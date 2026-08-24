#!/usr/bin/env node
/**
 * PostToolUse hook on Write|Edit|Read|Bash|Task|Agent — the run's observable
 * timeline.
 *
 * This hook enforces NOTHING. It exists because the flow's change policy
 * only accepts a failing run as grounds for changing the flow, and several of
 * its soft spots leave no trace anyone can read after the fact: a REPEAT gate
 * pass on a commit already reported (ADR-010) still renders no decision, so a
 * stalled run there looks exactly like a finished one to everything
 * downstream — that repeat notice is screen output, not record, and a human
 * who is away still misses it; the implementer's test-first protocol lives in
 * prose and the gate only ever sees the final state; nobody knows whether the
 * reviewer approves plans on the merits or rubber-stamps them. Writing the
 * evidence down is the cheapest possible answer to all three.
 *
 * ALWAYS exits 0. A hook whose only job is to observe must never be able to
 * block, annotate or fail anything; if it cannot parse a payload it says so
 * in run-trace-unmatched.log (key names only, never content) and gets out of
 * the way.
 */
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectDir, stateDir, readPhase, readPayload, run } from './lib/io.mjs';
import { loadConfig } from '../scripts/spec-flow-config.mjs';

function appendUnique(path, line) {
  try {
    const existing = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : [];
    if (!existing.includes(line)) appendFileSync(path, `${line}\n`);
  } catch {
    /* logging must never be why this hook fails */
  }
}

/** A file being read. The PATH only, never the contents — the only record of what an agent looked at. */
function traceRead(input) {
  const file = String(input.file_path ?? input.filePath ?? '');
  return file ? `read file=${file}` : '';
}

/** A source file hitting disk. Spec files included: the ORDER is the whole signal. */
function traceWrite(input, suffixes) {
  const file = String(input.file_path ?? input.filePath ?? '');
  return suffixes.some((sfx) => file.endsWith(sfx)) ? `write file=${file}` : '';
}

/**
 * A scoped test run and whether it was red. The verdict is read out of the
 * output text rather than an exit code, since a PostToolUse payload is not
 * guaranteed to carry the command's status.
 */
function traceTest(input, res, testName) {
  if (!testName) return ''; // no contract read -> no runner name to look for, trace nothing rather than guess one

  const cmd = String(input.command ?? '')
    .split('<<')[0] // everything after a heredoc operator is data fed TO the command
    .replace(/"[^"]*"/g, ' '); // and a quoted message, e.g. a commit -m, is not the command either

  if (/^\s*git(\s|$)/.test(cmd)) return ''; // git never runs tests

  const runner = testName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`(^|[^a-zA-Z-])${runner}([^a-zA-Z-]|$)`).test(cmd)) return '';

  const out = [res?.stdout, res?.stderr, typeof res === 'string' ? res : ''].filter((v) => typeof v === 'string').join('\n');

  let verdict = '?';
  if (/^\s*Tests:.*\bfailed\b/m.test(out) || /✕/.test(out)) verdict = 'red';
  else if (/^\s*Tests:.*\bpassed\b/m.test(out)) verdict = 'green';
  else if (/\bNo tests found\b/.test(out)) verdict = 'none';

  const target =
    cmd
      .split(/\s+/)
      .filter((t) => !t.startsWith('-') && /[/.]/.test(t) && !t.includes(testName) && !/^(pnpm|npm|npx|yarn|node)$/.test(t))
      .join(',') || '-';

  return `test verdict=${verdict} target=${target}`;
}

