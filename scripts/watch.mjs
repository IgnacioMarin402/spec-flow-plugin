#!/usr/bin/env node
/**
 * A run, live, from a second terminal — redrawn every second off the files
 * the run already writes (ADR-034).
 *
 *   node scripts/watch.mjs                       # or: spec-flow watch
 *   node scripts/watch.mjs --once                # one frame, no loop
 *   node scripts/watch.mjs --interval 2000 --lines 12
 *
 * Reads `.claude/state/` — the phase, the position, the gate's history, the
 * trace — and the transcripts `token-trace.mjs` has already named in
 * `token-offset`: each subagent's file beside the session's, with its type in
 * `.meta.json`. Who is running, since when, and what it has cost so far are
 * read off those files through the same reader `token-trace` uses, so the
 * live numbers and the ones recorded at the next stop are one computation.
 *
 * NEVER FAILS, gates nothing, creates nothing — the standing of `status.mjs`.
 * A frame that cannot be drawn prints why and the next one tries again.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setInterval } from 'node:timers';
import { parseFields, roleOf, summarizeTokens, tokenRow, human, TOKEN_FIELDS } from './trace-lines.mjs';
import { transcripts, unreadBytes, tally, agentOf } from '../hooks/lib/transcript-usage.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] !== undefined ? Number(argv[i + 1]) || fallback : fallback;
};
const ONCE = argv.includes('--once');
const INTERVAL = Math.max(250, flag('--interval', 1000));
const LINES = Math.max(1, flag('--lines', 8));

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const STATE = join(root, '.claude', 'state');

const read = (file) => (existsSync(join(STATE, file)) ? readFileSync(join(STATE, file), 'utf8').trim() : '');
const lines = (file) => read(file).split('\n').map((l) => l.trim()).filter(Boolean);
const clock = (ms) => (ms ? new Date(ms).toTimeString().slice(0, 8) : '?');
const span = (fromMs, toMs) => {
  const s = Math.max(0, Math.round((toMs - fromMs) / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
};

// ---- live usage, kept across frames --------------------------------------
//
// The same offsets `token-trace` keeps on disk, here in memory: a frame reads
// only what a transcript gained since the last one, so watching costs the
// same whether the session is a minute old or an afternoon old.
const offsets = {};
const groups = new Map();
const firstSeen = new Map(); // agent id -> when this watcher first saw its file

/** The session transcript `token-trace` last recorded, or null before the run's first stop. */
function sessionTranscript() {
  try {
    const saved = JSON.parse(read('token-offset'));
    const files = Object.keys(saved?.files ?? {});
    return files.find((f) => agentOf(f) === '' && f.endsWith('.jsonl')) ?? null;
  } catch {
    return null;
  }
}

function refreshUsage(sessionPath) {
  for (const file of transcripts(sessionPath)) {
    const before = offsets[file];
    let slice;
    try {
      slice = unreadBytes(file, before, false);
    } catch {
      continue; // gone, or mid-rotation: the next frame looks again
    }
    const carry = slice.continued && typeof before?.id === 'string' ? { id: before.id, out: before.out ?? 0, think: before.think ?? 0 } : null;
    const last = tally(slice.text, groups, carry, agentOf(file));
    offsets[file] = { ...(last ?? {}), bytes: slice.next };
  }
}

/** Usage summed over models for one agent id ('' for the session itself). */
function usageOf(agent) {
  /** @type {Record<string, number>} */
  const counts = Object.fromEntries(TOKEN_FIELDS.map((f) => [f, 0]));
  let msgs = 0;
  const models = new Set();
  for (const g of groups.values()) {
    if (g.agent !== agent) continue;
    msgs += g.msgs;
    models.add(g.model);
    for (const f of TOKEN_FIELDS) counts[f] += g[f] ?? 0;
  }
  return { msgs, models, counts };
}

/**
 * Every subagent of the session, from its transcript: the type from its
 * `.meta.json` (all five roles, not only the three the registry records),
 * when its file appeared, when it last wrote, and the status `run-trace`
 * recorded at its stop — absent while it is still running.
 */
function agentsOf(sessionPath, trace) {
  const dir = join(sessionPath.replace(/\.jsonl$/, ''), 'subagents');
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => agentOf(f) !== '');
  } catch {
    return [];
  }
  const closed = new Map(trace.filter((e) => e.type && e.status && e.agent_id).map((e) => [e.agent_id, e.status]));
  const now = Date.now();
  return files
    .map((f) => {
      const id = agentOf(f);
      const path = join(dir, f);
      let type = '';
      try {
        type = String(JSON.parse(readFileSync(path.replace(/\.jsonl$/, '.meta.json'), 'utf8')).agentType ?? '');
      } catch {
        /* no meta: the id is the name */
      }
      let st = null;
      try {
        st = statSync(path);
      } catch {
        /* removed between readdir and stat */
      }
      if (!firstSeen.has(id)) firstSeen.set(id, st?.birthtimeMs || st?.ctimeMs || now);
      return {
        id,
        role: type ? roleOf(type) : `agent-${id}`,
        started: firstSeen.get(id) ?? now,
        last: st?.mtimeMs ?? null,
        status: closed.get(id) ?? null,
        usage: usageOf(id),
      };
    })
    .sort((a, b) => a.started - b.started);
}

