#!/usr/bin/env node
/**
 * External lint/test/spec gate. Runs OUTSIDE the model on the Stop event, and
 * only while the flow is in the `implement` phase.
 *
 * - LINT is scoped to the files changed against the base branch; the SUITE
 *   never is, and never skips, not even on an empty scope — see ADR-008.
 *   `resolveBase` refuses to guess the base for the same reason: a wrong one
 *   manufactures an empty scope and disarms the gate.
 * - Runs the unscoped checks too, so a milestone cannot close while the specs
 *   and the tests that prove them disagree.
 * - Skips entirely (allowing the stop) while the tree is dirty. Implementers
 *   run in the background, so a Stop can fire mid-write and judging that
 *   snapshot produces false failures.
 * - Writes `running` to `state/gate-history.log` before judging and replaces
 *   it with the outcome. A surviving `running` line is proof its invocation
 *   was killed, and the next armed gate reports it as `fail:killed`. That line
 *   is the only trace a CANCELED hook leaves: reaching the `timeout` declared
 *   in hooks.json discards this file's output, and a Stop hook that renders no
 *   decision ALLOWS the stop — above this file's catch-all.
 * - On the first pass for a commit: blocks the stop and wakes the
 *   orchestrator with what to do next — see ADR-010. A repeat pass for a
 *   commit already reported this way allows the stop instead, silently to
 *   the model. On fail: blocks, routing back to PLAN or to the implementer
 *   depending on the failure's class.
 * - At MAX_ATTEMPTS it hands control to a human and writes `blocked` into the
 *   phase file. The wait state would be unreachable under `implement`, since
 *   stopping to wait re-triggers this gate.
 */
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { run, emitBlock, emitNotice, projectDir, stateDir, phasePath, readFileOrDefault, appendLine, writeFile, readPayload } from './lib/io.mjs';
import { loadConfig, ensureReportDir } from '../scripts/spec-flow-config.mjs';
import { runUnscopedChecks, histFields, histDashes, summary, failedHints } from '../scripts/unscoped-checks.mjs';
import { resolveBase, changedFiles } from '../scripts/changed-files.mjs';

const MAX_ATTEMPTS = 5;
// The planner (Opus) reads gate-failure.log on every REPLAN, so it is
// budgeted, not dumped: a broken suite prints thousands of lines and all of
// them would become input tokens on the most expensive model in the flow.
// The untruncated output stays in gate-failure.full.log for a human.
const MAX_LINT_LINES = 40;
const MAX_TEST_LINES = 60;

function shortSha(root) {
  const res = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : '-';
}

/**
 * This engine copy's own version, for the history line.
 *
 * Read from the package.json two directories up — the one that ships with these
 * hooks — so what it reports is the copy that RAN, never whatever the consuming
 * repo happens to have installed. Reporting the other would invert the whole
 * point of recording it.
 */
function engineVersion() {
  try {
    const own = new URL('../package.json', import.meta.url);
    return JSON.parse(readFileSync(own, 'utf8')).version || '?';
  } catch {
    return '?';
  }
}

function truncate(text, max) {
  const lines = text.split('\n');
  const total = lines.length;
  const kept = lines.slice(0, max).join('\n');
  return total > max ? `${kept}\n... [${total - max} more lines — see .claude/state/gate-failure.full.log]` : kept;
}

/**
 * Only the failure blocks and the totals carry signal in a full test run.
 * When no runner-specific marker matches (a runner whose summary format
 * differs from the ones below), fall back to the TAIL rather than the
 * head `truncate` uses elsewhere: a runner's own summary prints last, and
 * a full-suite run's head is pass spew with zero signal — spent on the
 * planner, the most expensive model in the flow.
 */
function summarizeTests(text, max) {
  const picked = text
    .split('\n')
    .filter((l) => /^\s*(●|✕|Tests:|Suites:|Test Suites:)/.test(l))
    .join('\n');
  if (picked) return truncate(picked, max);

  const lines = text.split('\n');
  if (lines.length <= max) return text;
  return `... [${lines.length - max} more lines above — see .claude/state/gate-failure.full.log]\n${lines.slice(-max).join('\n')}`;
}

/**
 * Set as soon as the hook knows it is armed, so the fail-closed handler at the
 * bottom of this file can still write a history line and a block message after
 * an unexpected throw. Null while the gate is not armed — in that state there
 * is nothing to fail closed about, and a block would be wrong.
 */
let armed = null;

