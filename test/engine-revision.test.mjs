#!/usr/bin/env node
/**
 * Unit tests for `scripts/engine-revision.mjs` — the `engine=` field of every
 * gate-history line (ADR-018).
 *
 * `gate-fixture.mjs` covers the copy that is a git checkout. The shapes here
 * are the ones a real install arrives in, which no fixture built: a
 * marketplace copy has no `.git` and is named for its commit, and a copy with
 * no `.git` can sit inside someone else's repository.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { engineRevision } from '../scripts/engine-revision.mjs';

/** A throwaway directory, removed however the test ends. */
function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'spec-flow-engine-revision-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** An engine copy: a directory with the package.json the fallback reads. */
function engineCopy(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'spec-flow-plugin', version: '0.1.0' }));
  return dir;
}

function commit(dir) {
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '.');
  git('config', 'user.email', 'revision@example.com');
  git('config', 'user.name', 'revision');
  git('commit', '-q', '--allow-empty', '-m', 'a revision');
  return git('rev-parse', '--short=12', 'HEAD').stdout.trim();
}

describe('engineRevision', () => {
  test('a checkout of its own reports its HEAD', () => {
    withDir((dir) => {
      const engine = engineCopy(join(dir, 'engine'));
      const head = commit(engine);
      assert.equal(engineRevision(engine), head);
    });
  });

  // The install every gate line is written from: `plugins/cache/<marketplace>/<plugin>/<sha>/`.
  test('a marketplace copy with no .git reports the commit its directory is named for', () => {
    withDir((dir) => {
      assert.equal(engineRevision(engineCopy(join(dir, 'spec-flow', '1d7e03d21d4d'))), '1d7e03d21d4d');
    });
  });

  test('a copy with no .git inside another repository does not report that repository', () => {
    withDir((dir) => {
      const outer = commit(dir);
      const revision = engineRevision(engineCopy(join(dir, 'engine')));
      assert.notEqual(revision, outer, 'reported the enclosing repository\'s HEAD as the engine\'s');
      assert.equal(revision, 'v0.1.0');
    });
  });

  test('a copy with nothing to name a commit reports its version, marked as one', () => {
    withDir((dir) => {
      assert.equal(engineRevision(engineCopy(join(dir, 'engine'))), 'v0.1.0');
    });
  });
});
