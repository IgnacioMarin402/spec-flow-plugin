#!/usr/bin/env node
/**
 * PreToolUse hook on Read|Write|Edit|MultiEdit|NotebookEdit|Bash — keeps the
 * orchestrator routing during a run (ADR-034).
 *
 * The orchestrator is the session running the command (ADR-029), and the
 * commands say it routes and never writes code. Nothing held it to that: it
 * moved a human's parked plan out of `specflow/` to get past a refusal, and
 * read the code a triage had just read — what the session reads stays in its
 * context for the rest of the run, paid again on every message (ADR-033).
 *
 * In the repository, during a run, the session may read `specflow/`,
 * `specs/`, `.spec-flow/`, `.claude/` and the root's `*.md`, and write only
 * `.claude/state/` and `specflow/`. Paths outside the repository are not this
 * hook's business. A subagent's call carries its `agent_id`; the session's
 * carries none — that is the whole test, so the hook arms only once the trace
 * shows this build attributes tool calls, and until then stands down and says
 * so in orchestrator-scope-unmatched.log. Bash is read for the commands that
 * write a path (mv, cp, rm, their git forms, tee, sed -i, a redirect): a
 * consistency guard like `no-gate-cmds`, not a security boundary.
 */
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { join, relative, resolve, isAbsolute, sep } from 'node:path';
import { projectDir, stateDir, readPhase, readPayload, run } from './lib/io.mjs';

const RUN_PHASES = ['spec', 'plan', 'review', 'implement', 'blocked'];
const WRITABLE = ['.claude/state/', 'specflow/'];
const READABLE = [...WRITABLE, 'specs/', '.spec-flow/', '.claude/'];

/** A path relative to the repository, with `/`, or null when it lies outside it. */
function inRepo(root, path) {
  const rel = relative(root, isAbsolute(path) ? path : resolve(root, path));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

const under = (rel, prefixes) => prefixes.some((p) => rel === p.replace(/\/$/, '') || rel.startsWith(p));
const readable = (rel) => under(rel, READABLE) || (!rel.includes('/') && rel.endsWith('.md'));

/** The paths a Bash command writes, moves or deletes, as far as its plain forms say. */
function bashWrites(cmd) {
  const command = cmd.split('<<')[0].replace(/"([^"]*)"|'([^']*)'/g, (_, a, b) => (a ?? b).replace(/\s/g, '\u0000'));
  const paths = [];
  for (const m of command.matchAll(/(?:^|[^0-9&>])>>?\s*([^\s&|;<>]+)/g)) paths.push(m[1]);
  for (const part of command.split(/&&|\|\||;|\|/)) {
    let t = part.trim().split(/\s+/).filter(Boolean);
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0] ?? '')) t = t.slice(1);
    if (t[0] === 'git' && ['mv', 'rm'].includes(t[1])) t = t.slice(1);
    const args = t.slice(1).filter((a) => !a.startsWith('-'));
    if (['mv', 'rm', 'rmdir', 'unlink', 'tee'].includes(t[0])) paths.push(...args);
    else if (t[0] === 'cp' && args.length) paths.push(args.at(-1));
    else if (t[0] === 'sed' && t.some((a) => /^-[a-zA-Z]*i/.test(a)) && args.length > 1) paths.push(args.at(-1));
  }
  return paths.map((p) => p.replace(/\u0000/g, ' ')).filter((p) => p && !p.startsWith('&') && p !== '/dev/null');
}

function deny(message) {
  process.stderr.write(`[spec-flow] Denied: ${message}\n`);
  process.exit(2); // PreToolUse denial protocol
}

await run(async () => {
  const root = projectDir();
  const phase = readPhase(root);
  if (!RUN_PHASES.includes(phase)) return;

  const payload = await readPayload();
  if (typeof payload.agent_id === 'string' && payload.agent_id) return; // a subagent: its role decides what it touches

  const traceFile = join(stateDir(root), 'run-trace.log');
  const trace = existsSync(traceFile) ? readFileSync(traceFile, 'utf8') : '';
  if (!/ (?:read|write) file=.* agent_id=[\w-]+$| test verdict=.* agent_id=[\w-]+$/m.test(trace)) {
    try {
      appendFileSync(join(stateDir(root), 'orchestrator-scope-unmatched.log'), `${new Date().toISOString()} phase=${phase} tool=${payload.tool_name} unattributed\n`);
    } catch {
      /* the log is how this blind spot is seen, never a reason to fail */
    }
    return;
  }

  const tool = String(payload.tool_name ?? '');
  const input = payload.tool_input ?? {};
  const route =
    'The agent whose job it is does it — the implementer writes code and tests for a milestone, the spec-writer writes `specs/` and `specflow/` — and a human edits the contract. ' +
    "If a human asked for this mid-run, it belongs to the milestone's implementer or to after the run; standing the run down is theirs to do, from their own terminal (ADR-034).";

  if (tool === 'Read') {
    const rel = inRepo(root, String(input.file_path ?? ''));
    if (rel === null || readable(rel)) return;
    deny(
      `the orchestrator reading ${rel} during a run. Every file this session reads stays in its context for the rest of the run and is paid again on each message it sends (ADR-033); the agent that needs the code reads it, and its context ends with it. ` +
        `Ask that agent, or read the gate's log under .claude/state/, which names the files and lines.`,
    );
  }

  const written =
    tool === 'Bash' ? bashWrites(String(input.command ?? '')) : [String(input.file_path ?? input.notebook_path ?? input.filePath ?? '')].filter(Boolean);
  const outside = written.map((p) => inRepo(root, p)).filter((rel) => rel !== null && !under(rel, WRITABLE));
  if (outside.length === 0) return;
  deny(`the orchestrator writing, moving or deleting ${[...new Set(outside)].join(', ')} during a run. This session routes: during a run it writes only .claude/state/ and specflow/. ${route}`);
});
