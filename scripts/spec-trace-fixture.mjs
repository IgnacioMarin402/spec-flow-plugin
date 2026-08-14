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
  trace: { specs_dir: 'specs', proof_dir: 'tests', proof_suffix: '.test.ts', not_a_capability: ['README.md'] },
  extra_checks: [],
  unscoped_denied: { scripts: [], tools: [], scoped_allowed: [], scoped_alternative: '', scoped_examples: [] },
};

/** A capability spec declaring one requirement, with the scope marker spec-trace requires. */
function spec(id = 'REQ-USER-001', title = 'the user can do the thing', scope = 'modules/user') {
  return `<!-- spec-scope: ${scope} -->\n\n# User\n\n### ${id} — ${title}\n\nThe system does the thing.\n`;
}

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
  // ---- an empty spec layer: grace while adopting, contradiction after a ship ----
  //
  // With no capability specs there are no requirements, so "every requirement
  // is proven" holds over the empty set and this check reports green. For a
  // repo adopting the engine that is correct — capability specs are written
  // BY the flow, as milestones fold their deltas in. The grace has to end
  // somewhere, and SHIPPED is the only artifact that says where: a fold
  // stamps it to assert those deltas landed in specs/.
  check('an empty spec layer passes while nothing has shipped yet', () =>
    withRepo({ 'tests/placeholder.test.ts': 'it("unrelated", () => {});\n' }, (r) => {
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
        'tests/placeholder.test.ts': 'it("unrelated", () => {});\n',
      },
      (r) => {
        if (r.status !== 0) {
          return `an infrastructure fix that legitimately has no deltas blocked the gate, and no capability spec would ever satisfy it: ${r.out}`;
        }
        return null;
      },
    ),
  ),

  // ---- build output is not proof ----
  //
  // A compiled or copied test under dist/ matches the same suffix as its
  // source and registers as proof — and keeps registering after the SOURCE is
  // deleted, leaving the requirement proven by an artifact nobody runs.
  check('a test surviving only in build output does not prove a requirement', () =>
    withRepo(
      {
        'specs/user.md': spec(),
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

  check('the declared proof surface outranks the build-output list', () =>
    withRepo(
      {
        // A repo whose contract says its proofs live in a directory named
        // `dist`. Unusual, and its to declare — the engine's heuristic must
        // not quietly exclude the surface the repo chose.
        '.spec-flow/config.json': JSON.stringify(
          { ...CONFIG, trace: { ...CONFIG.trace, proof_dir: 'dist' } },
          null,
          2,
        ),
        'specs/user.md': spec(),
        'dist/user.test.ts': `it('REQ-USER-001 lets the user do the thing', () => {});\n`,
      },
      (r) => {
        if (r.status !== 0) {
          return `the contract declared proof_dir "dist" and the walk skipped it anyway, so nothing in this repo can ever be proof: ${r.out}`;
        }
        return null;
      },
    ),
  ),

  check('a REJECTED change keeps the grace — it asserts nothing landed', () =>
    withRepo(
      {
        'specflow/archive/turned-down/spec.md': '# Spec — turned down\n\n**Status:** REJECTED 2026-07-30\n\nDeltas.\n',
        'specflow/archive/turned-down/proposal.md': '# Proposal\n\nWhy not.\n',
        'tests/placeholder.test.ts': 'it("unrelated", () => {});\n',
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

  // ---- the Skills field, enforced rather than described ----
  //
  // `none` is a legitimate answer; absent is not the same answer, because it
  // cannot be told apart from a planner that never looked. Only checked where
  // the repo declares a skills table — a project with no skills has nothing
  // for the field to route.
  check('a live milestone with no Skills field fails, when the repo declares skills', () =>
    withRepo(
      {
        '.spec-flow/skills.md': '# Skills\n\n| decision | skill |\n|---|---|\n| where a rule goes | where-does-it-live |\n',
        'specflow/add-users/spec.md': '# Spec — add users\n\nDeltas.\n',
        'specflow/add-users/proposal.md': '# Proposal\n\nWhy.\n',
        'specflow/add-users/milestones/M1.md': '# M1 — first\n\n- Objective: do the thing\n- Files to add/change: lib/a.ts\n',
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
        '.spec-flow/skills.md': '# Skills\n\n| decision | skill |\n|---|---|\n| where a rule goes | where-does-it-live |\n',
        'specflow/add-users/spec.md': '# Spec — add users\n\nDeltas.\n',
        'specflow/add-users/proposal.md': '# Proposal\n\nWhy.\n',
        'specflow/add-users/milestones/M1.md': '# M1 — first\n\n- Objective: do the thing\n- Skills: none\n',
      },
      (r) => {
        if (r.status !== 0) return `"none" was rejected, though it is what a planner writes when nothing applies: ${r.out}`;
        return null;
      },
    ),
  ),

  check('a repo that declares no skills is not asked for the field', () =>
    withRepo(
      {
        'specflow/add-users/spec.md': '# Spec — add users\n\nDeltas.\n',
        'specflow/add-users/proposal.md': '# Proposal\n\nWhy.\n',
        'specflow/add-users/milestones/M1.md': '# M1 — first\n\n- Objective: do the thing\n',
      },
      (r) => {
        if (r.status !== 0) {
          return `a project with no .spec-flow/skills.md was made to write "Skills: none" on every milestone — ceremony for a field that routes nothing: ${r.out}`;
        }
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
        'tests/user.test.ts':
          `it('REQ-USER-001 a', () => {});\nit('REQ-USER-002 b', () => {});\nit('REQ-USER-003 c', () => {});\n`,
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
    withRepo({ 'specs/user.md': spec(), 'tests/user.test.ts': `it('unrelated', () => {});\n` }, (r) => {
      if (r.status === 0) return 'an unproven requirement passed — the spec layer is decorative again';
      if (!/REQ-USER-001/.test(r.out)) return `the failure did not name the unproven requirement: ${r.out}`;
      return null;
    }),
  ),

  // ---- direction 2: a test proves something no spec declares ----
  check('a test tag with no requirement behind it is reported', () =>
    withRepo(
      { 'specs/user.md': spec(), 'tests/user.test.ts': `it('REQ-USER-001 ok', () => {});\nit('REQ-USER-999 orphan', () => {});\n` },
      (r) => {
        if (r.status === 0) return 'an orphan test tag passed — a renamed/removed requirement would leave this behind silently';
        if (!/REQ-USER-999/.test(r.out)) return `the failure did not name the orphan tag: ${r.out}`;
        return null;
      },
    ),
  ),

  // ---- the curried form: it.each(table)('title') ----
  check('the curried it.each(...)(title) form counts as proof', () =>
    withRepo(
      {
        'specs/user.md': spec(),
        'tests/user.test.ts': `it.each([1, 2])('REQ-USER-001 handles %s', (n) => {});\n`,
      },
      (r) => {
        if (r.status !== 0) return `a table-driven test did not register as proof: ${r.out}`;
        return null;
      },
    ),
  ),

  // ---- and the false positive that form's own pattern invites ----
  //
  // The curried alternative used to be a bare `)\s*(\s*` — ANY `)(` followed
  // by a string literal, anywhere in the file, with nothing tying it to a
  // test declaration. An ordinary curried call or an IIFE mentioning a
  // requirement id in a string would register as proof for a requirement no
  // test actually runs.
  check('a bare )( followed by a string is NOT proof — only a real test declaration is', () =>
    withRepo(
      {
        'specs/user.md': spec(),
        'tests/user.test.ts':
          `const describeThing = (a) => (b) => a + b;\n` +
          `describeThing('x')('REQ-USER-001 this is not a test');\n` +
          `it('something else entirely', () => {});\n`,
      },
      (r) => {
        if (r.status === 0) {
          return 'a non-test curried call registered as proof — a requirement nothing runs would read as proven';
        }
        if (!/REQ-USER-001/.test(r.out)) return `expected REQ-USER-001 to be reported unproven, got: ${r.out}`;
        return null;
      },
    ),
  ),

  // ---- a skipped test runs nothing, so it proves nothing ----
  //
  // This matters more since the gate's attempt-1 route hands a red suite
  // straight back to an implementer: `it.skip` is the cheapest way to make a
  // failing test stop failing, and if spec-trace accepts it as proof, the
  // requirement still looks covered while nothing executes.
  check('it.skip does not count as proof', () =>
    withRepo({ 'specs/user.md': spec(), 'tests/user.test.ts': `it.skip('REQ-USER-001 skipped', () => {});\n` }, (r) => {
      if (r.status === 0) return 'a skipped test registered as proof — the requirement is unproven but reads as covered';
      if (!/REQ-USER-001/.test(r.out)) return `expected REQ-USER-001 reported unproven, got: ${r.out}`;
      return null;
    }),
  ),

  check('xit does not count as proof', () =>
    withRepo({ 'specs/user.md': spec(), 'tests/user.test.ts': `xit('REQ-USER-001 skipped', () => {});\n` }, (r) => {
      if (r.status === 0) return 'an xit (skipped) test registered as proof';
      return null;
    }),
  ),

  check('it.todo does not count as proof', () =>
    withRepo({ 'specs/user.md': spec(), 'tests/user.test.ts': `it.todo('REQ-USER-001 not written yet');\n` }, (r) => {
      if (r.status === 0) return 'a todo placeholder registered as proof';
      return null;
    }),
  ),

  check('it.skip.each does not count as proof either', () =>
    withRepo(
      { 'specs/user.md': spec(), 'tests/user.test.ts': `it.skip.each([1])('REQ-USER-001 skipped table', () => {});\n` },
      (r) => {
        if (r.status === 0) return 'a skipped table-driven test registered as proof';
        return null;
      },
    ),
  ),

  // ---- but the ordinary modifiers still are proof: those tests DO run ----
  check('it.only and test.concurrent still count as proof', () =>
    withRepo(
      {
        'specs/user.md':
          `<!-- spec-scope: modules/user -->\n\n### REQ-USER-001 — a\n\n### REQ-USER-002 — b\n`,
        'tests/user.test.ts':
          `it.only('REQ-USER-001 runs', () => {});\ntest.concurrent('REQ-USER-002 runs', () => {});\n`,
      },
      (r) => {
        if (r.status !== 0) return `a running test was rejected as proof: ${r.out}`;
        return null;
      },
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
  check('a test outside proof_dir does not count as proof', () =>
    withRepo(
      { 'specs/user.md': spec(), 'elsewhere/user.test.ts': `it('REQ-USER-001 x', () => {});\n` },
      (r) => {
        if (r.status === 0) return 'a file outside the declared proof_dir registered as proof';
        return null;
      },
    ),
  ),

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
    withRepo({}, (r) => {
      if (r.status !== 0) return `expected a clean exit for an unconfigured repo, got rc=${r.status}: ${r.out}`;
      if (!/no requirements to bind/.test(r.out)) return `it did not say the repo has no specs — silence here reads as "all proven": ${r.out}`;
      if (!/still checked/.test(r.out)) return `it did not say the grace covers only the binding, which is what made it swallow everything else: ${r.out}`;
      return null;
    }),
  ),

  // ---- node_modules is never walked: not an optimisation, a hard requirement ----
  check('node_modules is not walked for proof files', () =>
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
