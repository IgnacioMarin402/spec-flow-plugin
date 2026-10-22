import { test } from 'node:test';
import assert from 'node:assert';
import { assumptionsProblem, capabilityOf, declaredIds, deltas, deltasSectionProblem, retiredIds, reusedIds, unreadDeltas } from '../scripts/spec-shape.mjs';

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

test('a numbered or plus-sign assumptions list is a list', () => {
  assert.equal(assumptionsProblem(spec('\n## Assumptions\n1. emails are unique — a merge flow if not\n')), '');
  assert.equal(assumptionsProblem(spec('\n## Assumptions\n+ none\n')), '');
});

test('an ADDED id whose capability has no file touches no other capability', () => {
  const specs = [{ file: 'specs/user.md', ids: declaredIds('### REQ-USER-001 — a\n') }];
  assert.equal(capabilityOf('REQ-USER-PROFILE-001', specs), null);
});

// ---- the deltas: one grammar, read or refused ------------------------------

const deltasOf = (section) => `# Spec — x\n\n## Requirement deltas\n${section}\n\n## Assumptions\n- none\n`;
const read = (section) => [...deltas(deltasOf(section))].map((d) => `${d.verb} ${d.id}`);
const refused = (section) => [...unreadDeltas(deltasOf(section))].map((u) => u.why);

test('a delta is one line: a dash, the verb in capitals, the id', () => {
  assert.deepStrictEqual(read('- ADDED   REQ-A-001 — a\n* CHANGED REQ-A-002 (wording) — b\n-REMOVED REQ-A-003 — c'), ['ADDED REQ-A-001', 'CHANGED REQ-A-002', 'REMOVED REQ-A-003']);
  assert.deepStrictEqual(refused('- ADDED REQ-A-001 — a'), []);
});

test('a delta spelled any other way is refused, never skipped', () => {
  for (const line of [
    '- ADDED\n  REQ-A-002 — wrapped after its verb',
    '| ADDED | REQ-A-002 | a table row |',
    '- [ADDED] REQ-A-002 — bracketed',
    '- (ADDED) REQ-A-002 — in parentheses',
    '- REQ-A-002 (ADDED) — the verb after the id',
    '- [x] ADDED REQ-A-002 — a checkbox',
    '- **ADDED** REQ-A-002 — bold',
    '+ ADDED REQ-A-002 — a plus sign',
    '  - ADDED REQ-A-002 — indented',
    '### ADDED REQ-A-002 — a heading',
    '- added REQ-A-002 — lowercase',
    '- ADDED: REQ-A-002 — a colon',
  ]) {
    assert.deepStrictEqual(read(line), [], line);
    assert.ok(refused(line).includes('unread'), line);
  }
});

test('a second id, or a range, before the text is refused', () => {
  for (const line of [
    '- ADDED REQ-A-002, REQ-A-003 — two',
    '- ADDED REQ-A-002 and REQ-A-003 — two',
    '- ADDED REQ-A-002; REQ-A-003 — two',
    '- ADDED REQ-A-002 to REQ-A-004 — a range',
    '- ADDED REQ-A-002–004 — a range',
    '- ADDED REQ-A-002..REQ-A-004 — a range',
    '- ADDED REQ-A-009 - REQ-A-010 a range',
    '- CHANGED REQ-A-001 (wording), REQ-A-002 — two',
  ]) {
    assert.deepStrictEqual(refused(line), ['two-ids'], line);
  }
});

test('prose, a note under a delta and an id in its text are neither read nor refused', () => {
  const section = [
    '> What this change does to `specs/`.',
    '- REMOVED REQ-A-001 (REQ-A-004 supersedes it)',
    '- REMOVED REQ-A-005 — REQ-A-006 replaces it',
    '- ADDED REQ-A-007 — 300 requests per second',
    '  - Removed because nobody uses it',
    '- Added the export button to the README',
    '- Changed: none',
    'Changed nothing in specs/.',
    '- none — infrastructure only',
  ].join('\n');
  assert.deepStrictEqual(read(section), ['REMOVED REQ-A-001', 'REMOVED REQ-A-005', 'ADDED REQ-A-007']);
  assert.deepStrictEqual(refused(section), []);
});

test('an example in a code fence is neither read nor refused', () => {
  const section = '- none — infrastructure only\n```\n- ADDED REQ-A-099 — an example\n| ADDED | REQ-A-098 |\n```';
  assert.deepStrictEqual(read(section), []);
  assert.deepStrictEqual(refused(section), []);
});

