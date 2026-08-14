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

/**
 * Returns the matched candidate, lowercased, or null.
 *
 * Case-INSENSITIVE, and the docstring used to promise a lowercase result
 * while nothing lowercased anything — the match itself was case-sensitive, so
 * a build reporting `subagent_type: "Implementer"` matched nothing. Both
 * callers then failed open and silently: `arm-gate` would not arm the phase,
 * leaving the gate, the write-time linter and the command deny all disarmed
 * for that milestone, with no trace anywhere; `opus-budget` would not charge
 * the call, though it at least logs the miss. The result is lowercased so a
 * caller comparing it against its own candidate list cannot be surprised by
 * whatever casing the payload happened to use.
 */
export function matchAgent(nameish, candidates) {
  const re = new RegExp(`(^|[^a-zA-Z])(${candidates.join('|')})($|[^a-zA-Z])`, 'i');
  const hit = re.exec(nameish.join(' '));
  return hit ? hit[2].toLowerCase() : null;
}
