#!/usr/bin/env node
/**
 * External lint/test/spec gate. Runs OUTSIDE the model on the Stop event.
 *
 * - Only enforces while the flow is in the `implement` phase.
 * - Scopes lint and tests to the files CHANGED on this branch (vs the base
 *   branch), so a milestone is never blocked by pre-existing debt in files it
 *   never touched. Which files count is declared in `.spec-flow/config.json`.
 * - Also runs the unscoped checks, so a milestone cannot close while the specs
 *   and the tests that prove them disagree.
 * - Skips entirely (allowing the stop) while the tree is dirty: implementers
 *   run in the background, so a Stop can fire mid-write, and judging that
 *   snapshot produces false failures. The environment's own git-check owns
 *   dirty trees; this gate owns clean ones.
 * - Every invocation appends one line to `state/gate-history.log`.
 * - On pass: allows the agent to stop. On fail: blocks and routes the failure
 *   back to PLAN or straight to the implementer, depending on its class.
 * - Caps the loop at MAX_ATTEMPTS, then hands control to a human, writing
 *   `blocked` into the phase file as it does — the wait state would be
 *   unreachable if the phase stayed `implement`, since the very act of
 *   stopping to wait would re-trigger this gate.
 */
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { run, emitBlock, projectDir, stateDir, readFileOrDefault, appendLine, writeFile, readPayload } from './lib/io.mjs';
import { loadConfig } from '../scripts/spec-flow-config.mjs';
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

function truncate(text, max) {
  const lines = text.split('\n');
  const total = lines.length;
  const kept = lines.slice(0, max).join('\n');
  return total > max ? `${kept}\n... [${total - max} more lines — see .claude/state/gate-failure.full.log]` : kept;
}

/** Only the failure blocks and the totals carry signal in a full test run. */
function summarizeTests(text, max) {
  const picked = text
    .split('\n')
    .filter((l) => /^\s*(●|✕|Tests:|Suites:|Test Suites:)/.test(l))
    .join('\n');
  return truncate(picked || text, max);
}

