#!/usr/bin/env node
/**
 * The step `resume.mjs` names, for every state a run can be left in.
 *
 * Each case builds a throwaway git repository in one of those states — the
 * artifacts under `specflow/`, the phase, the position file and the gate's
 * history — runs the real script against it, and asserts the `NEXT:` line
 * `commands/resume.md` branches on. A wrong verdict here is a resumed run that
 * repeats a milestone, skips one, or plans over a spec nobody approved.
 *
 *   node scripts/resume-fixture.mjs [engine-root]
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { removeTemp } from './temp-dir.mjs';

const ENGINE = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const temps = [];

const SPEC = '# Spec — add-cities: cities\n\n## Requirement deltas\n- ADDED   REQ-CITY-001 — a city has a name\n';
const FIX = '# Fix — fix-empty-filter: an empty filter\n\n## Case\n1 UNSPECIFIED\n';
const PROPOSAL = '# Proposal — add-cities: cities\n\n## Source\nAdd cities.\n';
const PLAN = '# Plan — add-cities\n';
/** The stamp a fold or a rejection writes: directly under the heading. */
const stamped = (text, status) => {
  const [heading, ...rest] = text.split('\n');
  return [heading, '', `**Status:** ${status} 2026-09-27`, ...rest].join('\n');
};

/**
 * A repository in one run state. `files` are committed; `dirty` is written
 * after the commit. `pass` stamps a gate pass on HEAD, `passAge`/`startedAge`
 * set how many minutes ago the pass and the milestone start happened.
 */
function repo({ files = {}, dirty = {}, phase = 'implement', milestone = '', verdict = '', verdictAge = 5, startedAge = 60 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'resume-repo-'));
  temps.push(dir);
  const g = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '.');
  g('symbolic-ref', 'HEAD', 'refs/heads/main');
  g('config', 'user.email', 'resume@example.com');
  g('config', 'user.name', 'resume');
  writeFileSync(join(dir, '.gitignore'), '.claude/state/\n');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  g('add', '-A');
  g('commit', '-q', '--allow-empty', '-m', 'state');
  for (const [path, text] of Object.entries(dirty)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }

  const state = join(dir, '.claude', 'state');
  mkdirSync(state, { recursive: true });
  if (phase !== null) writeFileSync(join(state, 'phase'), phase);
  if (milestone) {
    const at = join(state, 'current-milestone');
    writeFileSync(at, `${milestone} abc123def4567890a`);
    const when = new Date(Date.now() - startedAge * 60_000);
    utimesSync(at, when, when);
  }
  if (verdict) {
    const sha = g('rev-parse', '--short', 'HEAD').stdout.trim();
    const at = new Date(Date.now() - verdictAge * 60_000).toISOString().replace(/\.\d+Z$/, 'Z');
    writeFileSync(join(state, 'gate-history.log'), `${at} ${sha} cc=? engine=fixture phase=implement attempt=0 result=${verdict} lint=0 test=0 spec=0 files=1\n`);
  }
  return dir;
}

