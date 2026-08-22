#!/usr/bin/env node
/**
 * Behaviour fixture for hooks/gate.mjs.
 *
 * The gate is what every other guarantee in this engine rests on, so it is
 * tested by running it. Every case builds a throwaway git repo, installs the
 * engine at a SEPARATE path (the way it actually ships — a plugin cache
 * directory, never inside the repo it serves), points `CLAUDE_PROJECT_DIR` at
 * the repo, and asserts what the real hook did.
 *
 * The contract every case is really testing:
 *
 *   A Stop hook expresses "block" by printing {"decision":"block"} and
 *   exiting 0. Exiting non-zero is not a stricter failure, it is NO failure
 *   at all — the stop proceeds. So "did it exit 0" is never the assertion;
 *   "did it say block, and did it write down what it judged" is.
 *
 * Two properties of the scaffolding are load-bearing, because without them
 * the cases below pass while invoking neither `verify.lint` nor `verify.test`:
 *
 *   - `fixture()` creates a real base branch plus a commit that changes a
 *     tracked file, so every case has a NON-EMPTY changed-file scope. An
 *     empty one short-circuits the gate before either command runs. The
 *     "a green run reports the real scope" case exists to break loudly if
 *     that ever regresses.
 *   - `baseBranch` is a parameter, never hardcoded. A fixture built around
 *     one branch name cannot catch a resolver that only sees that name.
 *
 * Cases run concurrently: each builds its own two temp directories and its
 * own child process, nothing is shared.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

// A test/lint stand-in that always exits clean and does nothing else.
const NOOP = ['node', '-e', 'process.exit(0)'];
// Exits 1 unconditionally — a red check.
const RED = ['node', '-e', 'process.exit(1)'];

// A JUnit report proving REQ-FIX-001, and the same report with its one test
// case marked <skipped/> — for the cases that run the real spec-trace.mjs
// against a real report through the real gate.
const JUNIT_PROVES = '<testsuites><testcase name="REQ-FIX-001 the fix"/></testsuites>\n';
const JUNIT_SKIPS = '<testsuites><testcase name="REQ-FIX-001 the fix"><skipped/></testcase></testsuites>\n';
const FIX_SPEC = '<!-- spec-scope: modules/fix -->\n\n# Fix\n\n### REQ-FIX-001 — the fix\n\nThe system is fixed.\n';

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
    if (opts.input !== undefined) child.stdin.end(opts.input);
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

function have(cmd) {
  return spawnSync(cmd, ['--version'], { encoding: 'utf8' }).status === 0;
}

/**
 * Since ADR-010, `r.blocked` alone no longer means "the gate rejected this
 * tree" — a first-time PASS blocks too, to wake the orchestrator on the
 * channel verified to reach a human. Cases whose subject is something other
 * than that wake behavior (scoping, base resolution, extra_checks wiring...)
 * use this instead: true only when the block is an actual GATE FAILED, never
 * a pass reported through the same channel.
 */
function rejected(r) {
  return r.blocked && !/spec-flow: gate PASSED/.test(r.payload?.reason ?? '');
}

/**
 * Installs the engine at one temp directory and a throwaway git repo at a
 * DIFFERENT one — the split this whole fixture exists to exercise. A repo
 * under test that never had this engine's own file, `spec-trace.mjs`,
 * present gets a deterministic stand-in instead of the real check, so a case
 * can force green or red without depending on this plugin repo's own specs.
 *
 * The repo gets a real two-commit history on two branches: a baseline commit
 * on `main`, then `feature` branched off it with one more commit that
 * changes `changedFile` (default `b.ts`) — never `a.ts`, which stays as
 * committed-and-untouched debt on both branches, so a case that inspects
 * `verify.lint`'s argv can assert the untouched file is NOT in it.
 *
 * The base branch is created via `symbolic-ref` right after `init`, not
 * `git init -b` (needs git >= 2.28) and not left to `init.defaultBranch` (a
 * per-machine config this fixture must not depend on), so its name is
 * exactly what `baseBranch` says on every machine this runs on. It defaults
 * to `main` for the cases that are not about base resolution, and the cases
 * that ARE pass `master`/`develop`/`nonesuch` — see this file's header for
 * why hardcoding it was the bug rather than the setup.
 */