await run(
  async () => {
    await readPayload(); // consumed, unused — this hook does not act on it

    const root = projectDir();

    // Phase first, without creating anything: a Stop fires in every session,
    // and a gate that is not armed must leave no trace in a repo that does
    // not use this engine.
    const phaseFile = phasePath(root);
    const phase = readFileOrDefault(phaseFile, '');
    if (phase !== 'implement') return; // spec/plan/review/blocked/done -> allow the stop, nothing recorded

    const state = stateDir(root);
    const attFile = join(state, 'gate_attempts');
    const logFile = join(state, 'gate-failure.log');
    const fullLogFile = join(state, 'gate-failure.full.log');
    const histFile = join(state, 'gate-history.log');

    const attemptsNow = () => readFileOrDefault(attFile, '0');
    const line = (result, lintRc, testRc, unscopedFields, filesField) =>
      // `cc=` records the Claude Code that ran this gate — recorded, never
      // checked (ADR-004). `?` when the harness does not expose it: an absent
      // value must read as "not known here", never as a version.
      //
      // `engine=` records WHICH COPY of this engine judged the milestone, and
      // it stopped being a curiosity when the engine became an npm package.
      // There are two copies in a configured repo by construction: the plugin's
      // own, which these hooks import from, and the devDependency, which the
      // terminal and CI reach through `spec-flow check`. The README's central
      // promise — green in your terminal means green at the gate — is only true
      // while those agree, and nothing makes them: the plugin follows a commit
      // and the dependency follows a version range. Recorded, not enforced, for
      // the same reason `cc=` is: a mismatch is a fact worth having in the log
      // when a gate and a local run disagree, and blocking on it would refuse
      // milestones over a patch bump nobody noticed.
      `${new Date().toISOString().replace(/\.\d+Z$/, 'Z')} ${shortSha(root)} cc=${process.env.CLAUDE_CODE_VERSION ?? '?'} engine=${engineVersion()} phase=${phase} attempt=${attemptsNow()} result=${result} lint=${lintRc} test=${testRc} ${unscopedFields} files=${filesField}`;

    /**
     * The one failure this file's own catch-all cannot reach: a `command`
     * hook that hits its timeout is CANCELED by Claude Code, and a Stop hook
     * that renders no decision ALLOWS the stop. No block, no history line, and
     * "no history line" is otherwise indistinguishable from "never armed".
     *
     * So the log records the ATTEMPT too. A `running` line goes down before
     * any command is spawned, and every outcome replaces it. A `running` line
     * that survives is therefore proof that the invocation which wrote it was
     * killed — the gate's absence becomes evidence instead of silence, and
     * the next armed run reports it (see `killed` below).
     */
    const replaceRunning = (text) => {
      const lines = readFileOrDefault(histFile, '').split('\n').filter(Boolean);
      if (lines.length > 0 && / result=running /.test(lines[lines.length - 1])) lines.pop();
      writeFile(histFile, lines.length > 0 ? `${lines.join('\n')}\n${text}\n` : `${text}\n`);
    };

    const hist = (result, lintRc, testRc, unscopedFields, filesField) =>
      replaceRunning(line(result, lintRc, testRc, unscopedFields, filesField));

    // A dangling `running` from a PREVIOUS invocation: that gate was killed
    // mid-judgement, so whatever it was judging was never verified.
    //
    // Handled before this run writes its own `running` line, and `hist`
    // replaces the dangling one rather than appending beside it — otherwise
    // the evidence would survive its own report and every future stop would
    // block on the same dead invocation forever.
    const previous = readFileOrDefault(histFile, '').split('\n').filter(Boolean);
    if (previous.length > 0 && / result=running /.test(previous[previous.length - 1])) {
      armed = { hist };
      hist('fail:killed', '-', '-', 'unscoped=-', '-');
      emitBlock(
        `GATE FAILED — the previous gate invocation never finished. Its history line says \`running\` and no outcome ever replaced it, which means the process was killed before it could judge anything: nothing was linted, tested or traced for that stop, and the stop was ALLOWED, because a Stop hook that renders no decision allows one. ` +
          `The usual cause is \`verify.test\` exceeding the Stop hook's time budget (1800s as this plugin declares it). Treat the previous milestone as UNVERIFIED. ` +
          `Do not change the phase. Show this to a human: either the suite needs to be a smaller smoke subset in \`verify.test\`, or the timeout in the plugin's hooks.json needs raising. Then end your turn — the next gate runs normally.`,
      );
      return;
    }

    // This invocation's own claim on the log, written before anything is
    // spawned so that being killed from here on leaves the evidence above.
    appendLine(histFile, line('running', '-', '-', 'unscoped=-', '-'));
    armed = { hist };

    // The one deliberate fail-CLOSED case in this engine. An unrecognized
    // contract_version must block the run loudly — see spec-flow-config.mjs's
    // header for why a caller must never swallow this and fall back
    // to stale hardcoded defaults instead.
    let config;
    try {
      config = loadConfig(root);
    } catch (err) {
      hist('fail:contract', '-', '-', 'unscoped=missing', '-');
      emitBlock(
        `GATE FAILED — the contract could not be read: ${err.message} Do not proceed. A human needs to fix .spec-flow/config.json (or the engine's own supported version) before this run can continue.`,
      );
      return;
    }

    // ---- quiescence guard -----------------------------------------------------
    // Implementer subagents run in the background: the orchestrator's turn can
    // end — firing Stop — while an implementer is mid-write. A dirty tree is
    // therefore not evidence of a failed milestone, it is evidence of an
    // unfinished write, so it is not judged.
    const statusRes = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
    // Exclude .claude/state/ itself: the gate's own writes (gate-history.log
    // and friends) land there, so a consuming repo that forgot to gitignore
    // it would otherwise see this guard trip on every run FOREVER, right
    // after the first pass — silently disarming the gate with no message
    // anywhere, since skip-dirty is not a failure. The README asks repos to
    // gitignore this directory; this line is what happens when they don't.
    const dirty = statusRes.status === 0
      ? statusRes.stdout.split('\n').filter((l) => l.trim() && !/\.claude[\\/]state[\\/]/.test(l)).join('\n')
      : '';
    if (dirty.trim()) {
      hist('skip-dirty', '-', '-', histDashes(config), dirty.trim().split('\n').length);
      return;
    }

    // A pass now WAKES the orchestrator — see ADR-010, which reverses the
    // "silent to the model" half of the design this replaced. What forced
    // it: `emitNotice`'s `systemMessage` renders in `claude -p` and is
    // discarded in an interactive session — verified against real
    // transcripts, cited in the ADR — so "the human always sees it" was
    // never true on the surface this engine actually runs on. `emitBlock`
    // IS rendered there, the same way every GATE FAILED message in this
    // file already is, so a pass now speaks through that channel instead of
    // inventing a second one that only half of it needed.
    //
    // Waking on every stop would thrash: Stop can fire more than once on the
    // SAME clean tree (an implementer that reported early, a human who said
    // nothing), and a milestone only needs the orchestrator's attention once
    // per commit it produced. So this wakes ONCE per sha — `previous`,
    // captured above before this invocation's own history line existed,
    // already carries a `result=pass` for the current sha if an earlier stop
    // on this exact tree already woke the run. Later stops on that same sha
    // fall back to `emitNotice`: still on screen, just not spent re-waking a
    // model with nothing new to do.
    const passAndExit = (lintRc, testRc, unscopedFields, filesField) => {
      const sha = shortSha(root);
      hist('pass', lintRc, testRc, unscopedFields, filesField);
      writeFile(attFile, '0');
      writeFile(logFile, '');
      writeFile(fullLogFile, '');

      const summary = `spec-flow: gate PASSED — ${sha} (${config.verify.lint_name} ${lintRc}, ${config.verify.test_name} ${testRc}, ${unscopedFields}).`;

      // `sha !== '-'`: `shortSha` returns `-` when git itself failed, and
      // reading that as "already woke" would silence every future pass on a
      // broken checkout forever — the same silent-disarm shape this file
      // exists to close, one line further down.
      const alreadyWoke = sha !== '-' && previous.some(
        (l) => l.split(' ')[1] === sha && / result=pass /.test(l),
      );

      if (alreadyWoke) {
        emitNotice(`${summary} Already reported for this commit — nothing more happens on its own unless you act.`);
        return;
      }

      emitBlock(
        `${summary} Advance the run now: start the NEXT milestone with a fresh implementer Agent call, or if none remain, invoke spec-writer in MODE=FOLD; if this was the fold's own gate re-run, write 'done' into .claude/state/phase. Do not re-run lint or tests yourself and do not repeat what already passed.`,
      );
    };

    // ---- scope: only the files this branch touched, per the contract ----------
    // `resolveBase` throws rather than guessing a base it could not find, and
    // that is caught HERE rather than by the catch-all at the bottom, because
    // it is not an engine defect: it is a repo whose base branch this engine
    // cannot name, which a human fixes in the contract. Before it threw, it
    // fell back to `'HEAD'` — a base that yields an empty changed-file list
    // by construction — and this gate read that as "nothing in scope
    // changed" and reported a clean pass over a red linter and a red suite,
    // on every repo whose default branch is not called `main`.
    let base, files;
    try {
      base = resolveBase(root, config);
      files = changedFiles(root, config.verify.scope_globs, base);
    } catch (err) {
      hist('fail:base', '-', '-', histDashes(config), '-');
      emitBlock(
        `GATE FAILED — the base branch could not be resolved: ${err.message} Do not proceed and do not change the phase. Nothing was linted or tested, so treat NOTHING as verified. A human needs to add "base_ref" under "verify" in .spec-flow/config.json.`,
      );
      return;
    }

    // ---- the base that resolved, and resolved to the tip ---------------------
    // `resolveBase` throws when it cannot NAME a base; this is the case where
    // it names one successfully and the answer is HEAD. A repo doing its work
    // directly on the base branch — no feature branch, commonly no remote —
    // gets `merge-base HEAD main == HEAD`, so the diff against it is empty by
    // construction and stays empty for every commit of every milestone.
    //
    // What that costs is exactly one check, and only because the rest were
    // deliberately unscoped: the suite, spec-trace and the extra checks run on
    // every armed gate regardless of the diff, so this is not the disarmed
    // gate the old `'HEAD'` fallback produced. `verify.lint` is the one check
    // scoped to the changed files, and it never runs — for any milestone, for
    // the whole run — while the history records `lint=-`, which is true and
    // reads exactly like the milestone that honestly touched nothing in scope.
    // An engine built to refuse checks that look armed and are not does not
    // get to keep that one on a technicality.
    //
    // Deliberately NOT hoisted into `preflight`: at run start a correctly
    // branched repo looks identical — a fresh branch sits at the base's tip
    // until its first commit — so the same condition there would refuse every
    // properly set up run. It only becomes evidence here, where the tree is
    // clean and a milestone is being judged: nothing committed above the base
    // at that point means either the base is the branch, or the milestone
    // produced nothing. Both are refusals, and the message names both.
    const headRes = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
    if (headRes.status === 0 && headRes.stdout.trim() === base) {
      const branchRes = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8' });
      const branch = branchRes.status === 0 ? branchRes.stdout.trim() : '(unknown)';
      hist('fail:base', '-', '-', histDashes(config), '-');
      emitBlock(
        `GATE FAILED — the base resolved to HEAD itself, so the changed-file scope is empty by construction and ${config.verify.lint_name} was never invoked. ` +
          `Branch "${branch}" has no commit the base does not already have. Either this work is being done directly ON the base branch, in which case the scope will be empty for every milestone of this run, or this milestone committed nothing at all. ` +
          `Do not proceed and do not change the phase. Nothing was linted, so treat NOTHING as verified. A human fixes this by doing the run's work on its own branch, or by declaring the ref this work is judged against as "base_ref" under "verify" in .spec-flow/config.json.`,
      );
      return;
    }

    // LINT is scoped, so it has nothing to do when nothing in scope changed.
    let lintOut = '(no files in scope changed)';
    let lintRc = 0;
    if (files.length > 0) {
      const lintRes = spawnSync(config.verify.lint[0], [...config.verify.lint.slice(1), ...files], {
        cwd: root,
        encoding: 'utf8',
      });
      lintOut = `${lintRes.stdout ?? ''}${lintRes.stderr ?? ''}`;
      lintRc = lintRes.status ?? 1;
    }

    // The suite runs on EVERY armed gate, including when no file in scope
    // changed — not scoped to `files`, and not gated on `files` being
    // non-empty either. Both halves of that follow from the same fact: a
    // suite's outcome is a property of the SYSTEM, not of any file. Scoping
    // it to the diff lets a green run hide a broken consumer; skipping it
    // because the diff is empty is the same mistake at its degenerate case,
    // and the empty diff is not always real — a base this engine resolves
    // wrongly produces one out of thin air. Running the suite unconditionally
    // is what makes that a slow gate instead of a disarmed one.
    //
    // (Not scoped, specifically: a trailing path argument is a per-FILE
    // filter to the runners this contract documents — positional args match
    // against TEST file paths — not "run what's related to these sources".
    // Appending changed source files either matches nothing, a false RED that
    // burns an Opus REPLAN on a milestone that touched no test file, or
    // silently narrows coverage to whichever test shares a path segment.)
    ensureReportDir(root, config);
    const testRes = spawnSync(config.verify.test[0], config.verify.test.slice(1), {
      cwd: root,
      encoding: 'utf8',
    });
    const testOut = `${testRes.stdout ?? ''}${testRes.stderr ?? ''}`;
    const testRc = testRes.status ?? 1;

    // ---- the unscoped checks — run even when no file in scope changed ---------
    //
    // AFTER the suite, and that ordering is now load-bearing rather than
    // arbitrary. `spec-trace` establishes which requirements are proven by
    // asking the contract's `trace.executed_tests` what actually RAN, so it
    // has to run against this invocation's test run, not the previous one's.
    // Ahead of the suite it would judge a stale report — or none at all on a
    // fresh clone — and a report that says nothing is a refusal, so the gate
    // would block on the ordering rather than on the code.
    //
    // Costs nothing to move: this gate has never short-circuited. Lint, the
    // suite and the unscoped checks all run on every armed invocation
    // regardless of what the others found, because the block message has to
    // name everything that is wrong at once rather than the first thing.
    const result = runUnscopedChecks(root, config);

    // `lint=-` in the history when lint had nothing to run: reporting `lint=0`
    // for a linter that was never invoked is the same lie in miniature.
    const lintField = files.length > 0 ? lintRc : '-';

    if (lintRc === 0 && testRc === 0 && result.allPass) {
      return passAndExit(lintField, testRc, histFields(result), files.length);
    }

    // ---- failure path -----------------------------------------------------
    const attempts = Number(attemptsNow() || 0) + 1;
    writeFile(attFile, String(attempts));

    // A traceability failure groups with lint, not with behaviour: its common
    // cause is a test that proves the requirement but never named it, which is
    // an edit, not a re-think. A red test always means `behaviour` — and so
    // does any unscoped check that declared itself `class: 'behaviour'` in
    // the contract (spec-flow-config.mjs validates the field; this is what
    // reads it — previously nothing did, so a repo's own declaration was
    // accepted and silently ignored).
    const behaviourCheck = result.checks.some((c) => c.rc !== 0 && c.class === 'behaviour');
    const failureClass = testRc !== 0 || behaviourCheck ? 'behaviour' : 'lint/trace';

    const checkSections = result.checks
      .map((c) => `--- ${c.name} (rc=${c.rc}) ---\n${c.out}`)
      .join('\n\n');
    const checkSectionsTerse = result.checks
      .map((c) => `--- ${c.name} (rc=${c.rc}) ---\n${c.rc === 0 ? c.green : c.out}`)
      .join('\n\n');

    writeFile(
      fullLogFile,
      [
        `=== GATE FAILURE (attempt ${attempts}/${MAX_ATTEMPTS}, class: ${failureClass}) ===`,
        `--- scope (${files.length} changed file(s) vs ${base}) ---`,
        files.join('\n'),
        '',
        `--- ${config.verify.lint_name} (rc=${lintField}) ---`,
        lintOut,
        '',
        `--- ${config.verify.test_name} (rc=${testRc}) ---`,
        testOut,
        checkSections ? `\n${checkSections}` : '',
      ].join('\n'),
    );

    writeFile(
      logFile,
      [
        `=== GATE FAILURE (attempt ${attempts}/${MAX_ATTEMPTS}, class: ${failureClass}) ===`,
        `--- scope (${files.length} changed file(s) vs ${base}) ---`,
        files.join('\n'),
        '',
        `--- ${config.verify.lint_name} (rc=${lintField}) ---`,
        // `lintOut` already says so when lint did not run; `(clean)` would
        // claim a linter passed over files it was never given.
        files.length === 0 ? lintOut : lintRc === 0 ? '(clean)' : truncate(lintOut, MAX_LINT_LINES),
        '',
        `--- ${config.verify.test_name} (rc=${testRc}, failures only) ---`,
        testRc === 0 ? '(all passing)' : summarizeTests(testOut, MAX_TEST_LINES),
        checkSectionsTerse ? `\n${checkSectionsTerse}` : '',
      ].join('\n'),
    );

    hist(`fail:${failureClass}`, lintField, testRc, histFields(result), files.length);

    // Cap first: repeated failure of any class means a human should look.
    if (attempts >= MAX_ATTEMPTS) {
      writeFile(attFile, '0');
      writeFile(phaseFile, 'blocked');
      emitBlock(
        `GATE FAILED ${attempts} times (lint rc=${lintField}, test rc=${testRc}, ${summary(result)}). Auto-loop stopped to avoid thrashing; the phase is now 'blocked' so this stop-and-wait is allowed. Read .claude/state/gate-failure.log, summarize the blocker for the human (HITL), and wait. After their guidance, write 'implement' into .claude/state/phase and resume the milestone.`,
      );
      return;
    }

    // Cheap route: lint-only -> the implementer fixes it directly. No re-plan.
    if (failureClass === 'lint/trace' && attempts <= 2) {
      const hints = failedHints(result);
      emitBlock(
        `GATE FAILED on lint and/or the unscoped checks (lint rc=${lintField}, ${summary(result)}); the tests pass, so the plan is NOT in question. Do NOT re-plan and do NOT change the phase. Route the fix back to the session whose edits are being checked — the implementer of the CURRENT milestone, or the spec-writer if you just ran the FOLD step — with the output in .claude/state/gate-failure.log, and have it fix exactly those violations — nothing else. Note that the linter already applied everything auto-fixable, so what remains needs a real edit; if a violation comes from a project rule in ${config.verify.lint_config_hint}, read its message, which explains what it protects. ${hints} Then end your turn so the gate runs again.`,
      );
      return;
    }

    // Cheap route: a red test (or a check the contract declared `behaviour`),
    // FIRST attempt only. The first red test after a milestone is
    // overwhelmingly a bug in the code just written, not a flaw in the plan —
    // spending an Opus REPLAN on it before anyone has even tried a direct fix
    // is the expensive-first mistake this branch exists to skip. Only a
    // failure that SURVIVES one direct attempt is evidence the plan itself is
    // wrong, which is what REPLAN below is actually for.
    if (failureClass === 'behaviour' && attempts === 1) {
      emitBlock(
        `GATE FAILED (lint rc=${lintField}, test rc=${testRc}, ${summary(result)}), attempt 1/${MAX_ATTEMPTS}. Do NOT re-plan yet and do NOT change the phase. Route the fix back to the implementer of the CURRENT milestone with the output in .claude/state/gate-failure.log: fix the code (and any lint violation alongside it) so everything passes. Do NOT skip, delete, or weaken the failing test to make this pass — spec-trace does not catch a test that still exists but no longer asserts anything. If you believe the PLAN itself is wrong rather than the code, say so in your reply instead of patching around the test. Then end your turn so the gate runs again.`,
      );
      return;
    }

    // Everything else -> the plan may be wrong. Re-plan the current milestone.
    emitBlock(
      `GATE FAILED (lint rc=${lintField}, test rc=${testRc}, ${summary(result)}, class=${failureClass}) on the files this branch changed. Do NOT patch ad-hoc. Loop back to the PLAN phase: (1) write 'plan' into .claude/state/phase, (2) invoke the planner subagent in MODE=REPLAN for the CURRENT milestone, pointing it at the failure log .claude/state/gate-failure.log, (3) re-invoke the implementer for that milestone, (4) set phase back to 'implement'. The full output is in .claude/state/gate-failure.log.`,
    );
  },

  // ---- fail CLOSED, and this is the whole reason it is here ----------------
  //
  // Every other hook in this engine fails OPEN: a crash allows the tool call,
  // which is no worse than the hook not existing. This one is the exception,
  // because a Stop hook that exits 0 without printing a block ALLOWS the
  // stop — so an unexpected throw here does not merely skip the gate, it
  // reports a clean milestone. Code written with the gate off looks exactly
  // like code that passed it.
  //
  // That is the same failure the three defects behind scripts/gate-fixture.mjs
  // all were, and porting to node reintroduced it in a new shape: bash needed
  // `set -u` plus a missing file, node needs any uncaught exception at all.
  // So the catch-all says block, and records that it did.
  (err) => {
    if (!armed) return; // not an armed run -> nothing to fail closed about
    armed.hist('fail:hook-error', '-', '-', 'unscoped=missing', '-');
    emitBlock(
      `GATE FAILED — the gate itself threw before it could judge anything: ${err?.message ?? err}. ` +
        `This is a defect in the engine, not in the milestone: nothing was linted, tested or traced, so treat NOTHING as verified. ` +
        `Do not retry blindly and do not change the phase. Show this to a human, with the stack from stderr.`,
    );
    process.stderr.write(`[spec-flow] gate.mjs threw: ${err?.stack ?? err}\n`);
  },
);
