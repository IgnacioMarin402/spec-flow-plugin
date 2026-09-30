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

check('the size of each artefact is reported against its budget, and an oversize one is named', () => {
  const { out } = report({
    files: {
      'specs/orders.md': ORDERS_SPEC,
      ...changeFiles('specflow/archive/ship-orders'),
      'specflow/archive/ship-orders/proposal.md': `# Proposal — ship-orders\n${'x'.repeat(8100)}`,
    },
    archived: [{ slug: 'ship-orders', trace: [readIn(1, 'plan', 'lib/orders/place.ts')] }],
  });
  return (
    contains(out, 'Artefacts') ||
    contains(out, 'ship-orders: spec 1') ||
    contains(out, 'of 6,000)') ||
    contains(out, 'proposal 8,125 chars — OVER its 8,000 budget') ||
    contains(out, 'largest of 1 milestone(s)')
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

// ---- report ---------------------------------------------------------------
if (failures.length > 0) {
  console.error(`stats: ${failures.length} case(s) failed.\n`);
  for (const f of failures) console.error(`  - ${f.name}\n    ${f.problem}\n`);
  process.exit(1);
}
console.log('stats: OK — the session-reuse and read-scope sections hold under their cases.');
