#!/usr/bin/env node
/**
 * Behaviour fixture for scripts/test-report.mjs.
 *
 * **Every JUnit case below is a byte-for-byte capture of a real emitter's
 * output**, named with the version that produced it. That is the whole design
 * of this file: a parser verified against XML somebody wrote by hand is a
 * parser verified against its own author's assumptions, and the three captures
 * here disagree in exactly the ways such a file would have smoothed over — one
 * closes a passing case with a tag, one self-closes it, one omits the `<?xml?>`
 * declaration and roots the document at `<testsuite>` instead of
 * `<testsuites>`.
 *
 * Re-capture rather than hand-edit when adding an emitter. The value of these
 * strings is entirely that nobody chose them.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readReport } from './test-report.mjs';

const failures = [];

function check(name, fn) {
  try {
    const problem = fn();
    if (problem) failures.push({ name, problem });
  } catch (err) {
    failures.push({ name, problem: `threw: ${err?.stack ?? err}` });
  }
}

/** Writes `text` to a temp file and reads it back through the real entrypoint. */
function read(format, text) {
  const dir = mkdtempSync(join(tmpdir(), 'spec-flow-report-'));
  try {
    writeFileSync(join(dir, 'report'), text);
    return readReport({ format, path: 'report' }, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- the captures ---------------------------------------------------------
//
// Each ran the same two tests: REQ-AUTH-001 executed, REQ-AUTH-002 was skipped.
// The assertion every case makes is therefore identical, which is the point —
// the differences are all in the file, none in what a caller has to know.

// vitest 4.1.10 — `vitest run --reporter=junit`
const VITEST = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="2" failures="0" errors="0" time="0.002392605">
    <testsuite name="v/a.test.js" timestamp="2026-08-16T14:35:52.636Z" hostname="vm" tests="2" failures="0" errors="0" skipped="1" time="0.002392605">
        <testcase classname="v/a.test.js" name="REQ-AUTH-001 rejects a bad password" time="0.001053755">
        </testcase>
        <testcase classname="v/a.test.js" name="REQ-AUTH-002 locks after five attempts" time="0">
            <skipped/>
        </testcase>
    </testsuite>
</testsuites>
`;

// mocha 11.8.0 — `mocha --reporter xunit`
const MOCHA = `<testsuite name="Mocha Tests" tests="2" failures="0" errors="0" skipped="1" timestamp="Sun, 16 Aug 2026 14:35:52 GMT" time="0.001">
<testcase classname="" name="REQ-AUTH-001 rejects a bad password" file="/tmp/m/a.test.cjs" time="0"/>
<testcase classname="" name="REQ-AUTH-002 locks after five attempts" file="/tmp/m/a.test.cjs" time="0"><skipped/></testcase>
</testsuite>
`;

// node 22.22.2 — `node --test --test-reporter=junit`
const NODE_TEST = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
\t<testcase name="REQ-AUTH-001 rejects a bad password" time="0.000857" classname="test"/>
\t<testcase name="REQ-AUTH-002 locks after five attempts" time="0.000129" classname="test">
\t\t<skipped type="skipped" message="not implemented yet"/>
\t</testcase>
\t<!-- tests 2 -->
\t<!-- skipped 1 -->
</testsuites>
`;

// node 22.22.2 — `node --test` (its default reporter)
const NODE_TAP = `TAP version 13
# Subtest: REQ-AUTH-001 rejects a bad password
ok 1 - REQ-AUTH-001 rejects a bad password
# Subtest: REQ-AUTH-002 locks after five attempts
ok 2 - REQ-AUTH-002 locks after five attempts # SKIP not implemented yet
1..2
# tests 2
# pass 1
# skipped 1
`;

const EMITTERS = [
  ['vitest 4.1.10 --reporter=junit', 'junit', VITEST],
  ['mocha 11.8.0 --reporter xunit', 'junit', MOCHA],
  ['node 22 --test-reporter=junit', 'junit', NODE_TEST],
  ['node 22 --test (TAP 13)', 'tap', NODE_TAP],
];

for (const [emitter, format, text] of EMITTERS) {
  check(`${emitter}: the executed test is reported`, () => {
    const r = read(format, text);
    if (r.error) return `refused a valid report: ${r.error}`;
    if (!r.names.some((n) => n.includes('REQ-AUTH-001'))) {
      return `the test that RAN is missing, so its requirement would read as unproven: ${JSON.stringify(r.names)}`;
    }
    return null;
  });

  // The one that matters. A skipped test whose name still reaches spec-trace
  // proves a requirement with a test that never executed — which is the
  // cheapest way to silence a red suite, and the failure this whole engine
  // exists to close.
  check(`${emitter}: the SKIPPED test is not reported`, () => {
    const r = read(format, text);
    if (r.error) return `refused a valid report: ${r.error}`;
    if (r.names.some((n) => n.includes('REQ-AUTH-002'))) {
      return `a skipped test was reported as executed: ${JSON.stringify(r.names)}`;
    }
    return null;
  });
}

// ---- the shapes a hand-written fixture would not have produced ------------

check('a skipped case does not suppress the cases before it', () => {
  const xml = `<testsuites>
  <testcase name="REQ-A-001 first"/>
  <testcase name="REQ-A-002 second"></testcase>
  <testcase name="REQ-A-003 third"><skipped/></testcase>
</testsuites>`;
  const r = read('junit', xml);
  if (r.error) return r.error;
  const got = r.names.join('|');
  if (!/REQ-A-001/.test(got) || !/REQ-A-002/.test(got)) {
    return `a later <skipped> swallowed earlier cases — the body scan is unbounded: ${got}`;
  }
  if (/REQ-A-003/.test(got)) return `the skipped case was reported: ${got}`;
  return null;
});

check('a failure message that quotes XML does not invent a test case', () => {
  const xml = `<testsuites>
  <testcase name="REQ-A-001 real"><failure><![CDATA[expected <testcase name="REQ-A-999 fake"/> here]]></failure></testcase>
</testsuites>`;
  const r = read('junit', xml);
  if (r.error) return r.error;
  if (r.names.some((n) => n.includes('REQ-A-999'))) {
    return `text inside CDATA was parsed as markup, so a requirement is proven by a string in an error message: ${JSON.stringify(r.names)}`;
  }
  if (!r.names.some((n) => n.includes('REQ-A-001'))) return `the real failing case was dropped: ${JSON.stringify(r.names)}`;
  return null;
});

check('a failing test counts as executed', () => {
  const xml = `<testsuites><testcase name="REQ-A-001 red"><failure message="boom"/></testcase></testsuites>`;
  const r = read('junit', xml);
  if (r.error) return r.error;
  if (!r.names.some((n) => n.includes('REQ-A-001'))) {
    return 'a red test read as "never ran", which would route a plain test failure to the traceability check instead of the suite';
  }
  return null;
});

check('entities in a test name are decoded', () => {
  const xml = `<testsuites><testcase name="REQ-A-001 a &amp; b &lt;c&gt; &quot;d&quot;"/></testsuites>`;
  const r = read('junit', xml);
  if (r.error) return r.error;
  if (r.names[0] !== 'REQ-A-001 a & b <c> "d"') return `entities not decoded: ${JSON.stringify(r.names)}`;
  return null;
});

check('TAP: a failing test counts, a skipped one does not, and TODO still ran', () => {
  const tap = `TAP version 13
not ok 1 - REQ-A-001 failed but ran
ok 2 - REQ-A-002 skipped # SKIP later
ok 3 - REQ-A-003 todo # TODO known gap
    ok 4 - REQ-A-004 nested subtest
1..4`;
  const r = read('tap', tap);
  if (r.error) return r.error;
  const got = r.names.join('|');
  if (!/REQ-A-001/.test(got)) return `a failing TAP line read as not-run: ${got}`;
  if (/REQ-A-002/.test(got)) return `a # SKIP line was reported as executed: ${got}`;
  if (!/REQ-A-003/.test(got)) return `a # TODO line read as not-run, but it executed: ${got}`;
  if (!/REQ-A-004/.test(got)) return `an indented subtest was dropped: ${got}`;
  return null;
});

// ---- refusals must be distinguishable from an empty run -------------------

check('a missing report file is an error, not an empty result', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spec-flow-report-'));
  try {
    const r = readReport({ format: 'junit', path: 'nope.xml' }, dir);
    if (!r.error) return 'a report that was never written reported zero tests, which reads as "every requirement is unproven" instead of "the reporter flag is missing"';
    if (!/verify\.test|reporter flag/.test(r.error)) return `the error does not point at the likely cause: ${r.error}`;
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check('an unknown format is refused by name', () => {
  const r = read('xunit-ish', '<testsuites/>');
  if (!r.error) return 'an unsupported format was accepted, so the contract could name a reader that does not exist';
  return null;
});

// `skipped` is what lets spec-trace tell "the suite never ran" from "the suite
// ran and everything was disabled" — the first is a missing reporter flag, the
// second is a finding about the repo. A reader that only returned names would
// make both look identical, and the message would send someone to fix a flag
// that is already correct.
check('an all-skipped report is distinguishable from a report with nothing in it', () => {
  const allSkipped = read('junit', '<testsuites><testcase name="REQ-A-001 x"><skipped/></testcase></testsuites>');
  if (allSkipped.error) return allSkipped.error;
  if (allSkipped.names.length !== 0) return `a skipped test was reported as executed: ${JSON.stringify(allSkipped.names)}`;
  if (allSkipped.skipped !== 1) return `the skip was not counted, so it reads as "the suite never ran": skipped=${allSkipped.skipped}`;

  const nothing = read('junit', '<testsuites></testsuites>');
  if (nothing.skipped !== 0) return `an empty report claimed skips: skipped=${nothing.skipped}`;

  const tap = read('tap', 'TAP version 13\nok 1 - REQ-A-001 x # SKIP nope\n1..1');
  if (tap.skipped !== 1) return `TAP skips are not counted: ${JSON.stringify(tap)}`;
  return null;
});

check('a well-formed report with no tests in it is an empty result, not an error', () => {
  const r = read('junit', '<testsuites></testsuites>');
  if (r.error) return `a readable report was treated as unreadable: ${r.error}`;
  if (r.names.length !== 0) return `invented tests: ${JSON.stringify(r.names)}`;
  return null;
});

if (failures.length > 0) {
  console.error(`test-report-fixture: ${failures.length} case(s) failed\n`);
  for (const f of failures) console.error(`  ✕ ${f.name}\n    ${f.problem}\n`);
  process.exit(1);
}
console.log('test-report-fixture: OK — every capture is a real emitter\'s output, and a skipped test is reported by none of them.');
