#!/usr/bin/env node
/**
 * Whether this engine can run in `root` — the question `preflight` asks at a
 * run's first spawn and `phase-guard` at the write that starts one
 * (ADR-028). One copy, so the two cannot drift: a check one makes and the
 * other omits is a run refused at the spawn after it armed every hook at the
 * write.
 *
 * Throws the first failure, with `kind` naming it so a caller can head its
 * message — `no-repository` and `not-root` from `assertRepoRoot`, then
 * `contract`, then `settings`, then `base`, then `foreign-change` — and
 * returns `{ config, base }` otherwise.
 *
 * Not the Node floor: that is a fact about the engine's host, not about the
 * repository, and `preflight` keeps it.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../../scripts/spec-flow-config.mjs';
import { resolveBase, assertRepoRoot, changesAtBase } from '../../scripts/changed-files.mjs';
import { BUDGETS, budgetCap } from './budgets.mjs';
import { projectConfig } from './project-config.mjs';
import { projectRouting } from './routing.mjs';

/**
 * What in `.claude/spec-flow.config.json` a hook would refuse during the run:
 * a cap `opus-budget` denies every call at, a route `model-route` denies every
 * spawn over, or a file none of whose settings apply. Refused at the start, a
 * bad cap does not wait for the architect's first consult, mid-implement.
 *
 * @param {string} root
 * @returns {string[]}
 */
export function settingsProblems(root) {
  const path = join(root, '.claude', 'spec-flow.config.json');
  if (!existsSync(path)) return [];
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    return [`it could not be read (${err.message}), so none of its settings apply`];
  }
  const { settings, problem } = projectConfig(text);
  if (problem) return [problem];
  const caps = Object.entries(BUDGETS)
    .filter(([role]) => Number.isNaN(budgetCap(text, role)))
    .map(([role, b]) => `"${b.key}": ${JSON.stringify(settings[b.key])} is not a whole number of calls, so opus-budget would deny every ${role} call.`);
  return [...caps, ...projectRouting(root).problems];
}

export function assertCanRun(root) {
  assertRepoRoot(root);

  let config;
  try {
    config = loadConfig(root);
  } catch (err) {
    throw Object.assign(err, { kind: 'contract' });
  }

  const settings = settingsProblems(root);
  if (settings.length > 0) {
    throw Object.assign(
      new Error(
        `.claude/spec-flow.config.json cannot be applied:\n${settings.map((p) => `  - ${p}`).join('\n')}\n` +
          `Fix each, or remove the setting to take its default.`,
      ),
      { kind: 'settings' },
    );
  }

  let base;
  try {
    base = resolveBase(root, config);
  } catch (err) {
    throw Object.assign(err, { kind: 'base' });
  }

  // A run here could never be marked done: `done` needs every change folder
  // archived, and this one is no run of this branch to archive (ADR-032).
  const foreign = changesAtBase(root, base);
  if (foreign.length > 0) {
    const folders = foreign.map((slug) => `specflow/${slug}/`).join(', ');
    throw Object.assign(
      new Error(
        `${folders} ${foreign.length > 1 ? 'are' : 'is'} live, and the base branch already has ${foreign.length > 1 ? 'them' : 'it'}, so no run on this branch created ${foreign.length > 1 ? 'them' : 'it'}. ` +
          `A folder under specflow/ is a change in flight, and a run is not done while one is unarchived. ` +
          `A plan nobody has run belongs outside specflow/; a change that was dropped or shipped gets its **Status:** stamp and moves to specflow/archive/. ` +
          `Either is the human's call, best made on the base branch so the next branch does not inherit it.`,
      ),
      { kind: 'foreign-change' },
    );
  }
  return { config, base };
}
