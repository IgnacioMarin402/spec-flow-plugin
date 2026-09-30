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
 * **Attribution is by model, sidechain and transcript file, not by role.** A
 * sidechain message names no agent, and deriving one from which spawn was in
 * flight would be a guess written down as a fact. What is a fact is the FILE:
 * each subagent writes `agent-<id>.jsonl` of its own, so a sidechain line
 * carries `agent=<id>` and a reader joins it to a role through the registry
 * or the file's `.meta.json`, where it can say it is unsure. The roles map
 * onto tiers (ADR-013), so `model=` still answers what the budget asks.
 * `specflow-stats.mjs`, `status.mjs` and `watch.mjs` read these.
 *
 * Runs at `Stop` and at `SubagentStop` (ADR-034): the second is what puts an
 * agent's cost on record when the agent finishes, not one orchestrator turn
 * later. A `SubagentStop` payload names the agent's transcript, not the
 * session's; the session's is derived from it — they sit side by side.
 */
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { projectDir, stateDir, readPhase, readPayload, writeFile, run } from './lib/io.mjs';
import { COUNTERS, GROWING, num, transcripts, readOffsets, unreadBytes, sessionOf, agentOf, tally } from './lib/transcript-usage.mjs';

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

await run(async () => {
  const root = projectDir();

  // Phase first, through a path that creates nothing — and the SAME phases
  // run-trace.mjs traces, because both write to run-trace.log: a reader must
  // not have to know that two hooks disagree about which turns are recorded.
  // `readPhase` adds the repo that merely committed a phase file (ADR-017).
  const phase = readPhase(root);
  if (['', 'idle', 'done'].includes(phase)) return;

  const payload = await readPayload();
  const agentPath = [payload.agent_transcript_path].find((v) => typeof v === 'string' && v);
  const path = [payload.transcript_path, payload.transcriptPath].find((v) => typeof v === 'string' && v) ?? (agentPath ? sessionOf(agentPath) : undefined);

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
    const last = tally(slice.text, groups, carry, agentOf(file));
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
    const agent = g.agent ? ` agent=${g.agent}` : '';
    appendFileSync(join(state, 'run-trace.log'), `${stamp} tokens model=${g.model} sidechain=${g.sidechain}${agent} ${counts} msgs=${g.msgs}\n`);
  }
});
