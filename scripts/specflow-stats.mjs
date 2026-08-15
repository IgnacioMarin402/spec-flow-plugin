#!/usr/bin/env node
// Reads the telemetry a spec-flow run leaves behind and reports what it says.
//
//   node scripts/specflow-stats.mjs          # the report
//   node scripts/specflow-stats.mjs --raw    # also dump the timeline it read
//
// THIS SCRIPT NEVER FAILS. It always exits 0, it is not wired into the gate,
// into CI or into the everyday check command, and nothing in the flow
// consults it. That is deliberate: the flow's change policy says a proposal
// without a failing run attached defaults to no, so the missing piece was
// never another rule — it was evidence. A check that blocked on these numbers
// would be exactly the preemptive rule that policy exists to refuse.
//
// It answers three questions the flow cannot currently answer about itself:
//
//   1. Does a silent PASS strand runs between milestones? A gate history
//      whose last line is a PASS, with the phase still `implement` and
//      nothing after it, is that stall.
//   2. Is the test-first protocol honored? It lives in prose in the
//      implementer's instructions and the gate only ever sees the final
//      state — but it has an observable signature: the spec file is
//      written, a scoped test run goes red, and only then the source
//      appears.
//   3. Does the reviewer review, or rubber-stamp? If every plan it ever sees
//      comes back APPROVED with no escalation, the step is costing a call
//      and buying nothing.
//
// Sources, in two tiers:
//
//   .claude/state/{gate-history,run-trace}.log     the run happening now
//   specflow/**/<SLUG>/telemetry/*.log             every run that was archived
//
// The state files are gitignored working files, so a fresh clone sees only
// the archived tier — telemetry-snapshot.mjs writes the second tier.
//
// Kept SEPARATE rather than concatenated, and that is a correctness
// requirement: two of the three questions below are about ORDER inside one
// run, and across a run boundary the gap is days and means nothing.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './spec-flow-config.mjs';

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const STATE = join(root, '.claude', 'state');
const RAW = process.argv.includes('--raw');

// The orchestrator schedules its post-PASS self check-in about two minutes
// out, so a gap of ten is well past "slow" and into "nothing is coming".
const STALL_MINUTES = 10;

function lines(file, dir = STATE) {
  const path = join(dir, file);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
}

/** One entry per run: the live one first, then every archived snapshot. */
function collectRuns() {
  const runs = [{ name: '(current)', dir: STATE }];

  for (const base of [join(root, 'specflow', 'archive'), join(root, 'specflow')]) {
    if (!existsSync(base)) continue;
    for (const slug of readdirSync(base).sort()) {
      if (slug === 'archive') continue;
      const dir = join(base, slug, 'telemetry');
      if (existsSync(dir)) runs.push({ name: slug, dir });
    }
  }

  return runs
    .map((r) => ({ name: r.name, gate: lines('gate-history.log', r.dir).map(parse), trace: lines('run-trace.log', r.dir).map(parse) }))
    .filter((r) => r.name === '(current)' || r.gate.length > 0 || r.trace.length > 0);
}

/** `k=v k=v` pairs off a log line, plus the leading ISO timestamp. */
function parse(line) {
  const fields = Object.fromEntries([...line.matchAll(/(\w[\w-]*)=(\S+)/g)].map(([, k, v]) => [k, v]));
  const at = /^(\S+Z)/.exec(line);
  return { at: at ? new Date(at[1]) : null, raw: line, ...fields };
}

const minutesBetween = (a, b) => Math.round((b - a) / 60000);
const say = (...args) => console.log(...args);
const warn = [];

const phase = existsSync(join(STATE, 'phase')) ? readFileSync(join(STATE, 'phase'), 'utf8').trim() : '(none)';

say(`spec-flow stats — report only, nothing here gates anything`);
say(`current phase: ${phase}\n`);

// ---- 1. the gate, and whether a PASS stranded the run ----------------------
const runs = collectRuns();
const current = runs[0];
const gate = runs.flatMap((r) => r.gate);

say('Gate');
if (gate.length === 0) {
  say('  no gate history yet — run /spec-flow at least once.');
} else {
  const tally = gate.reduce((acc, g) => {
    acc[g.result] = (acc[g.result] ?? 0) + 1;
    return acc;
  }, {});
  const summary = Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(', ');
  const withData = runs.filter((r) => r.gate.length > 0 || r.trace.length > 0).length;
  const scope = withData > 1 ? ` across ${withData} run(s)` : '';
  say(`  ${gate.length} invocation(s)${scope}: ${summary}`);

  let worst = null;
  for (const run of runs) {
    for (let i = 0; i < run.gate.length - 1; i++) {
      if (run.gate[i].result !== 'pass' || !run.gate[i].at || !run.gate[i + 1].at) continue;
      const gap = minutesBetween(run.gate[i].at, run.gate[i + 1].at);
      if (!worst || gap > worst.gap) worst = { gap, at: run.gate[i].at, run: run.name };
    }
  }
  if (worst) {
    const where = runs.length > 1 ? ` in ${worst.run}` : '';
    say(`  longest gap after a PASS: ${worst.gap}m${where} (${worst.at.toISOString()})`);
    if (worst.gap >= STALL_MINUTES) {
      warn.push(`a PASS was followed by ${worst.gap}m of gate silence${where} — the run had to be nudged.`);
    }
  }

  const last = current.gate[current.gate.length - 1];
  if (last && last.result === 'pass' && phase === 'implement' && last.at) {
    const idle = minutesBetween(last.at, new Date());
    say(`  last line is a PASS, ${idle}m ago, phase still \`implement\``);
    if (idle >= STALL_MINUTES) {
      warn.push(`the run looks stalled RIGHT NOW: ${idle}m since a PASS with the phase still armed. Nothing re-wakes the orchestrator on a pass.`);
    }
  }
}
say('');

