#!/usr/bin/env node
/**
 * The only reader of `.spec-flow/config.json`.
 *
 * Everything the engine needs to know about the repo it is running in comes
 * through here: which command lints, which one tests, which files are in
 * scope, where the specs live, which extra checks the repo declares. Nothing
 * else parses that file — one reader means defaults, validation and the
 * version check exist once instead of in ten hooks.
 *
 *   import { loadConfig } from './spec-flow-config.mjs';
 *   const config = loadConfig(root);
 *
 * `root` is the consuming repo's directory, explicit rather than inferred.
 * Before this file lived in a plugin, `root` and "where this script sits"
 * were the same directory, so resolving from `import.meta.url` worked by
 * accident. They are never the same directory again: every caller passes the
 * repo root down from `CLAUDE_PROJECT_DIR` (hooks) or `process.cwd()` (the
 * CLI form, run from an npm script in the consuming repo). Inferring it from
 * this file's own location instead would read the PLUGIN's contract, or none
 * at all — both of which fail without saying so.
 *
 * **Missing file is not automatically silent, and that is a deliberate change
 * from how this file behaved while it lived inside the one repo it served.**
 * There, "no contract yet" had a concrete, safe meaning: this exact repo's
 * own prior hardcoded values, so falling back to them was a non-event by
 * construction. Once this file serves an arbitrary consuming repo, that
 * anchor is gone — there is no particular test runner, linter or layer name
 * that is safe to assume for a repo this engine has never seen. So the
 * defaults below carry only what genuinely has no stack-specific content
 * (`specs_dir: 'specs'`, the not-a-capability filenames); everything that
 * actually names a tool or a layer is required, and `validate()` — run on
 * EVERY load, missing file included — says exactly what is missing and that
 * `.spec-flow/config.json` is where it goes. A repo adopting this engine for
 * the first time hits that message twice at most, and both times before
 * anything runs with a guess: `spec-flow init` reports it at setup, and
 * `preflight.mjs` refuses the first subagent of a run if it is still true.
 *
 * **A version it does not recognise is an error too, and fails the same way.**
 * It used to be documented as "the one deliberate exception to the fail-open
 * rule", back when every other gap in this file had a safe generic fallback.
 * Now most of them don't, so refusing to run on missing configuration is the
 * norm here, not the exception — loud is recoverable, guessing is not.
 *
 * Every caller MUST let a thrown error propagate as a loud failure of its own
 * — never catch it and fall back to defaults. A caller that did would revive
 * the exact bug this file's own bash-era bridge had: `unscoped-checks.sh`
 * called `spec-flow-config.mjs --sh` inside `if ... ; then eval ...; else
 * <hardcoded defaults> fi`, and a *version-mismatch* exit was indistinguishable
 * from a *missing-file* exit to that `if` — so a repo that declared a version
 * this engine could not read silently got this engine's old hardcoded values
 * instead of a refusal to run. Every hook below calls `loadConfig` unguarded
 * for exactly this reason.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The contract this reader understands. A file declaring anything else stops the run. */
export const SUPPORTED_VERSION = 1;

/**
 * Kept as data rather than scattered through the file so "the defaults" is
 * something you can read in one place. Only fields with no stack-specific
 * content get a real value; everything that would have to guess a tool or a
 * layer name is left empty and `validate()` requires it — see this file's
 * header for why that is the correct default now, not a stricter one.
 */
const DEFAULTS = {
  contract_version: SUPPORTED_VERSION,
  verify: {
    scope_globs: [],
    lint: [],
    lint_no_fix: [],
    test: [],
    test_name: '',
    lint_name: '',
    lint_config_hint: '',
    // Optional, and the only field here whose empty default is not a
    // "required, go declare it": empty means "resolve the base branch
    // automatically", which succeeds for most repos. What is NOT optional is
    // that failing to resolve one is loud — see resolveBase in
    // changed-files.mjs. A repo only needs this field when the automatic
    // ladder cannot find its base.
    base_ref: '',
  },
  trace: {
    specs_dir: 'specs',
    proof_dir: '',
    proof_suffix: '',
    not_a_capability: ['README.md', 'glossary.md'],
  },
  extra_checks: [],
  unscoped_denied: {
    scripts: [],
    tools: [],
    scoped_allowed: [],
    scoped_alternative: '',
    scoped_examples: [],
  },
};

/** Shallow-merge one level down: a repo overriding `verify.test` keeps the other verify defaults. */
function merge(base, override) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    out[key] =
      value && typeof value === 'object' && !Array.isArray(value)
        ? merge(base[key] ?? {}, value)
        : value;
  }
  return out;
}

/**
 * Validation is deliberately thin: shape, not taste.
 *
 * A wrong command is caught the first time the gate runs it, loudly, with the
 * real error. A schema validator that tried to know which commands are
 * plausible would be a second opinion about the repo it is not entitled to
 * have — and would reject the vitest/deno/bazel cases this contract exists to
 * allow.
 *
 * Runs on EVERY load, including a missing file — see this file's header for
 * why "no contract yet" no longer has a safe generic answer for these fields.
 */