/** What a subagent returned — for the reviewer, that IS the open question. */
function traceAgent(input, res, payload, missLog) {
  const type = [input.subagent_type, input.subagentType, input.agent_type].find((v) => typeof v === 'string') ?? '?';
  const text = typeof res === 'string' ? res : JSON.stringify(res ?? '');
  const status = /STATUS:\s*([A-Z_]+)/.exec(text);
  if (status) {
    // `SKILL_MISS:` mirrors `STATUS:` on purpose — a skill the milestone
    // failed to route is the one observable this flow produces that had
    // nowhere to go. Reported as prose in NOTES it reaches the orchestrator
    // and then vanishes; recorded here it survives into the archived
    // telemetry, which is what makes "does the planner's routing miss often?"
    // answerable at all. That question is the only thing that could justify
    // changing the routing design, and this engine's own change policy
    // accepts evidence rather than argument.
    //
    // Slashes and spaces are stripped from the value: this line is `k=v`
    // pairs read back by a whitespace split, so a skill name with a space in
    // it would look like a second field.
    const misses = [...text.matchAll(/SKILL_MISS:\s*([^\n"\\]+)/g)]
      .map((m) => m[1].trim().replace(/\s+/g, '-'))
      .filter(Boolean);
    const missField = misses.length > 0 ? ` skill_miss=${[...new Set(misses)].join(',')}` : '';
    return `agent type=${type} status=${status[1]}${missField}`;
  }

  appendUnique(
    missLog,
    JSON.stringify({
      payload_keys: Object.keys(payload).sort(),
      response_keys: res && typeof res === 'object' ? Object.keys(res).sort() : typeof res,
    }),
  );
  return '';
}

await run(async () => {
  const root = projectDir();
  // Phase first, through a path that creates nothing: this hook fires on
  // almost every tool call, and standing down must leave no directory behind
  // in a repo that never adopted the flow. `readPhase` adds the repo that
  // committed one, which never started a run to trace (ADR-017).
  const phase = readPhase(root);
  if (['', 'idle', 'done'].includes(phase)) return;

  const state = stateDir(root);
  const traceFile = join(state, 'run-trace.log');
  const missLog = join(state, 'run-trace-unmatched.log');

  const payload = await readPayload();
  const tool = String(payload.tool_name ?? payload.toolName ?? '');
  const input = payload.tool_input ?? payload.toolInput ?? {};
  const res = payload.tool_response ?? payload.tool_result ?? payload.tool_output ?? payload.response ?? {};

  let line = '';
  if (/^(Write|Edit|MultiEdit)$/.test(tool)) {
    // `*.ts` -> `.ts`: the trace matches a suffix, the contract declares a
    // glob. No contract read -> no suffix to match, so this event traces
    // nothing rather than assuming a language. Never fatal: this hook must
    // always exit 0, and a config problem is gate.mjs's failure to report.
    let suffixes = [];
    try {
      suffixes = loadConfig(root).verify.scope_globs.map((g) => g.replace(/^\*/, ''));
    } catch {
      /* keep it empty — traceWrite() then matches nothing, which is correct */
    }
    line = traceWrite(input, suffixes);
  } else if (/^Read$/.test(tool)) {
    line = traceRead(input);
  } else if (/^Bash$/.test(tool)) {
    let testName = '';
    try {
      testName = loadConfig(root).verify.test_name;
    } catch {
      /* keep it empty — traceTest() then declines to trace, see its own guard */
    }
    line = traceTest(input, res, testName);
  } else if (/^(Task|Agent)$/.test(tool)) {
    line = traceAgent(input, res, payload, missLog);
  }

  if (!line) return;

  // Attribution, and the single question it answers: a path read twice inside
  // one milestone is context churn if ONE session read it twice, and the
  // cold-start cost the session-reuse rule exists to avoid if two did. The
  // pair of lines is identical either way, so without this field the two
  // opposite findings are the same observation. `specflow-stats.mjs` reads it.
  //
  // Absent rather than empty when the payload names no session: an empty
  // field would read as "one session" and turn an unanswered question into a
  // measurement. Only a `k=v`-safe value is written at all — this log is read
  // back by a whitespace split.
  //
  // On an `agent type=` line the id belongs to the SPAWNER, not to the agent
  // being spawned: a payload carries the session that made the tool call.
  const id = [payload.session_id, payload.sessionId].find((v) => typeof v === 'string' && /^[\w-]+$/.test(v));

  appendFileSync(traceFile, `${new Date().toISOString()} phase=${phase}${id ? ` session=${id}` : ''} ${line}\n`);
});