await run(async () => {
  await readPayload(); // consumed, unused — this hook does not act on it

  const root = projectDir();
  const state = stateDir(root);
  const phaseFile = join(state, 'phase');
  const attFile = join(state, 'gate_attempts');
  const logFile = join(state, 'gate-failure.log');
  const fullLogFile = join(state, 'gate-failure.full.log');
  const histFile = join(state, 'gate-history.log');

  const phase = readFileOrDefault(phaseFile, '');
  if (phase !== 'implement') return; // spec/plan/review/blocked/done -> allow the stop, nothing recorded

  const attemptsNow = () => readFileOrDefault(attFile, '0');
  const hist = (result, lintRc, testRc, unscopedFields, filesField) =>
    appendLine(
      histFile,
      `${new Date().toISOString().replace(/\.\d+Z$/, 'Z')} ${shortSha(root)} phase=${phase} attempt=${attemptsNow()} result=${result} lint=${lintRc} test=${testRc} ${unscopedFields} files=${filesField}`,
    );

  // The one deliberate fail-CLOSED case in this engine. An unrecognized
  // contract_version must block the run loudly — see spec-flow-config.mjs's
  // header for the bash-era bridge bug where this used to silently degrade
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
  const dirty = statusRes.status === 0 ? statusRes.stdout : '';
  if (dirty.trim()) {
    hist('skip-dirty', '-', '-', histDashes(config), dirty.trim().split('\n').length);
    return;
  }

  const passAndExit = (lintRc, testRc, unscopedFields, filesField) => {
    hist('pass', lintRc, testRc, unscopedFields, filesField);
    writeFile(attFile, '0');
    writeFile(logFile, '');
    writeFile(fullLogFile, '');
  };

  // ---- scope: only the files this branch touched, per the contract ----------
  const base = resolveBase(root);
  const files = changedFiles(root, config.verify.scope_globs, base);

  // ---- the unscoped checks — run even when no file in scope changed ---------
  const result = runUnscopedChecks(root, config);

  if (files.length === 0) {
    if (result.allPass) return passAndExit('-', '-', histFields(result), 0);
  }

  let lintOut = '', lintRc = 0, testOut = '', testRc = 0;
  if (files.length > 0) {
    const lintRes = spawnSync(config.verify.lint[0], [...config.verify.lint.slice(1), ...files], {
      cwd: root,
      encoding: 'utf8',
    });
    lintOut = `${lintRes.stdout ?? ''}${lintRes.stderr ?? ''}`;
    lintRc = lintRes.status ?? 1;

    const testRes = spawnSync(config.verify.test[0], [...config.verify.test.slice(1), ...files], {
      cwd: root,
      encoding: 'utf8',
    });
    testOut = `${testRes.stdout ?? ''}${testRes.stderr ?? ''}`;
    testRc = testRes.status ?? 1;
  } else {
    lintOut = '(no files in scope changed)';
    testOut = '(no files in scope changed)';
  }

  if (lintRc === 0 && testRc === 0 && result.allPass) {
    return passAndExit(lintRc, testRc, histFields(result), files.length);
  }

  // ---- failure path -----------------------------------------------------
  const attempts = Number(attemptsNow() || 0) + 1;
  writeFile(attFile, String(attempts));

  // A traceability failure groups with lint, not with behaviour: its common
  // cause is a test that proves the requirement but never named it, which is
  // an edit, not a re-think.
  const failureClass = testRc === 0 ? 'lint/trace' : 'behaviour';

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
      `--- ${config.verify.lint_name} (rc=${lintRc}) ---`,
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
      `--- ${config.verify.lint_name} (rc=${lintRc}) ---`,
      lintRc === 0 ? '(clean)' : truncate(lintOut, MAX_LINT_LINES),
      '',
      `--- ${config.verify.test_name} (rc=${testRc}, failures only) ---`,
      testRc === 0 ? '(all passing)' : summarizeTests(testOut, MAX_TEST_LINES),
      checkSectionsTerse ? `\n${checkSectionsTerse}` : '',
    ].join('\n'),
  );

  hist(`fail:${failureClass}`, lintRc, testRc, histFields(result), files.length);

  // Cap first: repeated failure of any class means a human should look.
  if (attempts >= MAX_ATTEMPTS) {
    writeFile(attFile, '0');
    writeFile(phaseFile, 'blocked');
    emitBlock(
      `GATE FAILED ${attempts} times (lint rc=${lintRc}, test rc=${testRc}, ${summary(result)}). Auto-loop stopped to avoid thrashing; the phase is now 'blocked' so this stop-and-wait is allowed. Read .claude/state/gate-failure.log, summarize the blocker for the human (HITL), and wait. After their guidance, write 'implement' into .claude/state/phase and resume the milestone.`,
    );
    return;
  }

  // Cheap route: lint-only -> the implementer fixes it directly. No re-plan.
  if (failureClass === 'lint/trace' && attempts <= 2) {
    const hints = failedHints(result);
    emitBlock(
      `GATE FAILED on lint and/or the unscoped checks (lint rc=${lintRc}, ${summary(result)}); the tests pass, so the plan is NOT in question. Do NOT re-plan and do NOT change the phase. Route the fix back to the session whose edits are being checked — the implementer of the CURRENT milestone, or the spec-writer if you just ran the FOLD step — with the output in .claude/state/gate-failure.log, and have it fix exactly those violations — nothing else. Note that the linter already applied everything auto-fixable, so what remains needs a real edit; if a violation comes from a project rule in ${config.verify.lint_config_hint}, read its message, which explains what it protects. ${hints} Then end your turn so the gate runs again.`,
    );
    return;
  }

  // Everything else -> the plan may be wrong. Re-plan the current milestone.
  emitBlock(
    `GATE FAILED (lint rc=${lintRc}, test rc=${testRc}, ${summary(result)}, class=${failureClass}) on the files this branch changed. Do NOT patch ad-hoc. Loop back to the PLAN phase: (1) write 'plan' into .claude/state/phase, (2) invoke the planner subagent in MODE=REPLAN for the CURRENT milestone, pointing it at the failure log .claude/state/gate-failure.log, (3) re-invoke the implementer for that milestone, (4) set phase back to 'implement'. The full output is in .claude/state/gate-failure.log.`,
  );
});
