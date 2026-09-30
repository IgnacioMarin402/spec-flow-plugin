#!/usr/bin/env node
// Reads the telemetry a spec-flow run leaves behind and reports what it says.
//
//   node scripts/specflow-stats.mjs          # the report
//   node scripts/specflow-stats.mjs --raw    # also dump the timeline it read
//
// THIS SCRIPT NEVER FAILS. It always exits 0, is wired into neither the gate
// nor CI, and nothing in the flow consults it. Deliberate: the change policy
// refuses a proposal with no failing run attached, so a check that blocked on
// these numbers would be the preemptive rule that policy exists to refuse.
// What was missing was never another rule — it was evidence.
//
// It answers three questions the flow cannot answer about itself:
//
//   1. Does a silent PASS strand runs between milestones? A gate history
//      ending in PASS, phase still `implement`, nothing after it, is that
//      stall.
//   2. Is the test-first protocol honored? It lives in prose in the
//      implementer's instructions and the gate sees only the final state, but
//      it has a signature: spec written, scoped test run red, source after.
//   3. Does the reviewer review, or rubber-stamp? Every plan coming back
//      APPROVED with no escalation means the step costs a call and buys
//      nothing.
//
// Two tiers of source, kept SEPARATE rather than concatenated — that is a
// correctness requirement, since two of the three questions are about ORDER
// within one run and across a run boundary the gap is days:
//
//   .claude/state/{gate-history,run-trace}.log     the run happening now
//   specflow/**/<SLUG>/telemetry/*.log             every archived run
//
// The state files are gitignored, so a fresh clone sees only the archived
// tier, which telemetry-snapshot.mjs writes.


import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './spec-flow-config.mjs';
import { parseFields as parse, roleOf, summarizeTokens, tokenRow, human } from './trace-lines.mjs';

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

/**
 * One entry per run: the live one first, then every archived snapshot.
 *
 * The two tiers OVERLAP and the overlap must be removed here, because every
 * section below flattens across runs. A snapshot is a slice of the live log,
 * not a separate recording, so a run taken on this machine is present in both
 * — and reading them as independent runs multiplies gate invocations, reads,
 * subagent returns and milestones by two.
 *
 * That failure has no symptom: it scales the totals uniformly, so the report
 * stays internally consistent and no line reads as wrong. It is only visible
 * against a hand count, which is how it survived.
 *
 * The archived tier wins the tie because it carries the run's slug. What is
 * left in `(current)` is exactly what no snapshot has captured yet, which is
 * the honest meaning of "current".
 */
function collectRuns() {
  const archived = [];
  for (const base of [join(root, 'specflow', 'archive'), join(root, 'specflow')]) {
    if (!existsSync(base)) continue;
    for (const slug of readdirSync(base).sort()) {
      if (slug === 'archive') continue;
      const dir = join(base, slug, 'telemetry');
      if (existsSync(dir)) archived.push({ name: slug, gate: lines('gate-history.log', dir), trace: lines('run-trace.log', dir) });
    }
  }

  // `lines()` trims, so a snapshot committed with CRLF matches the LF log it
  // was sliced from. Comparing raw text here would let the line ending decide
  // whether a run counts once or twice.
  const seen = new Set(archived.flatMap((r) => [...r.gate, ...r.trace]));
  const live = {
    name: '(current)',
    gate: lines('gate-history.log').filter((l) => !seen.has(l)),
    trace: lines('run-trace.log').filter((l) => !seen.has(l)),
  };

  return [live, ...archived]
    .map((r) => ({ name: r.name, gate: r.gate.map(parse), trace: r.trace.map(parseTrace) }))
    .filter((r) => r.name === '(current)' || r.gate.length > 0 || r.trace.length > 0);
}

