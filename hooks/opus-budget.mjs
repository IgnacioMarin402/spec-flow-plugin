#!/usr/bin/env node
/**
 * PreToolUse hook on subagent spawn AND SendMessage — hard budget for the
 * flow's two ESCALATION agents, `planner` and `architect`. A hook, not an
 * instruction to the orchestrator: a budget that depends on the model
 * remembering to count is not a budget.
 *
 * **It counts roles, not models, and that survived model routing on purpose.**
 * Once a project can re-route any agent (ADR-014) the name of this file and
 * its config key describe a proxy rather than the thing: what runs away is the
 * escalation LOOP — implementer stuck, architect consulted, plan revised,
 * round again — and that loop is bounded by how often the deep roles are
 * consulted whatever tier they sit on. An implementer a project deliberately
 * routes to opus runs once per milestone, bounded by the plan. See ADR-014 for
 * the resolved-tier version of this hook and why it was refused.
 *
 * SendMessage counts too, and has to — a follow-up into an existing planner
 * session costs the same tokens as a fresh spawn. Identifying the recipient
 * is best-effort over the payload's name-ish fields and FAILS OPEN: an
 * unrecognised recipient is allowed, uncounted. Failing open is fine; failing
 * open SILENTLY is not, so `state/opus-budget-unmatched.log` records the
 * input's field names — NEVER the message body — one line per distinct shape.
 * Session ids resolve through `state/agent-registry`, written at spawn time
 * by register-agent.mjs.
 *
 * `max_opus_calls` lives in the consuming repo's `.claude/spec-flow.config.json`,
 * not in `.spec-flow/config.json`: it is a run-scoped number, not an
 * architectural fact about the repo. Counted only while a run is in progress,
 * so a one-off question to the architect outside the flow is never charged.
 * The key keeps its name after ADR-014 for one reason: nothing validates that
 * file, so a rename would read a repo's configured cap as absent and hand it
 * the default instead — a silent change to the one number a human set
 * deliberately.
 *
 * Two inaccuracies are accepted rather than fixed, because both err small
 * against a default budget of 6 and neither can silently disarm it:
 *
 *   - It counts the INTENT to spawn. PreToolUse never learns whether the call
 *     succeeded, so a failed spawn is still charged. Correcting it needs a
 *     PostToolUse hook holding second state that can drift from this one.
 *   - Read-then-write is not atomic, so two spawns in the same instant can
 *     undercharge by one. The flow is sequential by construction.
 */
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectDir, stateDir, phasePath, readFileOrDefault, writeFile, readPayload, run } from './lib/io.mjs';
import { nameishFields, matchAgent } from './lib/agent-name.mjs';

function readRegistry(path) {
  const reg = {};
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const [id, type] = line.trim().split(/\s+/);
      if (id && type) reg[id] = type;
    }
  } catch {
    /* no registry yet — nothing to resolve against */
  }
  return reg;
}

function logUnmatched(path, shape) {
  try {
    const existing = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : [];
    if (!existing.includes(shape)) appendFileSync(path, `${shape}\n`);
  } catch {
    /* logging must never be why this hook fails */
  }
}

await run(async () => {
  const root = projectDir();
  const configPath = join(root, '.claude', 'spec-flow.config.json');

  // Read through a path that creates nothing — outside a run this hook is
  // transparent, and transparent should mean on disk too.
  const phase = readFileOrDefault(phasePath(root), 'idle');
  if (phase === '' || phase === 'idle' || phase === 'done') return;

  const state = stateDir(root);
  const countFile = join(state, 'opus_calls');

  const payload = await readPayload();
  const input = payload.tool_input ?? {};
  const nameish = nameishFields(input);

  let agent = matchAgent(nameish, ['planner', 'architect']);

  if (!agent) {
    // Second chance: register-agent.mjs maps opaque session ids back to the
    // type they were spawned as, so a follow-up message into an Opus session
    // is budgeted exactly like the spawn was.
    const registry = readRegistry(join(state, 'agent-registry'));
    for (const v of nameish) {
      if (registry[v] === 'planner' || registry[v] === 'architect') {
        agent = registry[v];
        break;
      }
    }
  }

  if (!agent) {
    const unmatchedLog = join(state, 'opus-budget-unmatched.log');
    if (String(payload.tool_name ?? '') === 'SendMessage') {
      // Keys ONLY: values embed per-session ids, which would defeat the dedup.
      logUnmatched(unmatchedLog, JSON.stringify({ keys: Object.keys(input).sort() }));
    } else {
      // A spawn that matched nothing is usually Sonnet/Haiku doing its job —
      // allowed uncounted — but a RENAMED Opus agent would look identical, so
      // the miss leaves a trace too.
      logUnmatched(
        unmatchedLog,
        JSON.stringify({ 'unmatched-spawn': nameish.join(' ') || Object.keys(input).sort().join(',') }),
      );
    }
    return;
  }

  let max = 6;
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    max = Number(config.max_opus_calls ?? 6);
  } catch {
    /* missing or malformed config -> the historical default */
  }

  const used = Number(readFileOrDefault(countFile, '0')) || 0;

  if (used >= max) {
    process.stderr.write(
      `[spec-flow] escalation budget exhausted: ${used}/${max} calls to planner+architect this run.\n\n` +
        `Stop the loop. Do NOT spawn another planner or architect. Summarize for the ` +
        `human (HITL): which milestone is stuck, what the gate reported, and what you ` +
        `would ask the planner or the architect if you could. Then wait.\n\n` +
        `If the run legitimately needs more, the human can raise max_opus_calls in ` +
        `.claude/spec-flow.config.json or reset the counter:\n` +
        `  printf '0' > .claude/state/opus_calls\n`,
    );
    process.exit(2); // PreToolUse denial protocol
  }

  writeFile(countFile, String(used + 1));
});
