#!/usr/bin/env node
/**
 * The setup skill and the engine agree about the contract.
 *
 * `skills/spec-flow-setup/SKILL.md` is prose a model acts on, which makes it
 * the one shipped instruction with no compiler and no runtime behind it. It
 * tells the model which script to run, which labels to read in that script's
 * output, which contract fields to fill, and what a wrong reporter flag looks
 * like when it fails. Every one of those is a claim about code in this package,
 * and every one of them goes stale silently: rename a label and the skill still
 * reads correctly, still ships, and sends the model looking for a word that is
 * no longer printed.
 *
 * That is the same defect `agent-contracts.mjs` closes one layer over — the
 * planner and the reviewer agreeing about a milestone's fields — and it arrives
 * here for the same reason. See ADR-006 for why the runner knowledge this skill
 * carries is deliberately NOT in this package, and why what remains has to be
 * bound to the engine instead.
 *
 * What this does NOT check, and cannot: whether the model picks the right flag.
 * CI has no model in it. The last case below is the reason that gap is
 * survivable rather than fatal — it holds the engine to failing LOUDLY when the
 * flag is wrong, which is the property the skill's whole safety argument rests
 * on.
 *
 *   node scripts/skill-contract.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILL = join(ROOT, 'skills', 'spec-flow-setup', 'SKILL.md');
const failures = [];

const check = (name, problem) => {
  if (problem) failures.push(`${name}\n    ${problem}`);
};

/** Always by path, from the repo's own root — the route the skill prescribes. */
function engine(script, cwd, args = []) {
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;
  return spawnSync(process.execPath, [join(ROOT, 'scripts', script), ...args], { cwd, env, encoding: 'utf8' });
}

const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });

if (!existsSync(SKILL)) {
  console.error(`skill-contract: ${SKILL} does not exist.`);
  process.exit(1);
}
const skill = readFileSync(SKILL, 'utf8');

// ---- 1. the scripts it tells the model to run ------------------------------
//
// `plugin-paths.mjs` proves every `${CLAUDE_PLUGIN_ROOT}/...` path in this file
// resolves to something that ships. It cannot prove the file is an entrypoint
// that runs, which is what the skill actually asserts by putting it in a code
// block.
for (const script of ['init.mjs', 'check-changed.mjs']) {
  check(
    `the skill's route names a real entrypoint: ${script}`,
    skill.includes(`scripts/${script}`) ? null : `the skill no longer tells anyone to run ${script}, so its procedure has a hole where the ${script === 'init.mjs' ? 'contract' : 'proof'} step was`,
  );
}

// ---- 2. the labels it tells the model to read ------------------------------
//
// Step 1 of the skill says init's output IS the worklist and names the three
// buckets. They are printed strings, so nothing but this fails when one is
// renamed.
const repo = mkdtempSync(join(tmpdir(), 'spec-flow-skill-'));

