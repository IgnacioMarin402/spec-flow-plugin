#!/usr/bin/env node
/**
 * Reading an argv the contract declares: which token is the actual binary,
 * and which trailing tokens are targets the engine must not inherit.
 *
 * Both questions were answered by ad-hoc guesses in two different files, and
 * both guesses were wrong in the same shape — they assumed argv[0] is always
 * an interpreter, so the binary is argv[1]. For `["node", ".bin/eslint"]`
 * that holds; for `["eslint", "."]` it makes the binary `"."`, and for
 * `["eslint", "--cache"]` it makes it `"--cache"`.
 */
import { existsSync, statSync, lstatSync, realpathSync, readFileSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';

/**
 * Interpreters that run something else. Shared with `init.mjs`, which needs
 * the same distinction for the opposite reason: naming a runner. `node
 * <script>` runs the tests, but "node" is not the name of a test runner, and
 * `node_modules/.bin/vitest` is not `node`.
 */
export const RUNTIMES = new Set([
  'node',
  'bun',
  'deno',
  'python',
  'python3',
  'ruby',
  'php',
  'go',
  'cargo',
  'dotnet',
  'java',
]);

/** `["node", ".bin/eslint", "--fix"]` -> `.bin/eslint`. `["eslint", "."]` -> `eslint`. */
export function binaryOf(argv) {
  const [first, second] = argv;
  if (!first) return '';
  if (RUNTIMES.has(first) && second && !second.startsWith('-')) return second;
  return first;
}

/**
 * The tool a shell command runs from `tokens[i]`: that token's basename, or
 * for `node [node's flags] <script>` the script's, minus `.js`/`.mjs`/`.cjs`.
 * `node --experimental-vm-modules node_modules/jest/bin/jest.js` runs jest —
 * the form `init` writes into the contract — so `no-gate-cmds` (is this an
 * unscoped run of a tool?) and `run-trace` (is this the runner failing?) read
 * it here, from one copy.
 *
 * @returns {{ index: number, name: string }} where the tool's token sits, and its name
 */
export function toolAt(tokens, i = 0) {
  if (tokens[i] !== 'node') return { index: i, name: (tokens[i] ?? '').replace(/^.*[\\/]/, '') };
  let j = i + 1;
  while (tokens[j]?.startsWith('-')) j++; // node's own flags, which a runner may need ahead of its script
  return { index: j, name: (tokens[j] ?? '').replace(/^.*[\\/]/, '').replace(/\.[cm]?js$/, '') };
}

/**
 * Does this token name a place in the repo rather than a flag or a value?
 *
 * Deliberately narrow. `.`, `./`, anything containing a separator or a glob
 * star, and anything that is an actual directory in the repo. NOT every token
 * with a dot in it: `--ext .ts` ends in `.ts`, which is a flag's value, and
 * stripping it would change what the linter checks rather than where.
 */
export function looksLikeTarget(token, root) {
  if (!token || token.startsWith('-')) return false;
  if (token === '.' || token === './') return true;
  if (/[\\/*]/.test(token)) return true;
  try {
    return statSync(join(root, token)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Drops the targets from an argv that the engine will append file paths to.
 *
 * `verify.lint` is documented as receiving the changed files appended, so a
 * script written as `eslint .` becomes `eslint . <file>` — which lints the
 * whole repo AND the file. That is not a slow lint, it is a DISARMED one: the
 * scoping exists so a milestone is never blocked by pre-existing debt in
 * files it never touched, and a stray `.` puts every one of those files back
 * in front of the gate.
 *
 * A token is only dropped when the token BEFORE it is not a flag. That one
 * rule is what separates `eslint . --fix` (drop the `.`) from `--ignore-path
 * dist` (keep it): without knowing each linter's flag grammar, "follows a
 * flag" is the only evidence available that a path-shaped token is a value
 * rather than a target.
 *
 * The rule is deliberately incomplete rather than aggressive. `eslint --fix .`
 * puts a real target after a flag, and nothing here can tell it apart from a
 * flag's value — so it is KEPT and returned in `remaining`, for the caller to
 * report. Guessing wrong in that direction silently changes what the linter
 * checks; leaving it and saying so is recoverable.
 */
export function stripTargets(argv, root) {
  const kept = [];
  const stripped = [];

  for (const [i, token] of argv.entries()) {
    const followsFlag = i > 0 && argv[i - 1].startsWith('-');
    if (!followsFlag && looksLikeTarget(token, root)) {
      stripped.push(token);
      continue;
    }
    kept.push(token);
  }

  return { argv: kept, stripped, remaining: kept.filter((t) => looksLikeTarget(t, root)) };
}

/** Repo-relative, always with `/`. The contract is committed, so the separator cannot be the writer's. */
const toPosix = (path) => path.replace(/\\/g, '/');

/**
 * Where a locally installed bin's real JavaScript lives, repo-relative, or
 * null when it cannot be resolved.
 *
 * `node_modules/.bin/<name>` is NOT one thing. npm writes a symlink to the
 * package's entrypoint on POSIX and, because Windows has no symlink it can
 * count on, three files there instead — `<name>`, `<name>.cmd`, `<name>.ps1`
 * — of which the extensionless one is a `#!/bin/sh` script. So `node
 * node_modules/.bin/eslint` runs the linter on one platform and dies with a
 * JavaScript SyntaxError on the other, and the contract that names it is a
 * committed file both platforms read. Resolving past the shim is what makes
 * the two agree — see ADR-011.
 *
 * Returns null rather than guessing. A bin that is neither shape (a native
 * binary, a shell script with no JS behind it) has no entrypoint to name, and
 * the caller keeps whatever it would have written before.
 */
export function resolveLocalBin(root, binName) {
  const shim = join(root, 'node_modules', '.bin', binName);

  let stat;
  try {
    stat = lstatSync(shim);
  } catch {
    return null; // not installed locally
  }

  if (stat.isSymbolicLink()) {
    try {
      return toPosix(relative(root, realpathSync(shim)));
    } catch {
      return null; // a link with nothing behind it
    }
  }

  try {
    // The shim's `exec` line is the only machine-readable part, and what it
    // hands to `node` (bare, or as `"$basedir/node"`) is JavaScript whatever
    // its name: typescript's `bin/tsc` has no extension. Keyed on the
    // interpreter, not the first path: `$basedir/node` sits on the same line.
    const target = /exec\s+(?:node|"\$basedir\/node")\s+"\$basedir\/([^"]+)"/.exec(readFileSync(shim, 'utf8'));
    if (!target) return null;
    const full = resolve(dirname(shim), target[1]);
    return existsSync(full) ? toPosix(relative(root, full)) : null;
  } catch {
    return null;
  }
}

/**
 * Whether a binary token can be checked against a location at all. A bare
 * command name resolves through PATH and has no repo-relative file to find,
 * so `existsSync` on it is always false — a caller that treated that as
 * "not installed" would disable itself permanently on such a repo.
 */
export function resolvableOnDisk(binary, root) {
  if (!binary) return { checkable: false, present: false };
  if (binary.startsWith('/') || /^[A-Za-z]:[\\/]/.test(binary)) {
    return { checkable: true, present: existsSync(binary) };
  }
  if (/[\\/]/.test(binary)) return { checkable: true, present: existsSync(join(root, binary)) };
  return { checkable: false, present: false };
}
