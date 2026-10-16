import { test } from 'node:test';
import assert from 'node:assert';
import { liveSpecProblems } from '../scripts/spec-shape.mjs';

// Only `liveSpecProblems`, whose signature predates the rule: these cases run
// unchanged on a commit without it, which is what tells the ones that prove
// the defect from the ones that guard against overreach (ADR-045).
const problems = (deltas, heading = '# Spec — x') =>
  liveSpecProblems('x', `${heading}\n\n## Requirement deltas\n${deltas}\n\n## Out of scope\n- nothing\n`, {
    hasProposal: true,
    archivedBodies: [],
  });

const refused = (delta) => {
  const found = problems(delta);
  assert.equal(found.length, 1, `not refused: ${delta}`);
  assert.match(found[0], /REQ-A-001/);
  assert.match(found[0], /prohibition/);
  assert.match(found[0], /id of its own/);
};
const passes = (delta) => assert.deepEqual(problems(delta), [], `refused: ${delta}`);

test('a prohibition paired with what the requirement allows is refused', () => {
  refused('- ADDED REQ-A-001 — filters by A and B, never by C');
  refused('- ADDED REQ-A-001 — filters by A and B and never by C');
  refused('- ADDED REQ-A-001 — filters by A and B but never by C');
  refused('- ADDED REQ-A-001 — lists the user\'s orders and must not list another user\'s');
  refused('- ADDED REQ-A-001 — returns the order; a locked account cannot read it');
  refused('- ADDED REQ-A-001 — admins can delete a post — other users cannot');
  refused('- ADDED REQ-A-001: returns 404, never 500, for a missing order');
});

test('a prohibition stated first and paired after is refused', () => {
  refused('- ADDED REQ-A-001 — never stores the card, and masks it in the receipt');
  refused('- ADDED REQ-A-001 — only admins can delete a post, and the delete is logged');
  refused('- ADDED REQ-A-001 — when the cart is empty, checkout is never offered, and a hint is shown');
});

test('an ADDED delta that is only a prohibition passes', () => {
  passes('- ADDED REQ-A-001 — a guest cannot delete an order');
  passes('- ADDED REQ-A-001 — the search must not filter by C');
  passes('- ADDED REQ-A-001 — a filter never matches on C');
  passes('- ADDED REQ-A-001 — only an admin may delete a post');
  passes('- ADDED REQ-A-001 — Only admins and owners may delete a post');
  passes('- ADDED REQ-A-001 — never sends email or SMS to an unverified address');
  passes('- ADDED REQ-A-001 — filters only by name, city and country');
  passes('- ADDED REQ-A-001 — when the cart is empty, checkout is never offered');
});

test('the words in a subordinate clause describe, so they are not refused', () => {
  passes('- ADDED REQ-A-001 — returns 404 when the user cannot be found');
  passes('- ADDED REQ-A-001 — returns 404 when the user cannot be found, and logs the lookup');
  passes('- ADDED REQ-A-001 — cancels an order that was never paid, and emails the buyer');
  passes('- ADDED REQ-A-001 — lists a user who has never logged in as dormant, and emails them weekly');
});

test('ordinary uses of the words are not refused', () => {
  passes('- ADDED REQ-A-001 — returns not only the order but also its lines');
  passes('- ADDED REQ-A-001 — lists the only admin first, and the rest by name');
  passes('- ADDED REQ-A-001 — lists read-only fields, and sorts them by name');
  passes('- ADDED REQ-A-001 — lists never-expiring tokens; sorts them by owner');
  passes('- ADDED REQ-A-001 — the `--only` flag narrows the export, and the `neverExpires` field is listed');
  passes('- ADDED REQ-A-001 — answers "cannot be empty" for a blank name, and keeps the draft');
  passes('- ADDED REQ-A-001 — onlyActive narrows the list, and neverSent is shown');
});

test('several claims with no prohibition are not this rule\'s business', () => {
  passes('- ADDED REQ-A-001 — filters by A and B, sorts by C; pages by 20');
});

test('the words outside an ADDED delta are not read', () => {
  passes('- CHANGED REQ-A-001 (wording) — filters by A and B, never by C');
  passes('- REMOVED REQ-A-001 — filtered by A and B, never by C');
  const body = '# Spec — x\n\nIt filters by A and B, and never by C.\n\n## Requirement deltas\n- ADDED REQ-A-001 — filters by A and B\n\n## Out of scope\n- sorting, and never paging\n';
  assert.deepEqual(liveSpecProblems('x', body, { hasProposal: true, archivedBodies: [] }), []);
});

test('a fix brief is held to it: a case 1 adds a requirement as a feature does', () => {
  const found = problems('- ADDED REQ-A-001 — filters by A and B, never by C', '# Fix — x\n\n## Case\n1 UNSPECIFIED');
  assert.equal(found.length, 1);
  assert.match(found[0], /prohibition/);
});

test('each paired delta is named, and only those', () => {
  const found = problems('- ADDED REQ-A-001 — filters by A, never by C\n- ADDED REQ-A-002 — never sorts by C\n- ADDED REQ-A-003 — sorts by B; never by C');
  assert.equal(found.length, 2);
  assert.match(found[0], /REQ-A-001/);
  assert.match(found[1], /REQ-A-003/);
});
