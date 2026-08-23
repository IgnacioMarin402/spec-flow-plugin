#!/usr/bin/env node
/**
 * The only reader of `.spec-flow/config.json`. One reader means defaults,
 * validation and the version check exist once instead of in ten hooks.
 *
 *   import { loadConfig } from './spec-flow-config.mjs';
 *   const config = loadConfig(root);
 *
 * `root` is the consuming repo's directory, explicit rather than inferred,
 * and never where this script sits. Callers pass it from `CLAUDE_PROJECT_DIR`
 * (hooks) or `process.cwd()` (the CLI); resolving it from `import.meta.url`
 * would read the PLUGIN's contract, or none at all, and fail without saying so.
 *
 * **A missing file is not silent, and neither is an unreadable version.** No
 * test runner, linter or layer name is safe to assume for a repo this engine
 * has never seen, so the defaults carry only what has no stack-specific
 * content (`specs_dir`, the not-a-capability filenames) and everything naming
 * a tool or a layer is required. `validate()` runs on EVERY load, missing file
 * included, and says what is absent and where it goes.
 *
 * **Every caller MUST let a thrown error propagate — never catch it and fall
 * back to defaults.** Catching would make a version mismatch
 * indistinguishable from a missing file, handing a repo whose declared
 * version this engine cannot read someone else's values instead of a refusal
 * to run.
 */

import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
// The list of readable formats has one home, and it is the file that reads
// them. Restating it here would let a format be accepted by the contract and
// then rejected at the gate, which is the drift this import exists to refuse.
// Safe to import at module scope for the same reason unscoped-checks.mjs is:
// both ship inside this package, so neither is ever present without the other.
import { FORMATS as VALID_REPORT_FORMATS } from './test-report.mjs';

/** The contract this reader understands. A file declaring anything else stops the run. */
export const SUPPORTED_VERSION = 1;

