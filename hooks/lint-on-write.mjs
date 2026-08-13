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
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { projectDir, readFileOrDefault, readPayload, run } from './lib/io.mjs';
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
  if (binPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(binPath)) {
    if (!existsSync(binPath)) return;
  } else if (!existsSync(join(root, binPath))) {
    return; // a repo mid-`install` must not have every write blocked by a missing binary
  }

  const res = spawnSync(bin, [...args, '--format', 'stylish', file], { cwd: root, encoding: 'utf8' });
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
