#!/usr/bin/env node
// Traceability check between a repo's capability specs and the tests that
// prove them. A spec is the source of truth only if something breaks when the
// spec and the code disagree; otherwise it is documentation, and
// documentation rots quietly. This script is what breaks.
//
// It binds two artifacts the contract names:
//
//   <trace.specs_dir>/<capability>.md   what the system does today
//   <trace.executed_tests>              argv naming the tests that RAN
//
// The binding is the requirement id (REQ-USER-001), and it binds only from a
// test the runner REPORTED as executed — a tag in a comment or a helper
// string proves nothing, because no test ran under that name.
//
// **Nothing here reads source code, and nothing walks the repo**: see ADR-001.
//
// Checked in BOTH directions:
//
//   requirement with no test     -> the spec claims something nobody proves.
//   test tag with no requirement -> behaviour is protected that no spec
//                                   declares, or a requirement was renamed
//                                   and its test left behind.
//
// Plus one archive rule: every change parked under `specflow/archive/`
// declares what became of it (SHIPPED / REJECTED / SUPERSEDED), since an
// archived change with no status cannot be told from an abandoned one.
//
//   node scripts/spec-trace.mjs          # check, exit 1 on drift
//   node scripts/spec-trace.mjs --list   # also print the requirement -> test matrix
//
// Capabilities are opt-in: a module with no spec file under `specs_dir` is
// not checked. But the check itself is engine core, which is why it is NOT in
// `.spec-flow/config.json`'s `extra_checks` — it is what makes `specs/`
// authoritative rather than decorative. See `unscoped-checks.mjs`.


import { readdirSync, readFileSync, statSync, lstatSync, realpathSync, existsSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig } from './spec-flow-config.mjs';
import { readReport } from './test-report.mjs';

const LIST = process.argv.includes('--list');

// `### REQ-USER-001 — Title`. The separator is optional and may be an em
// dash, a hyphen or a colon: the id is what matters.
const REQ_HEADING = /^###\s+(REQ-[A-Z0-9-]+-\d{3})\b\s*[—:-]?\s*(.*)$/;

// **Deliberately NOT `\b`-delimited.** Go and pytest build test names out of
// identifiers, which cannot hold spaces or hyphens, so a reported name glues
// the id to its neighbours — `TestAuth/REQ-USER-001_rejects`. `_` is a word
// character, so `\b` fails on both sides and a genuine executed proof reads as
// absent.
//
// The boundaries say what matters instead: not glued to a preceding letter or
// digit (a different token), and not followed by a fourth digit (so
// `REQ-USER-0011` never matches as `REQ-USER-001`).
const REQ_TAG = /(?<![A-Z0-9])REQ-[A-Z0-9-]+-\d{3}(?!\d)/g;

/**
 * The ids a reported line proves, in canonical (hyphenated) spelling.
 *
 * The line is read TWICE: as reported, and with `_` read as `-`. The second
 * pass is the other half of the premise stated just above, and it is the half
 * that was missed. A language whose test name is an IDENTIFIER cannot spell the
 * id at all — `def test_REQ_CORE_001_...` is the closest a Python function name
 * can come, and Java methods and Rust `fn`s are in the same position. Matching
 * only the hyphenated form made a real, executed, passing test read as "has no
 * test that RAN", which is the exact defect ADR-001 was written to remove,
 * arriving through the spelling instead of through source parsing.
 *
 * Both passes, not the normalized one alone: normalizing first would let
 * `REQ-USER-001_002` read as the single id `REQ-USER-001-002`, since that also
 * ends in three digits. The raw pass keeps answering `REQ-USER-001` there, and
 * the union takes whichever a line genuinely names.
 */
function idsIn(line) {
  const found = new Set(line.match(REQ_TAG) ?? []);
  for (const id of line.replace(/_/g, '-').match(REQ_TAG) ?? []) found.add(id);
  return found;
}

// Nothing anchors an id to a test declaration, and nothing rejects a skipped
// one — the source of the lines does both. A runner reports tests, not
// comments, and a test it skipped is simply not in the report. That is why the
// rule survives a change of language: `.skip`, `@pytest.mark.skip`,
// `@Disabled`, `#[ignore]` and a runtime `t.Skip()` all end in the same
// place.
const SCOPE_MARKER = /^<!--\s*spec-scope:\s*(.+?)\s*-->$/m;

