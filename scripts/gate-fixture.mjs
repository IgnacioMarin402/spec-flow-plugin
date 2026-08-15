#!/usr/bin/env node
/**
 * Behaviour fixture for hooks/gate.mjs.
 *
 * The gate is the one hook every other guarantee in this engine depends on,
 * so it is the one thing tested by running it, not by reading it. Every case
 * builds a throwaway git repo, installs the engine at a SEPARATE path (the
 * way it actually ships — a plugin cache directory, never inside the repo it
 * serves), points `CLAUDE_PROJECT_DIR` at the repo, and asserts what the real
 * hook did.
 *
 * The contract every case is really testing:
 *
 *   A Stop hook expresses "block" by printing {"decision":"block"} and
 *   exiting 0. Exiting non-zero is not a stricter failure, it is NO failure
 *   at all — the stop proceeds. So "did it exit 0" is never the assertion;
 *   "did it say block, and did it write down what it judged" is.
 *
 * Cases run concurrently: each builds its own two temp directories and its
 * own child process, nothing is shared.
 *
 * ---- the fixture's own history ----------------------------------------
 * Every case here used to build a repo with a single commit and no base
 * branch to diff against: `resolveBase` had nothing to find, fell through to
 * `HEAD`, and `changedFiles(root, globs, HEAD)` is empty by construction
 * (a diff against yourself is always empty). That made `files.length === 0`
 * on every single case, which routes straight through the "no files in
 * scope" short-circuit in gate.mjs — meaning this fixture asserted the
 * gate's block/pass behaviour around `verify.lint` and `verify.test` for
 * years WITHOUT EVER ONCE INVOKING either of them. The fixture reproduced,
 * inside itself, the exact class of failure this whole engine exists to
 * catch: a check that looks armed and is not. `fixture()` now creates a real
 * base branch (`main`) plus a second commit on `feature` that changes a
 * tracked file, so `files.length > 0` for every case below — and the
 * "a green run reports the real scope" case exists specifically to keep that
 * true, by breaking loudly if it ever regresses back to empty.
 *
 * That fix left a second copy of the same assumption behind, in this file's
 * own scaffolding: it hardcoded the base branch to `main`, because `main` is
 * what `resolveBase` probed for, and this header documented the coupling as
 * though it were a property of the fixture. It was a property of the ENGINE,
 * and it was a defect. A repo whose default branch is `master`, `develop` or
 * `trunk` got `resolveBase() === 'HEAD'`, an empty changed-file list, and a
 * gate that wrote `result=pass` over a red linter and a red suite that had
 * never been invoked. No case here could have caught it, because every case
 * had been built to match the bug. `baseBranch` is a parameter now, and the
 * cases below run the real hook against branch names the old resolver could
 * not see.
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
}) {
  const engineDir = mkdtempSync(join(tmpdir(), 'spec-flow-engine-'));
  const repoDir = mkdtempSync(join(tmpdir(), 'spec-flow-repo-'));

  mkdirSync(join(engineDir, 'hooks', 'lib'), { recursive: true });
  mkdirSync(join(engineDir, 'scripts'), { recursive: true });
  copyFileSync(join(ROOT, 'hooks/gate.mjs'), join(engineDir, 'hooks/gate.mjs'));
  for (const f of ['io.mjs', 'agent-name.mjs']) {
    copyFileSync(join(ROOT, 'hooks/lib', f), join(engineDir, 'hooks/lib', f));
  }
  for (const f of ['spec-flow-config.mjs', 'unscoped-checks.mjs', 'changed-files.mjs']) {
    copyFileSync(join(ROOT, 'scripts', f), join(engineDir, 'scripts', f));
  }

  // A deterministic stand-in for spec-trace, green or red on demand — the
  // real one depends on this plugin repo's own specs/, which is not what
  // this fixture is testing. `omitSpecTrace` skips writing it entirely, to
  // exercise the "plugin install is broken/partial" path in
  // unscoped-checks.mjs instead.
  if (!omitSpecTrace) {
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
          // Unused by these cases — this fixture stubs spec-trace out entirely,
          // deliberately, so the gate's own behaviour is what is under test.
          // Present because the contract requires it, which is itself the point:
          // a repo cannot reach the gate without declaring how proof is found.
          executed_tests: ['node', '-e', 'process.exit(0)'],
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

  return {
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
    blocked: res.stdout.includes('"decision":"block"'),
    history: existsSync(histPath) ? readFileSync(histPath, 'utf8').trim() : '',
    failureLog: existsSync(failPath) ? readFileSync(failPath, 'utf8').trim() : '',
    lintArgv: existsSync(lintArgvPath) ? readFileSync(lintArgvPath, 'utf8').trim() : null,
  };
}

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
      if (r.blocked) return `the gate blocked a green tree — stderr: ${r.stderr}`;
      if (!/result=pass/.test(r.history)) {
        return `no pass recorded in the REPO's own state — the hook wrote state somewhere else, or did not run against the repo at all. stdout: ${r.stdout} stderr: ${r.stderr}`;
      }
      return null;
    }),
  ),

  // ---- the fixture's own signature failure, closed: it must actually reach verify.lint/verify.test ----
  check('a green run against real changes reports the real scope (files=1), not the empty short-circuit', () =>
    withFixture({ specTrace: 'green' }, (r) => {
      if (r.blocked) return `the gate blocked a green tree — stderr: ${r.stderr}`;
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

  check('a green run allows the stop and records the pass', () =>
    withFixture({ specTrace: 'green' }, (r) => {
      if (r.blocked) return 'the gate blocked a tree where every check passed';
      if (!/result=pass/.test(r.history)) return `expected a pass line, got: ${r.history}`;
      if (!/spec=0/.test(r.history)) return `the declared check did not report its field: ${r.history}`;
      return null;
    }),
  ),

  check('a dirty tree is skipped, not judged', () =>
    withFixture({ specTrace: 'red', dirty: true }, (r) => {
      if (r.blocked) return 'a dirty tree was judged; an implementer mid-write would be reported as a failure';
      if (!/result=skip-dirty/.test(r.history)) return `expected skip-dirty, got: ${r.history}`;
      return null;
    }),
  ),

  check('outside an implement phase the hook is transparent', () =>
    withFixture({ phase: 'idle', specTrace: 'red' }, (r) => {
      if (r.blocked) return 'the gate blocked while the phase was idle';
      if (r.history) return `the gate acted outside a run and logged: ${r.history}`;
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
        if (r.blocked) return `an all-green tree with a declared extra check blocked: ${r.stderr}`;
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
        if (r.blocked) return `the gate blocked because the test command received unexpected argv — verify.test is scoped to changed files again. stderr: ${r.stderr}, failure log: ${r.failureLog}`;
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
        if (r.blocked) return `an all-green tree blocked unexpectedly: ${r.stderr}`;
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
      if (r.blocked) return `an all-green tree with an explicit base_ref blocked: ${r.stdout} ${r.stderr}`;
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
      if (r.blocked) {
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