// ---- one frame -------------------------------------------------------------
function frame() {
  const out = [];
  const say = (s = '') => out.push(s);
  const now = Date.now();
  say(`spec-flow watch — ${root}   ${clock(now)}${ONCE ? '' : `   (every ${INTERVAL / 1000}s; Ctrl-C to stop)`}`);
  say('');

  const phase = read('phase');
  const trace = lines('run-trace.log').map(parseFields);
  const gate = lines('gate-history.log').map(parseFields);

  say('Run');
  if (!phase || ['idle', 'done'].includes(phase)) {
    say(`  phase ${phase || '(none)'} — no run is armed here.`);
  } else {
    const owner = read('phase.session');
    const [slug, milestone, impl] = read('current-milestone').split(/\s+/);
    say(`  phase ${phase}${owner ? ` (session ${owner})` : ''}   ${milestone ? `${milestone} of ${slug}${impl ? ` (implementer ${impl})` : ''}` : 'no implementer spawned yet'}`);
    say(`  gate failures in a row ${read('gate_attempts') || '0'}   planner+architect calls ${read('opus_calls') || '0'}`);
  }
  say('');

  const session = sessionTranscript();
  if (session && existsSync(session)) refreshUsage(session);
  const agents = session ? agentsOf(session, trace) : [];

  say('Agents');
  if (!session) {
    say('  transcripts not located yet — token-trace names them at the first stop of a run.');
  } else if (agents.length === 0) {
    say('  none spawned yet.');
  } else {
    const width = Math.max(...agents.map((a) => a.role.length));
    for (const a of agents) {
      const when = a.status ? `${clock(a.started)} → ${clock(a.last)} (${span(a.started, a.last ?? now)})` : `since ${clock(a.started)} (${span(a.started, now)})`;
      const { msgs, models, counts: c } = a.usage;
      const cost = msgs > 0 ? `in ${human(c.in)}  out ${human(c.out)}  cache_read ${human(c.cache_read)}  think ${human(c.think)}  (${msgs} msg${models.size > 1 ? `, ${models.size} models` : ''})` : 'no usage written yet';
      say(`  ${a.role.padEnd(width)}  ${(a.status ?? 'RUNNING').padEnd(18)}  ${when.padEnd(28)}  ${cost}`);
    }
  }
  say('');

  say('Gate');
  if (gate.length === 0) {
    say('  no gate history yet.');
  } else {
    const last = gate[gate.length - 1];
    const tally = gate.reduce((acc, g) => ({ ...acc, [g.result ?? '?']: (acc[g.result ?? '?'] ?? 0) + 1 }), {});
    say(`  last ${last.result ?? '?'} ${last.raw.split(' ')[1] ?? ''} (lint ${last.lint ?? '?'}, test ${last.test ?? '?'}) at ${last.at ? clock(last.at.getTime()) : '?'}   history: ${Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(', ')}`);
    if (last.result === 'running') say('  a gate is judging now — or was killed mid-judgement; the next one says which.');
  }
  say('');

  say(`Trace (last ${LINES})`);
  const events = trace.filter((e) => e.msgs === undefined); // token lines are the Cost section
  if (events.length === 0) {
    say('  nothing traced yet — run-trace writes a line per read, write, scoped test and agent stop.');
  } else {
    for (const e of events.slice(-LINES)) {
      say(`  ${e.at ? clock(e.at.getTime()) : '??:??:??'}  ${e.raw.replace(/^\S+\s+(phase=\S+\s+)?(session=\S+\s+)?/, '')}`);
    }
  }
  say('');

  say('Cost');
  const rows = session
    ? summarizeTokens([...groups.values()].map((g) => ({ ...g, sidechain: String(g.sidechain) })))
    : summarizeTokens(trace);
  if (rows.length === 0) {
    say('  no usage yet.');
  } else {
    const width = Math.max(...rows.map((r) => r.model.length));
    for (const r of rows) say(`  ${tokenRow(r, width)}`);
    say(session ? '  live, read off the transcripts; token-trace records the same at each stop.' : '  as recorded at the last stop; live once the transcripts are located.');
  }
  return `${out.join('\n')}\n`;
}

function draw() {
  let text;
  try {
    text = frame();
  } catch (err) {
    text = `spec-flow watch — could not draw this frame: ${err?.message ?? err}\n`;
  }
  process.stdout.write(`${!ONCE && process.stdout.isTTY ? '\x1b[2J\x1b[H' : ''}${text}`);
}

draw();
if (!ONCE) {
  setInterval(draw, INTERVAL);
  process.on('SIGINT', () => process.exit(0));
}
