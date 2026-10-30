#!/usr/bin/env node
/**
 * PostToolUse hook on Write|Edit|Read|Bash, PostToolUseFailure on Bash, and
 * SubagentStop — the run's observable timeline.
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
import { projectDir, stateDir, readPhase, readPayload, run, stateIsTracked, PHASE_FILE_RE, PHASE_WRITE_RE, phaseWriteText } from './lib/io.mjs';
import { loadConfig } from '../scripts/spec-flow-config.mjs';
import { parseReturn } from '../scripts/agent-blocks.mjs';
import { handedBack } from './lib/handback.mjs';
import { toolAt } from '../scripts/argv.mjs';

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
 * Whether the runner is the program this command runs, rather than a word in
 * it: `npx vitest run x.test.ts` runs it, `grep vitest package.json` does not.
 * Wrappers and leading `VAR=value` assignments are skipped, and so is `node`
 * running the runner's own script by path (`toolAt`); a multi-word name
 * (`node --test`) needs its first word in program position and the rest after.
 */
function runsRunner(cmd, testName) {
  const words = testName.split(/\s+/);
  const tokens = cmd.trim().split(/\s+/);
  let i = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i] ?? '')) i++;
  if (/^(npx|pnpm|yarn|bunx)$/.test(tokens[i] ?? '') || (tokens[i] === 'npm' && tokens[i + 1] === 'exec')) {
    i += tokens[i] === 'npm' ? 2 : 1;
    if (/^(exec|dlx|run)$/.test(tokens[i] ?? '')) i++;
  }
  const program = (tokens[i] ?? '').replace(/^.*[\\/]/, '');
  if (program === words[0] && words.slice(1).every((w) => tokens.slice(i + 1).includes(w))) return true;
  return words.length === 1 && toolAt(tokens, i).name === testName;
}

/**
 * A scoped test run and whether it was red.
 *
 * The event is the exit status: a command that exits non-zero arrives as
 * PostToolUseFailure, with its output in `error` and no `tool_response`, and
 * only a zero exit arrives as PostToolUse. A failure is red only when it is
 * the runner itself, run on a path, that failed: not a command that merely
 * names the runner, not a runner the shell could not find, not a run that
 * found no tests or whose own summary says everything passed (a coverage
 * threshold, say). A red verdict is what credits a requirement with
 * test-first, so an unsure failure is `?`. A PostToolUse run is read from its
 * text, because a pipe can hide a failing exit.
 *
 * A `?` carries `why=`: what this hook was not given. `specflow-stats.mjs`
 * reports it as that, never as "no red run" — a run it could not read is
 * not a run that did not happen.
 */