// ---- 2. test-first, by its observable signature ----------------------------
//
// Pairing a source file to its test used to be two hardcoded extensions —
// `.spec.ts` and `.ts` — in the one part of this engine whose whole purpose is
// saying whether the protocol in the implementer's prose is being followed. On
// any repo that was not TypeScript the pairing matched nothing and this
// section printed "no source file was written alongside its own spec", which
// reads as "nothing to report" and meant "this metric cannot see your repo".
// Reporting absence where the truth is blindness is the same failure as a
// check that looks armed and is not, with the severity turned down because
// nothing here gates anything.
//
// The contract already knew both halves: `trace.proof_suffix` is what a test
// file is called, and `verify.scope_globs` names the source extensions. Read
// defensively, because this script's header promises it never fails — an
// unreadable contract makes the pairing UNKNOWN, which is said out loud rather
// than reported as an absence of pairs.
//
// Two things the old version got wrong, and the second is why this pairs on
// BASENAME rather than on the whole path:
//
//   - `file.replace(/\.ts$/, '.spec.ts')` is a no-op on a file that does not
//     end in `.ts`, so on any other stack every source file was looked up as
//     ITSELF, found itself, and produced a verdict. That is not blindness, it
//     is fabricated data: a Python trace reported `no-red-run` MISSes for
//     files that had never been paired with anything.
//   - it assumed a test sits beside its source. That holds for a colocated
//     layout and not for a repo that keeps proofs in a directory of their own,
//     which the contract explicitly supports via `proof_dir`. Matching the
//     basename covers both, and the trace has no other way to relate them.
const trace = runs.flatMap((r) => r.trace);

const baseOf = (path) => path.split(/[\\/]/).pop();

let expectedTestName = null;
let pairingProblem = '';
try {
  const config = loadConfig(root);
  const suffix = config.trace.proof_suffix;
  const sourceExts = [...new Set(config.verify.scope_globs.map((g) => g.replace(/^\*/, '')).filter((e) => e.startsWith('.')))];
  if (!suffix || sourceExts.length === 0) {
    pairingProblem = 'the contract names no proof_suffix or no source extension, so a source file cannot be paired to its test';
  } else {
    expectedTestName = (file) => {
      const name = baseOf(file);
      if (name.endsWith(suffix)) return null; // this IS a test file
      const ext = sourceExts.find((e) => name.endsWith(e));
      return ext ? `${name.slice(0, -ext.length)}${suffix}` : null;
    };
  }
} catch (err) {
  pairingProblem = `the contract could not be read (${err.message.split('\n')[0]})`;
}

const verdicts = [];
for (const run of expectedTestName ? runs : []) {
  const firstWrite = new Map();
  const firstWriteByName = new Map();
  for (const [i, e] of run.trace.entries()) {
    if (!e.file) continue;
    if (!firstWrite.has(e.file)) firstWrite.set(e.file, i);
    if (!firstWriteByName.has(baseOf(e.file))) firstWriteByName.set(baseOf(e.file), i);
  }

  for (const [file, sourceIdx] of firstWrite) {
    const testName = expectedTestName(file);
    if (!testName) continue;
    const specIdx = firstWriteByName.get(testName);
    if (specIdx === undefined) continue;

    const redBetween = run.trace.some((e, i) => i > specIdx && i < sourceIdx && e.verdict === 'red');
    const status = specIdx > sourceIdx ? 'code-first' : redBetween ? 'red-first' : 'no-red-run';
    verdicts.push({ file, status, run: run.name });
  }
}

say('Test-first');
if (!expectedTestName) {
  say(`  UNKNOWN — ${pairingProblem}.`);
  say('  This is not "no misses found": nothing was measured. Fix the contract to get an answer.');
} else if (trace.length === 0) {
  say('  no run trace yet — run-trace.mjs writes it during a live run.');
} else if (verdicts.length === 0) {
  say('  no source file was written alongside its own test in this trace.');
} else {
  for (const { file, status, run } of verdicts) {
    const mark = status === 'red-first' ? 'OK  ' : 'MISS';
    const where = runs.length > 1 ? `  [${run}]` : '';
    say(`  ${mark} ${file}  (${status})${where}`);
  }
  const missed = verdicts.filter((v) => v.status !== 'red-first');
  if (missed.length > 0) {
    warn.push(`${missed.length}/${verdicts.length} requirement(s) show no red test run before the code. A test written after the implementation mirrors it and passes on day one.`);
  }
}
say('');

