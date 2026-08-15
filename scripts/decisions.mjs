#!/usr/bin/env node
/**
 * Binds `decisions/` to the code, in both directions.
 *
 * A standalone document in this repo needs a reason to be trusted, because the
 * last one did not have it: `.spec-flow/skills.md` was deleted after it turned
 * out nothing read it — no script parsed it, so it could name skills that had
 * been renamed and nobody would learn. `decisions/` is allowed to exist on two
 * conditions, and this file is the second one.
 *
 *   1. A decision record claims a MOMENT, not a present state. "On this date,
 *      for these reasons, we chose X" stays true after X is reversed; a
 *      reversal writes a superseding record rather than editing the old one.
 *      That is the property `skills.md` lacked — it claimed "these are the
 *      skills", which the present falsified silently.
 *
 *   2. Every record is REACHABLE from the code it governs, and every citation
 *      resolves. That is what this checks, and it is the same shape as
 *      `plugin-paths.mjs`: an instruction naming a file that does not ship is
 *      an instruction that silently never runs, and a decision nobody cites is
 *      a decision nobody will find at the moment they are about to undo it.
 *
 * Both directions fail, and for different reasons:
 *
 *   citation with no record  -> a reader following `see ADR-007` finds
 *                               nothing, which is worse than no citation.
 *   record with no citation  -> the decision is unreachable from the code it
 *                               governs, so it will drift out of relevance
 *                               exactly the way `skills.md` did.
 *
 *   node scripts/decisions.mjs
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DECISIONS = join(ROOT, 'decisions');
const SELF = relative(ROOT, fileURLToPath(import.meta.url)).replace(/\\/g, '/');

// Where a citation may appear. The same surfaces the coupling check scans,
// plus the prose docs — a decision is as worth citing from REFERENCE as from a
// hook, and `decisions/` itself is excluded so cross-references between records
// do not count as being reached from the code.
const CITE_DIRS = ['hooks', 'scripts', 'commands', 'agents', '.claude/skills'];
const CITE_FILES = ['README.md', 'REFERENCE.md', 'CLAUDE.md', 'BACKLOG.md'];
const CITE_EXTENSIONS = ['.mjs', '.md', '.json'];

/** `ADR-004`, wherever it appears. Three digits, so a year or an id cannot match. */
const CITATION = /\bADR-(\d{3})\b/g;
/** `004-proof-comes-from-the-runner.md` */
const RECORD = /^(\d{3})-[a-z0-9-]+\.md$/;

function walk(dir, found = []) {
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, found);
    else if (CITE_EXTENSIONS.some((ext) => entry.endsWith(ext))) found.push(full);
  }
  return found;
}

const problems = [];

// ---- the records that exist --------------------------------------------
const records = new Map(); // number -> filename
if (existsSync(DECISIONS)) {
  for (const entry of readdirSync(DECISIONS).sort()) {
    if (entry === 'README.md') continue;
    const match = RECORD.exec(entry);
    if (!match) {
      problems.push(
        `decisions/${entry} is not named like a record. Use NNN-a-short-slug.md — the number is what a citation resolves against, so a file without one cannot be cited.`,
      );
      continue;
    }
    if (records.has(match[1])) {
      problems.push(`decisions/ has two records numbered ${match[1]}: ${records.get(match[1])} and ${entry}.`);
      continue;
    }
    records.set(match[1], entry);
  }
}

// ---- the citations that exist -------------------------------------------
const files = CITE_DIRS.flatMap((d) => walk(join(ROOT, d)))
  .concat(CITE_FILES.map((f) => join(ROOT, f)).filter((f) => existsSync(f)))
  .filter((f) => relative(ROOT, f).replace(/\\/g, '/') !== SELF);

const cited = new Map(); // number -> [files citing it]
for (const file of files) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  for (const [, number] of readFileSync(file, 'utf8').matchAll(CITATION)) {
    if (!cited.has(number)) cited.set(number, []);
    if (!cited.get(number).includes(rel)) cited.get(number).push(rel);
  }
}

// ---- direction 1: a citation must resolve --------------------------------
for (const [number, where] of cited) {
  if (!records.has(number)) {
    problems.push(
      `ADR-${number} is cited by ${where.join(', ')} but decisions/ has no record numbered ${number}. A reader following that citation finds nothing, which is worse than no citation at all.`,
    );
  }
}

// ---- direction 2: a record must be reachable ------------------------------
for (const [number, filename] of records) {
  if (!cited.has(number)) {
    problems.push(
      `decisions/${filename} is cited by nothing. A decision unreachable from the code it governs will not be found at the moment someone is about to undo it — which is how this repo's last standalone document became wrong without anyone noticing. Cite it (\`see ADR-${number}\`) from the file it constrains, or delete it.`,
    );
  }
}

if (problems.length > 0) {
  console.error(`decisions: ${problems.length} problem(s).\n`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(
  `decisions: OK — ${records.size} record(s), every one cited; ${cited.size} citation(s), every one resolving.`,
);