function traceTest(input, res, testName, failure) {
  if (!testName) return ''; // no contract read -> no runner name to look for, trace nothing rather than guess one

  const raw = String(input.command ?? '')
    .split('<<')[0] // everything after a heredoc operator is data fed TO the command
    .replace(/\\\r?\n/g, ' '); // a `\` at a line's end continues the same command
  const cmd = raw.replace(/"[^"]*"|'[^']*'/g, ' '); // and a quoted message, e.g. a commit -m, is not the command either

  if (/^\s*git(\s|$)/.test(cmd)) return ''; // git never runs tests

  const runner = testName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const namesRunner = new RegExp(`(^|[^a-zA-Z-])${runner}([^a-zA-Z-]|$)`);
  if (!namesRunner.test(cmd)) return '';

  const out = failure
    ? failure.error
    : [res?.stdout, res?.stderr, typeof res === 'string' ? res : ''].filter((v) => typeof v === 'string').join('\n');

  // What the runner was handed, which stats credits test-first by: the paths
  // of the commands in a chain that run it, past any redirection. Another
  // command's paths — a lint of the same files, `>/dev/null` — ran no test.
  // A quoted word with no space in it is a path, often a Windows one; the
  // runner's own script and config carry its name, a test under it need not.
  const target =
    raw
      .replace(/"([^"\s]+)"|'([^'\s]+)'/g, ' $1$2 ')
      .replace(/"[^"]*"|'[^']*'/g, ' ')
      .replace(/\d*[<>]{1,2}&?\s*[^\s;|&<>]*/g, ' ')
      .split(/;|&&|\|\||\||&|\n/)
      .filter((part) => namesRunner.test(part))
      .flatMap((part) => part.replace(/[()`]/g, ' ').split(/\s+/))
      .filter((t) => !t.startsWith('-') && /[/.]/.test(t) && !t.split(/[\\/]/).pop().includes(testName) && !/^(pnpm|npm|npx|yarn|node)$/.test(t))
      .join(',') || '-';

  // `Tests:` is jest's summary, `Tests  N` vitest's; mocha and node's own
  // runner say no files were found, or could not find one. `Test Suites:` /
  // `Test Files` count a suite that failed before any test ran — the first red
  // of a test written ahead of its module, which reports `Tests: 0 total`.
  let verdict = '?';
  let why = '';
  if (/^\s*(Tests:?|Test Suites:|Test Files)\s.*\bfailed\b/m.test(out) || /✕/.test(out)) verdict = 'red';
  else if (/^\s*Tests:?\s.*\bpassed\b/m.test(out)) [verdict, why] = failure ? ['?', 'summary-passed'] : ['green', ''];
  else if (/\bNo tests? (files )?found\b/i.test(out) || /^Could not find '/m.test(out)) verdict = 'none';
  else if (!failure) why = /(^|[^|])\|([^|]|$)/.test(cmd) ? 'pipe' : 'no-summary'; // a pipe's exit is its last command's
  else if (failure.interrupted) why = 'interrupted';
  else if (/Exit code 12[67]\b|command not found|is not recognized as/.test(out)) why = 'not-found';
  else if (target === '-') why = 'no-path';
  else if (!runsRunner(cmd, testName)) why = 'not-the-runner';
  else verdict = 'red';

  return `test verdict=${verdict} target=${target}${why ? ` why=${why}` : ''}`;
}

/**
 * Whether this agent's return is already on a line — see traceReturn().
 * Return lines only: the agent's own reads and writes carry its id too.
 */
function alreadyTraced(traceFile, agentId) {
  try {
    return new RegExp(` agent type=.* agent_id=${agentId}(\\s|$)`, 'm').test(readFileSync(traceFile, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * What a subagent returned — for the reviewer, that IS the open question.
 *
 * Read at SubagentStop, never off the spawn's tool response: that response
 * echoes the PROMPT ahead of the report, and the orchestrator's prompts name
 * the statuses they expect back, so the first `STATUS:` in it is the question
 * rather than the answer. A background spawn's response is a launch receipt.
 *
 * One line per agent, at its FIRST stop: a session resumed by SendMessage
 * stops again under the same id, and `specflow-stats.mjs` reads every
 * `agent type=` line as a fresh spawn.
 */
async function traceReturn(payload, traceFile, missLog) {
  const type = String(payload.agent_type ?? '?').replace(/\s+/g, '-');
  const agentId = typeof payload.agent_id === 'string' && /^[\w-]+$/.test(payload.agent_id) ? payload.agent_id : '';
  if (agentId && alreadyTraced(traceFile, agentId)) return '';

  const text = await handedBack(payload);
  // The agent gate reads the same status through the same function.
  const status = parseReturn(text)?.status;
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
    // The effort the agent actually ran at, once per agent: the payload's
    // `effort.level` is what was applied after the frontmatter, a spawn's own
    // effort and CLAUDE_CODE_EFFORT_LEVEL had their say.
    const level = typeof payload.effort?.level === 'string' && /^[a-z]+$/.test(payload.effort.level) ? payload.effort.level : '';
    return `agent type=${type} status=${status}${missField}${level ? ` effort=${level}` : ''}${agentId ? ` agent_id=${agentId}` : ''}`;
  }

  appendUnique(
    missLog,
    JSON.stringify({
      payload_keys: Object.keys(payload).sort(),
      report: text ? 'no STATUS line' : 'empty',
    }),
  );
  return '';
}

/**
 * Whether this call wrote the phase file: a Write or Edit of it, or a redirect
 * or `tee` into it, the path quoted or not. A command that only reads it, or
 * writes somewhere else first, did not.
 */
function wrotePhase(tool, input) {
  if (/^(Write|Edit|MultiEdit)$/.test(tool)) return PHASE_FILE_RE.test(String(input.file_path ?? input.filePath ?? ''));
  return tool === 'Bash' && PHASE_WRITE_RE.test(phaseWriteText(String(input.command ?? '')).text);
}

await run(async () => {
  const root = projectDir();
  // Phase first, through a path that creates nothing: this hook fires on
  // almost every tool call, and standing down must leave no directory behind
  // in a repo that never adopted the flow. `readPhase` adds the repo that
  // committed one, which never started a run to trace (ADR-017).
  const phase = readPhase(root);
  if (['', 'idle'].includes(phase)) return;

  const payload = await readPayload();
  const tool = String(payload.tool_name ?? payload.toolName ?? '');
  const input = payload.tool_input ?? payload.toolInput ?? {};
  const res = payload.tool_response ?? payload.tool_result ?? payload.tool_output ?? payload.response ?? {};

  // `done` stands down too, but for the call that wrote it: the closing turn
  // is the run's last, its line is what follows the fold's PASS, and
  // token-trace charges that turn by it (ADR-043). Not into a `.claude/state/`
  // the repository committed: its log may link out of it (ADR-040).
  if (phase === 'done' && (!wrotePhase(tool, input) || stateIsTracked(root))) return;

  const state = stateDir(root);
  const traceFile = join(state, 'run-trace.log');
  const missLog = join(state, 'run-trace-unmatched.log');

  let line = '';
  if (phase === 'done') {
    line = `closed tool=${tool}`;
  } else if (payload.hook_event_name === 'SubagentStop') {
    line = await traceReturn(payload, traceFile, missLog);
  } else if (/^(Write|Edit|MultiEdit)$/.test(tool)) {
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
    const failure =
      payload.hook_event_name === 'PostToolUseFailure'
        ? { error: typeof payload.error === 'string' ? payload.error : '', interrupted: payload.is_interrupt === true }
        : null;
    line = traceTest(input, res, testName, failure);
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
  // On an `agent type=` line the id belongs to the SPAWNER: a SubagentStop
  // payload carries the session the agent was spawned from, and the agent
  // itself is `agent_id=`.
  const id = [payload.session_id, payload.sessionId].find((v) => typeof v === 'string' && /^[\w-]+$/.test(v));

  // Which agent made the call. A tool call inside a subagent carries the
  // PARENT's session id and the agent's own `agent_id`, so without this every
  // agent's reads land under the orchestrator and no split by session can see
  // a fresh one. Absent in the main session. A return line has it already.
  const agentId = typeof payload.agent_id === 'string' && /^[\w-]+$/.test(payload.agent_id) ? payload.agent_id : '';
  const byAgent = agentId && !line.startsWith('agent type=') ? ` agent_id=${agentId}` : '';

  appendFileSync(traceFile, `${new Date().toISOString()} phase=${phase}${id ? ` session=${id}` : ''} ${line}${byAgent}\n`);
});
