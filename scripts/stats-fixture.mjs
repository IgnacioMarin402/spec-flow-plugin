#!/usr/bin/env node
/**
 * Behaviour fixture for scripts/specflow-stats.mjs — the session-reuse
 * section.
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
const agent = (minute, type, session) =>
  `${stamp(minute)} phase=implement${session ? ` session=${session}` : ''} agent type=${type} status=DONE`;
const pass = (minute) =>
  `${stamp(minute)} abc1234 cc=1.0 engine=0.1.0 phase=implement attempt=1 result=pass lint=0 test=0 unscoped=ok files=1`;

/** Builds a repo holding exactly these log lines and returns what stats printed. */
function report({ trace = [], gate = [] }) {
  const repo = mkdtempSync(join(tmpdir(), 'spec-flow-stats-'));
  try {
    mkdirSync(join(repo, '.claude', 'state'), { recursive: true });
    mkdirSync(join(repo, '.spec-flow'), { recursive: true });
    writeFileSync(join(repo, '.spec-flow', 'config.json'), CONTRACT);
    writeFileSync(join(repo, '.claude', 'state', 'phase'), 'implement');
    writeFileSync(join(repo, '.claude', 'state', 'run-trace.log'), trace.join('\n') + (trace.length ? '\n' : ''));
    writeFileSync(join(repo, '.claude', 'state', 'gate-history.log'), gate.join('\n') + (gate.length ? '\n' : ''));

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

// ---- report ---------------------------------------------------------------
if (failures.length > 0) {
  console.error(`stats: ${failures.length} case(s) failed.\n`);
  for (const f of failures) console.error(`  - ${f.name}\n    ${f.problem}\n`);
  process.exit(1);
}
console.log('stats: OK — the session-reuse section holds under its cases.');
