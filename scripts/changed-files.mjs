#!/usr/bin/env node
/**
 * The scope that both the gate and the everyday check command judge: the
 * files THIS BRANCH changed.
 *
 * One resolver, every caller imports it, so "same files, same commands, same
 * result" is structural rather than a promise kept by two copies that agree
 * only while someone remembers to edit both — the exact drift step 0 of
 * docs/spec-flow-as-a-plugin.md closed the first time, and the reason it is
 * an import here instead of a second bash script.
 *
 *   import { resolveBase, changedFiles } from './changed-files.mjs';
 *
 * Which extensions count is the repo's call, not the engine's: it comes from
 * `.spec-flow/config.json` via `loadConfig`, and the caller decides what a
 * missing or malformed contract means to IT — this file itself takes a
 * loaded config rather than loading one, so it never has an opinion on that.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

function git(root, args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8' });
}

/** Compare against the merge-base with the default branch; fall back to HEAD (uncommitted only). */
export function resolveBase(root) {
  for (const ref of ['origin/main', 'main']) {
    const res = git(root, ['merge-base', 'HEAD', ref]);
    if (res.status === 0) return res.stdout.trim();
  }
  return 'HEAD';
}

/**
 * The union of three lists — committed + working-tree changes, staged
 * changes, untracked files — minus deletions, which have nothing left to
 * lint or test. `scopeGlobs` comes from the caller's loaded config.
 */
export function changedFiles(root, scopeGlobs, base = resolveBase(root)) {
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

// ---- CLI, mirroring the old shell entrypoints ------------------------------
//   node scripts/changed-files.mjs          # the changed files, one per line
//   node scripts/changed-files.mjs --base   # just the ref they are compared against

import { fileURLToPath } from 'node:url';
import { loadConfig } from './spec-flow-config.mjs';

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const config = loadConfig(root); // unguarded — see spec-flow-config.mjs's header
  const base = resolveBase(root);

  if (process.argv.includes('--base')) {
    console.log(base);
  } else {
    for (const f of changedFiles(root, config.verify.scope_globs, base)) console.log(f);
  }
}
