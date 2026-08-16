#!/usr/bin/env node
/**
 * Lint + format + test, scoped to the files THIS BRANCH changed, plus the
 * checks that deliberately run unscoped — the everyday command a human (or
 * Claude, when asked to check its work) runs directly.
 *
 * This is engine, not repo. It decides nothing about the repo it runs in — it
 * reads the same contract the gate reads and runs the same commands, adding
 * only a human-readable summary. **It must never live in a consuming repo:**
 * that would be a second implementation of "is this tree green", free to drift
 * from what the gate computes.
 *
 * A repo reaches it through an alias (`"check": "spec-flow check"`) or by path
 * out of a clone. Every route runs this SAME file, which is what makes "same
 * commands, same result" structural rather than a promise.
 *
 *   node scripts/check-changed.mjs          # autofix lint + test, scoped
 *   node scripts/check-changed.mjs --no-fix # report only, change nothing
 */
import { spawnSync } from 'node:child_process';
import { loadConfig, ensureReportDir } from './spec-flow-config.mjs';
import { resolveBase, changedFiles } from './changed-files.mjs';
import { runUnscopedChecks, summary } from './unscoped-checks.mjs';

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const fix = !process.argv.includes('--no-fix');

// Unguarded, like every consumer of the contract: a version this engine does
// not recognize must stop the run loudly, not fall back to stale defaults.
// See spec-flow-config.mjs's header for the bash-era bug this replaces.
const config = loadConfig(root);

// Unguarded for the same reason `loadConfig` is: `resolveBase` throws rather
// than falling back to a base that matches nothing, and catching that to
// print "no changed files" would make this command report a clean tree it
// never looked at — the same lie the gate used to tell. See resolveBase in
// changed-files.mjs.
let base;
try {
  base = resolveBase(root, config);
} catch (err) {
  console.error(`spec-flow check: ${err.message}`);
  process.exit(1);
}

const files = changedFiles(root, config.verify.scope_globs, base);

let lintRc = 0;

if (files.length === 0) {
  // Two different facts print the same sentence otherwise. When the resolved
  // base IS HEAD there is no diff to be empty: this branch has nothing the
  // base does not, so the scope is empty by construction and will stay empty
  // for every commit made this way. The gate REFUSES that (see hooks/gate.mjs);
  // this command reports it and keeps going, deliberately — the gate's job is
  // to withhold a pass, this one's is to tell a human what it looked at, and
  // the suite and unscoped checks below are still worth running.
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  if (head.status === 0 && head.stdout.trim() === base) {
    console.log(
      `No changed files in scope: the base resolved to HEAD itself, so the diff is empty by construction — ${config.verify.lint_name} is not sitting this out because nothing changed. Work on a branch off your base, or declare verify.base_ref in .spec-flow/config.json. The gate blocks on this.`,
    );
  } else {
    console.log(`No changed files in scope vs ${base} — skipping lint.`);
  }
} else {
  console.log(`Checking ${files.length} changed file(s) vs ${base}:`);
  for (const f of files) console.log(`  ${f}`);
  console.log('');

  const lintArgv = fix ? config.verify.lint : config.verify.lint_no_fix;
  console.log(`--- ${config.verify.lint_name} ${fix ? '' : '(no fix)'} ---`);
  const lintRes = spawnSync(lintArgv[0], [...lintArgv.slice(1), ...files], { cwd: root, stdio: 'inherit' });
  lintRc = lintRes.status ?? 1;
  console.log('');
}

// Outside the `files.length` branch, and NOT scoped to `files` — both for the
// same reason as hooks/gate.mjs, which this file must agree with command for
// command: this alias and the gate hook run the SAME file, so "same files,
// same commands, same result" stays structural rather than a promise two
// copies keep only while they happen to agree (see this file's own header).
// A trailing path filters TEST files to these runners, not "run what's
// related to these sources"; and an empty diff is a fact about the diff, not
// about whether the suite passes.
console.log(`--- ${config.verify.test_name} ---`);
ensureReportDir(root, config);
const testRes = spawnSync(config.verify.test[0], config.verify.test.slice(1), { cwd: root, stdio: 'inherit' });
const testRc = testRes.status ?? 1;
console.log('');

// ---- the unscoped checks ---------------------------------------------------
// Not scoped to the changed files, and they run even when no file changed at
// all — the same declaration the gate and phase-guard read, so a check added
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
