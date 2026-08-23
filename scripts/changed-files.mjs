#!/usr/bin/env node
/**
 * The scope that both the gate and the everyday check command judge: the
 * files THIS BRANCH changed.
 *
 * One resolver, every caller imports it, so "same files, same commands, same
 * result" is structural rather than a promise kept by two copies that agree
 * only while someone remembers to edit both. That is why this is an import
 * rather than a second script each caller keeps its own copy of.
 *
 *   import { resolveBase, changedFiles } from './changed-files.mjs';
 *
 * Which extensions count is the repo's call, not the engine's: it comes from
 * `.spec-flow/config.json` via `loadConfig`, and the caller decides what a
 * missing or malformed contract means to IT — this file itself takes a
 * loaded config rather than loading one, so it never has an opinion on that.
 *
 * Which BASE they are compared against is the repo's call too. See
 * `resolveBase` below, which throws rather than guessing.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

function git(root, args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8' });
}

/**
 * The candidates probed when neither the contract nor `origin/HEAD` answers.
 * A list, because "the default branch" is a repo's choice and this engine
 * does not get to have an opinion about which name is correct — it only gets
 * to be honest about whether it found one.
 */
const BASE_CANDIDATES = [
  'origin/main',
  'main',
  'origin/master',
  'master',
  'origin/develop',
  'develop',
  'origin/trunk',
  'trunk',
];

/** The merge-base of HEAD and `ref`, or null if git cannot resolve the pair. */
function mergeBase(root, ref) {
  const res = git(root, ['merge-base', 'HEAD', ref]);
  return res.status === 0 ? res.stdout.trim() : null;
}

/**
 * The commit this branch is judged against.
 *
 * **This function throws rather than guessing, and that is the whole point of
 * it.** A base that matches nothing does not degrade the scope, it disarms
 * the gate: `changedFiles` returns `[]`, and the caller reads zero changed
 * files as "this milestone touched nothing in scope" and reports a clean pass
 * over a red linter and a red suite that were never invoked.
 *
 * So the ladder ends in an exception, not a value. Every rung before it only
 * reduces how often a repo has to say the name out loud:
 *
 *   1. `verify.base_ref` from the contract — explicit, and it wins. A repo
 *      with an unusual base (a release branch, a fork's upstream) says so
 *      once instead of hoping the probe guesses right.
 *   2. `refs/remotes/origin/HEAD` — what `git clone` records as the remote's
 *      default branch. Correct when present, and absent more often than you
 *      would think: CI checkouts frequently do not set it, so this is a good
 *      first rung and a terrible only one.
 *   3. The candidate list above.
 *   4. Throw. The caller decides what a loud failure means for IT —
 *      `preflight` refuses to start the run, the gate blocks the stop, the
 *      CLI exits non-zero — but nobody continues on a base that matches
 *      nothing.
 *
 * @param {string} root Absolute path to the repo being judged.
 * @param {{verify?: {base_ref?: string}}} [config] The loaded contract, if the caller has one.
 */
export function resolveBase(root, config = undefined) {
  const declared = config?.verify?.base_ref;
  if (declared) {
    const base = mergeBase(root, declared);
    if (base) return base;
    throw new Error(
      `the contract declares verify.base_ref "${declared}", and git cannot resolve a merge-base between it and HEAD. ` +
        `Either the ref does not exist in this clone (a shallow or single-branch fetch is the usual cause) or the name is wrong. ` +
        `Refusing to fall back: a base this engine cannot resolve produces an EMPTY changed-file list, which reads as "nothing to check" rather than "I do not know what to check".`,
    );
  }

  const originHead = git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (originHead.status === 0 && originHead.stdout.trim()) {
    const base = mergeBase(root, originHead.stdout.trim());
    if (base) return base;
  }

  for (const ref of BASE_CANDIDATES) {
    const base = mergeBase(root, ref);
    if (base) return base;
  }

  throw new Error(
    `no base branch could be resolved for this repo. Tried the contract's verify.base_ref (not set), refs/remotes/origin/HEAD (absent or unresolvable), and ${BASE_CANDIDATES.join(', ')}. ` +
      `Declare the branch this work is judged against as "base_ref" under "verify" in .spec-flow/config.json — e.g. "base_ref": "origin/trunk". ` +
      `This is a refusal to run, not a failed milestone: with no base, the changed-file list is empty for reasons that have nothing to do with the code, and every scoped check would report clean without ever running.`,
  );
}

