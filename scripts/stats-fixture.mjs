#!/usr/bin/env node
/**
 * Behaviour fixture for scripts/specflow-stats.mjs — the session-reuse
 * section, and the tier merge every section is built on.
 *
 * Every case runs the real script as a child process against a synthetic
 * repo, because that script's whole surface is what it prints: it exports
 * nothing, gates nothing and always exits 0, so reading its return value
 * would assert nothing at all.
 *
 * The case that carries the design is `a file read in two milestones is not a
 * re-read`. Counting repeated paths across a whole run is the obvious
 * implementation and it is wrong: a fresh session per milestone is the
 * contract, so re-reading in the NEXT milestone is expected and only a repeat
 * INSIDE one is the cold-start cost. A run-wide tally reports the expected
 * case as waste, which is worse than not measuring it.
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATS = join(HERE, 'specflow-stats.mjs');
const failures = [];

const CONTRACT = JSON.stringify({
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

/** `at` is minutes past a fixed origin, so a case reads as an ordering. */
const stamp = (minute) => new Date(Date.UTC(2026, 7, 21, 10, minute)).toISOString().replace(/\.\d+Z$/, 'Z');
const read = (minute, file, session) =>
  `${stamp(minute)} phase=implement${session ? ` session=${session}` : ''} read file=${file}`;
const readIn = (minute, phase, file) => `${stamp(minute)} phase=${phase} read file=${file}`;
const agent = (minute, type, session) =>
  `${stamp(minute)} phase=implement${session ? ` session=${session}` : ''} agent type=${type} status=DONE`;
const pass = (minute) =>
  `${stamp(minute)} abc1234 cc=1.0 engine=0.1.0 phase=implement attempt=1 result=pass lint=0 test=0 unscoped=ok files=1`;

/**
 * Builds a repo holding exactly these log lines and returns what stats printed.
 *
 * `archived` writes snapshots under `specflow/archive/<slug>/telemetry/`, the
 * second tier the script reads. Passing the SAME lines in both tiers is what
 * a run taken on this machine actually looks like on disk, since a snapshot is
 * a slice of the live log rather than a separate recording.
 *
 * `files` are written into the repo as given (a spec, a milestone, a
 * capability spec), and `traceFor` builds live lines that need the repo's own
 * path — a read the tool was handed as an absolute path, which is how a real
 * trace spells every one.
 *
 * @param {{
 *   trace?: string[],
 *   gate?: string[],
 *   archived?: { slug: string, gate?: string[], trace?: string[] }[],
 *   files?: Record<string, string>,
 *   traceFor?: (repo: string) => string[],
 * }} lines
 */
function report({ trace = [], gate = [], archived = [], files = {}, traceFor = () => [] }) {
  const repo = mkdtempSync(join(tmpdir(), 'spec-flow-stats-'));
  try {
    mkdirSync(join(repo, '.claude', 'state'), { recursive: true });
    mkdirSync(join(repo, '.spec-flow'), { recursive: true });
    writeFileSync(join(repo, '.spec-flow', 'config.json'), CONTRACT);
    writeFileSync(join(repo, '.claude', 'state', 'phase'), 'implement');
    const live = [...trace, ...traceFor(repo)];
    writeFileSync(join(repo, '.claude', 'state', 'run-trace.log'), live.join('\n') + (live.length ? '\n' : ''));
    writeFileSync(join(repo, '.claude', 'state', 'gate-history.log'), gate.join('\n') + (gate.length ? '\n' : ''));

    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, rel)), { recursive: true });
      writeFileSync(join(repo, rel), body);
    }

    for (const snapshot of archived) {
      const dir = join(repo, 'specflow', 'archive', snapshot.slug, 'telemetry');
      mkdirSync(dir, { recursive: true });
      // CRLF on purpose: telemetry-snapshot.mjs writes with the platform's
      // ending, so a snapshot committed from Windows reaches a reader as CRLF
      // while the live log it was sliced from is LF. Two spellings of one line
      // must not read as two invocations.
      /** @type {[string, string[] | undefined][]} */
      const logs = [['gate-history.log', snapshot.gate], ['run-trace.log', snapshot.trace]];
      for (const [file, body] of logs) {
        if (!body?.length) continue;
        writeFileSync(join(dir, file), `${body.join('\r\n')}\r\n`);
      }
    }

    const res = spawnSync(process.execPath, [STATS], {
      cwd: repo,
      env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
      encoding: 'utf8',
    });
    return { code: res.status, out: `${res.stdout}${res.stderr}` };
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function check(name, fn) {
  try {
    const problem = fn();
    if (problem) failures.push({ name, problem });
  } catch (err) {
    failures.push({ name, problem: `threw: ${err?.stack ?? err}` });
  }
}

const contains = (out, text) => (out.includes(text) ? '' : `expected the report to contain "${text}".\n--- report ---\n${out}`);

