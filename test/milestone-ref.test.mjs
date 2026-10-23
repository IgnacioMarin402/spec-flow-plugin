import { test } from 'node:test';
import assert from 'node:assert';
import { milestoneRef } from '../hooks/lib/milestone-ref.mjs';

test('the work order names the change and the milestone, in either separator', () => {
  assert.deepStrictEqual(milestoneRef('implement specflow/add-users/milestones/M2.md per the plan'), { change: 'add-users', milestone: 'M2' });
  assert.deepStrictEqual(milestoneRef('implement C:\\repo\\specflow\\add-users\\milestones\\M2.md'), { change: 'add-users', milestone: 'M2' });
  assert.deepStrictEqual(milestoneRef('`specflow/add-users/milestones/M12.md`'), { change: 'add-users', milestone: 'M12' });
});

test('the work order wins over a milestone file named before it', () => {
  assert.deepStrictEqual(milestoneRef('see docs/milestones/M1.md, then implement specflow/add-users/milestones/M2.md'), { change: 'add-users', milestone: 'M2' });
  assert.deepStrictEqual(milestoneRef('after milestones/M1.md, implement specflow/add-users/milestones/M2.md'), { change: 'add-users', milestone: 'M2' });
});

test('a bare milestones/<Mk>.md names the milestone with no change; one deeper in a path names nothing', () => {
  assert.deepStrictEqual(milestoneRef('re-read plan.md and milestones/M3.md'), { change: '', milestone: 'M3' });
  assert.deepStrictEqual(milestoneRef('re-read `milestones\\M3.md`'), { change: '', milestone: 'M3' });
  assert.strictEqual(milestoneRef('see docs/milestones/M1.md'), null);
  assert.strictEqual(milestoneRef('see ./milestones/M1.md'), null);
});

test('a prompt naming no milestone, or no prompt, names none', () => {
  assert.strictEqual(milestoneRef('implement the plan'), null);
  assert.strictEqual(milestoneRef('specflow/add-users/plan.md'), null);
  assert.strictEqual(milestoneRef(undefined), null);
  assert.strictEqual(milestoneRef({ prompt: 'specflow/add-users/milestones/M2.md' }), null);
});