/**
 * The union of three lists — committed + working-tree changes, staged
 * changes, untracked files — minus deletions, which have nothing left to
 * lint or test. `scopeGlobs` comes from the caller's loaded config.
 *
 * `base` is REQUIRED, deliberately. It used to default to `resolveBase(root)`,
 * which meant a caller that forgot to pass one got a base resolved without
 * ever seeing the contract — and so never saw `verify.base_ref`. Every caller
 * in this package resolves the base explicitly, one line above, so the
 * default only existed to make that mistake possible.
 */
export function changedFiles(root, scopeGlobs, base) {
  const lists = [
    git(root, ['diff', '--name-only', '--diff-filter=ACMR', base, '--', ...scopeGlobs]),
    git(root, ['diff', '--name-only', '--diff-filter=ACMR', '--cached', '--', ...scopeGlobs]),
    git(root, ['ls-files', '--others', '--exclude-standard', '--', ...scopeGlobs]),
  ];

  const files = new Set();
  for (const res of lists) {
    if (res.status !== 0) continue;
    for (const f of res.stdout.split('\n')) {
      const trimmed = f.trim();
      if (!trimmed) continue;
      const full = join(root, trimmed);
      if (existsSync(full) && statSync(full).isFile()) files.add(trimmed);
    }
  }
  return [...files].sort();
}

/**
 * Whether `scopeGlobs` matches NOTHING this repo tracks.
 *
 * The question only has to be asked when `changedFiles` came back empty, and
 * it is what separates the two ways that happens. A milestone that touched no
 * file in scope is a fact about the diff and must pass; a scope that cannot
 * match anything at all, in any commit, is a contract whose `verify.lint` was
 * never going to run — for this milestone, and for every one after it.
 *
 * `loadConfig` already rejects the shape that produces this most often (`**`
 * in a git pathspec), and this is the half that shape cannot cover: a
 * directory that was renamed, an extension the repo does not use, a typo. Both
 * are needed because they catch different halves — `**\/*.ts` still matches
 * the files below the root, so it narrows the scope without emptying it.
 *
 * A git that cannot be asked answers `false`. This decides whether a gate
 * REFUSES, and "I could not tell" must never be the reason one does.
 */
export function scopeMatchesNothing(root, scopeGlobs) {
  const res = git(root, ['ls-files', '--', ...scopeGlobs]);
  return res.status === 0 && res.stdout.trim() === '';
}

// ---- CLI, mirroring the old shell entrypoints ------------------------------
//   node scripts/changed-files.mjs          # the changed files, one per line
//   node scripts/changed-files.mjs --base   # just the ref they are compared against

import { fileURLToPath } from 'node:url';
import { loadConfig } from './spec-flow-config.mjs';

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const config = loadConfig(root); // unguarded — see spec-flow-config.mjs's header

  // Also unguarded, and for the same reason: an unresolvable base is a
  // refusal to run, and printing an empty file list instead would be this
  // command lying about the scope in exactly the way `resolveBase`'s old
  // `'HEAD'` fallback did.
  let base;
  try {
    base = resolveBase(root, config);
  } catch (err) {
    process.stderr.write(`changed-files: ${err.message}\n`);
    process.exit(1);
  }

  if (process.argv.includes('--base')) {
    console.log(base);
  } else {
    for (const f of changedFiles(root, config.verify.scope_globs, base)) console.log(f);
  }
}
