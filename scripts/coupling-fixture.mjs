#!/usr/bin/env node
/**
 * Behaviour fixture for scripts/no-repo-refs.mjs.
 *
 * The coupling check reports a count and exits 0 when it finds nothing, so a
 * scan reaching the wrong set of files is indistinguishable from a clean repo
 * — this engine's own failure mode, in the check whose job is being armed.
 *
 * What this holds is therefore not "the banned patterns are right", which is
 * the check's own subject and which it states itself. It is **the scan reaches
 * every surface it claims to reach**, asserted per directory and per file.
 *
 * The list below is written out rather than imported, and that duplication is
 * the guarantee: a fixture reading `SCAN_DIRS` from the module would agree
 * with whatever the module says, a directory silently dropped from it
 * included, and would be green over exactly the defect it exists to catch.
 *
 * Every case copies the real script into a throwaway tree and runs it there.
 * The script derives its own root from `import.meta.url`, so a copy at
 * `<tmp>/scripts/no-repo-refs.mjs` scans `<tmp>` and nothing else — no
 * environment variable, and this repo's own files are never in scope.
 */
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECK = join(HERE, 'no-repo-refs.mjs');
const failures = [];

// Assembled at runtime and never written as a literal anywhere in this file:
// `scripts/` is one of the directories the check under test scans, so a
// spelled-out banned token here fails the real run against this repo.
const BANNED = ['Nest', 'JS'].join('');

// The surfaces the check claims. Written out, not imported — see the header.
const SCANNED_DIRS = ['hooks', 'scripts', 'commands', 'agents', '.claude/skills', 'skills', 'decisions'];
const SCANNED_FILES = ['README.md', 'REFERENCE.md', 'CLAUDE.md', 'LICENSE', 'BACKLOG.md', '.github/workflows/ci.yml'];

/**
 * Builds a tree holding exactly `files` (path -> contents), installs the real
 * check into it, and returns what the check did.
 */
function scan(files) {
  const root = mkdtempSync(join(tmpdir(), 'spec-flow-coupling-'));
  try {
    mkdirSync(join(root, 'scripts'), { recursive: true });
    copyFileSync(CHECK, join(root, 'scripts', 'no-repo-refs.mjs'));

    for (const [rel, contents] of Object.entries(files)) {
      const full = join(root, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, contents);
    }

    const res = spawnSync(process.execPath, [join(root, 'scripts', 'no-repo-refs.mjs')], { encoding: 'utf8' });
    return { code: res.status, out: `${res.stdout}${res.stderr}` };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The count the check prints on a clean tree, or null when it reported a finding. */
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
// the failure to find out which, which is the position this item started in.

for (const dir of SCANNED_DIRS) {
  check(`a banned token in ${dir}/ is reported`, () => {
    const { code, out } = scan({ [`${dir}/planted.md`]: `The engine is a ${BANNED} plugin.\n` });
    if (code === 0) {
      return `${dir}/ is not scanned: the check exited 0 over a file naming one stack's framework, which is the same output it gives a clean repo.\n--- output ---\n${out}`;
    }
    return out.includes(`${dir}/planted.md`) ? '' : `reported a finding but not the file that carries it.\n--- output ---\n${out}`;
  });
}

for (const file of SCANNED_FILES) {
  check(`a banned token in ${file} is reported`, () => {
    const { code, out } = scan({ [file]: `The engine is a ${BANNED} plugin.\n` });
    if (code === 0) return `${file} is not scanned.\n--- output ---\n${out}`;
    return out.includes(file) ? '' : `reported a finding but not the file that carries it.\n--- output ---\n${out}`;
  });
}

// ---- the properties a per-surface case cannot see -------------------------

check('a nested file is reached, not just the top level of a scanned directory', () => {
  const { code, out } = scan({ 'hooks/lib/deep.md': `The engine is a ${BANNED} plugin.\n` });
  if (code === 0) return `the walk did not recurse, so every subdirectory of a scanned directory is unscanned.\n--- output ---\n${out}`;
  return out.includes('hooks/lib/deep.md') ? '' : `reported a finding but not the nested file.\n--- output ---\n${out}`;
});

check('the check does not report itself for naming what it bans', () => {
  const { code, out } = scan({});
  if (code !== 0) return `a tree holding only the check itself came back dirty — the self-exclusion is gone, so the check fails on its own BANNED list and can never be green.\n--- output ---\n${out}`;
  return scannedCount(out) === 0 ? '' : `expected the only file present to be excluded, so a count of 0.\n--- output ---\n${out}`;
});

check('the count reports the files actually read, so a dropped surface is visible without running this fixture', () => {
  const clean = 'Nothing here names one repo.\n';
  const files = Object.fromEntries([
    ...SCANNED_DIRS.map((d) => [`${d}/clean.md`, clean]),
    ...SCANNED_FILES.map((f) => [f, clean]),
  ]);
  const { code, out } = scan(files);
  if (code !== 0) return `a clean tree was reported as coupled.\n--- output ---\n${out}`;

  const expected = SCANNED_DIRS.length + SCANNED_FILES.length;
  const actual = scannedCount(out);
  return actual === expected
    ? ''
    : `the check read ${actual} file(s) where every claimed surface holds exactly one, so ${expected} was the only correct answer. A count that drifts below the surfaces is what an unscanned directory looks like in CI output.\n--- output ---\n${out}`;
});

check('an extension outside the scanned set is not read, which is why a prose doc is listed by name', () => {
  const { code, out } = scan({ 'hooks/notes.txt': `The engine is a ${BANNED} plugin.\n` });
  if (code !== 0) {
    return `the walk read a .txt file. Widening the extensions is a real choice, but it is not this one: SCAN_FILES exists to name the prose that lives outside them, and a walk that picks up everything makes that list dead code.\n--- output ---\n${out}`;
  }
  return '';
});

// ---- report ---------------------------------------------------------------
if (failures.length > 0) {
  console.error(`coupling: ${failures.length} case(s) failed.\n`);
  for (const f of failures) console.error(`  - ${f.name}\n    ${f.problem}\n`);
  process.exit(1);
}
console.log(`coupling: OK — the scan reaches all ${SCANNED_DIRS.length + SCANNED_FILES.length} surface(s) it claims.`);