function resume(dir, ...args) {
  const r = spawnSync('node', [join(ENGINE, 'scripts', 'resume.mjs'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
    cwd: tmpdir(),
  });
  return { code: r.status, out: r.stdout, next: /^NEXT: (.+)$/m.exec(r.stdout)?.[1] ?? '', why: /^WHY: (.+)$/m.exec(r.stdout)?.[1] ?? '' };
}

function check(name, fn) {
  try {
    const problem = fn();
    if (problem) failures.push({ name, problem });
  } catch (err) {
    failures.push({ name, problem: `threw: ${err?.stack ?? err}` });
  }
}

/** The common assertion: exit 0 and this NEXT. */
const expect = (r, next) =>
  r.code !== 0 ? `exited ${r.code}; a report must always exit 0\n${r.out}` : r.next === next ? '' : `NEXT: ${r.next || '(none)'}, want ${next}\n${r.out}`;

const feature = (extra = {}) => ({ 'specflow/add-cities/spec.md': SPEC, 'specflow/add-cities/proposal.md': PROPOSAL, ...extra });
const planned = (extra = {}) =>
  feature({ 'specflow/add-cities/plan.md': PLAN, 'specflow/add-cities/milestones/M1.md': '# M1\n', 'specflow/add-cities/milestones/M2.md': '# M2\n', ...extra });

// ---- before any code ---------------------------------------------------------

check('no change in flight: NONE', () => expect(resume(repo({ phase: 'idle' })), 'NONE'));

check('a spec and its proposal with no plan: SIGN-OFF — the one step no file records', () =>
  expect(resume(repo({ files: feature(), phase: 'idle' })), 'SIGN-OFF'));

// A spec written before `## Assumptions` existed: phase-guard refuses to leave
// `spec` with it, so the human must not be asked to approve it as it stands.
check('a sign-off over a spec phase-guard would refuse says the spec-writer revises it first', () => {
  const r = resume(repo({ files: feature(), phase: 'idle' }));
  if (r.next !== 'SIGN-OFF') return `NEXT is ${r.next || '(none)'}, expected SIGN-OFF`;
  return /revises it first/.test(r.why) && /## Assumptions/.test(r.why) ? '' : `WHY does not name the problem and the revision: ${r.why}`;
});

check('a sign-off over a ready spec asks for nothing else', () => {
  const r = resume(repo({ files: feature({ 'specflow/add-cities/spec.md': `${SPEC}\n## Assumptions\n- none\n` }), phase: 'idle' }));
  return r.next === 'SIGN-OFF' && !/revises/.test(r.why) ? '' : `NEXT ${r.next}, WHY: ${r.why}`;
});

check('a spec without its proposal: SPEC — the spec step never finished', () =>
  expect(resume(repo({ files: { 'specflow/add-cities/spec.md': SPEC }, phase: 'spec' })), 'SPEC'));

check('a fix brief with no work order: WORK-ORDER, not a sign-off', () =>
  expect(resume(repo({ files: { 'specflow/fix-empty-filter/spec.md': FIX }, phase: 'spec' })), 'WORK-ORDER'));

check('a plan with no milestone ever started: REVIEW', () => expect(resume(repo({ files: planned(), phase: 'review' })), 'REVIEW'));

// The triage writes the work order inside `spec` (ADR-033), so a work order
// on disk says nothing about a case 3 having been confirmed: until an
// implementer starts, the fix re-enters at the HITL step.
check('a fix work order with no implementer ever spawned: WORK-ORDER, so a case 3 is confirmed again', () => {
  const r = resume(repo({ files: { 'specflow/fix-empty-filter/spec.md': FIX, 'specflow/fix-empty-filter/plan.md': PLAN, 'specflow/fix-empty-filter/milestones/M1.md': '# M1\n' } }));
  return expect(r, 'WORK-ORDER') || (/case 3 is confirmed/.test(r.why) ? '' : `WHY does not say the case 3 OK is asked again: ${r.why}`);
});

check('a fix work order whose implementer started: IMPLEMENT M1', () =>
  expect(
    resume(repo({ files: { 'specflow/fix-empty-filter/spec.md': FIX, 'specflow/fix-empty-filter/plan.md': PLAN, 'specflow/fix-empty-filter/milestones/M1.md': '# M1\n' }, milestone: 'fix-empty-filter M1' })),
    'IMPLEMENT M1',
  ));

// ---- during the milestones ---------------------------------------------------

check('M1 passed on HEAD after it started: IMPLEMENT M2', () =>
  expect(resume(repo({ files: planned(), milestone: 'add-cities M1', verdict: 'pass' })), 'IMPLEMENT M2'));

check('the last milestone passed: FOLD', () =>
  expect(resume(repo({ files: planned(), milestone: 'add-cities M2', verdict: 'pass' })), 'FOLD'));

check('a pass stamped BEFORE the milestone started is the previous one’s: IMPLEMENT M2 again', () =>
  expect(resume(repo({ files: planned(), milestone: 'add-cities M2', verdict: 'pass', verdictAge: 90, startedAge: 30 })), 'IMPLEMENT M2'));

check('a milestone in flight on a dirty tree: IMPLEMENT it, and say the tree holds the dead session’s work', () => {
  const r = resume(repo({ files: planned(), milestone: 'add-cities M1', dirty: { 'wip/half-written.txt': 'half\n' } }));
  const problem = expect(r, 'IMPLEMENT M1');
  if (problem) return problem;
  return /uncommitted/.test(r.why) ? '' : `WHY does not mention the uncommitted work, which the human has to decide about: ${r.why}`;
});

check('a gate failure on HEAD: IMPLEMENT that milestone, pointing at the failure log', () => {
  const r = resume(repo({ files: planned(), milestone: 'add-cities M1', verdict: 'fail' }));
  const problem = expect(r, 'IMPLEMENT M1');
  if (problem) return problem;
  return /gate-failure\.log/.test(r.why) ? '' : `WHY does not say where the failure is: ${r.why}`;
});

check('a milestone of ANOTHER change in the position file is not this change’s', () =>
  expect(resume(repo({ files: planned(), milestone: 'other-change M1', verdict: 'pass' })), 'REVIEW'));

// ---- closing -----------------------------------------------------------------

check('a SHIPPED stamp on a live folder: FOLD — the archive never happened', () =>
  expect(resume(repo({ files: planned({ 'specflow/add-cities/spec.md': stamped(SPEC, 'SHIPPED') }) })), 'FOLD'));

check('a REJECTED stamp on a live folder: ARCHIVE-REJECTED', () =>
  expect(resume(repo({ files: feature({ 'specflow/add-cities/spec.md': stamped(SPEC, 'REJECTED') }), phase: 'spec' })), 'ARCHIVE-REJECTED'));

check('an archived change whose run never wrote done: DONE', () =>
  expect(
    resume(repo({ files: { 'specflow/archive/add-cities/spec.md': stamped(SPEC, 'SHIPPED'), 'specflow/archive/add-cities/proposal.md': PROPOSAL }, milestone: 'add-cities M2' })),
    'DONE',
  ));

check('an archived change the run DID close is not resumed', () =>
  expect(resume(repo({ files: { 'specflow/archive/add-cities/spec.md': stamped(SPEC, 'SHIPPED') }, milestone: 'add-cities M2', phase: 'done' })), 'NONE'));

// ---- which change, and what it may not do --------------------------------------

check('two live changes: CHOOSE, and naming one resumes it', () => {
  const dir = repo({ files: feature({ 'specflow/other/spec.md': SPEC, 'specflow/other/proposal.md': PROPOSAL, 'specflow/other/plan.md': PLAN }), phase: 'idle' });
  const problem = expect(resume(dir), 'CHOOSE');
  if (problem) return problem;
  return expect(resume(dir, 'other'), 'REVIEW');
});

// A plan committed on the base and never run is not a run of a branch off it
// (ADR-032). Offered as one, resume enters a run phase-guard refuses to start.
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
  trace: { specs_dir: 'specs', proof_dir: 'tests', proof_suffix: '.spec.ts', executed_tests: ['node', '-e', 'process.exit(0)'], not_a_capability: [] },
  extra_checks: [],
  unscoped_denied: { scripts: ['test'], tools: ['ftest'], scoped_allowed: ['check'], scoped_alternative: 'npm run check', scoped_examples: ['npm run check'] },
});