try {
  // A repo that produces all three buckets at once: scripts that exist (so
  // something is `detected`), running through an interpreter (so the runner
  // cannot be named — `MISSING`), and no report flag (`REVIEW`).
  mkdirSync(join(repo, 'lib'), { recursive: true });
  mkdirSync(join(repo, 'test'), { recursive: true });
  writeFileSync(
    join(repo, 'package.json'),
    `${JSON.stringify(
      { name: 'fixture', version: '1.0.0', type: 'module', scripts: { test: 'node --test', lint: 'node -e "process.exit(0)"' } },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(repo, 'lib', 'a.js'), 'export const a = 1;\n');
  writeFileSync(
    join(repo, 'test', 'a.test.js'),
    "import { test } from 'node:test';\ntest('REQ-CORE-001 holds', () => {});\n",
  );

  git(repo, 'init', '-q', '.');
  git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(repo, 'config', 'user.email', 'skill@contract.test');
  git(repo, 'config', 'user.name', 'skill-contract');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'baseline');

  const init = engine('init.mjs', repo);
  const initOut = `${init.stdout}${init.stderr}`;

  for (const label of ['detected', 'REVIEW', 'MISSING']) {
    check(
      `init still prints the "${label}" bucket the skill tells the model to read`,
      new RegExp(`^\\s*${label}\\b`, 'm').test(initOut)
        ? null
        : `the skill instructs the model to work from init's ${label} lines and init printed none on a repo built to produce all three:\n${initOut}`,
    );
    check(
      `the skill still names the "${label}" bucket`,
      skill.includes(label) ? null : `init prints ${label} and the skill no longer mentions it, so that bucket has no reader`,
    );
  }

  // ---- 3. every contract field the skill names is a real one ---------------
  //
  // A dotted field in the skill is an instruction to write that key. A typo
  // ships a config the loader ignores and the model reports as configured —
  // and `loadConfig` will not complain, because an unknown key is not an
  // invalid one.
  const configPath = join(repo, '.spec-flow', 'config.json');
  check('init wrote a contract to check the skill against', existsSync(configPath) ? null : 'no .spec-flow/config.json was written');

  if (existsSync(configPath)) {
    const written = JSON.parse(readFileSync(configPath, 'utf8'));
    // The generated contract carries the report source; `executed_tests` is the
    // escape hatch and is absent by construction, so the known-good set is the
    // union of what was written and the one alternative the contract defines.
    const resolves = (path) => {
      if (path === 'trace.executed_tests') return true; // the documented alternative to trace.report
      return path.split('.').reduce((node, key) => (node && typeof node === 'object' ? node[key] : undefined), written) !== undefined;
    };

    const named = [...new Set([...skill.matchAll(/`((?:verify|trace)\.[a-z_]+(?:\.[a-z_]+)*)`/g)].map((m) => m[1]))];
    check(
      'the skill names at least one contract field',
      named.length > 0 ? null : 'no `verify.*` or `trace.*` field is named in the skill, which means step 2 tells the model nothing specific',
    );
    for (const path of named) {
      check(
        `the skill's \`${path}\` is a field the contract actually has`,
        resolves(path)
          ? null
          : `the skill tells the model to set ${path}, which is not in the contract init writes — a key nothing reads, written into a file that will still load`,
      );
    }
  }

  // ---- 4. the property the skill's safety argument rests on ----------------
  //
  // The skill's whole answer to "the model can pick the wrong flag" is that a
  // wrong flag cannot fail quietly: the report never lands, and the check goes
  // red naming it. That is a claim about the ENGINE, asserted in prose the
  // model reads, and it is the one this file most needs to hold — if it ever
  // stopped being true, the skill would keep saying it.
  const contract = JSON.parse(readFileSync(configPath, 'utf8'));
  contract.verify.scope_globs = ['*.js'];
  contract.verify.test_name = 'fixture-runner';
  contract.verify.lint_name = 'fixture-linter';
  contract.verify.lint_config_hint = 'fixture.config';
  writeFileSync(configPath, `${JSON.stringify(contract, null, 2)}\n`);

  mkdirSync(join(repo, 'specs'), { recursive: true });
  writeFileSync(
    join(repo, 'specs', 'core.md'),
    '<!-- spec-scope: lib -->\n\n# Core\n\n### REQ-CORE-001 — it holds\n\nThe system holds.\n',
  );

  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'adopt');
  git(repo, 'checkout', '-qb', 'feature');
  writeFileSync(join(repo, 'lib', 'a.js'), 'export const a = 2;\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'work');

  // No reporter flag was ever added — exactly the state a model leaves behind
  // when it gets step 3 wrong.
  const red = engine('check-changed.mjs', repo);
  const redOut = `${red.stdout}${red.stderr}`;

  check(
    'a requirement with no report is refused, not reported as configured',
    red.status === 0
      ? `the route went green with a declared requirement and no report on disk, so a wrong flag now produces a repo that LOOKS set up:\n${redOut}`
      : null,
  );
  check(
    'the refusal names the report, so the model is sent to the flag rather than to the specs',
    /reporter flag|does not exist|trace\.report/.test(redOut)
      ? null
      : `the check failed without naming the report, so nothing tells the model its flag is the problem:\n${redOut}`,
  );
  check(
    'the refusal does not read as an unproven requirement',
    /has no test/.test(redOut)
      ? `a missing report was reported as a requirement with no test, which sends the model to write a test that already exists:\n${redOut}`
      : null,
  );
} finally {
  rmSync(repo, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`skill-contract: ${failures.length} case(s) failed\n`);
  for (const f of failures) console.error(`  ✕ ${f}\n`);
  process.exit(1);
}

console.log(
  'skill-contract: OK — the setup skill and the engine agree about the entrypoints, the buckets and the contract fields, and a missing report still fails loudly.',
);