/**
 * Whether the report CLAIMS a cross-session split, as opposed to explaining
 * that it could not make one. A bare substring match catches the disclaimer
 * itself, which would fail the two cases asserting that the disclaimer is
 * exactly what gets printed.
 */
const claimsSplit = (out) => /\d+ across sessions/.test(out) || /re-read across sessions:/.test(out);

// ---- the cases ------------------------------------------------------------

check('one implementer session and no repeat reads is the clean case', () => {
  const { code, out } = report({
    trace: [read(1, 'x/one.ts'), agent(2, 'implementer'), read(3, 'x/two.ts')],
    gate: [pass(4)],
  });
  if (code !== 0) return `exited ${code}; this script must always exit 0.`;
  return (
    contains(out, 'milestone 1: 1 implementer session(s), no file read twice') ||
    (out.includes('spawned the implementer') ? `warned about spawns when there was only one.\n--- report ---\n${out}` : '')
  );
});

check('a second implementer spawn inside one milestone is reported and warned', () => {
  const { code, out } = report({
    trace: [agent(1, 'implementer'), read(2, 'x/one.ts'), agent(3, 'implementer'), read(4, 'x/one.ts')],
    gate: [pass(5)],
  });
  if (code !== 0) return `exited ${code}; this script must always exit 0.`;
  return (
    contains(out, 'milestone 1: 2 implementer session(s)') ||
    contains(out, 'spawned the implementer 2 times')
  );
});

// The harness reports a plugin's agents namespaced, and every real trace line
// carries `spec-flow:<role>`. Written bare, as the cases above are, these
// sections cannot tell whether they ever fire on a real run.
check('a namespaced implementer is counted in its milestone', () => {
  const { out } = report({
    trace: [agent(1, 'spec-flow:implementer'), read(2, 'x/one.ts'), agent(3, 'spec-flow:implementer')],
    gate: [pass(5)],
  });
  return contains(out, 'milestone 1: 2 implementer session(s)');
});

check('a namespaced reviewer is the reviewer, so its rubber-stamp check runs', () => {
  const approved = (minute) => `${stamp(minute)} phase=review agent type=spec-flow:reviewer status=APPROVED`;
  const { out } = report({ trace: [approved(1), approved(2), approved(3)] });
  return contains(out, 'reviewer: 3 APPROVED') || contains(out, 'the reviewer approved all 3 plan(s)');
});

check('the same file read twice inside one milestone counts as a re-read', () => {
  const { out } = report({
    trace: [agent(1, 'implementer'), read(2, 'x/one.ts'), read(3, 'x/one.ts'), read(4, 'x/one.ts')],
    gate: [pass(5)],
  });
  return contains(out, '1 file(s) re-read, 2 extra read(s)') || contains(out, 'most re-read: one.ts +2');
});

check('a file read in two DIFFERENT milestones is not a re-read', () => {
  const { out } = report({
    trace: [agent(1, 'implementer'), read(2, 'x/one.ts'), agent(5, 'implementer'), read(6, 'x/one.ts')],
    gate: [pass(3), pass(7)],
  });
  return (
    contains(out, 'milestone 1: 1 implementer session(s), no file read twice') ||
    contains(out, 'milestone 2: 1 implementer session(s), no file read twice') ||
    (out.includes('most re-read:') ? `counted a cross-milestone read as a re-read.\n--- report ---\n${out}` : '')
  );
});

check('work after the last PASS is still a milestone, marked as unfinished', () => {
  const { out } = report({
    trace: [agent(1, 'implementer'), read(2, 'x/one.ts'), agent(4, 'implementer'), read(5, 'x/two.ts')],
    gate: [pass(3)],
  });
  return contains(out, 'milestone 2 (never reached a PASS): 1 implementer session(s)');
});

// ---- attribution: which SESSION did the re-reading -------------------------
//
// The four cases below are one question — is a repeated read context churn or
// a cold start — and the report has to be able to say it does not know. Two
// of them assert exactly that, because the number is identical in all four
// and only the session ids tell them apart.

check('a file re-read by two sessions inside one milestone is the cold-start cost', () => {
  const { out } = report({
    trace: [agent(1, 'implementer', 's1'), read(2, 'x/one.ts', 's1'), agent(3, 'implementer', 's1'), read(4, 'x/one.ts', 's2')],
    gate: [pass(5)],
  });
  return (
    contains(out, '1 across sessions') ||
    contains(out, 're-read across sessions: one.ts x1') ||
    contains(out, 'the only re-read a cache could remove')
  );
});

check('the same session re-reading its own file is not counted across sessions', () => {
  const { out } = report({
    trace: [agent(1, 'implementer', 's1'), read(2, 'x/one.ts', 's1'), read(3, 'x/one.ts', 's1')],
    gate: [pass(4)],
  });
  return (
    contains(out, '1 file(s) re-read, 1 extra read(s)') ||
    (claimsSplit(out) ? `one session's own re-read was reported as a cold start.\n--- report ---\n${out}` : '')
  );
});

