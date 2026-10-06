#!/usr/bin/env node
/**
 * Every diagram a doc shows is a picture a reader can see, drawn from the
 * source beside it. See ADR-029.
 *
 *   node scripts/diagrams.mjs                    # check
 *   node scripts/diagrams.mjs --render [-- ...]  # redraw every diagram; what follows `--` goes to mmdc
 *
 * A diagram is `diagrams/<name>.mmd` and the `<name>.png` drawn from it, and a
 * doc shows the PNG. `diagrams/rendered.json` holds the sha256 of the source
 * each PNG was drawn from, so a source edited without a redraw fails here
 * instead of showing a picture that disagrees with its source.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RENDERED = 'rendered.json';
// Pinned, so a redraw changes a picture only when its source changed.
const MMDC = '@mermaid-js/mermaid-cli@12.0.0';

// The docs a person reads on GitHub, where a ```mermaid fence shows as code
// in the mobile app. Agents, commands and skills are not here: a model reads
// them as text, and a fence is as legible to it as anything else.
const DOCS = ['README.md', 'REFERENCE.md', 'CLAUDE.md', 'BACKLOG.md'];
const DOC_DIRS = ['decisions'];

// CRLF folded first: a Windows checkout converts the sources' line endings,
// and the same source has to hash the same on both legs of CI.
const hashOf = (text) => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');

const rel = (root, path) => relative(root, path).replace(/\\/g, '/');

function sources(root) {
  const dir = join(root, 'diagrams');
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.mmd')).sort() : [];
}

function docs(root) {
  const found = DOCS.map((f) => join(root, f)).filter((f) => existsSync(f));
  for (const d of DOC_DIRS) {
    const dir = join(root, d);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir).sort()) if (f.endsWith('.md')) found.push(join(dir, f));
  }
  return found;
}

/** Everything wrong with the diagrams under `root`, one sentence each. */
export function problems(root) {
  const found = [];
  const dir = join(root, 'diagrams');
  const names = sources(root);

  // Finding none is a failure: a fence ban alone reports a repo that lost its
  // diagrams exactly as it reports one whose diagrams are all fine.
  if (names.length === 0) found.push('diagrams/ holds no .mmd source, so there is no diagram here to check.');

  let rendered = {};
  const manifest = join(dir, RENDERED);
  if (existsSync(manifest)) {
    try {
      rendered = JSON.parse(readFileSync(manifest, 'utf8'));
    } catch (err) {
      found.push(`diagrams/${RENDERED} is not JSON (${err.message}). Redraw: npm run diagrams:render.`);
    }
  } else if (names.length > 0) {
    found.push(`diagrams/${RENDERED} is missing, so no picture can be shown to match its source.`);
  }

  for (const name of names) {
    const png = name.replace(/\.mmd$/, '.png');
    if (!existsSync(join(dir, png))) {
      found.push(`diagrams/${name} has no ${png} drawn from it. Draw it: npm run diagrams:render.`);
    } else if (rendered[name] !== hashOf(readFileSync(join(dir, name), 'utf8'))) {
      found.push(
        `diagrams/${png} was not drawn from the diagrams/${name} here, so it shows a flow the source no longer describes. Redraw it: npm run diagrams:render.`,
      );
    }
  }
  for (const name of Object.keys(rendered)) {
    if (!names.includes(name)) found.push(`diagrams/${RENDERED} records ${name}, which diagrams/ does not hold.`);
  }

  const shown = new Set();
  for (const doc of docs(root)) {
    const where = rel(root, doc);
    const text = readFileSync(doc, 'utf8');
    text.split('\n').forEach((line, i) => {
      if (/^\s*(```|~~~)\s*mermaid\b/.test(line)) {
        found.push(
          `${where}:${i + 1} draws a diagram in a mermaid fence, which GitHub's mobile app shows as source. Move it to diagrams/<name>.mmd, run npm run diagrams:render, and show the PNG.`,
        );
      }
    });
    for (const [, target] of text.matchAll(/!\[[^\]]*\]\(([^)\s]+\.png)\)/g)) {
      if (target.includes('://')) continue;
      const path = resolve(dirname(doc), target);
      if (!existsSync(path)) found.push(`${where} shows ${target}, which does not exist.`);
      else shown.add(rel(root, path));
    }
  }
  for (const name of names) {
    const png = `diagrams/${name.replace(/\.mmd$/, '.png')}`;
    if (existsSync(join(root, png)) && !shown.has(png)) {
      found.push(`${png} is shown by no doc, so nobody reads what it says and nobody notices when it is wrong.`);
    }
  }
  return found;
}

/** Redraws every diagram, then records what each was drawn from. Returns an exit code. */
export function render(root, mmdcArgs = []) {
  const dir = join(root, 'diagrams');
  // Through npm's own entry point, not a bare `npx`: on Windows that is a
  // .cmd, which spawnSync cannot run without a shell. `npm run` sets this.
  const npm = process.env.npm_execpath;
  const [cmd, pre] = npm ? [process.execPath, [npm]] : ['npm', []];
  const rendered = {};
  for (const name of sources(root)) {
    const src = join(dir, name);
    const args = ['exec', '--yes', `--package=${MMDC}`, '--', 'mmdc'];
    args.push('-i', src, '-o', src.replace(/\.mmd$/, '.png'), '-b', 'white', '-s', '2', ...mmdcArgs);
    const res = spawnSync(cmd, [...pre, ...args], { stdio: 'inherit' });
    if (res.status !== 0) {
      console.error(`diagrams: drawing diagrams/${name} failed${res.error ? ` (${res.error.message})` : ''}.`);
      return 1;
    }
    rendered[name] = hashOf(readFileSync(src, 'utf8'));
  }
  writeFileSync(join(dir, RENDERED), `${JSON.stringify(rendered, null, 2)}\n`);
  console.log(`diagrams: drew ${Object.keys(rendered).length} diagram(s).`);
  return 0;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const at = process.argv.indexOf('--render');
  if (at !== -1) {
    const rest = process.argv.slice(at + 1);
    process.exit(render(root, rest[0] === '--' ? rest.slice(1) : rest));
  }

  const found = problems(root);
  if (found.length > 0) {
    console.error(`diagrams: ${found.length} problem(s).\n`);
    for (const p of found) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`diagrams: OK — ${sources(root).length} diagram(s), each shown and drawn from its current source.`);
}