test('deltas under another heading, or outside their section, are refused', () => {
  const at = (body) => deltasSectionProblem(body, { needed: false });
  assert.match(at('# S\n\n## Requirement Deltas\n- ADDED REQ-A-002 — x\n'), /has "## Requirement Deltas"/);
  assert.match(at('# S\n\n### Requirement deltas\n- ADDED REQ-A-002 — x\n'), /has "### Requirement deltas"/);
  assert.match(at('# S\n\n## ADDED Requirements\n### REQ-A-002 — x\n'), /outside `## Requirement deltas` \("## ADDED Requirements"\)/);
  assert.match(at('# S\n\n## Deltas\n- ADDED REQ-A-002 — x\n'), /outside/);
  assert.equal(at('# S\n\n## Context\nWe added REQ-A-002 last time.\n\n## Requirement deltas\n- none\n'), '', 'prose elsewhere');
  assert.equal(at('# S\n\n```\n## Requirement Deltas\n```\n\n## Requirement deltas\n- none\n'), '', 'a fenced example');
});

test('a spec with no deltas section is refused where one is needed', () => {
  const body = '# S\n\n## User stories\n- US-1 — x\n';
  assert.match(deltasSectionProblem(body, { needed: true }), /no `## Requirement deltas` section/);
  assert.equal(deltasSectionProblem(body, { needed: false }), '');
});

test('a second id after a space alone is refused', () => {
  assert.deepStrictEqual(refused('- ADDED REQ-A-002 REQ-A-003 — two'), ['two-ids']);
});

test('a second number after the id, listed or as a range, is refused', () => {
  for (const line of [
    '- ADDED REQ-A-001, 002 — export and import',
    '- ADDED REQ-A-001 to 002 — x',
    '- ADDED REQ-A-001 – 002 — x',
    '- ADDED REQ-A-001/002 — x',
    '- ADDED REQ-A-002—004 — x',
    '- ADDED REQ-A-002 .. 004 — x',
    '- ADDED REQ-A-002 & 003 — x',
    '- ADDED REQ-A-002 and 003 — x',
    '- ADDED REQ-A-001~003 — x',
  ]) {
    assert.deepStrictEqual(refused(line), ['two-ids'], line);
  }
  for (const line of [
    '- ADDED REQ-A-001 — 300 requests per second',
    '- ADDED REQ-A-001 100 users can export at once',
    '- ADDED REQ-A-001: 500 errors are retried',
    '- ADDED REQ-A-001 - 500 errors are retried',
    '- CHANGED REQ-A-001 (wording) — 300 ms',
  ]) {
    assert.deepStrictEqual(refused(line), [], line);
  }
});

test('a number the text goes on from is the text', () => {
  for (const line of [
    '- ADDED REQ-A-002 - 404 or 410 for a deleted user',
    '- ADDED REQ-A-002 – 100 to 200 ms jitter is tolerated',
    '- ADDED REQ-A-002 - 401, not 403, for a bad token',
    '- CHANGED REQ-A-001 (wording) - 300. Still the same',
  ]) {
    assert.deepStrictEqual(refused(line), [], line);
  }
});

test('an id whose capability is named for a number is one id', () => {
  for (const id of ['REQ-RFC-822-001', 'REQ-ADR-009-010', 'REQ-A-002-004']) {
    assert.deepStrictEqual(read(`- ADDED ${id} — x`), [`ADDED ${id}`]);
    assert.deepStrictEqual(refused(`- ADDED ${id} — x`), []);
  }
});

test('a delta with its verb after the id, another bullet or in a quote is refused', () => {
  for (const line of [
    '| REQ-A-002 | Export to CSV | ADDED |',
    '- REQ-A-002 ADDED — export',
    '- REQ-A-002: ADDED — export',
    '– ADDED REQ-A-002 — an en dash',
    '• ADDED REQ-A-002 — a bullet',
    '> - ADDED REQ-A-002 — quoted',
    '- Added REQ-A-002 — export',
    '· ADDED REQ-A-002 — a middle dot',
    '\u00a0- ADDED REQ-A-002 — a no-break space before the dash',
    'a) ADDED REQ-A-002 — a lettered list',
    '- NEW REQ-A-002 — another word',
    '- REQ-A-002 Added — the verb after the id',
    '- REQ-A-002 — ADDED: the verb in the text',
  ]) {
    assert.deepStrictEqual(read(line), [], line);
    assert.ok(refused(line).includes('unread'), line);
  }
});

test('a table row names its id in any case', () => {
  for (const line of ['| REQ-A-002 | Added | export to CSV |', '| added | REQ-A-002 | export to CSV |', '| Removed | REQ-A-002 |', '| Added | REQ-A-002 | x |']) {
    const section = `- ADDED REQ-A-001 — import\n${line}`;
    assert.deepStrictEqual(read(section), ['ADDED REQ-A-001'], line);
    assert.deepStrictEqual(refused(section), ['unread'], line);
  }
});

