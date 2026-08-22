#!/usr/bin/env node
/**
 * Smoke test for the 9 hooks `gate-fixture.mjs` does not cover.
 *
 * `gate.mjs` earns a fixture of its own because it is the hook every other
 * guarantee depends on. The other nine were, for a while, verified by
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

function makeRepo({ phase = 'implement', withContract = true, git = true } = {}) {
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
    // forever. session-start used to skip these as "already harmless".
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

t('opus-budget does not count a Sonnet spawn', (repo) => {
  writeFileSync(join(repo, '.claude/spec-flow.config.json'), JSON.stringify({ max_opus_calls: 6 }));
  const r = runHook('opus-budget.mjs', { tool_name: 'Task', tool_input: { subagent_type: 'implementer' } }, repo);
  if (r.status !== 0) return `exit ${r.status}`;
  const f = join(repo, '.claude/state/opus_calls');
  if (existsSync(f) && readFileSync(f, 'utf8') !== '0' && readFileSync(f, 'utf8') !== '') {
    return `opus_calls became "${readFileSync(f, 'utf8')}" for a non-Opus spawn`;
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

console.log('');
let bad = 0;
for (const [n, s] of results) {
  if (s !== 'ok') bad++;
  console.log(`${s === 'ok' ? ' OK ' : 'FAIL'}  ${n}${s === 'ok' ? '' : '\n        ' + s}`);
}
console.log(`\n${results.length - bad}/${results.length} passed`);
process.exit(bad ? 1 : 0);
