/**
 * What a stopped subagent handed its caller. run-trace records it and
 * agent-gate judges it; one reader, so the two cannot see different returns
 * (ADR-031).
 */
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

// Long past the lag measured between a stop and its handback line, and short
// beside a hook's timeout: it is spent only on a stop that carries neither a
// last message nor a written handback, the one shape that otherwise reads as
// empty (ADR-050).
const WAIT_MS = 2000;
const POLL_MS = 25;

/** The `message` of the last SubagentHandback call in a transcript, or null. */
function handbackIn(path) {
  try {
    const lines = readFileSync(path, 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (!lines[i].includes('"SubagentHandback"')) continue;
      let entry;
      try {
        entry = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      const content = Array.isArray(entry?.message?.content) ? entry.message.content : [];
      const call = content.findLast((c) => c?.type === 'tool_use' && c.name === 'SubagentHandback');
      if (typeof call?.input?.message === 'string') return call.input.message;
    }
  } catch {
    /* unreadable or not there yet */
  }
  return null;
}

/**
 * The report a stopped subagent handed back — the text its caller received.
 *
 * A build that delivers reports through `SubagentHandback` ends the agent on a
 * line like "Report delivered", so `last_assistant_message` alone finds no
 * STATUS there; the report is the handback's `message`, in the agent's own
 * transcript. Without a handback, the last message IS the report.
 *
 * A stop that carries no last message and whose transcript holds no handback
 * yet is waited on, briefly: the line can land after the stop fires (ADR-050).
 */
export async function handedBack(payload, { waitMs = WAIT_MS } = {}) {
  const path = typeof payload.agent_transcript_path === 'string' ? payload.agent_transcript_path : '';
  const last = typeof payload.last_assistant_message === 'string' ? payload.last_assistant_message : '';
  const found = path ? handbackIn(path) : null;
  if (found !== null || last.trim() || !path) return found ?? last;

  for (const deadline = Date.now() + waitMs; Date.now() < deadline; ) {
    await sleep(POLL_MS);
    const late = handbackIn(path);
    if (late !== null) return late;
  }
  return last;
}
