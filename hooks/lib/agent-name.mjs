#!/usr/bin/env node
/**
 * Shared "who is this spawn or SendMessage for" detection.
 *
 * arm-gate.mjs and opus-budget.mjs both need it, and previously carried two
 * copies of the same field-sniffing embedded in bash-quoted JS strings — the
 * exact kind of duplication that let one of them drift. On a spawn the type
 * field says so directly; on a SendMessage the recipient hides in a name-ish
 * field whose key differs across builds, so this collects every plausible one
 * and matches the agent name as a whole word.
 */
export function nameishFields(input) {
  return [
    input.subagent_type, input.subagentType, input.agent_type, // spawn
    input.agent_id, input.agentId, input.agent, input.name, input.recipient, input.to, // SendMessage
  ].filter((v) => typeof v === 'string');
}

/** Returns the matched name (lowercase) among `candidates`, or null. */
export function matchAgent(nameish, candidates) {
  const re = new RegExp(`(^|[^a-zA-Z])(${candidates.join('|')})($|[^a-zA-Z])`);
  const hit = re.exec(nameish.join(' '));
  return hit ? hit[2] : null;
}