async function fixture({
  phase = 'implement',
  specTrace = 'green',
  dirty = false,
  extraChecks = [],
  contractVersion = 1,
  sabotage = null,
  gateAttempts = '0',
  history = null,
  lint = NOOP,
  test = NOOP,
  changedFile = 'b.ts',
  omitSpecTrace = false,
  baseBranch = 'main',
  baseRef = undefined,
  stayOnBase = false,
  // The real spec-trace.mjs, exercised end to end instead of stubbed — for
  // the cases that test the SEAM between the two changes that touched this
  // hook together: B16's notice protocol and B18's report readers. `report`
  // is `{format, path}` written into `trace.report`; `reportBody` is the file
  // spec-trace will read, so cases control what a real emitter would have
  // written without needing one installed. `specs` are the capability specs
  // that make the requirement real rather than vacuous — an empty specs_dir
  // passes trivially and would prove nothing about either change.
  report = null,
  reportBody = '',
  specs = {},
}) {
  const engineDir = mkdtempSync(join(tmpdir(), 'spec-flow-engine-'));
  const repoDir = mkdtempSync(join(tmpdir(), 'spec-flow-repo-'));

  mkdirSync(join(engineDir, 'hooks', 'lib'), { recursive: true });
  mkdirSync(join(engineDir, 'scripts'), { recursive: true });
  copyFileSync(join(ROOT, 'hooks/gate.mjs'), join(engineDir, 'hooks/gate.mjs'));
  for (const f of ['io.mjs', 'agent-name.mjs']) {
    copyFileSync(join(ROOT, 'hooks/lib', f), join(engineDir, 'hooks/lib', f));
  }
  // `test-report.mjs` is here because spec-flow-config.mjs imports it at module
  // scope, and a missing import throws before gate.mjs's own catch-all can run
  // — which is a Stop hook that renders no decision, i.e. a clean pass over a
  // milestone nothing judged. Every case below went silent the moment that
  // import was added, which is the fixture doing its job: this list is the
  // engine's real dependency graph, and it has to be kept honest by hand.
  for (const f of ['spec-flow-config.mjs', 'unscoped-checks.mjs', 'changed-files.mjs', 'test-report.mjs']) {
    copyFileSync(join(ROOT, 'scripts', f), join(engineDir, 'scripts', f));
  }

  // A deterministic stand-in for spec-trace, green or red on demand — the
  // real one depends on this plugin repo's own specs/, which is not what most
  // of this fixture is testing: it exists to verify the GATE's routing, not
  // spec-trace's own logic (spec-trace-fixture.mjs owns that). `omitSpecTrace`
  // skips writing it entirely, to exercise the "plugin install is
  // broken/partial" path in unscoped-checks.mjs instead. `report` switches to
  // the REAL spec-trace.mjs, for the cases that test where it and the gate's
  // notice protocol meet — neither fixture alone ever ran that combination.
  if (report) {
    copyFileSync(join(ROOT, 'scripts/spec-trace.mjs'), join(engineDir, 'scripts/spec-trace.mjs'));
  } else if (!omitSpecTrace) {
    writeFileSync(
      join(engineDir, 'scripts/spec-trace.mjs'),
      specTrace === 'green'
        ? 'console.log("spec-trace: OK — fixture");\n'
        : 'console.log("spec-trace: FAIL — REQ-FIX-001 has no test");\nprocess.exit(1);\n',
    );
  }

  // Injects a runtime throw into one of the engine's own modules, to stand in
  // for a defect nothing static could catch. Applied to the COPY, so the real
  // engine is untouched.
  if (sabotage) {
    const target = join(engineDir, sabotage.file);
    writeFileSync(target, readFileSync(target, 'utf8').replace(sabotage.find, sabotage.replace));
  }

  const git = (...args) => run('git', args, { cwd: repoDir });
  await git('init', '-q', '.');
  // See this function's own header: the name is `baseBranch`, exactly, on
  // every machine — never whatever this machine's init.defaultBranch says.
  await git('symbolic-ref', 'HEAD', `refs/heads/${baseBranch}`);
  await git('config', 'user.email', 'fixture@example.com');
  await git('config', 'user.name', 'fixture');
  // core.autocrlf false: on Windows the global default rewrites line endings
  // on checkout, git then reports every file as modified, and the gate's
  // quiescence guard skips a dirty tree — every case would silently test the
  // skip path instead of what it meant to test.
  await git('config', 'core.autocrlf', 'false');

  mkdirSync(join(repoDir, '.claude', 'state'), { recursive: true });
  mkdirSync(join(repoDir, '.spec-flow'), { recursive: true });
  writeFileSync(
    join(repoDir, '.spec-flow', 'config.json'),
    JSON.stringify(
      {
        contract_version: contractVersion,
        verify: {
          scope_globs: ['*.ts'],
          lint,
          lint_no_fix: NOOP,
          test,
          test_name: 'fixture-test',
          lint_name: 'fixture-lint',
          lint_config_hint: 'fixture.config',
          // Omitted unless a case is specifically about it: an absent
          // base_ref is the shape every existing consuming repo has, and is
          // what exercises the automatic resolution ladder.
          ...(baseRef === undefined ? {} : { base_ref: baseRef }),
        },
        trace: {
          specs_dir: 'specs',
          proof_dir: 'tests',
          proof_suffix: '.spec.ts',
          // Unused when `report` is set — the contract rejects declaring both
          // sources, so this is omitted rather than left empty in that case.
          // Present otherwise because the contract requires ONE source: a repo
          // cannot reach the gate without declaring how proof is found, even
          // when (as in most cases here) spec-trace itself is stubbed out.
          ...(report ? { report } : { executed_tests: ['node', '-e', 'process.exit(0)'] }),
          not_a_capability: [],
        },
        extra_checks: extraChecks,
        unscoped_denied: { scripts: [], tools: [], scoped_allowed: [], scoped_alternative: '', scoped_examples: [] },
      },
      null,
      2,
    ),
  );

  writeFileSync(join(repoDir, '.gitignore'), '.claude/state/\n');
  writeFileSync(join(repoDir, 'a.ts'), 'export const a = 1;\n');
  for (const [rel, content] of Object.entries(specs)) {
    mkdirSync(dirname(join(repoDir, rel)), { recursive: true });
    writeFileSync(join(repoDir, rel), content);
  }
  // Written at baseline, not staged separately: the report is what the
  // SUITE would have left behind before the gate ever runs, not an artifact
  // of this branch's diff — a real `verify.test` overwrites it on every gate
  // invocation, same as here.
  if (report) {
    mkdirSync(dirname(join(repoDir, report.path)), { recursive: true });
    writeFileSync(join(repoDir, report.path), reportBody);
  }
  await git('add', '-A');
  await git('commit', '-qm', `baseline on ${baseBranch}`);

  // The base every case diffs against — a real ancestor commit, never HEAD
  // itself. THAT is what the branch below buys, and for a while this fixture
  // only bought it when `changedFile` was set: `changedFile: null` skipped
  // the branch entirely, so HEAD stayed on the base and `merge-base` returned
  // HEAD. The two cases written against it therefore said "a milestone that
  // changed no file in scope" and built "a repo whose base IS its tip" — a
  // different situation with a different right answer, and the one the gate
  // could not see at all. The branch is now unconditional; `changedFile:
  // null` commits something OUTSIDE `scope_globs` instead, which is what an
  // empty scope honestly looks like: real work, none of it in scope.
  //
  // `stayOnBase` is the other situation, kept as its own explicit knob rather
  // than as a side effect of a file name.
  if (!stayOnBase) {
    await git('checkout', '-q', '-b', 'feature');
    const file = changedFile ?? 'notes.md';
    writeFileSync(
      join(repoDir, file),
      file.endsWith('.ts') ? 'export const changed = 1;\n' : '# notes\n\nReal work, none of it matching scope_globs.\n',
    );
    await git('add', '-A');
    await git('commit', '-qm', `change ${file}`);
  }

  if (dirty) writeFileSync(join(repoDir, 'dirty.txt'), 'uncommitted\n');

  writeFileSync(join(repoDir, '.claude/state/phase'), phase);
  writeFileSync(join(repoDir, '.claude/state/gate_attempts'), gateAttempts);
  // Seeds gate-history.log, for the cases about what a PREVIOUS invocation left behind.
  if (history !== null) writeFileSync(join(repoDir, '.claude/state/gate-history.log'), history);

  return { engineDir, repoDir };
}