// ---- 3. the reviewer, and whether it reviews -------------------------------
const agents = trace.filter((e) => e.type && e.status);

say('Agents');
if (agents.length === 0) {
  say('  no subagent outcomes recorded yet.');
} else {
  const byAgent = new Map();
  for (const a of agents) {
    if (!byAgent.has(a.type)) byAgent.set(a.type, new Map());
    const outcomes = byAgent.get(a.type);
    outcomes.set(a.status, (outcomes.get(a.status) ?? 0) + 1);
  }
  for (const [type, outcomes] of byAgent) {
    say(`  ${type}: ${[...outcomes].map(([status, n]) => `${n} ${status}`).join(', ')}`);
  }

  const reviewer = byAgent.get('reviewer');
  if (reviewer) {
    const total = [...reviewer.values()].reduce((a, b) => a + b, 0);
    const approved = reviewer.get('APPROVED') ?? 0;
    if (total >= 3 && approved === total) {
      warn.push(`the reviewer approved all ${total} plan(s) it saw, never escalating. Either the planner is that good or the step is a rubber-stamp — worth deciding once the sample is big enough.`);
    }
  }
}
say('');

// ---- 3b. does the plan's skill routing actually land? ----------------------
// `Skills:` in a milestone is filled by the planner reading the whole
// milestone before anything is written; the implementer reports what it
// needed and did not find there. One miss is noise. A pattern is the only
// evidence that would justify changing where that routing happens — which is
// the standard this flow sets for changing itself.
const misses = trace.flatMap((e) => (e.skill_miss ? e.skill_miss.split(',') : []));

say('Skill routing');
if (agents.length === 0) {
  say('  no subagent outcomes recorded yet.');
} else if (misses.length === 0) {
  say(`  no misses reported across ${agents.length} subagent return(s).`);
} else {
  const tally = misses.reduce((acc, m) => {
    acc[m] = (acc[m] ?? 0) + 1;
    return acc;
  }, {});
  const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  say(`  ${misses.length} miss(es): ${ranked.map(([m, n]) => `${m} x${n}`).join(', ')}`);
  if (ranked[0][1] >= 3) {
    warn.push(
      `"${ranked[0][0]}" was needed but not routed ${ranked[0][1]} times. A skill the planner keeps missing usually has a description that does not match the decision it actually applies to — the description is what the planner routes on.`,
    );
  }
}
say('');

// ---- 4. what the run READ, which is the only record of its inputs ----------
const reads = runs.flatMap((r) => r.trace).filter((e) => e.raw?.includes(' read file='));

say('Reads');
if (reads.length === 0) {
  say('  no reads recorded — run-trace.mjs logs these only during a live run.');
} else {
  const byPhase = reads.reduce((acc, r) => {
    acc[r.phase ?? '?'] = (acc[r.phase ?? '?'] ?? 0) + 1;
    return acc;
  }, {});
  say(`  ${reads.length} file read(s): ` + Object.entries(byPhase).map(([p, n]) => `${n} in ${p}`).join(', '));

  const archiveReads = reads.filter((r) => /specflow[\\/]archive/.test(r.raw));
  if (archiveReads.length > 0) {
    const inPlan = archiveReads.filter((r) => r.phase === 'plan').length;
    say(`  ${archiveReads.length} of them under specflow/archive/${inPlan > 0 ? ` (${inPlan} while planning)` : ''}`);
    if (inPlan > 0) {
      warn.push(`${inPlan} archived change spec(s) were read during the plan phase. The planner's own instructions allow this for failure lore and forbid it for solution shape — worth checking which one it was, because only the plan's prose can say.`);
    }
  }
}
say('');

// ---- parsing gaps this telemetry knows about -------------------------------
for (const [file, what] of [
  ['run-trace-unmatched.log', 'subagent returns with no STATUS line'],
  ['opus-budget-unmatched.log', 'SendMessage payloads the budget could not attribute'],
  ['register-agent-unmatched.log', 'Opus spawns whose session id was not found'],
]) {
  const n = lines(file).length;
  if (n > 0) say(`note: ${n} ${what} — see .claude/state/${file}`);
}

if (warn.length > 0) {
  say('\nWhat this run is telling you:');
  for (const w of warn) say(`  - ${w}`);
  say('\nThese are observations, not a verdict. The flow changes on a failing run,\nand one line of telemetry is not one yet — but it is how you get there.');
}

if (RAW) {
  for (const run of runs) {
    if (run.gate.length === 0 && run.trace.length === 0) continue;
    say(`\n=== ${run.name} ===`);
    if (run.gate.length) {
      say('--- gate-history.log ---');
      for (const g of run.gate) say(`  ${g.raw}`);
    }
    if (run.trace.length) {
      say('--- run-trace.log ---');
      for (const t of run.trace) say(`  ${t.raw}`);
    }
  }
}
