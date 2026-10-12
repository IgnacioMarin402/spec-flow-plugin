#!/usr/bin/env node
/**
 * PreToolUse hook on Task|Agent|SendMessage — records what the orchestrator
 * dispatches that the commands do not describe (ADR-035).
 *
 * The commands say which agent each phase puts to work, that the implementer
 * is handed `plan.md` and its milestone and nothing else, and that a message
 * goes back to an agent this run spawned. Nothing read any of it. This hook
 * records each departure as a `dispatch` line in run-trace.log and lets the
 * call through: the rules are read off prose, and a guard that denies a step
 * a real run needed stalls it with a human waiting. A rule is denied once
 * runs show it records nothing the commands meant.
 *
 * The implementer's phase is `arm-gate`'s, which moves it and records that.
 * A subagent's call is not the orchestrator dispatching, and stands down here.
 *
 * Outside a run it records one thing: this flow's agent put to work with no
 * run phase. Nothing else counts or traces such a dispatch — preflight, the
 * Opus budget, run-trace, token-trace and the agent gate all stand down there
 * (ADR-040). The implementer on `done` or `idle` is arm-gate's, which denies it
 * (ADR-044).
 */
import { projectDir, readPhase, readPayload, run, stateIsTracked } from './lib/io.mjs';
import { matchAgent, recipientRecord, recipientType } from './lib/agent-name.mjs';
import { shippedAgents } from './lib/routing.mjs';
import { DISPATCHED_IN, recordDispatch } from './lib/dispatch.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Repository paths a prompt names, relative to `root`, past URLs and the
 * plugin's own `${CLAUDE_PLUGIN_ROOT}` paths. A path outside the repository
 * is not a file the implementer was handed from it.
 */
function namedPaths(text, root) {
  const repo = `${root.replace(/\\/g, '/').replace(/\/$/, '')}/`;
  const plain = text.replace(/\w+:\/\/\S+/g, '').replace(/\$\{?\w+\}?\/\S*/g, '');
  const found = [...plain.matchAll(/(?:^|[\s"'`(])((?:[A-Za-z]:)?(?:\.\/|\/)?[\w.~-]+(?:\/[\w.~-]+)+\.\w{1,8})\b/g)].map((m) => m[1]);
  const rel = found.map((p) => (p.startsWith(repo) ? p.slice(repo.length) : p.replace(/^\.\//, '')));
  return [...new Set(rel.filter((p) => !p.startsWith('/') && !/^[A-Za-z]:/.test(p)))];
}

/** Why an implementer spawn's prompt is not the work order the commands hand it. */
function inputProblems(text, root) {
  const why = [];
  const plan = /specflow\/([\w.-]+)\/plan\.md/.exec(text);
  const milestone = /specflow\/([\w.-]+)\/milestones\/M\d+\.md/.exec(text);
  if (!plan) why.push('no-plan');
  if (!milestone) why.push('no-milestone');
  const own = new Set([plan?.[0], milestone?.[0]].filter(Boolean));
  // The gate's logs are what a respawn after a red gate is handed.
  const other = namedPaths(text, root).filter((p) => !own.has(p) && !p.startsWith('.claude/state/'));
  if (other.length > 0) why.push('other-files');
  return { why, other };
}

await run(async () => {
  const root = projectDir();
  const phase = readPhase(root);
  const inRun = Object.hasOwn(DISPATCHED_IN, phase);
  // Outside a run, only where the engine has run before: a repository it never
  // ran in is left with no `.claude/state/` it did not have.
  if (!inRun && !existsSync(join(root, '.claude', 'state'))) return;

  const payload = await readPayload();
  if (typeof payload.agent_id === 'string' && payload.agent_id) return;

  const tool = String(payload.tool_name ?? '');
  const input = payload.tool_input ?? {};
  const roles = Object.keys(shippedAgents());
  const why = [];
  const extra = {};

  let agent;
  let exactType;
  if (tool === 'SendMessage') {
    const rec = recipientRecord(payload);
    if (!rec) return; // no id or no transcript: nothing to say who it is for
    // By the session's record of the spawn, else by a role name in `to`.
    const type = recipientType(payload);
    exactType = type || rec.to;
    agent = matchAgent([type || rec.to], roles) ?? type;
    if (!agent) {
      // An agent this session spawned has a transcript beside its own, typed
      // or not; a target with neither is no agent of this run.
      if (inRun && !existsSync(rec.file)) recordDispatch(root, payload, phase, { agent: '-', result: 'record', why: 'unknown-target', extra: { to: rec.to } });
      return;
    }
  } else {
    const type = [input.subagent_type, input.subagentType, input.agent_type].find((v) => typeof v === 'string') ?? '';
    exactType = type;
    agent = matchAgent([type], roles) ?? type;
  }

  if (!inRun) {
    // By the namespaced name only: the harness reports this plugin's agents as
    // `spec-flow:<role>`, and outside a run is where people use their own — a
    // `reviewer` or `code-reviewer` of theirs is not this flow's.
    const own = /^spec-flow:([a-z][a-z-]*)$/i.exec(String(exactType ?? ''))?.[1]?.toLowerCase();
    // The implementer on `done` or `idle` is arm-gate's, which denies it and
    // records that (ADR-044).
    if (own === 'implementer' && ['done', 'idle'].includes(phase)) return;
    if (roles.includes(own) && !stateIsTracked(root)) recordDispatch(root, payload, phase || '-', { agent: own, result: 'record', why: 'no-run' });
    return;
  }

  if (tool !== 'SendMessage' && agent === 'implementer') {
    const text = [input.prompt, input.description].filter((v) => typeof v === 'string').join('\n').replace(/\\/g, '/');
    const found = inputProblems(text, root);
    why.push(...found.why);
    if (found.other.length > 0) extra.files = found.other.join(',');
  }

  if (!roles.includes(agent)) why.push('not-this-flow');
  else if (agent !== 'implementer' && !DISPATCHED_IN[phase].includes(agent)) why.push('phase');

  if (why.length > 0) recordDispatch(root, payload, phase, { agent: agent || '-', result: 'record', why: why.join(','), extra });
});
