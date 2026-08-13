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

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { loadConfig } from './spec-flow-config.mjs';

const LIST = process.argv.includes('--list');

// `### REQ-USER-001 — Title`. The separator is optional and may be an em
// dash, a hyphen or a colon: the id is what matters.
const REQ_HEADING = /^###\s+(REQ-[A-Z0-9-]+-\d{3})\b\s*[—:-]?\s*(.*)$/;
const REQ_TAG = /\bREQ-[A-Z0-9-]+-\d{3}\b/g;

// A tag proves a requirement only when it sits in a test TITLE — the string
// argument of `it(...)` / `test(...)` (plus `.only`/`.skip`/`.each` variants;
// the second alternative catches the curried `it.each(...)('title')` form).
const TEST_TITLE =
  /(?:\b(?:it|xit|fit|test|xtest)(?:\.\w+)*\s*\(|\)\s*\(\s*)(['"`])((?:(?!\1)[\s\S])*?)\1/g;
const SCOPE_MARKER = /^<!--\s*spec-scope:\s*(.+?)\s*-->$/m;

// `**Status:** SHIPPED 2026-07-30`, on an archived change spec.
const ARCHIVE_STATUS = /^\*\*Status:\*\*\s+(SHIPPED|REJECTED|SUPERSEDED)\b/m;

/** Every file under `dir` matching `test`, walked without extra dependencies. */
function walk(dir, test, found = []) {
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, test, found);
    else if (test(full)) found.push(full);
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
    for (const id of match[2].match(REQ_TAG) ?? []) {
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
if (specFiles.length === 0 && archived.length === 0) {
  console.log(`spec-trace: no capability specs under ${CONFIG.trace.specs_dir}/ and nothing archived — nothing to check.`);
  process.exit(0);
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
