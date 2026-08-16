#!/usr/bin/env node
/**
 * Cold start: a Node repo, from nothing to a green `spec-flow check`, through
 * the route the README documents.
 *
 * Every other fixture here tests a piece. This tests the claim a reader forms
 * from the front page — that they can adopt this engine — and it is the only
 * check that fails when adoption breaks for a reason no single piece owns.
 *
 * **Nothing is installed and nothing is hand-written.** The repo's suite is
 * `node --test`, which ships with the Node this engine already requires and
 * emits JUnit XML behind a flag. That matters more than convenience: the last
 * time this fixture wrote a report by hand it wrote one no runner could
 * produce, and a real, executed, passing test reading as absent went unnoticed
 * in exactly the check that exists to notice it. The report here is written by
 * a runner, so a spelling this engine cannot bind fails loudly.
 *
 * The claim under test moved with ADR-007. It used to be that a repo the
 * engine could guess nothing about could still satisfy the contract by hand;
 * the supported scope is Node now, and the front page promises more than
 * satisfiability — that `init` reads the commands, appends the reporter flag,
 * and leaves a bounded, named set of gaps. Each of those is a case below.
 *
 *   node scripts/cold-start.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENGINE = join(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

/** Always from the repo's own root, always by path — the documented route. */
function engine(script, cwd, args = []) {
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR; // a real adopter has none
  return spawnSync(process.execPath, [join(ENGINE, 'scripts', script), ...args], {
    cwd,
    env,
    encoding: 'utf8',
  });
}

const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });

function check(name, problem) {
  if (problem) failures.push(`${name}\n    ${problem}`);
}

const repo = mkdtempSync(join(tmpdir(), 'spec-flow-cold-'));

