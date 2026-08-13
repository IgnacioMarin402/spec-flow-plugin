#!/usr/bin/env node
/**
 * The UNSCOPED checks: the ones that run on every gate no matter which files
 * changed, and again when a run tries to declare itself done.
 *
 * A module now, not a sourced shell file — `gate.mjs`, `done-guard.mjs` and
 * `check-changed.mjs` `import` it directly. That is not a smaller version of
 * the old design, it removes a whole failure class: in bash, three separate
 * files each carried their OWN complete copy of "what if this file is
 * missing", because a bare `.` of a missing file plus `set -u` kills the
 * hook, and a Stop hook that dies allows the stop. An ES module that fails to
 * resolve throws at import time instead — before any of THIS file's own
 * try/catch could run — so the guard has to live one level up: every one of
 * this file's three consumers ships in the same plugin package as this file
 * and gate.mjs is never present without it, which was never true of two
 * separate files in a consuming repo's `scripts/`.
 *
 * What survives from the old design: `spec-trace` is engine core, always
 * present and always first — not something a repo opts into, since it is
 * what makes `specs/` authoritative rather than decorative. `extra_checks` is
 * whatever the repo declares in `.spec-flow/config.json`, each one naming the
 * field it writes in `gate-history.log`, the line it prints when green, and
 * the hint its failure carries.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// This file's own directory — where spec-trace.mjs ships, as a sibling in
// the SAME package. Resolving it this way is the correct use of
// `import.meta.url`: it answers "where is my sibling module", which is a
// different question from "where is the repo this hook runs against" (that
// one comes from `CLAUDE_PROJECT_DIR`, never from a script's own location —
// see spec-flow-config.mjs's header for what conflating the two used to do).
// A repo's own `extra_checks`, unlike this one, genuinely DO live in the
// repo, so `runUnscopedChecks` below resolves THOSE relative to `root`.
const ENGINE_SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));

const SPEC_TRACE_CHECK = {
  name: 'spec-trace',
  field: 'spec',
  green: '(specs and tests agree)',
  hint: 'Name the requirement id in the test that proves it, or correct the requirement in the capability spec.',
  cmd: ['node', join(ENGINE_SCRIPTS_DIR, 'spec-trace.mjs')],
  class: 'lint/trace',
};

/** spec-trace, then whatever the contract declared, in that order. */
export function buildChecklist(config) {
  return [SPEC_TRACE_CHECK, ...(config.extra_checks ?? [])];
}

/**
 * Runs every declared check against `root` and returns each result plus the
 * aggregate. Mirrors the bash version's degrade-quietly rule for a REPO'S
 * OWN `extra_checks`: a script the repo declared but has not written yet
 * means "this repo does not have that check", not "the run should be
 * blocked" — a repo mid-adoption should not be blocked by its own
 * not-yet-written check.
 *
 * `spec-trace` does NOT get that grace. It ships INSIDE this package, next
 * to this file, at a path this file computes itself (`SPEC_TRACE_CHECK.cmd`
 * above) — it is never something the consuming repo could have "not written
 * yet". Missing here means the plugin install is broken or partial, and
 * degrading that to green is exactly the silent-disarm this engine exists to
 * refuse: `specs/` would stop being authoritative with no message anywhere.
 */
export function runUnscopedChecks(root, config) {
  const checks = buildChecklist(config).map((check) => {
    const argv = [...check.cmd];
    // A relative script path in argv[1] resolves against the repo root, so a
    // check declared as `['node', 'scripts/x.mjs']` works whichever
    // directory the hook runs from. Not every declared check HAS one:
    // `['node', '-e', '<code>']` has no file at all — the code is inline,
    // argv[1] is the `-e` flag — and `['npx', 'tsc']` names a binary PATH
    // resolves, not a path this repo owns. Treating either shape as "resolve
    // argv[1] against root, then check existsSync" made every such check
    // fall into the not-present branch below on EVERY run, silently and
    // permanently green — the "not yet written" grace meant for a repo's own
    // pending check, applied instead to a check that runs fine and was never
    // given the chance. Only a path-SHAPED argv[1] — contains a separator or
    // a `.`, and is not itself a flag — is eligible for that grace; anything
    // else is spawned directly and left to fail on its own terms.
    const looksLikePath = argv.length >= 2 && !argv[1].startsWith('-') && /[\\/.]/.test(argv[1]);
    if (looksLikePath && !argv[1].startsWith('/') && !argv[1].includes(':')) {
      argv[1] = join(root, argv[1]);
    }

    let out, rc;
    if (!looksLikePath || existsSync(argv[1])) {
      const res = spawnSync(argv[0], argv.slice(1), { cwd: root, encoding: 'utf8' });
      out = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
      rc = res.status ?? 1;
    } else if (check === SPEC_TRACE_CHECK) {
      out = `(${argv[1] ?? '?'} not present — the plugin install is broken or partial: spec-trace ships with the engine itself, it is never a repo-provided script)`;
      rc = 1;
    } else {
      out = `(${argv[1] ?? '?'} not present)`;
      rc = 0;
    }

    return {
      name: check.name,
      field: check.field,
      green: check.green ?? '(ok)',
      hint: check.hint ?? '',
      class: check.class ?? 'lint/trace',
      rc,
      out,
    };
  });

  return { checks, allPass: checks.every((c) => c.rc === 0) };
}

/** `spec=0 domain=0` — the shape gate-history.log has always had. */
export function histFields(result) {
  return result.checks.map((c) => `${c.field}=${c.rc}`).join(' ');
}

/** Same keys with `-`, for an invocation that never ran them (dirty tree, no phase). */
export function histDashes(config) {
  return buildChecklist(config)
    .map((c) => `${c.field}=-`)
    .join(' ');
}

/** `spec-trace rc=0, other-check rc=0` — for the block messages. */
export function summary(result) {
  return result.checks.map((c) => `${c.name} rc=${c.rc}`).join(', ');
}

/** The hints of the checks that actually failed, for gate.mjs to append. */
export function failedHints(result) {
  return result.checks
    .filter((c) => c.rc !== 0 && c.hint)
    .map((c) => `${c.name}: ${c.hint}`)
    .join(' ');
}

/** `run_unscoped_checks NOT RUN` message shape, kept for the one caller that needs to say the module itself did not load — see gate.mjs's own top-level catch. */
export function unavailableSummary() {
  return 'unscoped checks NOT RUN (scripts/unscoped-checks.mjs failed to load)';
}
