#!/usr/bin/env node
/**
 * PreToolUse hook on SendMessage — denies resuming one of this plugin's
 * agents whose prompt cache has expired. See ADR-025.
 *
 * Such a message first re-sends the agent's whole context into the cache,
 * and a context that grew through a spec or a milestone is the most
 * expensive thing a run can re-send; a new agent given the files it needs
 * starts from its contract. The denial says which, and the commands tell the
 * orchestrator to spawn the new one.
 *
 * Stands down outside a run, like every hook but the gate: a SendMessage in a
 * repo that merely has the plugin installed is not this engine's business.
 */
import { projectDir, readPhase, readPayload, run } from './lib/io.mjs';
import { coldResume } from './lib/agent-cache.mjs';

await run(async () => {
  const phase = readPhase(projectDir());
  if (!['spec', 'plan', 'review', 'implement', 'blocked'].includes(phase)) return;

  const cold = coldResume(await readPayload());
  if (!cold) return;

  process.stderr.write(
    `[spec-flow] not resuming ${cold.agent} ${cold.to}: its last turn was ${Math.round(cold.ageMin)} minutes ago and its ` +
      `prompt cache lasts ${cold.ttlMin}, so this message would first re-send its whole ~${Math.round(cold.context / 1000)}k-token ` +
      `context. Start a NEW ${cold.agent} with an Agent call instead: the same inputs its predecessor was given, plus what this ` +
      `message says. The run's state is on disk, not in that agent's context (ADR-025).\n`,
  );
  process.exit(2); // PreToolUse denial protocol
});
