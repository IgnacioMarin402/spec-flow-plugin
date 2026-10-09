import { test } from 'node:test';
import assert from 'node:assert';
import { assumptionsProblem, capabilityOf, declaredIds } from '../scripts/spec-shape.mjs';

const spec = (assumptions) => `# Spec — x\n\n## Requirement deltas\n- ADDED REQ-A-001 — a thing\n${assumptions}\n## Out of scope\n- nothing\n`;

test('a spec that says it assumed nothing passes', () => {
  assert.equal(assumptionsProblem(spec('\n## Assumptions\n- none\n')), '');
});

test('a spec that lists an assumption passes', () => {
  assert.equal(assumptionsProblem(spec('\n## Assumptions\n- emails are unique — a merge flow is needed if not\n')), '');
});

test('a spec with no assumptions section is reported', () => {
  assert.match(assumptionsProblem(spec('')), /no `## Assumptions` section/);
});

test('an empty assumptions section is reported, as the missing one is', () => {
  assert.match(assumptionsProblem(spec('\n## Assumptions\n\n')), /empty/);
});

test('a fix brief is exempt', () => {
  assert.equal(assumptionsProblem('# Fix — x\n\n## Case\n2 WEAK-TEST\n'), '');
});

test('a delta touches the spec declaring its id, else the longest prefix, else none', () => {
  const specs = [
    { file: 'specs/user.md', ids: declaredIds('### REQ-USER-001 — a\n### REQ-USER-PROFILE-007 — moved here\n') },
    { file: 'specs/user-profile.md', ids: new Set() },
  ];
  assert.equal(capabilityOf('REQ-USER-PROFILE-007', specs), 'specs/user.md');
  assert.equal(capabilityOf('REQ-USER-PROFILE-008', specs), 'specs/user-profile.md');
  assert.equal(capabilityOf('REQ-USER-002', specs), 'specs/user.md');
  assert.equal(capabilityOf('REQ-ORDER-001', specs), null);
});
