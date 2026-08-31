#!/usr/bin/env node
/**
 * Stop hook — what a turn actually cost, in tokens, read from the transcript
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
 * **Attribution is by model and sidechain, not by agent role.** A sidechain
 * message names no agent, and deriving one from which spawn was in flight
 * would be a guess written down as a fact. The roles map onto tiers
 * (ADR-013), so `model=` already answers what the budget asks; joining a
 * sidechain to a role is a correlation, and correlation belongs in the
 * report, where it can say it is unsure. `specflow-stats.mjs` reads these.
 */
import { openSync, readSync, fstatSync, closeSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
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

const num = (v) => (Number.isFinite(v) ? v : 0);

/**
 * The bytes appended to `path` since the offset in `state`, and the offset to
 * remember next time.
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
function unreadBytes(path, offsetFile) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;

    // An offset that EXISTS and cannot be read is not the same as no offset at
    // all, and the difference decides a number. With no file, this transcript
    // has never been counted and reading from 0 is the only correct answer;
    // with a corrupt one, some prefix is already on a line in run-trace.log
    // and re-reading from 0 appends those bytes a second time. So the corrupt
    // case skips its slice and resynchronises, losing a count rather than
    // inventing one — the rule this file's header states.
    let from = 0;
    if (existsSync(offsetFile)) {
      try {
        const saved = JSON.parse(readFileSync(offsetFile, 'utf8'));
        // Reading from 0 is right in both of the first two cases and wrong in
        // the third, which is the distinction worth keeping straight: a
        // different path and an offset past the end are both NEW CONTENT this
        // log has never seen, while an offset that will not parse means some
        // prefix is already counted and cannot be identified.
        if (saved.path !== path) from = 0;
        else if (!Number.isInteger(saved.bytes)) return { text: '', next: size, resynced: true };
        else if (saved.bytes > size) from = 0;
        else from = saved.bytes;
      } catch {
        return { text: '', next: size, resynced: true };
      }
    }

    if (from === size) return { text: '', next: from };

    const buf = Buffer.allocUnsafe(size - from);
    const read = readSync(fd, buf, 0, buf.length, from);
    const text = buf.toString('utf8', 0, read);

    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline === -1) return { text: '', next: from };

    return { text: text.slice(0, lastNewline), next: from + Buffer.byteLength(text.slice(0, lastNewline + 1), 'utf8') };
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

/** Usage summed per `model|sidechain`, over the transcript lines in `text`. */
function tally(text) {
  const groups = new Map();

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

    group.msgs += 1;
    for (const [name, pick] of Object.entries(COUNTERS)) group[name] += num(pick(usage));
    groups.set(key, group);
  }

  return [...groups.values()];
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

  let slice;
  try {
    slice = unreadBytes(path, offsetFile);
  } catch (err) {
    noteMiss(state, { transcript_unreadable: err?.code ?? 'unknown' });
    return; // see the header — a missing count is never a zero
  }

  if (slice.resynced) noteMiss(state, { offset_unreadable: 'resynchronised, one slice not counted' });

  const groups = tally(slice.text);

  // The offset advances even when the slice held no usage record. What was
  // read has been read; leaving it behind would re-scan the same bytes at
  // every stop for the rest of the session.
  writeFile(offsetFile, `${JSON.stringify({ path, bytes: slice.next })}\n`);

  if (groups.length === 0) return;

  const id = [payload.session_id, payload.sessionId].find((v) => typeof v === 'string' && /^[\w-]+$/.test(v));
  const stamp = `${new Date().toISOString()} phase=${phase}${id ? ` session=${id}` : ''}`;

  // One line per group rather than one line with every model on it: this log
  // is read back by a whitespace split into `k=v` pairs, which has no way to
  // express a repeated key.
  for (const g of groups) {
    const counts = Object.keys(COUNTERS).map((name) => `${name}=${g[name]}`).join(' ');
    appendFileSync(join(state, 'run-trace.log'), `${stamp} tokens model=${g.model} sidechain=${g.sidechain} ${counts} msgs=${g.msgs}\n`);
  }
});
