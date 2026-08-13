#!/usr/bin/env node
/**
 * PostToolUse hook on Write|Edit — lint one file the moment it is written.
 *
 * The cheapest moment to fix a lint error is while the file is still in the
 * agent's context. The most expensive is a full gate cycle: end turn -> gate
 * -> block -> SendMessage -> end turn -> gate again. This hook is what makes
 * that round trip rare.
 *
 * Deliberately runs WITHOUT --fix. If this hook rewrote the file behind the
 * agent's back, the agent's next edit would fail as "modified externally" and
 * force a re-read — spending tokens instead of saving them. The gate keeps
 * --fix as the final formatting pass.
 *
 * Like the gate, this only fires while the flow is in `implement`.
 */
import { existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { projectDir, stateDir, readFileOrDefault, readPayload, run } from './lib/io.mjs';
import { loadConfig } from '../scripts/spec-flow-config.mjs';

const MAX_LINES = 30;

/** `*.ts`-shaped globs only, matching bash's own `case $file in $glob)` — no `**`, no character classes. */
function globMatch(glob, file) {
  const re = new RegExp(`^${glob.split('*').map((s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(file);
}

await run(async () => {
  const root = projectDir();
  const phase = readFileOrDefault(join(root, '.claude', 'state', 'phase'), '');
  if (phase !== 'implement') return;

  const payload = await readPayload();
  const input = payload.tool_input ?? {};
  const file = String(input.file_path ?? input.filePath ?? '');

  // Which linter, and which files it has an opinion about, is the repo's
  // call. A bad contract must not block every write — it degrades to
  // "nothing in scope" rather than denying.
  let config;
  try {
    config = loadConfig(root);
  } catch {
    return;
  }

  const inScope = config.verify.scope_globs.some((g) => globMatch(g, file));
  if (!inScope) return;
  if (!existsSync(file)) return;

  const [bin, ...args] = config.verify.lint_no_fix;
  // The linter binary is the argv element after the interpreter, if there is
  // one — mirrors the bash form's `${SF_LINT_NO_FIX[1]:-${SF_LINT_NO_FIX[0]}}`.
  const binPath = args[0] ?? bin;
  // Only a PATH-shaped binPath (absolute, or a repo-relative path like
  // `node_modules/.bin/eslint`) can be checked against a location at all. A
  // bare command name (`lint_no_fix: ["eslint"]`, meaning "resolve through
  // PATH") has no repo-relative file to find — `existsSync(join(root,
  // 'eslint'))` was always false for that shape, which silently disarmed
  // this hook on every write. spawnSync below reports an unresolvable
  // binary on its own; this guard exists only to skip a repo mid-`install`
  // without blocking every write on a binary that has a real, checkable path.
  if (binPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(binPath)) {
    if (!existsSync(binPath)) return;
  } else if (/[\\/]/.test(binPath) && !existsSync(join(root, binPath))) {
    return;
  }

  // No `--format` flag here: that is an ESLint-specific option, and this
  // hook is declared agnostic of which linter `lint_no_fix` names. The raw
  // output is truncated and shown as-is below, which every linter's default
  // output already supports.
  const res = spawnSync(bin, [...args, file], { cwd: root, encoding: 'utf8' });
  if (res.error) {
    // The binary could not be spawned at all (ENOENT, EACCES, ...) — not the
    // same as "lint passed clean", and falling through to the status-0
    // return below would have silently disarmed this hook for good on that
    // repo. Logged like opus-budget's and register-agent's misses, once per
    // distinct binary, instead of failing open with no trace.
    try {
      const spawnErr = /** @type {NodeJS.ErrnoException} */ (res.error);
      const line = `${bin} ${args.join(' ')}: ${spawnErr.code ?? spawnErr.message}`;
      const path = join(stateDir(root), 'lint-on-write-unmatched.log');
      const existing = existsSync(path) ? readFileOrDefault(path, '').split('\n') : [];
      if (!existing.includes(line)) appendFileSync(path, `${line}\n`);
    } catch {
      /* logging must never be why this hook fails */
    }
    return;
  }
  if ((res.status ?? 0) === 0) return;

  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  const lines = out.split('\n');
  let short = lines.slice(0, MAX_LINES).join('\n');
  if (lines.length > MAX_LINES) short += `\n... (${lines.length} lines total, truncated)`;

  process.stderr.write(
    `[spec-flow] ${config.verify.lint_name} flagged the file you just wrote — fix it now, while it is ` +
      `still in front of you. Fixing it here costs one edit; letting it reach the gate ` +
      `costs a full retry cycle.\n\n${short}\n\n` +
      `If the violation comes from a project rule in ${config.verify.lint_config_hint}, read its ` +
      `message: it names what the rule protects and why it exists.\n`,
  );
  process.exit(2); // PostToolUse denial protocol
});
