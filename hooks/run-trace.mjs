#!/usr/bin/env node
/**
 * PostToolUse hook on Write|Edit|Bash|Task|Agent — the run's observable
 * timeline.
 *
 * This hook enforces NOTHING. It exists because the flow's change policy
 * only accepts a failing run as grounds for changing the flow, and several of
 * its soft spots leave no trace anyone can read after the fact: a gate PASS
 * is silent, so a stalled run looks exactly like a finished one; the
 * implementer's test-first protocol lives in prose and the gate only ever
 * sees the final state; nobody knows whether the reviewer approves plans on
 * the merits or rubber-stamps them. Writing the evidence down is the
 * cheapest possible answer to all three.
 *
 * ALWAYS exits 0. A hook whose only job is to observe must never be able to
 * block, annotate or fail anything; if it cannot parse a payload it says so
 * in run-trace-unmatched.log (key names only, never content) and gets out of
 * the way.
 */
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectDir, stateDir, phasePath, readFileOrDefault, readPayload, run } from './lib/io.mjs';
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
  if (status) return `agent type=${type} status=${status[1]}`;

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
  // in a repo that never adopted the flow.
  const phase = readFileOrDefault(phasePath(root), '');
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
  appendFileSync(traceFile, `${new Date().toISOString()} phase=${phase} ${line}\n`);
});
