#!/usr/bin/env node
/**
 * Cold start: a repo that is not an npm package, from nothing to a green
 * `spec-flow check`, through the route the README documents.
 *
 * Every other fixture here tests a piece. This tests the claim a reader forms
 * from the front page — that they can adopt this engine — and it is the only
 * check that fails when adoption breaks for a reason no single piece owns.
 *
 * The repo it builds is deliberately hostile to the engine's own habits: no
 * `package.json`, no `node_modules`, sources and tests in a language this
 * engine has no code for. Until recently that repo could not finish one
 * milestone — `spec-trace` read a real, executed test as absent — and nothing
 * in CI would have said so, because every fixture was written in the stack
 * the engine happened to be written in.
 *
 * **It runs the engine the way a non-npm repo has to**: by path, out of a
 * clone, from the consuming repo's root, with no arguments and no environment
 * variables. That is the second install route in the README, and this is what
 * holds it to being true.
 *
 * `python3` is the only thing it needs beyond git and Node, and it is used as
 * a stand-in rather than a dependency — no test framework is installed. The
 * claim under test is not that pytest works; it is that a repo whose commands
 * this engine cannot guess anything about can still satisfy the contract.
 *
 *   node scripts/cold-start.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
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
  // ---- a repo with nothing this engine can read ----------------------------
  mkdirSync(join(repo, 'modules', 'auth'), { recursive: true });
  mkdirSync(join(repo, 'tests'), { recursive: true });
  writeFileSync(join(repo, 'pyproject.toml'), '[project]\nname = "demo"\n');
  writeFileSync(join(repo, 'modules', 'auth', 'login.py'), 'def login(user, password):\n    return password == "right"\n');
  writeFileSync(
    join(repo, 'tests', 'auth_test.py'),
    'def test_REQ_AUTH_001_a_bad_password_is_rejected():\n    assert True\n',
  );

  git(repo, 'init', '-q', '.');
  git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(repo, 'config', 'user.email', 'cold@start.test');
  git(repo, 'config', 'user.name', 'cold-start');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'baseline');

  check(
    'the repo under test is genuinely not an npm package',
    existsSync(join(repo, 'package.json')) || existsSync(join(repo, 'node_modules'))
      ? 'the fixture built an npm package, so it proves nothing about a repo that is not one'
      : null,
  );

  // ---- step 3: init ---------------------------------------------------------
  const init = engine('init.mjs', repo);

  check(
    'init refuses to call an unusable contract finished',
    init.status === 0 ? `init exited 0 on a repo where it could detect almost nothing:\n${init.stdout}` : null,
  );
  // ADR-005: what init leaves behind is a contract naming a report FORMAT the
  // engine can read, not a file the adopter must program. The assertion moved
  // with the decision — a stub written here would now be a file nothing points
  // at.
  const initial = JSON.parse(readFileSync(join(repo, '.spec-flow', 'config.json'), 'utf8'));
  check(
    'init leaves a proof source the engine can read, with no code for the adopter to write',
    initial.trace?.report?.format && initial.trace?.report?.path
      ? null
      : `init did not declare a readable report source: ${JSON.stringify(initial.trace)}`,
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
  const missing = init.stdout.split('\n').filter((l) => l.trim().startsWith('MISSING'));
  check(
    'the adopter is asked for a known, bounded set of fields',
    missing.length > 6
      ? `a non-Node repo is now asked for ${missing.length} fields:\n${missing.join('\n')}`
      : null,
  );

  // ---- the adopter fills in what init asked for -----------------------------
  //
  // Written the way a human would: the contract's own values, not the
  // engine's. `python3 -c` stands in for a linter and a runner so this needs
  // nothing installed — what is under test is the CONTRACT being satisfiable,
  // not any particular tool.
  const contract = JSON.parse(readFileSync(join(repo, '.spec-flow', 'config.json'), 'utf8'));
  contract.verify.scope_globs = ['*.py'];
  contract.verify.lint = ['python3', '-c', 'pass'];
  contract.verify.lint_no_fix = ['python3', '-c', 'pass'];
  contract.verify.lint_name = 'ruff';
  contract.verify.lint_config_hint = 'pyproject.toml';
  contract.verify.test = ['python3', '-c', 'pass'];
  contract.verify.test_name = 'pytest';
  contract.trace.proof_dir = 'tests';
  contract.trace.proof_suffix = '_test.py';
  writeFileSync(join(repo, '.spec-flow', 'config.json'), `${JSON.stringify(contract, null, 2)}\n`);

  // And leaves the report where the contract says it goes — the shape a
  // `--junitxml`-style flag produces, written here directly because this
  // fixture must install nothing. The point of the case is that the ENGINE
  // reads it: nothing in this repo is Node, nothing was programmed for the
  // engine, and no runner is named anywhere in the parser.
  //
  // **The `name` must match the function declared above it, character for
  // character.** A report is written FROM the test's identifier, so a hand-
  // written one that spells the id differently than the source it claims to
  // report is testing a file no runner could produce — which is how this
  // check, whose whole job is failing when adoption breaks, went green over a
  // real repo where a passing test read as absent.
  const junit = (name, skipped = false) =>
    `<?xml version="1.0" encoding="utf-8"?>\n<testsuites>\n  <testsuite name="pytest" tests="1">\n    <testcase classname="tests.auth_test" name="${name}" time="0.01">${skipped ? '<skipped/>' : ''}</testcase>\n  </testsuite>\n</testsuites>\n`;

  mkdirSync(join(repo, dirname(contract.trace.report.path)), { recursive: true });
  writeFileSync(join(repo, contract.trace.report.path), junit('test_REQ_AUTH_001_a_bad_password_is_rejected'));

  writeFileSync(
    join(repo, 'specs', 'auth.md'),
    '<!-- spec-scope: modules/auth -->\n\n# Auth\n\n### REQ-AUTH-001 — a bad password is rejected\n\nThe system rejects a login whose password does not match.\n',
  );

  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'adopt spec-flow');
  git(repo, 'checkout', '-qb', 'feature');
  writeFileSync(join(repo, 'modules', 'auth', 'login.py'), 'def login(user, password):\n    return password == "right"  # changed\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'work');

  // ---- step 4: the check the gate will run ---------------------------------
  const green = engine('check-changed.mjs', repo);
  const out = `${green.stdout}${green.stderr}`;

  check(
    'a repo the engine can detect nothing about reaches a green check',
    green.status !== 0 ? `spec-flow check failed on a fully configured non-Node repo:\n${out}` : null,
  );
  check(
    'the requirement binds to the test the runner reported',
    /every one proven by a test/.test(out) ? null : `spec-trace did not report the requirement as proven:\n${out}`,
  );

  // ---- and the property the whole binding rests on -------------------------
  //
  // The test still exists and still names the requirement — the report now
  // marks it `<skipped/>`, which is a real skip written the way a real runner
  // writes one, rather than a line removed from a text file. If this passes,
  // every requirement in every language is one skip decorator from unproven
  // while the check stays green.
  writeFileSync(
    join(repo, contract.trace.report.path),
    junit('test_REQ_AUTH_001_a_bad_password_is_rejected', true),
  );
  const skipped = engine('spec-trace.mjs', repo);
  check(
    'a test the runner did not report is not proof, in a language the engine has no code for',
    skipped.status === 0
      ? `a requirement stayed proven after its test stopped being reported:\n${skipped.stdout}${skipped.stderr}`
      : null,
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
  'cold-start: OK — a repo with no package.json, in a language this engine has no code for, goes from nothing to a green check.',
);
