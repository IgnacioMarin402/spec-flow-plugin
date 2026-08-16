#!/usr/bin/env node
/**
 * Behaviour fixture for scripts/spec-trace.mjs.
 *
 * spec-trace is what makes `specs/` authoritative instead of decorative: it
 * binds a requirement id to the test that proves it, in both directions, and
 * fails the gate when they disagree. It is ~270 lines of regex parsing that
 * runs on every gate, every phase-guard and every check command — and until
 * this file existed it had no test of its own. `gate-fixture.mjs`
 * deliberately replaces it with a green/red stub, so nothing anywhere
 * exercised the actual parsing.
 *
 * Tested the same way as the gate: by RUNNING it. Each case builds a
 * throwaway repo, writes a file map into it, spawns the real script with
 * `CLAUDE_PROJECT_DIR` pointed at that repo, and asserts on the exit code
 * and the problems it named. No repo here has a `.git` — spec-trace never
 * shells out to git, so a fixture that created one would be testing
 * scaffolding rather than the script.
 *
 * The contract each case is testing: a problem must be REPORTED (exit 1 and
 * named in the output), not merely survived. A parser that silently matches
 * nothing looks identical to a repo where everything is proven — which is
 * the failure mode this whole engine is built against.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC_TRACE = join(ROOT, 'scripts', 'spec-trace.mjs');
const failures = [];

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, opts);
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d) => (stdout += d));
    child.stderr?.on('data', (d) => (stderr += d));
    child.on('error', () => resolve({ status: -1, stdout, stderr }));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

async function check(name, fn) {
  try {
    const problem = await fn();
    if (problem) failures.push(`${name}\n    ${problem}`);
  } catch (err) {
    failures.push(`${name}\n    threw: ${err.message}`);
  }
}

const CONFIG = {
  contract_version: 1,
  verify: {
    scope_globs: ['*.ts'],
    lint: ['node', '-e', 'process.exit(0)'],
    lint_no_fix: ['node', '-e', 'process.exit(0)'],
    test: ['node', '-e', 'process.exit(0)'],
    test_name: 'fixture-test',
    lint_name: 'fixture-lint',
    lint_config_hint: 'fixture.config',
  },
  // `executed_tests` names the one requirement `spec()` declares, so every
  // case that is not ABOUT proof keeps reading the way it did when a walk
  // found `tests/user.test.ts`. Cases that assert an absence of proof override
  // it with `ran()` — an empty report — which is now the honest way to say
  // "nothing ran" rather than deleting a file and hoping the walk missed it.
  trace: {
    specs_dir: 'specs',
    proof_dir: 'tests',
    proof_suffix: '.test.ts',
    executed_tests: ['node', '-e', 'console.log("tests/user.test.ts::REQ-USER-001 the user can do the thing")'],
    // Present and null, exactly as the loader defaults it, so `reportContract`
    // below can assign to it. Omitting it left the inferred type without the
    // property, which is the one thing `npm run typecheck` had to say about
    // this engine and it said it on every run.
    report: null,
    not_a_capability: ['README.md'],
  },
  extra_checks: [],
  unscoped_denied: { scripts: [], tools: [], scoped_allowed: [], scoped_alternative: '', scoped_examples: [] },
};

/** A capability spec declaring one requirement, with the scope marker spec-trace requires. */
function spec(id = 'REQ-USER-001', title = 'the user can do the thing', scope = 'modules/user') {
  return `<!-- spec-scope: ${scope} -->\n\n# User\n\n### ${id} — ${title}\n\nThe system does the thing.\n`;
}

/**
 * A `trace.executed_tests` command reporting exactly these lines as the tests
 * that RAN — the port B1 replaces source-parsing with.
 *
 * The engine's whole contract here is "lines naming a test that executed", so
 * a fixture can express any runner's output by writing the lines directly.
 * That is the point of the port: what the repo's translator emits is the
 * repo's business, and these cases prove the engine never needs to know which
 * runner produced them.
 */
const ran = (...lines) => ['node', '-e', `console.log(${JSON.stringify(lines.join('\n'))})`];

/**
 * The default contract with a different report: the tests this run executed.
 *
 * `contract()` with no lines is a suite that ran and reported nothing, which
 * is how a case says "no proof" now. Deleting a test FILE no longer says it —
 * files stopped being what proof is made of.
 */
const contract = (...lines) =>
  JSON.stringify({ ...CONFIG, trace: { ...CONFIG.trace, executed_tests: ran(...lines) } }, null, 2);

/**
 * The default contract with its proof source replaced by a report FILE, or by
 * nothing at all when `report` is null.
 *
 * `executed_tests` is deleted rather than left beside it, because the contract
 * rejects declaring both — which is itself a case below.
 */
function reportContract(report) {
  const trace = { ...CONFIG.trace };
  delete trace.executed_tests;
  if (report) trace.report = report;
  return JSON.stringify({ ...CONFIG, trace }, null, 2);
}

// A junit report naming the requirement `spec()` declares as EXECUTED, and the
// same report with that test skipped. Shapes taken from real emitters; the
// formats themselves are covered by test-report-fixture.mjs.
const JUNIT_RAN = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="fixture" tests="1" failures="0">
    <testsuite name="tests/user.test.ts" tests="1" failures="0">
        <testcase classname="tests/user.test.ts" name="REQ-USER-001 the user can do the thing" time="0.001">
        </testcase>
    </testsuite>
</testsuites>
`;

const JUNIT_SKIPPED = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="fixture" tests="1" failures="0">
    <testsuite name="tests/user.test.ts" tests="1" failures="0" skipped="1">
        <testcase classname="tests/user.test.ts" name="REQ-USER-001 the user can do the thing" time="0">
            <skipped/>
        </testcase>
    </testsuite>
</testsuites>
`;

