#!/usr/bin/env node
/**
 * SubagentStop hook — holds a spec-flow agent's return to its own contract
 * before the orchestrator acts on it (ADR-031).
 *
 * A first reply with no return block, a status the contract does not declare,
 * or a `*_PATH` naming a file that is not there reaches the orchestrator as
 * something no step of the command routes. Blocking makes the agent continue
 * with the reason, and its caller receives the corrected return. A
 * spec-writer's return is also held to ADR-030; see specWriterProblems().
 *
 * Narrow on purpose, because it blocks:
 *   - only `spec-flow:<name>` for an agent this plugin ships, during a run;
 *   - at most MAX_BLOCKS blocks per agent, counted from its own `agent-check`
 *     lines in run-trace.log; with no agent id, only a first stop is blocked;
 *   - a missing `STATUS:` only at an agent's first stop or after a block: a
 *     resumed agent (SendMessage) answers in prose, as the commands ask;
 *   - anything it cannot read passes — an empty reply included, recorded as
 *     a skip — and a crash exits 0.
 *
 * run-trace records the return, at the agent's FIRST stop. A return this
 * blocks and the agent then changes stays recorded as the first one; the
 * `agent-check` line says it was blocked.
 */
import { readdirSync, readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join, dirname, isAbsolute, resolve, relative, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectDir, stateDir, readPhase, readPayload, run } from './lib/io.mjs';
import { handedBack } from './lib/handback.mjs';
import { declaredStatuses, parseReturn, openQuestions, MAX_OPEN_QUESTIONS } from '../scripts/agent-blocks.mjs';
import { deltas, declaredIds, capabilityOf } from '../scripts/spec-shape.mjs';
import { specTimeProblems } from '../scripts/spec-time.mjs';
import { loadConfig } from '../scripts/spec-flow-config.mjs';

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

/**
 * The path a `*_PATH` value names: a markdown link's target, else its first
 * token, with backticks, quotes and emphasis stripped — `**a/b.md** (index)`
 * is `a/b.md`.
 */
function pathIn(raw) {
  const target = /\]\(([^)\s]+)\)/.exec(raw)?.[1] ?? raw;
  return target.replace(/[`'"*]/g, '').trim().split(/\s+/)[0] ?? '';
}

/** Why this return cannot be acted on, or null when it can. */
function problemWith(ret, statuses, root) {
  if (!statuses.includes(ret.status)) {
    return { why: 'undeclared-status', reason: `\`STATUS: ${ret.status}\` is not a status your contract declares (${statuses.join(', ')}), and the orchestrator routes only those. Return the one that fits.` };
  }
  for (const [key, raw] of Object.entries(ret.fields)) {
    if (!key.endsWith('_PATH') || !raw) continue;
    const path = pathIn(raw);
    if (!existsSync(isAbsolute(path) ? path : join(root, path))) {
      return { why: 'missing-path', reason: `\`${key}: ${raw}\` — there is no file at \`${path}\`. Write it, or return the path you wrote.` };
    }
  }
  return null;
}

/** A path as a comparable key: Windows paths compare without case or slash style. */
function samePath(root, path) {
  const full = resolve(root, path);
  return process.platform === 'win32' ? full.toLowerCase() : full;
}

/**
 * What a spec-writer's return must also satisfy (ADR-030): a round asks one
 * to MAX_OPEN_QUESTIONS questions, and a spec it hands back is live, passes
 * its spec-time checks, changes or removes only ids `specs/` declares, and —
 * for SPEC_READY — was written after reading `specs/README.md` and every
 * capability spec its deltas touch. The read check sees the Read tool only.
 *
 * `skips` name what could not be judged: no contract, or a trace whose reads
 * carry no agent id.
 */
