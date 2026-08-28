#!/usr/bin/env node
/**
 * Generate this repo's `.spec-flow/config.json`, plus the directories and the
 * `.gitignore` line the engine needs.
 *
 *   spec-flow init            # write it
 *   spec-flow init --force    # overwrite an existing contract
 *
 * A generator rather than a worked example, because an example is
 * unverifiable: nothing executes it, so a contract change leaves it silently
 * wrong while it still reads as authoritative. `init-fixture.mjs` asserts that
 * what this writes actually validates, so the same change turns CI red.
 *
 * **Nothing here guesses a value it cannot support** — a plausible-but-wrong
 * default runs, a missing one is reported. Every field lands in one of three
 * buckets and the summary says which:
 *
 *   detected   — read from what this repo already declares
 *   review     — inferred from a heuristic that is usually right; confirm it
 *   MISSING    — nothing could determine it. Left empty, so the contract does
 *                not validate until a human fills it in
 *
 * Detection reads what the REPO says rather than what this engine believes:
 * the test runner comes from the repo's own `test` script, never from a list
 * of runners this file knows about. See ADR-002 for why that limit holds even
 * where a list would be convenient.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, appendFileSync } from 'node:fs';
import { join, extname, sep } from 'node:path';
import { resolveBase } from './changed-files.mjs';
import { RUNTIMES, stripTargets, resolveLocalBin } from './argv.mjs';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'out', 'vendor', '.claude']);
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
// Package managers, which precede the real binary as `<pm> run <bin>` or
// `<pm> exec <bin>`. Only that exact shape is stripped: a bare `<pm> <word>`
// is ambiguous — the word may be a script name rather than a binary — and
// guessing there would name the wrong thing.
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const SUBCOMMANDS = new Set(['run', 'exec']);

// `RUNTIMES` comes from ./argv.mjs, shared with lint-on-write.mjs. An
// interpreter is not a test runner even when it is the first token of the
// test script: `node <a-script>` runs the tests, but "node" labels the gate's
// log sections, is matched against every Bash command by run-trace to spot a
// test run, and lands in `unscoped_denied.tools` — where it would deny EVERY
// node invocation while implementing. The argv stays correct; only the NAME
// is undeterminable, so it is reported rather than filled with this.

/** Every source file in the repo, repo-relative, skipping the noise directories. */
function sourceFiles(root, dir = root, found = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue; // a dangling symlink is not a source file
    }
    if (st.isDirectory()) sourceFiles(root, full, found);
    else if (SOURCE_EXTENSIONS.has(extname(entry))) found.push(full.slice(root.length + 1));
  }
  return found;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * `"vitest run --reporter dot"` -> `{ bin: 'vitest', args: ['run', ...] }`.
 * Wrapper prefixes are stripped, so a script written as `npm exec -- vitest
 * run` yields the same answer as one written as `vitest run`.
 */
/**
 * Why a script cannot become a contract argv, or null when it can.
 *
 * Both answers are the same kind of thing — something only a SHELL resolves,
 * in a field this engine spawns without one — and they are reported apart
 * because the remedies differ: a chain has to be split by a human, a quoted
 * argument usually just loses its quotes. A message naming the wrong one
 * sends someone to edit the wrong thing.
 *
 * Quoting is the half that reads as working. Splitting on whitespace KEEPS
 * the quote characters, so `--spec "test/**\/*.spec.js"` reaches the runner
 * as literal text, matches no file, and on any runner that exits 0 for an
 * empty match becomes a green gate over zero executed tests.
 */