try {
  // ---- an ordinary Node repo, and nothing else -----------------------------
  mkdirSync(join(repo, 'lib'), { recursive: true });
  mkdirSync(join(repo, 'test'), { recursive: true });
  writeFileSync(
    join(repo, 'package.json'),
    `${JSON.stringify(
      {
        name: 'cold-start',
        version: '1.0.0',
        type: 'module',
        // Through an interpreter on purpose. It is the zero-dependency Node
        // setup, it is the case where `init` CANNOT name the runner from the
        // bin, and it is therefore the one that proves the reporter flag is
        // found from the argv rather than from `test_name`.
        scripts: { test: 'node --test', lint: 'node -e "process.exit(0)"' },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(repo, 'lib', 'login.js'), 'export const login = (user, password) => password === "right";\n');
  // Enough files for the scope globs to be a reading rather than a guess. A
  // one-file repo makes `init` report a field it would have detected in any
  // real project, which would inflate the count below into a false regression.
  for (const name of ['session', 'token', 'user', 'audit']) {
    writeFileSync(join(repo, 'lib', `${name}.js`), `export const ${name} = () => '${name}';\n`);
  }
  writeFileSync(
    join(repo, 'test', 'auth.test.js'),
    "import { test } from 'node:test';\n" +
      "import assert from 'node:assert';\n" +
      "import { login } from '../lib/login.js';\n\n" +
      "test('REQ-AUTH-001 a bad password is rejected', () => {\n" +
      "  assert.equal(login('u', 'wrong'), false);\n" +
      '});\n',
  );

  git(repo, 'init', '-q', '.');
  git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(repo, 'config', 'user.email', 'cold@start.test');
  git(repo, 'config', 'user.name', 'cold-start');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'baseline');

  check(
    'nothing was installed for this fixture',
    existsSync(join(repo, 'node_modules'))
      ? 'the fixture installed a runner, so it no longer proves the documented route works on a fresh clone'
      : null,
  );

  // ---- step 3: init ---------------------------------------------------------
  const init = engine('init.mjs', repo);
  const initOut = `${init.stdout}${init.stderr}`;

  const contractPath = join(repo, '.spec-flow', 'config.json');
  check('init wrote a contract', existsSync(contractPath) ? null : `no contract was written:\n${initOut}`);

  const initial = JSON.parse(readFileSync(contractPath, 'utf8'));
  check(
    'init leaves a proof source the engine can read, with no code for the adopter to write',
    initial.trace?.report?.format && initial.trace?.report?.path
      ? null
      : `init did not declare a readable report source: ${JSON.stringify(initial.trace)}`,
  );

  // The front page's strongest claim, and the one ADR-007 bought by narrowing
  // the scope: the flag is appended, not described.
  check(
    'init appends the reporter flag for a runner in scope',
    initial.verify.test.some((token) => token.includes(initial.trace.report.path))
      ? null
      : `verify.test does not write the report the contract points at: ${JSON.stringify(initial.verify.test)}`,
  );

  check(
    'no translator is scaffolded unasked',
    existsSync(join(repo, '.spec-flow', 'tests-that-ran.mjs'))
      ? 'a translator stub was written though nothing points at it — an unreferenced file that can rot unnoticed'
      : null,
  );

  // What an adopter actually has to supply, counted so that growth is visible
  // rather than absorbed. This number going UP is a real regression in
  // adoption cost even when every other check here still passes.
  const missing = initOut.split('\n').filter((l) => l.trim().startsWith('MISSING'));
  check(
    'the adopter is asked for a known, bounded set of fields',
    missing.length > 3 ? `a Node repo is now asked for ${missing.length} fields:\n${missing.join('\n')}` : null,
  );

  // ---- the adopter fills in what init asked for -----------------------------
  //
  // Only what init NAMED: the runner and the linter cannot be read off a script
  // that runs through `node`. Everything else, including the reporter flag,
  // came from init.
  const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
  contract.verify.scope_globs = ['*.js'];
  contract.verify.test_name = 'node-test';
  contract.verify.lint_name = 'fixture-lint';
  contract.verify.lint_config_hint = 'package.json';
  writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`);

  writeFileSync(
    join(repo, 'specs', 'auth.md'),
    '<!-- spec-scope: lib -->\n\n# Auth\n\n### REQ-AUTH-001 — a bad password is rejected\n\nThe system rejects a login whose password does not match.\n',
  );

  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'adopt spec-flow');
  git(repo, 'checkout', '-qb', 'feature');
  writeFileSync(join(repo, 'lib', 'login.js'), 'export const login = (user, password) => password === "right"; // changed\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'work');

  // ---- step 4: the check the gate will run ---------------------------------
  const green = engine('check-changed.mjs', repo);
  const out = `${green.stdout}${green.stderr}`;

  check(
    'a Node repo reaches a green check through the documented route',
    green.status !== 0 ? `spec-flow check failed on a repo init configured:\n${out}` : null,
  );
  check(
    'the requirement binds to the test the runner reported',
    /every one proven by a test/.test(out) ? null : `spec-trace did not report the requirement as proven:\n${out}`,
  );
  check(
    'the report was written by the run the gate performed',
    existsSync(join(repo, contract.trace.report.path))
      ? null
      : `no report at ${contract.trace.report.path} after the suite ran — the appended flag does not produce one`,
  );

  // ---- and the property the whole binding rests on -------------------------
  //
  // The test still exists and still names the requirement; it is skipped, and
  // the runner writes that skip itself. If this passes, every requirement is
  // one skip away from unproven while the check stays green.
  writeFileSync(
    join(repo, 'test', 'auth.test.js'),
    "import { test } from 'node:test';\n\n" +
      "test('REQ-AUTH-001 a bad password is rejected', { skip: 'wip' }, () => {});\n",
  );
  const rerun = engine('check-changed.mjs', repo);
  const skippedOut = `${rerun.stdout}${rerun.stderr}`;

  check(
    'a test the runner reported as skipped is not proof',
    rerun.status === 0
      ? `a requirement stayed proven after its test stopped running:\n${skippedOut}`
      : null,
  );
  check(
    'the skip is read from the report, not guessed',
    /REQ-AUTH-001/.test(skippedOut)
      ? null
      : `the failure did not name the requirement whose proof disappeared:\n${skippedOut}`,
  );
} finally {
  rmSync(repo, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`cold-start: ${failures.length} case(s) failed\n`);
  for (const f of failures) console.error(`  ✕ ${f}\n`);
  process.exit(1);
}

console.log(
  'cold-start: OK — a Node repo goes from nothing to a green check through the documented route, with the reporter flag init appended and a report its own runner wrote.',
);
