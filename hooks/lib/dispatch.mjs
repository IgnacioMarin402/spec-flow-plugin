#!/usr/bin/env node
/**
 * What the commands dispatch, and the line a dispatch outside it leaves in
 * run-trace.log (ADR-035). One copy, because `arm-gate` records the
 * implementer's phase moves and denials and `dispatch-guard` every other
 * departure, and stats reads both as one tally.
 */
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './io.mjs';

/**
 * The roles each phase dispatches, read off both commands. The implementer is
 * absent: engaging it moves the phase, which is `arm-gate`'s, and the two
 * hooks run in parallel on the same call.
 */
export const DISPATCHED_IN = {
  spec: ['spec-writer'],
  plan: ['planner'],
  review: ['reviewer', 'planner'],
  implement: ['architect', 'planner', 'spec-writer'],
  blocked: [],
};

/**
 * One `dispatch` line: `agent=`, not run-trace's `type=`, which stats reads
 * as an agent's return. Every value is whitespace-free, the phase included,
 * because the log is read back by a whitespace split; outside a run the phase
 * is whatever the file holds.
 */
export function recordDispatch(root, payload, phase, { agent, result, why, extra = {} }) {
  const safe = (v) => String(v).replace(/\s+/g, '') || '-';
  const session = [payload.session_id, payload.sessionId].find((v) => typeof v === 'string' && /^[\w-]+$/.test(v));
  const fields = Object.entries({ agent, tool: payload.tool_name, result, why, ...extra })
    .map(([k, v]) => `${k}=${safe(v)}`)
    .join(' ');
  try {
    appendFileSync(join(stateDir(root), 'run-trace.log'), `${new Date().toISOString()} phase=${safe(phase)}${session ? ` session=${session}` : ''} dispatch ${fields}\n`);
  } catch {
    /* a record must never be why a dispatch fails */
  }
}
