#!/usr/bin/env node
// Traceability check between a repo's capability specs and the tests that
// prove them.
//
// A spec is the source of truth only if something breaks when the spec and
// the code disagree. Otherwise it is documentation, and documentation rots
// quietly. This script is what breaks.
//
// It binds two artifacts the contract names:
//
//   <trace.specs_dir>/<capability>.md          what the system does today
//   <trace.proof_dir>/**/*<trace.proof_suffix>  the tests that prove it
//
// The binding is the requirement id (REQ-USER-001), and it only binds from a
// test's TITLE — a tag in a comment or a helper string proves nothing,
// because no test runs under that name. It is checked in BOTH directions:
//
//   requirement with no test     -> the spec claims something nobody proves.
//   test tag with no requirement -> behaviour is protected that no spec
//                                   declares, or a requirement was
//                                   renamed/removed and its test left behind.
//
// It also checks one thing about the archive: every change parked under
// `specflow/archive/` declares what became of it (SHIPPED / REJECTED /
// SUPERSEDED). An archived change with no status is indistinguishable from an
// abandoned one.
//
//   node scripts/spec-trace.mjs          # check, exit 1 on drift
//   node scripts/spec-trace.mjs --list   # also print the requirement -> test matrix
//
// Capabilities are opt-in: a module with no spec file under `specs_dir` is
// not checked at all.
//
// This is engine core, not something a repo opts into — spec-trace is what
// makes `specs/` authoritative rather than decorative, so it is deliberately
// NOT in `.spec-flow/config.json`'s `extra_checks`. See `unscoped-checks.mjs`.

