import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { assertRepoRoot } from '../scripts/changed-files.mjs';

// A git that answers in another language unless asked for `C` — what a
// localised installation does, and what the text match in `assertRepoRoot`
// has to survive. Skipped on Windows: a fake binary on PATH there has to be
// an executable, and a shell script is not one `spawnSync` can run without a
// shell.
test(
  'assertRepoRoot pins git\'s language, so a localised git still says "not a git repository"',
  { skip: process.platform === 'win32' && 'a fake git on PATH needs an executable on Windows' },
  () => {
    const bin = mkdtempSync(join(tmpdir(), 'spec-flow-fake-git-'));
    const dir = mkdtempSync(join(tmpdir(), 'spec-flow-no-repo-'));
    writeFileSync(
      join(bin, 'git'),
      '#!/bin/sh\n' +
        'if [ "$LC_ALL" = "C" ]; then\n' +
        '  echo "fatal: not a git repository (or any of the parent directories): .git" >&2\n' +
        'else\n' +
        '  echo "fatal: no es un repositorio git (ni ninguno de los directorios superiores): .git" >&2\n' +
        'fi\n' +
        'exit 128\n',
    );
    chmodSync(join(bin, 'git'), 0o755);

    const { PATH, LC_ALL } = process.env;
    process.env.PATH = `${bin}${delimiter}${PATH}`;
    delete process.env.LC_ALL; // the pin has to come from the engine, not from this shell
    try {
      assert.throws(() => assertRepoRoot(dir), /not inside a git repository/);
    } finally {
      process.env.PATH = PATH;
      if (LC_ALL !== undefined) process.env.LC_ALL = LC_ALL;
      rmSync(bin, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
