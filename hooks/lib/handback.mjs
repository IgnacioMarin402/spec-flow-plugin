/**
 * What a stopped subagent handed its caller. run-trace records it and
 * agent-gate judges it; one reader, so the two cannot see different returns
 * (ADR-031).
 */
import { readFileSync } from 'node:fs';

/**
 * The report a stopped subagent handed back — the text its caller received.
 *
 * A build that delivers reports through `SubagentHandback` ends the agent on a
 * line like "Report delivered", so `last_assistant_message` alone finds no
 * STATUS there; the report is the handback's `message`, in the agent's own
 * transcript. Without a handback, the last message IS the report.
 */
export function handedBack(payload) {
  const path = typeof payload.agent_transcript_path === 'string' ? payload.agent_transcript_path : '';
  if (path) {
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
      /* unreadable: fall back to the payload's own copy of the last message */
    }
  }
  return typeof payload.last_assistant_message === 'string' ? payload.last_assistant_message : '';
}