check('a trace with no session ids reports attribution as unavailable, not as zero', () => {
  const { out } = report({
    trace: [agent(1, 'implementer'), read(2, 'x/one.ts'), read(3, 'x/one.ts')],
    gate: [pass(4)],
  });
  return (
    contains(out, 'attribution: UNAVAILABLE') ||
    (claimsSplit(out) ? `claimed a split over a trace that carries no session id.\n--- report ---\n${out}` : '')
  );
});

check('one session id across several spawns is reported as unmeasured, not as reuse', () => {
  // `hooks/lib/io.mjs` records that whether a subagent's payload carries its
  // own session id or its parent's is undocumented. This is what the second
  // looks like from the report, and reading it as perfect session reuse is
  // the wrong conclusion drawn from a real trace.
  const { out } = report({
    trace: [agent(1, 'implementer', 's1'), read(2, 'x/one.ts', 's1'), agent(3, 'architect', 's1'), read(4, 'x/one.ts', 's1')],
    gate: [pass(5)],
  });
  return (
    contains(out, 'attribution: ONE session id across 2 subagent spawn(s)') ||
    contains(out, 'treat those numbers as unmeasured, not as zero')
  );
});

// A subagent's tool call carries its parent's session id and its own
// agent_id (Claude Code 2.1.294). Read by session, two implementers look like
// one; read by agent, the second one's cold start is visible.
check('reads attributed to two agents under one spawner session are two sessions', () => {
  const { out } = report({
    trace: [
      agent(1, 'implementer', 's1'),
      `${read(2, 'x/one.ts', 's1')} agent_id=a1`,
      agent(3, 'implementer', 's1'),
      `${read(4, 'x/one.ts', 's1')} agent_id=a2`,
    ],
    gate: [pass(5)],
  });
  return contains(out, 're-read across sessions: one.ts x1') || contains(out, 'across 2 session(s)');
});

// Token lines name the agent whose transcript they were read from; the
// return line names its role and effort. Joined, a run's cost reads by role.
check("a run's tokens are reported by role, with the orchestrator apart", () => {
  const tok = (minute, sidechain, out, agentId) =>
    `${stamp(minute)} phase=implement tokens model=model-alpha sidechain=${sidechain} in=10 out=${out} cache_read=0 cache_write=0 think=0 msgs=1 max_prompt=12000${agentId ? ` agent_id=${agentId}` : ''}`;
  const { out } = report({
    trace: [
      `${agent(1, 'spec-flow:reviewer', 's1')} effort=low agent_id=a1`,
      tok(2, 'true', 300, 'a1'),
      tok(3, 'false', 900),
      tok(4, 'true', 50, 'a9'),
    ],
    gate: [pass(5)],
  });
  return (
    contains(out, 'orchestrator  model-alpha  in 10  out 900') ||
    contains(out, 'reviewer (1 agent(s), effort low)  model-alpha  in 10  out 300') ||
    contains(out, 'unattributed (1 agent(s))  model-alpha  in 10  out 50') ||
    contains(out, 'largest prompt 12k')
  );
});

// A role's cost is how many messages it sent times the prompt each re-read:
// the orchestrator's 30 messages at ~115k each were most of a real fix run.
check('each role reports its messages and its average prompt per message', () => {
  const tok = (minute, msgs, cacheRead) =>
    `${stamp(minute)} phase=implement tokens model=model-alpha sidechain=false in=10 out=100 cache_read=${cacheRead} cache_write=${cacheRead / 10} think=0 msgs=${msgs} max_prompt=60000`;
  const subagent = `${stamp(4)} phase=implement tokens model=model-alpha sidechain=true in=1 out=1 cache_read=0 cache_write=0 think=0 msgs=1 max_prompt=9 agent_id=a1`;
  const { out } = report({ trace: [`${agent(1, 'spec-flow:reviewer', 's1')} agent_id=a1`, tok(2, 2, 100000), tok(3, 3, 200000), subagent], gate: [pass(5)] });
  return contains(out, 'largest prompt 60k  5 msg, ~66k prompt/msg');
});

// The measure the implementer experiment decides on: a PASS with no failure
// since the previous PASS. A failure before the first PASS counts against it;
// skip-dirty and running lines are not failures.
check('passed-the-first-time counts a PASS with no failure since the previous one', () => {
  const fail = (minute) =>
    `${stamp(minute)} abc1234 cc=1.0 engine=0.1.0 phase=implement attempt=1 result=fail lint=0 test=1 unscoped=ok files=1`;
  const dirty = (minute) => `${stamp(minute)} abc1234 cc=1.0 engine=0.1.0 phase=implement attempt=0 result=skip-dirty lint=- test=- unscoped=- files=1`;
  const { out } = report({ gate: [fail(1), pass(2), dirty(3), pass(4), fail(5), fail(6), pass(7)] });
  return contains(out, 'passed the first time: 1 of 3 PASS(es)');
});