import { readdirSync, readFileSync, statSync, lstatSync, realpathSync, existsSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { loadConfig } from './spec-flow-config.mjs';

const LIST = process.argv.includes('--list');

// `### REQ-USER-001 — Title`. The separator is optional and may be an em
// dash, a hyphen or a colon: the id is what matters.
const REQ_HEADING = /^###\s+(REQ-[A-Z0-9-]+-\d{3})\b\s*[—:-]?\s*(.*)$/;
const REQ_TAG = /\bREQ-[A-Z0-9-]+-\d{3}\b/g;

// A tag proves a requirement only when it sits in a test TITLE — the string
// argument of `it(...)` / `test(...)`, including the curried
// `it.each(table)('title')` form, which the inner alternative catches.
//
// Both alternatives are anchored to the test function's own name, and that
// anchoring is load-bearing. The curried branch used to be a bare `)\s*(\s*`
// — ANY `)(` followed by a string, anywhere in the file — so an ordinary
// curried call or an IIFE whose argument merely mentioned a requirement id
// registered as proof for a requirement no test runs.
//
// Group 1 is the modifier chain (`.only`, `.each`, `.skip.each`, ...), kept
// so the caller can reject the ones that do not RUN. `xit`/`xtest` are
// absent from the name list for the same reason `.skip` and `.todo` are
// rejected below: they are skipped-test forms, and a test that never
// executes proves nothing. Accepting them let the cheapest possible way of
// silencing a red test — skip it — leave the requirement reading as covered.
//
// Known limitation: the curried branch's `[^()]*` does not span nested
// parentheses, so `it.each([foo(1)])('...')` is not matched. Widening it
// costs the anchoring above, which is the more valuable property.
const TEST_TITLE =
  /\b(?:it|fit|test)((?:\.\w+)*)\s*\(\s*(?:(['"`])((?:(?!\2)[\s\S])*?)\2|[^()]*\)\s*\(\s*(['"`])((?:(?!\4)[\s\S])*?)\4)/g;

/** `.skip` / `.todo` anywhere in the modifier chain means the test does not run. */
const NOT_RUN = /\.(skip|todo)\b/;
const SCOPE_MARKER = /^<!--\s*spec-scope:\s*(.+?)\s*-->$/m;

// `**Status:** SHIPPED 2026-07-30`, on an archived change spec.
const ARCHIVE_STATUS = /^\*\*Status:\*\*\s+(SHIPPED|REJECTED|SUPERSEDED)\b/m;

/**
 * Directories a source walk must never descend into.
 *
 * This is not an optimisation, it is the difference between a check that runs
 * at every gate and one nobody can afford to run. Measured on a mid-size
 * project: 204 files under the source tree, 34,860 under `node_modules` —
 * walking both took 9.7s against 0.11s, and `spec-trace` runs on every gate,
 * every phase-guard and every check command.
 *
 * `node_modules` is not repo-specific vocabulary the way a layer name would
 * be: this engine is itself a Node program, and no dependency tree contains a
 * capability spec's proof. Dot-directories go for the same reason plus one
 * more — `.git` alone can hold tens of thousands of objects.
 *
 * Build output is skipped for a second reason, and it is correctness rather
 * than speed. A compiled or copied test under `dist/` matches the same suffix
 * as its source, so it registers as proof of the requirement its title names
 * — and keeps registering after the SOURCE test is deleted. The requirement
 * then reads as proven by an artifact nobody can run, which is the silent
 * pass this whole check exists to refuse. Reproduced: deleting
 * `tests/user.test.js` while `dist/tests/user.test.js` remained left
 * spec-trace green.
 *
 * The contract still wins over this list: a directory named by
 * `trace.proof_dir` is never skipped, whatever it is called. A repo that
 * genuinely keeps its proofs in a directory named `dist` is unusual and
 * entitled to say so, and an engine heuristic must not quietly exclude the
 * surface the repo declared.
 */
const NEVER_WALK = new Set(['node_modules', 'dist', 'build', 'coverage', 'out', 'vendor']);

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
      if (skipDir(entry)) continue;
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

// Defined here, below the contract, because the contract overrides it: see
// NEVER_WALK's header for why the declared proof surface outranks this
// engine's list of directories that are usually build output.
const skipDir = (name) => name !== CONFIG.trace.proof_dir && (name.startsWith('.') || NEVER_WALK.has(name));

// `proof_dir` is a directory NAME to look for as a path segment, wherever it
// appears — a project's tests might live several levels under the repo root,
// or right at it; this engine has no opinion. So the search root is
// the repo root, and matching is "does this test file's path include a
// segment named `proof_dir`".
const SEARCH_ROOT = root;
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

// ---- read the tests that claim to prove them -------------------------------
const testFiles = walk(SEARCH_ROOT, (f) => f.endsWith(CONFIG.trace.proof_suffix)).filter((f) =>
  relative(root, f).split(/[\\/]/).includes(CONFIG.trace.proof_dir),
);

/** id -> [test files that mention it] */
const proofs = new Map();

for (const file of testFiles) {
  const rel = relative(root, file);
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(TEST_TITLE)) {
    const [, modifiers, , directTitle, , curriedTitle] = match;
    if (NOT_RUN.test(modifiers)) continue; // a skipped or todo test executes nothing
    const title = directTitle ?? curriedTitle ?? '';

    for (const id of title.match(REQ_TAG) ?? []) {
      if (!proofs.has(id)) proofs.set(id, []);
      if (!proofs.get(id).includes(rel)) proofs.get(id).push(rel);
    }
  }
}

// ---- both directions --------------------------------------------------
for (const [id, req] of requirements) {
  if (!proofs.has(id)) {
    problems.push(
      `${id} (${req.spec}) has no test. Add a test under ${req.scope ?? 'the capability'}/${CONFIG.trace.proof_dir} whose name contains ${id}, or delete the requirement — an unproven requirement is a wish, not a spec.`,
    );
  }
}

for (const [id, files] of proofs) {
  if (!requirements.has(id)) {
    problems.push(
      `${id} is referenced by ${files.join(', ')} but no spec declares it. Either add it to the capability spec or drop the tag — a test proving something unspecified is drift in the other direction.`,
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
  if (/^## Case\b/m.test(body)) continue; // a fix brief, exempt by design

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

if (specFiles.length === 0) {
  if (shipped.length === 0) {
    console.log(
      `spec-trace: no capability specs under ${CONFIG.trace.specs_dir}/ and nothing shipped yet — nothing to check. ` +
        `This grace ends at the first SHIPPED change: capability specs are what a fold writes.`,
    );
    process.exit(0);
  }

  problems.push(
    `${shipped.length} change(s) are stamped SHIPPED (${shipped.join(', ')}) but ${CONFIG.trace.specs_dir}/ holds no capability spec. ` +
      `A fold stamps SHIPPED to assert its deltas landed there, so either they never did, or the specs were written somewhere this contract does not look — ` +
      `check trace.specs_dir. Until this is resolved every requirement check here is vacuous: with no requirements to bind, this script reports green over a spec layer that does not exist.`,
  );
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

console.log(
  `spec-trace: OK — ${requirements.size} requirement(s) across ${specFiles.length} capability spec(s), every one proven by a test; ` +
    `${archived.length} archived change(s), every one with a status.`,
);