/**
 * Kept as data rather than scattered through the file, so "the defaults" is
 * one thing you can read. Only fields with no stack-specific content get a
 * real value; anything that would have to guess a tool or a layer is left
 * empty and `validate()` requires it.
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
    // Two ways to answer "which tests RAN", and a repo declares at most one.
    //
    // `report` names a file the runner already writes and the FORMAT it is in;
    // the engine ships the reader (test-report.mjs). This is the default,
    // because `<skipped/>` is defined by the format rather than by the runner —
    // see ADR-005, which supersedes ADR-002's conclusion that an adopter must
    // therefore write code.
    //
    // `executed_tests` is argv whose stdout names those tests, one per line. It
    // remains the escape hatch for a runner with no standard report, and is
    // what every contract written before ADR-005 uses.
    //
    // Declaring NEITHER opts out of traceability. That is allowed and it is not
    // silent: spec-trace refuses the moment a requirement exists, because an
    // undeclared source and a satisfied check are otherwise the same green.
    report: null,
    executed_tests: [],
    not_a_capability: ['README.md', 'glossary.md'],
    // Off by default, because nothing this engine can read tells it whether a
    // repo routes skills at all — they arrive from the project, from installed
    // plugins, and from the user's own directory. Guessing wrong here does not
    // degrade, it fails a gate over a field the project was never going to use.
    // A project that DOES route them turns this on and gets "every live
    // milestone states its routing" as a machine fact.
    //
    // Deliberately NOT inferred from whether some milestone already names a
    // skill: that arms the check from an absence, so the first milestone that
    // should have routed one and did not is precisely the one that arms
    // nothing.
    require_skills_field: false,
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
 * Runs on EVERY load, including a missing file: "no contract yet" has no safe
 * generic answer for fields that name a tool or a layer.
 *
 * `scope_globs` is the one field whose CONTENT is judged, and the rule above
 * is what says why it may be: a wrong command fails loudly the first time it
 * runs, while a scope that matches nothing fails silently every time, by
 * disarming the only check scoped to it. See the branch itself.
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
  } else {
    // The one place this file judges CONTENT rather than shape, and the
    // exception is earned: these strings are handed to git as pathspecs, and
    // git's `*` already crosses `/`. So `*.ts` matches a file one directory
    // down as well as one in the root, while the form every JS developer
    // reaches for — `**/*.ts` — demands at least one directory and silently
    // drops the root; a `<dir>/**/*.ts` demands two and misses `<dir>/a.ts`
    // entirely. Both measured against a real repo before this was written.
    //
    // That is not "a wrong command, caught the first time the gate runs it",
    // which is the reasoning the rest of this function rests on. Nothing runs
    // wrongly: the scope comes back empty, `verify.lint` is never invoked, and
    // the history records `lint=-`, which is exactly what an honest milestone
    // that touched nothing in scope records. A green that means nothing is the
    // one failure this engine exists to close, so the shape that manufactures
    // it does not get to be a matter of taste.
    for (const [i, glob] of config.verify.scope_globs.entries()) {
      if (typeof glob !== 'string' || glob.length === 0) {
        problems.push(`verify.scope_globs[${i}] must be a non-empty string — got ${JSON.stringify(glob)}.`);
        continue;
      }
      if (glob.includes('**')) {
        problems.push(
          `verify.scope_globs[${i}] is ${JSON.stringify(glob)}, and \`**\` does not mean here what it means in npm, in a bundler config or in .gitignore. ` +
            `These are git PATHSPECS, where \`*\` already crosses \`/\`: write ${JSON.stringify(glob.replace(/\*\*\//g, '').replace(/\*\*/g, '*'))} and it matches at every depth. ` +
            `Left as written it matches only files at least one directory deep, so every file in the repo root falls out of scope — and an empty scope is not a failure anywhere: the linter is simply never invoked, and the gate records \`lint=-\`, which reads exactly like a milestone that honestly changed nothing in scope.`,
        );
      }
    }
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
  // These two say where a new test goes and what it is called — they do not
  // decide what counts as proof (ADR-001). Required anyway: an agent with no
  // answer to that invents a layout.
  if (!nonEmptyString(config.trace.proof_dir)) {
    problems.push(
      'trace.proof_dir must name the directory a new test goes in (e.g. "tests"). It is what an implementer is told when a requirement needs proof; it no longer decides what counts as proof, which is trace.executed_tests\' job.',
    );
  }
  if (!nonEmptyString(config.trace.proof_suffix)) {
    problems.push('trace.proof_suffix must name what a test file is called in this repo, e.g. ".spec.ts", ".test.ts" or "_test.py" — it tells an implementer what to name a new one.');
  }
  // At most one source, and neither is required — see the defaults above for
  // why opting out is a real contract. What is rejected here is declaring
  // BOTH: two answers to "which tests ran" means one of them is not being
  // read, and which one is not something an adopter should have to discover
  // from behaviour.
  const hasReport = config.trace.report !== null && config.trace.report !== undefined;
  const hasTranslator = nonEmptyArray(config.trace.executed_tests);

  if (hasReport && hasTranslator) {
    problems.push(
      'trace.report and trace.executed_tests are both declared, and only one can be read. Keep trace.report (the engine parses the file your runner writes) and delete trace.executed_tests, or the reverse — but say which.',
    );
  }

  if (hasReport) {
    if (!VALID_REPORT_FORMATS.includes(config.trace.report.format)) {
      problems.push(
        `trace.report.format must be one of ${VALID_REPORT_FORMATS.join(', ')} — got ${JSON.stringify(config.trace.report.format)}. ` +
          'These are report formats, not runners: most runners can emit one behind a flag, and the format is what defines how a skipped test is marked.',
      );
    }
    if (!nonEmptyString(config.trace.report.path)) {
      problems.push(
        'trace.report.path must name the file your test command writes, relative to the repo root, e.g. "reports/junit.xml". The engine does not run your tests a second time — it reads what the gate\'s own run produced.',
      );
    }
  }
  // A string here — `"true"`, `"yes"` — is the shape that would otherwise
  // arm the check by truthiness while the author believed they had written a
  // boolean, or worse, `"false"` disarming nothing. Rejected loudly instead:
  // this field decides whether a gate can fail, so a value this engine has to
  // interpret is not a value.
  if (typeof config.trace.require_skills_field !== 'boolean') {
    problems.push(
      'trace.require_skills_field, when present, must be true or false (a JSON boolean, not a quoted string). Omit it to leave the check off: the planner still fills the milestone\'s `Skills:` field and the reviewer still checks it — this only decides whether spec-trace fails a live milestone that lacks one.',
    );
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

/**
 * Creates the directory `trace.report.path` points into, before the suite runs.
 *
 * **Every caller that spawns `verify.test` must call this first**, and there
 * are two — the gate and `check-changed` — which already have to agree command
 * for command, so this is one more thing they cannot be allowed to differ on.
 *
 * The engine owns this because the engine causes it. `init` appends the
 * reporter flag itself now, so a runner that will not create its own output
 * directory gets handed a path that does not exist and dies on the adopter's
 * first run, holding a command this package wrote. Runners disagree about
 * this — some create it, some do not — and which ones is exactly the kind of
 * per-runner behaviour that does not belong in a table.
 *
 * Doing it at RUN time rather than at `init` time is the whole point: an empty
 * directory is not a thing git stores, so one created during setup is gone from
 * the next clone and CI meets the same ENOENT with nobody around to read it.
 *
 * @param {string} root Absolute path to the consuming repo.
 * @param {object} config A loaded contract.
 */
export function ensureReportDir(root, config) {
  const path = config?.trace?.report?.path;
  if (!path) return;
  const dir = dirname(isAbsolute(path) ? path : join(root, path));
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // Not fatal here: the suite is about to run and will say so far more
    // clearly than this could, and a report that never lands is already a
    // refusal spec-trace knows how to explain.
  }
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