check('returns the agent gate sent back are counted by why, and so are the ones let through or not fully judged', () => {
  const line = (minute, result, why) => `${stamp(minute)} phase=review agent-check agent=spec-flow:reviewer result=${result} why=${why} agent_id=a1`;
  const { out } = report({
    trace: [line(1, 'block', 'no-status'), line(2, 'block', 'no-status'), line(3, 'cap', 'no-status'), line(4, 'skip', 'unattributed'), `${agent(5, 'spec-flow:reviewer', 's1')} agent_id=a1`],
    gate: [pass(6)],
  });
  return (
    contains(out, 'agent gate: 2 return(s) sent back (no-status x2), 1 let through at the cap (no-status x1), 1 not fully judged (unattributed x1).') ||
    contains(out, 'reviewer: 1 DONE')
  );
});

// What the orchestrator dispatched off the commands' contract (ADR-035): the
// guard's records by agent and reason, and how often arm-gate moved the phase.
check("dispatches off the commands' contract are counted by agent and reason, and so are the gate's armings", () => {
  const line = (minute, phase, who, result, why) => `${stamp(minute)} phase=${phase} session=s dispatch agent=${who} tool=Agent result=${result} why=${why}`;
  const { out } = report({
    trace: [
      line(1, 'implement', 'reviewer', 'record', 'phase'),
      line(2, 'implement', 'implementer', 'record', 'no-milestone,other-files'),
      line(3, 'plan', 'implementer', 'armed', 'phase'),
      line(4, 'spec', 'implementer', 'deny', 'case-3-unanswered'),
    ],
    gate: [pass(5)],
  });
  return (
    contains(
      out,
      "dispatch: 2 off the commands' contract (reviewer:phase x1, implementer:no-milestone x1, implementer:other-files x1), recorded, not denied; the gate armed by arm-gate 1 time(s), the implementer denied 1 time(s) (implementer:case-3-unanswered x1).",
    ) ||
    contains(out, 'read the `dispatch` lines with --raw')
  );
});

// This flow's agents put to work with no run phase (ADR-040): told apart from
// the rules ADR-035 weighs, since nothing counted or traced them.
const noRun = (minute, phase, who) => `${stamp(minute)} phase=${phase} session=s dispatch agent=${who} tool=Agent result=record why=no-run`;
check('a spec-writer or planner with no run phase reads as a run that skipped step 0', () => {
  const { out } = report({ trace: [noRun(1, 'done', 'spec-writer'), noRun(2, 'done', 'planner')], gate: [pass(3)] });
  if (out.includes('read the `dispatch` lines with --raw')) return `no-run dispatches were reported as rules to weigh:\n${out}`;
  return (
    contains(out, "dispatch: 0 off the commands' contract, recorded, not denied") ||
    contains(out, '2 spec-writer or planner spawn(s) with no run phase (spec-writer:no-run x1, planner:no-run x1)')
  );
});

// A question to the architect between runs lands before the next `--mark`: no
// snapshot takes it, so it stays in `(current)` through every later report.
check('any other agent outside a run is reported, not warned about, and is no run', () => {
  const { out } = report({
    trace: [noRun(9, 'done', 'architect'), noRun(10, 'done', 'implementer')],
    archived: [{ slug: 'refunds', gate: [pass(5)], trace: [agent(4, 'spec-flow:implementer')] }],
  });
  if (out.includes('skipped writing `spec`')) return `a question between runs read as a skipped step 0:\n${out}`;
  if (out.includes('across 2 run(s)')) return `the slice holding only outside-run lines was counted as a run:\n${out}`;
  return contains(out, "outside a run: 2 of this flow's agent(s) put to work (architect:no-run x1, implementer:no-run x1)");
});

// orchestrator-scope stands down until the trace shows agent ids (ADR-034);
// a run where it never armed must not read as one where nothing was denied.
check('a run where orchestrator-scope or the case 3 check stood down says so', () => {
  const { out } = report({
    gate: [pass(1)],
    files: { '.claude/state/orchestrator-scope-unmatched.log': 'x phase=spec tool=Read unattributed\n', '.claude/state/human-turn-unmatched.log': 'x case-3 check stood down\n' },
  });
  return contains(out, 'note: 1 session calls orchestrator-scope let through') || contains(out, 'note: 1 case 3 checks that stood down');
});

check('no telemetry at all says so, and still exits 0', () => {
  const { code, out } = report({});
  if (code !== 0) return `exited ${code} on an empty repo; this script must always exit 0.`;
  return contains(out, 'Session reuse') || contains(out, 'no run trace yet');
});

