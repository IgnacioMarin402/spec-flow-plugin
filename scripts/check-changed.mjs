#!/usr/bin/env node
/**
 * Lint + format + test, scoped to the files THIS BRANCH changed, plus the
 * checks that deliberately run unscoped — the everyday command a human (or
 * Claude, when asked to check its work) runs directly.
 *
 * This is engine, not repo. It decides nothing about the repo it runs
 * in — it reads the same contract the gate reads and runs the same commands
 * the gate runs, adding only a human-readable summary. It moved here, out of
 * the original plan's repo-side listing, because leaving it there recreates
 * exactly what steps 0 and 1 of docs/spec-flow-as-a-plugin.md (in the engine
 * repo) closed: a second implementation of "is this tree green", free to
 * drift from what the gate computes. See that document's "Two manifests, one
 * source" for the full reasoning.
 *
 * A consuming repo reaches this through a one-line alias in its own
 * package.json:
 *
 *   "check": "spec-flow check"
 *
 * which `bin/spec-flow` in this package resolves to `node
 * <package>/scripts/check-changed.mjs`. Both that alias and the gate hook run
 * this SAME file, so "same files, same commands, same result" is structural.
 *
 *   node scripts/check-changed.mjs          # eslint --fix + test on changed files
 *   node scripts/check-changed.mjs --no-fix # report only, change nothing
 */
import { spawnSync } from 'node:child_process';
import { loadConfig } from './spec-flow-config.mjs';
import { resolveBase, changedFiles } from './changed-files.mjs';
import { runUnscopedChecks, summary } from './unscoped-checks.mjs';

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const fix = !process.argv.includes('--no-fix');

// Unguarded, like every consumer of the contract: a version this engine does
// not recognize must stop the run loudly, not fall back to stale defaults.
// See spec-flow-config.mjs's header for the bash-era bug this replaces.
const config = loadConfig(root);

const base = resolveBase(root);
const files = changedFiles(root, config.verify.scope_globs, base);

let lintRc = 0;
let testRc = 0;

if (files.length === 0) {
  console.log(`No changed files in scope vs ${base} — skipping lint and tests.`);
} else {
  console.log(`Checking ${files.length} changed file(s) vs ${base}:`);
  for (const f of files) console.log(`  ${f}`);
  console.log('');

  const lintArgv = fix ? config.verify.lint : config.verify.lint_no_fix;
  console.log(`--- ${config.verify.lint_name} ${fix ? '' : '(no fix)'} ---`);
  const lintRes = spawnSync(lintArgv[0], [...lintArgv.slice(1), ...files], { cwd: root, stdio: 'inherit' });
  lintRc = lintRes.status ?? 1;

  console.log(`\n--- ${config.verify.test_name} ---`);
  const testRes = spawnSync(config.verify.test[0], [...config.verify.test.slice(1), ...files], { cwd: root, stdio: 'inherit' });
  testRc = testRes.status ?? 1;
  console.log('');
}

// ---- the unscoped checks ---------------------------------------------------
// Not scoped to the changed files, and they run even when no file changed at
// all — the same declaration the gate and done-guard read, so a check added
// to the contract arms all three consumers at the same moment.
const result = runUnscopedChecks(root, config);
for (const c of result.checks) {
  console.log(`--- ${c.name} ---`);
  console.log(c.out);
  console.log('');
}

if (lintRc === 0 && testRc === 0 && result.allPass) {
  console.log(`OK — lint, tests and the unscoped checks pass (${summary(result)}).`);
  process.exit(0);
}
console.log(`FAILED — lint rc=${lintRc}, tests rc=${testRc}, ${summary(result)}`);
process.exit(1);
