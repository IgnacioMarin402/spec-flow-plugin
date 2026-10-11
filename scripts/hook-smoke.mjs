#!/usr/bin/env node
/**
 * Smoke test for the hooks `gate-fixture.mjs` does not cover.
 *
 * `gate.mjs` earns a fixture of its own because it is the hook every other
 * guarantee depends on. The others were, for a while, verified by
 * nothing at all — read carefully and shipped, which is exactly the standard
 * this engine refuses to accept from the code it gates.
 *
 * Shallower than gate-fixture on purpose: one realistic payload per branch
 * that matters, asserting what the hook did to a throwaway repo's state. It
 * will not catch a subtle misclassification; it will catch a hook that
 * crashes, never fires, fires when it should not, or writes the wrong file —
 * which is most of what a port breaks.
 *
 *   node scripts/hook-smoke.mjs [engine-root]
 */
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, existsSync, readFileSync, readdirSync, utimesSync, cpSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ENGINE = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];

/** The contract and the phase, written under `dir` — the two files a run arms on. */
function writeRun(dir, phase) {
  mkdirSync(join(dir, '.claude', 'state'), { recursive: true });
  mkdirSync(join(dir, '.spec-flow'), { recursive: true });
  writeFileSync(join(dir, '.spec-flow/config.json'), contractJson());
  writeFileSync(join(dir, '.claude/state/phase'), phase);
}

function makeRepo({ phase = 'implement', withContract = true, git = true, commitPhase = false, commit = true } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'smoke-repo-'));
  mkdirSync(join(repo, 'specflow'), { recursive: true });
  if (withContract) {
    writeRun(repo, phase);
  } else {
    mkdirSync(join(repo, '.claude', 'state'), { recursive: true });
    writeFileSync(join(repo, '.claude/state/phase'), phase);
  }

  // A real repo with a base branch, because the engine's scope is a
  // merge-base diff and `preflight` refuses to start a run without one. Off
  // only for the case that asserts exactly that refusal.
  if (git) initRepo(repo, { commitPhase, commit });

  return repo;
}

/**
 * `git init` plus one commit on `main`, so a merge-base exists — and the phase
 * committed with it when a case asks. `commit: false` leaves a repository with
 * no commit at all, the honest shape of "a repository whose base cannot be
 * resolved": it IS a repository, so the root check passes, and no ref exists
 * for the base ladder to find.
 */
function initRepo(dir, { commitPhase = false, commit = true } = {}) {
  const g = (...args) => spawnSync('git', args, { cwd: dir, stdio: 'ignore' });
  g('init', '-q', '.');
  g('symbolic-ref', 'HEAD', 'refs/heads/main');
  g('config', 'user.email', 'smoke@example.com');
  g('config', 'user.name', 'smoke');
  if (commit) g('commit', '-q', '--allow-empty', '-m', 'baseline');
  // The shape a repository the user did not write can arrive in: the file
  // every enforcement hook arms on, supplied by the repo rather than by a
  // run. See ADR-017.
  if (commitPhase) {
    g('add', '-f', '--', '.claude/state/phase');
    g('commit', '-q', '-m', 'a phase this repository committed');
  }
}

function contractJson() {
  return JSON.stringify({
        contract_version: 1,
        verify: {
          scope_globs: ['*.ts'],
          lint: ['node', '-e', 'process.exit(0)'],
          lint_no_fix: ['node', '-e', 'process.exit(0)'],
          test: ['node', '-e', 'process.exit(0)'],
          test_name: 'ftest',
          lint_name: 'flint',
          lint_config_hint: 'f.config',
        },
        trace: {
          specs_dir: 'specs',
          proof_dir: 'tests',
          proof_suffix: '.spec.ts',
          executed_tests: ['node', '-e', 'process.exit(0)'],
          not_a_capability: [],
        },
        extra_checks: [],
        unscoped_denied: {
          scripts: ['test', 'lint'],
          tools: ['eslint', 'ftest'],
          scoped_allowed: ['check'],
          scoped_alternative: 'npm run check',
          scoped_examples: ['npm run check'],
        },
      });
}

/** One gate-history line judging the repo's current HEAD, in the gate's own shape. */
function seedGateHistory(repo, result) {
  const sha = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
  writeFileSync(
    join(repo, '.claude/state/gate-history.log'),
    `2026-01-01T00:00:00Z ${sha} cc=? engine=smoke phase=implement attempt=0 result=${result} lint=0 test=0 spec=0 files=1\n`,
  );
}

function runHook(hook, payload, repo, engineRoot = ENGINE, env = {}) {
  return spawnSync('node', [join(engineRoot, 'hooks', hook)], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: repo, ...env },
    cwd: tmpdir(),
  });
}

/**
 * A throwaway copy of the engine declaring a different Node floor.
 *
 * The floor is read from `package.json`'s `engines.node`, so testing the
 * comparison means changing that file — not adding an env-var override to a
 * hook whose job is DENYING. A knob that can make preflight refuse a run is
 * not something to ship for a fixture's convenience, and the version actually
 * running cannot be lowered here, so the floor is raised past it instead.
 * Same branch, same comparison, no second Node.
 */
