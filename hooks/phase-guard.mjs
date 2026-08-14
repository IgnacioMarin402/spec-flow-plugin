#!/usr/bin/env node
/**
 * PreToolUse hook on Bash|Write|Edit — guards every write to
 * `.claude/state/phase`.
 *
 * That file is the spine of the whole engine: every enforcement hook decides
 * whether it is armed by matching it against a CLOSED SET of values. Each one
 * falls through to "not my business" on a value it does not recognise, so a
 * phase nobody defined — `triage`, `fix`, `verify` — stands down the gate, the
 * write-time linter, the whole-repo command deny, `preflight` and the Opus
 * budget **all at once**, and nothing anywhere says so. Code written with the
 * gate off looks exactly like code that passed it.
 *
 * That rule was written in four documents and enforced by nothing. This hook
 * is the enforcement, and it answers one question in two halves:
 *
 *   1. Is the value a phase this engine knows? An unrecognised one is denied,
 *      with the vocabulary, before it disarms anything.
 *   2. If the value is `done`, is it EARNED? `done` disarms everything the
 *      same way an invented phase does, only legitimately — so it is checked
 *      rather than trusted:
 *        - every unscoped check green (unscoped-checks.mjs declares them)
 *        - `specflow/` holds no unarchived change folder (the FOLD step ran)
 *
 * Both halves are the same question — *is this transition legitimate* — which
 * is why they live in one hook rather than two that would have to agree about
 * how a phase write is recognised.
 *
 * **Recognising the value is deliberately narrow, because this hook DENIES.**
 * A `Write`/`Edit` of the phase file carries the value as its body: exact. A
 * Bash `printf`/`echo` redirected into the phase file carries it as an
 * argument: also exact. Anything else that merely mentions the file — `cat`,
 * a grep, a path in an unrelated string — cannot be read reliably, so it is
 * ALLOWED. Denying on a guess would block legitimate work to enforce a rule
 * about a value nobody wrote; every hook here except the gate fails open, and
 * a guard that cannot see the value has nothing to guard.
 *
 * Only acts while a run is in progress. Degrades quietly if the contract
 * cannot be read: this is a consistency guard, not a security boundary, and a
 * hook that denied every phase write because of an unrelated config problem
 * would be worse than one that let a `done` through unchecked in that case.
 */
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { projectDir, phasePath, readPayload, readFileOrDefault, run } from './lib/io.mjs';
import { loadConfig } from '../scripts/spec-flow-config.mjs';
import { runUnscopedChecks } from '../scripts/unscoped-checks.mjs';

/**
 * The whole vocabulary. Kept here as the one executable copy — the tables in
 * README, REFERENCE and both commands describe it, and descriptions drift.
 */
const PHASES = ['spec', 'plan', 'review', 'implement', 'blocked', 'done', 'idle'];

const PHASE_FILE_RE = /\.claude[\\/]state[\\/]phase/;

/**
 * The value a Bash command writes into the phase file, or null when this
 * command cannot be read as a write of a specific value.
 *
 * Requires all three: a redirect into the phase file, a `printf`/`echo`
 * producing it, and a single readable argument. Anything looser starts
 * guessing, and this hook denies.
 */
function bashWrittenValue(cmd) {
  if (!PHASE_FILE_RE.test(cmd)) return null;
  if (!/>>?\s*['"]?[^'"\s]*\.claude[\\/]state[\\/]phase/.test(cmd)) return null;

  const source = cmd.split('>')[0];
  const producer = /(?:^|[;&|]|\s)(printf|echo)\s+(.*)$/.exec(source);
  if (!producer) return null;

  const args = producer[2]
    .trim()
    .split(/\s+/)
    .filter((a) => !a.startsWith('-')) // `echo -n`, `printf --`
    .map((a) => a.replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);

  // `printf '%s' implement` and friends: a format string is not the value.
  const values = args.filter((a) => !/%/.test(a));
  return values.length === 1 ? values[0] : null;
}

await run(async () => {
  const root = projectDir();
  const phaseFile = phasePath(root);
  const phase = readFileOrDefault(phaseFile, 'idle');

  if (!['spec', 'plan', 'review', 'implement', 'blocked'].includes(phase)) return; // idle/done/unknown -> transparent

  const payload = await readPayload();
  const input = payload.tool_input ?? {};

  let written = null;
  if (String(payload.tool_name ?? '') === 'Bash') {
    written = bashWrittenValue(String(input.command ?? ''));
  } else {
    const filePath = String(input.file_path ?? input.filePath ?? '');
    if (PHASE_FILE_RE.test(filePath)) {
      written = String(input.content ?? input.new_string ?? '').trim();
    }
  }

  if (!written) return; // not a readable phase write -> see this file's header

  // ---- half one: is this a phase at all? ----------------------------------
  if (!PHASES.includes(written)) {
    process.stderr.write(
      `[spec-flow] Denied: '${written}' is not a phase this engine knows.\n\n` +
        `The phase vocabulary is a CLOSED SET: ${PHASES.join(', ')}. Every enforcement hook ` +
        `decides whether it is armed by matching this file against those values, and each one ` +
        `falls through to "not my business" on anything else — so writing '${written}' would run ` +
        `the flow with the gate, the write-time linter, the whole-repo command deny, preflight ` +
        `and the Opus budget ALL disarmed at once, with nothing to say so.\n\n` +
        `Whatever step you are modelling, express it inside the vocabulary: spec work runs under ` +
        `\`spec\`, anything that writes code runs under \`implement\`. If you are extending the ` +
        `orchestrator, that constraint is the design, not an obstacle to route around.\n`,
    );
    process.exit(2); // PreToolUse denial protocol
  }

  if (written !== 'done') return; // a known phase that disarms nothing on its own

  // ---- half two: is `done` earned? ----------------------------------------
  const failures = [];

  // Degrades quietly on a bad contract: this guard's job is refusing an
  // unearned `done`, not policing the contract — gate.mjs does that loudly,
  // and preflight refuses to start a run over it in the first place.
  try {
    const config = loadConfig(root);
    const result = runUnscopedChecks(root, config);
    for (const c of result.checks) {
      if (c.rc !== 0) failures.push(`--- ${c.name} ---\n${c.out}`);
    }
  } catch {
    /* contract unreadable: leave the unscoped-check half silent, per the header above */
  }

  // Any directory under specflow/ other than archive/ is a change that never
  // got folded — shipped code with an unarchived change spec is an unfinished run.
  const specflowDir = join(root, 'specflow');
  if (existsSync(specflowDir)) {
    const unarchived = readdirSync(specflowDir).filter(
      (e) => e !== 'archive' && statSync(join(specflowDir, e)).isDirectory(),
    );
    if (unarchived.length > 0) {
      failures.push(`--- unarchived changes in specflow/ ---\n${unarchived.join('\n')}`);
    }
  }

  if (failures.length === 0) return;

  process.stderr.write(
    `[spec-flow] Denied: writing 'done' into .claude/state/phase, and the run is not ` +
      `actually finished. 'done' disarms every hook, so it has to be earned, not ` +
      `declared:\n${failures.join('\n')}\n\n` +
      `Route by what failed: a spec-trace gap belongs to the spec-writer session ` +
      `(FOLD), an unarchived specflow/<SLUG>/ means step 5 never ran — invoke ` +
      `spec-writer in MODE=FOLD — and any other check the project declared goes back ` +
      `to the implementer of the milestone that broke it, with the hint that check ` +
      `carries in .spec-flow/config.json.\n`,
  );
  process.exit(2); // PreToolUse denial protocol: stderr + exit 2, unlike a Stop hook's JSON-on-stdout
});