test('in a delta\'s text, a verb in capitals before an id starts another delta', () => {
  assert.deepStrictEqual(refused('- ADDED REQ-A-001 — export; ADDED REQ-A-002 — import'), ['unread']);
  assert.deepStrictEqual(refused('- ADDED REQ-A-001 — export; ADDED REQ-A-002 — import\n- ADDED REQ-A-002 — import'), []);
});

test('a verb another format writes is refused, never read', () => {
  for (const line of ['- MODIFIED REQ-A-001 — now also PDF', '- UPDATED REQ-A-001 — x', '- DELETED REQ-A-001 — gone', '- RENAMED REQ-A-001 — to export', '- Updated REQ-A-001 wording']) {
    assert.deepStrictEqual(read(line), [], line);
    assert.ok(refused(line).includes('unread'), line);
  }
  assert.match(deltasSectionProblem('# S\n\n## MODIFIED Requirements\n### Requirement: x\n\n## Requirement deltas\n- none\n', { needed: true }), /outside `## Requirement deltas` \("## MODIFIED Requirements"\)/);
});

test("a note names only ids its deltas read; a delta's own text may name any", () => {
  const section = [
    '- REMOVED REQ-A-001 — legacy export; REQ-A-004 will replace it in a follow-up',
    '  - Removed for now; REQ-A-001 goes with its test',
    '- ADDED REQ-A-005 — sync',
    '  - Added after review; REQ-A-005 stays behind a flag',
    '> REQ-A-005 ships dark.',
  ].join('\n');
  assert.deepStrictEqual(read(section), ['REMOVED REQ-A-001', 'ADDED REQ-A-005']);
  assert.deepStrictEqual(refused(section), []);
  for (const note of ['  - Removed for now; REQ-A-004 will replace it', '- Changed from thirty; REQ-A-003 keeps its timeout', 'REQ-A-003 keeps its timeout.']) {
    assert.deepStrictEqual(refused(`- REMOVED REQ-A-001 — legacy export\n${note}`), ['unread'], note);
  }
});

test('notes, headings and HTTP words in the section name no delta of their own', () => {
  const section = [
    '### Create',
    '- ADDED REQ-API-008 — POST /users creates a user',
    '### Update',
    '- ADDED REQ-API-009 — PUT /users/:id replaces it',
    '  - REQ-API-009 DELETE /users/:id answers 204',
    '  - UPDATE statements run in one transaction',
    '### Delete',
    '- REMOVED REQ-API-010 — the batch delete',
    '  - DELETE /legacy/users now answers 410',
    '  - DEPRECATED since v2.3',
  ].join('\n');
  assert.deepStrictEqual(read(section), ['ADDED REQ-API-008', 'ADDED REQ-API-009', 'REMOVED REQ-API-010']);
  assert.deepStrictEqual(refused(section), []);
});

test('only REMOVED in capitals retires: a note, or the verb in another case, retires nothing', () => {
  assert.deepStrictEqual(retiredIds(deltasOf('- REMOVED REQ-A-001 — legacy export\n  - Removed for now; REQ-A-004 will replace it in a follow-up')), ['REQ-A-001']);
  assert.deepStrictEqual(retiredIds(deltasOf('- Removed REQ-A-004 — x\n- REQ-A-005 (removed)\n| Removed | REQ-A-006 |')), []);
  assert.deepStrictEqual(retiredIds(deltasOf('| REMOVED | REQ-A-006 |')), ['REQ-A-006']);
});

test('a comment, a nested fence and indented code declare nothing', () => {
  for (const section of [
    '- ADDED REQ-A-001 — x\n<!--\n- ADDED REQ-A-003 — dropped\n-->',
    '- ADDED REQ-A-001 — x\n````md\n```\n- ADDED REQ-A-099 — an example\n```\n````',
    '- ADDED REQ-A-001 — x\n~~~md\n```\n- ADDED REQ-A-099 — an example\n```\n~~~',
    '- ADDED REQ-A-001 — x\n\nFor example:\n\n    - ADDED REQ-A-099 — an example',
  ]) {
    assert.deepStrictEqual(read(section), ['ADDED REQ-A-001'], section);
    assert.deepStrictEqual(refused(section), [], section);
  }
});

test('a comment marker in a code span hides nothing, and a fence ends with its list item', () => {
  const quoted = '- ADDED REQ-A-001 — strips `<!--` from names\n- ADDED REQ-A-002 — export\n- ADDED REQ-A-003 — strips `-->` too';
  assert.deepStrictEqual(read(quoted), ['ADDED REQ-A-001', 'ADDED REQ-A-002', 'ADDED REQ-A-003']);
  assert.deepStrictEqual(read('- ADDED REQ-A-001 — x\n  ```\n- ADDED REQ-A-002 — y\n  ```'), ['ADDED REQ-A-001', 'ADDED REQ-A-002']);
});

