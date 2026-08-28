#!/usr/bin/env node
/**
 * How much HISTORY is sitting in this engine's comments.
 *
 * `.claude/skills/engine-comments` splits reasoning three ways — an invariant
 * beside the code, a transition in the commit message, a decision in
 * `decisions/` — and a transition is the one that does not belong where it is
 * written. Git holds it already, with the diff attached, and unlike a comment
 * it cannot drift from what actually happened.
 *
 * The rule shipped with the skill, `CLAUDE.md`, the records and
 * `scripts/decisions.mjs`. Nothing measured the thing the rule is about, so
 * the pass that applied it closed on a number in a backlog entry — and this
 * repo's own contract says an item is done when a check goes red before the
 * fix and green after, not when a paragraph says so.
 *
 * **The measurement is transition TEXT, not comment density**, and the skill
 * is what settles that: ratio and history turn out to be near-independent
 * here, "which is why a percentage is a poor way to decide where to look and
 * a worse way to decide when to stop". A file at 45% whose comments are all
 * invariants is finished. A file carrying three sentences about what it used
 * to be is not, whatever it scores.
 *
 * **The count is asserted EQUAL to `EXPECTED`, not merely capped.** A ceiling
 * only ever notices the direction that gets worse, and a count that silently
 * drifts below its ceiling is the same stale number this check exists to
 * replace. Equality means the figure in this file is always the measured one
 * and every move is a deliberate edit with a commit message behind it.
 *
 * Zero is the wrong target and is deliberately not it. The skill names the
 * exception: where an old shape is a trap someone is likely to reintroduce,
 * one line naming it is an invariant rather than history.
 *
 *   node scripts/comment-transitions.mjs          # check
 *   node scripts/comment-transitions.mjs --list   # print every line counted
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIST = process.argv.includes('--list');

/**
 * Every directory holding engine source. No exemption for the fixtures: the
 * skill says outright that no file in `hooks/` or `scripts/` is outside this
 * rule, and the one time they WERE exempt the exclusion turned out to be
 * hiding real history in four files.
 */
const SCAN_DIRS = ['hooks', 'scripts', 'bin'];

/**
 * The measured count over `SCAN_DIRS`. Update it in the same commit that
 * changes the comments, and say in that commit which way it moved and why.
 *
 * **It is a baseline, not a census.** `--list` shows that a minority of these
 * lines are about a superseded thing in the DOMAIN rather than about the
 * file's own past: spec-trace reasoning over a test that asserts behaviour
 * since replaced, `decisions.mjs` describing how one record supersedes
 * another. Telling those apart mechanically would need this file to know
 * which sense a sentence means, which it cannot. It does not need to — the
 * number's job is to MOVE when someone lets history back in, and a stable
 * baseline of known composition does that exactly as well as a pure one.
 *
 * The same property applies to this file: its own prose is scanned like every
 * other, so an example written out here would be counted. Hence the
 * circumlocutions above.
 */
const EXPECTED = 29;

/**
 * Phrases that mark a sentence as HISTORY rather than as an invariant.
 *
 * Deliberately narrow, and narrowed by measurement rather than by taste: a
 * first pattern here also matched `before this`, `before it` and `it was`,
 * which are ordinary English inside an invariant — "handled before this run
 * writes its own line" is an ordering constraint, not a story. That pattern
 * reported 48 where the real figure was 23, and a check that cries wolf twice
 * for every true hit is one people learn to re-run with a wider grep.
 *
 * The cost of the narrowing is misses, which is the right way to be wrong
 * here: this number's job is to move when someone lets history back in, and a
 * miss keeps it flat while a false positive makes it unreadable.
 */
const TRANSITION = /\bused to\b|\bpreviously\b|\bthe old\b|\bthis replaced\b|\bno longer\b|\bhad been\b|\bfor a while\b|\bonce before\b|\bshipped in exactly\b/i;

/** A comment line — a `//`, or a line inside or opening a block comment. */
const COMMENT_LINE = /^\s*(\/\/|\*|\/\*)/;

function sources(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sources(path, acc);
    else if (path.endsWith('.mjs')) acc.push(path);
  }
  return acc;
}

const files = sources(join(ROOT, SCAN_DIRS[0]));
for (const dir of SCAN_DIRS.slice(1)) sources(join(ROOT, dir), files);

// A scan that reached nothing reports exactly as a clean engine does — the
// same failure `coupling-fixture.mjs` exists to close for the prose scanner.
if (files.length === 0) {
  console.error(
    `comment-transitions: found no .mjs under ${SCAN_DIRS.join(', ')}. A scan that reaches nothing passes exactly as a clean one does, so this is a failure rather than a quiet OK.`,
  );
  process.exit(1);
}

const hits = [];
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  for (const [i, line] of lines.entries()) {
    if (!COMMENT_LINE.test(line) || !TRANSITION.test(line)) continue;
    hits.push({ file: relative(ROOT, file).replace(/\\/g, '/'), line: i + 1, text: line.trim() });
  }
}

if (LIST) {
  for (const hit of hits) console.log(`${hit.file}:${hit.line}  ${hit.text}`);
  console.log('');
}

if (hits.length !== EXPECTED) {
  const byFile = hits.reduce((acc, h) => ({ ...acc, [h.file]: (acc[h.file] ?? 0) + 1 }), {});
  const worst = Object.entries(byFile).sort((a, b) => b[1] - a[1]).slice(0, 5);

  console.error(
    hits.length > EXPECTED
      ? `comment-transitions: ${hits.length} transition line(s), and EXPECTED says ${EXPECTED}.\n\n` +
          `  Something's history moved back into a comment. Git already holds it with the diff\n` +
          `  attached — put it in the commit message instead, and see .claude/skills/engine-comments\n` +
          `  for the one case where naming an old shape IS an invariant. If this line is that case,\n` +
          `  raise EXPECTED in scripts/comment-transitions.mjs and say why in the commit.\n`
      : `comment-transitions: ${hits.length} transition line(s), and EXPECTED says ${EXPECTED}.\n\n` +
          `  Fewer than recorded, which is the direction this rule wants — but the number in\n` +
          `  scripts/comment-transitions.mjs is now stale, and a stale number is what this check\n` +
          `  replaced. Lower EXPECTED to ${hits.length} in the same commit.\n`,
  );
  console.error(`  Run with --list to see every line counted. Most, by file:`);
  for (const [file, n] of worst) console.error(`    ${String(n).padStart(3)}  ${file}`);
  process.exit(1);
}

console.log(
  `comment-transitions: OK — ${hits.length} transition line(s) across ${files.length} engine source file(s), matching what this check records. Density is deliberately not measured; see this file's header.`,
);
