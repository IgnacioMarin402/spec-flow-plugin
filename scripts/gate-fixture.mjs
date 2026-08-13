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
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
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
 */
async function fixture({
  phase = 'implement',
  specTrace = 'green',
  dirty = false,
  extraChecks = [],
  contractVersion = 1,
  sabotage = null,
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
  // this fixture is testing.
  writeFileSync(
    join(engineDir, 'scripts/spec-trace.mjs'),
    specTrace === 'green'
      ? 'console.log("spec-trace: OK — fixture");\n'
      : 'console.log("spec-trace: FAIL — REQ-FIX-001 has no test");\nprocess.exit(1);\n',
  );

  // Injects a runtime throw into one of the engine's own modules, to stand in
  // for a defect nothing static could catch. Applied to the COPY, so the real
  // engine is untouched.
  if (sabotage) {
    const target = join(engineDir, sabotage.file);
    writeFileSync(target, readFileSync(target, 'utf8').replace(sabotage.find, sabotage.replace));
  }

  const git = (...args) => run('git', args, { cwd: repoDir });
  await git('init', '-q', '.');
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
          lint: ['node', '-e', 'process.exit(0)'],
          lint_no_fix: ['node', '-e', 'process.exit(0)'],
          test: ['node', '-e', 'process.exit(0)'],
          test_name: 'fixture-test',
          lint_name: 'fixture-lint',
          lint_config_hint: 'fixture.config',
        },
        trace: { specs_dir: 'specs', proof_dir: 'application', proof_suffix: '.spec.ts', not_a_capability: [] },
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
  await git('commit', '-qm', 'fixture');

  if (dirty) writeFileSync(join(repoDir, 'dirty.txt'), 'uncommitted\n');

  writeFileSync(join(repoDir, '.claude/state/phase'), phase);
  writeFileSync(join(repoDir, '.claude/state/gate_attempts'), '0');

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

  return {
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
    blocked: res.stdout.includes('"decision":"block"'),
    history: existsSync(histPath) ? readFileSync(histPath, 'utf8').trim() : '',
    failureLog: existsSync(failPath) ? readFileSync(failPath, 'utf8').trim() : '',
  };
}

async function withFixture(opts, assert) {
  const { engineDir, repoDir } = await fixture(opts);
  try {
    return assert(await runGate({ engineDir, repoDir }));
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

  // ---- the one deliberate fail-CLOSED case ----
  check('an unrecognized contract_version blocks loudly instead of falling back to defaults', () =>
    withFixture({ specTrace: 'green', contractVersion: 999 }, (r) => {
      if (!r.blocked) return 'a contract version this engine does not understand did not block the stop';
      if (!/fail:contract/.test(r.history)) return `history did not record a contract failure: ${r.history}`;
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
]);

if (failures.length) {
  failures.sort();
  console.log(`gate-fixture: ${failures.length} case(s) failed\n`);
  for (const f of failures) console.log(`  ✕ ${f}\n`);
  process.exit(1);
}

console.log('gate-fixture: OK — the gate holds under each of its own failure modes, engine and repo installed at separate paths.');
