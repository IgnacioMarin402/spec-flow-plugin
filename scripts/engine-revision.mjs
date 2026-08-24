#!/usr/bin/env node
/**
 * Which copy of this engine is running, spelled so that two builds of it
 * cannot answer the same thing — see ADR-018.
 *
 * `gate.mjs` writes this into every line of `state/gate-history.log`. The field
 * is the only record of WHICH engine judged a milestone, which is worth having
 * when a history is read months later, and worth nothing at all if the value
 * cannot change: `package.json`'s `version` has moved once, at extraction, and
 * is the number ADR-003 already removed from `plugin.json` for that exact
 * reason. This resolves the commit instead.
 *
 *   import { engineRevision } from './engine-revision.mjs';
 *   engineRevision(root); // '9a3f21c4b0d8' | 'v0.1.0-unversioned'
 *
 * `root` is the engine's OWN directory — the copy whose revision is being
 * asked for — never the consuming repo. Passing the wrong one inverts the
 * whole point of recording it, so it is a required argument rather than
 * something resolved here from `import.meta.url`: this file has two callers
 * that sit at different depths.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The `v` prefix is load-bearing: it is what stops this being read as a short
 * sha. A reader who cannot tell a revision from a fallback is back where the
 * frozen `version` left them.
 */
const UNRESOLVED_PREFIX = 'v';

/**
 * @param {string} root The engine copy's own root directory.
 * @returns {string} A commit id when one can be resolved, else the package
 *   version prefixed so it reads as what it is.
 */
export function engineRevision(root) {
  const res = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: root, encoding: 'utf8' });
  const sha = res.status === 0 ? res.stdout.trim() : '';
  if (/^[0-9a-f]{7,40}$/.test(sha)) return sha;

  // The other install has no revision to report, and that is a measured fact
  // rather than a guess: `npm install <git-spec>` packs the clone and installs
  // the tarball, so `node_modules/spec-flow-plugin` arrives with no `.git` and
  // — checked on npm 11 — no `gitHead` in its package.json either. The commit
  // survives only in the CONSUMING repo's package-lock.json, which is that
  // repo's file, not this one's. Nothing here writes a history line from that
  // copy today (`gate.mjs` is a plugin hook), so this branch is the honest
  // answer rather than a gap: a version, marked as a version.
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    return `${UNRESOLVED_PREFIX}${pkg.version || '?'}`;
  } catch {
    return `${UNRESOLVED_PREFIX}?`;
  }
}
