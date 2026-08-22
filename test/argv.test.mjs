#!/usr/bin/env node
/**
 * Unit tests for `scripts/argv.mjs` — the module that reads an argv the
 * contract declares.
 *
 * This file exists because of what `binaryOf`'s own header records: the
 * question "which token is the binary" was answered by a positional guess in
 * two different files, and the guess made the binary `"."` for
 * `["eslint", "."]`. That is a defect a fixture cannot reach economically —
 * every case here would have needed a throwaway repo, a git history and a
 * full `init` run to exercise one branch of one pure function.
 *
 * The other half is `resolveLocalBin`, whose two branches are split by
 * PLATFORM in production: npm writes a symlink on POSIX and a `#!/bin/sh`
 * shim on Windows, so each machine only ever runs one of them. Here both are
 * a directory this file builds, so the shim branch is covered on POSIX too —
 * which is the only place it gets covered at all, since CI is POSIX by
 * ADR-011.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { binaryOf, looksLikeTarget, stripTargets, resolveLocalBin, RUNTIMES } from '../scripts/argv.mjs';

/** A throwaway directory, removed however the test ends. */
function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'spec-flow-argv-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The package half of a local install: real JavaScript at a real path. */
function packageEntry(dir, pkg, entry) {
  const target = join(dir, 'node_modules', pkg, entry);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, 'process.exit(0);\n');
  mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
  return target;
}

describe('binaryOf', () => {
  test('an interpreter hands the name to what it runs', () => {
    assert.equal(binaryOf(['node', 'node_modules/eslint/bin/eslint.js']), 'node_modules/eslint/bin/eslint.js');
  });

  // The defect this module was extracted to fix: `args[0] ?? bin` read the
  // token after the binary, which is a target, not a binary.
  test('a bare command with a target is still the command', () => {
    assert.equal(binaryOf(['eslint', '.']), 'eslint');
  });

  test('a bare command with a flag is still the command', () => {
    assert.equal(binaryOf(['eslint', '--cache']), 'eslint');
  });

  // A runtime whose next token is a flag is running ITSELF, not a script.
  test('an interpreter followed by a flag is the binary', () => {
    assert.equal(binaryOf(['node', '--test']), 'node');
  });

  test('an empty argv names nothing', () => {
    assert.equal(binaryOf([]), '');
  });

  test('every runtime in RUNTIMES defers to its second token', () => {
    for (const runtime of RUNTIMES) {
      assert.equal(binaryOf([runtime, 'script.js']), 'script.js', `${runtime} did not defer`);
    }
  });
});

describe('looksLikeTarget', () => {
  test('a flag is never a target', () => {
    withDir((dir) => assert.equal(looksLikeTarget('--fix', dir), false));
  });

  test('the current directory is a target in both spellings', () => {
    withDir((dir) => {
      assert.equal(looksLikeTarget('.', dir), true);
      assert.equal(looksLikeTarget('./', dir), true);
    });
  });

  test('anything carrying a separator or a star is a target', () => {
    withDir((dir) => {
      assert.equal(looksLikeTarget('src/lib', dir), true);
      assert.equal(looksLikeTarget('*.ts', dir), true);
    });
  });

  // `--ext .ts` ends in an extension and is a flag's VALUE. Treating a dot as
  // evidence would strip it and change what the linter checks.
  test("an extension is not a target just because it has a dot", () => {
    withDir((dir) => assert.equal(looksLikeTarget('.ts', dir), false));
  });

  test('a real directory in the repo is a target', () => {
    withDir((dir) => {
      mkdirSync(join(dir, 'src'));
      assert.equal(looksLikeTarget('src', dir), true);
    });
  });
});

describe('stripTargets', () => {
  test('a trailing target is dropped and reported', () => {
    withDir((dir) => {
      const { argv, stripped } = stripTargets(['.', '--fix'], dir);
      assert.deepEqual(argv, ['--fix']);
      assert.deepEqual(stripped, ['.']);
    });
  });

  // Without each linter's flag grammar, "follows a flag" is the only evidence
  // that a path-shaped token is a value rather than a target.
  test("a flag's value is kept even when it is path-shaped", () => {
    withDir((dir) => {
      const { argv, stripped } = stripTargets(['--ignore-path', 'dist'], dir);
      assert.deepEqual(argv, ['--ignore-path', 'dist']);
      assert.deepEqual(stripped, []);
    });
  });

  // Deliberately incomplete rather than aggressive: guessing wrong here
  // silently changes what the linter checks, so it is kept and REPORTED.
  test('a target that follows a flag is kept and surfaced in remaining', () => {
    withDir((dir) => {
      const { argv, stripped, remaining } = stripTargets(['--fix', '.'], dir);
      assert.deepEqual(argv, ['--fix', '.']);
      assert.deepEqual(stripped, []);
      assert.deepEqual(remaining, ['.']);
    });
  });
});