/** A trace line, its agent `type` read as the role it names — see `roleOf`. */
function parseTrace(line) {
  const entry = parse(line);
  if (entry.type) entry.type = roleOf(entry.type);
  return entry;
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
// Pairing a source file to its test reads the contract rather than assuming
// extensions: `trace.proof_suffix` is what a test file is called, and
// `verify.scope_globs` names the source extensions. Hardcoding them makes the
// pairing match nothing outside one language, and this section then prints
// "no source file was written alongside its own spec" — reporting absence
// where the truth is blindness, which is the same failure as a check that
// looks armed and is not, with the severity turned down because nothing here
// gates anything.
//
// Read defensively, because this script never fails: an unreadable contract
// makes the pairing UNKNOWN, said out loud rather than reported as an absence.
//
// Two traps, and the second is why this pairs on BASENAME rather than on the
// whole path:
//
//   - a suffix swap like `file.replace(/\.ts$/, '.spec.ts')` is a no-op on any
//     other extension, so every source file resolves to ITSELF, finds itself
//     and produces a verdict. That is not blindness, it is fabricated data:
//     `no-red-run` MISSes for files never paired with anything.
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
//
// Split against the CHANGE'S SCOPE — the modules its deltas name and the
// files its milestones touch — because a count answers "how many" and the
// question a real run raised was "why those". A planner that opens twenty
// files of a module the change does not touch is learning how this repo
// builds a module from its source, which is the read a repo's own statement
// of its anatomy makes unnecessary (ADR-026). The scope is derived, never
// guessed: a change whose spec and milestones name nothing readable reports
// UNKNOWN rather than zero.
const reads = runs.flatMap((r) => r.trace).filter((e) => e.raw?.includes(' read file='));

/** A path as the scope compares it: forward slashes, no leading `./`, no trailing `/`. */
const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

const rootNorm = norm(root);

/** A read's path relative to this repo, or null when it points outside it. */
function insideRepo(file) {
  const p = norm(file);
  // Drive letters and the paths under them arrive in whichever case the tool
  // was handed, so the prefix test is case-blind where the filesystem is.
  const under = process.platform === 'win32' ? p.toLowerCase().startsWith(`${rootNorm.toLowerCase()}/`) : p.startsWith(`${rootNorm}/`);
  if (under) return p.slice(rootNorm.length + 1);
  return /^([a-zA-Z]:)?\//.test(p) ? null : p;
}

/** The change folder a run's artifacts live in, or null when it cannot be told. */
function changeDir(run) {
  if (run.name !== '(current)') {
    return [join(root, 'specflow', 'archive', run.name), join(root, 'specflow', run.name)].find((d) => existsSync(join(d, 'spec.md'))) ?? null;
  }
  // The live tier carries no slug: only a single live change folder names it.
  const live = existsSync(join(root, 'specflow'))
    ? readdirSync(join(root, 'specflow')).filter((e) => e !== 'archive' && existsSync(join(root, 'specflow', e, 'spec.md')))
    : [];
  return live.length === 1 ? join(root, 'specflow', live[0]) : null;
}

const REQ_ID = /(?<![A-Z0-9])REQ-([A-Z0-9-]+)-\d{3}(?!\d)/g;
const SCOPE_MARKER = /^<!--\s*spec-scope:\s*(.+?)\s*-->$/m;
// The field runs to the next top-level field, a heading, or the end of the
// file. No `m` flag: `$` has to mean the end of the text, not of a line.
const FILES_FIELD = /(?:^|\n)[-*][ \t]*\**Files to add\/change\**[ \t]*:([\s\S]*?)(?=\n[-*][ \t]*\**[A-Z][^:\n]*\**[ \t]*:|\n#|$)/;

/**
 * The directories a change is about: what its deltas' capability specs scope
 * (`<!-- spec-scope: ... -->`, the marker spec-trace binds on) plus the
 * directory of every path its milestones name. `from` says which of the two
 * answered, so a scope built from nothing is reported as such.
 */
function changeScope(dir, specsDir) {
  const dirs = new Set();
  const from = [];
  const text = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '');

  const deltas = text(join(dir, 'spec.md')).split(/^## /m).find((s) => /^Requirement deltas/.test(s)) ?? '';
  for (const cap of new Set([...deltas.matchAll(REQ_ID)].map((m) => m[1].toLowerCase()))) {
    const marker = SCOPE_MARKER.exec(text(join(root, specsDir, `${cap}.md`)));
    if (!marker) continue;
    dirs.add(norm(marker[1]));
    from.push(`${specsDir}/${cap}.md`);
  }

  const milestones = join(dir, 'milestones');
  let named = 0;
  for (const file of existsSync(milestones) ? readdirSync(milestones).filter((f) => f.endsWith('.md')).sort() : []) {
    const field = FILES_FIELD.exec(text(join(milestones, file)));
    for (const [path] of field?.[1].matchAll(/[\w.@-]+(?:\/[\w.@-]+)+\/?/g) ?? []) {
      named += 1;
      dirs.add(path.endsWith('/') ? norm(path) : norm(path).split('/').slice(0, -1).join('/'));
    }
  }
  if (named > 0) from.push(`${named} milestone path(s)`);
  return { dirs: [...dirs].filter(Boolean), from };
}

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
      warn.push(`${inPlan} archived change spec(s) were read during the plan phase. The planner's contract keeps the archive out of a plan (ADR-026): a past change describes one problem's shape, and what generalised from past runs is in the contracts. Worth reading the plan for what it took from there.`);
    }
  }

  // ---- against the change's scope, per run ----------------------------------
  // Read defensively, like section 2: an unreadable contract leaves the
  // directories that are always in scope at their defaults rather than
  // taking the section down.
  let specsDir = 'specs';
  let proofDir = '';
  try {
    const contract = loadConfig(root);
    specsDir = contract.trace.specs_dir;
    proofDir = contract.trace.proof_dir;
  } catch {
    /* the defaults above; a bad contract is gate.mjs's to report */
  }
  const alwaysIn = [specsDir, proofDir, 'specflow', '.spec-flow', '.claude', 'CLAUDE.md'].filter(Boolean).map(norm);

  for (const run of runs) {
    const runReads = run.trace.filter((e) => e.raw?.includes(' read file=') && e.file);
    if (runReads.length === 0) continue;

    const label = runs.length > 1 ? `${run.name}: ` : '';
    const dir = changeDir(run);
    const scope = dir ? changeScope(dir, specsDir) : null;
    if (!scope || scope.dirs.length === 0) {
      const why = dir ? 'its spec names no scoped capability and its milestones name no path' : 'no change folder under specflow/ names this run';
      say(`  ${label}scope UNKNOWN — ${why}, so nothing here says which reads were outside it.`);
      continue;
    }
    say(`  ${label}scope ${scope.dirs.join(', ')} (from ${scope.from.join(', ')})`);

    const inScope = (rel) => [...alwaysIn, ...scope.dirs].some((d) => rel === d || rel.startsWith(`${d}/`));
    for (const phase of [...new Set(runReads.map((e) => e.phase ?? '?'))]) {
      const inPhase = runReads.filter((e) => (e.phase ?? '?') === phase);
      const outside = new Map();
      let inside = 0;
      for (const e of inPhase) {
        const rel = insideRepo(e.file);
        if (rel !== null && inScope(rel)) {
          inside += 1;
          continue;
        }
        // Grouped two segments deep — the module, in most layouts — so the
        // line names where the reads went rather than listing every file.
        const key = rel === null ? '(outside the repository)' : rel.split('/').slice(0, 2).join('/');
        outside.set(key, (outside.get(key) ?? 0) + 1);
      }
      const ranked = [...outside].sort((a, b) => b[1] - a[1]);
      const where = ranked.length > 0 ? ` — ${ranked.slice(0, 5).map(([d, n]) => `${d} x${n}`).join(', ')}` : '';
      const out = inPhase.length - inside;
      say(`    ${phase}: ${inPhase.length} read(s), ${out} outside the scope${where}`);

      if (phase === 'plan' && out > inside) {
        warn.push(
          `${runs.length > 1 ? `in ${run.name} ` : ''}the planner read more outside the change's scope (${out}) than inside it (${inside})${where}. That is a planner learning how this repo builds a module from its source. A repo that states its anatomy — a skill, or a CLAUDE.md section — is what makes those reads unnecessary, and the planner's contract sends it there first (ADR-026).`,
        );
      }
    }
  }
}
say('');

