#!/usr/bin/env node
/**
 * Behaviour fixture for the `.claude/state/` inventory in scripts/plugin-paths.mjs.
 *
 *   node scripts/plugin-paths-fixture.mjs
 *
 * The inventory passes when every name it found has a row, so a name it
 * cannot see reads exactly like a name that has one. The live tree cannot
 * show that: once the rows are there, a scan that stopped following a
 * constant still prints OK. These trees have no row for the name, so the scan
 * has to find it to fail. The other half holds it to names a file binds
 * itself: a name guessed from somewhere else would fail a tree that is fine.
 */
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeTemp } from './temp-dir.mjs';

const CHECK = join(dirname(fileURLToPath(import.meta.url)), 'plugin-paths.mjs');
const failures = [];

/** A REFERENCE whose state table lists `names`, plus the baseline's own. */
const reference = (...names) =>
  ['## `.claude/state/`', '', '| file | what it holds |', '|---|---|', ...['base.log', ...names].map((n) => `| \`${n}\` | x |`), '', '---', ''].join('\n');

/**
 * Builds a tree holding `files` plus a baseline hook that names `base.log`
 * literally — an inventory that finds no name at all is its own failure,
 * which would mask every case — registers every top-level hook, installs the
 * real check, and returns what it did.
 */
function scan(files) {
  const root = mkdtempSync(join(tmpdir(), 'spec-flow-plugin-paths-'));
  try {
    const tree = {
      'hooks/base.mjs': "appendFileSync(join(stateDir(root), 'base.log'), '');\n",
      'REFERENCE.md': reference(),
      ...files,
    };
    const hooks = Object.keys(tree).filter((p) => /^hooks\/[^/]+\.mjs$/.test(p));
    tree['hooks/hooks.json'] = JSON.stringify({ hooks: hooks.map((h) => ({ command: `node ${h}` })) });
    for (const [rel, contents] of Object.entries(tree)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), contents);
    }
    mkdirSync(join(root, 'scripts'), { recursive: true });
    copyFileSync(CHECK, join(root, 'scripts', 'plugin-paths.mjs'));
    const r = spawnSync(process.execPath, [join(root, 'scripts', 'plugin-paths.mjs')], { encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    removeTemp(root);
  }
}

function check(name, fn) {
  const problem = fn();
  if (problem) failures.push(`${name}\n    ${problem}`);
}

const reports = (r, file, name) =>
  r.status === 1 && r.out.includes(`${file} names .claude/state/${name}`)
    ? null
    : `expected ${file} reported for ${name}, got exit ${r.status}:\n${r.out}`;

const passes = (r) => (r.status === 0 ? null : `expected OK, got exit ${r.status}:\n${r.out}`);

// The shape hooks/human-turn.mjs writes its log in.
const exported = {
  'hooks/lib/log.mjs': "export const LOG = 'kept.log';\n",
  'hooks/writer.mjs': "import { LOG } from './lib/log.mjs';\nappendFileSync(join(stateDir(root), LOG), '');\n",
};

check('a name imported from the file that exports it is followed to its literal', () =>
  reports(scan(exported), 'hooks/writer.mjs', 'kept.log'),
);

check('a name a file binds at its own top level is followed to its literal', () =>
  reports(
    scan({ 'hooks/lib/reader.mjs': "const LOG = 'kept.log';\nreadFileSync(join(root, '.claude', 'state', LOG), 'utf8');\n" }),
    'hooks/lib/reader.mjs',
    'kept.log',
  ),
);

check('a followed name with its row passes', () => passes(scan({ ...exported, 'REFERENCE.md': reference('kept.log') })));

// Each state path here goes through a parameter. A scan that guessed would
// take `LOG` from the module that exports it without being imported, or from
// a local in another function, and report a name no state path holds.
check('a parameter is not guessed at', () =>
  passes(
    scan({
      'hooks/lib/names.mjs': "export const LOG = 'elsewhere.log';\n",
      'hooks/param.mjs': "const read = (LOG) => readFileSync(join(STATE, LOG), 'utf8');\n",
      'hooks/scoped.mjs': "function f() {\n  const LOG = 'inner.log';\n  return LOG;\n}\nconst g = (LOG) => join(state, LOG);\n",
    }),
  ),
);

if (failures.length > 0) {
  console.error(`plugin-paths-fixture: ${failures.length} case(s) failed.\n`);
  for (const f of failures) console.error(`  - ${f}\n`);
  process.exit(1);
}

console.log('plugin-paths-fixture: OK — the state inventory follows a constant to its literal, and guesses at no parameter.');
