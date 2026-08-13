#!/usr/bin/env node
/**
 * SessionStart hook — protects against a stale `phase` file.
 *
 * The gate only enforces while `.claude/state/phase` says `implement`. That
 * file is state on disk, so it outlives the session that wrote it: if a
 * `/spec-flow` run is interrupted, the phase stays at `implement` forever,
 * and the next session — even one that only asks a question — would trip the
 * gate on its way out and get told to re-plan a milestone that has nothing
 * to do with it.
 *
 * So: on session start, if the phase looks abandoned, reset it. A run that is
 * genuinely in progress rewrites the phase on every step, so its file is
 * always fresh; only a dead run has an old one.
 *
 * `blocked` gets the same treatment, for the opposite reason: harmless (it
 * disarms every hook) but it claims someone is waiting on a human, and a
 * `blocked` nobody touched for hours is a wait nobody is coming back to.
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { projectDir, stateDir, readFileOrDefault, writeFile, readPayload, run } from './lib/io.mjs';

const STALE_HOURS = 6;

await run(async () => {
  await readPayload(); // consumed, unused — this hook does not act on it

  const root = projectDir();
  const state = stateDir(root);
  const phaseFile = join(state, 'phase');
  const attFile = join(state, 'gate_attempts');

  if (!existsSync(phaseFile)) return;

  const phase = readFileOrDefault(phaseFile, '');
  if (phase !== 'implement' && phase !== 'blocked') return; // anything else is already harmless

  const ageHours = (Date.now() - statSync(phaseFile).mtimeMs) / 3_600_000;
  if (ageHours < STALE_HOURS) return;

  writeFile(phaseFile, 'idle');
  writeFile(attFile, '0');
  console.log(
    `[spec-flow] Phase was '${phase}' and untouched for ${Math.floor(ageHours)}h, so it was treated as an abandoned ` +
      `run and reset to 'idle'. The lint/test gate is disarmed. If you meant to resume that run, re-run /spec-flow.`,
  );
});
