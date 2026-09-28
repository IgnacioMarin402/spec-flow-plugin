#!/usr/bin/env node
/**
 * PreToolUse on subagent spawn — rewrites a spawn of this plugin's agents: the
 * consuming project's model routing into its `model` (ADR-014), and
 * `run_in_background: true` into every one an attended session makes
 * (ADR-023).
 *
 * A hook rather than an instruction to the orchestrator, for the reason
 * `opus-budget.mjs` is one: routing the model remembers to pass is routing
 * that stops happening on the turn it is busy. `hookSpecificOutput.
 * updatedInput` replaces the tool input before the spawn, so the orchestrator
 * never has to know this feature exists. Both rewrites live in this one hook
 * because each sibling is handed the ORIGINAL input: two hooks rewriting one
 * spawn would each drop the other's field.
 *
 * **No `permissionDecision` is emitted, deliberately.** `updatedInput` is
 * honoured on its own; adding `allow` would also decide the permission
 * question, and a hook that exists to pick a model has no business answering
 * that. Sibling hooks on this matcher are unaffected either way — they run in
 * parallel, each handed the ORIGINAL input, and a `deny` from any of them
 * beats this rewrite, so `preflight` and the budget stay armed.
 *
 * **Not on SendMessage**, which the other hooks on that matcher do take: a
 * session's model is chosen when the session is created, so a follow-up
 * message has nothing left to route.
 *
 * **Not gated on the run phase**, which `opus-budget` is: a budget counts what
 * a run spends and has to stand down outside one, while routing is the
 * project's standing answer to "what does this agent run on". A one-off
 * question to the architect should reach the model the project chose for it.
 */
import { join } from 'node:path';
import { projectDir, stateDir, readPayload, readLinesDeduped, appendLine, run } from './lib/io.mjs';
import { nameishFields, matchAgent } from './lib/agent-name.mjs';
import { shippedRouting, resolveModel } from './lib/routing.mjs';

await run(async () => {
  const payload = await readPayload();
  const input = payload.tool_input ?? {};

  const shipped = shippedRouting();
  const names = Object.keys(shipped);
  if (names.length === 0) return; // no agents to route; nothing this hook can say

  const agent = matchAgent(nameishFields(input), names);

  // Every other agent in the session — the harness's own, another plugin's —
  // passes through untouched. It also means a broken routing block below can
  // only ever block a spawn of THIS plugin's agents, never unrelated work in
  // a repo that merely has the plugin installed.
  if (!agent) return;

  const root = projectDir();
  const { model, source, problems } = resolveModel(root, agent, shipped);

  if (problems.length > 0) {
    process.stderr.write(
      `[spec-flow] the model routing in .claude/spec-flow.config.json cannot be applied:\n\n` +
        problems.map((p) => `  - ${p}`).join('\n') +
        `\n\nFix the file, or remove its "agents" block to fall back to the routing this plugin ships. ` +
        `This is a denial rather than a shrug because a routing block that reads as though it works and ` +
        `routes nothing is the failure this engine exists to close.\n`,
    );
    process.exit(2); // PreToolUse denial protocol
  }

  const reRouted = source === 'project' && Boolean(model);
  if (reRouted) {
    // Deduped, so a run of twenty spawns leaves one line per re-routed agent
    // rather than twenty. Without it a re-route is invisible: the spawn looks
    // ordinary from the transcript, and the frontmatter still says otherwise.
    const routeLog = join(stateDir(root), 'model-routes.log');
    const line = `${agent} -> ${model} (project override; shipped default is ${shipped[agent] ?? 'none'})`;
    if (!readLinesDeduped(routeLog).has(line)) appendLine(routeLog, line);
  }

  // The background serves a human watching the chat, and only an interactive
  // session waits for it: `claude -p` terminates background agents still
  // running 600 s after its turn ends. It runs hooks with
  // CLAUDE_CODE_SESSION_ATTENDED=0, so an unattended spawn is left as the
  // orchestrator wrote it. See ADR-023.
  const attended = process.env.CLAUDE_CODE_SESSION_ATTENDED !== '0';
  if (!reRouted && !attended) return;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: { ...input, ...(reRouted ? { model } : {}), ...(attended ? { run_in_background: true } : {}) },
      },
    }),
  );
});
