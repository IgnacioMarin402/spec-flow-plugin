#!/usr/bin/env node
/**
 * The live view, one frame at a time.
 *
 * `watch.mjs` reads files several hooks write — the phase, the position, the
 * gate's history, the trace — and the transcripts `token-trace.mjs` names in
 * `token-offset`. Every one of those is a shape another file decides, so the
 * frame is asserted line by line against a synthetic run: a moved field would
 * otherwise leave a frame that draws fine and says nothing.
 *
 *   node scripts/watch-fixture.mjs [engine-root]
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { removeTemp } from './temp-dir.mjs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ENGINE = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const temps = [];

function check(name, fn) {
  try {
    const problem = fn();
    if (problem) failures.push({ name, problem });
  } catch (err) {
    failures.push({ name, problem: `threw: ${err?.stack ?? err}` });
  }
}

/** One assistant entry in the transcript shape token-fixture.mjs pins. */
const entry = ({ model = 'model-alpha', sidechain = false, out = 100, input = 10, cacheRead = 0, think = 0 } = {}) =>
  `${JSON.stringify({
    type: 'assistant',
    isSidechain: sidechain,
    message: { role: 'assistant', model, usage: { input_tokens: input, output_tokens: out, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0, output_tokens_details: { thinking_tokens: think } } },
  })}\n`;

/**
 * A repo mid-run: phase `implement`, M2 of add-thing, one gate pass, a trace
 * with reads and one closed agent, and a session transcript beside which two
 * subagents wrote — the planner, closed with PLAN_READY, and an implementer
 * still writing. `token-offset` names the session transcript the way the
 * hook writes it, which is how the watcher finds any of this.
 */
function run({ state = true, meta = true } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'watch-repo-'));
  temps.push(repo);
  if (!state) return repo;

  const stateDir = join(repo, '.claude', 'state');
  mkdirSync(stateDir, { recursive: true });
  const session = join(repo, 'transcripts', 'sess.jsonl');
  const agentsDir = join(repo, 'transcripts', 'sess', 'subagents');
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(session, entry({ out: 300, input: 50, cacheRead: 10_000 }));
  writeFileSync(join(agentsDir, 'agent-aaa111.jsonl'), entry({ sidechain: true, model: 'model-beta', out: 4_000, input: 12_000, cacheRead: 1_100_000, think: 2_000 }) + entry({ sidechain: true, model: 'model-beta', out: 100 }));
  writeFileSync(join(agentsDir, 'agent-bbb222.jsonl'), entry({ sidechain: true, out: 1_000, input: 3_000, cacheRead: 210_000 }));
  if (meta) {
    writeFileSync(join(agentsDir, 'agent-aaa111.meta.json'), JSON.stringify({ agentType: 'spec-flow:planner' }));
    writeFileSync(join(agentsDir, 'agent-bbb222.meta.json'), JSON.stringify({ agentType: 'spec-flow:implementer' }));
  }

  writeFileSync(join(stateDir, 'phase'), 'implement');
  writeFileSync(join(stateDir, 'phase.session'), 'orch-1');
  writeFileSync(join(stateDir, 'current-milestone'), 'add-thing M2 bbb222');
  writeFileSync(join(stateDir, 'gate_attempts'), '1');
  writeFileSync(join(stateDir, 'opus_calls'), '2');
  writeFileSync(join(stateDir, 'token-offset'), `${JSON.stringify({ files: { [session]: { bytes: 0 } } })}\n`);
  writeFileSync(
    join(stateDir, 'gate-history.log'),
    '2026-09-30T10:00:00Z 1a2b3c4 cc=? engine=fixture phase=implement attempt=0 result=pass lint=0 test=0 spec=0 files=2\n' +
      '2026-09-30T10:05:00Z 5d6e7f8 cc=? engine=fixture phase=implement attempt=1 result=fail:behaviour lint=0 test=1 spec=0 files=1\n',
  );
  writeFileSync(
    join(stateDir, 'run-trace.log'),
    '2026-09-30T10:01:00.000Z phase=plan session=orch-1 read file=specs/orders.md\n' +
      '2026-09-30T10:02:00.000Z phase=plan session=orch-1 agent type=spec-flow:planner status=PLAN_READY agent_id=aaa111\n' +
      '2026-09-30T10:03:00.000Z phase=implement session=orch-1 write file=lib/orders/ship.ts\n' +
      '2026-09-30T10:04:00.000Z phase=implement session=orch-1 test verdict=red target=tests/ship.spec.ts\n' +
      '2026-09-30T10:04:30.000Z phase=implement session=orch-1 tokens model=model-alpha sidechain=false in=50 out=300 cache_read=10000 cache_write=0 think=0 msgs=1\n',
  );
  return repo;
}