// ---- reads against the change's scope --------------------------------------
//
// The scope is read off two artifacts the change already carries: the deltas
// in its spec, resolved through the capability spec's `spec-scope` marker,
// and the paths its milestones name. A run whose artifacts name neither has
// to say UNKNOWN: "0 outside the scope" over a scope of nothing is the number
// this report exists to refuse.

const ORDERS_SPEC = '<!-- spec-scope: lib/orders -->\n\n# Orders\n\n### REQ-ORDERS-001 — an order is placed\n\nThe system places it.\n';
const CHANGE = {
  'spec.md': '# Spec — ship-orders: ship an order\n\n## User stories\n- **US-1** — as a clerk I ship an order\n\n## Requirement deltas\n- ADDED REQ-ORDERS-002 — an order ships\n\n## Out of scope\nnone\n',
  'milestones/M1.md':
    '# M1 — ship (covers US-1)\n\n- Objective: ship\n- Skills: none\n- Files to add/change: lib/orders/ship.ts, tests/orders-ship.spec.ts\n- Steps: one\n- Spec deltas: ADDED REQ-ORDERS-002\n- Tests to add/change: tests/orders-ship.spec.ts — REQ-ORDERS-002 ships\n- What this could break: nothing outside the deltas, it adds a file\n- Depends on: none\n',
};
const changeFiles = (base) => Object.fromEntries(Object.entries(CHANGE).map(([rel, body]) => [`${base}/${rel}`, body]));

check('reads are split against the scope read off the deltas and the milestone paths', () => {
  const { out } = report({
    files: { 'specs/orders.md': ORDERS_SPEC, ...changeFiles('specflow/archive/ship-orders') },
    archived: [
      {
        slug: 'ship-orders',
        trace: [
          readIn(1, 'plan', 'lib/orders/place.ts'),
          readIn(2, 'plan', 'lib/billing/invoice.ts'),
          readIn(3, 'plan', 'lib/billing/tax.ts'),
          readIn(4, 'plan', 'lib/billing/refund.ts'),
          readIn(5, 'plan', 'specs/orders.md'),
          readIn(6, 'plan', '/opt/elsewhere/engine/scripts/gate.mjs'),
        ],
      },
    ],
  });
  return (
    contains(out, 'ship-orders: scope lib/orders, tests (from specs/orders.md, 2 milestone path(s))') ||
    contains(out, 'plan: 6 read(s), 4 outside the scope — lib/billing x3, (outside the repository) x1') ||
    contains(out, "the planner read more outside the change's scope (4) than inside it (2)")
  );
});

check('a planner reading mostly inside the scope is reported and not warned about', () => {
  const { out } = report({
    files: { 'specs/orders.md': ORDERS_SPEC, ...changeFiles('specflow/archive/ship-orders') },
    archived: [{ slug: 'ship-orders', trace: [readIn(1, 'plan', 'lib/orders/place.ts'), readIn(2, 'plan', 'lib/orders/cancel.ts'), readIn(3, 'plan', 'lib/billing/tax.ts')] }],
  });
  return (
    contains(out, 'plan: 3 read(s), 1 outside the scope — lib/billing x1') ||
    (out.includes('read more outside') ? `warned about a planner that mostly stayed inside the scope.\n--- report ---\n${out}` : '')
  );
});

check('a change whose scope cannot be derived reports UNKNOWN, not zero', () => {
  const { out } = report({
    files: { 'specflow/archive/mystery/spec.md': '# Spec — mystery\n\n## Requirement deltas\n- none — wiring only\n' },
    archived: [{ slug: 'mystery', trace: [readIn(1, 'plan', 'lib/billing/tax.ts')] }],
  });
  return (
    contains(out, 'mystery: scope UNKNOWN') ||
    (out.includes('outside the scope') ? `counted reads against a scope that could not be derived.\n--- report ---\n${out}` : '')
  );
});

check("an absolute path under the repo is the repo's own file, whichever slashes it carries, and a live change scopes the current run", () => {
  const { out } = report({
    files: { 'specs/orders.md': ORDERS_SPEC, ...changeFiles('specflow/ship-orders') },
    traceFor: (repo) => [readIn(1, 'plan', join(repo, 'lib', 'orders', 'place.ts')), readIn(2, 'plan', join(repo, 'lib', 'billing', 'tax.ts'))],
  });
  return (
    contains(out, 'scope lib/orders, tests (from specs/orders.md, 2 milestone path(s))') ||
    contains(out, 'plan: 2 read(s), 1 outside the scope — lib/billing x1')
  );
});

// ---- the two tiers overlap, and only one of them is a separate run ---------
//
// `telemetry-snapshot.mjs` copies a slice of `.claude/state/` into the change
// folder, so a run taken on this machine is present in BOTH tiers. Reading
// them as independent runs inflates every number the report prints, and the
// inflation is invisible: it scales the totals without producing a line
// anyone can point at as wrong.
//
// The archived tier wins the tie because it carries the run's slug; a live
// line with no snapshot is work not yet archived and stays.

