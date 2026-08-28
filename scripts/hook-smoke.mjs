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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync, utimesSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ENGINE = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];

function makeRepo({ phase = 'implement', withContract = true, git = true, commitPhase = false } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'smoke-repo-'));
  mkdirSync(join(repo, '.claude', 'state'), { recursive: true });
  mkdirSync(join(repo, 'specflow'), { recursive: true });
  if (withContract) {
    mkdirSync(join(repo, '.spec-flow'), { recursive: true });
    writeFileSync(
      join(repo, '.spec-flow/config.json'),
      JSON.stringify({
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
      }),
    );
  }
  writeFileSync(join(repo, '.claude/state/phase'), phase);

  // A real repo with a base branch, because the engine's scope is a
  // merge-base diff and `preflight` refuses to start a run without one. Off
  // only for the case that asserts exactly that refusal.
  if (git) {
    const g = (...args) => spawnSync('git', args, { cwd: repo, stdio: 'ignore' });
    g('init', '-q', '.');
    g('symbolic-ref', 'HEAD', 'refs/heads/main');
    g('config', 'user.email', 'smoke@example.com');
    g('config', 'user.name', 'smoke');
    g('commit', '-q', '--allow-empty', '-m', 'baseline');
    // The shape a repository the user did not write can arrive in: the file
    // every enforcement hook arms on, supplied by the repo rather than by a
    // run. See ADR-017.
    if (commitPhase) {
      g('add', '-f', '--', '.claude/state/phase');
      g('commit', '-q', '-m', 'a phase this repository committed');
    }
  }

  return repo;
}

function runHook(hook, payload, repo, engineRoot = ENGINE) {
  return spawnSync('node', [join(engineRoot, 'hooks', hook)], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
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
  { git: false, phase: 'spec' },
);

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

t('run-trace logs a subagent STATUS', (repo) => {
  const r = runHook(
    'run-trace.mjs',
    { tool_name: 'Task', tool_input: { subagent_type: 'reviewer' }, tool_response: 'STATUS: APPROVED' },
    repo,
  );
  if (r.status !== 0) return `exit ${r.status}`;
  const log = readFileSync(join(repo, '.claude/state/run-trace.log'), 'utf8');
  if (!log.includes('agent type=reviewer status=APPROVED')) return `log: ${log}`;
  return null;
});

t('run-trace records a reported skill-routing miss', (repo) => {
  // The one observable this flow produces that had nowhere to go: reported as
  // prose in NOTES it reaches the orchestrator and vanishes. Recorded here it
  // survives into the archived telemetry, which is what makes "does the
  // planner's routing miss often?" answerable at all.
  const r = runHook(
    'run-trace.mjs',
    {
      tool_name: 'Task',
      tool_input: { subagent_type: 'implementer' },
      tool_response: 'STATUS: IMPLEMENTED\nSKILL_MISS: where does it live\nNOTES: fine',
    },
    repo,
  );
  if (r.status !== 0) return `exit ${r.status}: ${r.stderr}`;
  const line = readFileSync(join(repo, '.claude/state/run-trace.log'), 'utf8');
  if (!/skill_miss=where-does-it-live/.test(line)) {
    return `the miss did not reach the trace, so no number of runs can answer whether routing misses: ${line}`;
  }
  if (!/status=IMPLEMENTED/.test(line)) return `the status field was lost: ${line}`;
  return null;
});

t('run-trace writes no skill_miss field when none was reported', (repo) => {
  const r = runHook(
    'run-trace.mjs',
    { tool_name: 'Task', tool_input: { subagent_type: 'implementer' }, tool_response: 'STATUS: IMPLEMENTED' },
    repo,
  );
  if (r.status !== 0) return `exit ${r.status}`;
  const line = readFileSync(join(repo, '.claude/state/run-trace.log'), 'utf8');
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

// ---- B5: the engine refuses a Node it does not support, and only in a run --
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

// ---- B7: the position a resume needs survives, and a reset reports it ------
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

t('phase-guard allows every phase the engine actually knows', (repo) => {
  for (const value of ['spec', 'plan', 'review', 'implement', 'blocked', 'idle']) {
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
  const r = runHook(
    'phase-guard.mjs',
    { tool_name: 'Bash', tool_input: { command: "printf 'done' > .claude/state/phase" } },
    repo,
  );
  if (r.status !== 0) return `exit ${r.status}, expected 0. stderr: ${r.stderr.slice(0, 300)}`;
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

t('model-route is transparent when the project declares no routing', (repo) => {
  const r = runHook('model-route.mjs', { tool_name: 'Agent', tool_input: { subagent_type: 'planner' } }, repo);
  if (r.status !== 0) return `exit ${r.status}, expected 0. stderr: ${r.stderr.slice(0, 200)}`;
  if (r.stdout.trim()) return `emitted output for a repo that configured nothing: ${r.stdout.slice(0, 200)}`;
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

t('model-route leaves an agent the project did not re-route alone', (repo) => {
  withRouting(repo, { reviewer: 'sonnet' });
  const r = runHook('model-route.mjs', { tool_name: 'Agent', tool_input: { subagent_type: 'planner' } }, repo);
  if (r.status !== 0) return `exit ${r.status}`;
  if (r.stdout.trim()) return `rewrote a spawn nobody re-routed: ${r.stdout.slice(0, 200)}`;
  return null;
});

t('model-route treats restating the shipped default as no re-route', (repo) => {
  withRouting(repo, { planner: 'opus' });
  const r = runHook('model-route.mjs', { tool_name: 'Agent', tool_input: { subagent_type: 'planner' } }, repo);
  if (r.status !== 0) return `exit ${r.status}`;
  if (r.stdout.trim()) return `reported a change nobody made: ${r.stdout.slice(0, 200)}`;
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

console.log('');
let bad = 0;
for (const [n, s] of results) {
  if (s !== 'ok') bad++;
  console.log(`${s === 'ok' ? ' OK ' : 'FAIL'}  ${n}${s === 'ok' ? '' : '\n        ' + s}`);
}
console.log(`\n${results.length - bad}/${results.length} passed`);
process.exit(bad ? 1 : 0);
