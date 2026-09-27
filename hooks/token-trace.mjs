#!/usr/bin/env node
/**
 * Stop hook — what a turn actually cost, in tokens, read from the transcripts
 * Claude Code was already writing.
 *
 * This hook enforces NOTHING. It exists because the one budget in this engine
 * charges the wrong unit: `opus-budget.mjs` counts the INTENT to spawn, so an
 * architect consulted once over 200k of context and one consulted six times
 * over 5k are charged 1 and 6, in the opposite order to what they cost.
 * Nothing here proposes a different budget — it makes the question answerable,
 * which this engine's change policy requires before a rule may move.
 *
 * ALWAYS exits 0 and renders no decision. A Stop hook that blocks decides the
 * turn; an observer that can do that is a gate nobody declared.
 *
 * **An unreadable transcript records NOTHING, never a zero.** The fields here
 * are sums, and a sum is the one shape where "not known" and "none" are
 * indistinguishable after the fact — the same refusal `cc=?` makes in
 * gate.mjs, where an absent value must read as "not known here" (ADR-004).
 *
 * **The transcript LAGS the conversation** — it is written asynchronously, so
 * the turn that triggered this Stop may not be in the file yet. That costs
 * nothing here and is the reason the read is cumulative rather than "the last
 * turn": whatever has not landed is counted at the next stop, under a later
 * timestamp. A reader built around the current turn would undercount every
 * turn instead, silently.
 *
 * **A subagent's messages are not in the session transcript.** Each subagent
 * gets its own file, `<session>/subagents/agent-<id>.jsonl`, beside the
 * session's `<session>.jsonl`; a reader of the one file sees no subagent at
 * all. Every stop reads them all, each from its own offset.
 *
 * **A message is counted once, not once per line.** One line is written per
 * content block, each repeating the message's usage: the input side is the
 * same on every line of a message and the output side only grows, so input is
 * counted at a message's first line and output at the largest value any of its
 * lines carries. `out` and `think` are floors all the same — some messages
 * never get their final count written, and keep the one they started with.
 *
 * **Attribution is by model and sidechain, not by agent role.** A sidechain
 * message names no agent, and deriving one from which spawn was in flight
 * would be a guess written down as a fact. The roles map onto tiers
 * (ADR-013), so `model=` already answers what the budget asks; joining a
 * sidechain to a role is a correlation, and correlation belongs in the
 * report, where it can say it is unsure. `specflow-stats.mjs` reads these.
 */