// `**Status:** SHIPPED 2026-07-30`, on an archived change spec.
const ARCHIVE_STATUS = /^\*\*Status:\*\*\s+(SHIPPED|REJECTED|SUPERSEDED)\b/m;

// `- CHANGED REQ-USER-001 (wording) — was X, now Y`, inside a change spec's
// `## Requirement deltas` section. The marker is OPTIONAL to this regex and
// required by the check that reads it: matching the line without one is what
// lets the failure quote the line it is complaining about, instead of
// reporting that it found nothing.
const CHANGED_DELTA = /^[-*]\s*CHANGED\s+(REQ-[A-Z0-9-]+-\d{3})(?!\d)[ \t]*(?:\(([a-z]+)\))?.*$/gm;

/** The two edits a CHANGED may legitimately be. Everything else decomposes. */
const CHANGED_KINDS = ['wording', 'correction'];

/**
 * The body of `## Requirement deltas`, or '' when the spec has no such
 * section.
 *
 * Scoped to that section rather than read over the whole file: a spec's prose
 * is entitled to DISCUSS a changed requirement without DECLARING one, and a
 * check that reads a sentence as a delta fails runs that are correct — which
 * costs more trust than the case it would catch.
 */
function deltasSection(body) {
  const heading = /^## Requirement deltas\b.*$/m.exec(body);
  if (!heading) return '';
  const after = body.slice(heading.index + heading[0].length);
  const next = after.search(/^## /m);
  return next === -1 ? after : after.slice(0, next);
}

/** Every CHANGED delta a change spec declares, with the kind it claims. */
function* changedDeltas(body) {
  for (const m of deltasSection(body).matchAll(CHANGED_DELTA)) {
    yield { line: m[0], id: m[1], kind: m[2] ?? null };
  }
}

/** Why one CHANGED line was rejected, in the failure's own voice. */
function explainKind(kind) {
  if (!kind) return 'does not say which kind of change it is';
  if (kind === 'correction') return 'is marked (correction), which only a `/spec-fix` brief may use';
  return `is marked (${kind}), which is not one of the two kinds a CHANGED may be (${CHANGED_KINDS.join(', ')})`;
}

/**
 * The only walk left is over `specs/` — Markdown this flow itself writes — so
 * the only thing worth skipping is dot-directories, and only for size: `.git`
 * alone can hold tens of thousands of objects.
 *
 * **Do not add build-output names here.** An ecosystem list is exactly what
 * ADR-001 removed, and in this walk it would be a liability rather than a
 * saving: a repo whose capability is called `build` is entitled to
 * `specs/build/`.
 */
const skipWalk = (name) => name.startsWith('.');

/**
 * Every file under `dir` matching `test`, walked without extra dependencies.
 *
 * Uses `lstatSync` on each entry, not `statSync`: a symlink must be told
 * apart from an ordinary directory before it is safe to descend into. `seen`
 * holds the REAL (symlink-resolved) path of every directory already walked —
 * a circular symlink (a consuming repo linking one package back into
 * another) would otherwise recurse until the stack overflows. That still
 * fails this check closed, via `gate.mjs`'s catch-all, but as a stack trace
 * blocking every run instead of a named problem. A broken symlink (dangling
 * target) fails to resolve with ENOENT; that entry is skipped, not fatal to
 * the walk.
 */
function walk(dir, test, found = [], seen = new Set()) {
  if (!existsSync(dir)) return found;

  let real;
  try {
    real = realpathSync(dir);
  } catch {
    return found; // dangling symlink, or removed between existsSync and here
  }
  if (seen.has(real)) return found;
  seen.add(real);

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let st;
    try {
      st = lstatSync(full);
    } catch {
      continue; // vanished between readdir and lstat
    }

    let isDir = st.isDirectory();
    if (st.isSymbolicLink()) {
      try {
        isDir = statSync(full).isDirectory(); // resolve the target
      } catch {
        continue; // dangling symlink
      }
    }

    if (isDir) {
      if (skipWalk(entry)) continue;
      walk(full, test, found, seen);
    } else if (test(full)) {
      found.push(full);
    }
  }
  return found;
}

/** `specs/user-profile.md` -> `REQ-USER-PROFILE-`, so ids cannot drift across files. */
function expectedPrefix(specFile) {
  return `REQ-${basename(specFile, '.md').toUpperCase()}-`;
}

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
// Unguarded — a version this engine does not recognize must stop the run
// loudly. See spec-flow-config.mjs's header.
const CONFIG = loadConfig(root);
const SPECS_DIR = join(root, CONFIG.trace.specs_dir);

