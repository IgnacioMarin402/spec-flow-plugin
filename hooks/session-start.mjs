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
 *
 * `spec`, `plan` and `review` are reset too. Every phase that arms anything
 * belongs here, not just the ones that gate: `preflight` arms on all of them,
 * so an abandoned `plan` would validate the contract and the base branch
 * before EVERY subagent spawn in that repo, forever, and deny the spawn if
 * either fails. A stale phase nobody remembers is exactly the case where that
 * denial is inexplicable.
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { projectDir, stateDir, phasePath, readPhase, releasePhase, readFileOrDefault, writeFile, readPayload, run } from './lib/io.mjs';

const STALE_HOURS = 6;

await run(async () => {
  await readPayload(); // consumed, unused — this hook does not act on it

  const root = projectDir();
  const phaseFile = phasePath(root);
  if (!existsSync(phaseFile)) return; // no phase file -> nothing to reset, and nothing to create

  const attFile = join(stateDir(root), 'gate_attempts');

  // `readPhase`, never `readOwnedPhase`: this hook's subject is a phase whose
  // OWNER is gone, so reading a previous session's phase as absent would stand
  // it down on precisely the file it exists to reset. What it does buy is the
  // other half of ADR-017 — a phase the repo COMMITTED reads as none, and is
  // left alone. There is nothing to reset there (no hook honours it) and
  // writing `idle` over it would dirty a tracked file in every repository the
  // user opens.
  const phase = readPhase(root);
  // Every phase that arms anything — see this file's header for why `spec`,
  // `plan` and `review` stopped being exempt. `idle`, `done` and an
  // unrecognized value arm nothing, so there is nothing to reset.
  if (!['spec', 'plan', 'review', 'implement', 'blocked'].includes(phase)) return;

  const ageHours = (Date.now() - statSync(phaseFile).mtimeMs) / 3_600_000;
  if (ageHours < STALE_HOURS) return;

  writeFile(phaseFile, 'idle');
  writeFile(attFile, '0');
  // The seal names the session that was driving the run this just declared
  // abandoned. Left behind, it would stand every later session down over an
  // owner that is never coming back — the fail-closed rule reversed.
  releasePhase(root);

  // `current-milestone` is deliberately NOT cleared. Disarming a stale run and
  // forgetting where it was are separate acts: the phase arms hooks, the
  // position arms nothing. Keeping it turns "start over" into "this run was at
  // Mk, and its plan is still on disk".
  const at = readFileOrDefault(join(stateDir(root), 'current-milestone'), '');
  const [slug, milestone] = at.split(' ');

  console.log(
    `[spec-flow] Phase was '${phase}' and untouched for ${Math.floor(ageHours)}h, so it was treated as an abandoned ` +
      `run and reset to 'idle'. The lint/test gate is disarmed.` +
      (slug && milestone
        ? ` That run was implementing ${milestone} of "${slug}"; its plan is still at specflow/${slug}/, and specflow/${slug}/milestones/${milestone}.md is where it stopped. ` +
          `To pick it up rather than start over, re-read that milestone, write 'implement' into .claude/state/phase and re-invoke the implementer for it.`
        : ` If you meant to resume that run, re-run /spec-flow.`),
  );
});