import { openSync, readSync, fstatSync, closeSync, appendFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import { projectDir, stateDir, readPhase, readPayload, writeFile, run } from './lib/io.mjs';

/**
 * Every counter this hook reports, and where each lives in a usage record.
 *
 * Reported in this order, which insertion order on a string-keyed object
 * makes deterministic — a log read back by field name would not care, but a
 * human diffing two runs would.
 */
const COUNTERS = {
  in: (u) => u.input_tokens,
  out: (u) => u.output_tokens,
  cache_read: (u) => u.cache_read_input_tokens,
  cache_write: (u) => u.cache_creation_input_tokens,
  think: (u) => u.output_tokens_details?.thinking_tokens,
};

/** The counters that grow across a message's lines; the rest are fixed at its first. */
const GROWING = ['out', 'think'];

const num = (v) => (Number.isFinite(v) ? v : 0);

/** The session's transcript, then each of its subagents' — see the header. */
function transcripts(sessionPath) {
  const dir = join(sessionPath.replace(/\.jsonl$/, ''), 'subagents');
  let subagents = [];
  try {
    subagents = readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .map((f) => join(dir, f));
  } catch {
    /* none yet: the directory appears with the first subagent */
  }
  return [sessionPath, ...subagents];
}

/**
 * The offsets saved at the last stop, by transcript path — or `null` when the
 * file exists and cannot be read, which unreadBytes() treats differently from
 * having none.
 */
function readOffsets(offsetFile) {
  if (!existsSync(offsetFile)) return {};
  try {
    const saved = JSON.parse(readFileSync(offsetFile, 'utf8'));
    if (saved?.files && typeof saved.files === 'object') return saved.files;
    // `{path, bytes}` is ONE transcript's offset — the shape still on disk
    // wherever a revision that read only the session transcript last ran.
    if (typeof saved?.path === 'string') return { [saved.path]: { bytes: saved.bytes } };
  } catch {
    /* unreadable — below */
  }
  return null;
}

/**
 * The bytes appended to `path` since its saved offset, the offset to remember
 * next time, and whether the read carried on from that offset.
 *
 * Reads from an offset rather than the whole file: Stop fires at every turn
 * end and a transcript only grows, so a full read is work that scales with
 * the session on a hook that runs once a turn.
 *
 * Stops at the LAST NEWLINE. The file is being appended to by another
 * process, so the tail can be half a line — and a half line is not merely
 * unparseable, it would be skipped permanently once the offset moved past it.
 *
 * A file SHORTER than the offset is a different transcript at the same path
 * (a new session, a compaction), which must be read from the start rather
 * than from an offset that now points into the middle of a line.
 */
function unreadBytes(path, saved, offsetsUnreadable) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;

    // An offset that EXISTS and cannot be read is not the same as no offset at
    // all, and the difference decides a number. With none, this transcript
    // has never been counted and reading from 0 is the only correct answer;
    // with a corrupt one, some prefix is already on a line in run-trace.log
    // and re-reading from 0 appends those bytes a second time. So the corrupt
    // case skips its slice and resynchronises, losing a count rather than
    // inventing one — the rule this file's header states.
    if (offsetsUnreadable || (saved !== undefined && !Number.isInteger(saved?.bytes))) {
      return { text: '', next: size, continued: false, resynced: true };
    }
    // A path with no saved offset and an offset past the end are both NEW
    // CONTENT this log has never seen, which is why both read from 0.
    const continued = saved !== undefined && saved.bytes <= size;
    const from = continued ? saved.bytes : 0;

    if (from === size) return { text: '', next: from, continued };

    const buf = Buffer.allocUnsafe(size - from);
    const read = readSync(fd, buf, 0, buf.length, from);
    const text = buf.toString('utf8', 0, read);

    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline === -1) return { text: '', next: from, continued };

    return { text: text.slice(0, lastNewline), next: from + Buffer.byteLength(text.slice(0, lastNewline + 1), 'utf8'), continued };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * A payload or a file this hook could not read, recorded by SHAPE — key names
 * only, never content.
 *
 * Every other observer here keeps one (`run-trace-unmatched.log`,
 * `register-agent-unmatched.log`, `opus-budget-unmatched.log`) and
 * `specflow-stats.mjs` reports the counts, for a reason that applies most
 * sharply to this hook: it reads a file another program writes, so the way it
 * dies is a field moving — after which it records nothing, forever, and a
 * cost section that says zero looks exactly like a cheap run.
 */
function noteMiss(state, what) {
  try {
    const path = join(state, 'token-trace-unmatched.log');
    const line = JSON.stringify(what);
    const existing = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : [];
    if (!existing.includes(line)) appendFileSync(path, `${line}\n`);
  } catch {
    /* logging must never be why this hook fails */
  }
}

/**
 * Usage summed per `model|sidechain` into `groups`, over the transcript lines
 * in `text`. Returns the message the slice ended inside, as `{id, out, think}`,
 * for the next slice of the same file to carry on from.
 *
 * `carry` is that value from the previous slice: a message whose lines
 * straddle two stops has its input counted already.
 */
function tally(text, groups, carry) {
  let last = carry;

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;

    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a line this build writes in a shape we do not read
    }

    const message = entry?.message;
    const usage = message?.usage;
    // `model` is required, not defaulted: a usage record whose model cannot be
    // named cannot be charged to a tier, and a total that silently absorbs it
    // reports a number no one can act on.
    if (!usage || typeof message.model !== 'string') continue;

    const key = `${message.model}|${entry.isSidechain === true}`;
    const group = groups.get(key) ?? { model: message.model, sidechain: entry.isSidechain === true, msgs: 0, ...Object.fromEntries(Object.keys(COUNTERS).map((name) => [name, 0])) };
    groups.set(key, group);

    // A message's lines are consecutive among the lines that carry usage, so
    // the previous one is the only message a line can continue. A line with
    // no id is its own message.
    const id = typeof message.id === 'string' ? message.id : null;
    if (id !== null && last?.id === id) {
      for (const name of GROWING) {
        const value = num(COUNTERS[name](usage));
        if (value > last[name]) {
          group[name] += value - last[name];
          last[name] = value;
        }
      }
      continue;
    }

    group.msgs += 1;
    for (const [name, pick] of Object.entries(COUNTERS)) group[name] += num(pick(usage));
    last = id === null ? null : { id, ...Object.fromEntries(GROWING.map((name) => [name, num(COUNTERS[name](usage))])) };
  }

  return last;
}

