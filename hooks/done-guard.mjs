#!/usr/bin/env node
/**
 * PreToolUse hook on Bash|Write|Edit — guards the `implement -> done` phase
 * transition.
 *
 * Writing `done` into `.claude/state/phase` is the flow declaring victory: it
 * disarms every other enforcement hook. This validates that claim before
 * letting the write through —
 *
 *   1. every unscoped check green (unscoped-checks.mjs declares them)
 *   2. specflow/ holds no unarchived change folder (the FOLD step ran)
 *
 * Both are exactly what the last step of the orchestrator must leave behind,
 * so a legitimate `done` sails through.
 *
 * Detection is intentionally broad — any Bash command that mentions both the
 * phase file and the word `done`, or a Write/Edit of the phase file whose
 * content says `done`. A false match merely re-runs two fast checks and
 * passes when they are green; it can only deny while the run genuinely has
 * an unfinished state.
 *
 * Only acts while a run is in progress. Degrades quietly if the contract
 * cannot be read: this is a consistency guard, not a security boundary, and a
 * hook that denied every `done` because of an unrelated config problem would
 * be worse than one that let a `done` through unchecked in that one case.
 */
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { projectDir, readPayload, readFileOrDefault, run } from './lib/io.mjs';
import { loadConfig } from '../scripts/spec-flow-config.mjs';
import { runUnscopedChecks } from '../scripts/unscoped-checks.mjs';

await run(async () => {
  const root = projectDir();
  const phaseFile = join(root, '.claude', 'state', 'phase');
  const phase = readFileOrDefault(phaseFile, 'idle');

  if (!['spec', 'plan', 'review', 'implement', 'blocked'].includes(phase)) return; // idle/done/unknown -> transparent

  const payload = await readPayload();
  const input = payload.tool_input ?? {};
  const phasePathRe = /\.claude[\\/]state[\\/]phase/;
  const doneRe = /\bdone\b/;

  let matched = false;
  if (String(payload.tool_name ?? '') === 'Bash') {
    const cmd = String(input.command ?? '');
    matched = phasePathRe.test(cmd) && doneRe.test(cmd);
  } else {
    const filePath = String(input.file_path ?? input.filePath ?? '');
    const body = String(input.content ?? input.new_string ?? '');
    matched = phasePathRe.test(filePath) && doneRe.test(body);
  }
  if (!matched) return;

  const failures = [];

  // Degrades quietly on a bad contract too: this guard's job is refusing an
  // unearned `done`, not policing the contract — gate.mjs already does that
  // loudly the next time it runs.
  try {
    const config = loadConfig(root);
    const result = runUnscopedChecks(root, config);
    for (const c of result.checks) {
      if (c.rc !== 0) failures.push(`--- ${c.name} ---\n${c.out}`);
    }
  } catch {
    /* contract unreadable: leave the unscoped-check half of this guard silent, per the header above */
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
    `[spec-flow] Denied: this looks like writing 'done' into .claude/state/phase, ` +
      `and the run is not actually finished. 'done' disarms every hook, so it has to ` +
      `be earned, not declared:\n${failures.join('\n')}\n\n` +
      `Route by what failed: a spec-trace gap belongs to the spec-writer session ` +
      `(FOLD), an unarchived specflow/<SLUG>/ means step 5 never ran — invoke ` +
      `spec-writer in MODE=FOLD — and any other check the project declared goes back ` +
      `to the implementer of the milestone that broke it, with the hint that check ` +
      `carries in .spec-flow/config.json. If this command was ` +
      `NOT closing the run and matched by accident, rephrase it to avoid naming the ` +
      `phase file and 'done' together.\n`,
  );
  process.exit(2); // PreToolUse denial protocol: stderr + exit 2, unlike a Stop hook's JSON-on-stdout
});
