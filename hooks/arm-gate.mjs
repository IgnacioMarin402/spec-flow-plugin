#!/usr/bin/env node
/**
 * PreToolUse hook on subagent spawn AND SendMessage — arms the gate when the
 * implementer starts working.
 *
 * Every enforcement hook in this flow keys off `.claude/state/phase` saying
 * `implement`. An orchestrator that skipped writing it would run the
 * implementer with the gate, the write-time linter, the command deny and the
 * Opus budget ALL disarmed — silently, because code written with the gate off
 * looks exactly like code that passed it.
 *
 * So this transition is EXECUTED here, not validated: the event that makes
 * the gate necessary — the implementer being put to work — is the event that
 * arms it. gate.mjs already writes `blocked` itself at the attempt cap for
 * the same reason; this is the mirror image on the way in. The orchestrator
 * still writes `implement` per its own protocol; this hook is the backstop
 * for the time it forgets.
 *
 * FAILS OPEN on an unrecognized SendMessage recipient: no worse than before
 * this hook existed, and the orchestrator's instructions still cover it.
 *
 * Only acts while a run is in progress — outside one, spawning an
 * implementer-shaped agent is a deliberate human act, not the orchestrator
 * forgetting a step.
 */
import { projectDir, phasePath, readFileOrDefault, writeFile, readPayload, run } from './lib/io.mjs';
import { nameishFields, matchAgent } from './lib/agent-name.mjs';

await run(async () => {
  const root = projectDir();
  const phaseFile = phasePath(root);
  const phase = readFileOrDefault(phaseFile, 'idle');
  if (phase === 'implement') return; // already armed
  if (!['spec', 'plan', 'review', 'blocked'].includes(phase)) return; // idle/done/unknown -> not our business

  const payload = await readPayload();
  const input = payload.tool_input ?? {};
  const agent = matchAgent(nameishFields(input), ['implementer']);
  if (agent !== 'implementer') return;

  writeFile(phaseFile, 'implement');
  process.stderr.write(
    `[spec-flow] Phase was '${phase}' while the implementer was being engaged; armed the gate (phase -> implement). ` +
      `The orchestrator should have written this itself — the hook is the backstop, not the protocol.\n`,
  );
  // Informational, not a block: the call goes through, now with the gate armed.
});
