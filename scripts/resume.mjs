#!/usr/bin/env node
/**
 * Where an unfinished run stands, and the step it resumes at — read off disk.
 *
 * `commands/resume.md` acts on the last line, `NEXT:`. Everything above it is
 * the evidence, printed so the human can check the verdict before a run
 * spends anything on it. See ADR-024 for why the answer comes from the
 * artifacts and the gate's history rather than from a transcript.
 *
 * NEVER FAILS, and creates nothing — the same standing as `status.mjs`: it
 * reads `.claude/state/` through `existsSync`, and its exit code is always 0.
 *
 *   node scripts/resume.mjs [<SLUG>]      # or: spec-flow resume [<SLUG>]
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// A report that throws reads as a verdict. Anything unexpected still ends on
// a NEXT line and exit 0 — see the header.
process.on('uncaughtException', (err) => {
  console.log(`\nNEXT: UNKNOWN\nWHY: the state could not be read (${err?.message ?? err}); \`spec-flow status\` shows what is there.`);
  process.exit(0);
});

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const STATE = join(root, '.claude', 'state');
const SPECFLOW = join(root, 'specflow');
const asked = process.argv[2] ?? '';

const read = (path) => (existsSync(path) ? readFileSync(path, 'utf8').trim() : '');
const lines = (path) => read(path).split('\n').map((l) => l.trim()).filter(Boolean);
const say = (...args) => console.log(...args);
const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });

/** The `# Spec —` / `# Fix —` heading and the `**Status:**` stamp under it. */
function describe(dir) {
  const spec = read(join(dir, 'spec.md'));
  const milestonesDir = join(dir, 'milestones');
  const milestones = existsSync(milestonesDir)
    ? readdirSync(milestonesDir)
        .map((f) => /^M(\d+)\.md$/.exec(f))
        .filter(Boolean)
        .map((m) => Number(m[1]))
        .sort((a, b) => a - b)
    : [];
  return {
    fix: /^#\s*Fix\b/m.test(spec),
    status: /^\*\*Status:\*\*\s*([A-Z]+)/m.exec(spec)?.[1] ?? '',
    proposal: existsSync(join(dir, 'proposal.md')),
    plan: existsSync(join(dir, 'plan.md')),
    milestones,
  };
}

const live = existsSync(SPECFLOW)
  ? readdirSync(SPECFLOW).filter((d) => d !== 'archive' && existsSync(join(SPECFLOW, d, 'spec.md'))).sort()
  : [];

const phase = read(join(STATE, 'phase'));
const [atSlug, atMilestone] = read(join(STATE, 'current-milestone')).split(/\s+/);

say('spec-flow resume — where an unfinished run stands, read off disk');
say(`repo: ${root}\n`);

/** Prints the verdict and stops. `step` is what commands/resume.md branches on. */
function next(step, why) {
  say(`\nNEXT: ${step}`);
  say(`WHY: ${why}`);
  process.exit(0);
}

if (phase === 'blocked') {
  next('BLOCKED', 'the gate reached its attempt cap and wrote `blocked` itself; a human decides from .claude/state/gate-failure.log.');
}

// ---- which change ----------------------------------------------------------
let slug = asked;
if (!slug) {
  if (live.length > 1) {
    say(`live changes: ${live.join(', ')}`);
    next('CHOOSE', 'more than one change is live in specflow/; name the one to resume.');
  }
  slug = live[0] ?? '';
}

// A change the fold already archived: the run died between the archive and
// `done`, and the position file is the only thing still naming it.
if (!slug && atSlug && existsSync(join(SPECFLOW, 'archive', atSlug, 'spec.md')) && phase !== 'done') {
  slug = atSlug;
}
if (!slug) next('NONE', 'no change is live in specflow/ and none is half-closed; there is nothing to resume.');

const liveDir = join(SPECFLOW, slug);
const archived = !existsSync(join(liveDir, 'spec.md')) && existsSync(join(SPECFLOW, 'archive', slug, 'spec.md'));
const dir = archived ? join(SPECFLOW, 'archive', slug) : liveDir;
if (!existsSync(join(dir, 'spec.md'))) next('NONE', `specflow/${slug}/spec.md does not exist, live or archived.`);