test('a fence never closed, and lines ended by CR alone, still declare', () => {
  assert.deepStrictEqual(read('```\n- ADDED REQ-A-002 — x'), ['ADDED REQ-A-002']);
  assert.deepStrictEqual([...deltas(deltasOf('- ADDED REQ-A-002 — x').replace(/\n/g, '\r'))].map((d) => d.id), ['REQ-A-002']);
  assert.deepStrictEqual([...deltas(deltasOf('- ADDED REQ-A-002 — x').replace(/\n/g, '\r\n'))].map((d) => d.id), ['REQ-A-002']);
});

test('outside the section, a word in capitals that names no id is not a delta', () => {
  const at = (body) => deltasSectionProblem(body, { needed: true });
  const around = (outside) => `# S\n\n${outside}\n\n## Requirement deltas\n- ADDED REQ-A-002 — x\n`;
  for (const outside of [
    '## Non-functional / constraints\n- `REMOVED` items never reappear after a sync\n- `ADDED` events carry the item id',
    '## Symptom\n- ADDED role admin to user 42\n- ADDED role admin to user 42',
    '## Notes\nADDED in response to issue #12.',
    '## User stories\n- ADDED value: users export',
    '## States\n### Update\n### Deleted',
    '## API\n| /users/:id | DELETE | REQ-A-001 |\n- REQ-A-001 (deleted users are hidden) is unchanged\n### REQ-A-002: DELETE /users/:id',
    '## States\n| DELETED | REQ-A-001 |',
    '## Context\n- added REQ-A-003 last time, as prose',
  ]) {
    assert.equal(at(around(outside)), '', outside);
  }
  assert.match(at(around('## Deltas\n- ADDED REQ-A-003 — y')), /outside `## Requirement deltas` \("- ADDED REQ-A-003/);
  assert.match(at(around('## Deltas\n| REMOVED | REQ-A-003 |')), /outside `## Requirement deltas` \("\| REMOVED \| REQ-A-003 \|"\)/);
});

test('a section the engine reads nothing in is refused where one is needed', () => {
  const at = (section) => deltasSectionProblem(`# S\n\n## Requirement deltas\n${section}\n`, { needed: true });
  assert.match(at('This change adds the export.'), /says nothing the engine reads/);
  assert.match(at('### ADDED'), /says nothing the engine reads/);
  assert.match(at('\n    - ADDED REQ-A-002 — indented into a code block'), /says nothing the engine reads/);
  assert.match(at(''), /says nothing the engine reads/);
  assert.equal(at('- none — infrastructure only'), '');
  assert.equal(at('- **None**'), '');
  assert.equal(at('- added REQ-A-002 — refused as a line instead'), '');
  assert.equal(deltasSectionProblem('# S\n\n## Requirement deltas\nprose\n', { needed: false }), '');
});

test('a section says it has no delta in the words writers use', () => {
  const at = (section) => deltasSectionProblem(`# S\n\n## Requirement deltas\n${section}\n`, { needed: true });
  for (const none of [
    'None — infrastructure only',
    '_None._',
    '- n/a — wiring only',
    '- No requirement changes — wiring only',
    '- No deltas: wiring only',
    '1. none — wiring only',
    '  - none — wiring only',
    '> none — wiring only',
    '- Nothing changes in specs/ — wiring only',
    'No change — REQ-A-001 is right; its test missed a case',
  ]) {
    assert.equal(at(none), '', none);
    assert.deepStrictEqual(refused(none), [], none);
  }
  assert.deepStrictEqual(refused('- No longer exports CSV (REQ-A-002)'), ['unread']);
});

test('a REMOVED line retires each id it names before its text, however it is spelled', () => {
  assert.deepStrictEqual(retiredIds(deltasOf('- REMOVED REQ-A-001, REQ-A-002 — both')), ['REQ-A-001', 'REQ-A-002']);
  assert.deepStrictEqual(retiredIds(deltasOf('  - REMOVED REQ-A-003\n- **REMOVED** REQ-A-004\n- REQ-A-005 (REMOVED)')), ['REQ-A-003', 'REQ-A-004', 'REQ-A-005']);
  assert.deepStrictEqual(retiredIds(deltasOf('- REMOVED REQ-A-006 (REQ-A-007 supersedes it)\n- ADDED REQ-A-008 — x')), ['REQ-A-006']);
});

test('an ADDED id an archived change retired in another spelling is reused', () => {
  const archived = `# Spec — old\n\n**Status:** SHIPPED 2026-07-30\n\n## Requirement deltas\n- REMOVED REQ-A-001, REQ-A-002 — both gone\n`;
  assert.deepStrictEqual(reusedIds(deltasOf('- ADDED REQ-A-002 — again'), [archived]), ['REQ-A-002']);
  assert.deepStrictEqual(reusedIds(deltasOf('- ADDED REQ-A-002 — again'), [archived.replace('SHIPPED', 'REJECTED')]), [], 'a change turned down removed nothing');
});