// ---- 4b. the size of what a run wrote, against the budgets ----------------
//
// `size-on-write` refuses an artefact over `trace.budgets` at the write
// (ADR-032); this is the trend behind that line: a change that hugs its
// budgets on every run is a budget about to be raised, and one far under
// them on every run is prose the prompts could lose. Read defensively, like
// section 4: no contract, no budgets, no verdict.
say('Artefacts');
{
  let budgets = null;
  try {
    budgets = loadConfig(root).trace.budgets ?? null;
  } catch {
    budgets = null;
  }
  const sized = runs
    .map((run) => ({ run, dir: changeDir(run) }))
    .filter(({ dir }) => dir !== null);
  if (sized.length === 0) {
    say('  no change folder to measure — a run archives one under specflow/archive/<slug>/.');
  } else {
    for (const { run, dir } of sized) {
      const parts = [];
      for (const [label, rel, key] of [
        ['spec', 'spec.md', 'spec'],
        ['proposal', 'proposal.md', 'proposal'],
        ['plan', 'plan.md', 'plan'],
      ]) {
        const file = join(dir, rel);
        if (!existsSync(file)) continue;
        parts.push(sizeLine(label, readFileSync(file, 'utf8').replace(/^\*\*Status:\*\*.*$/m, '').length, budgets?.[key]));
      }
      const mDir = join(dir, 'milestones');
      if (existsSync(mDir)) {
        const sizes = readdirSync(mDir)
          .filter((f) => /^M\d+\.md$/.test(f))
          .map((f) => readFileSync(join(mDir, f), 'utf8').length);
        if (sizes.length > 0) parts.push(sizeLine(`largest of ${sizes.length} milestone(s)`, Math.max(...sizes), budgets?.milestone));
      }
      if (parts.length > 0) say(`  ${run.name}: ${parts.join(', ')}`);
    }
  }
}