check('a snapshot that duplicates the live log is one invocation, not two', () => {
  const line = pass(4);
  const { out } = report({ gate: [line], archived: [{ slug: 'shipped', gate: [line] }] });
  return (
    contains(out, '1 invocation(s)') ||
    (/2 invocation\(s\)/.test(out) ? `counted one gate invocation twice, once per tier.\n--- report ---\n${out}` : '')
  );
});

check('a live line with no snapshot yet is still counted', () => {
  const { out } = report({ gate: [pass(4), pass(6)], archived: [{ slug: 'shipped', gate: [pass(4)] }] });
  return (
    contains(out, '2 invocation(s)') ||
    (/3 invocation\(s\)/.test(out) ? `double-counted the archived line.\n--- report ---\n${out}` : '')
  );
});

check('a milestone held in both tiers is reported once', () => {
  const trace = [agent(1, 'implementer'), read(2, 'x/one.ts'), read(3, 'x/one.ts')];
  const gate = [pass(4)];
  const { out } = report({ trace, gate, archived: [{ slug: 'shipped', trace, gate }] });
  const seen = (out.match(/milestone 1:/g) ?? []).length;
  return seen === 1 ? '' : `milestone 1 was reported ${seen} time(s); the run exists in both tiers but happened once.\n--- report ---\n${out}`;
});

// A snapshot is committed and read from other checkouts. Recorded on Windows
// under another user's directory, every read pointed "outside the repository"
// from here, and the planner warning fired on reads that were all in scope.
check('an archived run recorded under another root reads as this repo', () => {
  const recorded = 'C:\\Users\\someone\\work\\shop';
  const at = (rel) => `${recorded}\\${rel.replace(/\//g, '\\')}`;
  const { out } = report({
    files: { 'specs/orders.md': ORDERS_SPEC, ...changeFiles('specflow/archive/ship-orders') },
    archived: [
      {
        slug: 'ship-orders',
        trace: [
          readIn(1, 'plan', at('specflow/ship-orders/spec.md')),
          readIn(2, 'plan', at('lib/orders/place.ts')),
          readIn(3, 'plan', at('lib/billing/tax.ts')),
          readIn(4, 'plan', 'C:\\Users\\someone\\AppData\\engine\\scripts\\gate.mjs'),
        ],
      },
    ],
  });
  return contains(out, 'plan: 4 read(s), 2 outside the scope — lib/billing x1, (outside the repository) x1');
});

// ---- test-first: a test written, run red, then the code ---------------------
const write = (minute, file) => `${stamp(minute)} phase=implement write file=${file}`;
const ran = (minute, verdict, why) => `${stamp(minute)} phase=implement test verdict=${verdict} target=tests/orders/place.spec.ts${why ? ` why=${why}` : ''}`;
/** The Test-first section alone: the warnings below it carry other sections' words. */
const testFirst = (out) => /^Test-first\n([\s\S]*?)\n\n/m.exec(out)?.[1] ?? '';

check('a test written, run red, then its code is red-first', () => {
  const { out } = report({ trace: [write(1, 'tests/orders/place.spec.ts'), ran(2, 'red'), write(3, 'lib/orders/place.ts')] });
  return contains(testFirst(out), 'OK   lib/orders/place.ts  (red-first)');
});

check('code written before its test is code-first', () => {
  const { out } = report({ trace: [write(1, 'lib/orders/place.ts'), write(2, 'tests/orders/place.spec.ts')] });
  return contains(testFirst(out), 'MISS lib/orders/place.ts  (code-first)');
});

// The fabricated verdict: an agent reading a module and then its test, both
// long written, read as "code first" — every module a planner or implementer
// looked at turned up as a test-first MISS of the run that looked.
check('a module and its test that were only read are not paired', () => {
  const { out } = report({ trace: [read(1, 'lib/orders/place.ts'), read(2, 'tests/orders/place.spec.ts'), write(3, 'lib/other.ts')] });
  return testFirst(out).includes('place.ts') ? `paired two files that were only read.\n--- report ---\n${out}` : '';
});

// A run the trace could not judge is not a run that did not happen. Reported
// as one, every red run run-trace failed to read became a "no red run" MISS.
check('a test run with no readable verdict is unmeasured, not missed', () => {
  const { out } = report({ trace: [write(1, 'tests/orders/place.spec.ts'), ran(2, '?', 'pipe'), write(3, 'lib/orders/place.ts')] });
  const section = testFirst(out);
  if (section.includes('no-red-run')) return `reported an unreadable run as no red run.\n--- report ---\n${out}`;
  return contains(section, '?    lib/orders/place.ts  (a test run the trace could not judge: pipe)') || contains(out, 'unmeasured, not missed');
});