/**
 * The contract of a project that DOES route skills and has asked for the
 * milestone field to be enforced. Written out by the cases that test the
 * check, so none of them depends on what the default happens to be — the
 * default is a decision with its own case, not scaffolding for these.
 *
 * Reports nothing, because those cases declare no capability specs: a report
 * naming a requirement no spec declares is drift, and would fail them for a
 * reason that has nothing to do with skills.
 */
const SKILLS_REQUIRED = JSON.stringify(
  { ...CONFIG, trace: { ...CONFIG.trace, require_skills_field: true, executed_tests: ran() } },
  null,
  2,
);

/**
 * Builds a repo from a plain {relativePath: contents} map and runs the real
 * spec-trace against it. `files` always gets the contract merged in unless
 * the case wrote its own.
 */
async function withRepo(files, assert) {
  const repoDir = mkdtempSync(join(tmpdir(), 'spec-trace-repo-'));
  try {
    const all = { '.spec-flow/config.json': JSON.stringify(CONFIG, null, 2), ...files };
    for (const [rel, contents] of Object.entries(all)) {
      if (contents === null) continue; // a case can opt a default file out
      const full = join(repoDir, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, contents);
    }

    const env = { ...process.env, CLAUDE_PROJECT_DIR: repoDir };
    const res = await run('node', [SPEC_TRACE], { cwd: tmpdir(), env });
    return await assert({ ...res, out: `${res.stdout}${res.stderr}` }, repoDir);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
}

await Promise.all([
  // ==== B1: proof comes from what the runner REPORTED as executed ============
  //
  // These five cases are the red half of B1. Four of them describe the port
  // that replaces source-parsing; the first describes a defect the current
  // static walk has TODAY, in plain TypeScript, with no other language
  // involved — which is why it leads.

  // A dependency directory is not in NEVER_WALK unless someone thought of its
  // name. `venv` was not thought of, and neither were `site-packages`,
  // `__pycache__` or `target` — but the failure needs none of those: any
  // vendored tree with a `tests/` segment and a matching suffix is walked and
  // its contents registered as this repo's proof. Here that manufactures a
  // requirement the repo never declared, out of a third party's test, and
  // fails a gate over it.
  check('a vendored dependency tree does not register as this repo\'s proof', () =>
    withRepo(
      {
        'specs/user.md': spec(),
        'tests/user.test.ts': `it('REQ-USER-001 x', () => {});\n`,
        'venv/lib/site-packages/pkg/tests/vendored.test.ts': `it('REQ-USER-999 a third party proves its own thing', () => {});\n`,
      },
      (r) => {
        if (/REQ-USER-999/.test(r.out)) {
          return `a vendored test became this repo's problem: ${r.out}`;
        }
        if (r.status !== 0) return `a repo whose own specs and tests agree was blocked: ${r.out}`;
        return null;
      },
    ),
  ),

  // The engine reads lines, not a language. pytest's node ids and Go's
  // subtest paths are just two shapes of line, and neither is known to the
  // engine — the repo's translator emitted them.
  check('a pytest-shaped report proves a requirement', () =>
    withRepo(
      {
        '.spec-flow/config.json': JSON.stringify(
          { ...CONFIG, trace: { ...CONFIG.trace, executed_tests: ran('tests/auth_test.py::test_REQ-USER-001_rejects') } },
          null,
          2,
        ),
        'specs/user.md': spec(),
      },
      (r) => (r.status === 0 ? null : `a real, executed pytest proof was reported as absent: ${r.out}`),
    ),
  ),

  check('a Go-shaped subtest report proves a requirement', () =>
    withRepo(
      {
        '.spec-flow/config.json': JSON.stringify(
          { ...CONFIG, trace: { ...CONFIG.trace, executed_tests: ran('--- PASS: TestAuth/REQ-USER-001_rejects_a_bad_password (0.00s)') } },
          null,
          2,
        ),
        'specs/user.md': spec(),
      },
      (r) => (r.status === 0 ? null : `a real, executed Go proof was reported as absent: ${r.out}`),
    ),
  ),

  // ---- the other source: a report file the runner already writes -----------
  //
  // These assert the SEAM, not the parser — test-report-fixture.mjs owns the
  // formats, against captures from real emitters. What matters here is that a
  // contract naming a file reaches the same verdicts as one naming a command,
  // including the two that must never collapse into each other.

  check('a junit report proves a requirement', () =>
    withRepo(
      {
        '.spec-flow/config.json': reportContract({ format: 'junit', path: 'reports/junit.xml' }),
        'reports/junit.xml': JUNIT_RAN,
        'specs/user.md': spec(),
      },
      (r) => (r.status === 0 ? null : `an executed test named in a junit report was reported as absent: ${r.out}`),
    ),
  ),

  // The whole reason a format reader is allowed to exist: `<skipped/>` is in
  // the JUnit schema, so "did it run" is answered without knowing the runner.
  check('a test that is <skipped/> in the report does not prove its requirement', () =>
    withRepo(
      {
        '.spec-flow/config.json': reportContract({ format: 'junit', path: 'reports/junit.xml' }),
        'reports/junit.xml': JUNIT_SKIPPED,
        'specs/user.md': spec(),
      },
      (r) => {
        if (r.status === 0) return `a skipped test proved a requirement: ${r.out}`;
        if (!/has no test/.test(r.out)) return `expected the requirement to read as unproven, got: ${r.out}`;
        // A report holding one real, skipped test case is not a report that
        // said nothing — that message exists for a different failure (the
        // reporter flag missing, or a stale path) and would send someone to
        // fix a flag that was never broken. This is the assertion the
        // reportSkipped guard exists for; it was untested until it was
        // mutation-tested and this exact wording leaked through.
        if (/reported no tests at all/.test(r.out)) {
          return `a report with one skipped case was also reported as though it said nothing at all: ${r.out}`;
        }
        return null;
      },
    ),
  ),

  // Same distinction as the empty-report case below, one layer out: a report
  // that was never written means the reporter flag is missing from
  // `verify.test`, not that the repo has an unproven requirement.
  check('a report file that was never written is a refusal, not "has no test"', () =>
    withRepo(
      {
        '.spec-flow/config.json': reportContract({ format: 'junit', path: 'reports/junit.xml' }),
        'specs/user.md': spec(),
      },
      (r) => {
        if (r.status === 0) return `a missing report passed: ${r.out}`;
        if (/has no test/.test(r.out)) return `a missing report read as an unproven requirement: ${r.out}`;
        if (!/reporter flag|does not exist/.test(r.out)) return `the refusal did not name the likely cause: ${r.out}`;
        return null;
      },
    ),
  ),

  // ---- opting out, and the one thing that makes it honest ------------------

  check('no source and no requirements is a pass that says why it passed', () =>
    withRepo(
      { '.spec-flow/config.json': reportContract(null) },
      (r) => {
        if (r.status !== 0) return `a repo with nothing to prove was blocked: ${r.out}`;
        if (!/not configured/i.test(r.out)) {
          return `it passed without saying it was unarmed, which is how an unarmed check gets mistaken for a passing one: ${r.out}`;
        }
        return null;
      },
    ),
  ),

  check('no source WITH requirements is refused — opting out stops being coherent', () =>
    withRepo(
      { '.spec-flow/config.json': reportContract(null), 'specs/user.md': spec() },
      (r) => {
        if (r.status === 0) {
          return 'a repo declared a requirement and no way to prove it, and the check went green — an opt-out that survives its own precondition is a disarmed gate';
        }
        if (!/opt-in|opted out|trace\.report/.test(r.out)) return `the refusal did not say how to arm it: ${r.out}`;
        return null;
      },
    ),
  ),

  // The state every adopter is in on their first run, and the one no case
  // here covered: `init` always writes `trace.report`, so "declared but not
  // producing anything yet" — not "no source" — is what the install route
  // ends on. Its pair is the refusal case above: the SAME missing report with
  // a requirement declared must still be refused, which is what keeps this
  // grace from being an opt-out that outlives its precondition.
  check('a declared report that has not landed yet, with nothing to prove, is not a refusal', () =>
    withRepo(
      { '.spec-flow/config.json': reportContract({ format: 'junit', path: 'reports/junit.xml' }) },
      (r) => {
        if (r.status !== 0) {
          return `the contract init writes failed the command the install route ends with, on a repo with no requirements: ${r.out}`;
        }
        if (!/nothing to bind|no requirement/i.test(r.out)) {
          return `it passed without saying it was unarmed, which is how an unarmed check gets mistaken for a passing one: ${r.out}`;
        }
        return null;
      },
    ),
  ),

  // A capability file with no `###` heading yet is a real state — a fold that
  // wrote the file before the first requirement landed in it — and it is the
  // one where `specs/` is non-empty while `requirements` is. The green must
  // not claim proof it never looked for.
  check('an unarmed source never reports requirements as proven', () =>
    withRepo(
      {
        '.spec-flow/config.json': reportContract({ format: 'junit', path: 'reports/junit.xml' }),
        'specs/user.md': '<!-- spec-scope: modules/user -->\n\n# User\n\nNo requirement declared yet.\n',
      },
      (r) => {
        if (r.status !== 0) return `a spec file with no requirement in it blocked the check: ${r.out}`;
        if (/every one proven by a test/.test(r.out)) {
          return `it claimed every requirement was proven while nothing was read about which tests ran: ${r.out}`;
        }
        return null;
      },
    ),
  ),

  // The same grace on the other proof source. `executed_tests` is where an
  // unfinished translator lands, which is the same fact as a report that has
  // not been written — nothing has been produced to read — and the two must
  // not answer differently for a repo with nothing to prove.
  check('the same grace covers the other proof source, so neither is the odd one out', () =>
    withRepo(
      {
        '.spec-flow/config.json': JSON.stringify(
          { ...CONFIG, trace: { ...CONFIG.trace, executed_tests: ['node', '-e', 'process.exit(3)'] } },
          null,
          2,
        ),
      },
      (r) => {
        if (r.status !== 0) {
          return `a report source producing nothing blocked a repo with no requirements, while a missing report file does not: ${r.out}`;
        }
        return null;
      },
    ),
  ),

  check('the unarmed grace does not swallow the other checks', () =>
    withRepo(
      {
        '.spec-flow/config.json': reportContract({ format: 'junit', path: 'reports/junit.xml' }),
        'specflow/archive/old-change/spec.md': '# Old change\n\nNo status line anywhere.\n',
      },
      (r) => {
        if (r.status === 0) return `an archived change with no status passed under the unarmed grace: ${r.out}`;
        if (!/no status/i.test(r.out)) return `the failure was not the archive problem: ${r.out}`;
        return null;
      },
    ),
  ),

  check('declaring both sources is refused by the contract, not resolved silently', () =>
    withRepo(
      {
        '.spec-flow/config.json': JSON.stringify(
          { ...CONFIG, trace: { ...CONFIG.trace, report: { format: 'junit', path: 'reports/junit.xml' } } },
          null,
          2,
        ),
        'specs/user.md': spec(),
      },
      (r) => {
        if (r.status === 0) return 'two answers to "which tests ran" were accepted, so which one is read is discoverable only from behaviour';
        if (!/both/i.test(r.out)) return `the refusal did not name the conflict: ${r.out}`;
        return null;
      },
    ),
  ),

  // The two outcomes this engine has twice refused to let collapse: "nothing
  // was proven" and "I could not tell". Both exit non-zero, so the exit code
  // cannot be the thing that distinguishes them — the MESSAGE has to, because
  // one sends an implementer to write a test that already exists.
  check('an empty report with requirements is a named refusal, not "has no test"', () =>
    withRepo(
      {
        '.spec-flow/config.json': JSON.stringify(
          { ...CONFIG, trace: { ...CONFIG.trace, executed_tests: ran() } },
          null,
          2,
        ),
        'specs/user.md': spec(),
      },
      (r) => {
        if (r.status === 0) return `an empty report passed: ${r.out}`;
        if (/has no test/.test(r.out)) {
          return `an empty report was reported as an unproven requirement, which sends someone to write a test that may already exist: ${r.out}`;
        }
        if (!/report|executed_tests|no tests/i.test(r.out)) {
          return `the refusal did not name the report as the problem: ${r.out}`;
        }
        return null;
      },
    ),
  ),

  check('a report command that fails is a refusal, not an absence of proof', () =>
    withRepo(
      {
        '.spec-flow/config.json': JSON.stringify(
          { ...CONFIG, trace: { ...CONFIG.trace, executed_tests: ['node', '-e', 'process.exit(3)'] } },
          null,
          2,
        ),
        'specs/user.md': spec(),
      },
      (r) => {
        if (r.status === 0) return `a broken report command passed: ${r.out}`;
        if (/has no test/.test(r.out)) return `a broken report command read as an unproven requirement: ${r.out}`;
        return null;
      },
    ),
  ),

  // ---- an empty spec layer: grace while adopting, contradiction after a ship ----
  //
  // With no capability specs there are no requirements, so "every requirement
  // is proven" holds over the empty set and this check reports green. For a
  // repo adopting the engine that is correct — capability specs are written
  // BY the flow, as milestones fold their deltas in. The grace has to end
  // somewhere, and SHIPPED is the only artifact that says where: a fold
  // stamps it to assert those deltas landed in specs/.
  check('an empty spec layer passes while nothing has shipped yet', () =>
    withRepo({ '.spec-flow/config.json': contract('an unrelated test that proves no requirement') }, (r) => {
      if (r.status !== 0) return `a repo mid-adoption was blocked: ${r.out}`;
      if (!/no requirements to bind/.test(r.out)) return `unexpected output: ${r.out}`;
      return null;
    }),
  ),

  // The archived spec has to NAME a requirement, because that is what makes
  // this a contradiction: the change asserts REQ-USER-001 landed in specs/,
  // and specs/ is empty. A SHIPPED stamp with no id claims nothing — see the
  // wiring-only case below.
  check('an empty spec layer FAILS once a change ships a requirement it claims landed', () =>
    withRepo(
      {
        'specflow/archive/add-users/spec.md':
          '# Spec — add users\n\n**Status:** SHIPPED 2026-07-30\n\n## Requirement deltas\n- ADDED REQ-USER-001 — the user can do the thing\n',
        'specflow/archive/add-users/proposal.md': '# Proposal\n\nWhy.\n',
        'tests/placeholder.test.ts': 'it("unrelated", () => {});\n',
      },
      (r) => {
        if (r.status === 0) {
          return `a change claims its deltas landed in specs/, which holds nothing, and spec-trace reported green — every requirement check here is vacuous and the gate would pass over a spec layer that does not exist. out: ${r.out}`;
        }
        if (!/SHIPPED/.test(r.out)) return `the failure does not name what makes this a contradiction: ${r.out}`;
        return null;
      },
    ),
  ),

  // A change that shipped without claiming a requirement asserts nothing
  // about specs/. `/spec-fix` case 4 (INFRA) and any wiring-only change do
  // exactly that, by contract — and the first one in a repo used to block
  // every gate afterwards, with no way out but writing a capability spec the
  // change never needed.
  check('a SHIPPED change with no requirement deltas keeps the grace', () =>
    withRepo(
      {
        'specflow/archive/wiring-only/spec.md':
          '# Fix — wiring only\n\n**Status:** SHIPPED 2026-08-14\n\n## Case\ncase 4 — INFRA\n\n## Requirement deltas\n- none — infrastructure only\n',
        'specflow/archive/wiring-only/proposal.md': '# Proposal\n\nWhy.\n',
        '.spec-flow/config.json': contract('an unrelated test that proves no requirement'),
      },
      (r) => {
        if (r.status !== 0) {
          return `an infrastructure fix that legitimately has no deltas blocked the gate, and no capability spec would ever satisfy it: ${r.out}`;
        }
        return null;
      },
    ),
  ),

  // ---- build output is not proof, and now it cannot be by construction ----
  //
  // The old failure: a compiled or copied test under `dist/` matched the same
  // suffix as its source, so it registered as proof of the requirement its
  // title named — and kept registering after the SOURCE test was deleted,
  // leaving the requirement proven by an artifact nobody runs. It needed a
  // hardcoded skip list to defend against, which then had to stay current with
  // every ecosystem's build directory and did not.
  //
  // Nothing defends against it now. A stale artifact cannot be reported as
  // having run when it did not run, so the case that used to need a list needs
  // nothing.
  check('a stale test surviving only in build output does not prove a requirement', () =>
    withRepo(
      {
        'specs/user.md': spec(),
        '.spec-flow/config.json': contract('tests/other.test.ts::an unrelated test that did run'),
        'dist/tests/user.test.ts': `it('REQ-USER-001 lets the user do the thing', () => {});\n`,
      },
      (r) => {
        if (r.status === 0) {
          return `a build artifact counted as proof: delete the source test and the requirement stays green forever. out: ${r.out}`;
        }
        if (!/REQ-USER-001/.test(r.out)) return `the failure does not name the unproven requirement: ${r.out}`;
        return null;
      },
    ),
  ),

  // ---- and the reverse: where a test LIVES stopped being a question ----
  //
  // Two cases used to live here — one asserting a test outside `proof_dir` was
  // not proof, one asserting a contract declaring `proof_dir: "dist"` beat the
  // engine's skip list. Both existed because location was the only signal
  // available for telling a real test from a string that resembled one.
  //
  // "The runner executed it" is a strictly stronger claim than "it sits in the
  // right directory", so location is not consulted at all. That is a behaviour
  // change worth a case of its own rather than a silent deletion: a repo whose
  // tests live somewhere this engine would never have guessed is now correct
  // by default instead of needing to declare its way out.
  check('a reported test proves its requirement wherever it lives', () =>
    withRepo(
      {
        'specs/user.md': spec(),
        '.spec-flow/config.json': contract('somewhere/nobody/would/guess::REQ-USER-001 the user can do the thing'),
      },
      (r) =>
        r.status !== 0
          ? `a test the runner reported was rejected for living outside proof_dir, which no longer decides anything: ${r.out}`
          : null,
    ),
  ),

  check('a REJECTED change keeps the grace — it asserts nothing landed', () =>
    withRepo(
      {
        'specflow/archive/turned-down/spec.md': '# Spec — turned down\n\n**Status:** REJECTED 2026-07-30\n\nDeltas.\n',
        'specflow/archive/turned-down/proposal.md': '# Proposal\n\nWhy not.\n',
        '.spec-flow/config.json': contract('an unrelated test that proves no requirement'),
      },
      (r) => {
        if (r.status !== 0) return `a rejected change blocked a repo that has still shipped nothing: ${r.out}`;
        return null;
      },
    ),
  ),

  // The adoption grace covers the requirement BINDING and nothing else. It
  // used to exit(0) before the problem report, which discarded everything
  // else this file had already found — during adoption, which is exactly when
  // those habits are forming.
  check('the empty-specs grace does not swallow the other checks', () =>
    withRepo(
      {
        'specflow/mine/spec.md': '# Spec — mine\n\n## Decision\nThis belongs in proposal.md.\n',
        'tests/placeholder.test.ts': 'it("unrelated", () => {});\n',
      },
      (r) => {
        if (r.status === 0) {
          return `a live change with a leaked ## Decision and no proposal.md passed, because specs/ happened to be empty: ${r.out}`;
        }
        if (!/proposal\.md/.test(r.out)) return `the missing proposal was not reported: ${r.out}`;
        return null;
      },
    ),
  ),

  // ---- the Skills field, when the contract asks for it ----
  //
  // `none` is a legitimate answer; absent is not the same answer, because it
  // cannot be told apart from a planner that never looked.
  //
  // A field present with NOTHING after the colon is the third case, and it is
  // the one the check was blind to: it satisfies "the field is there" while
  // answering none of the three questions the field exists to answer. It
  // collapses back into exactly what an absent field is — a milestone whose
  // routing nobody can read — so it fails the same way.
  //
  // Every case in this group declares `require_skills_field` explicitly,
  // because the default is off and a case that relied on the default would be
  // testing the default rather than the check. The default has its own case,
  // last in the group.
  check('a live milestone with no Skills field fails', () =>
    withRepo(
      {
        'specflow/add-users/spec.md': '# Spec — add users\n\nDeltas.\n',
        'specflow/add-users/proposal.md': '# Proposal\n\nWhy.\n',
        'specflow/add-users/milestones/M1.md': '# M1 — first\n\n- Objective: do the thing\n- Files to add/change: lib/a.ts\n',
        '.spec-flow/config.json': SKILLS_REQUIRED,
      },
      (r) => {
        if (r.status === 0) {
          return `a milestone said nothing about skills and passed, so nobody can tell whether the planner looked: ${r.out}`;
        }
        if (!/Skills/.test(r.out)) return `the failure does not name the missing field: ${r.out}`;
        return null;
      },
    ),
  ),

  check('`Skills: none` is a legitimate answer and passes', () =>
    withRepo(
      {
        'specflow/add-users/spec.md': '# Spec — add users\n\nDeltas.\n',
        'specflow/add-users/proposal.md': '# Proposal\n\nWhy.\n',
        'specflow/add-users/milestones/M1.md': '# M1 — first\n\n- Objective: do the thing\n- Skills: none\n',
        '.spec-flow/config.json': SKILLS_REQUIRED,
      },
      (r) => {
        if (r.status !== 0) return `"none" was rejected, though it is what a planner writes when nothing applies: ${r.out}`;
        return null;
      },
    ),
  ),

  check('a Skills field with nothing after the colon fails, like the absent one it is', () =>
    withRepo(
      {
        'specflow/add-users/spec.md': '# Spec — add users\n\nDeltas.\n',
        'specflow/add-users/proposal.md': '# Proposal\n\nWhy.\n',
        'specflow/add-users/milestones/M1.md': '# M1 — first\n\n- Objective: do the thing\n- Skills:\n- Files to add/change: lib/a.ts\n',
        '.spec-flow/config.json': SKILLS_REQUIRED,
      },
      (r) => {
        if (r.status === 0) {
          return `an empty Skills field passed. The check then asserts only that someone typed the word: it cannot tell "no skills apply" from "the planner never looked", which is the single distinction it exists to draw. out: ${r.out}`;
        }
        if (!/Skills/.test(r.out)) return `the failure does not name the field: ${r.out}`;
        return null;
      },
    ),
  ),

  // Trailing whitespace is the same case wearing a disguise, and the likelier
  // one in practice: an editor that strips nothing leaves `Skills: ` behind
  // when the planner deleted a value it meant to replace.
  check('a Skills field holding only whitespace fails too', () =>
    withRepo(
      {
        'specflow/add-users/spec.md': '# Spec — add users\n\nDeltas.\n',
        'specflow/add-users/proposal.md': '# Proposal\n\nWhy.\n',
        'specflow/add-users/milestones/M1.md': '# M1 — first\n\n- Objective: do the thing\n- **Skills**:   \n',
        '.spec-flow/config.json': SKILLS_REQUIRED,
      },
      (r) => {
        if (r.status === 0) return `"Skills:" plus spaces passed as an answer: ${r.out}`;
        return null;
      },
    ),
  ),

  // ---- and the default, which is the decision this group hangs off --------
  //
  // A repo that never asked for the check is not a repo that failed it. This
  // is the same milestone as the first case in the group, on the DEFAULT
  // contract: skills reach a session from plugins and the user's own
  // directory as well as the project's, so nothing this engine reads can tell
  // it whether a project routes them, and a default that guesses wrong fails
  // a gate over a field the project was never going to use.
  //
  // The field is not gone: the planner's template still carries it, the
  // planner still fills it, and the reviewer still checks it — which is where
  // `Spec deltas`, `Tests` and `Objective` have always been checked. What
  // changed is that `Skills:` stopped being the only one of them that could
  // fail a gate on its own.
  check('a milestone with no Skills field passes when the contract never asked for one', () =>
    withRepo(
      {
        'specflow/add-users/spec.md': '# Spec — add users\n\nDeltas.\n',
        'specflow/add-users/proposal.md': '# Proposal\n\nWhy.\n',
        'specflow/add-users/milestones/M1.md': '# M1 — first\n\n- Objective: do the thing\n- Files to add/change: lib/a.ts\n',
        '.spec-flow/config.json': contract(),
      },
      (r) => {
        if (r.status !== 0) {
          return `a project that ships no skills was failed for not answering a question about them, on the contract it gets by default: ${r.out}`;
        }
        return null;
      },
    ),
  ),

  // The flag decides whether a gate can fail, so a value the engine has to
  // interpret is refused rather than coerced — `"true"` reading as true and
  // `"false"` also reading as true is the whole reason.
  check('a non-boolean require_skills_field is refused, not coerced', () =>
    withRepo(
      {
        '.spec-flow/config.json': JSON.stringify(
          { ...CONFIG, trace: { ...CONFIG.trace, require_skills_field: 'false' } },
          null,
          2,
        ),
        'specs/user.md': spec(),
        'tests/user.test.ts': `it('REQ-USER-001 lets the user do the thing', () => {});\n`,
      },
      (r) => {
        if (r.status === 0) return `a quoted "false" was accepted, and JS would have read it as true: ${r.out}`;
        if (!/require_skills_field/.test(r.out)) return `the failure does not name the field: ${r.out}`;
        return null;
      },
    ),
  ),

  // ---- the happy path, and the separators a requirement heading may use ----
  check('a requirement proven by a test title passes, in both directions', () =>
    withRepo(
      {
        'specs/user.md': spec(),
        'tests/user.test.ts': `it('REQ-USER-001 lets the user do the thing', () => {});\n`,
      },
      (r) => {
        if (r.status !== 0) return `a fully proven spec was reported as drift (rc=${r.status}): ${r.out}`;
        if (!/1 requirement/.test(r.out)) return `did not report the requirement it checked: ${r.out}`;
        return null;
      },
    ),
  ),

  check('a requirement heading parses with an em dash, a hyphen or a colon', () =>
    withRepo(
      {
        'specs/user.md':
          `<!-- spec-scope: modules/user -->\n\n### REQ-USER-001 — em dash\n\n### REQ-USER-002 - hyphen\n\n### REQ-USER-003: colon\n`,
        '.spec-flow/config.json': contract('REQ-USER-001 a', 'REQ-USER-002 b', 'REQ-USER-003 c'),
      },
      (r) => {
        if (r.status !== 0) return `one of the three separators failed to parse: ${r.out}`;
        if (!/3 requirement/.test(r.out)) return `expected all 3 headings to parse, got: ${r.out}`;
        return null;
      },
    ),
  ),

  // ---- direction 1: the spec claims something nobody proves ----
  check('a requirement with no test is reported', () =>
    withRepo({ 'specs/user.md': spec(), '.spec-flow/config.json': contract('an unrelated test') }, (r) => {
      if (r.status === 0) return 'an unproven requirement passed — the spec layer is decorative again';
      if (!/REQ-USER-001/.test(r.out)) return `the failure did not name the unproven requirement: ${r.out}`;
      return null;
    }),
  ),

  // ---- direction 2: a test proves something no spec declares ----
  check('a test tag with no requirement behind it is reported', () =>
    withRepo(
      { 'specs/user.md': spec(), '.spec-flow/config.json': contract('REQ-USER-001 ok', 'REQ-USER-999 orphan') },
      (r) => {
        if (r.status === 0) return 'an orphan test tag passed — a renamed/removed requirement would leave this behind silently';
        if (!/REQ-USER-999/.test(r.out)) return `the failure did not name the orphan tag: ${r.out}`;
        return null;
      },
    ),
  ),

  // ---- parameterised tests: the runner reports the names it expanded ----
  //
  // The old matcher had to recognise `it.each(table)('title')` as a shape, and
  // documented its own failure at `it.each([foo(1)])('...')` — a nested paren
  // it could not span. There is nothing to recognise now: a table-driven test
  // reports one line per case, already expanded, so this works for the form
  // that used to be a known limitation.
  check('a parameterised test proves through its expanded names', () =>
    withRepo(
      {
        '.spec-flow/config.json': JSON.stringify(
          { ...CONFIG, trace: { ...CONFIG.trace, executed_tests: ran('REQ-USER-001 handles 1', 'REQ-USER-001 handles 2') } },
          null,
          2,
        ),
        'specs/user.md': spec(),
      },
      (r) => (r.status !== 0 ? `a table-driven test did not register as proof: ${r.out}` : null),
    ),
  ),

  // ---- an id in SOURCE is not proof, whatever it is sitting in ----
  //
  // This case survives its own mechanism. It used to guard one specific
  // parser bug: the curried branch was a bare `)(` followed by a string, so an
  // ordinary curried call mentioning an id registered as proof. The property
  // it was protecting was always the broader one — a requirement is proven by
  // a test that RUNS, not by its id appearing somewhere — and that property is
  // now structural rather than defended by anchoring. Nothing reads the file
  // at all; the id can sit in a test declaration, a comment or a helper string
  // and none of them reaches this check.
  check('an id present in source but absent from the report is not proof', () =>
    withRepo(
      {
        '.spec-flow/config.json': JSON.stringify(
          { ...CONFIG, trace: { ...CONFIG.trace, executed_tests: ran('tests/user.test.ts::something else entirely') } },
          null,
          2,
        ),
        'specs/user.md': spec(),
        'tests/user.test.ts':
          `// REQ-USER-001 is mentioned here\n` +
          `const describeThing = (a) => (b) => a + b;\n` +
          `describeThing('x')('REQ-USER-001 this is not a test');\n` +
          `it('REQ-USER-001 a real declaration that the runner did not report', () => {});\n`,
      },
      (r) => {
        if (r.status === 0) return 'an id that no reported test carried registered as proof';
        if (!/REQ-USER-001/.test(r.out)) return `expected REQ-USER-001 reported unproven, got: ${r.out}`;
        return null;
      },
    ),
  ),

  // ---- a test that did not run proves nothing, in any language ----
  //
  // This used to be four cases — `it.skip`, `xit`, `it.todo`, `it.skip.each` —
  // one per spelling the matcher had to know, and it covered exactly the
  // spellings someone had thought of. It is one case now, and a stronger one:
  // whatever the language calls skipping, a skipped test is absent from a
  // report of what executed. `@pytest.mark.skip`, `@Disabled`, `#[ignore]` and
  // a runtime `t.Skip()` need no support here, which is what "no opinion about
  // your language" has to mean to be worth claiming.
  //
  // It matters more than it looks, because the gate's attempt-1 route hands a
  // red suite straight back to an implementer, and skipping is the cheapest
  // way to make a failing test stop failing.
  check('a test that exists in every language\'s skipped form is not proof', () =>
    withRepo(
      {
        '.spec-flow/config.json': JSON.stringify(
          { ...CONFIG, trace: { ...CONFIG.trace, executed_tests: ran('tests/other.test.ts::an unrelated test that did run') } },
          null,
          2,
        ),
        'specs/user.md': spec(),
        'tests/user.test.ts': `it.skip('REQ-USER-001 skipped', () => {});\n`,
        'tests/user_test.py': `@pytest.mark.skip\ndef test_REQ_USER_001_skipped(): pass\n`,
        'tests/user_test.go': `func TestUser(t *testing.T) { t.Skip(); t.Run("REQ-USER-001 x", nil) }\n`,
      },
      (r) => {
        if (r.status === 0) return 'a skipped test registered as proof — the requirement is unproven but reads as covered';
        if (!/REQ-USER-001/.test(r.out)) return `expected REQ-USER-001 reported unproven, got: ${r.out}`;
        return null;
      },
    ),
  ),

  // ---- and a test that DID run is proof, whatever modifiers it carried ----
  check('tests the runner reports as executed count as proof', () =>
    withRepo(
      {
        '.spec-flow/config.json': JSON.stringify(
          { ...CONFIG, trace: { ...CONFIG.trace, executed_tests: ran('REQ-USER-001 runs', 'REQ-USER-002 runs') } },
          null,
          2,
        ),
        'specs/user.md': `<!-- spec-scope: modules/user -->\n\n### REQ-USER-001 — a\n\n### REQ-USER-002 — b\n`,
      },
      (r) => (r.status !== 0 ? `a running test was rejected as proof: ${r.out}` : null),
    ),
  ),

  // ---- the id must match the file that declares it ----
  check('a requirement id that does not match its spec filename is reported', () =>
    withRepo(
      { 'specs/user.md': spec('REQ-BILLING-001'), 'tests/user.test.ts': `it('REQ-BILLING-001 x', () => {});\n` },
      (r) => {
        if (r.status === 0) return 'an id that drifted from its filename passed';
        if (!/REQ-USER-/.test(r.out)) return `the failure did not name the prefix the filename requires: ${r.out}`;
        return null;
      },
    ),
  ),

  check('a spec with no scope marker is reported', () =>
    withRepo(
      { 'specs/user.md': `# User\n\n### REQ-USER-001 — no marker\n`, 'tests/user.test.ts': `it('REQ-USER-001 x', () => {});\n` },
      (r) => {
        if (r.status === 0) return 'a spec with no scope marker passed';
        if (!/scope marker/.test(r.out)) return `the failure did not name the missing marker: ${r.out}`;
        return null;
      },
    ),
  ),

  // ---- only files under proof_dir with proof_suffix are proof ----
  // ---- the archive declares what became of every change ----
  check('an archived change with a status passes', () =>
    withRepo(
      {
        'specs/user.md': spec(),
        'tests/user.test.ts': `it('REQ-USER-001 x', () => {});\n`,
        'specflow/archive/add-user/spec.md': `# Add user\n\n**Status:** SHIPPED 2026-07-30\n`,
      },
      (r) => {
        if (r.status !== 0) return `a properly stamped archive entry was reported as a problem: ${r.out}`;
        if (!/1 archived change/.test(r.out)) return `the archive entry was not counted: ${r.out}`;
        return null;
      },
    ),
  ),

  check('an archived change with no status is reported', () =>
    withRepo(
      {
        'specs/user.md': spec(),
        'tests/user.test.ts': `it('REQ-USER-001 x', () => {});\n`,
        'specflow/archive/add-user/spec.md': `# Add user\n\nNo status line here.\n`,
      },
      (r) => {
        if (r.status === 0) return 'an archived change with no recorded outcome passed';
        if (!/no status/.test(r.out)) return `the failure did not name the missing status: ${r.out}`;
        return null;
      },
    ),
  ),

  check('an archived folder with no spec.md at all is reported', () =>
    withRepo(
      {
        'specs/user.md': spec(),
        'tests/user.test.ts': `it('REQ-USER-001 x', () => {});\n`,
        'specflow/archive/add-user/notes.md': `stray\n`,
      },
      (r) => {
        if (r.status === 0) return 'an archived folder with no spec.md passed';
        return null;
      },
    ),
  ),

  // ---- a live change spec stays light; the rationale lives next to it ----
  check('a live change spec carrying a Decision heading is reported', () =>
    withRepo(
      {
        'specs/user.md': spec(),
        'tests/user.test.ts': `it('REQ-USER-001 x', () => {});\n`,
        'specflow/add-user/spec.md': `# Add user\n\n## Decision\n\nWe chose X.\n`,
        'specflow/add-user/proposal.md': `# Why\n`,
      },
      (r) => {
        if (r.status === 0) return 'a change spec carrying the rationale headings passed';
        if (!/Decision/.test(r.out)) return `the failure did not name the leaked heading: ${r.out}`;
        return null;
      },
    ),
  ),

  check('a live change with no proposal.md is reported', () =>
    withRepo(
      {
        'specs/user.md': spec(),
        'tests/user.test.ts': `it('REQ-USER-001 x', () => {});\n`,
        'specflow/add-user/spec.md': `# Add user\n\nJust the delta.\n`,
      },
      (r) => {
        if (r.status === 0) return 'a change with no recorded reasoning passed';
        if (!/proposal\.md/.test(r.out)) return `the failure did not name the missing proposal: ${r.out}`;
        return null;
      },
    ),
  ),

  check('a fix brief (## Case) is exempt from the split rule', () =>
    withRepo(
      {
        'specs/user.md': spec(),
        'tests/user.test.ts': `it('REQ-USER-001 x', () => {});\n`,
        'specflow/fix-thing/spec.md': `# Fix\n\n## Case\n\n## Decision\n\nInline, and allowed here.\n`,
        'specflow/fix-thing/proposal.md': `# Why\n`,
      },
      (r) => {
        if (r.status !== 0) return `a /spec-fix brief was held to the split rule it is exempt from: ${r.out}`;
        return null;
      },
    ),
  ),

  // ---- an unconfigured repo says so, rather than reporting everything proven ----
  check('a repo with no specs and nothing archived says what it is not checking', () =>
    withRepo({ '.spec-flow/config.json': contract() }, (r) => {
      if (r.status !== 0) return `expected a clean exit for an unconfigured repo, got rc=${r.status}: ${r.out}`;
      if (!/no requirements to bind/.test(r.out)) return `it did not say the repo has no specs — silence here reads as "all proven": ${r.out}`;
      if (!/still checked/.test(r.out)) return `it did not say the grace covers only the binding, which is what made it swallow everything else: ${r.out}`;
      return null;
    }),
  ),

  // ---- no dependency tree is read, because no tree is read at all ----
  //
  // This used to assert that one hardcoded name was skipped. It now asserts
  // the general property that replaced the list: a dependency's own tests
  // cannot become this repo's problem, whatever its directory is called —
  // which is what the `venv` case at the top of this file proves from the
  // other side.
  check("a dependency's own tests are never judged as this repo's", () =>
    withRepo(
      {
        'specs/user.md': spec(),
        'tests/user.test.ts': `it('REQ-USER-001 x', () => {});\n`,
        // If this were walked, its orphan tag would fail the run.
        'node_modules/pkg/tests/dep.test.ts': `it('REQ-USER-404 from a dependency', () => {});\n`,
      },
      (r) => {
        if (r.status !== 0) return `a dependency's own test files were walked and judged: ${r.out}`;
        return null;
      },
    ),
  ),

  // ---- a circular symlink must not hang or crash the walk ----
  //
  // Skipped rather than failed where the OS refuses to create the link
  // (Windows needs Developer Mode or elevation for symlinks): the case is
  // about spec-trace's walk, and a fixture that fails on a permission
  // boundary would be reporting the wrong thing.
  check('a circular symlink does not hang or crash the walk', () =>
    withRepo(
      { 'specs/user.md': spec(), 'tests/user.test.ts': `it('REQ-USER-001 x', () => {});\n` },
      async (r, repoDir) => {
        let linked = false;
        try {
          mkdirSync(join(repoDir, 'tests', 'nested'), { recursive: true });
          symlinkSync(join(repoDir, 'tests'), join(repoDir, 'tests', 'nested', 'loop'), 'dir');
          linked = true;
        } catch {
          return null; // no symlink privilege here — nothing this case can assert
        }

        if (!linked) return null;
        const env = { ...process.env, CLAUDE_PROJECT_DIR: repoDir };
        const again = await run('node', [SPEC_TRACE], { cwd: tmpdir(), env });
        const out = `${again.stdout}${again.stderr}`;
        if (again.status !== 0) {
          return `a circular symlink broke the walk (rc=${again.status}) — every gate in a repo with one would block on this: ${out}`;
        }
        return null;
      },
    ),
  ),
]);

if (failures.length) {
  failures.sort();
  console.log(`spec-trace-fixture: ${failures.length} case(s) failed\n`);
  for (const f of failures) console.log(`  ✕ ${f}\n`);
  process.exit(1);
}

console.log('spec-trace-fixture: OK — the requirement/proof binding holds in both directions, and a test that does not run is not proof.');
