#!/usr/bin/env node
/**
 * Make a run's telemetry outlive the machine that produced it.
 *
 * run-trace.mjs and gate.mjs write to .claude/state/, which is gitignored —
 * correctly so: both append on every tool call or gate invocation, and a
 * tracked file that changes that often would leave the tree permanently
 * dirty, which makes the gate's quiescence guard skip the gate on every
 * stop, forever.
 *
 * So the run copies its own slice into the change folder instead, which the
 * FOLD step already commits and archives. That is the whole idea: the
 * evidence travels with the change that produced it.
 *
 * It copies the RAW `k=v` lines rather than a derived report, so archiving
 * costs no new parser and keeps every future question open.
 *
 *   node scripts/telemetry-snapshot.mjs --mark    # at the start of a run
 *   node scripts/telemetry-snapshot.mjs <SLUG>    # at the end of one
 *
 * The mark is not optional bookkeeping. Both logs are cumulative per machine
 * and never truncated, so at DONE the file holds this run AND every run
 * before it. `--mark` records how many lines were already there; the
 * snapshot takes everything after. In a fresh cloud container the offset is
 * 0, which is exactly why it is easy to forget matters anywhere else.
 *
 * Always exits 0 — a run whose telemetry is empty is a fact worth recording
 * quietly, not a reason to fail a close that already passed the gate.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const STATE = join(root, '.claude', 'state');
const OFFSET_FILE = join(STATE, 'run-offset');

// The failure logs are deliberately absent: gate.mjs truncates them on every
// pass, so what survives to DONE is noise from the last failure, not a
// record of the run.
const LOGS = ['run-trace.log', 'gate-history.log'];

const readLines = (file, dir = STATE) => {
  const p = join(dir, file);
  return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()) : [];
};

const args = process.argv.slice(2);

if (args.includes('--mark')) {
  mkdirSync(STATE, { recursive: true });
  const offsets = Object.fromEntries(LOGS.map((f) => [f, readLines(f).length]));
  writeFileSync(OFFSET_FILE, `${JSON.stringify(offsets)}\n`);
  const total = Object.values(offsets).reduce((a, b) => a + b, 0);
  console.log(
    total === 0
      ? 'telemetry: mark set at an empty state — this run starts the record.'
      : `telemetry: mark set — ${total} pre-existing line(s) will be excluded from this run's slice.`,
  );
  process.exit(0);
}

const slug = args.find((a) => !a.startsWith('-'));
if (!slug) {
  console.log('telemetry: usage — telemetry-snapshot.mjs --mark | telemetry-snapshot.mjs <SLUG>');
  process.exit(1);
}

// The fold archives the folder before the run reaches DONE, so the archived
// path is the expected one; the live path is accepted for a snapshot taken
// before archiving, and for a fix, which may close either way.
const candidates = [join(root, 'specflow', 'archive', slug), join(root, 'specflow', slug)];
const target = candidates.find((c) => existsSync(c));

if (!target) {
  console.log(`telemetry: FAILED — no change folder named "${slug}" under specflow/ or specflow/archive/.`);
  process.exit(1);
}

let offsets = {};
if (existsSync(OFFSET_FILE)) {
  try {
    offsets = JSON.parse(readFileSync(OFFSET_FILE, 'utf8'));
  } catch {
    console.log('telemetry: the mark could not be read — taking the whole log, which may include earlier runs.');
  }
}

const dir = join(target, 'telemetry');
mkdirSync(dir, { recursive: true });

const written = [];
for (const file of LOGS) {
  const slice = readLines(file).slice(offsets[file] ?? 0);
  if (slice.length === 0) continue;
  writeFileSync(join(dir, file), `${slice.join('\n')}\n`);
  written.push(`${file} (${slice.length} line(s))`);
}

if (written.length === 0) {
  console.log(`telemetry: nothing to snapshot for "${slug}" — the run produced no trace.`);
  process.exit(0);
}

console.log(`telemetry: snapshotted into ${dir.replace(root, '.').replace(/\\/g, '/')} — ${written.join(', ')}`);