const ARCHIVE_DIR = join(root, 'specflow', 'archive');

const problems = [];
/** id -> { title, spec, scope } */
const requirements = new Map();

// ---- read the specs ---------------------------------------------------
const NOT_A_CAPABILITY = new Set(CONFIG.trace.not_a_capability);
const specFiles = walk(SPECS_DIR, (f) => f.endsWith('.md') && !NOT_A_CAPABILITY.has(basename(f)));

for (const file of specFiles) {
  const rel = relative(root, file);
  const text = readFileSync(file, 'utf8');

  const scope = SCOPE_MARKER.exec(text)?.[1];
  if (!scope) {
    problems.push(
      `${rel}: missing the scope marker. Add \`<!-- spec-scope: <the path this spec is about> -->\` near the top.`,
    );
  }

  const prefix = expectedPrefix(file);
  for (const line of text.split('\n')) {
    const match = REQ_HEADING.exec(line.trim());
    if (!match) continue;

    const [, id, title] = match;
    if (!id.startsWith(prefix)) {
      problems.push(`${rel}: requirement ${id} does not start with ${prefix}, which this file's name requires.`);
    }
    if (requirements.has(id)) {
      problems.push(`${id} is declared twice: ${requirements.get(id).spec} and ${rel}.`);
      continue;
    }
    requirements.set(id, { title: title.trim(), spec: rel, scope });
  }
}

// ---- ask which tests actually ran ------------------------------------------
//
// Two sources, one shape. Everything downstream reads LINES: an id found in a
// line is a proof, and what produced the line is not this file's business
// (ADR-001). `trace.report` names a file the runner already knows how to write
// and a FORMAT that defines what "skipped" looks like; `trace.executed_tests`
// names a command the repo wrote. ADR-005 explains why the first is the default
// and the second stayed.
//
// Declaring NEITHER is a legitimate contract — a repo can use this gate for
// lint and tests without making its specs authoritative — but it is only
// legitimate while there is nothing to prove. The moment a requirement exists,
// an undeclared source is the shape this engine refuses everywhere else: a
// check that reads as satisfied because nobody armed it.
const useReport = CONFIG.trace.report && CONFIG.trace.report.format;
const reportCmd = useReport
  ? `trace.report (${CONFIG.trace.report.format} @ ${CONFIG.trace.report.path})`
  : CONFIG.trace.executed_tests.join(' ');

// Set only on the report path, where the file can say that it HAS test cases
// and that all of them were skipped. A command-based source cannot express
// that — it prints lines or it does not — so the guard below stays keyed on
// emptiness for `executed_tests` and on this for `report`.
let reportSkipped = 0;

