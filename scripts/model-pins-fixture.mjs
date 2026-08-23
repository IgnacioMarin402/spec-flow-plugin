#!/usr/bin/env node
/**
 * Behaviour fixture for scripts/model-pins.mjs.
 *
 *   node scripts/model-pins-fixture.mjs
 *
 * The half of that check which BANS a version prints a count and exits 0 when
 * it finds nothing, so a scan walking the wrong directories is
 * indistinguishable from a clean repo — the same hole `coupling-fixture.mjs`
 * exists to plug for `no-repo-refs.mjs`. The surface lists below are written
 * out rather than imported, and that duplication is the whole guarantee: a
 * fixture reading `SCAN_DIRS` from the module would agree with a directory
 * silently dropped from it.
 *
 * The half which ASSERTS the routing needs the opposite kind of case. It
 * cannot pass vacuously — no agents is a failure — so what is checked there is
 * that each way of getting the routing wrong is actually reported, and that
 * the ban is not so wide it forbids the bare alias the fix depends on.
 *
 * Every versioned token here is assembled at runtime and never written as a
 * literal: `scripts/` is one of the directories the check under test scans, so
 * a spelled-out one would fail the real run against this repo.
 */
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECK = join(HERE, 'model-pins.mjs');
const failures = [];

// Assembled, never spelled — see the header.
const PINNED_ID = ['claude', 'opus', '5'].join('-');
const NUMBERED_TIER = ['Opus', '5'].join(' ');

// The surfaces the check claims. Written out, not imported.
const SCANNED_DIRS = ['agents', 'commands', 'hooks', 'scripts', 'skills', '.claude/skills'];
const SCANNED_FILES = ['README.md', 'REFERENCE.md', 'CLAUDE.md', 'BACKLOG.md', '.github/workflows/ci.yml'];

/** A valid agent, so a case about the ban is not also failing the routing assertions. */
function agent(name, model = 'sonnet', description = `Does a job (${model}).`) {
  return `---\nname: ${name}\ndescription: ${description}\nmodel: ${model}\n---\n\nBody.\n`;
}

/**
 * Builds a tree holding exactly `files` (path -> contents), installs the real
 * check into it, and returns what the check did. A valid agent is planted
 * unless the case opts out: an empty `agents/` is itself a failure, which
 * would otherwise mask every other case.
 */