const change = describe(dir);
const n = change.milestones.length;

// ---- what the gate knows about HEAD -----------------------------------------
const head = git('rev-parse', '--short', 'HEAD').stdout?.trim() || '';
const history = lines(join(STATE, 'gate-history.log'));
const onHead = history.filter((l) => l.split(' ')[1] === head);
const verdict = (onHead.at(-1)?.match(/ result=(\S+)/) ?? [])[1] ?? '';
const dirty = (git('status', '--porcelain').stdout ?? '')
  .split('\n')
  .filter((l) => l.trim() && !/\.claude[\\/]state[\\/]/.test(l));

// The milestone in flight, and whether HEAD's pass is ITS pass. The position
// file is written when that milestone's implementer is spawned, so a pass
// stamped before it belongs to the milestone before.
const started = atSlug === slug && /^M\d+$/.test(atMilestone ?? '') ? Number(atMilestone.slice(1)) : 0;
const startedAt = started ? statSync(join(STATE, 'current-milestone')).mtimeMs : 0;
const passedSince = onHead.some((l) => / result=pass /.test(l) && Date.parse(l.split(' ')[0]) >= startedAt);

say(`change: ${slug} — ${change.fix ? 'a /spec-fix brief' : 'a /spec-flow change'}${archived ? ', archived' : ''}`);
say(`  spec.md: yes${change.status ? ` (Status: ${change.status})` : ''} · proposal.md: ${change.proposal ? 'yes' : 'no'} · plan.md: ${change.plan ? 'yes' : 'no'} · milestones: ${n ? change.milestones.map((m) => `M${m}`).join(', ') : 'none'}`);
say(`  phase: ${phase || '(none)'} · milestone in flight: ${started ? `M${started}` : 'none recorded'}`);
say(`  HEAD ${head || '?'}: ${verdict ? `gate ${verdict}` : 'not judged by the gate'} · tree: ${dirty.length ? `dirty (${dirty.length} path(s))` : 'clean'}`);

// ---- the step --------------------------------------------------------------
if (archived) {
  next('DONE', `the fold archived specflow/${slug}/ (Status: ${change.status || 'none'}) and the run never wrote \`done\`.`);
}
if (change.status === 'REJECTED') {
  next('ARCHIVE-REJECTED', 'the spec is stamped REJECTED and still live; the rejection was never archived.');
}
if (change.status === 'SHIPPED') {
  next('FOLD', 'the change spec is stamped SHIPPED but was never archived; finish the fold.');
}
if (!change.fix && !change.proposal) {
  // The requirement itself lived in the dead session's chat: `proposal.md`'s
  // Source section is the only file that would have carried it.
  next('SPEC', 'spec.md exists without proposal.md, so the spec step never finished; the requirement has to come from the human again.');
}
if (!change.plan) {
  next(
    change.fix ? 'WORK-ORDER' : 'SIGN-OFF',
    change.fix
      ? 'the triage brief is written and no work order exists yet.'
      : 'the spec is written and no plan exists: the human sign-off is the step no file records, so it is asked for again.',
  );
}
if (!started) {
  if (change.fix) next('IMPLEMENT M1', 'the work order exists and no implementer was ever spawned for it.');
  next('REVIEW', 'the plan exists and no milestone was ever started; its review is not on disk, so it runs again.');
}
if (passedSince) {
  if (started < n) next(`IMPLEMENT M${started + 1}`, `M${started} passed the gate on ${head}; M${started + 1} is next.`);
  next('FOLD', `M${started}, the last milestone, passed the gate on ${head}.`);
}
next(
  `IMPLEMENT M${started}`,
  dirty.length
    ? `M${started} was in flight and never passed; the tree holds ${dirty.length} uncommitted path(s) from the session that died.`
    : verdict.startsWith('fail')
      ? `M${started} failed the gate on ${head}; .claude/state/gate-failure.log says why.`
      : `M${started} was in flight and has no pass on ${head}.`,
);