function watch(repo, ...args) {
  const res = spawnSync('node', [join(ENGINE, 'scripts', 'watch.mjs'), '--once', ...args], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
    cwd: tmpdir(),
  });
  return { code: res.status, out: `${res.stdout}${res.stderr}` };
}

const contains = (out, text) => (out.includes(text) ? '' : `expected the frame to contain "${text}".\n--- frame ---\n${out}`);

// ---- the frame ---------------------------------------------------------------

check('a frame names the phase, the position and the counters', () => {
  const { code, out } = watch(run());
  if (code !== 0) return `exited ${code}; this script must always exit 0.\n${out}`;
  return contains(out, 'phase implement (session orch-1)   M2 of add-thing (implementer bbb222)') || contains(out, 'gate failures in a row 1   planner+architect calls 2');
});

check('a closed agent shows its status and its cost; a running one shows since when', () => {
  const { out } = watch(run());
  return (
    contains(out, 'planner') ||
    contains(out, 'PLAN_READY') ||
    contains(out, 'in 12k  out 4k  cache_read 1.1M  think 2k  (2 msg)') ||
    contains(out, 'implementer') ||
    contains(out, 'RUNNING') ||
    contains(out, 'since ') ||
    contains(out, 'in 3k  out 1k  cache_read 210k  think 0  (1 msg)')
  );
});

check('a subagent with no .meta.json is shown by its id, not dropped', () => {
  const { out } = watch(run({ meta: false }));
  return contains(out, 'agent-aaa111') || contains(out, 'agent-bbb222');
});

check("the gate's last verdict and its tally are on the frame", () => {
  const { out } = watch(run());
  return contains(out, 'last fail:behaviour 5d6e7f8 (lint 0, test 1)') || contains(out, '1 pass, 1 fail:behaviour');
});

check('the trace tail shows events and not token lines, newest last', () => {
  const { out } = watch(run(), '--lines', '2');
  const tail = out.slice(out.indexOf('Trace (last 2)'), out.indexOf('Cost'));
  return (
    contains(tail, 'write file=lib/orders/ship.ts') ||
    contains(tail, 'test verdict=red target=tests/ship.spec.ts') ||
    (tail.includes('tokens model=') ? `a token line leaked into the trace tail:\n${tail}` : '') ||
    (tail.includes('read file=specs/orders.md') ? `--lines 2 showed more than two events:\n${tail}` : '')
  );
});

check('the cost is read live off the transcripts, one row per model and chain', () => {
  const { out } = watch(run());
  return contains(out, 'model-beta   subagent  in 12k  out 4k  cache_read 1.1M  think 2k  (2 msg)') || contains(out, 'model-alpha  main      in 50  out 300') || contains(out, 'live, read off the transcripts');
});

check('before the first stop the transcripts are not located, and the frame says so', () => {
  const repo = run();
  writeFileSync(join(repo, '.claude', 'state', 'token-offset'), '');
  const { code, out } = watch(repo);
  if (code !== 0) return `exited ${code}\n${out}`;
  return contains(out, 'transcripts not located yet') || contains(out, 'as recorded at the last stop');
});

check('a repo that never adopted the flow gets one line, exit 0 and no .claude/ directory', () => {
  const repo = run({ state: false });
  const { code, out } = watch(repo);
  if (code !== 0) return `exited ${code}\n${out}`;
  if (existsSync(join(repo, '.claude'))) return 'the watcher created .claude/ in a repo that never had one';
  return contains(out, 'no run is armed here');
});

for (const t of temps) removeTemp(t);

if (failures.length > 0) {
  console.error(`watch-fixture: ${failures.length} case(s) failed\n`);
  for (const f of failures) console.error(`  - ${f.name}\n    ${f.problem}\n`);
  process.exit(1);
}
console.log('watch-fixture: OK — a frame names the run, every agent with its status and cost, the gate, the trace tail and the live totals.');
