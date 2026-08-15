#!/usr/bin/env node
/**
 * The plugin's equivalent of a consuming repo's own architectural boundary
 * rules: fails if any engine file mentions the vocabulary or the reasoning
 * pattern of the one repo this engine was extracted from.
 *
 * The engine stops knowing the repo and starts depending on a contract the
 * repo implements — `.spec-flow/config.json` — the same inversion a
 * hexagonal repo applies one level down (`application` depends on a port,
 * `infrastructure` implements it). This is the check that makes the reversed
 * arrow checkable, instead of a rule that only holds while whoever edits a
 * hook remembers not to reach for `src/` again.
 *
 * Two different kinds of leak are banned, and they fail for different
 * reasons:
 *
 *   - vocabulary tokens (`application`, `pnpm run`, `NestJS`, ...) couple the
 *     engine to one repo's STACK. A plugin that assumed a test runner, or a
 *     `src/` layout, or a hexagonal `application` directory would not run
 *     correctly against a repo on a different stack or architecture, which is
 *     the whole reason this extraction exists.
 *   - a "read the archive for precedent" INSTRUCTION couples the engine to
 *     one repo's HISTORY, which is a sharper problem than vocabulary: it
 *     passes a token check clean and then degrades in the worst possible
 *     direction — a repo with no history behaves one way, a repo with years
 *     of it another, so plan quality becomes a function of how long the repo
 *     has existed. `planner.md` in this plugin draws its own line already
 *     (failure lore yes, solution shape no); this check is what keeps that
 *     line from being re-crossed by whoever edits it next. It is deliberately
 *     narrower than banning the string `specflow/archive` outright — that
 *     path is the engine's own structural convention and appears throughout
 *     this plugin doing ordinary archival work (moving a folder, checking a
 *     status). What is actually banned is recommending the archive's
 *     CONTENTS as a template.
 *
 *   node scripts/no-repo-refs.mjs
 *
 * Scans every command, agent, hook and script this plugin ships. Excludes
 * itself: a checker necessarily names what it checks for.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SELF = relative(ROOT, fileURLToPath(import.meta.url)).replace(/\\/g, '/');

const SCAN_DIRS = ['hooks', 'scripts', 'commands', 'agents'];
const SCAN_EXTENSIONS = ['.mjs', '.md', '.json'];

// The prose docs are scanned too, and that is not an afterthought: they are
// the most public surface this plugin has, the first thing an adopting repo
// reads, and they were the one place the coupling check did not cover — which
// is exactly how the README ended up naming the repo this engine was
// extracted from, and pointing at a design document that exists only there.
//
// EVERY prose doc goes in this list, not just the entry point. The moment a
// reference doc is split out of the README, the unscanned file becomes the
// path of least resistance for exactly the vocabulary this check exists to
// keep out — the leak simply moves one file over, which is worse than never
// having scanned at all, because now it looks covered.
//
// There is no exception list, and there is no `examples/` directory to
// exempt. A worked contract naming a real runner and a real layout would have
// to live outside this scan by construction — a contract's whole job is to
// hold the values the engine refuses to know. `scripts/init.mjs` generates
// that file from the adopting repo instead, which needs no exemption: it
// names nothing, it reads what the repo already declares.
// The workflow is in this list for a reason worth stating, because it is not
// prose and looks out of place next to four Markdown files. It is the file that
// demonstrated the gap: `ci.yml` spent several commits pointing readers at a
// `conformance/` directory and a design document, neither of which exists here
// — the same class of reference this check exists to keep out, sitting in the
// one file type it could not see. A workflow is read by anyone evaluating the
// project and can name a stack as easily as a README can.
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
  { pattern: /\bjest\b/i, label: 'jest' },
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
