#!/usr/bin/env node
/**
 * Fails if any engine file couples itself to one consuming repo: its
 * vocabulary, or the reasoning pattern only its history supports.
 *
 * The engine depends on a contract the repo implements
 * (`.spec-flow/config.json`), never on the repo. This check is what makes
 * that arrow verifiable instead of a rule that holds only while whoever edits
 * a hook remembers it.
 *
 * Two kinds of leak, banned for different reasons:
 *
 *   - vocabulary tokens (`application`, `pnpm run`, `NestJS`, ...) couple the
 *     engine to one STACK. A plugin that assumed a test runner, a `src/`
 *     layout or a particular architecture would misbehave anywhere else.
 *   - a "read the archive for precedent" INSTRUCTION couples the engine to
 *     one repo's HISTORY, which is sharper: it passes a token check clean and
 *     then degrades in the worst direction — plan quality becomes a function
 *     of how long the repo has existed. `planner.md` already draws the line
 *     (failure lore yes, solution shape no); this keeps it from being
 *     re-crossed. Deliberately narrower than banning the string
 *     `specflow/archive`, which is the engine's own convention and appears
 *     throughout doing ordinary archival work. What is banned is recommending
 *     the archive's CONTENTS as a template.
 *
 *   node scripts/no-repo-refs.mjs
 *
 * Scans every command, agent, hook and script this plugin ships, plus the
 * prose in SCAN_FILES. Excludes itself: a checker necessarily names what it
 * checks for.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SELF = relative(ROOT, fileURLToPath(import.meta.url)).replace(/\\/g, '/');

// `.claude/skills` is in this list for the reason the list exists: a skill is
// prose that instructs, so an unscanned one is the cheapest possible place for
// stack vocabulary to reappear — and it would reappear in the file that tells
// the next author how to write. Directories are scanned whole, so a skill
// added later is covered without anyone remembering this line.
// Both skill directories, and they are not the same surface: `.claude/skills`
// is this repo's own development skills, `skills` is what ships to adopters
// inside the package. The second is the one this check has to hold, because a
// skill is where runner knowledge would land if anyone put it in a file — and
// a shipped skill that is not scanned is the "path of least resistance" this
// file's header names, one directory over. See ADR-006.
// `decisions/` is scanned on the same terms as every other surface, and needs
// no notion of "record prose may name what it measured": under ADR-007 the
// line is one repo's vocabulary, not one ecosystem's, so ADR-005 naming four
// runners it tested was never at risk from this list. Widening BANNED back to
// stack vocabulary would put a record in tension with a check — which is a
// reason to reopen ADR-007, not to exempt a directory.
const SCAN_DIRS = ['hooks', 'scripts', 'commands', 'agents', '.claude/skills', 'skills', 'decisions'];
const SCAN_EXTENSIONS = ['.mjs', '.md', '.json'];

// The prose docs are scanned too, and deliberately: they are the most public
// surface this plugin has and the first thing an adopting repo reads.
//
// EVERY prose doc goes in this list, not just the entry point. The moment a
// reference doc is split out of the README, the unscanned file becomes the
// path of least resistance for exactly the vocabulary this check keeps out —
// the leak moves one file over, which is worse than never scanning, because
// now it looks covered.
//
// No exception list, and no `examples/` directory to exempt. A worked contract
// naming a real layout would have to live outside this scan by construction —
// a contract's whole job is to hold the values the engine refuses to know.
// `scripts/init.mjs` generates that file from the adopting repo instead.
//
// **This check is about ONE repo, not one stack**, and the difference is
// load-bearing under ADR-007. A test runner's name is not coupling: the
// supported scope is Node, and `init` ships a table saying how each supported
// runner writes a report — a table that cannot exist if naming a runner fails
// CI. What stays banned is the vocabulary that identifies a single codebase:
// its package manager, its framework, its layer names. Widening this list back
// to stack vocabulary reopens ADR-007 and needs to say what changed.

const SCAN_FILES = [
  'README.md',
  'REFERENCE.md',
  'CLAUDE.md',
  'LICENSE',
  'BACKLOG.md',
  '.github/workflows/ci.yml',
];

// Whole-word or path-shaped tokens — a substring match on "application" would
// also flag the English word inside unrelated prose ("the application of
// this rule"), which is noise, not signal. Each is anchored so it matches the
// vocabulary, not every appearance of the letters.
const BANNED = [
  { pattern: /\bsrc\//, label: 'src/' },
  { pattern: /\bapplication\/|\bapplication layer\b|application\/use-cases/, label: 'application (the hexagonal layer)' },
  { pattern: /\binfrastructure\/|\binfrastructure layer\b/, label: 'infrastructure (the hexagonal layer)' },
  { pattern: /\bdomain\/(services|interfaces|value-objects|models)?\b/, label: 'domain/ (the hexagonal layer)' },
  { pattern: /\bpnpm run\b/, label: 'pnpm run' },
  // No runner name belongs in this list: ADR-007 made Node the scope. See the
  // header for the line between one repo's vocabulary and one ecosystem's.
  { pattern: /\beslint\.config\.mjs\b/, label: 'eslint.config.mjs' },
  { pattern: /\bNestJS\b/i, label: 'NestJS' },
  { pattern: /\bdomain-service-trace\b/, label: 'domain-service-trace' },
  // Proximity, not a path-string ban — see this file's header.
  {
    pattern: /\barchive\b[^.]{0,60}\b(precedent|inspiration)\b|\b(precedent|inspiration)\b[^.]{0,60}\barchive\b/i,
    label: 'reads the archive for precedent/inspiration — shape guidance from one repo\'s history, not this repo\'s job',
  },
];

function walk(dir, found = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, found);
    else if (SCAN_EXTENSIONS.some((ext) => entry.endsWith(ext))) found.push(full);
  }
  return found;
}

const files = SCAN_DIRS.filter((d) => {
  try {
    return statSync(join(ROOT, d)).isDirectory();
  } catch {
    return false;
  }
})
  .flatMap((d) => walk(join(ROOT, d)))
  .concat(
    SCAN_FILES.map((f) => join(ROOT, f)).filter((f) => {
      try {
        return statSync(f).isFile();
      } catch {
        return false;
      }
    }),
  )
  .filter((f) => relative(ROOT, f).replace(/\\/g, '/') !== SELF);

const findings = [];
for (const file of files) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');

  for (const { pattern, label } of BANNED) {
    lines.forEach((line, i) => {
      if (pattern.test(line)) findings.push(`${rel}:${i + 1}  ${label}\n    ${line.trim()}`);
    });
  }
}

if (findings.length > 0) {
  console.error(`no-repo-refs: ${findings.length} reference(s) to a specific repo's vocabulary or history.\n`);
  for (const f of findings) console.error(`  - ${f}`);
  console.error(
    '\nThe engine must run identically against any consuming repo. A value that ' +
      'belongs to one repo goes in that repo\'s .spec-flow/config.json, not in this file.',
  );
  process.exit(1);
}

console.log(`no-repo-refs: OK — ${files.length} file(s) clean of repo-specific vocabulary and history.`);