let report;
if (useReport) {
  const result = readReport(CONFIG.trace.report, root);
  if (result.error) {
    report = { status: 1, stdout: '', stderr: result.error, error: null };
  } else {
    reportSkipped = result.skipped;
    report = { status: 0, stdout: result.names.join('\n'), stderr: '', error: null };
  }
} else if (CONFIG.trace.executed_tests.length > 0) {
  report = spawnSync(CONFIG.trace.executed_tests[0], CONFIG.trace.executed_tests.slice(1), {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
} else if (requirements.size > 0) {
  report = {
    status: 1,
    stdout: '',
    stderr:
      `${CONFIG.trace.specs_dir}/ declares ${requirements.size} requirement(s) and the contract declares no way to find out which tests ran. ` +
      `Traceability is opt-in and this repo has opted out, which is only coherent while it has no requirements. Add "report": {"format": "junit", "path": "..."} under "trace" ` +
      `(your runner already writes that file — \`spec-flow init\` proposes the flag), or delete the requirements.`,
    error: null,
  };
} else {
  // Nothing declared and nothing to prove. Explicit rather than silent: a
  // green line that does not say WHY it is green is how an unarmed check gets
  // mistaken for a passing one.
  console.log('spec-trace: traceability is not configured and no requirements are declared — nothing to check.');
  report = { status: 0, stdout: '', stderr: '', error: null };
}

/**
 * Three ways to have no proof, and they must never collapse into one outcome.
 *
 * This engine has twice had to remove a check that inferred a pass from an
 * absence, and this is the same shape upside down: "every requirement is
 * unproven" and "I could not find out what ran" both exit non-zero, so the
 * EXIT CODE cannot be what tells them apart. The message has to, because one
 * of them sends an implementer to write a test that already exists while the
 * suite that proves it never ran.
 */
const reportFailed = report.error || (report.status ?? 1) !== 0;
const reportedLines = (report.stdout ?? '')
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean);

// A source that answers nothing is only a refusal while something depends on
// the answer. With no requirement declared, nothing does — and this is the
// state EVERY adopter is in on their first run, because `init` always writes
// `trace.report` while the reporter flag it asks for is theirs to add
// afterwards. Refusing here made the contract `init` wrote fail the very
// command the install route ends with, on a repo with nothing to prove.
//
// It is the same rule the no-source branch above applies, reaching the same
// place from the other side: an opt-out is honest exactly until a requirement
// exists. Both proof sources get it, deliberately — a missing report file and
// a translator that is not finished yet are one fact, "nothing has been
// produced to read", and giving one the grace and not the other would be an
// asymmetry nobody decided.
//
// Loud, not silent: the reason is printed. A green line that does not say why
// it is green is how an unarmed check gets mistaken for a passing one, which
// is the failure this whole file exists to close.
let unarmed = false;
if (reportFailed && requirements.size === 0) {
  const why = report.error ? report.error.message : (report.stderr || '').trim() || `exit ${report.status}`;
  unarmed = true;
  console.log(
    `spec-trace: traceability is declared but not producing anything yet, and ${CONFIG.trace.specs_dir}/ declares no requirement — so there is nothing to bind and this is not a failure. ` +
      `It becomes one the moment a requirement exists.\n  source: ${reportCmd}\n  reason: ${why}`,
  );
} else if (reportFailed) {
  const why = report.error ? report.error.message : `exit ${report.status}`;
  problems.push(
    `${reportCmd} failed: ${why}. Nothing was learned about which tests ran, so no requirement can be called proven OR unproven. ` +
      `This is a refusal, not a finding about your specs.${report.stderr ? `\n\n${report.stderr.trim()}` : ''}`,
  );
} else if (reportedLines.length === 0 && reportSkipped === 0 && requirements.size > 0) {
  problems.push(
    `${reportCmd} reported no tests at all, while ${CONFIG.trace.specs_dir}/ declares ${requirements.size} requirement(s). ` +
      `That is not ${requirements.size} unproven requirement(s) — it is a report that says nothing, which usually means the suite has not run yet in this working tree, or the source names the wrong output. ` +
      `Run the suite (\`spec-flow check\` does it in the right order) and try again.`,
  );
}
// The case above deliberately does NOT cover a report holding cases that were
// every one of them skipped. That report says something: the suite ran and
// proved nothing. Falling through to the per-requirement findings below is the
// correct answer there, and each one names skipping as the reason it counts as
// absent.

/** id -> [reported lines that name it] */
const proofs = new Map();

if (!reportFailed) {
  for (const line of reportedLines) {
    for (const id of idsIn(line)) {
      if (!proofs.has(id)) proofs.set(id, []);
      if (!proofs.get(id).includes(line)) proofs.get(id).push(line);
    }
  }
}

// ---- both directions --------------------------------------------------
// Suppressed entirely when the report could not be read: naming individual
// requirements there would be inventing findings out of an unanswered
// question, and the refusal above already says what to fix.
if (!reportFailed && (reportedLines.length > 0 || reportSkipped > 0)) {
  for (const [id, req] of requirements) {
    if (!proofs.has(id)) {
      problems.push(
        `${id} (${req.spec}) has no test that RAN. Add a test under ${req.scope ?? 'the capability'}/${CONFIG.trace.proof_dir} whose name contains ${id}, or delete the requirement — an unproven requirement is a wish, not a spec. ` +
          `Note that a test which exists but was skipped counts as absent here: it is reported by nothing, which is exactly what makes skipping useless as a way to silence this.`,
      );
    }
  }
}

for (const [id, files] of proofs) {
  if (!requirements.has(id)) {
    problems.push(
      `${id} is proven by a test that ran (${files.join(', ')}) but no spec declares it. Either add it to the capability spec or drop the tag — a test proving something unspecified is drift in the other direction.`,
    );
  }
}

// ---- the archive declares what became of each change -----------------------
const archived = existsSync(ARCHIVE_DIR)
  ? readdirSync(ARCHIVE_DIR).filter((entry) => statSync(join(ARCHIVE_DIR, entry)).isDirectory())
  : [];

for (const slug of archived) {
  const specPath = join(ARCHIVE_DIR, slug, 'spec.md');
  const rel = relative(root, specPath);

  if (!existsSync(specPath)) {
    problems.push(`specflow/archive/${slug}/ has no spec.md. An archived change with no spec is a folder nobody can interpret.`);
    continue;
  }

  if (!ARCHIVE_STATUS.test(readFileSync(specPath, 'utf8'))) {
    problems.push(
      `${rel}: no status. Add \`**Status:** SHIPPED|REJECTED|SUPERSEDED <YYYY-MM-DD>\` under the heading, so a reader can tell what became of this change without digging through git history.`,
    );
  }
}

// ---- a live change spec stays light -----------------------------------
// Two files exist so the planner (reads on every fresh context) and the human
// (reads once, at sign-off) each get the document shaped for them: spec.md is
// the delta, proposal.md is the rationale. Without a check the Decision
// section drifts back into spec.md within a few changes.
//
//   - Live changes only — archived ones predate this rule.
//   - Fix briefs are exempt (`## Case` heading): the five-case triage IS the
//     fix flow, so `/spec-fix` output has nowhere to split.
//   - Headings only. Whether the rationale is any good is a reviewer's job.
const SPECFLOW_DIR = join(root, 'specflow');
const HEAVY_HEADINGS = ['## Source', '## Context', '## Decision'];

const live = existsSync(SPECFLOW_DIR)
  ? readdirSync(SPECFLOW_DIR).filter((entry) => entry !== 'archive' && statSync(join(SPECFLOW_DIR, entry)).isDirectory())
  : [];

for (const slug of live) {
  const specPath = join(SPECFLOW_DIR, slug, 'spec.md');
  if (!existsSync(specPath)) continue; // a folder mid-write is not a failure

  const body = readFileSync(specPath, 'utf8');
  const isFixBrief = /^## Case\b/m.test(body);

  // ---- a CHANGED delta says which kind it is ------------------------------
  //
  // ADDED and REMOVED are both PROVEN by this script: a new id with no test
  // that ran fails, and a test naming an id no spec declares fails. CHANGED
  // is neither, and the asymmetry is invisible because the three read as
  // peers in the template. The id already exists and already has a test, so
  // the binding this file checks is satisfied before the edit and after it,
  // whatever the body now says.
  //
  // The suite covers most of the gap without help: if behaviour really
  // changed, the code changed, and a test asserting the old behaviour goes
  // red. What survives is a CHANGED that WIDENS — "A and B" becomes "A, B and
  // C". Nothing breaks, because nothing that used to pass stopped passing,
  // and C is now claimed by the spec layer and proven by nobody. Declared as
  // ADDED, that same clause fails this script on sight.
  //
  // So the rule routes the unprovable case back into the provable deltas: a
  // behaviour claim that appears, disappears or changes is REMOVED + ADDED —
  // ids are permanent, which is exactly what makes retiring one safe — and
  // CHANGED keeps only the two edits that genuinely move no proof:
  //
  //   (wording)    the requirement means what it meant; the text is clearer.
  //                What MODE=FOLD does when it fixes tense, and the only
  //                delta a pure re-wording run has to declare.
  //   (correction) the requirement was WRONG and is corrected to match
  //                behaviour that already exists and is already proven.
  //                `/spec-fix` case 3, and fix briefs only — the one case
  //                that flow stops for a human on, precisely because a diff
  //                cannot tell it from rewriting the spec to agree with the
  //                bug. The marker records that the human was asked; it does
  //                not stand in for them.
  //
  // What this does NOT do: verify the kind is TRUE. `(wording)` written over a
  // requirement that grew three clauses passes, exactly as a bare CHANGED did.
  // The machine checks that the claim was declared; the reviewer and the
  // sign-off check that it holds. Said here because a check whose reach is
  // overestimated is the same failure as one that is disarmed. See ADR-009.
  //
  // Unconditional, unlike `require_skills_field` below, and the difference is
  // the peer test that field's own history turned on: its siblings are
  // checked by the reviewer alone, so enforcing one of them was an asymmetry.
  // This delta's siblings are enforced HERE, on every gate. Leaving CHANGED
  // out is the asymmetry. See ADR-009.
  for (const { line, id, kind } of changedDeltas(body)) {
    if (kind === 'wording') continue;
    if (kind === 'correction' && isFixBrief) continue;

    problems.push(
      `specflow/${slug}/spec.md: "${line.trim()}" ${explainKind(kind)}. ` +
        `CHANGED is the one delta this script cannot prove — ${id} already exists and already has a test, ` +
        `so the spec/test binding passes before the edit and after it, whatever the body now says. ` +
        `If the requirement means exactly what it meant and no test moves, write \`CHANGED ${id} (wording)\`. ` +
        `Otherwise this is not a CHANGED: split it into \`REMOVED ${id}\` plus an \`ADDED\` on a NEW id, ` +
        `which this script proves in both directions. Widening counts — a clause added to an existing ` +
        `requirement is claimed by the spec layer and proven by nobody.`,
    );
  }

  if (isFixBrief) continue; // exempt from the split below, by design

  const leaked = HEAVY_HEADINGS.filter((h) => new RegExp(`^${h}\\b`, 'm').test(body));
  if (leaked.length > 0) {
    problems.push(
      `specflow/${slug}/spec.md carries ${leaked.join(', ')}. Those belong in specflow/${slug}/proposal.md — the spec says what changes, the proposal says why it was chosen and what was rejected. The planner reads the first on every fresh context; only a human reads the second.`,
    );
  }

  if (!existsSync(join(SPECFLOW_DIR, slug, 'proposal.md'))) {
    problems.push(
      `specflow/${slug}/ has no proposal.md. A change spec with no recorded reasoning is a decision nobody can audit later — the archive's whole job is answering "was this considered, and what was turned down?".`,
    );
  }

  // ---- every live milestone says what skills it needs ---------------------
  //
  // `Skills:` is where the planner records its routing, decided while reading
  // the whole milestone with nothing written yet — the one point in the flow
  // where that is a decision rather than a judgement made mid-edit. The
  // implementer loads what it names before its first change.
  //
  // `none` is a legitimate and common answer, and the only one a project that
  // ships no skills will ever write. An ABSENT field is not the same thing:
  // it cannot be told apart from a planner that never looked, and the
  // implementer has no way to know which it is either. An EMPTY one — the
  // label with nothing after the colon — is the absent case with the word
  // typed in front of it, and is checked as such below. Same distinction the
  // gate draws between `spec=0` and `spec=-`.
  //
  // Off unless the contract asks for it. This was unconditional for one
  // commit, on the reasoning that the field lives in an artifact this flow
  // writes and so needs nothing declared first. True, and it answered the
  // wrong question: what a repo has to declare is not where the field lives,
  // it is whether it routes skills at all — which no file this engine can
  // read will tell it, since skills also arrive from plugins and from the
  // user's own directory. `require_skills_field` is that declaration. See
  // spec-flow-config.mjs for why the default is off and why it is not
  // inferred.
  //
  // Nothing else about the field changed: the planner's template still has
  // it, the planner still fills it, and the reviewer still checks it — which
  // is exactly where `Spec deltas`, `Tests` and `Objective` are checked. This
  // was the only milestone field spec-trace enforced.
  if (!CONFIG.trace.require_skills_field) continue;

  const milestonesDir = join(SPECFLOW_DIR, slug, 'milestones');
  if (!existsSync(milestonesDir)) continue; // no plan yet — a run mid-spec is not a failure

  for (const file of readdirSync(milestonesDir).filter((f) => f.endsWith('.md')).sort()) {
    // The trailing `\S` is the whole check, not a tidiness detail. Matching
    // the label alone accepts `Skills:` with nothing after it — which is the
    // ABSENT case with the word typed in front of it: same silence about
    // whether the planner looked, same nothing for the implementer to load.
    // A check that fails "no field" and passes "empty field" is not enforcing
    // the distinction it was written for, it is enforcing the spelling.
    if (!/^[-*]?\s*\**Skills\**\s*:[ \t]*\S/m.test(readFileSync(join(milestonesDir, file), 'utf8'))) {
      problems.push(
        `specflow/${slug}/milestones/${file} has no \`Skills:\` field, or has one with nothing after the colon. Every milestone says which skills it needs — \`none\` when the answer is none, which is what a project shipping no skills always writes. Neither absent nor empty is that answer: the implementer cannot tell either apart from a planner that never looked, and loads nothing in all three cases.`,
      );
    }
  }
}

// ---- report -------------------------------------------------------------
//
// An empty `specs/` makes every check in this file vacuous: no requirements
// means nothing to bind, so "every requirement is proven" is true of the
// empty set and this script reports green. That is the right answer for a
// repo adopting the engine — capability specs are WRITTEN by the flow, as
// milestones fold their deltas in, so demanding them before the first run
// completes would block adoption on an artifact the run is supposed to
// produce.
//
// It stops being the right answer the moment a change is stamped SHIPPED.
// That stamp is the flow asserting the deltas landed in `specs/`, so SHIPPED
// with no capability spec anywhere is not an early adoption state, it is two
// artifacts contradicting each other — and the one this script exists to
// trust says something landed where nothing is. REJECTED and SUPERSEDED
// assert nothing landed, so they keep the grace.
// A SHIPPED change only contradicts an empty spec layer if it CLAIMED a
// requirement. `/spec-fix` case 4 (INFRA) and any wiring-only change ship with
// `- none — infrastructure only` by design: the contract's proof surface does
// not cover them, so they assert nothing about `specs/` and the grace holds.
// Without this, the first such change in a repo blocked every gate afterwards,
// and the only way out was writing a capability spec the change never needed.
const shipped = archived.filter((slug) => {
  const specPath = join(ARCHIVE_DIR, slug, 'spec.md');
  if (!existsSync(specPath)) return false;
  const body = readFileSync(specPath, 'utf8');
  // `new RegExp(REQ_TAG.source)` rather than REQ_TAG itself: that one carries
  // the `g` flag, which makes `.test()` stateful through `lastIndex` — across
  // this filter's iterations it would answer about where the previous slug's
  // match ended rather than about this file.
  return /^\*\*Status:\*\*\s+SHIPPED\b/m.test(body) && new RegExp(REQ_TAG.source).test(body);
});

// The grace covers the REQUIREMENT BINDING and nothing else, and must NOT
// exit here: everything already found a few lines above — a leaked
// `## Decision`, a missing `proposal.md` — would be discarded with it. An
// empty `specs/` means the repo is adopting, which is when the habits form and
// the worst time to stand those checks down. So it reports what it is skipping
// and falls through to the problem report below.
let graced = false;
if (specFiles.length === 0) {
  if (shipped.length === 0) {
    console.log(
      `spec-trace: no capability specs under ${CONFIG.trace.specs_dir}/ and nothing shipped yet — no requirements to bind. ` +
        `This grace ends at the first SHIPPED change: capability specs are what a fold writes. Everything else below is still checked.`,
    );
    graced = true;
  } else {
    problems.push(
      `${shipped.length} change(s) are stamped SHIPPED (${shipped.join(', ')}) but ${CONFIG.trace.specs_dir}/ holds no capability spec. ` +
      `A fold stamps SHIPPED to assert its deltas landed there, so either they never did, or the specs were written somewhere this contract does not look — ` +
        `check trace.specs_dir. Until this is resolved every requirement check here is vacuous: with no requirements to bind, this script reports green over a spec layer that does not exist.`,
    );
  }
}

if (LIST) {
  for (const file of specFiles) {
    const rel = relative(root, file);
    console.log(`\n${rel}`);
    for (const [id, req] of requirements) {
      if (req.spec !== rel) continue;
      const proof = proofs.get(id);
      console.log(`  ${proof ? 'OK  ' : 'MISS'} ${id}  ${req.title}` + (proof ? `\n         proven by ${proof.join(', ')}` : ''));
    }
  }
  console.log('');
}

if (problems.length > 0) {
  console.error('spec-trace: the spec layer and the code disagree.\n');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(`\n${problems.length} problem(s).`);
  process.exit(1);
}

// Nothing to add when the grace already said what it skipped — claiming
// "every one proven by a test" over zero requirements is the vacuous green
// this file spent a commit learning not to print. `unarmed` is the same
// sentence about the other half of the binding: with nothing read about which
// tests ran, "every one proven" would be a claim over an unanswered question,
// and it is reachable with a non-empty specs/ (a capability file holding no
// `###` heading yet), which is where `graced` alone does not cover it.
if (!graced && !unarmed) {
  console.log(
    `spec-trace: OK — ${requirements.size} requirement(s) across ${specFiles.length} capability spec(s), every one proven by a test; ` +
      `${archived.length} archived change(s), every one with a status.`,
  );
}
