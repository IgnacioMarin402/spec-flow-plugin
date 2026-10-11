#!/usr/bin/env node
/**
 * Shared "who is this spawn or SendMessage for" detection.
 *
 * One copy, because arm-gate.mjs and opus-budget.mjs must agree about who a
 * call is for — two copies of this drifted once and the disagreement is
 * invisible from either side.
 *
 * On a spawn the type field says so directly; on a SendMessage the recipient
 * hides in a name-ish field whose key differs across builds, so this collects
 * every plausible one and matches the agent name as a whole word.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function nameishFields(input) {
  return [
    input.subagent_type, input.subagentType, input.agent_type, // spawn
    input.agent_id, input.agentId, input.agent, input.name, input.recipient, input.to, // SendMessage
  ].filter((v) => typeof v === 'string');
}

/**
 * Returns the matched candidate, lowercased, or null.
 *
 * **Case-INSENSITIVE, and the result is lowercased.** Both matter: a build
 * reporting `subagent_type: "Implementer"` must match, and a caller comparing
 * against its own candidate list must not be surprised by the payload's
 * casing. Getting either wrong fails OPEN and silently — `arm-gate` would not
 * arm the phase, leaving the gate, the write-time linter and the command deny
 * disarmed for that milestone with no trace anywhere.
 */
export function matchAgent(nameish, candidates) {
  const re = new RegExp(`(^|[^a-zA-Z])(${candidates.join('|')})($|[^a-zA-Z])`, 'i');
  const hit = re.exec(nameish.join(' '));
  return hit ? hit[2].toLowerCase() : null;
}

/**
 * The session's own record of a subagent a SendMessage's `to` names — beside
 * its transcript, where token-trace reads its usage — or null when `to` is
 * not an id or there is no transcript to look beside.
 */
export function recipientRecord(payload) {
  const to = String(payload?.tool_input?.to ?? '');
  const transcript = [payload?.transcript_path, payload?.transcriptPath].find((v) => typeof v === 'string' && v);
  if (!/^[\w-]+$/.test(to) || !transcript) return null;
  return { to, file: join(transcript.replace(/\.jsonl$/, ''), 'subagents', `agent-${to}.jsonl`) };
}

/**
 * The agent type a SendMessage is for, as the session recorded it at the
 * spawn. A message addresses an agent by the id its spawn returned, and the
 * id says nothing of the role: matched on name-ish fields alone, resuming an
 * implementer by id read as a message to nobody (ADR-035). '' when there is
 * no such record.
 */
export function recipientType(payload) {
  const rec = recipientRecord(payload);
  if (!rec) return '';
  try {
    return String(JSON.parse(readFileSync(rec.file.replace(/\.jsonl$/, '.meta.json'), 'utf8')).agentType ?? '');
  } catch {
    return '';
  }
}
