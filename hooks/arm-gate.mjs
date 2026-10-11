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
 * So this transition is EXECUTED here: the event that makes the gate
 * necessary — the implementer being put to work — is the event that arms it.
 * `gate.mjs` writes `blocked` itself at the attempt cap for the same reason.
 * The orchestrator still writes `implement` per its own protocol; this is the
 * backstop for the time it forgets.
 *
 * A write this hook makes must be one phase-guard would let through, or the
 * backstop is a way around the guard. From `spec` that write leaves it, which
 * phase-guard judges (ADR-030): over a spec that fails, the spawn is denied
 * instead, and nothing is armed because nothing starts (ADR-035).
 *
 * Each time it acts, it records that in run-trace.log: every one is an
 * implementer dispatched in a phase the commands do not dispatch it in.
 *
 * FAILS OPEN on an unrecognized recipient, and only acts while a run is in
 * progress: outside one, spawning an implementer-shaped agent is a deliberate
 * human act, not a step the orchestrator forgot.
 */
import { projectDir, phasePath, readPhase, claimPhase, writeFile, readPayload, run } from './lib/io.mjs';
import { nameishFields, matchAgent, recipientType } from './lib/agent-name.mjs';
import { recordDispatch } from './lib/dispatch.mjs';
import { leavingSpecProblems } from '../scripts/spec-time.mjs';

await run(async () => {
  const root = projectDir();
  const phaseFile = phasePath(root);

  // `readPhase`: a phase the REPOSITORY committed is not a run this hook may
  // advance, and writing over it would dirty a tracked file (ADR-017).
  const phase = readPhase(root) || 'idle';
  if (phase === 'implement') return; // already armed
  if (!['spec', 'plan', 'review', 'blocked'].includes(phase)) return; // idle/done/unknown -> not our business

  const payload = await readPayload();
  const input = payload.tool_input ?? {};
  const agent = matchAgent([...nameishFields(input), recipientType(payload)], ['implementer']);
  if (agent !== 'implementer') return;

  if (phase === 'spec') {
    const found = leavingSpecProblems(root);
    if (found.length > 0) {
      recordDispatch(root, payload, phase, { agent, result: 'deny', why: 'spec-not-ready' });
      process.stderr.write(
        `[spec-flow] Denied: engaging the implementer while the phase is 'spec' leaves spec, and the spec is not ready to build from:\n` +
          `${found.map((p) => `  - ${p}`).join('\n')}\n\n` +
          `Hand these to a new spec-writer with specflow/<SLUG>/ (MODE=TRIAGE for a /spec-fix brief). Then write the next phase ` +
          `yourself — phase-guard judges it — and engage the implementer (ADR-030).\n`,
      );
      process.exit(2); // PreToolUse denial protocol
    }
  }

  recordDispatch(root, payload, phase, { agent, result: 'armed', why: 'phase' });
  writeFile(phaseFile, 'implement');
  // This hook performs the transition, so it is the one that knows who drove
  // it — the same claim `phase-guard` makes for the writes it merely watches.
  claimPhase(root, payload.session_id);
  process.stderr.write(
    `[spec-flow] Phase was '${phase}' while the implementer was being engaged; armed the gate (phase -> implement). ` +
      `The orchestrator should have written this itself — the hook is the backstop, not the protocol.\n`,
  );
  // Informational, not a block: the call goes through, now with the gate armed.
});
