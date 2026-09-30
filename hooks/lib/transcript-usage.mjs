/**
 * Reading Claude Code's transcripts for what they cost — in ONE copy.
 *
 * `token-trace.mjs` records usage at every stop of a run, and `watch.mjs`
 * shows the same usage live from a second terminal; two readers of one file
 * that disagreed would leave nothing to say which is right. Everything here
 * is an OBSERVATION about a file another program writes — the shapes
 * `token-fixture.mjs` pins — and the whole risk sits there.
 */
import { openSync, readSync, fstatSync, closeSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { basename, dirname, join } from 'node:path';

/**
 * Every counter this hook reports, and where each lives in a usage record.
 *
 * Reported in this order, which insertion order on a string-keyed object
 * makes deterministic — a log read back by field name would not care, but a
 * human diffing two runs would.
 */
export const COUNTERS = {
  in: (u) => u.input_tokens,
  out: (u) => u.output_tokens,
  cache_read: (u) => u.cache_read_input_tokens,
  cache_write: (u) => u.cache_creation_input_tokens,
  think: (u) => u.output_tokens_details?.thinking_tokens,
};

/** The counters that grow across a message's lines; the rest are fixed at its first. */
export const GROWING = ['out', 'think'];

export const num = (v) => (Number.isFinite(v) ? v : 0);

/** The session's transcript, then each of its subagents' — see the header. */
export function transcripts(sessionPath) {
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
export function readOffsets(offsetFile) {
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
export function unreadBytes(path, saved, offsetsUnreadable) {
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
 * The session transcript a subagent's transcript belongs to — the inverse
 * of `transcripts()`: `<session>/subagents/agent-<id>.jsonl` sits beside
 * `<session>.jsonl`. A `SubagentStop` payload names only the agent's file.
 */
export function sessionOf(agentTranscriptPath) {
  return `${dirname(dirname(agentTranscriptPath))}.jsonl`;
}

/** The agent id a subagent transcript is named after, or '' for the session's own. */
export function agentOf(transcriptPath) {
  return /^agent-([\w-]+)\.jsonl$/.exec(basename(transcriptPath))?.[1] ?? '';
}

/**
 * Usage summed per `model|sidechain|agent` into `groups`, over the transcript
 * lines in `text`. `agent` is the transcript's own label (`agentOf`): a
 * subagent writes its own file, so charging its usage to that file's id is a
 * fact about the file, not a guess about which spawn was in flight. Returns the message the slice ended inside, as `{id, out, think}`,
 * for the next slice of the same file to carry on from.
 *
 * `carry` is that value from the previous slice: a message whose lines
 * straddle two stops has its input counted already.
 */
export function tally(text, groups, carry, agent = '') {
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

    const key = `${message.model}|${entry.isSidechain === true}|${agent}`;
    const group = groups.get(key) ?? { model: message.model, sidechain: entry.isSidechain === true, agent, msgs: 0, ...Object.fromEntries(Object.keys(COUNTERS).map((name) => [name, 0])) };
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