check('a `?` from before why= existed is unmeasured too', () => {
  const { out } = report({ trace: [write(1, 'tests/orders/place.spec.ts'), ran(2, '?'), write(3, 'lib/orders/place.ts')] });
  return contains(testFirst(out), '(a test run the trace could not judge: not-recorded)');
});

check('a `?` that was not a failed test run leaves the miss standing', () => {
  const { out } = report({ trace: [write(1, 'tests/orders/place.spec.ts'), ran(2, '?', 'not-the-runner'), write(3, 'lib/orders/place.ts')] });
  return contains(testFirst(out), 'MISS lib/orders/place.ts  (no-red-run)');
});

check('the test-first warning counts source files and the runs they span', () => {
  const trace = [write(1, 'tests/orders/place.spec.ts'), write(2, 'lib/orders/place.ts')];
  const { out } = report({ archived: [{ slug: 'one', trace }, { slug: 'two', trace: trace.map((l) => l.replace('10:0', '11:0')) }] });
  return contains(out, '2 of 2 source file(s) across 2 runs show no red test run before the code');
});

// A verdict is evidence for the test it ran, not for every test written
// before it. One real milestone wrote three tests and ran one; all three were
// credited with that one run.
const ranOn = (minute, verdict, target, why) => `${stamp(minute)} phase=implement test verdict=${verdict} target=${target}${why ? ` why=${why}` : ''}`;
const threePairs = (...runs) => [
  write(1, 'tests/orders/place.spec.ts'),
  write(2, 'tests/orders/cancel.spec.ts'),
  write(3, 'tests/orders/ship.spec.ts'),
  ...runs,
  write(20, 'lib/orders/place.ts'),
  write(21, 'lib/orders/cancel.ts'),
  write(22, 'lib/orders/ship.ts'),
];

check('a red run of one test credits that test alone', () => {
  const section = testFirst(report({ trace: threePairs(ranOn(10, 'red', 'tests/orders/place.spec.ts')) }).out);
  return (
    contains(section, 'OK   lib/orders/place.ts  (red-first)') ||
    contains(section, 'MISS lib/orders/cancel.ts  (no-red-run)') ||
    contains(section, 'MISS lib/orders/ship.ts  (no-red-run)')
  );
});

check('an unreadable run of one test leaves the others missed, not unmeasured', () => {
  const section = testFirst(report({ trace: threePairs(ranOn(10, '?', 'tests/orders/place.spec.ts', 'pipe')) }).out);
  return contains(section, '?    lib/orders/place.ts  (a test run the trace could not judge: pipe)') || contains(section, 'MISS lib/orders/ship.ts  (no-red-run)');
});

check('a red run of the tests\' directory credits each test under it', () => {
  const section = testFirst(report({ trace: threePairs(ranOn(10, 'red', 'tests/orders')) }).out);
  return ['place', 'cancel', 'ship'].map((m) => contains(section, `OK   lib/orders/${m}.ts  (red-first)`)).find(Boolean) ?? '';
});

check('a red run that names no path is unjudged, not credited', () => {
  const section = testFirst(report({ trace: threePairs(ranOn(10, 'red', '-')) }).out);
  return contains(section, '?    lib/orders/ship.ts  (a test run the trace could not judge: no-path)');
});

// A whole-suite run with its output thrown away, as an older trace recorded it.
check('a target holding only a redirection names no path', () => {
  const section = testFirst(report({ trace: threePairs(ranOn(10, 'red', '>/dev/null;')) }).out);
  return contains(section, '?    lib/orders/ship.ts  (a test run the trace could not judge: no-path)');
});

// jest and vitest match an argument anywhere in a path: `place.spec.ts` runs
// `replace.spec.ts` too, so that run may have been this test's.
check('a name found inside a test\'s name, not at a path segment, is unjudged', () => {
  const trace = [write(1, 'tests/orders/replace.spec.ts'), ranOn(2, 'red', 'place.spec.ts'), write(3, 'lib/orders/replace.ts')];
  return contains(testFirst(report({ trace }).out), '?    lib/orders/replace.ts  (a test run the trace could not judge: pattern)');
});

// A MISS says no red run happened: a run that loaded a config or a module, or
// matched a glob, ran a suite the trace cannot see into.
check('a run naming only a config, a module, or a glob is unjudged, never a miss', () => {
  const section = testFirst(
    report({ trace: threePairs(ranOn(10, 'red', 'config/unit.json'), ranOn(11, 'red', 'ts-node/register'), ranOn(12, 'red', 'tests/orders/*.spec.ts')) }).out,
  );
  return contains(section, '?    lib/orders/ship.ts  (a test run the trace could not judge: no-test-path,glob)');
});

check('a run of another directory of tests is not a run of these', () => {
  return contains(testFirst(report({ trace: threePairs(ranOn(10, 'red', 'tests/billing')) }).out), 'MISS lib/orders/ship.ts  (no-red-run)');
});

