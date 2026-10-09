#!/usr/bin/env node
/**
 * SubagentStop hook — holds a spec-flow agent's return to its own contract
 * before the orchestrator acts on it (ADR-031).
 *
 * A reply with no return block, a status the contract does not declare, or a
 * `*_PATH` naming a file that is not there reaches the orchestrator as
 * something no step of the command routes. Blocking makes the agent continue
 * with the reason, and its caller receives the corrected return.
 *
 * Narrow on purpose, because it blocks:
 *   - only `spec-flow:<name>` for an agent this plugin ships, and only in a run
 *     this session owns;
 *   - at most MAX_BLOCKS blocks per agent, counted from its own `agent-check`
 *     lines in run-trace.log; with no agent id, only a first stop is blocked;
 *   - anything it cannot read passes, and a crash exits 0.
 *
 * run-trace records the return, at the agent's FIRST stop. A return this
 * blocks and the agent then changes stays recorded as the first one; the
 * `agent-check` line says it was blocked.
 */
import { readdirSync, readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectDir, stateDir, readOwnedPhase, readPayload, run } from './lib/io.mjs';
import { handedBack } from './lib/handback.mjs';
import { declaredStatuses, parseReturn } from '../scripts/agent-blocks.mjs';

const ENGINE = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Blocks per agent before its return goes through as it is. */
const MAX_BLOCKS = 2;

const RUN_PHASES = ['spec', 'plan', 'review', 'implement', 'blocked'];

/** The statuses `name`'s contract declares, its modes included; [] when it ships none. */
function contractStatuses(name) {
  const main = join(ENGINE, 'agents', `${name}.md`);
  if (!existsSync(main)) return [];
  const modes = join(ENGINE, 'modes');
  const texts = [readFileSync(main, 'utf8')];
  if (existsSync(modes)) {
    for (const f of readdirSync(modes).filter((f) => f.startsWith(`${name}-`) && f.endsWith('.md')).sort()) {
      texts.push(readFileSync(join(modes, f), 'utf8'));
    }
  }
  return declaredStatuses(texts.join('\n'));
}

/** Why this return cannot be acted on, or null when it can. */
function problemWith(text, statuses, root) {
  if (!text.trim()) return { why: 'empty', reason: `Your reply is empty. The orchestrator acts only on your return block: end with one of ${statuses.map((s) => `STATUS: ${s}`).join(', ')}.` };
  const ret = parseReturn(text);
  if (!ret) return { why: 'no-status', reason: `Your reply has no \`STATUS:\` line, so the orchestrator has nothing to route. End with the return block your contract declares: ${statuses.map((s) => `STATUS: ${s}`).join(', ')}.` };
  if (!statuses.includes(ret.status)) {
    return { why: 'undeclared-status', reason: `\`STATUS: ${ret.status}\` is not a status your contract declares (${statuses.join(', ')}), and the orchestrator routes only those. Return the one that fits.` };
  }
  for (const [key, raw] of Object.entries(ret.fields)) {
    if (!key.endsWith('_PATH') || !raw) continue;
    const path = raw.replace(/^[`'"]|[`'"]$/g, '');
    if (!existsSync(isAbsolute(path) ? path : join(root, path))) {
      return { why: 'missing-path', reason: `\`${key}: ${raw}\` names a file that does not exist. Write it, or return the path you wrote.` };
    }
  }
  return null;
}

await run(async () => {
  const root = projectDir();
  const payload = await readPayload();
  const type = String(payload.agent_type ?? '');
  const name = /^spec-flow:([a-z][a-z-]*)$/.exec(type)?.[1];
  if (!name) return;
  const session = String(payload.session_id ?? '');
  const phase = readOwnedPhase(root, session);
  if (!RUN_PHASES.includes(phase)) return;

  const statuses = contractStatuses(name);
  if (statuses.length === 0) return;

  const found = problemWith(handedBack(payload), statuses, root);
  if (!found) return;

  const agentId = typeof payload.agent_id === 'string' && /^[\w-]+$/.test(payload.agent_id) ? payload.agent_id : '';
  const traceFile = join(stateDir(root), 'run-trace.log');
  let blocks = 0;
  if (agentId) {
    const mine = new RegExp(` agent-check .*result=block .*agent_id=${agentId}(\\s|$)`);
    blocks = (existsSync(traceFile) ? readFileSync(traceFile, 'utf8') : '').split('\n').filter((l) => mine.test(l)).length;
  } else if (payload.stop_hook_active === true) {
    blocks = MAX_BLOCKS;
  }
  const result = blocks >= MAX_BLOCKS ? 'cap' : 'block';

  appendFileSync(
    traceFile,
    // `agent=`, not run-trace's `type=`: stats reads a `type=` line with an
    // agent id as that agent's return.
    `${new Date().toISOString()} phase=${phase}${/^[\w-]+$/.test(session) ? ` session=${session}` : ''} agent-check agent=${type} result=${result} why=${found.why}${agentId ? ` agent_id=${agentId}` : ''}\n`,
  );
  if (result === 'block') process.stdout.write(JSON.stringify({ decision: 'block', reason: `[spec-flow] ${found.reason}` }));
});
