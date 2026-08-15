#!/usr/bin/env node
/**
 * Generate this repo's `.spec-flow/config.json`, plus the directories and the
 * `.gitignore` line the engine needs.
 *
 *   spec-flow init            # write it
 *   spec-flow init --force    # overwrite an existing contract
 *
 * This exists instead of a worked example file. An example has to be found,
 * copied, and then translated into the reader's repo — three steps where the
 * reader supplies the values, which are exactly the values they do not know
 * yet. Worse, a static example is unverifiable: nothing executes it, so a
 * contract change leaves it silently wrong while it still reads as
 * authoritative. This is code, so `init-fixture.mjs` can assert that what it
 * writes actually validates, and a contract change that breaks it turns CI
 * red instead of misleading the next adopter.
 *
 * **Nothing here guesses a value it cannot support.** That rule comes from
 * spec-flow-config.mjs's own header: a plausible-but-wrong default is worse
 * than a missing one, because the missing one is reported and the wrong one
 * runs. So every field is placed in one of three buckets and the summary says
 * which is which:
 *
 *   detected   — read from what this repo already declares
 *   review     — inferred from a heuristic that is usually right; confirm it
 *   MISSING    — nothing could determine it. Left empty, so the contract does
 *                not validate until a human fills it in
 *
 * Detection reads what the REPO says rather than what this engine believes.
 * The test runner comes from the repo's own `test` script, not from a list of
 * runners this file knows about — a list would be this engine having an
 * opinion about stacks, which is the coupling the whole extraction removed,
 * and it would silently fail to detect anything not on it.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, appendFileSync } from 'node:fs';
import { join, extname, sep } from 'node:path';
import { resolveBase } from './changed-files.mjs';
import { RUNTIMES, stripTargets } from './argv.mjs';

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
function parseScript(script) {
  if (!script) return null;
  // A script chaining commands is not one runner invocation; the engine needs
  // a single argv it can spawn, so anything compound is left to the human.
  if (/[&|;><]/.test(script)) return null;

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
  const local = join('node_modules', '.bin', parsed.bin);
  const argv = existsSync(join(root, local))
    ? ['node', local, ...args.argv]
    : [parsed.bin, ...args.argv];
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
    missing.push('verify.test and verify.test_name — no single-command "test" script to read them from.');
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
    missing.push('verify.lint, verify.lint_no_fix and verify.lint_name — no single-command "lint" script to read them from.');
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
  // Always MISSING, and that is this file's own rule rather than an omission:
  // it never invents a value it could not determine, and there is nothing in a
  // repo that says how its runner can be made to list the tests it executed.
  // Every runner can do it and no two agree on how, so a guess here would
  // produce a command that runs and reports nothing — which spec-trace refuses
  // loudly, but only after an adopter has wondered why.
  //
  // This is the one field a fully discoverable repo still has to write by
  // hand. Teaching `init` the common runners is a real improvement and belongs
  // to `init`, not to the engine: a generator may know technologies because it
  // reads what the repo already declares about itself, while the checker may
  // not, because it has to be right about repos nobody has seen.
  missing.push(
    'trace.executed_tests — argv whose output lists the tests that RAN, one per line, e.g. ["node", "tools/tests-that-ran.mjs"]. ' +
      'A requirement counts as proven when a reported line contains its id, so the lines need to carry test NAMES. ' +
      'Most runners emit this behind a reporter flag (JUnit XML, JSON, TAP); the small script that turns your runner\'s output into lines belongs in your repo, not in the engine, so that changing runners changes your script and nothing else. ' +
      'A test that was skipped must not appear — that absence is what makes skipping useless as a way to silence this check.',
  );

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
      // Empty on purpose — see the MISSING entry above. A plausible wrong
      // value would run; an empty one is reported.
      executed_tests: [],
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

/** Creates the directories, the specs contract and the gitignore line. Returns what it changed. */
export function scaffold(root) {
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

  const gitignore = join(root, '.gitignore');
  const line = '.claude/state/';
  const current = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : '';
  if (!current.split('\n').some((l) => l.trim() === line)) {
    appendFileSync(gitignore, `${current && !current.endsWith('\n') ? '\n' : ''}${line}\n`);
    done.push(`added ${line} to .gitignore`);
  }

  return done;
}

// ---- CLI -------------------------------------------------------------------

import { fileURLToPath } from 'node:url';
import { loadConfig } from './spec-flow-config.mjs';

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const force = process.argv.includes('--force');
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

  for (const line of scaffold(root)) console.log(`  ${line}`);
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
