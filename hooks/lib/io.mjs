#!/usr/bin/env node
/**
 * I/O primitives shared by every hook. Deliberately thin: nothing here reads
 * the contract, so a missing or malformed .spec-flow/config.json cannot break
 * any of it. The "one complete fallback" rule lives in spec-flow-config.mjs
 * alone (see its own header) — these helpers exist one layer below that, and
 * a hook that cannot even read stdin has a different problem than a hook that
 * disagrees with the repo about which linter to run.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * The repo this hook is running against — never the plugin's own location.
 * `import.meta.url` answers "where am I", which is the right question for
 * finding a sibling module and the wrong one for finding the project: once
 * this code ships inside an installed plugin, its own location and the
 * consuming repo's root are different directories, so resolving the project
 * from a script's own location silently reads the PLUGIN's files and writes
 * the PLUGIN's state.
 */
export function projectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

/**
 * The state directory, CREATED. Call it when the hook already knows it is
 * going to write — never merely to compute a path, or the plugin litters
 * `.claude/state/` into every repo the user opens, including ones that never
 * adopted spec-flow.
 */
export function stateDir(root = projectDir()) {
  const dir = join(root, '.claude', 'state');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * The phase file's path, WITHOUT creating anything.
 *
 * Almost every hook here reads the phase first and then decides it has
 * nothing to do. Routing that read through `stateDir` made the decision to
 * stand down leave a directory behind anyway — on every Stop, every write,
 * every subagent spawn, in every repository. A hook that is transparent
 * should be transparent on disk too.
 */
export function phasePath(root = projectDir()) {
  return join(root, '.claude', 'state', 'phase');
}

/** Where the session driving the current phase is recorded. Creates nothing, like `phasePath`. */
export function phaseOwnerPath(root = projectDir()) {
  return join(root, '.claude', 'state', 'phase.session');
}

/**
 * The phases that ARM something. Everything else — `idle`, `done`, an empty
 * file, a value no hook recognises — stands every hook down on its own, so
 * `readPhase` answers those without spawning anything.
 */
const ARMING = new Set(['spec', 'plan', 'review', 'implement', 'blocked']);

/** The path as git spells it, for a pathspec: `join` would use `\` on Windows. */
const PHASE_PATHSPEC = '.claude/state/phase';

/**
 * Whether the repo COMMITTED its phase file.
 *
 * Non-zero — no git, not a repo, not tracked — all mean "not tracked", which
 * arms. That direction is deliberate: this answer decides whether hooks run,
 * and a git that could not be asked must never be the reason one stands down.
 */
function phaseIsTracked(root) {
  const res = spawnSync('git', ['ls-files', '--error-unmatch', '--', PHASE_PATHSPEC], {
    cwd: root,
    encoding: 'utf8',
  });
  return res.status === 0;
}

/**
 * The phase this REPOSITORY is in, if a run put it there — `''` otherwise.
 *
 * Every hook that arms reads the phase through here rather than through
 * `readFileOrDefault(phasePath(...))`, because one thing other than the value
 * decides whether it counts, and it was previously invisible: see ADR-017.
 *
 * **A phase git tracks is not state, it is content.** Nothing in this engine
 * ever commits that file; a repo that ships one is handing every session that
 * opens it a gate armed on arrival, and the gate spawns the argv named in that
 * same repo's `.spec-flow/config.json` when a turn ends. Verified before the
 * fix: a clone with `implement` committed ran both declared commands on the
 * first Stop, with nothing typed. `session-start` does not rescue it either —
 * a fresh checkout's mtime is seconds old, so the staleness reset never fires.
 *
 * Fails CLOSED, and that is the property to preserve in any edit here: a git
 * that could not be asked leaves the phase honoured. A hook that stood down
 * because it was unsure would be this engine's own signature failure.
 */
export function readPhase(root = projectDir()) {
  const phase = readFileOrDefault(phasePath(root), '');
  if (!ARMING.has(phase)) return phase;
  return phaseIsTracked(root) ? '' : phase;
}

/**
 * The same, narrowed to a phase THIS session owns.
 *
 * `sessionId` comes from the hook payload; `phaseOwnerPath` holds whoever last
 * drove a phase write past `phase-guard`. Two Claude Code sessions in one repo
 * — an IDE one and a terminal one — otherwise share the phase file, so the
 * second arms the first's gate, spends its Opus budget and moves the attempt
 * counter that decides when a human is called.
 *
 * **Two hooks call this, and the rest deliberately do not.** A hook only gets
 * the owner check when it is certain to fire in the session that SEALED the
 * phase: `gate.mjs` on `Stop`, which fires for the orchestrating turn, and
 * `opus-budget.mjs` on a subagent spawn, which only an orchestrator performs.
 *
 * The others fire inside subagents too — `lint-on-write` runs on the
 * implementer's every write — and whether a subagent's payload carries its
 * parent's `session_id` is the harness's business, undocumented and free to
 * change. If it ever does not, an owner check there stands the write-time
 * linter down on every write of every milestone, silently. That is a worse
 * failure than the one being fixed, and it would be reached by an assumption
 * rather than by a decision. So the narrow rule is not caution about today's
 * behaviour; it is a refusal to depend on it. See ADR-017.
 *
 * Fails CLOSED like `readPhase`: no seal, or no session id in the payload,
 * leaves the phase honoured. Only a seal naming a different, known session
 * stands a hook down.
 */
export function readOwnedPhase(root = projectDir(), sessionId = '') {
  const phase = readPhase(root);
  if (!ARMING.has(phase)) return phase;
  const owner = readFileOrDefault(phaseOwnerPath(root), '');
  return owner && sessionId && owner !== sessionId ? '' : phase;
}

/**
 * Records this session as the one driving the phase.
 *
 * Called where a phase write is OBSERVED — `phase-guard` sees the model's
 * writes, `arm-gate` performs its own — because that is the only moment the
 * engine can tell who is driving. A payload with no `session_id` claims
 * nothing rather than writing an empty seal: an empty one reads as "unowned"
 * to `readPhase`, which is the fail-closed answer already.
 */
export function claimPhase(root, sessionId) {
  if (!sessionId) return;
  stateDir(root);
  writeFile(phaseOwnerPath(root), String(sessionId));
}

/** Drops the seal, so the next session to drive a phase may claim it. */
export function releasePhase(root) {
  try {
    rmSync(phaseOwnerPath(root), { force: true });
  } catch {
    /* best-effort, like every writer here */
  }
}

/**
 * Every hook receives its payload on stdin. A hook that cannot read it, or
 * gets something that is not JSON, degrades to `{}` — the same fail-open
 * default the bash form used (`cat 2>/dev/null || echo '{}'`).
 */
export async function readPayload() {
  let raw = '';
  try {
    for await (const chunk of process.stdin) raw += chunk;
  } catch {
    return {};
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function readFileOrDefault(path, fallback = '') {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8').trim() : fallback;
  } catch {
    return fallback;
  }
}

export function writeFile(path, content) {
  try {
    writeFileSync(path, content);
  } catch {
    /* best-effort, like every hook here writes its own state */
  }
}

export function appendLine(path, line) {
  try {
    appendFileSync(path, `${line}\n`);
  } catch {
    /* logging must never be why a hook fails */
  }
}

export function readLinesDeduped(path) {
  try {
    return new Set(readFileSync(path, 'utf8').split('\n').filter(Boolean));
  } catch {
    return new Set();
  }
}

/**
 * A Stop or PreToolUse hook expresses "block" this way — JSON on stdout,
 * process exit 0. Exiting non-zero is not a stricter block, it is no block at
 * all: the tool call or the stop proceeds. Every hook that can deny something
 * calls this instead of `process.exit(2)` with a message, except the ones
 * whose protocol IS stderr + exit 2 (PreToolUse denials use that form; Stop
 * hooks use this one) — each hook below says which.
 *
 * On a Stop hook this is also the ONLY channel verified to reach a human in
 * an interactive session — see `emitNotice` below and ADR-010. `gate.mjs`
 * uses this for a milestone's first pass for exactly that reason, not only
 * for failures.
 */
export function emitBlock(reason) {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
}

/**
 * Say something to the human without a `decision` field, so a Stop hook
 * still allows the stop and the model is not re-invoked.
 *
 * Where this renders is NOT uniform, and that took a real regression to find
 * (ADR-010): a headless `claude -p` session records this `systemMessage` in
 * its transcript every time, but an interactive session (`claude`, the
 * desktop app) was observed discarding it across three consecutive gate
 * passes with zero exceptions in every transcript checked on the machine
 * this was diagnosed on — while a `PostToolUse` notice in that SAME session
 * rendered fine, so the loss is specific to a `systemMessage` off a `Stop`
 * hook, not to notices in general. Do not reach for this as "the way to
 * reach a human without spending a turn" — for a Stop hook, on the surface
 * this engine actually runs on, it usually is not one. `emitBlock` is what
 * reaches a human in that session type; this exists for the cases that
 * deliberately want silence-if-lost, such as a repeat notice `gate.mjs`
 * already reported once through `emitBlock`.
 *
 * Fail-open like the rest of this file's writers: a notice that cannot be
 * printed must never be why a hook stops working.
 */
export function emitNotice(message) {
  try {
    process.stdout.write(JSON.stringify({ systemMessage: message }));
  } catch {
    /* a hook's voice is not a hook's job */
  }
}

/**
 * Every hook's entrypoint is wrapped in this. An uncaught exception in a Stop
 * hook is indistinguishable from "everything passed" to whoever is waiting on
 * the process: no JSON on stdout, and a non-zero exit does not block a stop —
 * it merely fails to say anything. That is the exact silent-disarm failure
 * this whole engine exists to close, one level down in the hook's own code
 * instead of in the contract it reads. `onError` lets a hook say something
 * appropriate for ITS protocol instead of one generic message for all ten.
 */
export async function run(main, onError) {
  try {
    await main();
    process.exit(0);
  } catch (err) {
    if (onError) {
      try {
        onError(err);
      } catch {
        /* the error handler itself must not be why this hook goes silent */
      }
    } else {
      process.stderr.write(`[spec-flow] hook error: ${err?.stack || err}\n`);
    }
    process.exit(0); // hooks fail open; onError already said what it needed to
  }
}