/** A plan parked on `main`, then a branch off it carrying `own`, committed. */
function parkedRepo(own = {}) {
  const dir = repo({
    files: { '.spec-flow/config.json': CONTRACT, 'specflow/parked/spec.md': SPEC, 'specflow/parked/proposal.md': PROPOSAL, 'specflow/parked/plan.md': PLAN },
    phase: 'idle',
  });
  const g = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  g('checkout', '-q', '-b', 'feature');
  for (const [path, text] of Object.entries(own)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  g('add', '-A');
  g('commit', '-q', '--allow-empty', '-m', 'own');
  return dir;
}

check('a plan the base branch already has is not offered as the run to resume', () => {
  const r = resume(parkedRepo());
  return expect(r, 'NONE') || (r.out.includes('the base branch has them: parked') ? '' : `the parked plan is not named:\n${r.out}`);
});

check("a plan the base branch has does not stand beside this branch's own change", () => expect(resume(parkedRepo(feature())), 'SIGN-OFF'));

check('a blocked run: BLOCKED — a human decides, not a resume', () => expect(resume(repo({ files: planned(), milestone: 'add-cities M1', phase: 'blocked' })), 'BLOCKED'));

check('state it cannot read still ends on a NEXT line, with exit 0', () => {
  const dir = repo({ phase: 'idle' });
  writeFileSync(join(dir, 'specflow'), 'a file where a directory belongs\n');
  return expect(resume(dir), 'UNKNOWN');
});

check('it creates nothing in a repository that never ran the flow', () => {
  const dir = mkdtempSync(join(tmpdir(), 'resume-bare-'));
  temps.push(dir);
  const r = resume(dir);
  if (r.code !== 0) return `exited ${r.code}`;
  return existsSync(join(dir, '.claude')) ? 'created .claude/ in a repository with no run' : '';
});

// ---- report --------------------------------------------------------------------
for (const dir of temps) removeTemp(dir);

if (failures.length > 0) {
  console.error(`resume: ${failures.length} case(s) failed.\n`);
  for (const f of failures) console.error(`  - ${f.name}\n    ${f.problem}\n`);
  process.exit(1);
}
console.log('resume: OK — every run state names the step it resumes at.');