function scan(files, { baseline = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'spec-flow-model-pins-'));
  try {
    mkdirSync(join(root, 'scripts'), { recursive: true });
    copyFileSync(CHECK, join(root, 'scripts', 'model-pins.mjs'));
    if (baseline) {
      mkdirSync(join(root, 'agents'), { recursive: true });
      writeFileSync(join(root, 'agents', 'base.md'), agent('base'));
    }

    for (const [rel, contents] of Object.entries(files)) {
      const full = join(root, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, contents);
    }

    const res = spawnSync(process.execPath, [join(root, 'scripts', 'model-pins.mjs')], { encoding: 'utf8' });
    return { code: res.status, out: `${res.stdout}${res.stderr}` };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The count the check prints on a clean tree, or null when it reported a problem. */
function scannedCount(out) {
  const match = /OK — (\d+) file\(s\)/.exec(out);
  return match ? Number(match[1]) : null;
}

function check(name, fn) {
  try {
    const problem = fn();
    if (problem) failures.push({ name, problem });
  } catch (err) {
    failures.push({ name, problem: `threw: ${err?.stack ?? err}` });
  }
}

// ---- every claimed surface is actually reached ----------------------------
// One case per surface rather than one case planting everywhere at once: a
// single case would report "something is unscanned" and leave whoever reads
// the failure to work out which.

for (const dir of SCANNED_DIRS) {
  check(`a pinned id in ${dir}/ is reported`, () => {
    // In agents/ the planted file has to be a VALID agent, or the routing
    // assertions would name the same path for a different reason and the case
    // would pass without the ban having reached anything.
    const contents = dir === 'agents' ? agent('planted', 'sonnet', `Does a job (Sonnet), once ${PINNED_ID}.`) : `Routes to ${PINNED_ID}.\n`;
    const { code, out } = scan({ [`${dir}/planted.md`]: contents });
    if (code === 0) {
      return `${dir}/ is not scanned: the check exited 0 over a file naming a pinned model id, which is the same output it gives a clean repo.\n--- output ---\n${out}`;
    }
    if (!out.includes('a pinned model id')) return `reported a problem, but not the ban.\n--- output ---\n${out}`;
    return out.includes(`${dir}/planted.md`) ? '' : `reported the ban but not the file that carries it.\n--- output ---\n${out}`;
  });
}

for (const file of SCANNED_FILES) {
  check(`a numbered tier in ${file} is reported`, () => {
    const { code, out } = scan({ [file]: `The planner runs on ${NUMBERED_TIER}.\n` });
    if (code === 0) return `${file} is not scanned.\n--- output ---\n${out}`;
    return out.includes(file) ? '' : `reported a problem but not the file that carries it.\n--- output ---\n${out}`;
  });
}

check('a nested file is reached, not just the top level of a scanned directory', () => {
  const { code, out } = scan({ 'hooks/lib/deep.md': `Routes to ${PINNED_ID}.\n` });
  if (code === 0) return `the walk did not recurse, so every subdirectory of a scanned directory is unscanned.\n--- output ---\n${out}`;
  return out.includes('hooks/lib/deep.md') ? '' : `reported a problem but not the nested file.\n--- output ---\n${out}`;
});

check('decisions/ is exempt, so a record can name what it removed', () => {
  const { code, out } = scan({ 'decisions/012-a-record.md': `We removed ${PINNED_ID} on this date.\n` });
  return code === 0
    ? ''
    : `a record naming the id it retired was reported. A record claims a moment, and ADR-012 cannot say what changed without naming it.\n--- output ---\n${out}`;
});

// ---- the ban is not wider than the fix ------------------------------------
// Without this the check could be "green" by forbidding the bare alias, which
// would make the thing it exists to enforce impossible to write.

check('a bare tier alias is not reported', () => {
  const { code, out } = scan({
    'commands/route.md': 'Routing: reviewer = haiku; implementer = sonnet; planner = opus. The Opus budget counts the last one.\n',
  });
  return code === 0 ? '' : `the bare aliases and tier words were reported, which forbids exactly what ADR-012 requires.\n--- output ---\n${out}`;
});

// ---- the routing assertions -----------------------------------------------

check('an agents/ directory the check cannot see is a failure, not a clean run', () => {
  const { code, out } = scan({}, { baseline: false });
  if (code === 0) {
    return `a tree with no agents passed. That is the failure mode this check exists to close: it would report a directory it never reached exactly as it reports a clean one.\n--- output ---\n${out}`;
  }
  return out.includes('no agent files') ? '' : `failed, but not for the reason that matters.\n--- output ---\n${out}`;
});

check('an agent pinned to a full model id is reported', () => {
  const { code, out } = scan({ 'agents/pinned.md': `---\nname: pinned\ndescription: Does a job (Opus).\nmodel: ${PINNED_ID}\n---\n\nBody.\n` });
  if (code === 0) return `an agent frozen on one model passed.\n--- output ---\n${out}`;
  return out.includes('not one of the tier aliases') ? '' : `failed, but not on the alias assertion.\n--- output ---\n${out}`;
});

check('an agent declaring no model is reported', () => {
  const { code, out } = scan({ 'agents/inherits.md': '---\nname: inherits\ndescription: Does a job.\n---\n\nBody.\n' });
  if (code === 0) {
    return `an agent with no model passed. Omitting it means inherit, so a cheap pass silently runs on whatever the main session is using.\n--- output ---\n${out}`;
  }
  return out.includes('declares no') ? '' : `failed, but not on the missing model.\n--- output ---\n${out}`;
});

check('an agent whose description contradicts its routing is reported', () => {
  const { code, out } = scan({ 'agents/drifted.md': agent('drifted', 'haiku', 'Reviews the plan (Sonnet, read-only).') });
  if (code === 0) return `a frontmatter re-route that never reached the description passed.\n--- output ---\n${out}`;
  return out.includes('never says so') ? '' : `failed, but not on the description.\n--- output ---\n${out}`;
});

check('naming another agent\'s tier in a description is allowed', () => {
  const { code, out } = scan({
    'agents/escalates.md': agent('escalates', 'haiku', 'Reviews the plan (Haiku). Escalates hard doubts to the Opus planner.'),
  });
  return code === 0
    ? ''
    : `a description naming the tier it escalates TO was reported. What the check requires is presence, not exclusivity.\n--- output ---\n${out}`;
});

check('a clean tree reports the routing it read, so a silent miss is visible in CI output', () => {
  const { code, out } = scan({ 'agents/deep.md': agent('deep', 'opus', 'Advises (Opus).') });
  if (code !== 0) return `a clean tree was reported as pinned.\n--- output ---\n${out}`;
  if (!out.includes('deep -> opus') || !out.includes('base -> sonnet')) {
    return `the check passed without naming what each agent routes to. Printing the routing is what makes an unread agents/ visible without running this fixture.\n--- output ---\n${out}`;
  }
  return '';
});

check('the count reports the files actually read, so a dropped surface is visible without running this fixture', () => {
  const clean = 'Nothing here names a version.\n';
  const files = Object.fromEntries([
    // The one in agents/ has to be a real agent: this case is about the file
    // COUNT, and prose sitting there would fail the routing half instead.
    ...SCANNED_DIRS.map((d) => [`${d}/clean.md`, d === 'agents' ? agent('clean') : clean]),
    ...SCANNED_FILES.map((f) => [f, clean]),
  ]);
  const { code, out } = scan(files);
  if (code !== 0) return `a clean tree was reported as pinned.\n--- output ---\n${out}`;

  // One per surface, plus the baseline agent. The check under test is at
  // scripts/model-pins.mjs and excludes itself.
  const expected = SCANNED_DIRS.length + SCANNED_FILES.length + 1;
  const actual = scannedCount(out);
  return actual === expected
    ? ''
    : `the check read ${actual} file(s) where ${expected} was the only correct answer. A count that drifts below the surfaces is what an unscanned directory looks like in CI output.\n--- output ---\n${out}`;
});

// ---- report ---------------------------------------------------------------
if (failures.length > 0) {
  console.error(`model-pins-fixture: ${failures.length} case(s) failed.\n`);
  for (const f of failures) console.error(`  - ${f.name}\n    ${f.problem}\n`);
  process.exit(1);
}
console.log(
  `model-pins-fixture: OK — the scan reaches all ${SCANNED_DIRS.length + SCANNED_FILES.length} surface(s) it claims, and the routing assertions hold.`,
);
