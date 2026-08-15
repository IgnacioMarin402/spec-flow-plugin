#!/usr/bin/env node
/**
 * PreToolUse hook on subagent spawn AND SendMessage — refuses to start a run
 * the engine cannot finish.
 *
 * Until this existed, the contract's first BLOCKING check was `gate.mjs`, and
 * the gate only fires on `Stop` while the phase is `implement`. Everything
 * before that either reads the contract defensively or not at all, so a repo
 * with an unusable contract ran the whole way through SPEC, the human
 * sign-off, PLAN — an Opus call — REVIEW, and a full implementer milestone
 * before anything said the engine could not run here. The most expensive
 * calls in the flow were spent ahead of the cheapest check it has.
 *
 * A hook rather than a step in the orchestrator's instructions, for the same
 * reason `opus-budget.mjs` is one: a preflight the model has to remember to
 * run is not a preflight. This fires on the first subagent of a run, which is
 * the earliest enforceable moment and the one where a denial costs nothing —
 * no agent has produced anything yet.
 *
 * It checks the things that stop a run dead, and nothing else:
 *
 *   0. The Node running this engine is one the engine declares support for.
 *      `package.json`'s `engines.node` is the single source — a floor written
 *      twice drifts. Major version only, and only when it parses: a floor this
 *      engine cannot compare against confidently is not worth denying a run
 *      over. Why Node gets a floor and Claude Code does not: see ADR-004.
 *
 *   1. The contract loads and validates. Same reader every hook uses, so this
 *      cannot disagree with what the gate would have said later.
 *   2. The base branch resolves IN THIS ENVIRONMENT. That check cannot live
 *      in `validate()`, which judges the shape of a file: whether a base
 *      resolves depends on the clone — a shallow or single-branch checkout
 *      has refs a full one does not — so the same contract can be fine on one
 *      machine and unusable on another. Here it is checked where the run will
 *      actually happen.
 *
 * It is NOT a general policy hook. `specs/` being empty, a missing skill, an
 * unwise test command — none of those stop a run from starting, so none of
 * them belong here. Every check above is fatal and cheap: two file reads and,
 * in most repos, one or two `git merge-base` calls.
 *
 * Stands down outside a run (`idle`/`done`), so a subagent spawned for
 * something unrelated to the flow never sees it. And like every hook here
 * except the gate, a crash in this file ALLOWS the call — `run()` without an
 * `onError` exits 0. Only a check that genuinely failed denies, and it does
 * so through the PreToolUse protocol: stderr plus exit 2.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectDir, phasePath, readFileOrDefault, readPayload, run } from './lib/io.mjs';
import { loadConfig } from '../scripts/spec-flow-config.mjs';
import { resolveBase } from '../scripts/changed-files.mjs';

function deny(what, detail) {
  process.stderr.write(
    `[spec-flow] PREFLIGHT FAILED — ${what}\n\n${detail}\n\n` +
      `Nothing has run yet, which is the point of checking here: the same problem would otherwise ` +
      `surface at the first gate, after the planner and an implementer had already been spent on a ` +
      `milestone this engine could not have verified.\n\n` +
      `Fix it, then start the run again. \`spec-flow init\` regenerates the contract from this repo; ` +
      `\`spec-flow init --force\` overwrites an existing one.\n`,
  );
  process.exit(2); // PreToolUse denial protocol
}

/**
 * The engine's own declared floor, from the one place a Node project states it.
 *
 * Returns null when anything is unreadable or unparseable — a missing floor is
 * "no opinion", never "deny". This runs before every subagent spawn of every
 * run, so a throw here would be a permanent, inexplicable denial.
 */
function nodeFloor() {
  try {
    const pkg = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
    );
    const declared = /(\d+)/.exec(pkg?.engines?.node ?? '');
    return declared ? Number(declared[1]) : null;
  } catch {
    return null;
  }
}

await run(async () => {
  const root = projectDir();

  // `phasePath`, not `stateDir`: this hook only ever reads, and it fires on
  // every subagent spawn. Creating the directory here would drop
  // `.claude/state/` into every repository the user opens.
  const phase = readFileOrDefault(phasePath(root), 'idle');
  if (['', 'idle', 'done'].includes(phase)) return; // not a run -> not this hook's business

  await readPayload(); // consumed, unused — this hook judges the repo, not the call

  // AFTER the phase guard, and that placement is not incidental. This hook
  // fires on every subagent spawn in every repository the user opens; a Node
  // check ahead of the guard would deny agents that have nothing to do with
  // this engine, in projects that never adopted it, over a floor only this
  // engine declares. Standing down outside a run is the rule the whole file
  // is built on and a new check does not get an exception from it.
  //
  // First WITHIN the run, though: a contract error reported by an engine that
  // cannot run here at all would send someone to edit the wrong file.
  const floor = nodeFloor();
  const running = Number(/(\d+)/.exec(process.versions.node ?? '')?.[1]);
  if (floor && Number.isFinite(running) && running < floor) {
    deny(
      `this engine needs Node ${floor} or newer, and it is running on ${process.versions.node}.`,
      `Every hook, the gate and the CLI run through this same Node, so nothing downstream would be trustworthy — ` +
        `a check that crashes on syntax it cannot parse looks the same from the outside as a check that found nothing wrong.`,
    );
    return;
  }

  let config;
  try {
    config = loadConfig(root);
  } catch (err) {
    deny('the contract could not be read.', err.message);
    return;
  }

  try {
    resolveBase(root, config);
  } catch (err) {
    deny('the base branch could not be resolved.', err.message);
  }
});
