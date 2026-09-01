#!/usr/bin/env node
/**
 * Where a run is, what the gate last said, and what it has cost — read off
 * `.claude/state/` from outside the session.
 *
 * The engine already writes all of this down. What it had no way to do was
 * SHOW it: a Stop hook's `systemMessage` is discarded in an interactive
 * session (ADR-010), so between two turns the only surfaces are a block
 * message that has scrolled away and four log files nobody reads by hand.
 *
 * NEVER FAILS, and gates nothing. Same standing as `specflow-stats.mjs`: an
 * exit code here would be a verdict, and every verdict this engine renders
 * comes from the gate.
 *
 * **Creates nothing.** Run in a repo that never adopted the flow it must
 * leave no `.claude/` behind, so every path is read through `existsSync` and
 * `stateDir()` is never called.
 *
 *   node scripts/status.mjs      # or: spec-flow status
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFields, summarizeTokens, tokenRow } from './trace-lines.mjs';

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const STATE = join(root, '.claude', 'state');

const read = (file) => (existsSync(join(STATE, file)) ? readFileSync(join(STATE, file), 'utf8').trim() : '');
const lines = (file) => read(file).split('\n').map((l) => l.trim()).filter(Boolean);
const say = (...args) => console.log(...args);

say('spec-flow status — report only, nothing here gates anything');
say(`repo: ${root}\n`);

// ---- the run ---------------------------------------------------------------
const phase = read('phase');
const owner = read('phase.session');

say('Run');
if (!phase || ['idle', 'done'].includes(phase)) {
  say(`  phase: ${phase || '(none)'} — no run is armed. The hooks that enforce anything stand down here.`);
} else {
  say(`  phase: ${phase}${owner ? ` (owned by session ${owner})` : ''}`);
}

// `<SLUG> <Mk> <session>`, written by register-agent.mjs from an implementer
// spawn — the only place the run's position is recorded at all.
const milestone = read('current-milestone').split(/\s+/).filter(Boolean);
if (milestone.length >= 2) {
  say(`  milestone: ${milestone[1]} of ${milestone[0]}${milestone[2] ? ` (implementer session ${milestone[2]})` : ''}`);
} else if (phase === 'implement') {
  say('  milestone: not recorded — no implementer has been spawned in this run yet.');
}

const attempts = Number(read('gate_attempts')) || 0;
if (attempts > 0) {
  // The cap is `MAX_ATTEMPTS` in gate.mjs and is NOT restated here. It is
  // already prose in one doc, and a third copy is how a number starts
  // disagreeing with itself; the failure log below carries the gate's own
  // `attempt N/M` when there is one to read.
  say(`  consecutive gate failures: ${attempts} (the cap, and what happens at it, is the gate's — see the failure log below)`);
}
say('');

// ---- the gate --------------------------------------------------------------
const history = lines('gate-history.log');

say('Gate');
if (history.length === 0) {
  say('  no gate history — this repo has not run a milestone through the gate.');
} else {
  const last = parseFields(history[history.length - 1]);
  const sha = history[history.length - 1].split(' ')[1];
  say(`  last: ${last.result ?? '?'} — ${sha} (lint ${last.lint ?? '?'}, test ${last.test ?? '?'})`);
  if (last.at) say(`        at ${last.at.toISOString().replace(/\.\d+Z$/, 'Z')}, engine ${last.engine ?? '?'}, claude code ${last.cc ?? '?'}`);

  // A `running` line that was never replaced is the gate's own proof that the
  // invocation which wrote it was KILLED mid-judgement — the one failure
  // gate.mjs cannot report itself, because a hook that is cancelled renders no
  // decision and a Stop with no decision ALLOWS the stop.
  if (last.result === 'running') {
    say('  WARNING: that line was never replaced, so the gate was killed mid-judgement.');
    say('  Nothing it was judging was verified. The next armed run reports it.');
  }

  const tally = history.map((l) => parseFields(l).result).reduce((acc, r) => ({ ...acc, [r]: (acc[r] ?? 0) + 1 }), {});
  say(`  history: ${history.length} invocation(s) — ${Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(', ')}`);
}

if (read('gate-failure.log')) {
  const failure = lines('gate-failure.log');
  say(`  the last failure is on disk (${failure.length} line(s)): .claude/state/gate-failure.log`);
  const header = failure.find((l) => l.startsWith('=== GATE FAILURE'));
  if (header) say(`  ${header.replace(/^=== | ===$/g, '')}`);
}
say('');

// ---- what it has cost ------------------------------------------------------
// Same summary `specflow-stats.mjs` prints, through the same module, because
// two numbers for one question that disagree are worse than one that is wrong.
const rows = summarizeTokens(lines('run-trace.log').map(parseFields));

say('Cost');
if (rows.length === 0) {
  say('  no token accounting recorded — token-trace.mjs writes it at each stop of an armed run.');
} else {
  const width = Math.max(...rows.map((r) => r.model.length));
  for (const r of rows) say(`  ${tokenRow(r, width)}`);
  say('  This is the live state only. `spec-flow stats` adds every archived run.');
}
say('');

say('Everything above is written by the run itself. `spec-flow stats` reads the same');
say('state plus the archived runs, and asks what it means.');