describe('resolveLocalBin', () => {
  // The Windows shape. Exercised here on every platform, because production
  // only ever reaches it on the one CI does not run.
  test('reads the entrypoint out of a sh shim', () => {
    withDir((dir) => {
      packageEntry(dir, 'eslint', 'bin/eslint.js');
      writeFileSync(
        join(dir, 'node_modules', '.bin', 'eslint'),
        '#!/bin/sh\nbasedir=$(dirname "$0")\n' +
          'if [ -x "$basedir/node" ]; then\n' +
          '  exec "$basedir/node"  "$basedir/../eslint/bin/eslint.js" "$@"\n' +
          'else\n' +
          '  exec node  "$basedir/../eslint/bin/eslint.js" "$@"\n' +
          'fi\n',
      );
      assert.equal(resolveLocalBin(dir, 'eslint'), 'node_modules/eslint/bin/eslint.js');
    });
  });

  // `$basedir/node` sits on the same line as the target. Taking the first
  // path would name the interpreter instead of the script.
  test('does not mistake $basedir/node for the entrypoint', () => {
    withDir((dir) => {
      packageEntry(dir, 'vitest', 'dist/cli.js');
      writeFileSync(
        join(dir, 'node_modules', '.bin', 'vitest'),
        '#!/bin/sh\nexec "$basedir/node"  "$basedir/../vitest/dist/cli.js" "$@"\n',
      );
      assert.equal(resolveLocalBin(dir, 'vitest'), 'node_modules/vitest/dist/cli.js');
    });
  });

  test('the POSIX shape resolves through the symlink', (t) => {
    withDir((dir) => {
      packageEntry(dir, 'eslint', 'bin/eslint.js');
      try {
        symlinkSync(join('..', 'eslint', 'bin', 'eslint.js'), join(dir, 'node_modules', '.bin', 'eslint'));
      } catch {
        // Windows refuses a symlink without Developer Mode or elevation. The
        // branch is unreachable in production there anyway.
        t.skip('symlinks not permitted on this machine');
        return;
      }
      assert.equal(resolveLocalBin(dir, 'eslint'), 'node_modules/eslint/bin/eslint.js');
    });
  });

  test('a bin that is not installed resolves to nothing', () => {
    withDir((dir) => assert.equal(resolveLocalBin(dir, 'eslint'), null));
  });

  // A native binary has no entrypoint to name. Returning null is what makes
  // the caller keep the bare command name instead of inventing a path.
  test('a shim with no JavaScript behind it resolves to nothing', () => {
    withDir((dir) => {
      mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
      writeFileSync(join(dir, 'node_modules', '.bin', 'ruff'), '#!/bin/sh\nexec "$basedir/../ruff/ruff" "$@"\n');
      assert.equal(resolveLocalBin(dir, 'ruff'), null);
    });
  });

  // A shim naming a file that is gone is a broken install, not an entrypoint.
  test('a shim pointing at a missing file resolves to nothing', () => {
    withDir((dir) => {
      mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
      writeFileSync(join(dir, 'node_modules', '.bin', 'eslint'), '#!/bin/sh\nexec node "$basedir/../eslint/bin/eslint.js"\n');
      assert.equal(resolveLocalBin(dir, 'eslint'), null);
    });
  });

  // The property the whole change exists for: the contract is committed, so
  // the separator can never be the writing machine's.
  test('the path it returns never carries a host separator', () => {
    withDir((dir) => {
      packageEntry(dir, 'eslint', 'bin/eslint.js');
      writeFileSync(
        join(dir, 'node_modules', '.bin', 'eslint'),
        '#!/bin/sh\nexec node  "$basedir/../eslint/bin/eslint.js" "$@"\n',
      );
      assert.ok(!resolveLocalBin(dir, 'eslint').includes('\\'));
    });
  });
});
