#!/usr/bin/env node
/**
 * PreToolUse hook on Bash|Write|Edit — guards every write to
 * `.claude/state/phase`.
 *
 * That file is the spine: every enforcement hook decides whether it is armed
 * by matching it against a CLOSED SET of values, and each falls through to
 * "not my business" on a value it does not recognise. So a phase nobody
 * defined — `triage`, `fix`, `verify` — stands down the gate, the write-time
 * linter, the whole-repo command deny, `preflight` and the Opus budget **all
 * at once**, silently. Code written with the gate off looks exactly like code
 * that passed it.
 *
 * One question — is this transition legitimate? — asked of three kinds of
 * write:
 *
 *   1. A value outside the vocabulary is denied before it disarms anything.
 *   2. `blocked` is the gate's own hand-off to a human, written by the gate
 *      at its cap; a tool writing it is denied.
 *   3. A write that ENDS a run is decided from evidence on disk, never from
 *      the value (ADR-022). `done` needs every unscoped check green, no live
 *      `specflow/<SLUG>/`, and a gate pass on the current commit. `idle` is
 *      never a step from `implement`, needs the change recorded first from
 *      `spec`/`plan`/`review`, and is free from `blocked`, where a human is
 *      already in the loop.
 *   4. A write that STARTS a run — a run phase while no run is in progress —
 *      is refused where this engine cannot run: not a repository root, no
 *      contract that loads, no base that resolves (ADR-028). Nothing is armed
 *      then, so a refused start leaves nothing for `session-start` to reset
 *      and denies no later spawn in that repository.
 *
 * **Recognising the value is deliberately narrow, because this hook DENIES.**
 * A `Write`/`Edit` carries the value as its body and a Bash `printf`/`echo`
 * redirect carries it as an argument: both exact. Anything that merely
 * mentions the file — `cat`, a grep, a path in an unrelated string — is
 * ALLOWED, because a guard that cannot see the value has nothing to guard and
 * denying on a guess blocks legitimate work.
 *
 * Outside a run it acts on two writes only: `blocked`, which is the gate's
 * alone wherever it is written, and the one that would start a run (4). An
 * unreadable contract refuses that start loudly and leaves the `done` check
 * quiet, because refusing an unearned `done` is that check's job and policing
 * the contract is the gate's. A consistency guard, not a security boundary.
 */
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { projectDir, stateDir, readPhase, claimPhase, readPayload, readLinesDeduped, readFileOrDefault, appendLine, run } from './lib/io.mjs';
import { loadConfig } from '../scripts/spec-flow-config.mjs';
import { runUnscopedChecks } from '../scripts/unscoped-checks.mjs';
import { assertCanRun } from './lib/can-run.mjs';

/** Change folders under `specflow/` that were never stamped and archived. */
function liveChanges(root) {
  const dir = join(root, 'specflow');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((e) => e !== 'archive' && statSync(join(dir, e)).isDirectory());
}

/**
 * Whether a gate has passed the current commit: true, false, or null when git
 * cannot say. The same short sha and the same `result=pass` test the gate uses
 * to decide a commit was already judged, so the two cannot disagree about
 * what a pass for this commit is.
 */
function gatePassedHead(root) {
  const res = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' });
  if (res.status !== 0) return null;
  const sha = res.stdout.trim();
  return readFileOrDefault(join(stateDir(root), 'gate-history.log'), '')
    .split('\n')
    .some((l) => l.split(' ')[1] === sha && / result=pass /.test(l));
}

function deny(message) {
  process.stderr.write(`[spec-flow] Denied: ${message}\n`);
  process.exit(2); // PreToolUse denial protocol
}

/**
 * The whole vocabulary. Kept here as the one executable copy — the tables in
 * README, REFERENCE and both commands describe it, and descriptions drift.
 */
const PHASES = ['spec', 'plan', 'review', 'implement', 'blocked', 'done', 'idle'];

/** The phases a run is IN — the ones that arm a hook. */
const RUN_PHASES = ['spec', 'plan', 'review', 'implement', 'blocked'];

/** The phases a tool may write to START a run; `blocked` is the gate's alone. */
const STARTS_A_RUN = ['spec', 'plan', 'review', 'implement'];

// Anchored past the name: `phase.session` and `phase-guard-unmatched.log` sit
// beside the phase file, and a write to either is not a phase write.
const PHASE_FILE_RE = /\.claude[\\/]state[\\/]phase(?![\w.-])/;

/**
 * The value a Bash command writes into the phase file, or null when this
 * command cannot be read as a write of a specific value.
 *
 * Requires all three: a redirect into the phase file, a `printf`/`echo`
 * producing it, and a single readable argument. Anything looser starts
 * guessing, and this hook denies.
 */