/**
 * Runs the hook the way the harness does: payload on stdin, no arguments,
 * `CLAUDE_PLUGIN_ROOT`-style separation — `cwd` is irrelevant to the hook by
 * design (it reads `CLAUDE_PROJECT_DIR`, never its own location), so this
 * deliberately runs it from a THIRD directory, matching neither the engine
 * nor the repo, to make sure nothing about the hook depends on being invoked
 * from either.
 */
async function runGate({ engineDir, repoDir }) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: repoDir };
  const res = await run('node', [join(engineDir, 'hooks/gate.mjs')], { cwd: tmpdir(), input: '{}', env });
  const histPath = join(repoDir, '.claude/state/gate-history.log');
  const failPath = join(repoDir, '.claude/state/gate-failure.log');
  const lintArgvPath = join(repoDir, '.claude/state/lint-argv.log');

  let payload = null;
  try {
    payload = res.stdout.trim() ? JSON.parse(res.stdout.trim()) : null;
  } catch {
    /* not JSON: `blocked` below still answers the only question most cases ask */
  }

  return {
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
    blocked: res.stdout.includes('"decision":"block"'),
    payload,
    history: existsSync(histPath) ? readFileSync(histPath, 'utf8').trim() : '',
    failureLog: existsSync(failPath) ? readFileSync(failPath, 'utf8').trim() : '',
    lintArgv: existsSync(lintArgvPath) ? readFileSync(lintArgvPath, 'utf8').trim() : null,
  };
}

/**
 * Kept in step with `MAX_DIRTY_SKIPS` in hooks/gate.mjs by hand. A drift makes
 * the two cases below assert the wrong side of the threshold, which is loud —
 * one of them goes red — rather than silent.
 */
const MAX_DIRTY_SKIPS = 10;

/** A history whose last `n` lines are consecutive skips, the shape a stuck run leaves. */
const skipDirtyHistory = (n) =>
  `${Array.from(
    { length: n },
    (_, i) =>
      `2026-08-01T00:00:${String(i).padStart(2, '0')}Z abc1234 phase=implement attempt=0 result=skip-dirty lint=- test=- unscoped=- files=1`,
  ).join('\n')}\n`;