/** `spec 4,120 chars (69% of 6,000)`, or `over its budget` in place of the percentage. */
function sizeLine(label, size, budget) {
  const n = size.toLocaleString('en-US');
  if (!(budget > 0)) return `${label} ${n} chars`;
  return size > budget
    ? `${label} ${n} chars — OVER its ${budget.toLocaleString('en-US')} budget`
    : `${label} ${n} chars (${Math.round((100 * size) / budget)}% of ${budget.toLocaleString('en-US')})`;
}
say('');

// ---- 5. session reuse, which is where a run's token cost actually goes -----
//
// A milestone is delimited by a gate PASS: the gate allows the stop and the
// orchestrator moves on. Inside one milestone the contract in
// `commands/spec-flow.md` is that the implementer is spawned once and every
// follow-up returns to that session by SendMessage while its cache is warm —
// a cold one is replaced (ADR-025). Both halves are already observable, with
// no new instrumentation:
//
//   - `agent type=...` is written at an agent's FIRST stop only — a session
//     resumed by SendMessage stops again under the same id and is not
//     written twice — so every such line is a FRESH session.
//   - a fresh session re-reads what the previous one already had, so the same
//     path read twice inside one milestone is what the cold start cost.
//
// Two proxies, and the output says so: the trace carries no milestone id, so
// the segmentation is inferred from the gate, and a milestone that never
// passed runs to the end of the log.

/** Trace events split into milestones, each ending at a gate PASS. */
function milestones(run) {
  const passes = run.gate.filter((g) => g.result === 'pass' && g.at).map((g) => g.at);
  const events = run.trace.filter((e) => e.at).sort((a, b) => a.at - b.at);
  const segments = [];
  let start = null;
  for (const end of [...passes, null]) {
    const inSegment = events.filter((e) => (start === null || e.at > start) && (end === null || e.at <= end));
    if (inSegment.length > 0) segments.push({ closed: end !== null, events: inSegment });
    start = end;
  }
  return segments;
}

