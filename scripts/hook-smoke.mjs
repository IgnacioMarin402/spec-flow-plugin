#!/usr/bin/env node
/**
 * Smoke test for the 8 hooks `gate-fixture.mjs` does not cover.
 *
 * `gate.mjs` earns a fixture of its own because it is the hook every other
 * guarantee depends on. The other eight were, for a while, verified by
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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ENGINE = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];

function makeRepo({ phase = 'implement', withContract = true } = {}) {
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
        trace: { specs_dir: 'specs', proof_dir: 'application', proof_suffix: '.spec.ts', not_a_capability: [] },
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
  return repo;
}

function runHook(hook, payload, repo) {
  return spawnSync('node', [join(ENGINE, 'hooks', hook)], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
    cwd: tmpdir(),
  });
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

t('session-start leaves a fresh phase alone', (repo) => {
  const r = runHook('session-start.mjs', {}, repo);
  if (r.status !== 0) return `exit ${r.status}`;
  const phase = readFileSync(join(repo, '.claude/state/phase'), 'utf8');
  if (phase !== 'implement') return `phase is "${phase}", expected implement (untouched)`;
  return null;
});

t('done-guard denies done with an unarchived specflow folder', (repo) => {
  mkdirSync(join(repo, 'specflow', 'my-change'), { recursive: true });
  const r = runHook(
    'done-guard.mjs',
    { tool_name: 'Bash', tool_input: { command: "printf 'done' > .claude/state/phase" } },
    repo,
  );
  if (r.status !== 2) return `exit ${r.status}, expected 2 (deny). stderr: ${r.stderr.slice(0, 300)}`;
  if (!r.stderr.includes('unarchived')) return `stderr: ${r.stderr.slice(0, 300)}`;
  return null;
});

t('done-guard allows an earned done', (repo) => {
  const r = runHook(
    'done-guard.mjs',
    { tool_name: 'Bash', tool_input: { command: "printf 'done' > .claude/state/phase" } },
    repo,
  );
  if (r.status !== 0) return `exit ${r.status}, expected 0. stderr: ${r.stderr.slice(0, 300)}`;
  return null;
});

t('done-guard ignores an unrelated command', (repo) => {
  mkdirSync(join(repo, 'specflow', 'my-change'), { recursive: true });
  const r = runHook('done-guard.mjs', { tool_name: 'Bash', tool_input: { command: 'git status' } }, repo);
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