await run(async () => {
  const root = projectDir();

  // Phase first, through a path that creates nothing — and the SAME phases
  // run-trace.mjs traces, because both write to run-trace.log: a reader must
  // not have to know that two hooks disagree about which turns are recorded.
  // `readPhase` adds the repo that merely committed a phase file (ADR-017).
  const phase = readPhase(root);
  if (['', 'idle', 'done'].includes(phase)) return;

  const payload = await readPayload();
  const path = [payload.transcript_path, payload.transcriptPath].find((v) => typeof v === 'string' && v);

  const state = stateDir(root);
  const offsetFile = join(state, 'token-offset');

  // No transcript on this build's payload: nothing is known, so nothing is
  // written — but the SHAPE is, because this is how the hook stops working
  // without stopping running.
  if (!path) {
    noteMiss(state, { no_transcript_path: Object.keys(payload).sort() });
    return;
  }

  const saved = readOffsets(offsetFile);
  if (saved === null) noteMiss(state, { offset_unreadable: 'resynchronised, one slice not counted' });

  const groups = new Map();
  const offsets = {};
  for (const file of transcripts(path)) {
    const before = saved?.[file];
    let slice;
    try {
      slice = unreadBytes(file, before, saved === null);
    } catch (err) {
      // The session's own transcript is the stop's subject: without it,
      // nothing this stop could say is known — see the header.
      if (file === path) {
        noteMiss(state, { transcript_unreadable: err?.code ?? 'unknown' });
        return;
      }
      noteMiss(state, { subagent_transcript_unreadable: err?.code ?? 'unknown' });
      if (before !== undefined) offsets[file] = before; // keep its place for the next stop
      continue;
    }

    if (slice.resynced && saved !== null) noteMiss(state, { offset_unreadable: 'resynchronised, one slice not counted' });

    const carry =
      slice.continued && typeof before?.id === 'string'
        ? { id: before.id, ...Object.fromEntries(GROWING.map((name) => [name, num(before[name])])) }
        : null;
    const last = tally(slice.text, groups, carry);
    offsets[file] = { ...(last ?? {}), bytes: slice.next };
  }

  // The offsets advance even when a slice held no usage record. What was
  // read has been read; leaving it behind would re-scan the same bytes at
  // every stop for the rest of the session. Only this session's transcripts
  // are kept: another session's offset would never be read again.
  writeFile(offsetFile, `${JSON.stringify({ files: offsets })}\n`);

  // A group opened only by the tail of a message counted at an earlier stop,
  // whose output did not grow, has nothing to report.
  const lines = [...groups.values()].filter((g) => g.msgs > 0 || Object.keys(COUNTERS).some((name) => g[name] > 0));
  if (lines.length === 0) return;

  const id = [payload.session_id, payload.sessionId].find((v) => typeof v === 'string' && /^[\w-]+$/.test(v));
  const stamp = `${new Date().toISOString()} phase=${phase}${id ? ` session=${id}` : ''}`;

  // One line per group rather than one line with every model on it: this log
  // is read back by a whitespace split into `k=v` pairs, which has no way to
  // express a repeated key.
  for (const g of lines) {
    const counts = Object.keys(COUNTERS).map((name) => `${name}=${g[name]}`).join(' ');
    appendFileSync(join(state, 'run-trace.log'), `${stamp} tokens model=${g.model} sidechain=${g.sidechain} ${counts} msgs=${g.msgs}\n`);
  }
});