const segments = runs.flatMap((r) => milestones(r).map((s, i) => ({ ...s, run: r.name, index: i + 1 })));

say('Session reuse');
if (segments.length === 0) {
  say('  no run trace yet — run-trace.mjs writes it during a live run.');
} else {
  const rereadTally = new Map();
  const coldTally = new Map();

  for (const segment of segments) {
    const spawns = segment.events.filter((e) => e.type && e.status);
    const implementers = spawns.filter((e) => e.type === 'implementer').length;

    // Per file: how often it was read, and by how many DISTINCT sessions.
    // The second number is the one a caching decision turns on — a repeat
    // inside one session is context the model already had and re-read, and a
    // repeat across two is a fresh context paying for what the previous one
    // already knew. Only the second is a cost any cache could remove.
    const seen = new Map();
    for (const e of segment.events) {
      if (!e.raw?.includes(' read file=') || !e.file) continue;
      const entry = seen.get(e.file) ?? { n: 0, sessions: new Set() };
      entry.n += 1;
      if (e.session) entry.sessions.add(e.session);
      seen.set(e.file, entry);
    }
    const repeated = [...seen].filter(([, v]) => v.n > 1);
    const extra = repeated.reduce((sum, [, v]) => sum + v.n - 1, 0);
    const cold = repeated.filter(([, v]) => v.sessions.size > 1);
    for (const [file, v] of repeated) rereadTally.set(file, (rereadTally.get(file) ?? 0) + v.n - 1);
    for (const [file] of cold) coldTally.set(file, (coldTally.get(file) ?? 0) + 1);

    const where = runs.length > 1 ? `[${segment.run}] ` : '';
    const open = segment.closed ? '' : ' (never reached a PASS)';
    const across = cold.length > 0 ? `, ${cold.length} across sessions` : '';
    const reads = repeated.length === 0 ? 'no file read twice' : `${repeated.length} file(s) re-read, ${extra} extra read(s)${across}`;
    say(`  ${where}milestone ${segment.index}${open}: ${implementers} implementer session(s), ${reads}`);

    if (implementers > 1) {
      warn.push(
        `milestone ${segment.index}${runs.length > 1 ? ` of ${segment.run}` : ''} spawned the implementer ${implementers} times. The flow returns to one implementer per milestone while its cache is warm; a new one is right only after the previous went cold — a human's answer, a long gate (ADR-025). Any other re-spawn re-read the plan and every touched file into a cold context, which is most of what a run costs.`,
      );
    }
  }

  const ranked = [...rereadTally].sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (ranked.length > 0) {
    say(`  most re-read: ${ranked.map(([f, n]) => `${baseOf(f)} +${n}`).join(', ')}`);
  }

  const coldRanked = [...coldTally].sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (coldRanked.length > 0) {
    say(`  re-read across sessions: ${coldRanked.map(([f, n]) => `${baseOf(f)} x${n}`).join(', ')}`);
    warn.push(
      `${coldTally.size} file(s) were read by more than one session inside a single milestone. That is the only re-read a cache could remove — a repeat within one session is context the model already had.`,
    );
  }

  // Whether the split above measured anything, said out loud. "0 across
  // sessions" over a trace carrying no session id is right and answers
  // nothing, which is this engine's own failure mode wearing a number.
  //
  // The one-id case is not a formatting nicety. `hooks/lib/io.mjs` records
  // that whether a subagent's payload carries its own session id or its
  // parent's is undocumented and free to change; a trace with several spawns
  // and a single id is what the second of those looks like from here, and it
  // means no split can ever see a fresh session. Nothing downstream should be
  // built on this attribution until a real run has answered it.
  const attributed = reads.filter((r) => r.session);
  const ids = new Set(attributed.map((r) => r.session));
  const spawned = trace.filter((e) => e.type && e.status).length;

  if (reads.length === 0) {
    /* section 4 already said there are no reads */
  } else if (attributed.length === 0) {
    say('  attribution: UNAVAILABLE — no read carries a session id, so "across sessions" above measured nothing.');
    say('  Either this trace predates the field or the payloads name no session.');
  } else if (ids.size === 1 && spawned > 1) {
    say(`  attribution: ONE session id across ${spawned} subagent spawn(s) — reads are landing under the spawner.`);
    warn.push(
      `every read in this trace carries the same session id while ${spawned} subagent(s) were spawned. A subagent's reads are being attributed to whoever spawned it, so the across-session split cannot see a fresh session's cold start — treat those numbers as unmeasured, not as zero.`,
    );
  } else {
    say(`  attribution: ${attributed.length}/${reads.length} read(s) carry a session id, across ${ids.size} session(s).`);
  }

  say('  Both numbers are proxies: the trace carries no milestone id, so a milestone here is');
  say('  whatever happened between two gate PASSes.');
}
say('');