function validate(config, source) {
  const problems = [];
  const nonEmptyArray = (v) => Array.isArray(v) && v.length > 0;
  const nonEmptyString = (v) => typeof v === 'string' && v.length > 0;

  if (!nonEmptyArray(config.verify.lint)) {
    problems.push('verify.lint must be a non-empty array of argv parts, e.g. ["node", "node_modules/.bin/eslint", "--fix"].');
  }
  if (!nonEmptyArray(config.verify.test)) {
    problems.push('verify.test must be a non-empty array of argv parts, e.g. ["node", "node_modules/.bin/vitest", "run"].');
  }
  if (!nonEmptyArray(config.verify.scope_globs)) {
    problems.push('verify.scope_globs must be a non-empty array, e.g. ["*.ts", "*.tsx"].');
  }
  if (!nonEmptyString(config.verify.test_name)) {
    problems.push('verify.test_name must name the test runner, e.g. "vitest" — it labels the gate\'s log sections.');
  }
  if (!nonEmptyString(config.verify.lint_name)) {
    problems.push('verify.lint_name must name the linter, e.g. "eslint" — it labels the gate\'s log sections.');
  }
  // Optional — but a repo that bothers to declare it must mean something by
  // it. `"base_ref": ""` is indistinguishable from not setting it at all,
  // and silently means "auto-resolve"; saying so here stops that from being
  // a surprise the first time the automatic ladder picks a different branch.
  if (config.verify.base_ref !== '' && !nonEmptyString(config.verify.base_ref)) {
    problems.push(
      'verify.base_ref, when present, must be a non-empty string naming the ref this branch is judged against, e.g. "origin/trunk". Omit it entirely to let the engine resolve the base branch automatically.',
    );
  }
  if (!nonEmptyString(config.trace.proof_dir)) {
    problems.push(
      'trace.proof_dir must name the directory segment that marks a proof file (e.g. "application"). ' +
        'Without it spec-trace silently matches no test files, which reads as "nothing is proven" instead of "this is unconfigured".',
    );
  }
  if (!nonEmptyString(config.trace.proof_suffix)) {
    problems.push('trace.proof_suffix must name the test-file suffix spec-trace looks for, e.g. ".spec.ts" or ".test.ts".');
  }

  if (problems.length > 0 && source === 'defaults') {
    problems.push(
      'No .spec-flow/config.json was found at all, so none of the above has a value — this project has not written a contract for this engine yet. See the plugin README for the minimal file to start from.',
    );
  }

  for (const [i, check] of (config.extra_checks ?? []).entries()) {
    const where = `extra_checks[${i}]`;
    if (!check.name) problems.push(`${where}.name is required.`);
    if (!nonEmptyArray(check.cmd)) problems.push(`${where}.cmd must be a non-empty array.`);
    if (!check.field) {
      problems.push(
        `${where}.field is required: it is the key this check writes in gate-history.log, and specflow-stats reads that log by key.`,
      );
    }
    if (check.class && !['lint/trace', 'behaviour'].includes(check.class)) {
      problems.push(
        `${where}.class must be "lint/trace" (route the failure back as an edit) or "behaviour" (route it as a re-plan).`,
      );
    }
  }

  return problems;
}

/** @param {string} root Absolute path to the repo whose contract this reads. */
export function loadConfig(root) {
  if (!root) {
    throw new Error('loadConfig(root) requires the consuming repo\'s path — see this file\'s header.');
  }
  const configPath = join(root, '.spec-flow', 'config.json');
  const raw = existsSync(configPath) ? readFileSync(configPath, 'utf8') : null;

  let parsed = {};
  let source = 'defaults';

  if (raw !== null) {
    source = 'file';
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`.spec-flow/config.json is not valid JSON: ${err.message}`);
    }

    const declared = parsed.contract_version;
    if (declared !== SUPPORTED_VERSION) {
      throw new Error(
        `.spec-flow/config.json declares contract_version ${JSON.stringify(declared)}, and this engine understands ${SUPPORTED_VERSION}. ` +
          `Refusing to run: continuing would silently ignore whatever that version changed, which is a gate that looks armed and is not.`,
      );
    }
  }

  // The missing-file case runs through the SAME validation as a malformed
  // file, on purpose — see this file's header. It is not "load defaults and
  // proceed" any more; it is "load defaults and find out they are not enough".
  const config = merge(DEFAULTS, parsed);
  const problems = validate(config, source);
  if (problems.length > 0) {
    throw new Error(`.spec-flow/config.json is not usable:\n  - ${problems.join('\n  - ')}`);
  }

  return { ...config, _source: source };
}

// ---- CLI, for a human inspecting the contract ------------------------------

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  let config;
  try {
    config = loadConfig(root);
  } catch (err) {
    process.stderr.write(`spec-flow-config: ${err.message}\n`);
    process.exit(1);
  }

  const checks = config.extra_checks.map((c) => c.name).join(', ') || '(none)';
  console.log(`spec-flow-config: OK — contract v${config.contract_version}, read from ${config._source} (${root}).`);
  console.log(`  lint:  ${config.verify.lint.join(' ')}`);
  console.log(`  test:  ${config.verify.test.join(' ')}`);
  console.log(`  scope: ${config.verify.scope_globs.join(', ')}`);
  console.log(`  extra checks: ${checks}`);
}
