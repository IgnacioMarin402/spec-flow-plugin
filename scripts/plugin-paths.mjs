#!/usr/bin/env node
/**
 * Every `${CLAUDE_PLUGIN_ROOT}/...` path this plugin tells someone to run must
 * exist in this package.
 *
 * The failure this closes is a documented step that cannot be executed. Both
 * orchestrator commands instruct the model to snapshot the run's telemetry —
 * once at intake, once at DONE — and for a while neither named a path and the
 * script was not reachable through `bin/spec-flow` either. Nothing failed:
 * the orchestrator simply could not run a step nobody could locate, the
 * snapshot never fired, and every run's telemetry died with its gitignored
 * state directory. `specflow-stats` then reported nothing, which reads
 * identically to "this flow has never been run".
 *
 * That shape — an instruction that silently does not execute — is the same
 * one the gate fixture exists for, one layer up in the prose. A path in a
 * command is a call site; this is its type check.
 *
 *   node scripts/plugin-paths.mjs
 *
 * Scans the files that can carry such a path: the commands and agents (where
 * the placeholder is substituted into markdown the model then acts on) and
 * hooks.json (where it resolves in `args`).
 *
 * It also checks CROSS-DOC ANCHORS, which are the same defect in prose. The
 * README's job is now to be short and send readers elsewhere, so a link to a
 * REFERENCE section that does not exist is a promise it cannot keep — and one
 * such link shipped the moment that restructuring happened, pointing at a
 * section that documented one install route while the text claimed both.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// `skills` is the plugin-root directory, not `.claude/skills` — the first ships
// to adopters inside the package, the second is this repo's own development
// skills and reaches nobody else. A skill carries the same call sites a command
// does, because it is the same markdown a model acts on.
const SCAN_DIRS = ['commands', 'agents', 'modes', 'hooks', 'skills'];
const SCAN_EXTENSIONS = ['.md', '.json'];

// `${CLAUDE_PLUGIN_ROOT}/some/path.mjs` — the trailing character class stops
// at whatever markdown wrapped it (a backtick, a quote, a comma, a period).
const PLACEHOLDER = /\$\{CLAUDE_PLUGIN_ROOT\}\/([A-Za-z0-9._\-/]+)/g;

function walk(dir, found = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, found);
    else if (SCAN_EXTENSIONS.some((ext) => entry.endsWith(ext))) found.push(full);
  }
  return found;
}

function walkMjs(dir, found = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkMjs(full, found);
    else if (entry.endsWith('.mjs')) found.push(full);
  }
  return found;
}

const files = SCAN_DIRS.filter((d) => {
  try {
    return statSync(join(ROOT, d)).isDirectory();
  } catch {
    return false;
  }
}).flatMap((d) => walk(join(ROOT, d)));

const findings = [];
let checked = 0;

for (const file of files) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      for (const [, path] of line.matchAll(PLACEHOLDER)) {
        checked++;
        if (!existsSync(join(ROOT, path))) {
          findings.push(`${rel}:${i + 1}  ${path} does not exist in this package`);
        }
      }
    });
}

// ---- the hook inventory, both directions ----------------------------------
//
// A hook file that hooks.json never registers is dead code that reads as
// shipped; a hooks.json entry with no file behind it is a guarantee the
// manifest claims and the package cannot keep. Neither shows up anywhere
// else: the counts live as prose in half a dozen headers and docs, which
// drifted by one within two lines of each other the last time a hook was
// added. Prose cannot be checked; this can.
const hookFiles = readdirSync(join(ROOT, 'hooks'))
  .filter((f) => f.endsWith('.mjs'))
  .sort();

const manifest = readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8');
const registered = new Set([...manifest.matchAll(/hooks\/([A-Za-z0-9._-]+\.mjs)/g)].map(([, f]) => f));

for (const file of hookFiles) {
  if (!registered.has(file)) {
    findings.push(`hooks/${file} exists but hooks.json never registers it — it ships and never fires`);
  }
}
for (const file of registered) {
  if (!hookFiles.includes(file)) {
    findings.push(`hooks.json registers hooks/${file}, which this package does not ship`);
  }
}

// ---- the mod's modules, both directions ------------------------------------
//
// The same two failures for what `modules` names (ADR-037), which Claude Code
// loads with no Node and no other check would notice missing: a view the
// manifest promises and nothing loads, or a module that ships and never runs.
// A `*.test.tsx` is `claude plugin test`'s, not a module.
const modules = (JSON.parse(manifest).modules ?? []).map((m) => m.replace(/^\.\//, ''));
const moduleFiles = readdirSync(join(ROOT, 'hooks'))
  .filter((f) => f.endsWith('.tsx') && !f.endsWith('.test.tsx'))
  .sort();

for (const file of moduleFiles) {
  if (!modules.includes(file)) {
    findings.push(`hooks/${file} exists but hooks.json never names it in modules — it ships and never loads`);
  }
}
for (const file of modules) {
  if (!existsSync(join(ROOT, 'hooks', file))) {
    findings.push(`hooks.json names the module hooks/${file}, which this package does not ship`);
  }
}

// The state contract a module's `$.state` keys are validated against.
const contract = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).types;
if (contract && !existsSync(join(ROOT, contract))) {
  findings.push(`.claude-plugin/plugin.json names the types contract ${contract}, which this package does not ship`);
}

// ---- every state file the code names has a row ----------------------------
//
// REFERENCE's `.claude/state/` table is what a human deletes from to reset a
// piece of state, and what a reader of the state (a mod, a script) takes as
// the list. A file the hooks write and the table does not name is state
// nobody knows to look for. Code to table only: the table may describe a
// family (`*-unmatched.log`) the code builds by name.
//
// Reach: the shapes this repo writes a state path in — `join(state, 'x')`,
// `join(STATE, 'x')`, `join(stateDir(root), 'x')`, `'.claude', 'state', 'x'`
// and `.claude/state/x` in a literal. A helper called with a bare file name
// (`read('x')`) is not seen.
const STATE_SHAPES = [
  /join\(\s*(?:state|STATE|stateDir\([^)]*\))\s*,\s*'([^']+)'\s*\)/g,
  /'\.claude',\s*'state',\s*'([^']+)'/g,
  /\.claude\/state\/([A-Za-z0-9_-][A-Za-z0-9_.-]*[A-Za-z0-9_-])/g,
];
const engineSources = [
  ...walkMjs(join(ROOT, 'hooks')),
  ...readdirSync(join(ROOT, 'scripts')).map((f) => join(ROOT, 'scripts', f)),
].filter((f) => f.endsWith('.mjs') && !/(fixture|smoke|cold-start|plugin-paths)\.mjs$/.test(f));

const stateNames = new Map(); // name -> first file naming it
for (const file of engineSources) {
  const text = readFileSync(file, 'utf8');
  for (const shape of STATE_SHAPES) {
    for (const [, name] of text.matchAll(shape)) {
      if (!stateNames.has(name)) stateNames.set(name, relative(ROOT, file).replace(/\\/g, '/'));
    }
  }
}

const reference = readFileSync(join(ROOT, 'REFERENCE.md'), 'utf8');
const tableStart = reference.indexOf('## `.claude/state/`');
const table = tableStart === -1 ? '' : reference.slice(tableStart, reference.indexOf('\n---', tableStart));
const covers = [];
for (const row of table.split('\n').filter((l) => l.startsWith('| `'))) {
  const cell = row.split('|')[1];
  let stem = '';
  for (const [, token] of cell.matchAll(/`([^`]+)`/g)) {
    // `gate-failure.log` / `.full.log`: a token starting with a dot is a
    // sibling of the previous one, written short.
    const name = token.startsWith('.') ? `${stem}${token}` : token;
    if (!token.startsWith('.')) stem = token.replace(/\.[^.]+$/, '');
    covers.push(new RegExp(`^${name.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`));
  }
}

if (stateNames.size === 0 || covers.length === 0) {
  findings.push(
    `the .claude/state inventory found ${stateNames.size} state file name(s) in the code and ${covers.length} row name(s) in REFERENCE.md. One of the two stopped matching; a check that finds nothing passes forever.`,
  );
} else {
  for (const [name, file] of stateNames) {
    if (!covers.some((re) => re.test(name))) {
      findings.push(`${file} names .claude/state/${name}, which REFERENCE.md's \`.claude/state/\` table does not list.`);
    }
  }
}

// ---- cross-doc anchors ---------------------------------------------------
//
// GitHub's own rule: lowercase, drop everything that is not a letter, digit,
// space, underscore or hyphen, then spaces to hyphens. Kept in one place so a
// heading with a backtick or an em dash — most of them here — resolves the same
// way the renderer will.
const anchorOf = (heading) =>
  heading
    .replace(/^#+\s*/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9 _-]/g, '')
    .replace(/ /g, '-');

