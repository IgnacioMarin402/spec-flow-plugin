import { test } from 'node:test';
import assert from 'node:assert';
import { returnBlocks, unroutedFields, declaredStatuses, parseReturn, openQuestions } from '../scripts/agent-blocks.mjs';

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

test('a field named only inside a longer field name is not routed', () => {
  assert.deepEqual(unroutedFields(['QUESTIONS'], 'route `OPEN_QUESTIONS:` to the human'), ['QUESTIONS']);
  assert.deepEqual(unroutedFields(['READ'], 'expect `STATUS: SPEC_READY`'), ['READ']);
});

test('a field the commands name is routed, and an exempt one needs no name', () => {
  assert.deepEqual(unroutedFields(['GAPS', 'STATUS'], 'read its `GAPS:` line', { STATUS: 'discriminator' }), []);
});

test('declaredStatuses reads each return block, CRLF included', () => {
  const md = 'x\n```\nSTATUS: NEEDS_INPUT\nOPEN_QUESTIONS:\n```\ny\r\n```\r\nSTATUS: SPEC_READY\r\nSPEC_PATH: a\r\n```\r\n';
  assert.deepEqual(declaredStatuses(md), ['NEEDS_INPUT', 'SPEC_READY']);
});

test('parseReturn reads the first status and the fields after it, up to a fence', () => {
  const reply = 'Done.\n\n```\nSTATUS: SPEC_READY\nSPEC_PATH: specflow/x/spec.md\nSUMMARY: two lines\n```\nSTATUS: NOT_THIS\n';
  assert.deepEqual(parseReturn(reply), { status: 'SPEC_READY', fields: { SPEC_PATH: 'specflow/x/spec.md', SUMMARY: 'two lines' } });
  assert.equal(parseReturn('no block here'), null);
});

test('openQuestions counts the top-level questions, not the options under them', () => {
  const reply = '```\nSTATUS: NEEDS_INPUT\nOPEN_QUESTIONS:\n- Which store?\n  - (a) Postgres\n  - (b) Redis\n- Soft delete?\n```\nThanks.\n- not a question';
  assert.equal(openQuestions(reply), 2);
  assert.equal(openQuestions('STATUS: NEEDS_INPUT\r\nOPEN_QUESTIONS:\r\n1. a\r\n2. b\r\n3. c\r\n4. d\r\n'), 4);
  assert.equal(openQuestions('STATUS: NEEDS_INPUT\nOPEN_QUESTIONS:\n'), 0);
});