// ---- 6. what the run cost, in the unit the budget does not charge ----------
//
// `opus-budget.mjs` charges the intent to spawn, so one consult over a large
// context and six over a small one are charged 1 and 6 — in the opposite
// order to what they cost. These lines are the other unit. Nothing here
// proposes a different budget: the change policy accepts a run, and this is
// how the run gets recorded.
//
// Summed by model rather than by agent, because that is the join the hook can
// make without guessing — see hooks/token-trace.mjs. The tiers ARE the models
// (ADR-013), so a per-model total already answers what the budget asks.
const tokenLines = trace.filter((e) => e.model && e.msgs !== undefined);

say('Tokens');
if (tokenLines.length === 0) {
  say('  no token accounting recorded yet — token-trace.mjs writes it at each stop, from');
  say('  the transcript Claude Code already keeps. A trace older than that hook has none.');
} else {
  const rows = summarizeTokens(tokenLines);
  const width = Math.max(...rows.map((r) => r.model.length));
  for (const r of rows) say(`  ${tokenRow(r, width)}`);

  const total = (field, filter = () => true) => rows.filter(filter).reduce((sum, r) => sum + r[field], 0);
  say(`  total: in ${human(total('in'))}, out ${human(total('out'))}, cache_read ${human(total('cache_read'))}, cache_write ${human(total('cache_write'))}`);
  say('  out and think are floors: some messages never get their final count written.');

  // The number the budget cannot see. A spawn is charged once whatever it
  // costs, so cost-per-spawn is the only thing that can say whether a cap in
  // calls is calibrated — and it is a DIVISION ACROSS TWO SOURCES, the token
  // lines and the agent returns, so it is reported as a ratio and never as a
  // per-agent figure the trace cannot support.
  const subagentOut = total('out', (r) => r.chain === 'subagent');
  const spawns = trace.filter((e) => e.type && e.status).length;
  if (subagentOut > 0 && spawns > 0) {
    say(`  subagent output: ${human(subagentOut)} across ${spawns} recorded spawn(s) — ~${human(Math.round(subagentOut / spawns))}/spawn.`);
    say('  That average is the unit max_opus_calls does not charge; it says nothing about which agent.');
  } else if (subagentOut === 0 && spawns > 0) {
    say(`  ${spawns} spawn(s) recorded and no subagent tokens with them.`);
    warn.push(
      `${spawns} subagent spawn(s) are in this trace and no token line is marked sidechain. Either the spawns predate token-trace.mjs reading subagent transcripts, or this build keeps them somewhere other than <session>/subagents/ — treat the per-spawn cost as unmeasured, not as zero.`,
    );
  }
}
say('');

// ---- parsing gaps this telemetry knows about -------------------------------
for (const [file, what] of [
  ['run-trace-unmatched.log', 'subagent returns with no STATUS line'],
  ['opus-budget-unmatched.log', 'SendMessage payloads the budget could not attribute'],
  ['register-agent-unmatched.log', 'Opus spawns whose session id was not found'],
  ['token-trace-unmatched.log', 'stops whose token usage could not be read — a cost of zero here is not a cheap run'],
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