const DOCS = ['README.md', 'REFERENCE.md', 'CLAUDE.md', 'BACKLOG.md'];
const anchors = new Map(); // doc -> Set of anchors it defines

for (const doc of DOCS) {
  const path = join(ROOT, doc);
  if (!existsSync(path)) continue;
  anchors.set(
    doc,
    new Set(
      readFileSync(path, 'utf8')
        .split('\n')
        .filter((l) => l.startsWith('#'))
        .map(anchorOf),
    ),
  );
}

let anchorsChecked = 0;
for (const doc of anchors.keys()) {
  const text = readFileSync(join(ROOT, doc), 'utf8');
  for (const [, target, anchor] of text.matchAll(/\]\(([A-Za-z.]*\.md)?#([^)]+)\)/g)) {
    const where = target ?? doc;
    const defined = anchors.get(where);
    if (!defined) continue; // a doc this check does not scan — not its business
    anchorsChecked++;
    if (!defined.has(anchor)) {
      findings.push(
        `${doc} links to ${where}#${anchor}, which names no heading there. A reader following it lands at the top of the page and has to hunt.`,
      );
    }
  }
}

if (findings.length > 0) {
  console.error(`plugin-paths: ${findings.length} problem(s).\n`);
  for (const f of findings) console.error(`  - ${f}`);
  console.error(
    '\nA command that names a script the package does not ship is an instruction ' +
      'that silently does not run, and a hook nothing registers is a guarantee ' +
      'nobody is keeping. Ship the file, or stop claiming it.',
  );
  process.exit(1);
}

console.log(
  `plugin-paths: OK — ${checked} plugin-root path(s) referenced, all present; ` +
    `${hookFiles.length} hook(s), each registered in hooks.json; ` +
    `${modules.length} module(s), each shipped and named; ` +
    `${stateNames.size} state file(s) named in the code, each listed in REFERENCE; ` +
    `${anchorsChecked} cross-doc anchor(s), every one resolving.`,
);
