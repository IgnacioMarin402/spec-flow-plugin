import { test } from 'node:test';
import assert from 'node:assert';
import { returnBlocks } from '../scripts/agent-blocks.mjs';

/**
 * The contract this file defends is one line long: an agent's markdown is read
 * from wherever the plugin was INSTALLED, and git hands a Windows checkout
 * CRLF. A parser anchored to `\n` finds nothing there and everything on the
 * machine it was written on.
 *
 * Windows CI does cover it, and covered it by turning three jobs red. It
 * covers it only because the runner happens to check out CRLF, though — a
 * `.gitattributes` normalising to LF would end that silently while looking
 * like tidying. This states the case explicitly instead.
 */

const BLOCK = ['```', 'STATUS: FOLDED', 'ARCHIVED: specflow/archive/x/', 'GAPS: none', '```'];

test('returnBlocks reads a block written with LF', () => {
  const { blocks, fields } = returnBlocks(BLOCK.join('\n'));
  assert.equal(blocks, 1);
  assert.deepEqual(fields, ['STATUS', 'ARCHIVED', 'GAPS']);
});

test('returnBlocks reads the same block written with CRLF', () => {
  const { blocks, fields } = returnBlocks(BLOCK.join('\r\n'));
  assert.equal(blocks, 1, 'a CRLF checkout must not read as "this agent declares no return block"');
  assert.deepEqual(fields, ['STATUS', 'ARCHIVED', 'GAPS'], 'field names must not carry a trailing \\r');
});

test('returnBlocks reports zero blocks rather than throwing when the anchor is gone', () => {
  // The caller distinguishes "declares none" from "the anchor moved" by this
  // count, and reports the second as a defect in the check itself.
  assert.deepEqual(returnBlocks('# just prose\n'), { blocks: 0, fields: [] });
  assert.deepEqual(returnBlocks(''), { blocks: 0, fields: [] });
});

test('a fenced block that is not a return block is not read as one', () => {
  const shell = ['```bash', 'STATUS=1 npm test', '```'].join('\n');
  assert.equal(returnBlocks(shell).blocks, 0);
});