function bashWrittenValue(cmd) {
  if (!PHASE_FILE_RE.test(cmd)) return null;
  if (!/>>?\s*['"]?[^'"\s]*\.claude[\\/]state[\\/]phase(?![\w.-])/.test(cmd)) return null;

  const source = cmd.split('>')[0];
  const producer = /(?:^|[;&|]|\s)(printf|echo)\s+(.*)$/.exec(source);
  if (!producer) return null;

  const args = producer[2]
    .trim()
    .split(/\s+/)
    .filter((a) => !a.startsWith('-')) // `echo -n`, `printf --`
    .map((a) => a.replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);

  // `printf '%s' implement` and friends: a format string is not the value.
  const values = args.filter((a) => !/%/.test(a));
  return values.length === 1 ? values[0] : null;
}

/**
 * Records that a write got past unread, one line per distinct program.
 *
 * The matcher above is narrow because this hook DENIES, so `tee`, `cp`,
 * `sh -c` and a variable all go through. That is the right trade and it leaves
 * the hook unable to see its own blind spot; this is the half that IS
 * available — the same shape `opus-budget` and `lint-on-write` use for what
 * they let past, and for the same reason: failing open is fine, failing open
 * silently is not.
 *
 * Narrower than the matcher on purpose. A command that merely READS the file
 * got past nothing, and a log that fills with `cat` is one nobody opens — so a
 * redirect or a pipe is required as the structural evidence that something was
 * WRITING. A writer taking the path as a positional argument (`cp x <phase>`)
 * still leaves no line, and that gap is what keeps the log worth opening.
 *
 * The program only, never the arguments: this file has no business copying a
 * command's content into a log.
 */
function recordUnreadableWrite(root, cmd) {
  try {
    const redirects = />>?\s*['"]?[^'"\s]*\.claude[\\/]state[\\/]phase(?![\w.-])/.test(cmd);

    // The pipeline SEGMENT that names the file is the one touching it; in
    // `printf x | tee <phase>` the command's own first token is the producer,
    // which is not what got past.
    const segments = cmd.split('|');
    const at = segments.findIndex((s) => PHASE_FILE_RE.test(s));

    // Something must be flowing INTO the file. A redirect says so outright; a
    // pipe says so only when the file is downstream of it, since
    // `cat <phase> | grep x` is a read that happens to contain a pipe.
    if (!redirects && at < 1) return;

    const program = (segments[at === -1 ? 0 : at].trim().split(/\s+/)[0] ?? '').replace(/^.*[\\/]/, '');
    if (!program) return;

    const path = join(stateDir(root), 'phase-guard-unmatched.log');
    if (!readLinesDeduped(path).has(program)) appendLine(path, program);
  } catch {
    /* logging must never be why this hook fails */
  }
}

await run(async () => {
  const root = projectDir();
  const payload = await readPayload();

  // `readPhase`, never `readOwnedPhase` — this is the hook that ASSIGNS
  // ownership (ADR-017). Reading a foreign session's phase as absent here would
  // stand it down on exactly the write that transfers the phase to this
  // session: the write would go through unguarded, and the seal would keep
  // naming a session that no longer decides anything. The tracked half still
  // applies, because the `done` check below runs the repo's own unscoped checks.
  const phase = readPhase(root);
  const inRun = RUN_PHASES.includes(phase); // idle/done/unknown/committed -> no run

  const input = payload.tool_input ?? {};

  let written = null;
  if (String(payload.tool_name ?? '') === 'Bash') {
    const cmd = String(input.command ?? '');
    written = bashWrittenValue(cmd);
    // In or out of a run: a command writing into `.claude/state/phase` creates
    // that directory itself, so recording it there leaves nothing behind that
    // the command did not — and a start this hook could not read is the one
    // `preflight` has to catch, which is worth a line saying so.
    if (!written && PHASE_FILE_RE.test(cmd)) recordUnreadableWrite(root, cmd);
  } else {
    const filePath = String(input.file_path ?? input.filePath ?? '');
    if (PHASE_FILE_RE.test(filePath)) {
      written = String(input.content ?? input.new_string ?? '').trim();
    }
  }

  if (!written) return; // not a readable phase write -> see this file's header

  // The gate's alone, in a run and out of one: written from `idle` it arms
  // `preflight` and the budget over a cap no gate reached, and the next
  // implementer spawn has `arm-gate` move it to `implement`.
  if (written === 'blocked') {
    deny(
      `'blocked' is written by the gate itself, at its attempt cap — it is how the gate hands a run to a human. ` +
        `Written by anything else it disarms the gate without that having happened. If you need a human, say so ` +
        `and end your turn; the gate still judges what is committed.`,
    );
  }

  // ---- a write that STARTS a run is decided from where it starts (ADR-028) --
  if (!inRun) {
    // `idle`, `done`, or a value outside the vocabulary: arms nothing, so
    // there is nothing to guard and this hook stays transparent.
    if (!STARTS_A_RUN.includes(written)) return;

    // The checks `preflight` makes at the first spawn, made at the first
    // write: a run refused here leaves no phase behind, while one refused
    // there had already armed every hook that reads the phase.
    try {
      assertCanRun(root);
    } catch (err) {
      deny(
        `starting a run by writing '${written}' into .claude/state/phase, and this engine cannot run in this repository: ${err.message}\n\n` +
          `Nothing has started and nothing is armed. Fix that first, then start the run again — \`spec-flow init\`, run from the repository root, writes the contract.`,
      );
    }
    claimPhase(root, payload.session_id);
    return;
  }

  // ---- is this a phase at all? ---------------------------------------------
  if (!PHASES.includes(written)) {
    process.stderr.write(
      `[spec-flow] Denied: '${written}' is not a phase this engine knows.\n\n` +
        `The phase vocabulary is a CLOSED SET: ${PHASES.join(', ')}. Every enforcement hook ` +
        `decides whether it is armed by matching this file against those values, and each one ` +
        `falls through to "not my business" on anything else — so writing '${written}' would run ` +
        `the flow with the gate, the write-time linter, the whole-repo command deny, preflight ` +
        `and the Opus budget ALL disarmed at once, with nothing to say so.\n\n` +
        `Whatever step you are modelling, express it inside the vocabulary: spec work runs under ` +
        `\`spec\`, anything that writes code runs under \`implement\`. If you are extending the ` +
        `orchestrator, that constraint is the design, not an obstacle to route around.\n`,
    );
    process.exit(2); // PreToolUse denial protocol
  }

  // ---- a write that ends the run is decided from evidence (ADR-022) -------
  // From `blocked` the gate's cap has already put a human in the loop, so
  // standing down there is their call and is not second-guessed.
  if (written === 'idle' && phase !== 'blocked') {
    if (phase === 'implement') {
      deny(
        `writing 'idle' while the phase is 'implement'. No step of /spec-flow or /spec-fix ends a run from here: ` +
          `'idle' disarms the gate with nothing judged, and the next stop passes in silence. If the gate failed, ` +
          `follow its message — it routes the fix and the re-plan, and at its cap writes 'blocked' itself. If a ` +
          `human asked to abandon the run, standing it down is theirs to do, from their own terminal.`,
      );
    }
    const live = liveChanges(root);
    if (live.length > 0) {
      deny(
        `writing 'idle' with a change still live in specflow/: ${live.join(', ')}. Both flows record a dropped ` +
          `change before standing down: stamp \`**Status:** REJECTED <YYYY-MM-DD> — <reason>\` under the heading ` +
          `of its spec.md, move the folder to specflow/archive/, then write 'idle'.`,
      );
    }
  }

  // This write is going through: the session making it is the one driving the
  // phase from here, and every hook that arms reads the seal to tell its own
  // run's state from a second session's (ADR-017). Claimed only for a write
  // that is ALLOWED — a denied one changes nothing, so transferring the phase
  // on it would seal a transition that never happened.
  if (written !== 'done') {
    claimPhase(root, payload.session_id);
    return;
  }

  // ---- is `done` earned? ----------------------------------------------------
  const failures = [];

  // Degrades quietly on a bad contract: this guard's job is refusing an
  // unearned `done`, not policing the contract — gate.mjs does that loudly,
  // and preflight refuses to start a run over it in the first place.
  try {
    const config = loadConfig(root);
    const result = runUnscopedChecks(root, config);
    for (const c of result.checks) {
      if (c.rc !== 0) failures.push(`--- ${c.name} ---\n${c.out}`);
    }
  } catch {
    /* contract unreadable: leave the unscoped-check half silent, per the header above */
  }

  // A folder under specflow/ other than archive/ is a change that never got
  // folded — shipped code with an unarchived change spec is an unfinished run.
  const unarchived = liveChanges(root);
  if (unarchived.length > 0) {
    failures.push(`--- unarchived changes in specflow/ ---\n${unarchived.join('\n')}`);
  }

  // The checks above re-read the repo; only the gate ran the suite. A run
  // whose last commit it failed, or never judged, is not finished however
  // green spec-trace reads — spec-trace counts a failed test as executed.
  const passed = gatePassedHead(root);
  if (passed !== true) {
    failures.push(
      passed === null
        ? `--- the current commit ---\ngit could not name HEAD, so nothing can say a gate passed it.`
        : `--- the current commit ---\nthe gate has not passed it: no line in .claude/state/gate-history.log records result=pass for HEAD.`,
    );
  }

  if (failures.length === 0) {
    claimPhase(root, payload.session_id);
    return;
  }

  deny(
    `writing 'done' into .claude/state/phase, and the run is not actually finished. 'done' disarms every ` +
      `hook, so it has to be earned, not declared:\n${failures.join('\n')}\n\n` +
      `Route by what failed: a spec-trace gap belongs to the spec-writer session (FOLD); an unarchived ` +
      `specflow/<SLUG>/ means step 5 never ran — invoke spec-writer in MODE=FOLD; a commit the gate has not ` +
      `passed needs committing and a turn ended so the gate judges it; any other check the project declared goes ` +
      `back to the implementer of the milestone that broke it, with the hint that check carries in ` +
      `.spec-flow/config.json.`,
  );
});
