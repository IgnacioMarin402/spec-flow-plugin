import { test } from 'node:test';
import assert from 'node:assert';
import { budgetCap } from '../hooks/lib/budgets.mjs';

const cap = (value) => budgetCap(JSON.stringify({ max_architect_calls: value }), 'architect');

// `Number()` reads each of these as a count — true as 1, [5] as 5, [] and ''
// as 0 — and a fraction is no number of calls: none is what a person set.
test('budgetCap reads a cap that is not a whole number of calls as NaN', () => {
  for (const value of [true, false, [5], [], '', '  ', 'six', {}, -1, 2.5, '2.5']) {
    assert.ok(Number.isNaN(cap(value)), JSON.stringify(value));
  }
});

test('budgetCap reads a whole number of calls, written as a number or a numeric string', () => {
  assert.strictEqual(cap(0), 0);
  assert.strictEqual(cap(3), 3);
  assert.strictEqual(cap('4'), 4);
  assert.strictEqual(cap(' 5 '), 5);
});

test('budgetCap falls back to the default for a file that sets nothing, or does not parse', () => {
  assert.strictEqual(budgetCap('', 'architect'), 3);
  assert.strictEqual(budgetCap('{ not json', 'planner'), 6);
  assert.strictEqual(budgetCap(JSON.stringify({ max_architect_calls: null }), 'architect'), 3);
  assert.strictEqual(budgetCap(JSON.stringify({}), 'planner'), 6);
});