function engineDeclaring(nodeFloor) {
  const dir = mkdtempSync(join(tmpdir(), 'spec-flow-engine-'));
  cpSync(join(ENGINE, 'hooks'), join(dir, 'hooks'), { recursive: true });
  cpSync(join(ENGINE, 'scripts'), join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module', engines: { node: `>=${nodeFloor}` } }, null, 2));
  return dir;
}

function t(name, fn, repoOpts) {
  const repo = makeRepo(repoOpts);
  try {
    const p = fn(repo);
    results.push([name, p ? 'FAIL: ' + p : 'ok']);
  } catch (e) {
    results.push([name, 'THREW: ' + e.message]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ---- preflight: the run refuses to start rather than dying at the gate ----
//
// Before this hook, the contract's first BLOCKING check was the gate, on
// Stop, while implementing. A repo with an unusable contract therefore spent
// spec-writer, the human sign-off, an Opus planner call, the reviewer and a
// whole implementer milestone before anything said the engine could not run
// here. These cases pin the two halves of the fix: it denies what would have
// failed later, and it is invisible everywhere else.
t('preflight allows a run whose contract and base both resolve', (repo) => {
  const r = runHook('preflight.mjs', { tool_input: { subagent_type: 'spec-writer' } }, repo);
  if (r.status !== 0) return `a valid setup was denied — exit ${r.status}: ${r.stderr}`;
  return null;
});

t(
  'preflight denies the first spawn when the contract is unusable',
  (repo) => {
    const r = runHook('preflight.mjs', { tool_input: { subagent_type: 'spec-writer' } }, repo);
    if (r.status !== 2) return `expected the PreToolUse denial (exit 2), got ${r.status}: ${r.stderr}`;
    if (!/PREFLIGHT FAILED/.test(r.stderr)) return `the denial does not say what happened: ${r.stderr}`;
    return null;
  },
  { withContract: false, phase: 'spec' },
);

t(
  'preflight denies when no base branch can be resolved',
  (repo) => {
    const r = runHook('preflight.mjs', { tool_input: { subagent_type: 'spec-writer' } }, repo);
    if (r.status !== 2) return `a run with no resolvable base was allowed to start — exit ${r.status}`;
    if (!/base branch/.test(r.stderr)) return `the denial does not name the base as the problem: ${r.stderr}`;
    return null;
  },
  { commit: false, phase: 'spec' },
);

// A directory in no repository at all — a workspace folder holding several
// repositories — has no base to resolve either, and that is not what is wrong
// with it. Named as such, or a human fills a contract in for a directory the
// engine can never run against (ADR-027).
t(
  'preflight denies a run at a directory that is in no repository, and says to open a repository',
  (repo) => {
    const r = runHook('preflight.mjs', { tool_input: { subagent_type: 'spec-writer' } }, repo);
    if (r.status !== 2) return `a run outside any repository was allowed to start — exit ${r.status}`;
    if (!/not inside a git repository/.test(r.stderr)) return `the denial blames something other than the missing repository: ${r.stderr}`;
    // The heading is what a human reads first, and it must not contradict the
    // detail under it — nor send them to run `init` in a directory where init
    // refuses for the same reason.
    if (!/PREFLIGHT FAILED — this directory is in no git repository/.test(r.stderr)) return `the heading names something other than the missing repository: ${r.stderr.split('\n')[0]}`;
    if (/spec-flow init` regenerates/.test(r.stderr)) return `the denial sends a human to run init here, where init refuses for the same reason: ${r.stderr}`;
    return null;
  },
  { git: false, phase: 'spec' },
);

// ---- the unit of a run is the repository (ADR-027) -------------------------
//
// Opened inside a package of a workspace, every committed change git reports
// is spelled from the root and falls out of the subdirectory's scope, so the
// gate would pass with the linter never invoked. The run is refused at its
// first spawn instead, and the message names the root.
t('preflight denies a run opened in a subdirectory of its repository', () => {
  const outer = mkdtempSync(join(tmpdir(), 'smoke-workspace-'));
  try {
    initRepo(outer);
    const back = join(outer, 'back');
    writeRun(back, 'spec');
    const r = runHook('preflight.mjs', { tool_input: { subagent_type: 'spec-writer' } }, back);
    if (r.status !== 2) return `a run opened at back/ of a repository was allowed to start — exit ${r.status}: ${r.stderr}`;
    if (!/repository root/.test(r.stderr)) return `the denial does not say where to open the repository: ${r.stderr}`;
    return null;
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});

// A GUARD on the rule's edge, not proof of a defect: it passes before the
// refusal existed too. A package that is its own repository IS a root,
// wherever it sits on disk, and the refusal must not reach it.
t('preflight allows a package that is its own repository, wherever it sits on disk', () => {
  const outer = mkdtempSync(join(tmpdir(), 'smoke-workspace-'));
  try {
    initRepo(outer);
    const back = join(outer, 'back');
    writeRun(back, 'spec');
    initRepo(back);
    const r = runHook('preflight.mjs', { tool_input: { subagent_type: 'spec-writer' } }, back);
    if (r.status !== 0) return `a package that is its own repository was refused — exit ${r.status}: ${r.stderr}`;
    return null;
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});

t(
  'preflight is transparent outside a run, even with no contract at all',
  (repo) => {
    const r = runHook('preflight.mjs', { tool_input: { subagent_type: 'anything' } }, repo);
    if (r.status !== 0) return `it denied a subagent spawned outside the flow — exit ${r.status}: ${r.stderr}`;
    return null;
  },
  { withContract: false, git: false, phase: 'idle' },
);

t(
  'session-start resets a stale plan phase, not just implement/blocked',
  (repo) => {
    // `preflight` arms on every run phase, so an abandoned `plan` makes it
    // validate — and potentially DENY — every subagent spawn in that repo
    // forever. No run phase is "already harmless" to leave standing.
    const phaseFile = join(repo, '.claude/state/phase');
    const old = Date.now() / 1000 - 60 * 60 * 24 * 3;
    utimesSync(phaseFile, old, old);
    const r = runHook('session-start.mjs', {}, repo);
    if (r.status !== 0) return `exit ${r.status}: ${r.stderr}`;
    const phase = readFileSync(phaseFile, 'utf8');
    if (phase !== 'idle') return `a three-day-old 'plan' survived as "${phase}"`;
    return null;
  },
  { phase: 'plan' },
);

t('no hook creates .claude/state/ in a repo that is not running the flow', () => {
  // Every hook reads the phase before deciding it has nothing to do. Routing
  // that read through `stateDir` (which mkdirs) meant standing down still
  // left a directory behind — in every repository the user ever opened.
  const bare = mkdtempSync(join(tmpdir(), 'smoke-bare-'));
  try {
    writeFileSync(join(bare, 'package.json'), '{}');
    for (const hook of readdirSync(join(ENGINE, 'hooks')).filter((f) => f.endsWith('.mjs'))) {
      runHook(hook, { tool_name: 'Task', tool_input: { subagent_type: 'planner', command: 'ls' } }, bare);
    }
    if (existsSync(join(bare, '.claude'))) {
      return 'the hooks created .claude/ in a repo with no phase file and no contract';
    }
    return null;
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

t('arm-gate matches an agent name whatever its casing', (repo) => {
  writeFileSync(join(repo, '.claude/state/phase'), 'plan');
  const r = runHook('arm-gate.mjs', { tool_input: { subagent_type: 'Implementer' } }, repo);
  if (r.status !== 0) return `exit ${r.status}: ${r.stderr}`;
  const phase = readFileSync(join(repo, '.claude/state/phase'), 'utf8');
  if (phase !== 'implement') {
    return `phase is "${phase}" — a capitalised agent type left the gate, the write-time linter and the command deny all disarmed, silently`;
  }
  return null;
});

t('the whole-repo denial does not hand the agent a way to disarm the flow', (repo) => {
  const r = runHook('no-gate-cmds.mjs', { tool_input: { command: 'npm run test' } }, repo);
  if (r.status !== 2) return `expected a denial, got exit ${r.status}`;
  if (/state[\\/]phase/.test(r.stderr)) {
    return `the denial quotes the phase file to an agent mid-milestone: ${r.stderr}`;
  }
  return null;
});

t('arm-gate flips phase on an implementer spawn', (repo) => {
  writeFileSync(join(repo, '.claude/state/phase'), 'plan');
  const r = runHook('arm-gate.mjs', { tool_input: { subagent_type: 'implementer' } }, repo);
  if (r.status !== 0) return `exit ${r.status}: ${r.stderr}`;
  const phase = readFileSync(join(repo, '.claude/state/phase'), 'utf8');
  if (phase !== 'implement') return `phase is "${phase}", expected implement`;
  return null;
});

t('arm-gate ignores a non-implementer spawn', (repo) => {
  writeFileSync(join(repo, '.claude/state/phase'), 'plan');
  const r = runHook('arm-gate.mjs', { tool_input: { subagent_type: 'reviewer' } }, repo);
  if (r.status !== 0) return `exit ${r.status}`;
  const phase = readFileSync(join(repo, '.claude/state/phase'), 'utf8');
  if (phase !== 'plan') return `phase changed to "${phase}"`;
  return null;
});

t('opus-budget counts a planner spawn', (repo) => {
  writeFileSync(join(repo, '.claude/spec-flow.config.json'), JSON.stringify({ max_opus_calls: 6 }));
  const r = runHook('opus-budget.mjs', { tool_name: 'Task', tool_input: { subagent_type: 'planner' } }, repo);
  if (r.status !== 0) return `exit ${r.status}: ${r.stderr}`;
  const n = readFileSync(join(repo, '.claude/state/opus_calls'), 'utf8');
  if (n !== '1') return `opus_calls is "${n}", expected 1`;
  return null;
});

t('opus-budget denies past the cap', (repo) => {
  writeFileSync(join(repo, '.claude/spec-flow.config.json'), JSON.stringify({ max_opus_calls: 2 }));
  writeFileSync(join(repo, '.claude/state/opus_calls'), '2');
  const r = runHook('opus-budget.mjs', { tool_name: 'Task', tool_input: { subagent_type: 'planner' } }, repo);
  if (r.status !== 2) return `exit ${r.status}, expected 2 (deny). stderr: ${r.stderr.slice(0, 200)}`;
  if (!r.stderr.includes('budget exhausted')) return 'no budget message on stderr';
  return null;
});

t('opus-budget does not count a non-escalation spawn', (repo) => {
  writeFileSync(join(repo, '.claude/spec-flow.config.json'), JSON.stringify({ max_opus_calls: 6 }));
  const r = runHook('opus-budget.mjs', { tool_name: 'Task', tool_input: { subagent_type: 'implementer' } }, repo);
  if (r.status !== 0) return `exit ${r.status}`;
  const f = join(repo, '.claude/state/opus_calls');
  if (existsSync(f) && readFileSync(f, 'utf8') !== '0' && readFileSync(f, 'utf8') !== '') {
    return `opus_calls became "${readFileSync(f, 'utf8')}" for a spawn that is not an escalation`;
  }
  return null;
});

// Guards: the architect has a budget of its own (ADR-038).
const counter = (repo, name) => {
  const f = join(repo, '.claude/state', name);
  return existsSync(f) ? readFileSync(f, 'utf8').trim() || '0' : '0';
};

t("opus-budget charges the architect to its own counter, not the planner's", (repo) => {
  const r = runHook('opus-budget.mjs', { tool_name: 'Task', tool_input: { subagent_type: 'spec-flow:architect' } }, repo);
  if (r.status !== 0) return `exit ${r.status}: ${r.stderr}`;
  if (counter(repo, 'architect_calls') !== '1') return `architect_calls is "${counter(repo, 'architect_calls')}", expected 1`;
  return counter(repo, 'opus_calls') === '0' ? null : `the architect was charged to opus_calls ("${counter(repo, 'opus_calls')}")`;
});

t('opus-budget stops the architect at 3 by default while the planner still has budget', (repo) => {
  writeFileSync(join(repo, '.claude/state/architect_calls'), '3');
  const a = runHook('opus-budget.mjs', { tool_name: 'Task', tool_input: { subagent_type: 'architect' } }, repo);
  if (a.status !== 2) return `a fourth architect call went through (exit ${a.status})`;
  if (!a.stderr.includes('max_architect_calls')) return `the denial does not name max_architect_calls: ${a.stderr.slice(0, 200)}`;
  const p = runHook('opus-budget.mjs', { tool_name: 'Task', tool_input: { subagent_type: 'planner' } }, repo);
  return p.status === 0 ? null : `the planner was denied by the architect's budget (exit ${p.status})`;
});

t('opus-budget reads max_architect_calls from the config', (repo) => {
  writeFileSync(join(repo, '.claude/spec-flow.config.json'), JSON.stringify({ max_architect_calls: 1 }));
  writeFileSync(join(repo, '.claude/state/architect_calls'), '1');
  const r = runHook('opus-budget.mjs', { tool_name: 'Task', tool_input: { subagent_type: 'architect' } }, repo);
  return r.status === 2 ? null : `max_architect_calls 1 let a second call through (exit ${r.status})`;
});

t('register-agent records an Opus session id', (repo) => {
  const r = runHook(
    'register-agent.mjs',
    { tool_input: { subagent_type: 'planner' }, tool_response: { agent_id: 'a1b2c3d4e5f6a7b8' } },
    repo,
  );
  if (r.status !== 0) return `exit ${r.status}: ${r.stderr}`;
  const reg = readFileSync(join(repo, '.claude/state/agent-registry'), 'utf8');
  if (!reg.includes('a1b2c3d4e5f6a7b8 planner')) return `registry has: ${JSON.stringify(reg)}`;
  return null;
});

t('no-gate-cmds denies a whole-repo run', (repo) => {
  const r = runHook('no-gate-cmds.mjs', { tool_input: { command: 'npm run test' } }, repo);
  if (r.status !== 2) return `exit ${r.status}, expected 2. stderr: ${r.stderr.slice(0, 200)}`;
  return null;
});

// The denial's whole job is redirecting an implementer, so a command it names
// that does not resolve is worse than no message: the reader is an agent
// mid-milestone that cannot install anything, and the hook says in its own
// source that it is evadable. The contract's own alternative can be anything
// the repo declared — including a script whose binary is not installed — so
// what is asserted here is that the message ALSO names a route needing
// nothing, and that the route is a file this plugin actually ships.
t('no-gate-cmds names a check that needs nothing installed, and it exists', (repo) => {
  const r = runHook('no-gate-cmds.mjs', { tool_input: { command: 'npm run test' } }, repo);
  const named = /^\s*node (.+check-changed\.mjs)\s*$/m.exec(r.stderr);
  if (!named) return `the denial names no install-free route:\n${r.stderr.slice(0, 400)}`;
  if (!existsSync(named[1])) return `it names ${named[1]}, which does not exist — the implementer is sent to a path that is not there`;
  return null;
});

t('no-gate-cmds allows the declared scoped command', (repo) => {
  const r = runHook('no-gate-cmds.mjs', { tool_input: { command: 'npm run check' } }, repo);
  if (r.status !== 0) return `exit ${r.status}, expected 0 (allow). stderr: ${r.stderr.slice(0, 200)}`;
  return null;
});

t('no-gate-cmds allows a path-scoped tool run', (repo) => {
  const r = runHook('no-gate-cmds.mjs', { tool_input: { command: 'eslint example/thing.ts' } }, repo);
  if (r.status !== 0) return `exit ${r.status}, expected 0 (scoped). stderr: ${r.stderr.slice(0, 200)}`;
  return null;
});

t('no-gate-cmds denies a bare unscoped tool run', (repo) => {
  const r = runHook('no-gate-cmds.mjs', { tool_input: { command: 'eslint' } }, repo);
  if (r.status !== 2) return `exit ${r.status}, expected 2 (deny)`;
  return null;
});

t('no-gate-cmds denies a runner subcommand with no path', (repo) => {
  // `run` was read as a scope, so `ftest run` put the whole suite in the
  // implementer's context.
  const r = runHook('no-gate-cmds.mjs', { tool_input: { command: 'npx ftest run' } }, repo);
  return r.status === 2 ? null : `exit ${r.status}, expected 2: a subcommand passed as a scope`;
});

t('no-gate-cmds denies a flag value posing as a scope', (repo) => {
  const r = runHook('no-gate-cmds.mjs', { tool_input: { command: 'eslint --max-warnings 0' } }, repo);
  return r.status === 2 ? null : `exit ${r.status}, expected 2: a flag's value passed as a scope`;
});

t('no-gate-cmds allows a subcommand plus a test path — the red run test-first asks for', (repo) => {
  const r = runHook('no-gate-cmds.mjs', { tool_input: { command: 'npx ftest run tests/a.spec.ts' } }, repo);
  return r.status === 0 ? null : `exit ${r.status}, expected 0: the implementer's own red run was denied. stderr: ${r.stderr.slice(0, 200)}`;
});

t('no-gate-cmds does not tell the implementer to skip its red run', (repo) => {
  const r = runHook('no-gate-cmds.mjs', { tool_input: { command: 'npm run test' } }, repo);
  if (/do not need to run anything/.test(r.stderr)) return 'the denial tells the implementer to run nothing, which skips the red run test-first asks for';
  return /test file's path/.test(r.stderr) ? null : `the denial never names the scoped form a red run takes:\n${r.stderr.slice(0, 400)}`;
});

t('no-gate-cmds reads quoted text as data, not as a command', (repo) => {
  const r = runHook('no-gate-cmds.mjs', { tool_input: { command: 'git commit -m "fix; ftest covers it"' } }, repo);
  return r.status === 0 ? null : `exit ${r.status}: a commit message was read as a test run. stderr: ${r.stderr.slice(0, 200)}`;
});

t('no-gate-cmds still reads a quoted test path as a scope', (repo) => {
  const r = runHook('no-gate-cmds.mjs', { tool_input: { command: 'ftest "tests/a.spec.ts"' } }, repo);
  return r.status === 0 ? null : `exit ${r.status}: a quoted path was not read as a scope`;
});

t('a runtime that is also the runner is denied only for its test subcommand', (repo) => {
  const config = JSON.parse(readFileSync(join(repo, '.spec-flow/config.json'), 'utf8'));
  config.unscoped_denied.tools = ['bun'];
  writeFileSync(join(repo, '.spec-flow/config.json'), JSON.stringify(config));
  const add = runHook('no-gate-cmds.mjs', { tool_input: { command: 'bun add zod' } }, repo);
  if (add.status !== 0) return `exit ${add.status}: \`bun add\` was denied as a whole-suite run`;
  const test = runHook('no-gate-cmds.mjs', { tool_input: { command: 'bun test' } }, repo);
  return test.status === 2 ? null : `exit ${test.status}: an unscoped \`bun test\` was allowed`;
});

t('no-gate-cmds is transparent outside implement', (repo) => {
  writeFileSync(join(repo, '.claude/state/phase'), 'idle');
  const r = runHook('no-gate-cmds.mjs', { tool_input: { command: 'npm run test' } }, repo);
  if (r.status !== 0) return `exit ${r.status}, expected 0 outside a run`;
  return null;
});

t('run-trace logs a source write', (repo) => {
  const r = runHook('run-trace.mjs', { tool_name: 'Write', tool_input: { file_path: 'example/thing.ts' } }, repo);
  if (r.status !== 0) return `exit ${r.status}: ${r.stderr}`;
  const log = join(repo, '.claude/state/run-trace.log');
  if (!existsSync(log)) return 'no run-trace.log written';
  if (!readFileSync(log, 'utf8').includes('write file=example/thing.ts')) return `log: ${readFileSync(log, 'utf8')}`;
  return null;
});

/** A SubagentStop payload, in the shape Claude Code 2.1.283 delivers it. */
const subagentStop = (extra = {}) => ({
  hook_event_name: 'SubagentStop',
  session_id: 'spawner-session',
  agent_id: 'a0123456789abcdef',
  agent_type: 'spec-flow:reviewer',
  ...extra,
});

const traceText = (repo) => {
  const log = join(repo, '.claude/state/run-trace.log');
  return existsSync(log) ? readFileSync(log, 'utf8') : '';
};

// ---- agent-gate: a return the orchestrator cannot route is sent back (ADR-031)
const blocked = (r) => {
  try {
    return JSON.parse(r.stdout).decision === 'block';
  } catch {
    return false;
  }
};
const gateReturn = (repo, extra) => runHook('agent-gate.mjs', subagentStop(extra), repo);

t('agent-gate sends back a first reply with no STATUS, and an undeclared status', (repo) => {
  for (const [reply, why] of [
    ['Looks fine to me.', 'no-status'],
    ['STATUS: SPEC_READY', 'undeclared-status'],
  ]) {
    const r = gateReturn(repo, { agent_id: `a-${why}`, last_assistant_message: reply });
    if (r.status !== 0 || !blocked(r)) return `"${reply}" was not sent back (exit ${r.status}): ${r.stdout}${r.stderr}`;
    if (!new RegExp(`agent-check agent=spec-flow:reviewer result=block why=${why} agent_id=a-${why}`).test(traceText(repo))) {
      return `no agent-check line for ${why}: ${traceText(repo)}`;
    }
  }
  return null;
}, { phase: 'review' });

// An empty reply is one this hook cannot read — a payload without the field,
// or an agent stopped from outside — so it passes, and says so.
t('agent-gate lets an empty reply through and records it', (repo) => {
  const r = gateReturn(repo, { last_assistant_message: '' });
  if (blocked(r)) return `an empty reply was sent back: ${r.stdout}`;
  return /result=skip why=empty/.test(traceText(repo)) ? null : `no skip line: ${traceText(repo)}`;
}, { phase: 'review' });

// /spec-flow step 4 resumes the implementer to "fix and report back only",
// and the fold spec-writer is resumed with a failure log: both answer in prose.
t('agent-gate lets a resumed agent answer in prose', (repo) => {
  writeFileSync(join(repo, '.claude/state/run-trace.log'), '2026-01-01T00:00:00Z phase=implement agent type=spec-flow:implementer status=IMPLEMENTED agent_id=impl1\n');
  const r = gateReturn(repo, { agent_type: 'spec-flow:implementer', agent_id: 'impl1', last_assistant_message: 'Fixed both lint violations in lib/a.ts.' });
  return blocked(r) ? `a resumed implementer's prose answer was sent back: ${r.stdout}` : null;
}, { phase: 'implement' });

t('agent-gate reads a status and a path the way a model decorates them', (repo) => {
  mkdirSync(join(repo, 'specflow', 'x'), { recursive: true });
  writeFileSync(join(repo, 'specflow', 'x', 'plan.md'), '# Plan\n');
  for (const [i, reply] of [
    '**STATUS:** PLAN_READY\n**PLAN_PATH:** specflow/x/plan.md',
    'STATUS: PLAN_READY\nPLAN_PATH: specflow/x/plan.md (index + 3 milestones)',
    'STATUS: PLAN_READY\nPLAN_PATH: [plan.md](specflow/x/plan.md)',
    'Round two; the last one ended with STATUS: NEEDS_INPUT.\n\nSTATUS: PLAN_READY\nPLAN_PATH: `specflow/x/plan.md`',
  ].entries()) {
    const r = gateReturn(repo, { agent_type: 'spec-flow:planner', agent_id: `p${i}`, last_assistant_message: reply });
    if (blocked(r)) return `a well-formed return was sent back: ${JSON.stringify(reply)} -> ${r.stdout}`;
  }
  return null;
}, { phase: 'plan' });

t('agent-gate sends back a path to a file that is not there, and passes one that is', (repo) => {
  const plan = { agent_type: 'spec-flow:planner', last_assistant_message: '```\nSTATUS: PLAN_READY\nPLAN_PATH: specflow/x/plan.md\n```' };
  const r = gateReturn(repo, plan);
  if (!blocked(r) || !/PLAN_PATH/.test(r.stdout)) return `a missing PLAN_PATH was not sent back: ${r.stdout}`;
  mkdirSync(join(repo, 'specflow', 'x'), { recursive: true });
  writeFileSync(join(repo, 'specflow', 'x', 'plan.md'), '# Plan\n');
  const ok = gateReturn(repo, { ...plan, agent_id: 'another-agent' });
  return blocked(ok) ? `an existing PLAN_PATH was sent back: ${ok.stdout}` : null;
}, { phase: 'plan' });

t('agent-gate passes a declared status and writes nothing', (repo) => {
  const r = gateReturn(repo, { last_assistant_message: 'STATUS: APPROVED\nNOTES: none' });
  if (r.status !== 0 || r.stdout) return `a declared status was not let through (exit ${r.status}): ${r.stdout}`;
  return /agent-check/.test(traceText(repo)) ? `a clean return left a line: ${traceText(repo)}` : null;
}, { phase: 'review' });

t('agent-gate sends an agent back at most twice, then lets it through and says so', (repo) => {
  for (const n of [1, 2]) {
    if (!blocked(gateReturn(repo, { last_assistant_message: 'no block' }))) return `block ${n} did not happen`;
  }
  const third = gateReturn(repo, { last_assistant_message: 'no block', stop_hook_active: true });
  if (blocked(third)) return 'a third stop was sent back: the cap is two';
  return /result=cap why=no-status/.test(traceText(repo)) ? null : `the cap left no line: ${traceText(repo)}`;
}, { phase: 'review' });

t('agent-gate with no agent id blocks only a first stop, and cannot tell a first reply from a resumed one', (repo) => {
  if (!blocked(gateReturn(repo, { agent_id: undefined, last_assistant_message: 'STATUS: SPEC_READY' }))) return 'a first stop was let through';
  if (blocked(gateReturn(repo, { agent_id: undefined, last_assistant_message: 'STATUS: SPEC_READY', stop_hook_active: true }))) {
    return 'a stop the hook already continued was sent back again, with nothing to count blocks by';
  }
  return blocked(gateReturn(repo, { agent_id: undefined, last_assistant_message: 'prose' })) ? 'prose with no agent id was judged as a first reply' : null;
}, { phase: 'review' });

// ADR-017 keeps the owner check to hooks certain to run in the sealing
// session; a SubagentStop's session id is the harness's to define.
t('agent-gate judges a return whatever session sealed the phase', (repo) => {
  writeFileSync(join(repo, '.claude/state/phase.session'), 'someone-else');
  return blocked(gateReturn(repo, { last_assistant_message: 'STATUS: SPEC_READY' })) ? null : 'the owner seal stood the agent gate down';
}, { phase: 'review' });

t('agent-gate leaves alone another plugin\'s agent, and a return outside a run', (repo) => {
  for (const agent_type of ['spec-writer', 'other:reviewer', 'spec-flow:nobody']) {
    if (blocked(gateReturn(repo, { agent_type, last_assistant_message: 'prose' }))) return `${agent_type} was judged against spec-flow's contracts`;
  }
  writeFileSync(join(repo, '.claude/state/phase'), 'idle');
  return blocked(gateReturn(repo, { last_assistant_message: 'prose' })) ? 'a return outside any run was sent back' : null;
}, { phase: 'review' });

t('agent-gate that crashes lets the return through', (repo) => {
  const engine = mkdtempSync(join(tmpdir(), 'spec-flow-engine-'));
  try {
    for (const dir of ['hooks', 'scripts', 'agents', 'modes']) cpSync(join(ENGINE, dir), join(engine, dir), { recursive: true });
    rmSync(join(engine, 'agents', 'reviewer.md'));
    mkdirSync(join(engine, 'agents', 'reviewer.md')); // reading it throws
    const r = runHook('agent-gate.mjs', subagentStop({ last_assistant_message: 'prose' }), repo, engine);
    if (!/hook error/.test(r.stderr)) return `the crash path was not reached: ${r.stderr}`;
    return r.status === 0 && !blocked(r) ? null : `a crash blocked the agent (exit ${r.status}): ${r.stdout}`;
  } finally {
    rmSync(engine, { recursive: true, force: true });
  }
}, { phase: 'review' });

// ---- agent-gate: what a spec-writer hands back (ADR-030) ------------------
const writerSpec = (deltas) => `# Spec — my-change: x\n\n## Requirement deltas\n${deltas}\n\n## Assumptions\n- none\n\n## Out of scope\n- nothing\n`;
const specReady = (extra = {}) => ({
  agent_type: 'spec-flow:spec-writer',
  agent_id: 'writer1',
  last_assistant_message: '```\nSTATUS: SPEC_READY\nSPEC_PATH: specflow/my-change/spec.md\nPROPOSAL_PATH: specflow/my-change/proposal.md\nSUMMARY: x\n```',
  ...extra,
});
/** specs/ with its contract and one capability, and the change's two files. */
function writerRepo(repo, deltas = '- ADDED REQ-USER-002 — another thing') {
  mkdirSync(join(repo, 'specs'), { recursive: true });
  writeFileSync(join(repo, 'specs', 'README.md'), '# specs\n');
  writeFileSync(join(repo, 'specs', 'user.md'), '<!-- spec-scope: lib/user -->\n### REQ-USER-001 — a thing\n');
  writeChange(repo, writerSpec(deltas));
}
const readBy = (repo, agentId, ...files) =>
  writeFileSync(
    join(repo, '.claude/state/run-trace.log'),
    files.map((f) => `2026-01-01T00:00:00Z phase=spec session=spawner-session read file=${join(repo, f)} agent_id=${agentId}\n`).join(''),
  );

t('agent-gate holds a NEEDS_INPUT round to one to three questions, options not counted', (repo) => {
  const ask = (items) => gateReturn(repo, { agent_type: 'spec-flow:spec-writer', agent_id: `w${items.length}`, last_assistant_message: `STATUS: NEEDS_INPUT\nOPEN_QUESTIONS:\n${items.join('\n')}` });
  const four = ask(['- a?', '- b?', '- c?', '- d?']);
  if (!blocked(four) || !/at most 3/.test(four.stdout)) return `four questions were let through: ${four.stdout}`;
  if (!blocked(ask([]))) return 'a NEEDS_INPUT with no question was let through';
  const three = ask(['- a?', '  - (1) this', '  - (2) that', '- b?', '- c?']);
  return blocked(three) ? `three questions with options were sent back: ${three.stdout}` : null;
}, { phase: 'spec' });

t('agent-gate sends back a SPEC_READY whose spec phase-guard would not let leave spec', (repo) => {
  writerRepo(repo);
  writeChange(repo, writerSpec('- ADDED REQ-USER-002 — x').replace('## Assumptions\n- none\n\n', ''));
  readBy(repo, 'writer1', 'specs/README.md', 'specs/user.md');
  const r = gateReturn(repo, specReady());
  return blocked(r) && /## Assumptions/.test(r.stdout) ? null : `a spec with no Assumptions was let through: ${r.stdout}`;
}, { phase: 'spec' });

t('agent-gate sends back a CHANGED or REMOVED on an id specs/ never declared', (repo) => {
  writerRepo(repo, '- CHANGED REQ-USER-009 (wording) — clearer\n- REMOVED REQ-USER-001 — gone');
  readBy(repo, 'writer1', 'specs/README.md', 'specs/user.md');
  const r = gateReturn(repo, specReady());
  if (!blocked(r) || !/CHANGED REQ-USER-009/.test(r.stdout)) return `an unknown CHANGED id was let through: ${r.stdout}`;
  return /REMOVED REQ-USER-001/.test(r.stdout) ? `a declared REMOVED id was reported: ${r.stdout}` : null;
}, { phase: 'spec' });

t('agent-gate sends back a SPEC_READY written without reading the capability its deltas touch', (repo) => {
  writerRepo(repo);
  readBy(repo, 'writer1', 'specs/README.md');
  const r = gateReturn(repo, specReady());
  if (!blocked(r) || !/specs\/user\.md/.test(r.stdout) || /README/.test(r.stdout)) return `the unread capability was not the one named: ${r.stdout}`;
  readBy(repo, 'writer1', 'specs/README.md', 'specs/user.md');
  const ok = gateReturn(repo, specReady({ agent_id: 'writer1' }));
  return blocked(ok) ? `a spec-writer that read both was sent back: ${ok.stdout}` : null;
}, { phase: 'spec' });

// token-trace takes agent ids from transcript file names, not from tool
// payloads, so its lines say nothing about whether a read was attributed.
t('agent-gate does not take a token line as proof that reads are attributed', (repo) => {
  writerRepo(repo);
  writeFileSync(
    join(repo, '.claude/state/run-trace.log'),
    `2026-01-01T00:00:00Z phase=spec read file=${join(repo, 'specs/user.md')}\n` +
      '2026-01-01T00:00:01Z phase=spec tokens model=m sidechain=true in=1 out=1 cache_read=0 cache_write=0 think=0 msgs=1 max_prompt=2 agent_id=writer1\n',
  );
  const r = gateReturn(repo, specReady());
  return blocked(r) ? `reads with no agent id were judged: ${r.stdout}` : null;
}, { phase: 'spec' });

t('agent-gate does not demand a read of another capability for a new one', (repo) => {
  writerRepo(repo, '- ADDED REQ-USER-PROFILE-001 — a profile');
  readBy(repo, 'writer1', 'specs/README.md');
  const r = gateReturn(repo, specReady());
  return blocked(r) ? `specs/user.md was demanded for REQ-USER-PROFILE-001: ${r.stdout}` : null;
}, { phase: 'spec' });

t('agent-gate lets a case 5 brief through: it is rejected, not built', (repo) => {
  writerRepo(repo);
  writeChange(repo, '# Fix — my-change\n\n## Case\n5 NOT-A-FIX\n\n## Requirement deltas\n- CHANGED REQ-USER-001 — would stop cascading\n', { proposal: false });
  const r = gateReturn(repo, { agent_type: 'spec-flow:spec-writer', last_assistant_message: 'STATUS: TRIAGED\nCASE: 5 NOT-A-FIX\nSPEC_PATH: specflow/my-change/spec.md' });
  return blocked(r) ? `a case 5 brief was held to "ready to build": ${r.stdout}` : null;
}, { phase: 'spec' });

t('agent-gate does not judge reads it cannot attribute, and says so', (repo) => {
  writerRepo(repo);
  writeFileSync(join(repo, '.claude/state/run-trace.log'), `2026-01-01T00:00:00Z phase=spec read file=${join(repo, 'specs/README.md')}\n`);
  const r = gateReturn(repo, specReady());
  if (blocked(r)) return `unattributed reads were judged: ${r.stdout}`;
  return /agent-check agent=spec-flow:spec-writer result=skip why=unattributed/.test(traceText(repo)) ? null : `no skip line: ${traceText(repo)}`;
}, { phase: 'spec' });

/** A fix brief and the work order its triage writes (ADR-033). */
function writeFix(repo, { workOrder = true } = {}) {
  writeChange(repo, '# Fix — my-change\n\n## Case\n3 SPEC-WRONG\n\n## Requirement deltas\n- CHANGED REQ-USER-001 (correction) — now right\n', { proposal: false });
  if (!workOrder) return;
  mkdirSync(join(repo, 'specflow', 'my-change', 'milestones'), { recursive: true });
  writeFileSync(join(repo, 'specflow', 'my-change', 'plan.md'), '# Plan — my-change\n');
  writeFileSync(join(repo, 'specflow', 'my-change', 'milestones', 'M1.md'), '# M1\n- Skills: none\n');
}
const TRIAGED = 'STATUS: TRIAGED\nCASE: 3\nSPEC_PATH: specflow/my-change/spec.md';
const WORK_ORDER = '\nPLAN_PATH: specflow/my-change/plan.md\nWORK_ORDER_PATH: specflow/my-change/milestones/M1.md';

t('agent-gate lets a ready fix brief through without the reads or the assumptions a change spec owes', (repo) => {
  writerRepo(repo);
  writeFix(repo);
  readBy(repo, 'someone-else', 'specs/README.md');
  const r = gateReturn(repo, { agent_type: 'spec-flow:spec-writer', last_assistant_message: TRIAGED + WORK_ORDER });
  return blocked(r) ? `a ready fix brief was sent back: ${r.stdout}` : null;
}, { phase: 'spec' });

// The orchestrator writing the work order read the code the triage had just
// read, and carried it for the rest of the run (ADR-033).
t('agent-gate sends back a triage of case 1 to 4 that names no work order', (repo) => {
  writerRepo(repo);
  writeFix(repo);
  const r = gateReturn(repo, { agent_type: 'spec-flow:spec-writer', last_assistant_message: TRIAGED });
  if (!blocked(r)) return 'a triage with no work order went through: the orchestrator would write it, reading the code again';
  return /PLAN_PATH/.test(r.stdout) && /WORK_ORDER_PATH/.test(r.stdout) ? null : `the reason does not name both lines: ${r.stdout}`;
}, { phase: 'spec' });

t('agent-gate sends back a triage naming a work order that is not on disk', (repo) => {
  writerRepo(repo);
  writeFix(repo, { workOrder: false });
  const r = gateReturn(repo, { agent_type: 'spec-flow:spec-writer', last_assistant_message: TRIAGED + WORK_ORDER });
  return blocked(r) ? null : 'a triage naming files it never wrote went through';
}, { phase: 'spec' });

t('run-trace logs a subagent STATUS', (repo) => {
  const r = runHook('run-trace.mjs', subagentStop({ last_assistant_message: 'STATUS: APPROVED' }), repo);
  if (r.status !== 0) return `exit ${r.status}: ${r.stderr}`;
  if (!traceText(repo).includes('agent type=spec-flow:reviewer status=APPROVED')) return `log: ${traceText(repo)}`;
  return null;
});

t('run-trace takes no status from a spawn — its response echoes the prompt ahead of the report', (repo) => {
  // The orchestrator's prompts name the statuses they expect back, so the
  // first STATUS in either response shape is the question, not the answer.
  const prompt = 'If anything is ambiguous, return STATUS: NEEDS_INPUT.';
  for (const tool_response of [
    { isAsync: true, status: 'async_launched', agentId: 'a0123456789abcdef', prompt },
    { status: 'completed', prompt, agentId: 'a0123456789abcdef', content: [{ type: 'text', text: 'STATUS: SPEC_READY' }] },
  ]) {
    const r = runHook('run-trace.mjs', { tool_name: 'Agent', tool_input: { subagent_type: 'spec-flow:spec-writer', prompt }, tool_response }, repo);
    if (r.status !== 0) return `exit ${r.status}: ${r.stderr}`;
  }
  if (/agent type=/.test(traceText(repo))) return `a spawn's tool response was recorded as the agent's return: ${traceText(repo)}`;
  return null;
});

t('run-trace reads a report handed back through SubagentHandback, not the line after it', (repo) => {
  const transcript = join(repo, 'agent-a0123456789abcdef.jsonl');
  const entries = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'SubagentHandback', input: { message: 'STATUS: SPEC_READY\nSPEC_PATH: specflow/x/spec.md' } }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Report delivered to the orchestrator via SubagentHandback.' }] } },
  ];
  writeFileSync(transcript, entries.map((e) => `${JSON.stringify(e)}\n`).join(''));
  const r = runHook(
    'run-trace.mjs',
    subagentStop({ agent_type: 'spec-flow:spec-writer', last_assistant_message: entries[1].message.content[0].text, agent_transcript_path: transcript }),
    repo,
  );
  if (r.status !== 0) return `exit ${r.status}: ${r.stderr}`;
  if (!traceText(repo).includes('agent type=spec-flow:spec-writer status=SPEC_READY')) {
    return `the report the caller received was not recorded: ${traceText(repo) || '(no trace)'}`;
  }
  return null;
});

t('run-trace writes one line per agent — a resumed session stops again under the same id', (repo) => {
  runHook('run-trace.mjs', subagentStop({ last_assistant_message: 'STATUS: CHANGES_REQUESTED' }), repo);
  runHook('run-trace.mjs', subagentStop({ last_assistant_message: 'STATUS: APPROVED' }), repo);
  const lines = traceText(repo).split('\n').filter((l) => l.includes('agent type='));
  if (lines.length !== 1) return `${lines.length} line(s) for one agent; specflow-stats counts each as a fresh spawn:\n${lines.join('\n')}`;
  if (!lines[0].includes('status=CHANGES_REQUESTED')) return `the line kept is not the first return: ${lines[0]}`;
  return null;
});

t('run-trace records the shape of a return that carries no STATUS', (repo) => {
  const r = runHook('run-trace.mjs', subagentStop({ last_assistant_message: 'all done' }), repo);
  if (r.status !== 0) return `exit ${r.status}: ${r.stderr}`;
  if (/agent type=/.test(traceText(repo))) return `a line was written with no status to put on it: ${traceText(repo)}`;
  const miss = join(repo, '.claude/state/run-trace-unmatched.log');
  if (!existsSync(miss)) return 'a return the trace could not read left no record of its shape';
  return null;
});

t('run-trace records a reported skill-routing miss', (repo) => {
  // The one observable this flow produces that had nowhere to go: reported as
  // prose in NOTES it reaches the orchestrator and vanishes. Recorded here it
  // survives into the archived telemetry, which is what makes "does the
  // planner's routing miss often?" answerable at all.
  const r = runHook(
    'run-trace.mjs',
    subagentStop({ agent_type: 'spec-flow:implementer', last_assistant_message: 'STATUS: IMPLEMENTED\nSKILL_MISS: where does it live\nNOTES: fine' }),
    repo,
  );
  if (r.status !== 0) return `exit ${r.status}: ${r.stderr}`;
  const line = traceText(repo);
  if (!/skill_miss=where-does-it-live/.test(line)) {
    return `the miss did not reach the trace, so no number of runs can answer whether routing misses: ${line}`;
  }
  if (!/status=IMPLEMENTED/.test(line)) return `the status field was lost: ${line}`;
  return null;
});

t('run-trace writes no skill_miss field when none was reported', (repo) => {
  const r = runHook('run-trace.mjs', subagentStop({ agent_type: 'spec-flow:implementer', last_assistant_message: 'STATUS: IMPLEMENTED' }), repo);
  if (r.status !== 0) return `exit ${r.status}`;
  const line = traceText(repo);
  if (/skill_miss/.test(line)) return `an empty field was written, which reads as a miss of nothing: ${line}`;
  return null;
});

t('run-trace logs a read path', (repo) => {
  const r = runHook('run-trace.mjs', { tool_name: 'Read', tool_input: { file_path: 'specs/user.md' } }, repo);
  if (r.status !== 0) return `exit ${r.status}`;
  const log = readFileSync(join(repo, '.claude/state/run-trace.log'), 'utf8');
  if (!log.includes('read file=specs/user.md')) return `log: ${log}`;
  return null;
});

t('run-trace records which session read a file', (repo) => {
  // Without this field a path read twice inside one milestone is one
  // observation with two opposite readings — one session re-reading its own
  // context, or a second session paying the cold start the flow's
  // session-reuse rule exists to avoid.
  const r = runHook(
    'run-trace.mjs',
    { session_id: 'abc123def456', tool_name: 'Read', tool_input: { file_path: 'specs/user.md' } },
    repo,
  );
  if (r.status !== 0) return `exit ${r.status}: ${r.stderr}`;
  const log = readFileSync(join(repo, '.claude/state/run-trace.log'), 'utf8');
  if (!/session=abc123def456/.test(log)) return `the read was recorded with no session to attribute it to: ${log}`;
  if (!log.includes('read file=specs/user.md')) return `the path was lost: ${log}`;
  return null;
});

t('run-trace writes no session field when the payload names none', (repo) => {
  // Absent, not empty. An empty field reads as one session downstream, which
  // turns an unanswered question into a measurement of zero.
  const r = runHook('run-trace.mjs', { tool_name: 'Read', tool_input: { file_path: 'specs/user.md' } }, repo);
  if (r.status !== 0) return `exit ${r.status}`;
  const log = readFileSync(join(repo, '.claude/state/run-trace.log'), 'utf8');
  if (/session=/.test(log)) return `a session field was written over a payload that named none: ${log}`;
  return null;
});

// A tool call inside a subagent carries the PARENT's session id and the
// agent's own agent_id (Claude Code 2.1.294).
t('run-trace attributes a read made inside a subagent to that agent', (repo) => {
  runHook(
    'run-trace.mjs',
    { session_id: 'spawner-session', agent_id: 'a0123456789abcdef', agent_type: 'spec-flow:spec-writer', tool_name: 'Read', tool_input: { file_path: 'specs/user.md' } },
    repo,
  );
  return /read file=specs\/user\.md agent_id=a0123456789abcdef/.test(traceText(repo)) ? null : `the read names no agent: ${traceText(repo)}`;
});

t('an agent whose reads carry its id still gets its return line', (repo) => {
  runHook('run-trace.mjs', { ...subagentStop(), hook_event_name: undefined, tool_name: 'Read', tool_input: { file_path: 'specs/user.md' } }, repo);
  runHook('run-trace.mjs', subagentStop({ last_assistant_message: 'STATUS: APPROVED' }), repo);
  return /agent type=spec-flow:reviewer status=APPROVED/.test(traceText(repo)) ? null : `the agent's own read suppressed its return: ${traceText(repo)}`;
});

t('a read in the main session names no agent', (repo) => {
  runHook('run-trace.mjs', { session_id: 'main', tool_name: 'Read', tool_input: { file_path: 'specs/user.md' } }, repo);
  return /agent_id=/.test(traceText(repo)) ? `a main-session read was charged to an agent: ${traceText(repo)}` : null;
});

t('run-trace records the effort an agent ran at on its return line', (repo) => {
  runHook('run-trace.mjs', subagentStop({ last_assistant_message: 'STATUS: APPROVED', effort: { level: 'low' } }), repo);
  return /status=APPROVED effort=low agent_id=/.test(traceText(repo)) ? null : `no effort on the return line: ${traceText(repo)}`;
});

/** A Bash call that exited non-zero, in the shape Claude Code 2.1.294 delivers it: no tool_response. */
const bashFailure = (command, error, extra = {}) => ({
  hook_event_name: 'PostToolUseFailure',
  tool_name: 'Bash',
  tool_input: { command },
  error,
  is_interrupt: false,
  ...extra,
});

t('run-trace logs a failing scoped test run as red', (repo) => {
  // The red run test-first asks for exits non-zero, and a non-zero exit never
  // reaches PostToolUse. Read only from there, the trace saw no red run at all.
  const r = runHook('run-trace.mjs', bashFailure('npx ftest run tests/a.spec.ts', 'Exit code 1\nexpected 3, got undefined'), repo);
  if (r.status !== 0) return `exit ${r.status}: ${r.stderr}`;
  const log = traceText(repo);
  return /test verdict=red target=tests\/a\.spec\.ts/.test(log) ? null : `a failing test run was not recorded as red: ${log || '(nothing traced)'}`;
});

t('run-trace does not call an interrupted test run red', (repo) => {
  runHook('run-trace.mjs', bashFailure('npx ftest run tests/a.spec.ts', 'Interrupted', { is_interrupt: true }), repo);
  const log = traceText(repo);
  return /test verdict=\? target=tests\/a\.spec\.ts/.test(log) ? null : `an interrupted run was given a verdict: ${log || '(nothing traced)'}`;
});

// A red verdict credits a requirement with test-first, so a failure is red
// only when the runner itself failed on a path. Each case below was traced
// red, and counted as red-first, before that rule.
const verdictOf = (repo) => /test verdict=(\S+)/.exec(traceText(repo))?.[1] ?? '(nothing traced)';

t('a failing command that only names the runner is not a red run', (repo) => {
  runHook('run-trace.mjs', bashFailure('grep -n ftest package.json', 'Exit code 1'), repo);
  return verdictOf(repo) === 'red' ? `grep was traced as a failing test run: ${traceText(repo)}` : null;
});

t('a runner the shell could not find is not a red run', (repo) => {
  runHook('run-trace.mjs', bashFailure('ftest tests/a.spec.ts', 'Exit code 127\nbash: line 1: ftest: command not found'), repo);
  return verdictOf(repo) === '?' ? null : `want ?, got ${verdictOf(repo)}`;
});

t('a failing run that found no test file is none, in vitest and node wording', (repo) => {
  runHook('run-trace.mjs', bashFailure('npx ftest run tests/typo.spec.ts', 'Exit code 1\nNo test files found, exiting with code 1'), repo);
  runHook('run-trace.mjs', bashFailure('npx ftest run tests/typo.spec.ts', "Exit code 1\nCould not find '/x/tests/typo.spec.ts'"), repo);
  const verdicts = [...traceText(repo).matchAll(/test verdict=(\S+)/g)].map((m) => m[1]);
  return verdicts.join(',') === 'none,none' ? null : `want none,none, got ${verdicts.join(',') || '(nothing traced)'}`;
});

t('a failing run whose own summary says every test passed is not red', (repo) => {
  runHook(
    'run-trace.mjs',
    bashFailure('npx ftest run tests/a.spec.ts', 'Exit code 1\n      Tests  3 passed (3)\nERROR: Coverage for lines (12%) does not meet global threshold (80%)'),
    repo,
  );
  return verdictOf(repo) === '?' ? null : `want ?, got ${verdictOf(repo)}`;
});

// What jest prints for a test written ahead of its module — the first red of
// test-first in a TypeScript repo. No test ran, so `Tests:` says nothing failed;
// only the exit status and `Test Suites:` do. Taken from a real run.
const JEST_SUITE_FAILED = [
  'FAIL tests/a.spec.ts',
  '  ● Test suite failed to run',
  '',
  "    tests/a.spec.ts:1:20 - error TS2307: Cannot find module './a' or its corresponding type declarations.",
  '',
  'Test Suites: 1 failed, 1 total',
  'Tests:       0 total',
  'Snapshots:   0 total',
].join('\n');

t('a runner launched as `node <its script>` that fails on a path is a red run', (repo) => {
  runHook('run-trace.mjs', bashFailure('node --experimental-vm-modules node_modules/ftest/bin/ftest.js tests/a.spec.ts', 'Exit code 1\nexpected 3, got undefined'), repo);
  return verdictOf(repo) === 'red' ? null : `want red, got ${verdictOf(repo)}: ${traceText(repo)}`;
});

t('a suite that failed to run is red even when a pipe hid the exit status', (repo) => {
  runHook(
    'run-trace.mjs',
    { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npx ftest tests/a.spec.ts 2>&1 | tail -20' }, tool_response: { stdout: JEST_SUITE_FAILED, stderr: '' } },
    repo,
  );
  return verdictOf(repo) === 'red' ? null : `want red, got ${verdictOf(repo)}: ${traceText(repo)}`;
});

// The coupling the two cases above stand in for: `init` writes the runner as
// `node <entrypoint>`, the implementer runs what the contract names, and this
// hook has to recognise it. Checked against what init actually writes.
t('the test argv init writes, run on a path and failing, is a red run', (repo) => {
  const entry = join(repo, 'node_modules', 'jest', 'bin', 'jest.js');
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, 'process.exit(0);\n');
  mkdirSync(join(repo, 'node_modules', '.bin'), { recursive: true });
  const shim = join(repo, 'node_modules', '.bin', 'jest');
  // npm's two bin layouts — see resolveLocalBin.
  if (process.platform === 'win32') writeFileSync(shim, '#!/bin/sh\nexec node "$basedir/../jest/bin/jest.js" "$@"\n');
  else symlinkSync(join('..', 'jest', 'bin', 'jest.js'), shim);
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
  const smokeContract = readFileSync(join(repo, '.spec-flow/config.json'), 'utf8');

  const init = spawnSync('node', [join(ENGINE, 'scripts', 'init.mjs'), '--force'], { cwd: repo, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: repo } });
  const written = JSON.parse(readFileSync(join(repo, '.spec-flow/config.json'), 'utf8')).verify;
  if (written.test_name !== 'jest' || written.test[0] !== 'node') {
    return `init did not write jest as \`node <entrypoint>\` — this case tests nothing: ${JSON.stringify(written)} ${init.stderr}`;
  }
  // Only the runner from init's contract: the rest of it is not this case's subject.
  const contract = JSON.parse(smokeContract);
  contract.verify.test = written.test;
  contract.verify.test_name = written.test_name;
  writeFileSync(join(repo, '.spec-flow/config.json'), JSON.stringify(contract));

  runHook('run-trace.mjs', bashFailure(`${written.test.join(' ')} tests/a.spec.ts`, `Exit code 1\n${JEST_SUITE_FAILED}`), repo);
  return verdictOf(repo) === 'red' ? null : `want red for \`${written.test.join(' ')} tests/a.spec.ts\`, got ${verdictOf(repo)}: ${traceText(repo)}`;
});

t('node running a script that is not the runner is not a red run', (repo) => {
  runHook('run-trace.mjs', bashFailure('node scripts/build.mjs --then ftest tests/a.spec.ts', 'Exit code 1\nbuild failed'), repo);
  return verdictOf(repo) === 'red' ? `a build script was traced as a failing test run: ${traceText(repo)}` : null;
});

// A `?` is what this hook was not given, and it says which: stats reports it
// as that instead of as a run that never happened.
t('a run the hook cannot judge says why', (repo) => {
  runHook('run-trace.mjs', bashFailure('npx ftest run tests/a.spec.ts', 'Interrupted', { is_interrupt: true }), repo);
  runHook('run-trace.mjs', bashFailure('ftest tests/a.spec.ts', 'Exit code 127\nbash: line 1: ftest: command not found'), repo);
  runHook(
    'run-trace.mjs',
    { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npx ftest tests/a.spec.ts | tail -5' }, tool_response: { stdout: 'some output', stderr: '' } },
    repo,
  );
  runHook('run-trace.mjs', bashFailure('grep -rn ftest tests/a.spec.ts', 'Exit code 1'), repo);
  const whys = [...traceText(repo).matchAll(/test verdict=\? \S+ why=(\S+)/g)].map((m) => m[1]);
  return whys.join(',') === 'interrupted,not-found,pipe,not-the-runner' ? null : `want interrupted,not-found,pipe,not-the-runner, got ${whys.join(',') || '(none)'}: ${traceText(repo)}`;
});

t('hooks.json registers run-trace for a failing Bash call', () => {
  const manifest = JSON.parse(readFileSync(join(ENGINE, 'hooks', 'hooks.json'), 'utf8'));
  const entries = manifest.hooks?.PostToolUseFailure ?? [];
  const wired = entries.some(
    (e) => /(^|\|)Bash(\||$)/.test(e.matcher ?? '') && (e.hooks ?? []).some((h) => (h.args ?? []).some((a) => a.endsWith('/hooks/run-trace.mjs'))),
  );
  return wired ? null : 'no PostToolUseFailure entry runs run-trace on Bash — a red test run is never traced';
});

t('run-trace is silent outside a run', (repo) => {
  writeFileSync(join(repo, '.claude/state/phase'), 'idle');
  const r = runHook('run-trace.mjs', { tool_name: 'Write', tool_input: { file_path: 'example/thing.ts' } }, repo);
  if (r.status !== 0) return `exit ${r.status}`;
  if (existsSync(join(repo, '.claude/state/run-trace.log'))) return 'traced while idle';
  return null;
});

t('session-start resets a stale phase', (repo) => {
  const pf = join(repo, '.claude/state/phase');
  writeFileSync(pf, 'implement');
  const old = new Date(Date.now() - 8 * 3600 * 1000);
  utimesSync(pf, old, old);
  const r = runHook('session-start.mjs', {}, repo);
  if (r.status !== 0) return `exit ${r.status}: ${r.stderr}`;
  const phase = readFileSync(pf, 'utf8');
  if (phase !== 'idle') return `phase is "${phase}", expected idle`;
  return null;
});

// ---- the engine refuses a Node it does not support, and only in a run ------
//
// The second case is the one worth having. A version check is easy to write in
// the wrong place, and ahead of the phase guard this hook would deny subagents
// in repositories that never adopted this engine, over a floor only this
// engine declares. It was written in the wrong place first.
t('preflight stands down on an unsupported Node when no run is in progress', (repo) => {
  const engine = engineDeclaring(9999);
  try {
    writeFileSync(join(repo, '.claude/state/phase'), 'idle');
    const r = runHook('preflight.mjs', { tool_name: 'Agent', tool_input: { subagent_type: 'implementer' } }, repo, engine);
    if (r.status !== 0) return `an agent unrelated to any run was denied over this engine's Node floor: ${r.stderr}`;
    return null;
  } finally {
    rmSync(engine, { recursive: true, force: true });
  }
});

t('preflight denies a run on a Node below the declared floor', (repo) => {
  const engine = engineDeclaring(9999);
  try {
    writeFileSync(join(repo, '.claude/state/phase'), 'plan');
    const r = runHook('preflight.mjs', { tool_name: 'Agent', tool_input: { subagent_type: 'planner' } }, repo, engine);
    if (r.status !== 2) return `expected the PreToolUse denial (exit 2), got ${r.status}: ${r.stderr}`;
    if (!/Node 9999/.test(r.stderr)) return `the denial did not name the floor it wants: ${r.stderr}`;
    return null;
  } finally {
    rmSync(engine, { recursive: true, force: true });
  }
});

// ---- the position a resume needs survives, and a reset reports it ----------
//
// The two facts that made a run resumable lived only in the orchestrator's
// context. These assert they now live on disk, and — the half that is easy to
// get wrong — that disarming a stale run does not also erase where it was.
t('register-agent records the milestone and session an implementer was given', (repo) => {
  writeFileSync(join(repo, '.claude/state/phase'), 'implement');
  const r = runHook(
    'register-agent.mjs',
    {
      tool_name: 'Agent',
      tool_input: { subagent_type: 'implementer', prompt: 'implement specflow/add-users/milestones/M2.md per the plan' },
      tool_response: { session_id: 'abc123def4567890a' },
    },
    repo,
  );
  if (r.status !== 0) return `exit ${r.status}: ${r.stderr}`;
  const at = join(repo, '.claude/state/current-milestone');
  if (!existsSync(at)) return 'nothing recorded — a crash here still loses which milestone was in flight';
  const got = readFileSync(at, 'utf8').trim();
  if (got !== 'add-users M2 abc123def4567890a') return `recorded "${got}"`;
  return null;
});

t('a stale-phase reset disarms the run without forgetting where it was', (repo) => {
  const pf = join(repo, '.claude/state/phase');
  writeFileSync(pf, 'implement');
  writeFileSync(join(repo, '.claude/state/current-milestone'), 'add-users M2 abc123def4567890a');
  const old = new Date(Date.now() - 8 * 3600 * 1000);
  utimesSync(pf, old, old);

  const r = runHook('session-start.mjs', {}, repo);
  if (r.status !== 0) return `exit ${r.status}: ${r.stderr}`;
  if (readFileSync(pf, 'utf8') !== 'idle') return 'the stale phase was not disarmed';
  if (!existsSync(join(repo, '.claude/state/current-milestone'))) {
    return 'the reset erased the position too, so the run is still unresumable';
  }
  if (!/M2/.test(r.stdout) || !/add-users/.test(r.stdout)) {
    return `the message did not say where the run stopped, which is the whole point: ${r.stdout}`;
  }
  if (/re-run \/spec-flow/.test(r.stdout)) {
    return `it still tells the user to start over though it knows where the run was: ${r.stdout}`;
  }
  if (!/\/spec-flow:resume/.test(r.stdout)) return `it does not name the command that picks the run up (ADR-024): ${r.stdout}`;
  return null;
});

t('session-start leaves a fresh phase alone', (repo) => {
  const r = runHook('session-start.mjs', {}, repo);
  if (r.status !== 0) return `exit ${r.status}`;
  const phase = readFileSync(join(repo, '.claude/state/phase'), 'utf8');
  if (phase !== 'implement') return `phase is "${phase}", expected implement (untouched)`;
  return null;
});

// ---- the closed set, enforced rather than described ----
//
// The phase vocabulary was written into four documents and checked by
// nothing. Every hook falls through to "not my business" on a value it does
// not recognise, so one invented phase stands down the gate, the write-time
// linter, the command deny, preflight and the Opus budget at once — silently.
// ---- a run that cannot run here does not start (ADR-028) --------------------
//
// The phase write is the first thing a run does. Refused at the first spawn
// instead, it had already armed preflight, the budget, phase-guard and arm-gate
// on a `spec` nothing would reset for six hours — every later subagent spawn in
// that repository denied over a run the human never got to start.
t(
  'phase-guard refuses the write that starts a run where the engine cannot run, and leaves nothing armed',
  (repo) => {
    const r = runHook(
      'phase-guard.mjs',
      { session_id: 'session-a', tool_name: 'Write', tool_input: { file_path: join(repo, '.claude/state/phase'), content: 'spec' } },
      repo,
    );
    if (r.status !== 2) return `a run was started in a repository with no contract — exit ${r.status}; preflight will deny every spawn here until session-start resets the phase`;
    if (!/Nothing has started/.test(r.stderr)) return `the denial does not say that nothing is armed: ${r.stderr}`;
    if (existsSync(join(repo, '.claude/state/phase.session'))) return 'a refused start sealed the phase to the session anyway';
    return null;
  },
  { withContract: false, phase: '' },
);

// The other half of the rule: a repository that can run the engine enters a
// run on its first write, sealed to the session that wrote it (ADR-017). The
// seal is what lets the gate tell this run's stops from another session's, so
// a start that skips it is a run no gate owns.
t(
  'phase-guard lets a run start in a repository the engine can run in, and seals it',
  (repo) => {
    const r = runHook(
      'phase-guard.mjs',
      { session_id: 'session-a', tool_name: 'Write', tool_input: { file_path: join(repo, '.claude/state/phase'), content: 'spec' } },
      repo,
    );
    if (r.status !== 0) return `a valid repository was refused a run — exit ${r.status}: ${r.stderr}`;
    const seal = join(repo, '.claude/state/phase.session');
    if (!existsSync(seal) || readFileSync(seal, 'utf8') !== 'session-a') return 'the start of a run was not sealed to the session that wrote it';
    return null;
  },
  { phase: '' },
);

// `blocked` is in the vocabulary and arms every hook that reads the phase, so
// a tool writing it from `idle` is a run nobody started and no gate capped:
// preflight and the budget wake over it, and the next implementer spawn has
// arm-gate carry it to `implement`. The gate's alone means everywhere.
t(
  'phase-guard denies blocked outside a run too — it is the gate\'s alone',
  (repo) => {
    const r = runHook(
      'phase-guard.mjs',
      { tool_name: 'Write', tool_input: { file_path: join(repo, '.claude/state/phase'), content: 'blocked' } },
      repo,
    );
    if (r.status !== 2) return `a tool wrote blocked from idle (exit ${r.status}) — a run nobody started, armed as if the gate had capped it`;
    return null;
  },
  { withContract: false, phase: '' },
);

// The phase file has siblings — the seal, the unmatched log — and a write to
// one of them is not a phase write. Judged as one, the seal's session id is
// "not a phase this engine knows".
// ---- a change the base branch already has is not this run's (ADR-032) ------
//
// A plan committed on the base and never run sat in specflow/, the run on a
// branch off it was refused `done` at its very end, and the orchestrator moved
// the human's plan out of the way to get past the refusal. The start is where
// that run can still be declined for nothing.
const gitIn = (repo, ...args) => spawnSync('git', args, { cwd: repo, stdio: 'ignore' });
const changeFolder = (repo, slug) => {
  mkdirSync(join(repo, 'specflow', slug), { recursive: true });
  writeFileSync(join(repo, 'specflow', slug, 'spec.md'), `# Spec — ${slug}\n`);
  gitIn(repo, 'add', '-f', '--', `specflow/${slug}`);
  gitIn(repo, 'commit', '-q', '-m', `add ${slug}`);
};
/** A change folder committed on the base, then a branch off it. */
const parkedOnBase = (repo, slug = 'parked') => {
  changeFolder(repo, slug);
  gitIn(repo, 'checkout', '-q', '-b', 'feature');
};
const startRun = (repo) =>
  runHook('phase-guard.mjs', { session_id: 'session-a', tool_name: 'Write', tool_input: { file_path: join(repo, '.claude/state/phase'), content: 'spec' } }, repo);

t(
  'phase-guard refuses to start a run over a change the base branch already has',
  (repo) => {
    parkedOnBase(repo);
    const r = startRun(repo);
    if (r.status !== 2) return `a run started with specflow/parked/ inherited from the base — exit ${r.status}; its done would be refused after every milestone was spent`;
    if (!r.stderr.includes('specflow/parked/')) return `the refusal does not name the folder: ${r.stderr}`;
    if (r.stderr.includes('spec-flow init')) return `the refusal sends the human to init, which fixes nothing here: ${r.stderr}`;
    return null;
  },
  { phase: '' },
);

// The other half: the folder a run created on its own branch is the one
// `/spec-flow:resume` starts a run over again, after a stale reset.
t(
  'phase-guard lets a run start over a change this branch created — the one a resume picks up',
  (repo) => {
    gitIn(repo, 'checkout', '-q', '-b', 'feature');
    changeFolder(repo, 'mine');
    const r = startRun(repo);
    return r.status === 0 ? null : `a resume of this branch's own change was refused — exit ${r.status}: ${r.stderr}`;
  },
  { phase: '' },
);

t(
  'preflight refuses a spawn while a change the base branch has is live — the start it backstops',
  (repo) => {
    parkedOnBase(repo);
    const r = runHook('preflight.mjs', { tool_name: 'Agent', tool_input: { subagent_type: 'planner' } }, repo);
    if (r.status !== 2) return `a spawn went through with specflow/parked/ from the base live — exit ${r.status}`;
    return r.stderr.includes('a change the base branch already has') ? null : `the refusal is not headed with what failed: ${r.stderr}`;
  },
  { phase: 'plan' },
);

t("phase-guard's done refusal says a change the base branch has is not this run's to fold", (repo) => {
  parkedOnBase(repo);
  seedGateHistory(repo, 'pass');
  const r = runHook('phase-guard.mjs', { tool_name: 'Write', tool_input: { file_path: join(repo, '.claude/state/phase'), content: 'done' } }, repo);
  if (r.status !== 2) return `done was allowed over an unarchived change — exit ${r.status}`;
  return r.stderr.includes("parked (the base branch has it: not this run's change)") ? null : `the refusal does not say the folder is not this run's, so it routes it to a FOLD: ${r.stderr}`;
});

t('phase-guard leaves the phase file\'s siblings alone', (repo) => {
  const r = runHook(
    'phase-guard.mjs',
    { tool_name: 'Write', tool_input: { file_path: join(repo, '.claude/state/phase.session'), content: 'abc123def456' } },
    repo,
  );
  if (r.status !== 0) return `a write to phase.session was judged as a phase write — exit ${r.status}: ${r.stderr}`;
  return null;
});

// A start written in a form this hook cannot read goes through to preflight,
// which is the backstop ADR-028 names — and the blind-spot log is what says
// the guard was bypassed, so it has to be kept outside a run too.
t(
  'phase-guard records a start it could not read',
  (repo) => {
    runHook('phase-guard.mjs', { tool_name: 'Bash', tool_input: { command: "printf 'spec' | tee .claude/state/phase" } }, repo);
    const log = join(repo, '.claude', 'state', 'phase-guard-unmatched.log');
    if (!existsSync(log) || !readFileSync(log, 'utf8').includes('tee')) return 'an unreadable start left no line in phase-guard-unmatched.log, so nothing says the guard was bypassed';
    return null;
  },
  { withContract: false, phase: '' },
);

t('phase-guard denies a phase outside the closed set', (repo) => {
  const r = runHook(
    'phase-guard.mjs',
    { tool_name: 'Bash', tool_input: { command: "printf 'triage' > .claude/state/phase" } },
    repo,
  );
  if (r.status !== 2) {
    return `an invented phase was allowed (exit ${r.status}) — it would disarm every hook at once, silently`;
  }
  if (!/closed set/i.test(r.stderr)) return `the denial does not explain the vocabulary: ${r.stderr}`;
  return null;
});

t('phase-guard denies an invented phase written with Write, not just Bash', (repo) => {
  const r = runHook(
    'phase-guard.mjs',
    { tool_name: 'Write', tool_input: { file_path: join(repo, '.claude/state/phase'), content: 'verify' } },
    repo,
  );
  if (r.status !== 2) return `a Write of an unknown phase was allowed (exit ${r.status})`;
  return null;
});

t('phase-guard allows every phase the orchestrator writes mid-run', (repo) => {
  for (const value of ['spec', 'plan', 'review', 'implement']) {
    const r = runHook(
      'phase-guard.mjs',
      { tool_name: 'Bash', tool_input: { command: `printf '${value}' > .claude/state/phase` } },
      repo,
    );
    if (r.status !== 0) return `'${value}' is in the vocabulary and was denied (exit ${r.status}): ${r.stderr}`;
  }
  return null;
});

t('phase-guard does not deny a command that merely reads the phase file', (repo) => {
  // It denies, so it may only act on a value it can actually read. A guess
  // here blocks legitimate work to enforce a rule about a value nobody wrote.
  const r = runHook(
    'phase-guard.mjs',
    { tool_name: 'Bash', tool_input: { command: 'cat .claude/state/phase' } },
    repo,
  );
  if (r.status !== 0) return `reading the phase file was denied (exit ${r.status}): ${r.stderr}`;
  return null;
});

// The guard reads two forms and denies on what it reads, so everything else
// is ALLOWED — `tee`, `cp`, `sh -c`, a variable. That is the right call for a
// hook that denies, and it means the guard has a blind spot it cannot see
// into. Making the spot observable is the part that is available: `tee` still
// gets through, and now leaves a line saying so, the same way opus-budget and
// lint-on-write record what they let past.
t('phase-guard lets an unreadable write through and records that it did', (repo) => {
  const r = runHook(
    'phase-guard.mjs',
    { tool_name: 'Bash', tool_input: { command: "printf 'done' | tee .claude/state/phase" } },
    repo,
  );
  if (r.status !== 0) return `a form the guard cannot read was denied (exit ${r.status}): ${r.stderr}`;

  const log = join(repo, '.claude', 'state', 'phase-guard-unmatched.log');
  if (!existsSync(log)) return 'the write went through unread and left no trace that it had';
  const body = readFileSync(log, 'utf8');
  if (!/\btee\b/.test(body)) return `the log does not name what got past: ${JSON.stringify(body)}`;
  // The command's arguments are not the hook's to record — only the shape.
  if (/done/.test(body)) return `the log captured the command's content, not just its shape: ${JSON.stringify(body)}`;
  return null;
});

// Including the piped form: a pipe is only evidence of a write when the file
// is DOWNSTREAM of it. `cat <phase> | grep` reads, and a log that collects
// reads is one nobody opens — which would cost the line that matters above.
t('phase-guard does not record a command that only reads the phase file', (repo) => {
  for (const command of ['cat .claude/state/phase', 'cat .claude/state/phase | grep implement']) {
    runHook('phase-guard.mjs', { tool_name: 'Bash', tool_input: { command } }, repo);
  }
  const log = join(repo, '.claude', 'state', 'phase-guard-unmatched.log');
  const body = existsSync(log) ? readFileSync(log, 'utf8') : '';
  if (/\bcat\b/.test(body)) {
    return `a read was logged as an unreadable write; the log fills with reads and stops being worth opening: ${JSON.stringify(body)}`;
  }
  return null;
});

t('phase-guard denies done with an unarchived specflow folder', (repo) => {
  mkdirSync(join(repo, 'specflow', 'my-change'), { recursive: true });
  const r = runHook(
    'phase-guard.mjs',
    { tool_name: 'Bash', tool_input: { command: "printf 'done' > .claude/state/phase" } },
    repo,
  );
  if (r.status !== 2) return `exit ${r.status}, expected 2 (deny). stderr: ${r.stderr.slice(0, 300)}`;
  if (!r.stderr.includes('unarchived')) return `stderr: ${r.stderr.slice(0, 300)}`;
  return null;
});

t('phase-guard allows an earned done', (repo) => {
  seedGateHistory(repo, 'pass');
  const r = runHook(
    'phase-guard.mjs',
    { tool_name: 'Bash', tool_input: { command: "printf 'done' > .claude/state/phase" } },
    repo,
  );
  if (r.status !== 0) return `exit ${r.status}, expected 0. stderr: ${r.stderr.slice(0, 300)}`;
  return null;
});

// ---- a run does not end itself without a verdict (ADR-022) ---------------
//
// The gate arms only on `implement`, and the phase is written by the model it
// judges. These are the writes that END a run or stand it down looking
// legitimate; each is decided from evidence on disk, never from the value.

t('phase-guard denies done while the gate has not passed the current commit', (repo) => {
  seedGateHistory(repo, 'fail:behaviour');
  const r = runHook(
    'phase-guard.mjs',
    { tool_name: 'Bash', tool_input: { command: "printf 'done' > .claude/state/phase" } },
    repo,
  );
  if (r.status !== 2) {
    return `done was allowed over a commit whose last verdict was fail:behaviour (exit ${r.status}) — the run closes with its last milestone red`;
  }
  if (!/gate has not passed/.test(r.stderr)) return `the denial does not say what is missing: ${r.stderr.slice(0, 300)}`;
  return null;
});

t('phase-guard denies done when no gate ever judged the current commit', (repo) => {
  const r = runHook(
    'phase-guard.mjs',
    { tool_name: 'Write', tool_input: { file_path: '.claude/state/phase', content: 'done' } },
    repo,
  );
  if (r.status !== 2) return `done was allowed with no gate verdict at all (exit ${r.status})`;
  return null;
});

t('phase-guard denies idle mid-implement', (repo) => {
  seedGateHistory(repo, 'fail:behaviour');
  const r = runHook(
    'phase-guard.mjs',
    { tool_name: 'Bash', tool_input: { command: "printf 'idle' > .claude/state/phase" } },
    repo,
  );
  if (r.status !== 2) {
    return `idle was allowed from implement after a red gate (exit ${r.status}) — the next Stop passes silently and nothing records why`;
  }
  return null;
});

t('phase-guard denies idle over a change folder that was never recorded', (repo) => {
  mkdirSync(join(repo, 'specflow', 'my-change'), { recursive: true });
  const r = runHook(
    'phase-guard.mjs',
    { tool_name: 'Bash', tool_input: { command: "printf 'idle' > .claude/state/phase" } },
    repo,
  );
  if (r.status !== 2) return `idle was allowed with specflow/my-change/ still live (exit ${r.status})`;
  if (!/my-change/.test(r.stderr)) return `the denial does not name the folder: ${r.stderr.slice(0, 300)}`;
  return null;
}, { phase: 'spec' });

// Both protocol paths to `idle` — a spec rejected at sign-off, a /spec-fix
// case 5 — stamp and archive the change first. A guard, not proof of a
// defect: this passed before ADR-022 and must keep passing.
t('phase-guard allows idle once the rejection is archived', (repo) => {
  mkdirSync(join(repo, 'specflow', 'archive', 'my-change'), { recursive: true });
  const r = runHook(
    'phase-guard.mjs',
    { tool_name: 'Bash', tool_input: { command: "printf 'idle' > .claude/state/phase" } },
    repo,
  );
  if (r.status !== 0) return `the protocol's own rejection path was denied (exit ${r.status}): ${r.stderr.slice(0, 300)}`;
  return null;
}, { phase: 'spec' });

// `blocked` is reached only through the gate's cap, so a human is already in
// the loop. A guard, like the case above.
t('phase-guard allows idle from blocked', (repo) => {
  mkdirSync(join(repo, 'specflow', 'my-change'), { recursive: true });
  const r = runHook(
    'phase-guard.mjs',
    { tool_name: 'Bash', tool_input: { command: "printf 'idle' > .claude/state/phase" } },
    repo,
  );
  if (r.status !== 0) return `a human abandoning a blocked run was refused (exit ${r.status}): ${r.stderr.slice(0, 300)}`;
  return null;
}, { phase: 'blocked' });

// ---- leaving `spec` needs a spec its first gate would accept (ADR-030) ----
const SIGNED_SPEC = '# Spec — my-change: x\n\n## Requirement deltas\n- ADDED REQ-USER-001 — a thing\n\n## Assumptions\n- none\n\n## Out of scope\n- nothing\n';

function writeChange(repo, body, { proposal = true, slug = 'my-change' } = {}) {
  mkdirSync(join(repo, 'specflow', slug), { recursive: true });
  writeFileSync(join(repo, 'specflow', slug, 'spec.md'), body);
  if (proposal) writeFileSync(join(repo, 'specflow', slug, 'proposal.md'), '# Proposal — x\n');
}

const writePhase = (repo, value) =>
  runHook('phase-guard.mjs', { tool_name: 'Bash', tool_input: { command: `printf '${value}' > .claude/state/phase` } }, repo);

t('phase-guard denies plan from spec while the spec says nothing of what it assumed', (repo) => {
  writeChange(repo, SIGNED_SPEC.replace('## Assumptions\n- none\n\n', ''));
  const r = writePhase(repo, 'plan');
  if (r.status !== 2) return `plan was allowed over a spec with no Assumptions (exit ${r.status})`;
  if (!/my-change\/spec\.md has no `## Assumptions`/.test(r.stderr)) return `the denial does not name the spec and the section: ${r.stderr.slice(0, 300)}`;
  if (!/sign-off again/.test(r.stderr)) return `the denial does not send the change back to sign-off: ${r.stderr.slice(0, 400)}`;
  return null;
}, { phase: 'spec' });

t('phase-guard denies plan from spec over what spec-trace would reject at the first gate', (repo) => {
  writeChange(repo, SIGNED_SPEC.replace('## Out of scope', '## Decision\nchosen\n\n## Out of scope'), { proposal: false });
  const r = writePhase(repo, 'plan');
  if (r.status !== 2) return `plan was allowed over a spec carrying ## Decision with no proposal.md (exit ${r.status})`;
  if (!/## Decision/.test(r.stderr) || !/no proposal\.md/.test(r.stderr)) return `the denial misses one of the two problems: ${r.stderr.slice(0, 400)}`;
  return null;
}, { phase: 'spec' });

t('phase-guard denies implement from spec over a fix brief whose CHANGED says no kind', (repo) => {
  writeChange(repo, '# Fix — my-change\n\n## Case\n3 SPEC-WRONG\n\n## Requirement deltas\n- CHANGED REQ-USER-001 — now right\n', { proposal: false });
  const r = writePhase(repo, 'implement');
  if (r.status !== 2) return `implement was allowed over a CHANGED with no kind (exit ${r.status})`;
  return null;
}, { phase: 'spec' });

// The triage writes a fix's plan inside `spec` (ADR-033). Read as "already
// left spec", that plan would let the brief out unchecked.
t('phase-guard holds a fix brief to its spec-time checks even once its triage wrote the plan', (repo) => {
  writeChange(repo, '# Fix — my-change\n\n## Case\n3 SPEC-WRONG\n\n## Requirement deltas\n- CHANGED REQ-USER-001 — now right\n', { proposal: false });
  writeFileSync(join(repo, 'specflow', 'my-change', 'plan.md'), '# Plan — my-change\n');
  const r = writePhase(repo, 'implement');
  return r.status === 2 ? null : `implement was allowed over a fix brief with a CHANGED of no kind, because it had a plan (exit ${r.status})`;
}, { phase: 'spec' });

// Guards: these passed before the check existed and must keep passing.
t('phase-guard allows leaving spec with a signed-off spec, and a fix brief without assumptions', (repo) => {
  writeChange(repo, SIGNED_SPEC);
  writeChange(repo, '# Fix — a-fix\n\n## Case\n3 SPEC-WRONG\n\n## Requirement deltas\n- CHANGED REQ-USER-002 (correction) — now right\n', { proposal: false, slug: 'a-fix' });
  const r = writePhase(repo, 'plan');
  if (r.status !== 0) return `a ready spec and a ready fix brief were denied (exit ${r.status}): ${r.stderr.slice(0, 400)}`;
  return null;
}, { phase: 'spec' });

t('phase-guard does not hold the change being signed off to another one already planned', (repo) => {
  writeChange(repo, SIGNED_SPEC.replace('## Assumptions\n- none\n\n', ''), { slug: 'planned-before' });
  writeFileSync(join(repo, 'specflow', 'planned-before', 'plan.md'), '# Plan\n');
  writeChange(repo, SIGNED_SPEC);
  const r = writePhase(repo, 'plan');
  return r.status === 0 ? null : `plan was denied over a change that already has a plan (exit ${r.status}): ${r.stderr.slice(0, 300)}`;
}, { phase: 'spec' });

t('phase-guard does not hold a run already past spec to the assumptions rule', (repo) => {
  writeChange(repo, SIGNED_SPEC.replace('## Assumptions\n- none\n\n', ''));
  const r = writePhase(repo, 'review');
  if (r.status !== 0) return `a run planned before the section existed was denied review (exit ${r.status}): ${r.stderr.slice(0, 300)}`;
  return null;
}, { phase: 'plan' });

// arm-gate writes `implement` itself when the implementer is engaged without
// it, and that write never passed phase-guard: from `spec` it carried a brief
// out that phase-guard refuses to let leave.
const UNREADY_BRIEF = '# Fix — my-change\n\n## Case\n3 SPEC-WRONG\n\n## Requirement deltas\n- CHANGED REQ-USER-001 — now right\n';
const engageImplementer = (repo) =>
  runHook('arm-gate.mjs', { session_id: 's', tool_name: 'Agent', tool_input: { subagent_type: 'implementer', prompt: 'specflow/my-change/plan.md specflow/my-change/milestones/M1.md' } }, repo);

t('arm-gate does not carry a brief out of spec that phase-guard would hold there', (repo) => {
  writeChange(repo, UNREADY_BRIEF, { proposal: false });
  writeFileSync(join(repo, 'specflow', 'my-change', 'plan.md'), '# Plan — my-change\n');
  const r = engageImplementer(repo);
  const phase = readFileSync(join(repo, '.claude/state/phase'), 'utf8');
  if (phase !== 'spec') return `engaging the implementer moved the phase to "${phase}" over a CHANGED with no kind`;
  if (r.status !== 2) return `the implementer was engaged over a brief that is not ready (exit ${r.status})`;
  return /CHANGED/.test(r.stderr) && /spec-writer/.test(r.stderr) ? null : `the denial does not name the problem and route it: ${r.stderr.slice(0, 400)}`;
}, { phase: 'spec' });

// Guard: a ready brief arms as before — the backstop still holds when the
// orchestrator forgets the phase write.
t('arm-gate still arms from spec over a brief that is ready', (repo) => {
  writeChange(repo, UNREADY_BRIEF.replace('REQ-USER-001 —', 'REQ-USER-001 (correction) —'), { proposal: false });
  writeFileSync(join(repo, 'specflow', 'my-change', 'plan.md'), '# Plan — my-change\n');
  const r = engageImplementer(repo);
  if (r.status !== 0) return `a ready brief was denied (exit ${r.status}): ${r.stderr.slice(0, 300)}`;
  const phase = readFileSync(join(repo, '.claude/state/phase'), 'utf8');
  return phase === 'implement' ? null : `phase is "${phase}" — the implementer would run with the gate disarmed`;
}, { phase: 'spec' });

t('phase-guard denies blocked from anything but the gate', (repo) => {
  const r = runHook(
    'phase-guard.mjs',
    { tool_name: 'Write', tool_input: { file_path: '.claude/state/phase', content: 'blocked' } },
    repo,
  );
  if (r.status !== 2) return `a tool wrote blocked (exit ${r.status}) — it disarms the gate as if its cap had been reached`;
  return null;
});

t('phase-guard ignores an unrelated command', (repo) => {
  mkdirSync(join(repo, 'specflow', 'my-change'), { recursive: true });
  const r = runHook('phase-guard.mjs', { tool_name: 'Bash', tool_input: { command: 'git status' } }, repo);
  if (r.status !== 0) return `exit ${r.status}, expected 0 for an unrelated command`;
  return null;
});

t('lint-on-write ignores an out-of-scope file', (repo) => {
  const r = runHook('lint-on-write.mjs', { tool_input: { file_path: 'README.md' } }, repo);
  if (r.status !== 0) return `exit ${r.status}, expected 0`;
  return null;
});

t('lint-on-write is transparent outside implement', (repo) => {
  writeFileSync(join(repo, '.claude/state/phase'), 'idle');
  const r = runHook('lint-on-write.mjs', { tool_input: { file_path: 'example/thing.ts' } }, repo);
  if (r.status !== 0) return `exit ${r.status}, expected 0`;
  return null;
});

// ---- ADR-017: whose state is this? ----------------------------------------
//
// `gate-fixture.mjs` holds the case that matters most — a committed phase made
// the Stop hook run both of the repo's declared argv, measured. These are the
// other nine, where the same file arms a deny, a spawn rewrite or a linter.
// Shallow on purpose, per this file's header: what a regression here looks
// like is a hook that fires when it should be transparent.

t(
  'a phase the repository committed does not arm the whole-repo deny',
  (repo) => {
    const r = runHook('no-gate-cmds.mjs', { tool_input: { command: 'npm run test' } }, repo);
    if (r.status === 2) return `a committed phase denied a command in a repo running no flow: ${r.stderr}`;
    if (r.status !== 0) return `exit ${r.status}: ${r.stderr}`;
    return null;
  },
  { commitPhase: true },
);

t(
  'a phase the repository committed does not arm the phase guard',
  (repo) => {
    const r = runHook(
      'phase-guard.mjs',
      { tool_name: 'Write', tool_input: { file_path: '.claude/state/phase', content: 'triage' } },
      repo,
    );
    if (r.status === 2) return `a committed phase denied a write in a repo running no flow: ${r.stderr}`;
    if (r.status !== 0) return `exit ${r.status}: ${r.stderr}`;
    return null;
  },
  { commitPhase: true },
);

t(
  'a phase the repository committed does not arm the write-time linter',
  (repo) => {
    // The linter is made to leave EVIDENCE rather than to be silent. The
    // fixture's default `lint_no_fix` exits 0 and prints nothing, so "the hook
    // said nothing" is what a hook that ran the linter looks like too — and
    // this case passed against the unfixed engine for exactly that reason
    // before the marker was added. Running the repo's own argv is the whole
    // thing being tested.
    const cfgPath = join(repo, '.spec-flow/config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    cfg.verify.lint_no_fix = [
      'node',
      '-e',
      "require('fs').writeFileSync(process.env.CLAUDE_PROJECT_DIR + '/LINTER-RAN', 'x')",
    ];
    writeFileSync(cfgPath, JSON.stringify(cfg));
    writeFileSync(join(repo, 'thing.ts'), 'export const a = 1;\n');

    const r = runHook('lint-on-write.mjs', { tool_input: { file_path: join(repo, 'thing.ts') } }, repo);
    if (r.status !== 0) return `exit ${r.status}: ${r.stderr}`;
    if (existsSync(join(repo, 'LINTER-RAN'))) {
      return "the repository's own argv ran off a phase git tracks — that is the exec this boundary exists to stop";
    }
    return null;
  },
  { commitPhase: true },
);

// The same marker, with the phase arriving the way a run writes it: the case
// above has to be able to fail, and a hook that never spawns anything would
// satisfy it too.
t('the write-time linter does run when the phase came from a run', (repo) => {
  const cfgPath = join(repo, '.spec-flow/config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  cfg.verify.lint_no_fix = [
    'node',
    '-e',
    "require('fs').writeFileSync(process.env.CLAUDE_PROJECT_DIR + '/LINTER-RAN', 'x')",
  ];
  writeFileSync(cfgPath, JSON.stringify(cfg));
  writeFileSync(join(repo, 'thing.ts'), 'export const a = 1;\n');

  const r = runHook('lint-on-write.mjs', { tool_input: { file_path: join(repo, 'thing.ts') } }, repo);
  if (r.status !== 0) return `exit ${r.status}: ${r.stderr}`;
  if (!existsSync(join(repo, 'LINTER-RAN'))) {
    return 'the linter never ran on an in-scope write mid-implement, so the case above proves nothing';
  }
  return null;
});

t(
  'a phase the repository committed is not flipped to implement by arm-gate',
  (repo) => {
    const r = runHook('arm-gate.mjs', { tool_input: { subagent_type: 'implementer' } }, repo);
    if (r.status !== 0) return `exit ${r.status}: ${r.stderr}`;
    const phase = readFileSync(join(repo, '.claude/state/phase'), 'utf8');
    if (phase !== 'plan') return `arm-gate rewrote a tracked file: phase is now "${phase}"`;
    return null;
  },
  { phase: 'plan', commitPhase: true },
);

t(
  'session-start leaves a committed phase alone rather than dirtying the repo',
  (repo) => {
    const pf = join(repo, '.claude/state/phase');
    const old = new Date(Date.now() - 8 * 3600 * 1000);
    utimesSync(pf, old, old);
    const r = runHook('session-start.mjs', {}, repo);
    if (r.status !== 0) return `exit ${r.status}: ${r.stderr}`;
    if (readFileSync(pf, 'utf8') !== 'implement') return 'session-start wrote over a file git tracks';
    const status = spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
    if (/state[\\/]phase/.test(status.stdout)) return `the repo is dirty on a tracked file it did not touch:\n${status.stdout}`;
    return null;
  },
  { commitPhase: true },
);

// The seal is asked about by two hooks only — `gate.mjs`, which
// `gate-fixture.mjs` covers, and this one. Every other hook here reads the
// phase WITHOUT it, deliberately: they fire inside subagents too, and standing
// the write-time linter down over a subagent's session id would be a worse
// failure than the one being fixed. See ADR-017.
const OPUS_SPAWN = { tool_name: 'Task', tool_input: { subagent_type: 'planner' } };

t("a phase sealed to another session does not spend that run's Opus budget", (repo) => {
  writeFileSync(join(repo, '.claude/spec-flow.config.json'), JSON.stringify({ max_opus_calls: 2 }));
  writeFileSync(join(repo, '.claude/state/opus_calls'), '1');
  writeFileSync(join(repo, '.claude/state/phase.session'), 'session-a');

  const r = runHook('opus-budget.mjs', { session_id: 'session-b', ...OPUS_SPAWN }, repo);
  if (r.status !== 0) return `session B was denied against session A's budget: exit ${r.status}: ${r.stderr}`;
  const n = readFileSync(join(repo, '.claude/state/opus_calls'), 'utf8');
  if (n !== '1') return `session B charged session A's budget: opus_calls is now "${n}"`;
  return null;
});

// The case that keeps the one above from being a disarmed hook. Both halves of
// the fail-closed rule: the owner is still charged, and so is a payload that
// names nobody.
t('a phase sealed to this session still charges it, and so does one sealed to nobody', (repo) => {
  writeFileSync(join(repo, '.claude/spec-flow.config.json'), JSON.stringify({ max_opus_calls: 9 }));
  writeFileSync(join(repo, '.claude/state/phase.session'), 'session-a');

  const owner = runHook('opus-budget.mjs', { session_id: 'session-a', ...OPUS_SPAWN }, repo);
  if (owner.status !== 0) return `exit ${owner.status}: ${owner.stderr}`;
  if (readFileSync(join(repo, '.claude/state/opus_calls'), 'utf8') !== '1') {
    return 'the owning session was not charged for its own spawn';
  }

  const anon = runHook('opus-budget.mjs', OPUS_SPAWN, repo);
  if (anon.status !== 0) return `exit ${anon.status}: ${anon.stderr}`;
  const n = readFileSync(join(repo, '.claude/state/opus_calls'), 'utf8');
  if (n !== '2') {
    return `a payload with no session_id was not charged (opus_calls "${n}") — the seal must fail CLOSED, or a harness that stops sending the field turns the budget off entirely`;
  }
  return null;
});

t('phase-guard seals the phase to the session whose write it allowed', (repo) => {
  const r = runHook(
    'phase-guard.mjs',
    { session_id: 'session-a', tool_name: 'Write', tool_input: { file_path: '.claude/state/phase', content: 'implement' } },
    repo,
  );
  if (r.status !== 0) return `a legitimate phase write was denied: exit ${r.status}: ${r.stderr}`;
  const seal = join(repo, '.claude/state/phase.session');
  if (!existsSync(seal)) return 'the write went through unsealed, so a second session shares this run\'s state';
  if (readFileSync(seal, 'utf8') !== 'session-a') return `the seal names ${readFileSync(seal, 'utf8')}`;
  return null;
});

t('phase-guard seals nothing when it denied the write', (repo) => {
  const r = runHook(
    'phase-guard.mjs',
    { session_id: 'session-a', tool_name: 'Write', tool_input: { file_path: '.claude/state/phase', content: 'triage' } },
    repo,
  );
  if (r.status !== 2) return `an invented phase was allowed: exit ${r.status}`;
  if (existsSync(join(repo, '.claude/state/phase.session'))) {
    return 'a denied write claimed the phase — nothing was written, so nothing transferred';
  }
  return null;
});

// ---- model-route: the project's routing, applied without the orchestrator --
//
// The measurements this hook rests on are in ADR-014; what these cases hold is
// the half that lives here — that a routing block is applied when it is right,
// and refused LOUDLY when it is not. A typo'd agent name is this repo's whole
// subject in miniature: the config reads as though it routes something and
// routes nothing, forever.

/** The routing hook's rewritten input, or null when it emitted nothing. */
function routed(r) {
  if (!r.stdout.trim()) return null;
  try {
    return JSON.parse(r.stdout).hookSpecificOutput?.updatedInput ?? null;
  } catch {
    return null;
  }
}

function withRouting(repo, agents) {
  writeFileSync(join(repo, '.claude/spec-flow.config.json'), JSON.stringify({ max_opus_calls: 6, agents }));
}

t('model-route leaves the model alone when the project declares no routing', (repo) => {
  const r = runHook('model-route.mjs', { tool_name: 'Agent', tool_input: { subagent_type: 'planner' } }, repo);
  if (r.status !== 0) return `exit ${r.status}, expected 0. stderr: ${r.stderr.slice(0, 200)}`;
  if (routed(r) && 'model' in routed(r)) return `set a model for a repo that configured nothing: ${r.stdout.slice(0, 200)}`;
  return null;
});

t('model-route runs every spawn of this plugin in the background', (repo) => {
  // ADR-023. A foreground spawn blocks the chat with no sign of progress for
  // as long as the agent thinks, which is how a working run gets killed as hung.
  const spawn = { tool_name: 'Agent', tool_input: { subagent_type: 'spec-flow:spec-writer', prompt: 'x', run_in_background: false } };
  const r = runHook('model-route.mjs', spawn, repo, ENGINE, { CLAUDE_CODE_SESSION_ATTENDED: '1' });
  if (r.status !== 0) return `exit ${r.status}. stderr: ${r.stderr.slice(0, 200)}`;
  const input = routed(r);
  if (input?.run_in_background !== true) return `the spawn was left in the foreground: ${r.stdout.slice(0, 200) || '(no rewrite)'}`;
  if (input.prompt !== 'x') return 'the rewrite dropped the rest of the spawn input';
  return null;
});

t('model-route leaves an unattended session in the foreground', (repo) => {
  // `claude -p` terminates background agents still running 600 s after its
  // turn ends, and nobody watches its chat. Measured with this variable: 0
  // under `claude -p`, 1 in an interactive session.
  const spawn = { tool_name: 'Agent', tool_input: { subagent_type: 'spec-flow:spec-writer', prompt: 'x' } };
  const r = runHook('model-route.mjs', spawn, repo, ENGINE, { CLAUDE_CODE_SESSION_ATTENDED: '0' });
  if (r.status !== 0) return `exit ${r.status}. stderr: ${r.stderr.slice(0, 200)}`;
  if (routed(r)?.run_in_background) return `an unattended spawn was sent to the background, where the harness kills it at 600 s: ${r.stdout.slice(0, 200)}`;
  withRouting(repo, { 'spec-writer': 'opus' });
  const rerouted = routed(runHook('model-route.mjs', spawn, repo, ENGINE, { CLAUDE_CODE_SESSION_ATTENDED: '0' }));
  if (rerouted?.model !== 'opus') return 'the re-route was dropped along with the background';
  if (rerouted.run_in_background) return 'a re-routed unattended spawn was sent to the background';
  return null;
});

t('model-route rewrites the spawn the project re-routed', (repo) => {
  withRouting(repo, { reviewer: 'sonnet' });
  const r = runHook('model-route.mjs', { tool_name: 'Agent', tool_input: { subagent_type: 'reviewer', prompt: 'x' } }, repo);
  if (r.status !== 0) return `exit ${r.status}. stderr: ${r.stderr.slice(0, 200)}`;
  const input = routed(r);
  if (!input) return `emitted no updatedInput, so the routing was configured and never applied. stdout: ${r.stdout.slice(0, 200)}`;
  if (input.model !== 'sonnet') return `rewrote model to "${input.model}", expected "sonnet"`;
  if (input.prompt !== 'x') return 'the rewrite dropped the rest of the spawn input';
  return null;
});

// Guards: the architect advisor runs on Opus unless the project routes it,
// the same way as any other agent; Fable is one of the tiers (ADR-038).
t('model-route sends the architect to Fable when the project routes it there', (repo) => {
  withRouting(repo, { architect: 'fable' });
  const r = runHook('model-route.mjs', { tool_name: 'Agent', tool_input: { subagent_type: 'spec-flow:architect', prompt: 'Which port owns this?' } }, repo);
  if (r.status !== 0) return `exit ${r.status}. stderr: ${r.stderr.slice(0, 200)}`;
  const input = routed(r);
  if (input?.model !== 'fable') return `rewrote model to "${input?.model}", expected "fable"`;
  return input.prompt === 'Which port owns this?' ? null : 'the rewrite dropped the rest of the spawn input';
});

t('model-route leaves the model of an agent the project did not re-route alone', (repo) => {
  withRouting(repo, { reviewer: 'sonnet' });
  const r = runHook('model-route.mjs', { tool_name: 'Agent', tool_input: { subagent_type: 'planner' } }, repo);
  if (r.status !== 0) return `exit ${r.status}`;
  if (routed(r) && 'model' in routed(r)) return `re-routed a spawn nobody re-routed: ${r.stdout.slice(0, 200)}`;
  return null;
});

t('model-route treats restating the shipped default as no re-route', (repo) => {
  withRouting(repo, { planner: 'opus' });
  const r = runHook('model-route.mjs', { tool_name: 'Agent', tool_input: { subagent_type: 'planner' } }, repo);
  if (r.status !== 0) return `exit ${r.status}`;
  if (routed(r) && 'model' in routed(r)) return `reported a change nobody made: ${r.stdout.slice(0, 200)}`;
  if (existsSync(join(repo, '.claude/state/model-routes.log'))) return 'logged a re-route nobody made';
  return null;
});

t('model-route denies a routing block naming an agent that does not exist', (repo) => {
  withRouting(repo, { reviwer: 'sonnet' });
  const r = runHook('model-route.mjs', { tool_name: 'Agent', tool_input: { subagent_type: 'reviewer' } }, repo);
  if (r.status !== 2) {
    return `exit ${r.status}, expected 2 (deny) — a name nothing matches routes nothing, and reads exactly like a routing that works`;
  }
  if (!r.stderr.includes('reviwer')) return 'denied without naming the entry that is wrong';
  if (!r.stderr.includes('reviewer')) return 'denied without naming the agents that do exist, which is what makes the message actionable';
  return null;
});

t('model-route denies a full model id, where the tool call would have', (repo) => {
  withRouting(repo, { reviewer: ['claude', 'haiku', '4-5'].join('-') });
  const r = runHook('model-route.mjs', { tool_name: 'Agent', tool_input: { subagent_type: 'reviewer' } }, repo);
  if (r.status !== 2) {
    return `exit ${r.status}, expected 2 — a pinned id fails the spawn's own schema, a long way from the file that caused it`;
  }
  return null;
});

t('model-route passes through an agent this plugin does not ship', (repo) => {
  withRouting(repo, { reviewer: 'sonnet' });
  const r = runHook('model-route.mjs', { tool_name: 'Agent', tool_input: { subagent_type: 'general-purpose' } }, repo);
  if (r.status !== 0) return `exit ${r.status}, expected 0 — an unrelated agent must never be touched`;
  if (r.stdout.trim()) return 'rewrote a spawn that is none of this plugin’s business';
  return null;
});

t('model-route does not block unrelated work over its own broken config', (repo) => {
  withRouting(repo, { reviwer: 'sonnet' });
  const r = runHook('model-route.mjs', { tool_name: 'Agent', tool_input: { subagent_type: 'general-purpose' } }, repo);
  if (r.status !== 0) {
    return `exit ${r.status}: a broken spec-flow routing block blocked unrelated work in a repo that merely has the plugin installed`;
  }
  return null;
});

t('model-route applies outside a run, unlike the budget', (repo) => {
  writeFileSync(join(repo, '.claude/state/phase'), 'idle');
  withRouting(repo, { architect: 'sonnet' });
  const r = runHook('model-route.mjs', { tool_name: 'Agent', tool_input: { subagent_type: 'architect' } }, repo);
  if (r.status !== 0) return `exit ${r.status}`;
  if (routed(r)?.model !== 'sonnet') {
    return 'a one-off question to the architect ignored the routing. A budget counts what a run spends and stands down outside one; routing is the project’s standing answer to what an agent runs on.';
  }
  return null;
});

t('model-route leaves a deduped trace of what it re-routed', (repo) => {
  withRouting(repo, { reviewer: 'sonnet' });
  runHook('model-route.mjs', { tool_name: 'Agent', tool_input: { subagent_type: 'reviewer' } }, repo);
  runHook('model-route.mjs', { tool_name: 'Agent', tool_input: { subagent_type: 'reviewer' } }, repo);
  const log = join(repo, '.claude/state/model-routes.log');
  if (!existsSync(log)) {
    return 'a re-route left no trace: the spawn looks ordinary in the transcript and the frontmatter still says otherwise';
  }
  const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  if (lines.length !== 1) return `${lines.length} line(s) for two identical spawns; the log is deduped so a run leaves one line per re-route`;
  if (!lines[0].includes('reviewer -> sonnet')) return `the trace does not say what changed: ${lines[0]}`;
  return null;
});

// ---- stale-resume: an agent whose cache expired is not resumed (ADR-025) ----
//
// The shape a run leaves: `<session>.jsonl`, and beside it
// `<session>/subagents/agent-<id>.jsonl` with its `.meta.json`. `ageMin`
// backdates the agent's last write; `ttl` is which cache entry it wrote.
function subagentOnDisk(repo, { id = 'a0123456789abcdef', type = 'spec-flow:spec-writer', ttl = '5m', context = 206000, ageMin = 30 } = {}) {
  const session = join(repo, 'sess.jsonl');
  writeFileSync(session, '');
  const dir = join(repo, 'sess', 'subagents');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `agent-${id}.jsonl`);
  const cacheCreation = { ephemeral_5m_input_tokens: ttl === '5m' ? 998 : 0, ephemeral_1h_input_tokens: ttl === '1h' ? 998 : 0 };
  const usage = { input_tokens: 2, cache_read_input_tokens: context - 1000, cache_creation_input_tokens: 998, cache_creation: cacheCreation };
  writeFileSync(file, `${JSON.stringify({ type: 'assistant', isSidechain: true, message: { id: 'msg_1', model: 'model-alpha', usage } })}\n`);
  writeFileSync(join(dir, `agent-${id}.meta.json`), JSON.stringify({ agentType: type }));
  const when = new Date(Date.now() - ageMin * 60_000);
  utimesSync(file, when, when);
  return { transcript_path: session, tool_name: 'SendMessage', tool_input: { to: id, message: 'close the gap', summary: 'close the gap' } };
}

t('stale-resume denies resuming an agent whose cache expired, and says the cost and the way out', (repo) => {
  const r = runHook('stale-resume.mjs', subagentOnDisk(repo, { ageMin: 30 }), repo);
  if (r.status !== 2) return `exit ${r.status}, expected 2 — a 30-minute-old spec-writer was resumed, re-sending its whole context`;
  if (!/206k/.test(r.stderr)) return `the denial does not say what the resume would have re-sent: ${r.stderr}`;
  if (!/NEW spec-writer/.test(r.stderr)) return `the denial does not name the way out: ${r.stderr}`;
  return null;
});

t('stale-resume lets a warm agent be resumed', (repo) => {
  const r = runHook('stale-resume.mjs', subagentOnDisk(repo, { ageMin: 1 }), repo);
  return r.status === 0 ? null : `exit ${r.status}: a one-minute-old agent was refused, and a warm retry is the cheap path: ${r.stderr}`;
});

t('stale-resume reads the TTL off the agent — a 1-hour cache at 30 minutes is warm', (repo) => {
  const r = runHook('stale-resume.mjs', subagentOnDisk(repo, { ageMin: 30, ttl: '1h' }), repo);
  return r.status === 0 ? null : `exit ${r.status}: an agent writing 1-hour entries was judged by the 5-minute rule: ${r.stderr}`;
});

t('stale-resume leaves an agent that is not this plugin’s alone', (repo) => {
  const r = runHook('stale-resume.mjs', subagentOnDisk(repo, { ageMin: 30, type: 'Explore' }), repo);
  return r.status === 0 ? null : `exit ${r.status}: another agent's message was denied: ${r.stderr}`;
});

t('stale-resume stands down outside a run', (repo) => {
  writeFileSync(join(repo, '.claude/state/phase'), 'idle');
  const r = runHook('stale-resume.mjs', subagentOnDisk(repo, { ageMin: 30 }), repo);
  return r.status === 0 ? null : `exit ${r.status}: a message outside any run was denied`;
});

t('stale-resume allows a recipient it cannot see', (repo) => {
  const payload = subagentOnDisk(repo, { ageMin: 30 });
  const r = runHook('stale-resume.mjs', { ...payload, tool_input: { to: 'someone-else', message: 'x' } }, repo);
  return r.status === 0 ? null : `exit ${r.status}: a message was denied over a transcript that does not exist`;
});

t('opus-budget charges a warm planner resume and not one stale-resume denies', (repo) => {
  writeFileSync(join(repo, '.claude/state/agent-registry'), 'a0123456789abcdef planner\n');
  const count = () => (existsSync(join(repo, '.claude/state/opus_calls')) ? readFileSync(join(repo, '.claude/state/opus_calls'), 'utf8').trim() : '0');
  runHook('opus-budget.mjs', subagentOnDisk(repo, { ageMin: 30, type: 'spec-flow:planner' }), repo);
  if (count() !== '0') return `a resume stale-resume denies was charged (${count()}): the fresh spawn replacing it bills the same consult twice`;
  runHook('opus-budget.mjs', subagentOnDisk(repo, { ageMin: 1, type: 'spec-flow:planner' }), repo);
  return count() === '1' ? null : `a warm planner resume was charged ${count()}, want 1`;
});

// ---- the orchestrator routes, and a hook keeps it routing (ADR-034) ------
//
// On real runs the session moved a human's parked plan out of specflow/ to
// get past a refusal, and read eleven files a triage had just read. A
// subagent's call carries its agent_id; the session's carries none.
const scope = (repo, payload) => runHook('orchestrator-scope.mjs', payload, repo);
const attributed = (repo) =>
  writeFileSync(join(repo, '.claude/state/run-trace.log'), `2026-01-01T00:00:00Z phase=implement session=s read file=${join(repo, 'specs', 'user.md')} agent_id=writer1\n`);
const sessionWrite = (repo, rel) => scope(repo, { session_id: 's', tool_name: 'Write', tool_input: { file_path: join(repo, rel), content: 'x' } });
const sessionRead = (repo, path) => scope(repo, { session_id: 's', tool_name: 'Read', tool_input: { file_path: path } });
const sessionBash = (repo, command) => scope(repo, { session_id: 's', tool_name: 'Bash', tool_input: { command } });

t('orchestrator-scope denies the session writing code during a run, and names who does it', (repo) => {
  attributed(repo);
  const r = sessionWrite(repo, 'lib/a.ts');
  if (r.status !== 2) return `the session wrote lib/a.ts mid-run (exit ${r.status})`;
  return /implementer/.test(r.stderr) ? null : `the denial does not route the work: ${r.stderr}`;
});

t('orchestrator-scope lets a subagent write code', (repo) => {
  attributed(repo);
  const r = scope(repo, { session_id: 's', agent_id: 'impl1', tool_name: 'Edit', tool_input: { file_path: join(repo, 'lib/a.ts'), old_string: 'a', new_string: 'b' } });
  return r.status === 0 ? null : `an implementer's edit was denied (exit ${r.status}): ${r.stderr}`;
});

t('orchestrator-scope lets the session write its state and the change folder', (repo) => {
  attributed(repo);
  for (const rel of ['.claude/state/gate_attempts', 'specflow/my-change/spec.md']) {
    const r = sessionWrite(repo, rel);
    if (r.status !== 0) return `the session was denied ${rel} (exit ${r.status}): ${r.stderr}`;
  }
  return null;
});

t('orchestrator-scope denies the session reading code, and lets it read specs, the change, the root docs and anything outside the repository', (repo) => {
  attributed(repo);
  const code = sessionRead(repo, join(repo, 'lib', 'a.ts'));
  if (code.status !== 2) return `the session read lib/a.ts mid-run (exit ${code.status})`;
  for (const path of [join(repo, 'specs', 'user.md'), join(repo, 'specflow', 'my-change', 'spec.md'), join(repo, 'CLAUDE.md'), join(tmpdir(), 'elsewhere', 'commands', 'spec-flow.md')]) {
    const r = sessionRead(repo, path);
    if (r.status !== 0) return `the session was denied ${path} (exit ${r.status}): ${r.stderr}`;
  }
  return null;
});

t("orchestrator-scope denies a Bash move of a human's plan out of specflow/", (repo) => {
  attributed(repo);
  const r = sessionBash(repo, 'git mv specflow/city-gym docs/backlog/city-gym');
  return r.status === 2 ? null : `the session moved a parked plan out of specflow/ (exit ${r.status})`;
});

t('orchestrator-scope denies a redirect or a sed -i into code', (repo) => {
  attributed(repo);
  for (const command of ['echo x > lib/a.ts', "sed -i 's/a/b/' lib/a.ts"]) {
    const r = sessionBash(repo, command);
    if (r.status !== 2) return `\`${command}\` went through (exit ${r.status})`;
  }
  return null;
});

// Guards: the session's own steps, as the commands write them.
t("orchestrator-scope lets the session's own Bash steps through", (repo) => {
  attributed(repo);
  for (const command of [
    'printf 0 > .claude/state/gate_attempts && printf 0 > .claude/state/opus_calls && printf 0 > .claude/state/architect_calls && node /x/telemetry-snapshot.mjs --mark',
    'git add -A && git commit -m "move lib/a.ts into lib/b" && git push',
    'git mv specflow/my-change specflow/archive/my-change',
    'node /x/specflow-stats.mjs 2>&1 > /dev/null',
  ]) {
    const r = sessionBash(repo, command);
    if (r.status !== 0) return `\`${command}\` was denied (exit ${r.status}): ${r.stderr}`;
  }
  return null;
});

t('orchestrator-scope stands down outside a run', (repo) => {
  attributed(repo);
  writeFileSync(join(repo, '.claude/state/phase'), 'idle');
  const r = sessionWrite(repo, 'lib/a.ts');
  return r.status === 0 ? null : `an edit outside any run was denied (exit ${r.status})`;
});

t('orchestrator-scope stands down until the trace shows this build attributes calls, and says so', (repo) => {
  const r = sessionWrite(repo, 'lib/a.ts');
  if (r.status !== 0) return `it denied with no evidence that subagent calls carry an agent_id (exit ${r.status}) — an implementer's write would read the same`;
  return existsSync(join(repo, '.claude/state/orchestrator-scope-unmatched.log')) ? null : 'it stood down without recording why';
});

// ---- what the orchestrator dispatches, recorded before it is denied (ADR-035) ----
//
// A message addresses an agent by the id its spawn returned; arm-gate read
// only name-ish fields, so resuming the implementer by id armed nothing.
t('arm-gate arms on a message that resumes the implementer by its id', (repo) => {
  writeFileSync(join(repo, '.claude/state/phase'), 'blocked');
  const r = runHook('arm-gate.mjs', subagentOnDisk(repo, { type: 'spec-flow:implementer', ageMin: 1 }), repo);
  if (r.status !== 0) return `exit ${r.status}: ${r.stderr}`;
  const phase = readFileSync(join(repo, '.claude/state/phase'), 'utf8');
  return phase === 'implement' ? null : `phase is "${phase}" — the implementer was put back to work with the gate disarmed`;
});

const dispatches = (repo) => {
  const file = join(repo, '.claude/state/run-trace.log');
  return (existsSync(file) ? readFileSync(file, 'utf8') : '').split('\n').filter((l) => l.includes(' dispatch '));
};
const spawn = (repo, type, prompt = '', extra = {}) =>
  runHook('dispatch-guard.mjs', { session_id: 's', tool_name: 'Agent', tool_input: { subagent_type: type, description: 'x', prompt }, ...extra }, repo);
const IMPL_ORDER = 'Implement specflow/my-change/milestones/M1.md; the approach is in specflow/my-change/plan.md.';

t('arm-gate records each time it arms the gate for the orchestrator', (repo) => {
  writeFileSync(join(repo, '.claude/state/phase'), 'plan');
  runHook('arm-gate.mjs', { session_id: 's', tool_name: 'Agent', tool_input: { subagent_type: 'implementer', prompt: IMPL_ORDER } }, repo);
  const line = dispatches(repo)[0] ?? '';
  return / phase=plan .*dispatch agent=implementer tool=Agent result=armed why=phase/.test(line) ? null : `no record of the backstop arming: "${line}"`;
});

t('dispatch-guard records an agent put to work in a phase the commands do not dispatch it in, and lets it through', (repo) => {
  const r = spawn(repo, 'spec-flow:reviewer');
  if (r.status !== 0) return `a recorded dispatch was denied (exit ${r.status}): ${r.stderr}`;
  const line = dispatches(repo)[0] ?? '';
  return / phase=implement .*dispatch agent=reviewer tool=Agent result=record why=phase/.test(line) ? null : `no record of a reviewer mid-implement: "${line}"`;
});

t('dispatch-guard records an implementer handed more than its work order, or less', (repo) => {
  spawn(repo, 'spec-flow:implementer', `${IMPL_ORDER} Start from lib/orders/place.ts and read specflow/my-change/spec.md.`);
  spawn(repo, 'spec-flow:implementer', 'Implement specflow/my-change/plan.md.');
  const [more, less] = dispatches(repo);
  if (!/why=other-files files=lib\/orders\/place\.ts,specflow\/my-change\/spec\.md/.test(more ?? '')) return `files beyond the work order were not recorded: "${more}"`;
  return /why=no-milestone/.test(less ?? '') ? null : `an implementer with no milestone was not recorded: "${less}"`;
});

t('dispatch-guard records a message to an agent this session never spawned', (repo) => {
  const payload = subagentOnDisk(repo, { type: 'spec-flow:implementer', ageMin: 1 });
  runHook('dispatch-guard.mjs', { ...payload, tool_input: { ...payload.tool_input, to: 'b0123456789abcdef' } }, repo);
  const line = dispatches(repo)[0] ?? '';
  return /dispatch agent=- tool=SendMessage result=record why=unknown-target to=b0123456789abcdef/.test(line) ? null : `no record of a message to nobody: "${line}"`;
});

t('dispatch-guard records an agent that is not this flow put to work mid-run', (repo) => {
  spawn(repo, 'Explore', 'read lib/ and summarize the orders module');
  const line = dispatches(repo)[0] ?? '';
  return /dispatch agent=Explore tool=Agent result=record why=not-this-flow/.test(line) ? null : `no record of a general agent mid-run: "${line}"`;
});

// Guards: what the commands dispatch, as they write it, leaves no line.
t("dispatch-guard leaves no line for the commands' own dispatches", (repo) => {
  const at = (phase) => writeFileSync(join(repo, '.claude/state/phase'), phase);
  at('spec');
  spawn(repo, 'spec-flow:spec-writer', 'MODE=TRIAGE the login fails');
  at('review');
  spawn(repo, 'spec-flow:planner', 'MODE=CONSULT');
  at('implement');
  spawn(repo, 'spec-flow:implementer', IMPL_ORDER);
  spawn(repo, 'spec-flow:implementer', `${join(repo, 'specflow/my-change/plan.md')} and ${join(repo, 'specflow/my-change/milestones/M2.md')}, with .claude/state/gate-failure.log`);
  spawn(repo, 'spec-flow:architect', 'Which port owns this?');
  spawn(repo, 'spec-flow:spec-writer', 'MODE=FOLD specflow/my-change/spec.md');
  runHook('dispatch-guard.mjs', subagentOnDisk(repo, { type: 'spec-flow:implementer', ageMin: 1 }), repo);
  const lines = dispatches(repo);
  return lines.length === 0 ? null : `the commands' own dispatches were recorded:\n${lines.join('\n')}`;
});

t("dispatch-guard leaves a subagent's call, and a call outside a run, alone", (repo) => {
  spawn(repo, 'Explore', '', { agent_id: 'impl1' });
  writeFileSync(join(repo, '.claude/state/phase'), 'idle');
  spawn(repo, 'Explore');
  const lines = dispatches(repo);
  return lines.length === 0 ? null : `recorded outside the orchestrator's run:\n${lines.join('\n')}`;
});

// ---- a case 3 waits for a human's answer (ADR-036) -------------------------
//
// The command stops for a person before a requirement is corrected to agree
// with the code. Nothing held it: the brief's `(correction)` marker is the
// triage's, written before anyone is asked.
const CORRECTION_BRIEF = '# Fix — my-change\n\n## Case\n3 SPEC-WRONG\n\n## Requirement deltas\n- CHANGED REQ-USER-001 (correction) — now right\n';
const turnLog = (repo, minutesAgo, event) =>
  appendFileSync(join(repo, '.claude/state/human-turn.log'), `${new Date(Date.now() - minutesAgo * 60_000).toISOString()} ${event}\n`);
/** The session ended its turn, then a person typed. */
const answeredAt = (repo, minutesAgo) => {
  turnLog(repo, minutesAgo + 0.5, 'turn-end');
  turnLog(repo, minutesAgo, 'prompt from=human');
};
function correctionBrief(repo, writtenMinutesAgo) {
  writeChange(repo, CORRECTION_BRIEF, { proposal: false });
  writeFileSync(join(repo, 'specflow', 'my-change', 'plan.md'), '# Plan — my-change\n');
  const when = new Date(Date.now() - writtenMinutesAgo * 60_000);
  utimesSync(join(repo, 'specflow', 'my-change', 'spec.md'), when, when);
}

t('phase-guard holds a case 3 in spec until a human has answered since the brief was written', (repo) => {
  answeredAt(repo, 10); // the /spec-fix that started the run
  correctionBrief(repo, 5);
  const r = writePhase(repo, 'implement');
  if (r.status !== 2) return `implement was written over a correction no human answered (exit ${r.status})`;
  if (/human-turn|turn-end/.test(r.stderr)) return `the denial names the record instead of asking for the answer: ${r.stderr.slice(0, 300)}`;
  return /REQ-USER-001/.test(r.stderr) && /end your turn/.test(r.stderr) ? null : `the denial does not name the correction and the stop: ${r.stderr.slice(0, 400)}`;
}, { phase: 'spec' });

t('arm-gate does not engage the implementer over a case 3 no human has answered, from spec or after a re-triage while implementing', (repo) => {
  answeredAt(repo, 10);
  correctionBrief(repo, 5);
  for (const phase of ['spec', 'implement']) {
    writeFileSync(join(repo, '.claude/state/phase'), phase);
    const r = engageImplementer(repo);
    if (r.status !== 2) return `${phase}: the implementer was engaged over a correction no human answered (exit ${r.status})`;
    const now = readFileSync(join(repo, '.claude/state/phase'), 'utf8');
    if (now !== phase) return `${phase}: the denied engagement still moved the phase to "${now}"`;
  }
  return null;
}, { phase: 'spec' });

// The triage's own report-back fires the prompt hook after the brief. The
// session ended its turn when it spawned the triage, before the brief.
t('a prompt with no turn end after the brief, or a harness notification, is not an answer', (repo) => {
  turnLog(repo, 8, 'turn-end');
  correctionBrief(repo, 5);
  turnLog(repo, 2, 'prompt from=human');
  const r = writePhase(repo, 'implement');
  if (r.status !== 2) return `a prompt arriving without the session having stopped after the brief counted as an answer (exit ${r.status})`;
  turnLog(repo, 1.5, 'turn-end');
  turnLog(repo, 1, 'prompt from=task-notification');
  const n = writePhase(repo, 'implement');
  return n.status === 2 ? null : `a task notification counted as a person's answer (exit ${n.status})`;
}, { phase: 'spec' });

t('human-turn records turn ends, prompts by source and answered questions, and nothing in a repository that never adopted the engine', (repo) => {
  const hook = (payload, at = repo) => runHook('human-turn.mjs', { session_id: 's', ...payload }, at);
  hook({ hook_event_name: 'UserPromptSubmit', prompt: 'yes, the requirement was wrong' });
  hook({ hook_event_name: 'UserPromptSubmit', prompt: '<task-notification>\n<task-id>a1</task-id>' });
  hook({ hook_event_name: 'UserPromptSubmit', prompt: '<pasted_content id="p1">\nlog\n</pasted_content> ok' });
  hook({ hook_event_name: 'Stop' });
  hook({ hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_input: {}, tool_response: {} });
  const got = readFileSync(join(repo, '.claude/state/human-turn.log'), 'utf8').split('\n').filter(Boolean).map((l) => l.split(' ').slice(1).join(' '));
  const want = ['prompt from=human', 'prompt from=task-notification', 'prompt from=human', 'turn-end', 'prompt from=question'];
  if (JSON.stringify(got) !== JSON.stringify(want)) return `recorded ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`;
  if (readFileSync(join(repo, '.claude/state/human-turn.log'), 'utf8').includes('requirement was wrong')) return 'the record copied what the person said';
  const bare = mkdtempSync(join(tmpdir(), 'smoke-bare-'));
  try {
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' }, bare);
    return existsSync(join(bare, '.claude')) ? 'it wrote state into a repository that never adopted the engine' : null;
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

t('orchestrator-scope denies the session writing a log the hooks decide on', (repo) => {
  attributed(repo);
  for (const command of ['echo "x prompt from=human" >> .claude/state/human-turn.log', "printf 'x result=pass ' >> .claude/state/gate-history.log"]) {
    const r = sessionBash(repo, command);
    if (r.status !== 2) return `\`${command}\` went through (exit ${r.status})`;
  }
  const w = sessionWrite(repo, '.claude/state/run-trace.log');
  return w.status === 2 ? null : `a Write over run-trace.log went through (exit ${w.status})`;
});

// Guards: an answered case 3 goes on, and a build that never records an
// answer is not held forever.
t('a case 3 goes on once a human has answered since the brief, typed after a turn end or through a question', (repo) => {
  correctionBrief(repo, 5);
  answeredAt(repo, 1);
  const r = writePhase(repo, 'implement');
  if (r.status !== 0) return `implement was denied after the human answered (exit ${r.status}): ${r.stderr.slice(0, 300)}`;
  const e = engageImplementer(repo);
  if (e.status !== 0) return `the implementer was denied after the human answered (exit ${e.status}): ${e.stderr.slice(0, 300)}`;
  correctionBrief(repo, 0.5);
  turnLog(repo, 0.2, 'prompt from=question');
  const q = engageImplementer(repo);
  return q.status === 0 ? null : `an answered question did not count (exit ${q.status}): ${q.stderr.slice(0, 300)}`;
}, { phase: 'spec' });

t('the case-3 check stands down, and says so, where no answer was ever recorded', (repo) => {
  correctionBrief(repo, 5);
  const r = writePhase(repo, 'implement');
  if (r.status !== 0) return `a build with no recorded answer held the case 3 (exit ${r.status}) — it would hold it forever`;
  return existsSync(join(repo, '.claude/state/human-turn-unmatched.log')) ? null : 'it stood down without recording why';
}, { phase: 'spec' });

console.log('');
let bad = 0;
for (const [n, s] of results) {
  if (s !== 'ok') bad++;
  console.log(`${s === 'ok' ? ' OK ' : 'FAIL'}  ${n}${s === 'ok' ? '' : '\n        ' + s}`);
}
console.log(`\n${results.length - bad}/${results.length} passed`);
process.exit(bad ? 1 : 0);
