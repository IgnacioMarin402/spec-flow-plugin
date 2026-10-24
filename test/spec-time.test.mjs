import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archivedSlugsIn } from '../scripts/spec-time.mjs';

// A file under the archive is no change: a live change named like it would be
// refused over a clash with nothing the fold could land in.
test('the archived changes are the folders under the archive, not its files', () => {
  const root = mkdtempSync(join(tmpdir(), 'spec-flow-archive-'));
  try {
    mkdirSync(join(root, 'specflow', 'archive', 'add-users'), { recursive: true });
    writeFileSync(join(root, 'specflow', 'archive', 'fix-login'), 'a file, not a change\n');
    assert.deepEqual(archivedSlugsIn(root), ['add-users']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
