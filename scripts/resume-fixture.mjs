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
const stamped = (text, status) => text.replace(/\n/, `\n\n**Status:** ${status} 2026-09-27\n`);

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

check('a spec without its proposal: SPEC — the spec step never finished', () =>
  expect(resume(repo({ files: { 'specflow/add-cities/spec.md': SPEC }, phase: 'spec' })), 'SPEC'));

check('a fix brief with no work order: WORK-ORDER, not a sign-off', () =>
  expect(resume(repo({ files: { 'specflow/fix-empty-filter/spec.md': FIX }, phase: 'spec' })), 'WORK-ORDER'));

check('a plan with no milestone ever started: REVIEW', () => expect(resume(repo({ files: planned(), phase: 'review' })), 'REVIEW'));

check('a fix work order with no implementer ever spawned: IMPLEMENT M1', () =>
  expect(
    resume(repo({ files: { 'specflow/fix-empty-filter/spec.md': FIX, 'specflow/fix-empty-filter/plan.md': PLAN, 'specflow/fix-empty-filter/milestones/M1.md': '# M1\n' } })),
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
