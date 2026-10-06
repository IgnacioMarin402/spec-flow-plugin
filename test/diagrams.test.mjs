import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { problems } from '../scripts/diagrams.mjs';

const SOURCE = 'flowchart TD\n    A --> B\n';
const sha = (text) => createHash('sha256').update(text).digest('hex');

/** A tree holding one diagram drawn from SOURCE and shown by REFERENCE, with `files` laid over it. */
function tree(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'spec-flow-diagrams-'));
  const all = {
    'diagrams/flow.mmd': SOURCE,
    'diagrams/flow.png': 'not really a png',
    'diagrams/rendered.json': JSON.stringify({ 'flow.mmd': sha(SOURCE) }),
    'REFERENCE.md': '# Flow\n\n![the flow](diagrams/flow.png)\n',
    ...files,
  };
  for (const [rel, contents] of Object.entries(all)) {
    if (contents === null) continue;
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), contents);
  }
  return root;
}

function problemsIn(files) {
  const root = tree(files);
  try {
    return problems(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('a diagram drawn from its current source and shown by a doc passes', () => {
  assert.deepEqual(problemsIn(), []);
});

test('a mermaid fence in a doc is reported, since the mobile app shows it as source', () => {
  const found = problemsIn({ 'REFERENCE.md': '# Flow\n\n![the flow](diagrams/flow.png)\n\n```mermaid\nflowchart TD\n```\n' });
  assert.equal(found.length, 1);
  assert.match(found[0], /^REFERENCE\.md:5 draws a diagram in a mermaid fence/);
});

test('a source edited after its picture was drawn is reported', () => {
  const found = problemsIn({ 'diagrams/flow.mmd': `${SOURCE}    B --> C\n` });
  assert.equal(found.length, 1);
  assert.match(found[0], /diagrams\/flow\.png was not drawn from the diagrams\/flow\.mmd here/);
});

test('a Windows checkout of an unchanged source still matches its picture', () => {
  assert.deepEqual(problemsIn({ 'diagrams/flow.mmd': SOURCE.replace(/\n/g, '\r\n') }), []);
});

test('a picture no doc shows, and a doc showing a picture that is not there, are both reported', () => {
  const found = problemsIn({ 'REFERENCE.md': '# Flow\n\n![the flow](diagrams/gone.png)\n' });
  assert.equal(found.length, 2);
  assert.match(found[0], /REFERENCE\.md shows diagrams\/gone\.png, which does not exist/);
  assert.match(found[1], /diagrams\/flow\.png is shown by no doc/);
});

test('no diagrams at all is a failure, not a clean pass', () => {
  const found = problemsIn({
    'diagrams/flow.mmd': null,
    'diagrams/flow.png': null,
    'diagrams/rendered.json': null,
    'REFERENCE.md': '# Flow\n',
  });
  assert.equal(found.length, 1);
  assert.match(found[0], /holds no \.mmd source/);
});