async function withFixture(opts, assert) {
  const { engineDir, repoDir } = await fixture(opts);
  try {
    return assert(await runGate({ engineDir, repoDir }), repoDir);
  } finally {
    rmSync(engineDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  }
}

if (!have('git')) {
  console.log('gate-fixture: skipped — git is required to exercise the hook.');
  process.exit(0);
}

await Promise.all([
  // ---- the reason this fixture exists: engine and repo are never the same directory ----
  check('the gate reads CLAUDE_PROJECT_DIR, never its own install location', () =>
    withFixture({ specTrace: 'green' }, (r) => {
      if (rejected(r)) return `the gate rejected a green tree — stderr: ${r.stderr}`;
      if (!/result=pass/.test(r.history)) {
        return `no pass recorded in the REPO's own state — the hook wrote state somewhere else, or did not run against the repo at all. stdout: ${r.stdout} stderr: ${r.stderr}`;
      }
      return null;
    }),
  ),

  // ---- the fixture's own signature failure, closed: it must actually reach verify.lint/verify.test ----
  check('a green run against real changes reports the real scope (files=1), not the empty short-circuit', () =>
    withFixture({ specTrace: 'green' }, (r) => {
      if (rejected(r)) return `the gate rejected a green tree — stderr: ${r.stderr}`;
      if (!/files=1\b/.test(r.history)) {
        return `expected files=1 in the history line — if this reads files=0, resolveBase() stopped finding the 'main' branch and every case in this fixture is back to never invoking verify.lint/verify.test. history: ${r.history}`;
      }
      return null;
    }),
  ),

  // ---- the failure this engine keeps having, in whatever language it is written ----
  //
  // In bash it was `set -u` plus a missing source file killing the hook. In
  // node it is any uncaught exception. Both end the same way: a Stop hook
  // that exits without printing a block ALLOWS the stop, so a milestone
  // nothing checked is indistinguishable from one that passed. This case is
  // what keeps the catch-all in gate.mjs from being quietly deleted as
  // defensive noise — it is load-bearing, and this proves it.
  check('an unexpected throw inside the engine blocks the stop and records it', () =>
    withFixture(
      {
        specTrace: 'green',
        sabotage: {
          file: 'scripts/unscoped-checks.mjs',
          find: 'export function runUnscopedChecks(root, config) {',
          replace: 'export function runUnscopedChecks(root, config) {\n  throw new Error("simulated engine defect");',
        },
      },
      (r) => {
        if (!r.blocked) {
          return 'the gate threw and ALLOWED the stop — a milestone nothing checked would read as a clean pass';
        }
        if (!/result=fail:hook-error/.test(r.history)) {
          return `blocked, but left no hook-error line, so the failure is invisible after the fact: ${r.history}`;
        }
        return null;
      },
    ),
  ),

  // ---- the failure mode the catch-all cannot reach ----
  //
  // A `command` hook that hits its timeout is CANCELED: output discarded, no
  // decision rendered — and a Stop hook that renders no decision ALLOWS the
  // stop. That happens a layer above this process, so gate.mjs's own catch-all
  // cannot see it, and until the log recorded the ATTEMPT as well as the
  // outcome, "no history line" was indistinguishable from "the gate was never
  // armed". A `running` line that outlives its invocation is the evidence.
  check('an armed gate records the attempt before it runs anything', () =>
    withFixture({ specTrace: 'green' }, (r) => {
      if (/result=running/.test(r.history)) {
        return `the run finished but left its own \`running\` line behind — every later stop would report a kill that never happened: ${r.history}`;
      }
      if (!/result=pass/.test(r.history)) return `expected the running line to be replaced by the outcome: ${r.history}`;
      return null;
    }),
  ),

  check('a gate killed mid-judgement is reported by the next one, not forgotten', () =>
    withFixture(
      { specTrace: 'green', history: '2026-08-01T00:00:00Z abc1234 phase=implement attempt=0 result=running lint=- test=- unscoped=- files=-\n' },
      (r) => {
        if (!r.blocked) {
          return `a previous gate died without judging anything and this one allowed the stop anyway — the milestone it was checking stays unverified and unmentioned. history: ${r.history}`;
        }
        if (!/result=fail:killed/.test(r.history)) return `the kill was not recorded as such: ${r.history}`;
        if (!/timeout|time budget/i.test(r.stdout)) return `the block does not name the likely cause: ${r.stdout}`;
        return null;
      },
    ),
  ),

  check('the report clears the evidence, so it does not block forever', () =>
    withFixture(
      { specTrace: 'green', history: '2026-08-01T00:00:00Z abc1234 phase=implement attempt=0 result=running lint=- test=- unscoped=- files=-\n' },
      (r) => {
        const lines = r.history.split('\n').filter(Boolean);
        if (lines.some((l) => / result=running /.test(l))) {
          return `the dangling line survived its own report, so every future stop blocks on the same dead invocation: ${r.history}`;
        }
        return null;
      },
    ),
  ),

  // ---- the one deliberate fail-CLOSED case ----
  check('an unrecognized contract_version blocks loudly instead of falling back to defaults', () =>
    withFixture({ specTrace: 'green', contractVersion: 999 }, (r) => {
      if (!r.blocked) return 'a contract version this engine does not understand did not block the stop';
      if (!/fail:contract/.test(r.history)) return `history did not record a contract failure: ${r.history}`;
      return null;
    }),
  ),

  // ---- a spec-trace missing from the ENGINE install is a broken plugin, not a green run ----
  //
  // Unlike a repo's own extra_checks (a script the repo has not written yet,
  // which degrades quietly by design), spec-trace ships INSIDE this package.
  // Missing here can only mean a broken or partial install — see
  // unscoped-checks.mjs's own header.
  check('a missing spec-trace (broken/partial plugin install) blocks the stop, not passes it', () =>
    withFixture({ omitSpecTrace: true }, (r) => {
      if (!r.blocked) return 'the gate passed with the engine\'s own spec-trace.mjs entirely absent — a broken install reads as a clean milestone';
      if (!/spec=1/.test(r.history)) return `expected the spec-trace field to record rc=1, got: ${r.history}`;
      return null;
    }),
  ),

  // ---- ordinary behaviour, unaffected by the split ----
  check('a red unscoped check blocks the stop and records why', () =>
    withFixture({ specTrace: 'red' }, (r) => {
      if (!r.blocked) return 'the gate did not emit a block decision for a failing check';
      if (!/result=fail/.test(r.history)) return `history did not record the failure: ${r.history}`;
      if (!r.failureLog.includes('spec-trace')) return 'the failure log does not name the check that failed';
      return null;
    }),
  ),

  // Renamed from "allows the stop" — since ADR-010 a first pass no longer
  // does; the "wakes the orchestrator" cases below cover that half. What
  // this case still owns: a green tree is never REJECTED (a `decision:
  // 'block'` whose reason is a failure, not a pass), and every declared
  // check's field lands in the history line either way.
  check('a green run is never rejected, and always records the pass', () =>
    withFixture({ specTrace: 'green' }, (r) => {
      if (rejected(r)) return 'the gate rejected a tree where every check passed';
      if (!/result=pass/.test(r.history)) return `expected a pass line, got: ${r.history}`;
      if (!/spec=0/.test(r.history)) return `the declared check did not report its field: ${r.history}`;
      return null;
    }),
  ),

  // ---- a FIRST pass wakes the orchestrator, on the channel that actually
  // reaches a human (ADR-010) --------------------------------------------
  //
  // `emitNotice`'s `systemMessage` was verified lost in an interactive
  // session while `decision:'block'` was not, so the first pass for a commit
  // must use the latter — the exact opposite of what this case asserted
  // before ADR-010. The reason string is the only thing a human or an
  // orchestrator has to act on, so it has to both say PASSED and say what to
  // do next; a block that merely announces success and leaves the reader
  // guessing is the same stall this replaced, in the other channel.
  check('a green run on a NEW commit wakes the orchestrator, on the channel that reaches a human', () =>
    withFixture({ specTrace: 'green' }, (r) => {
      if (!r.blocked) return `a first-time pass did not block — nothing will advance the run: ${JSON.stringify(r.payload)}`;
      if (r.payload?.decision !== 'block') {
        return `expected decision:'block' on a first pass, got: ${JSON.stringify(r.payload)}`;
      }
      const reason = r.payload?.reason ?? '';
      if (!/spec-flow: gate PASSED/.test(reason)) {
        return `the block reason does not announce a pass, so a human reading it cannot tell it apart from a failure: ${reason}`;
      }
      if (!/(next milestone|MODE=FOLD|'done')/i.test(reason)) {
        return `the pass block does not say what to do next: ${reason}`;
      }
      if (/^GATE FAILED/.test(reason)) return `a pass block reads exactly like a failure block: ${reason}`;
      return null;
    }),
  ),

  // ---- a SECOND stop on the same commit does not re-block --------------
  //
  // Stop can fire more than once over one clean tree — an implementer that
  // reported early, a human who said nothing in between. Waking the
  // orchestrator on every one of those would thrash: block, get answered,
  // stop again, block again with nothing new to report. `gate.mjs` guards
  // this by sha, so this case runs the SAME repo through the gate twice
  // without any new commit and asserts the second stop is silent to the
  // model. Two separate `runGate` calls on one `fixture()`, not
  // `withFixture` — the helper only runs the gate once.
  check('a second stop on the same commit does not re-wake the model', async () => {
    const built = await fixture({ specTrace: 'green' });
    try {
      const first = await runGate(built);
      if (!first.blocked) return `the first pass did not wake the orchestrator: ${JSON.stringify(first.payload)}`;
      const second = await runGate(built);
      if (second.blocked) {
        return `a second stop on a tree with no new commit re-blocked — this is the thrash the sha guard exists to prevent: ${JSON.stringify(second.payload)}`;
      }
      if (second.payload?.decision !== undefined) {
        return `the second stop carried a decision when none was expected: ${JSON.stringify(second.payload)}`;
      }
      if (typeof second.payload?.systemMessage !== 'string' || !second.payload.systemMessage) {
        return `the second stop said nothing at all, so it reads exactly like a hung run: ${JSON.stringify(second.payload)}`;
      }
      return null;
    } finally {
      rmSync(built.engineDir, { recursive: true, force: true });
      rmSync(built.repoDir, { recursive: true, force: true });
    }
  }),

  // ---- the seam between the two changes: real spec-trace, real report,
  // real gate -------------------------------------------------------------
  //
  // Everything above proves the gate's OWN routing using a stubbed
  // spec-trace, and spec-trace-fixture.mjs proves the report readers using
  // spec-trace.mjs directly, never through gate.mjs's Stop-hook protocol.
  // Neither exercises what happens when a real JUnit file, read by the real
  // spec-trace, decides what the real gate tells a human. These two do.
  check('a real JUnit report proving the requirement wakes the orchestrator and tells it what passed', () =>
    withFixture(
      {
        report: { format: 'junit', path: 'reports/junit.xml' },
        reportBody: JUNIT_PROVES,
        specs: { 'specs/fix.md': FIX_SPEC },
      },
      (r) => {
        if (!r.blocked) return `a real JUnit report proving the requirement did not wake the run: ${JSON.stringify(r.payload)}`;
        if (!/result=pass/.test(r.history)) return `expected a pass line, got: ${r.history}`;
        if (r.payload?.decision !== 'block') {
          return `the real report path passed but did not use the channel verified to reach a human: ${JSON.stringify(r.payload)}`;
        }
        if (!/spec-flow: gate PASSED/.test(r.payload?.reason ?? '')) {
          return `the real report path passed without telling the human: ${JSON.stringify(r.payload)}`;
        }
        return null;
      },
    ),
  ),

  // The one finding from building this pairing that neither fixture alone
  // could have produced: a report is not "no tests happened", it is "this
  // one test happened and did not run" — see test-report.mjs's `skipped`
  // count and spec-trace.mjs's guard against collapsing the two. Wired
  // through the real hook, a skip must still read as a normal gate FAILURE,
  // not as the "report never appeared" refusal, which sends a human to
  // check a reporter flag that was never broken.
  check('a real JUnit report marking the requirement <skipped/> blocks as an unproven requirement, not a broken contract', () =>
    withFixture(
      {
        report: { format: 'junit', path: 'reports/junit.xml' },
        reportBody: JUNIT_SKIPS,
        specs: { 'specs/fix.md': FIX_SPEC },
      },
      (r) => {
        if (!r.blocked) return 'a requirement whose only test was <skipped/> passed the gate';
        if (!/result=fail/.test(r.history)) return `history did not record the failure: ${r.history}`;
        if (!/spec=/.test(r.history) || /spec=0/.test(r.history)) {
          return `spec-trace did not report itself as the failing check: ${r.history}`;
        }
        if (!r.failureLog.includes('REQ-FIX-001') || !r.failureLog.includes('has no test')) {
          return `the failure does not name the unproven requirement, or reads as a broken report instead: ${r.failureLog}`;
        }
        // Two DIFFERENT wrong diagnoses this must not carry, from the two
        // refusals a report can trigger when it is misread as empty rather
        // than as "ran, and skipped": the file-never-written message, and the
        // reported-nothing-at-all message. Both send a human to fix a flag
        // that was never broken; the suite ran and reported a real skip.
        if (/reporter flag|does not exist/.test(r.failureLog)) {
          return `a skip was reported as a missing/broken report file, which sends a human to fix a flag that was never wrong: ${r.failureLog}`;
        }
        if (/reported no tests at all/.test(r.failureLog)) {
          return `a report holding one real, skipped test case was reported as though it said nothing at all: ${r.failureLog}`;
        }
        return null;
      },
    ),
  ),

  check('a dirty tree is skipped, not judged, and says nothing', () =>
    withFixture({ specTrace: 'red', dirty: true }, (r) => {
      if (r.blocked) return 'a dirty tree was judged; an implementer mid-write would be reported as a failure';
      if (!/result=skip-dirty/.test(r.history)) return `expected skip-dirty, got: ${r.history}`;
      // Stop fires every time the orchestrator's turn ends, including many
      // times per milestone while implementers write in the background. A
      // notice here would be noise on a run that has decided nothing, and
      // noise is how a real notice stops being read.
      if (r.stdout.trim()) return `the gate spoke about a tree it deliberately did not judge: ${r.stdout}`;
      return null;
    }),
  ),

  // ---- but a tree that NEVER clears is not an implementer mid-write --------
  //
  // Skipping is right for one stop and wrong forever. A run that leaves the
  // tree dirty and ends is never judged at all, and the only trace is a log
  // nobody opens — a gate that decided nothing, indistinguishable from a gate
  // that passed. The streak is already in `gate-history.log`, so this needs no
  // state of its own.
  check('a tree that has stayed dirty for a whole streak wakes the run', () =>
    withFixture({ specTrace: 'green', dirty: true, history: skipDirtyHistory(MAX_DIRTY_SKIPS - 1) }, (r) => {
      if (!r.blocked) {
        return `the gate skipped for the ${MAX_DIRTY_SKIPS}th stop in a row and still said nothing — nothing has been judged for this milestone and no one has been told. history: ${r.history}`;
      }
      const reason = r.payload?.reason ?? '';
      if (!/dirty/i.test(reason)) return `the block does not say what is wrong: ${reason}`;
      if (!/result=skip-dirty/.test(r.history)) return `expected the skip still recorded, got: ${r.history}`;
      return null;
    }),
  ),

  // The guard, isolated. Escalating on EVERY stop past the threshold would
  // block, get answered, and block again with nothing new — which is the
  // thrash ADR-010 had to solve for the green pass. Disable the once-per-streak
  // check in `gate.mjs` and this is the case that goes red, alone.
  check('the escalation fires once per streak, not on every stop past the threshold', () =>
    withFixture({ specTrace: 'green', dirty: true, history: skipDirtyHistory(MAX_DIRTY_SKIPS) }, (r) => {
      if (r.blocked) {
        return `the streak was already reported and the gate blocked again with nothing new to say: ${r.payload?.reason ?? ''}`;
      }
      if (r.stdout.trim()) return `the gate spoke twice about the same unbroken streak: ${r.stdout}`;
      return null;
    }),
  ),

  check('outside an implement phase the hook is transparent', () =>
    withFixture({ phase: 'idle', specTrace: 'red' }, (r) => {
      if (r.blocked) return 'the gate blocked while the phase was idle';
      if (r.history) return `the gate acted outside a run and logged: ${r.history}`;
      // Transparent means SILENT too. Every session in every repository the
      // user opens fires Stop, and a repo that never adopted this engine must
      // not learn it exists from a stray notice.
      if (r.stdout.trim()) return `the gate printed outside a run: ${r.stdout}`;
      return null;
    }),
  ),

  // ---- a repo's own extra_checks flow through the contract, not a hardcoded name ----
  check("a repo's own extra_checks are read from the contract and appear in the history line", () =>
    withFixture(
      {
        specTrace: 'green',
        extraChecks: [
          {
            name: 'fixture-extra',
            field: 'extra',
            green: '(fixture extra ok)',
            hint: 'fixture hint',
            cmd: ['node', '-e', 'console.log("fixture-extra: OK")'],
            class: 'lint/trace',
          },
        ],
      },
      (r) => {
        if (rejected(r)) return `an all-green tree with a declared extra check was rejected: ${r.stderr}`;
        if (!/extra=0/.test(r.history)) return `the declared extra check's field did not appear in history: ${r.history}`;
        return null;
      },
    ),
  ),

  // ---- the regression this milestone fixes: verify.test must run UNSCOPED ----
  //
  // Before the fix, gate.mjs appended the changed SOURCE files to
  // `verify.test`'s argv. A runner that treats trailing paths as a filter
  // over TEST files (documented in this repo's own README) would then match
  // nothing and exit non-zero on a milestone that never touched a test file
  // — a false RED that burns an Opus REPLAN for a defect that does not
  // exist. This stand-in exits 1 only if it received any argv beyond the
  // interpreter itself, so it reproduces exactly that shape of bug: green
  // proves no file argument reached it, red means the regression is back.
  check('verify.test runs with no file arguments — a changed source file alone must not turn it red', () =>
    withFixture(
      { specTrace: 'green', test: ['node', '-e', 'process.exit(process.argv.length > 1 ? 1 : 0)'] },
      (r) => {
        if (rejected(r)) return `the gate rejected the run because the test command received unexpected argv — verify.test is scoped to changed files again. stderr: ${r.stderr}, failure log: ${r.failureLog}`;
        if (!/result=pass/.test(r.history)) return `expected a pass line, got: ${r.history}`;
        return null;
      },
    ),
  ),

  // ---- the invariant that must survive the fix above: lint stays scoped ----
  check('verify.lint stays scoped to changed files (b.ts), and never receives untouched debt (a.ts)', () =>
    withFixture(
      {
        specTrace: 'green',
        lint: [
          'node',
          '-e',
          'require("fs").writeFileSync(".claude/state/lint-argv.log", process.argv.slice(1).join(","))',
        ],
      },
      (r) => {
        if (rejected(r)) return `an all-green tree was rejected unexpectedly: ${r.stderr}`;
        if (r.lintArgv === null) return 'the lint stand-in never ran — verify.lint received no invocation at all';
        if (!r.lintArgv.includes('b.ts')) return `verify.lint's argv did not include the changed file: "${r.lintArgv}"`;
        if (r.lintArgv.includes('a.ts')) return `verify.lint's argv included a.ts, an UNTOUCHED file — lint scoping regressed to whole-repo: "${r.lintArgv}"`;
        return null;
      },
    ),
  ),

  // ---- base resolution: the gate must not be disarmed by a branch name ----
  //
  // The whole group below is one defect. `resolveBase` probed `origin/main`
  // then `main`, and returned the literal string `'HEAD'` when it found
  // neither. `git diff HEAD` against a clean tree is empty BY CONSTRUCTION,
  // so on any repo whose default branch is named something else the gate
  // computed zero changed files, took the "nothing in scope changed"
  // short-circuit, and wrote `result=pass` — with a red linter and a red
  // suite sitting in the repo, neither ever invoked. Not a narrowed scope: a
  // disarmed gate, on a majority of the branch names in the wild.
  //
  // This first case is the reproduction, turned into a regression test. Both
  // commands are RED and the ONLY thing separating it from the passing `main`
  // cases above is the branch name.
  ...['master', 'develop', 'trunk'].map((branch) =>
    check(`a repo whose default branch is '${branch}' is still judged — a red tree must not read as a pass`, () =>
      withFixture({ specTrace: 'green', baseBranch: branch, lint: RED, test: RED }, (r) => {
        if (!r.blocked) {
          return `the gate ALLOWED the stop on a repo with a red linter and a red suite, because its base branch is '${branch}' rather than 'main'. This is the silent-disarm this engine exists to close, in the engine's own base resolver. history: ${r.history}`;
        }
        if (/result=pass/.test(r.history)) return `recorded a pass over a red tree: ${r.history}`;
        if (!/files=1\b/.test(r.history)) {
          return `blocked, but computed files=0 — the base is still unresolved and only the unscoped checks are running. history: ${r.history}`;
        }
        return null;
      }),
    ),
  ),

  // A base that genuinely cannot be resolved must be a REFUSAL, not an empty
  // scope. `release/7.x` is in no candidate list and there is no origin/HEAD
  // in a fixture repo, so nothing can find it — which is the point.
  check('an unresolvable base branch blocks loudly instead of silently checking nothing', () =>
    withFixture({ specTrace: 'green', baseBranch: 'release/7.x', lint: RED, test: RED }, (r) => {
      if (!r.blocked) {
        return `the gate allowed the stop when it could not resolve a base at all — the empty changed-file list read as "nothing to check". history: ${r.history}`;
      }
      if (!/result=fail:base/.test(r.history)) return `expected fail:base in the history line, got: ${r.history}`;
      if (!/base_ref/.test(r.stdout)) return `the block message does not tell a human which contract field fixes this: ${r.stdout}`;
      return null;
    }),
  ),

  // ...and declaring it in the contract is what makes that repo work again.
  // Same branch name the case above cannot resolve, so this asserts
  // `verify.base_ref` genuinely resolves it rather than some candidate in the
  // ladder happening to match.
  check('verify.base_ref resolves a base no candidate in the ladder could find', () =>
    withFixture({ specTrace: 'green', baseBranch: 'release/7.x', baseRef: 'release/7.x' }, (r) => {
      if (rejected(r)) return `an all-green tree with an explicit base_ref was rejected: ${r.stdout} ${r.stderr}`;
      if (!/result=pass/.test(r.history)) return `expected a pass line, got: ${r.history}`;
      if (!/files=1\b/.test(r.history)) {
        return `base_ref was declared but the scope is still empty — it is not being read. history: ${r.history}`;
      }
      return null;
    }),
  ),

  check('a declared base_ref that git cannot resolve blocks rather than falling back', () =>
    withFixture({ specTrace: 'green', baseRef: 'origin/does-not-exist', lint: RED, test: RED }, (r) => {
      if (!r.blocked) return `a bogus base_ref silently fell back to an empty scope: ${r.history}`;
      if (!/result=fail:base/.test(r.history)) return `expected fail:base, got: ${r.history}`;
      return null;
    }),
  ),

  // ---- the empty-scope short-circuit, which used to skip the suite too ----
  //
  // `files.length === 0` is a statement about the DIFF, not about the system,
  // and the gate used to treat it as grounds to skip `verify.test` — the same
  // scoping mistake the header of gate.mjs rejects, at its degenerate case.
  // It is also what made the base defect above fatal rather than merely
  // wrong: an empty scope invented by a bad base skipped everything.
  check('a milestone that changed no file in scope still runs the suite', () =>
    withFixture({ specTrace: 'green', changedFile: null, test: RED }, (r) => {
      if (!r.blocked) {
        return `no file in scope changed, so the gate skipped the suite and passed — a red suite reads as a clean milestone. history: ${r.history}`;
      }
      if (!/result=fail:behaviour/.test(r.history)) return `expected fail:behaviour, got: ${r.history}`;
      if (!/files=0\b/.test(r.history)) return `expected files=0 for this case, got: ${r.history}`;
      return null;
    }),
  ),

  check('an empty scope reports lint as not-run, never as clean', () =>
    withFixture({ specTrace: 'green', changedFile: null, test: RED }, (r) => {
      if (!/lint=-/.test(r.history)) {
        return `history claims a lint result for a linter that was never invoked: ${r.history}`;
      }
      if (/\(clean\)/.test(r.failureLog)) {
        return `the failure log reports the linter as "(clean)" over files it never received: ${r.failureLog}`;
      }
      return null;
    }),
  ),

  // ---- the empty scope that is not a fact about the milestone -------------
  //
  // `resolveBase` was taught to throw rather than fall back to `'HEAD'`,
  // because a base it cannot resolve yields an empty diff by construction.
  // This is the same empty diff arriving through the door that fix left open:
  // the ladder RESOLVES, successfully, to a commit that happens to be HEAD.
  // It is what a repo gets when the work is being done directly on the base
  // branch — no remote, no feature branch, `merge-base HEAD main` == HEAD —
  // and it is permanent, not transient: every further commit lands on the
  // base too, so the scope is empty for the whole run and for every run after
  // it.
  //
  // The consequence is narrower than the old `'HEAD'` fallback (`cba77ef`
  // made the suite, spec-trace and the extra checks run on every armed gate
  // regardless of scope, so this is not a disarmed gate) and it is not
  // nothing: `verify.lint` is the one check scoped to the diff, so it never
  // runs, for any milestone, while nothing anywhere says the linter is not
  // participating. `lint=-` in the history is honest and reads identically to
  // the milestone that genuinely touched no `.ts` file.
  check('a base that resolves to HEAD itself is refused, not read as an empty milestone', () =>
    withFixture({ specTrace: 'green', stayOnBase: true }, (r) => {
      if (!r.blocked) {
        return `the base resolved to HEAD, so the scope is empty by construction and verify.lint can never run — and the gate passed the milestone anyway. history: ${r.history}`;
      }
      if (!/result=fail:base/.test(r.history)) return `expected fail:base, got: ${r.history}`;
      return null;
    }),
  ),

  // The message has to name the repair, because the repo cannot see the cause
  // from the outside: everything looks normal, the suite even runs.
  check('the refusal names the branch it is standing on, and what to do about it', () =>
    withFixture({ specTrace: 'green', stayOnBase: true }, (r) => {
      if (!/base_ref/.test(r.stdout)) return `the block does not point at the contract field that fixes it: ${r.stdout}`;
      if (!/branch/i.test(r.stdout)) return `the block does not mention branching, the other repair: ${r.stdout}`;
      return null;
    }),
  ),

  // The distinction the previous two cases exist to draw: an empty scope on a
  // real branch is a fact about the milestone and must still pass. Without
  // this, "refuse an empty scope" would be indistinguishable from the fix.
  check('an empty scope on a real branch still passes — the diff, not the base, is what is empty', () =>
    withFixture({ specTrace: 'green', changedFile: null }, (r) => {
      if (rejected(r)) {
        return `a milestone that committed real work outside scope_globs was refused as a degenerate base: ${r.stdout} ${r.stderr}`;
      }
      if (!/result=pass/.test(r.history)) return `expected a pass line, got: ${r.history}`;
      if (!/files=0\b/.test(r.history)) return `expected files=0, got: ${r.history}`;
      return null;
    }),
  ),

  // ---- the new routing: a red test on attempt 1 goes to the implementer, not to REPLAN ----
  check('a red test on attempt 1 routes to the implementer directly — no REPLAN yet', () =>
    withFixture({ specTrace: 'green', test: RED, gateAttempts: '0' }, (r) => {
      if (!r.blocked) return 'a red test did not block the stop';
      if (!/result=fail:behaviour/.test(r.history)) return `expected fail:behaviour on attempt 1, got: ${r.history}`;
      if (/MODE=REPLAN/.test(r.stdout)) return `attempt 1 already told the orchestrator to REPLAN — should have routed to the implementer first. stdout: ${r.stdout}`;
      if (!/attempt 1/.test(r.stdout)) return `the block message did not name attempt 1: ${r.stdout}`;
      return null;
    }),
  ),

  // ---- and only a SECOND red attempt is evidence the plan itself is wrong ----
  check('a red test that survives one attempt (attempt 2) routes to REPLAN', () =>
    withFixture({ specTrace: 'green', test: RED, gateAttempts: '1' }, (r) => {
      if (!r.blocked) return 'a red test did not block the stop';
      if (!/result=fail:behaviour/.test(r.history)) return `expected fail:behaviour on attempt 2, got: ${r.history}`;
      if (!/MODE=REPLAN/.test(r.stdout)) return `attempt 2 did not route to REPLAN: ${r.stdout}`;
      return null;
    }),
  ),

  // ---- a repo's own extra_checks can force the behaviour class too, not just a red test ----
  check("an extra_check declared class:'behaviour' routes like a red test, not like lint", () =>
    withFixture(
      {
        specTrace: 'green',
        gateAttempts: '0',
        extraChecks: [
          {
            name: 'fixture-behaviour-check',
            field: 'beh',
            green: '(ok)',
            hint: 'fixture hint',
            cmd: ['node', '-e', 'process.exit(1)'],
            class: 'behaviour',
          },
        ],
      },
      (r) => {
        if (!r.blocked) return 'a red behaviour-classed check did not block the stop';
        if (!/result=fail:behaviour/.test(r.history)) return `expected fail:behaviour (the test itself was green, only the declared check was red), got: ${r.history}`;
        if (/MODE=REPLAN/.test(r.stdout)) return `attempt 1 of a behaviour-classed check already routed to REPLAN: ${r.stdout}`;
        return null;
      },
    ),
  ),
]);

if (failures.length) {
  failures.sort();
  console.log(`gate-fixture: ${failures.length} case(s) failed\n`);
  for (const f of failures) console.log(`  ✕ ${f}\n`);
  process.exit(1);
}

console.log('gate-fixture: OK — the gate holds under each of its own failure modes, engine and repo installed at separate paths.');