function specWriterProblems(ret, text, root, agentId, trace) {
  const problems = [];
  const skips = [];
  if (ret.status === 'NEEDS_INPUT') {
    const n = openQuestions(text);
    if (n === 0) problems.push({ why: 'no-questions', reason: '`STATUS: NEEDS_INPUT` with no question under `OPEN_QUESTIONS:` gives the human nothing to answer. List the questions, or write the spec.' });
    if (n > MAX_OPEN_QUESTIONS) {
      problems.push({
        why: 'too-many-questions',
        reason: `You asked ${n} questions; a round asks at most ${MAX_OPEN_QUESTIONS}. Keep the ${MAX_OPEN_QUESTIONS} whose answers would change the deltas most. Decide the rest and record each in the spec's \`## Assumptions\`, or ask it next round.`,
      });
    }
    return { problems, skips };
  }
  if (!['SPEC_READY', 'TRIAGED'].includes(ret.status)) return { problems, skips };
  // Case 5 is not a fix: the orchestrator stamps the brief REJECTED and
  // archives it, so nothing builds from it.
  if (ret.status === 'TRIAGED' && /^\W*5\b/.test(ret.fields.CASE ?? '')) return { problems, skips };

  // A fix has no planner, and the triage is the one who read the code: it
  // writes the work order, or the orchestrator would read that code again
  // and carry it for the rest of the run (ADR-033). That the files exist is
  // `problemWith`'s `*_PATH` check; that they are named is this one.
  const unnamed = ret.status === 'TRIAGED' ? ['PLAN_PATH', 'WORK_ORDER_PATH'].filter((k) => !ret.fields[k]) : [];
  if (unnamed.length > 0) {
    problems.push({
      why: 'no-work-order',
      reason: `A triage of case 1 to 4 writes the work order the implementer builds from — \`specflow/<SLUG>/plan.md\` and \`specflow/<SLUG>/milestones/M1.md\` — and returns ${unnamed.map((k) => `\`${k}:\``).join(' and ')} naming it. Write it, and return the line${unnamed.length > 1 ? 's' : ''}.`,
    });
    return { problems, skips };
  }

  const raw = pathIn(ret.fields.SPEC_PATH ?? '');
  const slug = /^specflow\/([^/]+)\/spec\.md$/.exec(relative(root, resolve(root, raw)).split(sep).join('/'))?.[1];
  if (!slug || slug === 'archive') {
    problems.push({ why: 'not-live', reason: `\`SPEC_PATH: ${raw}\` is not a live change spec. It names \`specflow/<SLUG>/spec.md\`, outside \`specflow/archive/\`.` });
    return { problems, skips };
  }

  const shape = specTimeProblems(root, [slug]);
  if (shape.length > 0) problems.push({ why: 'spec-shape', reason: `The spec is not ready to build from:\n${shape.map((p) => `- ${p}`).join('\n')}` });

  let config;
  try {
    config = loadConfig(root);
  } catch {
    skips.push('no-contract');
    return { problems, skips };
  }
  const specsDir = join(root, config.trace.specs_dir);
  const notCapability = new Set(config.trace.not_a_capability);
  const specs = existsSync(specsDir)
    ? readdirSync(specsDir, { recursive: true })
        .map(String)
        .filter((f) => f.endsWith('.md') && !notCapability.has(basename(f)))
        .map((f) => ({ file: join(specsDir, f), ids: declaredIds(readFileSync(join(specsDir, f), 'utf8')) }))
    : [];
  const own = [...deltas(readFileSync(join(root, 'specflow', slug, 'spec.md'), 'utf8'))];

  const unknown = own.filter((d) => d.verb !== 'ADDED' && !specs.some((s) => s.ids.has(d.id)));
  if (unknown.length > 0) {
    problems.push({
      why: 'unknown-id',
      reason: `${unknown.map((d) => `\`${d.verb} ${d.id}\``).join(', ')} name no requirement declared under ${config.trace.specs_dir}/. A CHANGED or REMOVED id must already exist there: use the id it declares, or make it an ADDED.`,
    });
  }

  if (ret.status !== 'SPEC_READY') return { problems, skips };
  const expected = new Set(own.map((d) => capabilityOf(d.id, specs)).filter(Boolean));
  if (existsSync(join(specsDir, 'README.md'))) expected.add(join(specsDir, 'README.md'));
  if (expected.size === 0) return { problems, skips };

  // Attribution exists when some tool call in this trace was recorded with
  // an agent id; without it, no read can be told from a missing one. Tool
  // calls only: token-trace takes its ids from transcript file names, so its
  // lines carry one whatever the tool payloads did.
  const lines = trace.split('\n');
  const attributed = lines.some((l) => / (?:read|write) file=.* agent_id=[\w-]+$| test verdict=.* agent_id=[\w-]+$/.test(l));
  if (!agentId || !attributed) {
    skips.push('unattributed');
    return { problems, skips };
  }
  const read = new Set(
    lines
      .filter((l) => l.endsWith(` agent_id=${agentId}`))
      .map((l) => / read file=(.*) agent_id=/.exec(l)?.[1])
      .filter(Boolean)
      .map((f) => samePath(root, f)),
  );
  const unread = [...expected].filter((f) => !read.has(samePath(root, f))).map((f) => relative(root, f).split(sep).join('/'));
  if (unread.length > 0) {
    problems.push({
      why: 'unread',
      reason: `You wrote this spec without reading ${unread.join(', ')} in this run. Read them — the contract, and the requirements your deltas add to or change — and check the deltas against them. (This check sees the Read tool only.)`,
    });
  }
  return { problems, skips };
}

await run(async () => {
  const root = projectDir();
  const payload = await readPayload();
  const type = String(payload.agent_type ?? '');
  const name = /^spec-flow:([a-z][a-z-]*)$/.exec(type)?.[1];
  if (!name) return;
  // `readPhase`, not the owner check: ADR-017 keeps that to hooks certain to
  // run in the session that sealed the phase.
  const session = String(payload.session_id ?? '');
  const phase = readPhase(root);
  if (!RUN_PHASES.includes(phase)) return;

  const statuses = contractStatuses(name);
  if (statuses.length === 0) return;

  const agentId = typeof payload.agent_id === 'string' && /^[\w-]+$/.test(payload.agent_id) ? payload.agent_id : '';
  const traceFile = join(stateDir(root), 'run-trace.log');
  const trace = existsSync(traceFile) ? readFileSync(traceFile, 'utf8') : '';

  const text = handedBack(payload);
  const ret = parseReturn(text);
  let problems = [];
  let skips = [];
  if (!ret) {
    // A reply with no status is judged only where a return is owed: at an
    // agent's first stop, or after a block. Once run-trace holds a return
    // for this id, the agent is answering a SendMessage, in prose.
    const returned = agentId && new RegExp(` agent type=\\S+ status=\\S+.* agent_id=${agentId}(\\s|$)`).test(trace);
    const owed = payload.stop_hook_active === true || (agentId && !returned);
    if (!text.trim()) skips.push('empty');
    else if (owed) {
      problems.push({
        why: 'no-status',
        reason: `Your reply has no line opening with \`STATUS:\`, so the orchestrator has nothing to route. End with the return block your contract declares: ${statuses.map((s) => `STATUS: ${s}`).join(', ')}.`,
      });
    }
  } else {
    const found = problemWith(ret, statuses, root);
    if (found) problems.push(found);
    else if (name === 'spec-writer') ({ problems, skips } = specWriterProblems(ret, text, root, agentId, trace));
  }

  // `agent=`, not run-trace's `type=`: stats reads a `type=` line with an
  // agent id as that agent's return.
  const record = (result, why) =>
    appendFileSync(
      traceFile,
      `${new Date().toISOString()} phase=${phase}${/^[\w-]+$/.test(session) ? ` session=${session}` : ''} agent-check agent=${type} result=${result} why=${why}${agentId ? ` agent_id=${agentId}` : ''}\n`,
    );

  if (problems.length === 0) {
    if (skips.length > 0) record('skip', skips.join(','));
    return;
  }

  let blocks = 0;
  if (agentId) {
    const mine = new RegExp(` agent-check .*result=block .*agent_id=${agentId}(\\s|$)`);
    blocks = trace.split('\n').filter((l) => mine.test(l)).length;
  } else if (payload.stop_hook_active === true) {
    blocks = MAX_BLOCKS;
  }
  const result = blocks >= MAX_BLOCKS ? 'cap' : 'block';
  record(result, problems.map((p) => p.why).join(','));
  if (result === 'block') {
    process.stdout.write(JSON.stringify({ decision: 'block', reason: `[spec-flow] ${problems.map((p) => p.reason).join('\n\n')}` }));
  }
});
