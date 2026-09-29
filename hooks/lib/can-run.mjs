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
 * `contract`, then `base` — and returns `{ config, base }` otherwise.
 *
 * Not the Node floor: that is a fact about the engine's host, not about the
 * repository, and `preflight` keeps it.
 */
import { loadConfig } from '../../scripts/spec-flow-config.mjs';
import { resolveBase, assertRepoRoot } from '../../scripts/changed-files.mjs';

export function assertCanRun(root) {
  assertRepoRoot(root);

  let config;
  try {
    config = loadConfig(root);
  } catch (err) {
    throw Object.assign(err, { kind: 'contract' });
  }

  try {
    return { config, base: resolveBase(root, config) };
  } catch (err) {
    throw Object.assign(err, { kind: 'base' });
  }
}