function shellOnly(script) {
  if (!script) return null;
  if (/[&|;><]/.test(script)) return 'it chains or redirects commands, so it is not one runner invocation';
  if (/["']/.test(script)) {
    return 'it quotes an argument, and this engine spawns the argv directly — with no shell to remove the quotes, the runner receives them as part of the value';
  }
  return null;
}

function parseScript(script) {
  if (!script) return null;
  // The engine needs a single argv it can spawn. Anything a shell would have
  // had to resolve first is left to the human — see `shellOnly`.
  if (shellOnly(script)) return null;

  const tokens = script.trim().split(/\s+/).filter(Boolean);

  if (tokens[0] === 'npx') tokens.shift();
  if (PACKAGE_MANAGERS.has(tokens[0]) && SUBCOMMANDS.has(tokens[1])) tokens.splice(0, 2);
  while (tokens[0] === '--') tokens.shift();
  if (tokens.length === 0) return null;

  const bin = tokens[0];
  const args = tokens.slice(1);

  // `bun test` / `deno test` — the runtime IS the runner here, so the name is
  // real. `node <a-script>` is the other case, and `named` says which.
  const named = !RUNTIMES.has(bin) || args[0] === 'test';

  return { bin, args, named };
}

/**
 * The argv the contract should carry for a parsed script, preferring the
 * local binary.
 *
 * `stripTargets` is applied for `verify.lint` and `verify.lint_no_fix` only,
 * because those are the two the engine APPENDS changed file paths to. A lint
 * script is almost always written with a target — `eslint .` — and carrying
 * that target into the contract produces `eslint . <changed-file>`, which
 * lints the whole repo. Not a slow lint: a disarmed one, since the scoping
 * exists precisely so a milestone is never judged on files it never touched.
 *
 * `verify.test` runs with no arguments appended, so its own targets are the
 * repo's deliberate choice and are left exactly as written.
 */
function toArgv(root, parsed, { stripTrailingTargets = false } = {}) {
  const args = stripTrailingTargets
    ? stripTargets(parsed.args, root)
    : { argv: parsed.args, stripped: [], remaining: [] };
  // Past the `.bin` shim, never at it: what that name points to differs by
  // platform, and this argv is written into a file the team commits. See
  // `resolveLocalBin`. A bin it cannot resolve keeps the bare name, which
  // resolves through PATH the way the script the repo already runs does.
  const entrypoint = resolveLocalBin(root, parsed.bin);
  const argv = entrypoint ? ['node', entrypoint, ...args.argv] : [parsed.bin, ...args.argv];
  return { argv, stripped: args.stripped, remaining: args.remaining };
}

/** A root-level config file belonging to `bin`, e.g. `<bin>.config.*` or `.<bin>rc*`. */
function findConfigFile(root, bin) {
  if (!bin) return '';
  let entries;
  try {
    entries = readdirSync(root);
  } catch {
    return '';
  }
  const match = entries.find((e) => {
    const lower = e.toLowerCase();
    return lower.startsWith(`${bin}.config.`) || lower.startsWith(`.${bin}rc`) || lower === `${bin}.json`;
  });
  return match ?? '';
}

/** Source extensions carrying real weight, most common first, capped. */
function detectScopeGlobs(files) {
  const counts = new Map();
  for (const f of files) counts.set(extname(f), (counts.get(extname(f)) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([ext]) => `*${ext}`);
}

/** `user.test.ts` -> `.test.ts`. Null when the name carries no test marker. */
function testSuffix(file) {
  const match = /(\.(?:test|spec)\.[a-z]+)$/i.exec(file);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Where this repo's tests live, as a directory SEGMENT plus a filename suffix.
 *
 * The segment is chosen for how well it discriminates: one that appears in
 * test paths and in no other source path identifies a test by itself, which
 * is what `spec-trace` needs. When no segment is exclusive — tests colocated
 * beside the code they prove — nothing can identify a proof file by directory
 * alone, so the most common top-level segment is offered for REVIEW rather
 * than presented as detected.
 */
function detectProof(files) {
  const tests = files.filter((f) => testSuffix(f));
  if (tests.length === 0) return { suffix: '', dir: '', confident: false };

  const suffixes = new Map();
  for (const f of tests) {
    const s = testSuffix(f);
    suffixes.set(s, (suffixes.get(s) ?? 0) + 1);
  }
  const suffix = [...suffixes.entries()].sort((a, b) => b[1] - a[1])[0][0];

  const nonTests = files.filter((f) => !testSuffix(f));
  const segmentsOf = (f) => f.split(sep).slice(0, -1);

  const inTests = new Map();
  for (const f of tests) for (const seg of new Set(segmentsOf(f))) inTests.set(seg, (inTests.get(seg) ?? 0) + 1);

  const inOthers = new Set();
  for (const f of nonTests) for (const seg of segmentsOf(f)) inOthers.add(seg);

  const exclusive = [...inTests.entries()]
    .filter(([seg]) => !inOthers.has(seg))
    .sort((a, b) => b[1] - a[1])[0];
  if (exclusive) return { suffix, dir: exclusive[0], confident: true };

  const common = [...inTests.entries()].sort((a, b) => b[1] - a[1])[0];
  return { suffix, dir: common ? common[0] : '', confident: false };
}

/** The package manager this repo uses, from its lockfile. Only affects prose. */
function detectPackageManager(root) {
  for (const [file, name] of [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'],
  ]) {
    if (existsSync(join(root, file))) return name;
  }
  return 'npm';
}

// ---- build the contract ----------------------------------------------------

/**
 * The report path a test command already names, or null.
 *
 * Deliberately looks for a PATH and not for a flag. `--junitxml=`, `--reporter`
 * and `--reporters` are each one runner's spelling, and a table of them is the
 * rotting stack list ADR-002 refused; an argv token ending in `.xml` is a fact
 * about this repo's own command. It is reported as REVIEW either way, because
 * a command may name an XML file for some other reason entirely.
 *
 * `=`-joined forms are split first, so `--junitxml=reports/x.xml` yields the
 * path without this function knowing what the left-hand side means.
 */
/**
 * How each supported runner is told to write a report, keyed by the name `init`
 * already read off the `test` script.
 *
 * **This table is the thing ADR-002 refused, and ADR-007 is why it is here.**
 * The refusal was that a per-runner list rots and is "precisely the artifact
 * that looks maintained and quietly is not" — an argument about maintenance
 * cost, which was decisive while the list had to span every ecosystem and is
 * proportionate now that the supported scope is Node.
 *
 * So it is small on purpose, and it stays small: a runner nobody here has RUN
 * does not belong in it. Every entry below was verified by installing the
 * runner and reading the file that appeared. An unknown runner is not a
 * failure — it falls through to the same REVIEW line this table replaced.
 *
 * `argv` returns tokens appended to the test command. `note` says what a flag
 * alone cannot express, and exists for exactly one reason: not every runner can
 * be configured from argv, and pretending otherwise would write a command that
 * runs clean and produces no file — a check that looks armed and is not.
 */
const REPORTER_FLAGS = {
  vitest: { argv: (path) => ['--reporter=junit', `--outputFile=${path}`] },
  mocha: { argv: (path) => ['--reporter', 'xunit', '--reporter-option', `output=${path}`] },
  node: { argv: (path) => ['--test-reporter=junit', `--test-reporter-destination=${path}`] },
  jest: {
    argv: () => ['--reporters=default', '--reporters=jest-junit'],
    note: (path) =>
      `jest reports through a separate package: install jest-junit, and point its output at "${path}" (a "jest-junit" key in package.json, or JEST_JUNIT_OUTPUT_FILE). ` +
      `The flag alone will not write the file, which is why this is the one entry that cannot be finished from argv.`,
  },
};

/**
 * Which entry of `REPORTER_FLAGS` this test command is, or null.
 *
 * Not simply `test_name`, and the gap is the most common zero-dependency Node
 * setup there is. `"test": "node --test"` leaves `test_name` MISSING on purpose
 * — the bin is an interpreter, and `test_name` is substring-matched against
 * Bash commands to spot a test run, so "node" there would match nearly
 * everything. The RUNNER is still knowable from the same argv: `--test` is what
 * makes that invocation a test run rather than a script.
 */
function reporterKey(testArgv, testName) {
  if (testName && REPORTER_FLAGS[testName]) return testName;
  const bin = (testArgv?.[0] ?? '').replace(/\\/g, '/').split('/').pop();
  if (bin === 'node' && testArgv.includes('--test')) return 'node';
  return null;
}

function detectReportPath(testArgv) {
  for (const token of testArgv ?? []) {
    const value = token.includes('=') ? token.slice(token.indexOf('=') + 1) : token;
    if (/\.xml$/i.test(value) && !value.startsWith('-')) return value.replace(/\\/g, '/');
  }
  return null;
}

export function buildContract(root) {
  const detected = [];
  const review = [];
  const missing = [];

  const pkg = readJson(join(root, 'package.json')) ?? {};
  const scripts = pkg.scripts ?? {};
  const files = sourceFiles(root);
  const pm = detectPackageManager(root);

  // --- test runner
  const testScript = parseScript(scripts.test);
  let test = [];
  let testName = '';
  if (testScript) {
    test = toArgv(root, testScript).argv;
    detected.push(`verify.test — from the "test" script: ${test.join(' ')}`);
    if (testScript.named) {
      testName = testScript.bin;
    } else {
      missing.push(
        `verify.test_name — the test script runs through "${testScript.bin}", an interpreter rather than a runner, so nothing here can name what actually runs your tests. It labels the gate's log sections and is matched against Bash commands to spot a test run, so a wrong value is worse than an empty one.`,
      );
    }
  } else {
    const why = shellOnly(scripts.test);
    missing.push(
      why
        ? `verify.test and verify.test_name — the "test" script (${scripts.test}) could not be read: ${why}. Write the argv by hand, one token per array element and no quotes around any of them.`
        : 'verify.test and verify.test_name — no single-command "test" script to read them from.',
    );
  }

  // --- linter. An autofix variant is used when the repo declares one; it is
  // never invented, because `--fix` is not universal and a flag this file
  // guessed would fail at the first gate rather than here.
  const lintScript = parseScript(scripts.lint);
  const fixScript = parseScript(scripts['lint:fix'] ?? scripts.format);
  let lint = [];
  let lintNoFix = [];
  let lintName = '';
  if (lintScript || fixScript) {
    const base = lintScript ?? fixScript;
    if (base.named) {
      lintName = base.bin;
    } else {
      missing.push(
        `verify.lint_name — the lint script runs through "${base.bin}", an interpreter rather than a linter, so nothing here can name it.`,
      );
    }
    const noFix = toArgv(root, lintScript ?? base, { stripTrailingTargets: true });
    const withFix = fixScript ? toArgv(root, fixScript, { stripTrailingTargets: true }) : noFix;
    lintNoFix = noFix.argv;
    lint = withFix.argv;

    const stripped = [...new Set([...noFix.stripped, ...withFix.stripped])];
    if (stripped.length > 0) {
      review.push(
        `verify.lint dropped the target(s) ${stripped.map((s) => `"${s}"`).join(', ')} from your lint script. The engine appends the changed files itself, and leaving a target in would lint the whole repo on every gate — which silently undoes the scoping that keeps a milestone from being blocked by debt it never touched. Confirm this is still the linter invocation you want.`,
      );
    }

    // A path-shaped token sitting after a flag cannot be told apart from that
    // flag's value, so it is left alone — and said out loud, because if it IS
    // a target the gate will quietly lint the whole repo on every run.
    const remaining = [...new Set([...noFix.remaining, ...withFix.remaining])];
    if (remaining.length > 0) {
      review.push(
        `verify.lint still contains ${remaining.map((s) => `"${s}"`).join(', ')}, which follows a flag — so it may be that flag's value, or it may be a target. If it is a target, remove it: the engine appends the changed files itself, and a target left in makes every gate lint the whole repo instead of the branch's changes.`,
      );
    }

    detected.push(`verify.lint_no_fix — from the "lint" script: ${lintNoFix.join(' ')}`);
    if (fixScript) {
      detected.push(`verify.lint — from the autofix script: ${lint.join(' ')}`);
    } else {
      review.push(
        'verify.lint is identical to verify.lint_no_fix — no autofix script was declared. If your linter supports one (commonly --fix), add it to verify.lint so the gate stops reporting violations it could have fixed.',
      );
    }
  } else {
    const why = shellOnly(scripts.lint) ?? shellOnly(scripts['lint:fix'] ?? scripts.format);
    missing.push(
      why
        ? `verify.lint, verify.lint_no_fix and verify.lint_name — the lint script could not be read: ${why}. Write the argv by hand, one token per array element and no quotes around any of them.`
        : 'verify.lint, verify.lint_no_fix and verify.lint_name — no single-command "lint" script to read them from.',
    );
  }

  const lintConfigHint = findConfigFile(root, lintName);
  if (lintConfigHint) detected.push(`verify.lint_config_hint — found ${lintConfigHint}`);
  else if (lintName) missing.push('verify.lint_config_hint — no config file for the linter was found in the repo root.');
  else missing.push('verify.lint_config_hint — depends on the linter, which was not detected.');

  // --- scope
  const scopeGlobs = detectScopeGlobs(files);
  if (scopeGlobs.length > 0) detected.push(`verify.scope_globs — ${scopeGlobs.join(', ')}, from the files in this repo`);
  else missing.push('verify.scope_globs — no source extension had enough files to infer one.');

  // --- base branch
  let baseRef = '';
  try {
    resolveBase(root);
    detected.push('verify.base_ref — omitted: the base branch resolves automatically here');
  } catch {
    missing.push(
      'verify.base_ref — no base branch could be resolved. Set it to the ref this work is judged against, e.g. "origin/trunk".',
    );
  }

  // --- proof surface
  const proof = detectProof(files);
  if (proof.suffix && proof.confident) {
    detected.push(`trace.proof_dir and trace.proof_suffix — "${proof.dir}" + "${proof.suffix}"`);
  } else if (proof.suffix) {
    review.push(
      `trace.proof_dir is "${proof.dir}" — a guess. Your tests are not in a directory of their own, so no segment identifies one. This is also where agents are told to PUT new tests, so confirm it.`,
    );
  } else {
    missing.push(
      'trace.proof_dir and trace.proof_suffix — no test files were found. These say what a proof file looks like AND where agents put new ones.',
    );
  }

  // --- how this repo reports what RAN
  //
  // REVIEW, not MISSING, and that is the whole of ADR-005 arriving here: what
  // an adopter owes is no longer a translator they write but a report their
  // runner already knows how to emit, and a repo with no requirements yet owes
  // nothing at all. `init` exiting non-zero over it would refuse to finish
  // setting up a repo whose gate would already run clean.
  const namedReport = detectReportPath(test);
  const reportPath = namedReport ?? 'reports/junit.xml';
  const runner = namedReport ? null : reporterKey(test, testName);
  const flag = runner ? REPORTER_FLAGS[runner] : null;

  if (namedReport) {
    review.push(
      `trace.report — your test command already names "${namedReport}", so the contract points at it and assumes JUnit XML. Confirm that is what lands there; if it is TAP, change the format to "tap".`,
    );
  } else if (flag) {
    // The flag is APPENDED to the command rather than proposed in prose,
    // because a flag a human still has to type is the step this whole table
    // exists to remove. It is still REVIEW: appending to someone's test command
    // is an edit to how their suite runs, and a reader has to see it.
    test = [...test, ...flag.argv(reportPath)];
    review.push(
      `verify.test — appended \`${flag.argv(reportPath).join(' ')}\` so ${runner} writes the report the traceability check reads. ` +
        `Run your suite once and confirm "${reportPath}" appears.${flag.note ? ` ${flag.note(reportPath)}` : ''}`,
    );
  } else {
    review.push(
      `trace.report — set to "${reportPath}", a convention rather than a reading${testName ? `, because "${testName}" is not a runner this version knows the reporter flag for` : ''}. ` +
        `Add your runner's flag to verify.test so a JUnit XML (or TAP) report lands there — the format is what tells a skipped test from an executed one. ` +
        `Until it lands, traceability is off — the gate still lints and tests, and spec-trace refuses the moment ${'specs'}/ declares a requirement it cannot prove. ` +
        `A runner with no standard report uses trace.executed_tests instead: see REFERENCE.md.`,
    );
  }

  const denyScripts = ['test', 'lint'].filter((s) => scripts[s]);
  const denyTools = [testName, lintName].filter(Boolean);

  const contract = {
    contract_version: 1,
    verify: {
      scope_globs: scopeGlobs,
      lint,
      lint_no_fix: lintNoFix,
      test,
      test_name: testName,
      lint_name: lintName,
      lint_config_hint: lintConfigHint,
    },
    trace: {
      specs_dir: 'specs',
      proof_dir: proof.dir,
      proof_suffix: proof.suffix,
      // The engine parses this file itself (test-report.mjs), so the contract
      // is complete from the first run and nothing in the repo has to be
      // written by hand. `executed_tests` is deliberately absent rather than
      // present-and-empty: the two are one source too many, and the contract
      // rejects declaring both.
      report: { format: 'junit', path: reportPath },
      not_a_capability: ['README.md', 'glossary.md'],
      // Written out at its default rather than omitted, so the choice is
      // visible in the file instead of being a behaviour of the engine the
      // repo would have to read the reference to discover. Off is the default
      // this engine can honestly hold: whether a project routes skills is not
      // something any file here can detect, since skills also come from
      // installed plugins and the user's own directory.
      require_skills_field: false,
    },
    extra_checks: [],
    unscoped_denied: {
      scripts: denyScripts,
      tools: denyTools,
      scoped_allowed: ['check'],
      scoped_alternative: `${pm} run check`,
      scoped_examples: [`${pm} run check`, `${pm} run check --no-fix`],
    },
  };

  if (baseRef) contract.verify.base_ref = baseRef;

  return { contract, detected, review, missing };
}

/**
 * The `trace.executed_tests` translator, scaffolded into the adopting repo.
 *
 * Not generated FOR a runner — see ADR-002 for why that limit is deliberate.
 *
 * So this writes the part that is the same for every runner — the contract,
 * the shape, and a failure loud enough that nobody ships without noticing —
 * and leaves the four lines that differ.
 *
 * Deliberately NOT silent when incomplete: a stub that exited 0 reporting
 * nothing would turn every requirement unproven at the first gate — the
 * failure this engine exists to close, arriving through the file meant to
 * prevent it.
 */
function translatorStub(testName) {
  const runner = testName ? `\`${testName}\`` : 'your test runner';
  return `#!/usr/bin/env node
// Tells spec-flow which tests actually RAN.
//
// The contract is one line per executed test, on stdout, each line containing
// that test's name. A requirement counts as proven when a reported line
// contains its id (REQ-USER-001). Nothing else is read: not the exit code, not
// the format, not where the test file lives.
//
// TWO RULES, and the second is the one that matters:
//
//   1. Lines must carry test NAMES, since ids are matched inside them. An id
//      may sit against underscores — REQ-USER-001_rejects binds fine.
//   2. A test that was SKIPPED must not appear. That absence is what makes
//      skipping useless as a way to silence a red suite, and it is why the
//      rule holds in any language.
//
// This runs AFTER the suite, in the same gate invocation, so it should read
// what that run produced rather than run the tests again.
//
// ---------------------------------------------------------------------------
// TODO — this is the part only you can write. It was left empty on purpose:
// every runner can report what it executed and no two agree on how, so a
// guess here would produce a command that runs and reports nothing.
//
// For ${runner}: find the reporter flag that writes a machine-readable report
// (most runners have one — JUnit XML, JSON, TAP), have your test command emit
// it, then read that file here and print one line per test that RAN.
// ---------------------------------------------------------------------------

function testsThatRan() {
  // Return an array of strings, one per executed test, e.g.
  //   ['tests/auth_test::REQ-USER-001 rejects a bad password']
  return null; // <- replace this
}

const names = testsThatRan();

if (names === null) {
  console.error(
    'spec-flow: .spec-flow/tests-that-ran.mjs has not been written yet.\\n' +
      'Until it reports the tests that ran, no requirement can be proven — and this\\n' +
      'fails loudly rather than reporting your specs as unproven, which would be the\\n' +
      'same mistake this check exists to catch. See REFERENCE.md, "executed_tests".',
  );
  process.exit(1);
}

for (const name of names) console.log(name);
`;
}

/**
 * The contract for writing a capability spec, scaffolded into the repo.
 *
 * Two agent contracts tell their reader that "`specs/README.md` has the
 * contract" — the spec-writer before writing one, the implementer before
 * creating a capability spec that does not exist yet. Nothing shipped or
 * created that file, so both deferred to a document that was not there, and
 * the three rules `spec-trace` actually enforces (the heading shape, the
 * filename→prefix binding, the scope marker) were written down only as
 * regexes. A human writing their first spec by hand met three validations
 * with no documentation behind any of them.
 *
 * `trace.not_a_capability` excludes this filename by default, so the engine
 * already assumed it would exist.
 */
const SPECS_README = `# Capability specs

One file per capability, describing what the system does **today** as numbered
requirements. \`specs/\` is the source of truth for behaviour; a change under
\`specflow/\` is a delta against it.

\`spec-trace\` enforces the rules below at every gate, in both directions: a
requirement with no test fails, and a test naming an id no spec declares fails
too.

## The file

Each spec starts with a scope marker naming the code it is about:

\`\`\`markdown
<!-- spec-scope: modules/user -->

# User

### REQ-USER-001 — the user can reset their password by email

The system sends a single-use link, valid for one hour.
\`\`\`

## The rules

- **The id prefix comes from the filename.** \`specs/user.md\` declares
  \`REQ-USER-\` ids; \`specs/user-profile.md\` declares \`REQ-USER-PROFILE-\`.
  A mismatch fails.
- **The number is exactly three digits.** \`REQ-USER-001\`, not \`REQ-USER-1\`.
- **Requirements are headings**, at \`###\`, with the id first. The separator
  after it may be an em dash, a hyphen or a colon.
- **Ids are permanent.** Never renumber, never reuse a removed one. New ids
  continue that capability's sequence.
- **Every requirement needs a test whose TITLE contains its id**, on the proof
  surface \`.spec-flow/config.json\` declares (\`trace.proof_dir\` +
  \`trace.proof_suffix\`). A test under \`it.skip\`, \`it.todo\`, \`xit\` or
  \`xtest\` does not count — a test that never executes proves nothing.
- **Write in the present tense**: what the system does, not what a change did.

This file is excluded from the check by \`trace.not_a_capability\`, so it is
documentation rather than a spec.
`;

/**
 * The `check` alias, added when the repo has none.
 *
 * `unscoped_denied.scoped_alternative` is the only thing `no-gate-cmds`
 * offers an implementer it has just denied, and that hook prints it three
 * times. Pointed at a script the repo does not have, a stuck implementer gets
 * `Missing script: "check"` — from a hook that says in its own source it is
 * evadable, which makes evasion the thing the guard rail teaches.
 *
 * `spec-flow check`, never `npx spec-flow check`: npx in a repo that has NOT
 * installed the dependency reaches the registry, where that name belongs to
 * an unrelated package — the hazard the README spells out. A script resolves
 * through `node_modules/.bin` and fails plainly when the dependency is
 * missing. The alias is the one `bin/spec-flow.mjs` already documents.
 *
 * Never replaces a `check` the repo wrote itself, on the same rule as
 * `specs/README.md`: this is the adopter's file, and their command wins.
 */
function ensureCheckScript(root) {
  const path = join(root, 'package.json');
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }

  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (pkg.scripts?.check) return null;

  // The file's own indentation, so adding one line does not reformat a file
  // the adopter has to read the diff of.
  const indent = /\n([ \t]+)"/.exec(raw)?.[1] ?? '  ';
  pkg.scripts = { ...pkg.scripts, check: 'spec-flow check' };
  try {
    writeFileSync(path, `${JSON.stringify(pkg, null, indent)}\n`);
  } catch {
    return null;
  }

  // Writing the script is not the same as the script working, and the gap
  // between those two is the shape this whole fix was about. The alias needs
  // the dependency — which an adopter following the README already has, and
  // one running these scripts by path does not. Said here rather than
  // discovered at the first denial, where the reader is an implementer that
  // cannot install anything.
  //
  // Presence of the SHIM, deliberately, not `resolveLocalBin`: that answers
  // "where is the real JavaScript", which is what a committed argv needs and
  // not what this asks. `npm run` puts `node_modules/.bin` on PATH and runs
  // whatever is there, symlink or shell script or `.cmd`, so the shim
  // existing in any of its shapes is the whole condition.
  const shim = join(root, 'node_modules', '.bin', 'spec-flow');
  const installed = existsSync(shim) || existsSync(`${shim}.cmd`);

  return installed
    ? 'added a "check" script to package.json — it runs the gate\'s own commands, scoped to this branch, and is what the deny hook points an implementer at'
    : 'added a "check" script to package.json — it is what the deny hook points an implementer at, and it resolves through node_modules/.bin, which does not carry spec-flow yet. Install the engine as a devDependency (README step 2), or the script exits "spec-flow: not found"';
}

/**
 * Creates the directories, the specs contract, the gitignore lines and the
 * `check` alias. Returns what it changed.
 *
 * `reportPath` is `trace.report.path` from the contract just written, and it
 * is a parameter rather than a re-read because the caller has the contract in
 * hand and a second reader of it could disagree with the first.
 */
export function scaffold(root, reportPath = '') {
  const done = [];

  for (const dir of ['specs', join('specflow', 'archive')]) {
    if (!existsSync(join(root, dir))) {
      mkdirSync(join(root, dir), { recursive: true });
      done.push(`created ${dir.replace(/\\/g, '/')}/`);
    }
  }

  // Never overwritten: a repo that has written its own conventions here keeps
  // them, and this is documentation rather than engine state.
  const specsReadme = join(root, 'specs', 'README.md');
  if (!existsSync(specsReadme)) {
    writeFileSync(specsReadme, SPECS_README);
    done.push('created specs/README.md — the capability-spec contract');
  }

  // Two paths this engine makes a repo churn, and both have to be ignored or
  // the gate stops judging. `.claude/state/` is the gate's own bookkeeping,
  // rewritten on every stop. `trace.report.path` is the file the SUITE
  // writes — and the gate is what runs the suite, so it lands in the tree on
  // every armed invocation and the NEXT stop reads it as an implementer
  // mid-write. Left out, a run alternates pass / skip-dirty for its whole
  // length: every other milestone judged, the rest not, and a skip is not a
  // failure, so nothing anywhere says so.
  //
  // The report is ignored by its DIRECTORY where it has one. That is the
  // surface a runner actually fills — several drop siblings beside the file
  // this contract names — and it is also what git reports when the directory
  // is untracked, which is the state the first gate leaves it in.
  const lines = ['.claude/state/'];
  const reportDir = reportPath ? reportPath.replace(/\\/g, '/').split('/')[0] : '';
  if (reportPath) lines.push(reportDir && reportDir !== reportPath ? `${reportDir}/` : reportPath);

  const gitignore = join(root, '.gitignore');
  let current = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : '';
  for (const line of lines) {
    if (current.split('\n').some((l) => l.trim() === line)) continue;
    const prefix = current && !current.endsWith('\n') ? '\n' : '';
    appendFileSync(gitignore, `${prefix}${line}\n`);
    // Kept in step with the file, so the second line's own "already there?"
    // question is asked against what the first one just wrote.
    current += `${prefix}${line}\n`;
    done.push(`added ${line} to .gitignore`);
  }

  const checkScript = ensureCheckScript(root);
  if (checkScript) done.push(checkScript);

  return done;
}

// ---- CLI -------------------------------------------------------------------

import { fileURLToPath } from 'node:url';
import { loadConfig } from './spec-flow-config.mjs';

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const force = process.argv.includes('--force');
  const wantsTranslator = process.argv.includes('--translator');
  const configPath = join(root, '.spec-flow', 'config.json');

  if (existsSync(configPath) && !force) {
    console.log(`spec-flow init: .spec-flow/config.json already exists. Nothing written.`);
    console.log(`  Pass --force to overwrite it, or edit it directly — every field is in REFERENCE.md.`);
    process.exit(0);
  }

  const { contract, detected, review, missing } = buildContract(root);

  mkdirSync(join(root, '.spec-flow'), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(contract, null, 2)}\n`);
  console.log(`spec-flow init: wrote .spec-flow/config.json\n`);

  // Opt-in since ADR-005, because the contract no longer points at it. A file
  // nothing references is the artifact this repo deleted `skills.md` over: it
  // can rot for months and the only person who finds out is whoever trusted
  // it. The escape hatch still has to EXIST — a runner with no standard report
  // is a real repo — so the stub is one flag away and REFERENCE documents the
  // field it fills.
  //
  // Never overwritten, and **`--force` does NOT extend to it.** The README
  // tells an adopter to fill fields in and re-run with `--force`, so a
  // `--force` that replaced this file would destroy their translator on the
  // exact command they were told to run — silently, since a fresh stub reports
  // nothing. Regenerating a stub costs a delete; losing working code costs the
  // work. Someone who wants a clean one removes the file.
  const translator = join(root, '.spec-flow', 'tests-that-ran.mjs');
  if (wantsTranslator && !existsSync(translator)) {
    writeFileSync(translator, translatorStub(contract.verify.test_name));
    console.log(
      `  wrote     .spec-flow/tests-that-ran.mjs — point "trace" at it with "executed_tests": ["node", ".spec-flow/tests-that-ran.mjs"] and delete "report".\n`,
    );
  }

  for (const line of scaffold(root, contract.trace.report?.path)) console.log(`  ${line}`);
  if (detected.length > 0) console.log('');

  for (const line of detected) console.log(`  detected  ${line}`);
  for (const line of review) console.log(`  REVIEW    ${line}`);
  for (const line of missing) console.log(`  MISSING   ${line}`);

  // The written file goes through the SAME reader every hook uses, so this
  // summary can never disagree with what the engine will say at the first
  // gate — which is the whole point of ending here rather than at "written".
  console.log('');
  try {
    loadConfig(root);
  } catch (err) {
    console.log(`The contract is NOT usable yet:\n${err.message}`);
    console.log('\nFill the fields above and re-run this command with --force, or edit the file directly.');
    process.exit(1);
  }

  // A MISSING line is unfinished business even when the reader accepts the
  // file. `base_ref` is the case that separates the two: it is optional to
  // the reader — most repos resolve a base without it — but when resolution
  // fails HERE, it will fail at the first gate too, and the gate blocks. So
  // the exit code follows the MISSING list rather than validation alone;
  // reporting "valid" over a field that will stop the first run is the kind
  // of half-truth this engine exists to refuse.
  if (missing.length > 0) {
    console.log(
      `The contract validates, but ${missing.length} field(s) above still need you. ` +
        `Fill them in and re-run with --force, or edit the file directly.`,
    );
    process.exit(1);
  }

  console.log(
    review.length > 0
      ? 'The contract is valid and the engine will run. Confirm the REVIEW line(s) above first — they are inferences, not readings.'
      : 'The contract is valid. Run your checks with `spec-flow check`, then start with /spec-flow.',
  );
}
