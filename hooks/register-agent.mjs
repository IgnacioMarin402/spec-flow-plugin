#!/usr/bin/env node
/**
 * PostToolUse hook on Task|Agent — records which session ids belong to the
 * Opus agents (planner, architect).
 *
 * opus-budget.mjs counts spawns by type, but a follow-up SendMessage into an
 * existing Opus session carries only an opaque hex session id — the type is
 * nowhere in that payload. The spawn is the one moment both facts are in
 * hand: the REQUEST names the type, the RESPONSE names the id. This hook
 * writes the pair down; the budget hook looks it up.
 *
 * Registers on every Opus spawn regardless of phase: recording costs
 * nothing, and an architect spawned just before the phase flips would
 * otherwise be messageable uncounted for the whole run.
 *
 * FAILS OPEN, like the budget hook: a response whose id cannot be found is
 * logged (key names only, never content) and allowed. Always exits 0 —
 * registration must never block or annotate a spawn.
 */
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectDir, stateDir, readPayload, run } from './lib/io.mjs';
import { matchAgent } from './lib/agent-name.mjs';

const ID_RE = /^[0-9a-f]{16,32}$/; // observed ids: 17 hex chars

function appendUnique(path, line) {
  try {
    const existing = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : [];
    if (!existing.includes(line)) appendFileSync(path, `${line}\n`);
  } catch {
    /* logging must never be why this hook fails */
  }
}

await run(async () => {
  const root = projectDir();
  const state = stateDir(root);
  const registry = join(state, 'agent-registry');
  const missLog = join(state, 'register-agent-unmatched.log');

  const payload = await readPayload();
  const input = payload.tool_input ?? {};

  const typeFields = [input.subagent_type, input.subagentType, input.agent_type].filter(
    (v) => typeof v === 'string',
  );
  const agent = matchAgent(typeFields, ['planner', 'architect']);
  if (!agent) return; // not an Opus spawn

  // The harness convention is tool_response; the fallbacks cost nothing and
  // the miss log will name the real field if all of them are wrong.
  const res = payload.tool_response ?? payload.tool_result ?? payload.tool_output ?? payload.response ?? payload.output ?? {};

  const structured = [res.agent_id, res.agentId, res.session_id, res.sessionId, res.agentSessionId, res.id, res.name].find(
    (v) => typeof v === 'string' && ID_RE.test(v),
  );

  let id = structured ?? '';
  if (!id) {
    // Fall back to scanning the stringified response. Labeled match first;
    // the bare match caps at 32 so a full 40-char commit sha never registers
    // as a session.
    //
    // The bare match is the weakest link — any 16-32 char hex run wins,
    // including an MD5 that happens to sit in an error message. So it is
    // skipped entirely when the response looks like a failure: registering
    // a wrong id there is worse than registering none, because a wrong
    // entry in the registry silently attributes a LATER SendMessage to the
    // wrong agent, and opus-budget would charge (or fail to charge) against
    // it. No id at all just logs a miss and fails open, which is this
    // hook's documented posture anyway.
    const text = typeof res === 'string' ? res : JSON.stringify(res ?? '');
    const labeled = /(?:agent[_ ]?id|session[_ ]?id|session|agent|id|name)[^0-9a-f]{0,5}([0-9a-f]{16,32})\b/i.exec(text);
    const looksLikeFailure = /\b(error|failed|failure|exception|traceback)\b/i.test(text);
    const bare = looksLikeFailure ? null : /\b[0-9a-f]{16,32}\b/.exec(text);
    id = labeled ? labeled[1] : bare ? bare[0] : '';
  }

  if (id) {
    appendUnique(registry, `${id} ${agent}`);
    return;
  }

  // Miss: record the shape so the field to add is discoverable after one real run.
  appendUnique(
    missLog,
    JSON.stringify({
      payload_keys: Object.keys(payload).sort(),
      response_keys: res && typeof res === 'object' ? Object.keys(res).sort() : typeof res,
    }),
  );
});