check('a target is matched past ./, ../, a subshell paren, and from Git Bash', () => {
  const at = (p) => `C:\\Users\\i\\repo\\${p.replace(/\//g, '\\')}`;
  const trace = [
    write(1, at('tests/orders/place.spec.ts')),
    write(2, at('tests/orders/cancel.spec.ts')),
    write(3, at('tests/orders/ship.spec.ts')),
    write(4, at('tests/orders/pack.spec.ts')),
    ranOn(5, 'red', './tests/orders/place.spec.ts'),
    ranOn(6, 'red', '../tests/orders/cancel.spec.ts)'),
    ranOn(7, 'red', '/c/Users/i/repo/tests/orders/ship.spec.ts'),
    ranOn(8, 'red', 'tests\\\\orders\\\\pack.spec.ts'),
    ...['place', 'cancel', 'ship', 'pack'].map((m, i) => write(10 + i, at(`lib/orders/${m}.ts`))),
  ];
  const section = testFirst(report({ trace }).out);
  return ['place', 'cancel', 'ship', 'pack'].map((m) => contains(section, `${m}.ts  (red-first)`)).find(Boolean) ?? '';
});

// Two changes in one log can each write a `utils.spec.ts`.
check('a source is credited by a red run of any test under its test\'s name', () => {
  const trace = [
    write(1, 'tests/item/utils.spec.ts'),
    write(2, 'lib/item/utils.ts'),
    write(3, 'tests/city/utils.spec.ts'),
    ranOn(4, 'red', 'tests/city/utils.spec.ts'),
    write(5, 'lib/city/utils.ts'),
  ];
  const section = testFirst(report({ trace }).out);
  return contains(section, 'OK   lib/city/utils.ts  (red-first)') || contains(section, 'MISS lib/item/utils.ts  (no-red-run)');
});

// The shape a real run left: Windows paths written, a relative target run, and
// a target from before run-trace kept only the runner's own command.
check('a target is matched to a Windows path, and past what another command left in it', () => {
  const trace = [
    write(1, 'C:\\Users\\someone\\repo\\tests\\orders\\place.spec.ts'),
    write(2, 'C:\\Users\\someone\\repo\\tests\\orders\\ship.spec.ts'),
    ranOn(3, 'red', 'tests/orders/place.spec.ts;,>/dev/null;,node_modules/eslint/bin/eslint.js'),
    write(4, 'C:\\Users\\someone\\repo\\lib\\orders\\place.ts'),
    write(5, 'C:\\Users\\someone\\repo\\lib\\orders\\ship.ts'),
  ];
  const section = testFirst(report({ trace }).out);
  return contains(section, 'place.ts  (red-first)') || (section.includes('ship.ts  (red-first)') ? `credited a test no run named.\n${section}` : '');
});

// ---- the gate: a PASS followed by nothing ----------------------------------
// After a PASS the next milestone's implementer works for as long as it takes,
// and the next gate line comes only when it ends. Measured to that line, every
// milestone longer than the stall threshold read as a run that had stopped.
check('a PASS followed by the next milestone working is not a stall', () => {
  const trace = [agent(1, 'implementer'), read(2, 'lib/orders/place.ts'), read(9, 'lib/orders/ship.ts')];
  const { out } = report({ archived: [{ slug: 'shipped', gate: [pass(0), pass(11)], trace }] });
  return out.includes('had to be nudged') ? `called a working milestone a stall.\n--- report ---\n${out}` : '';
});

check('a PASS followed by nothing at all is a stall', () => {
  const { out } = report({ archived: [{ slug: 'shipped', gate: [pass(0), pass(15)], trace: [read(15, 'lib/orders/place.ts')] }] });
  return contains(out, 'had to be nudged');
});

const ago = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
const passAgo = (minutes) => `${ago(minutes)} abc1234 cc=1.0 engine=0.1.0 phase=implement attempt=1 result=pass lint=0 test=0 unscoped=ok files=1`;

check('a live PASS with an implementer still working is not stalled right now', () => {
  const { out } = report({ gate: [passAgo(30)], trace: [`${ago(1)} phase=implement read file=lib/orders/place.ts agent_id=a1`] });
  return out.includes('stalled RIGHT NOW') ? `called a working milestone stalled.\n--- report ---\n${out}` : '';
});

check('a live PASS with nothing since is stalled right now', () => {
  const { out } = report({ gate: [passAgo(30)] });
  return contains(out, 'the run looks stalled RIGHT NOW');
});

// ---- report ---------------------------------------------------------------
if (failures.length > 0) {
  console.error(`stats: ${failures.length} case(s) failed.\n`);
  for (const f of failures) console.error(`  - ${f.name}\n    ${f.problem}\n`);
  process.exit(1);
}
console.log('stats: OK — the stall check and the session-reuse, read-scope and test-first sections hold under their cases.');
