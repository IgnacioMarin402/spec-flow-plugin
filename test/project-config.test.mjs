import { test } from 'node:test';
import assert from 'node:assert';
import { projectConfig } from '../hooks/lib/project-config.mjs';

test('projectConfig reads a file written after a byte-order mark as the same file', () => {
  assert.deepStrictEqual(projectConfig('﻿{"max_opus_calls": 2}'), { settings: { max_opus_calls: 2 }, problem: '' });
});

test('projectConfig reads an empty file as one that sets nothing', () => {
  for (const text of ['', '  \n', '﻿']) assert.deepStrictEqual(projectConfig(text), { settings: {}, problem: '' }, JSON.stringify(text));
});

test('projectConfig says why a file that is not a JSON object has no settings', () => {
  assert.match(projectConfig('{ "max_opus_calls": 2, }').problem, /does not parse as JSON/);
  for (const text of ['null', '[]', '6', '"six"']) {
    const read = projectConfig(text);
    assert.deepStrictEqual(read.settings, {}, text);
    assert.match(read.problem, /not a JSON object/, text);
  }
});
