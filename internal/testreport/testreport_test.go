package testreport

// Every JUnit and TAP capture below is a byte-for-byte copy of a real
// emitter's output, named with the version that produced it: a parser checked
// against XML written by hand is checked against its author's assumptions.
// Re-capture rather than hand-edit when adding an emitter.

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func read(t *testing.T, format, text string) Report {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "report"), []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
	return Read(format, "report", dir)
}

func names(r Report) string { return strings.Join(r.Names, "|") }

func has(r Report, id string) bool { return strings.Contains(names(r), id) }

// Each ran the same two tests: REQ-AUTH-001 executed, REQ-AUTH-002 was skipped.

// vitest 4.1.10 — `vitest run --reporter=junit`
const vitest = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="2" failures="0" errors="0" time="0.002392605">
    <testsuite name="v/a.test.js" timestamp="2026-08-16T14:35:52.636Z" hostname="vm" tests="2" failures="0" errors="0" skipped="1" time="0.002392605">
        <testcase classname="v/a.test.js" name="REQ-AUTH-001 rejects a bad password" time="0.001053755">
        </testcase>
        <testcase classname="v/a.test.js" name="REQ-AUTH-002 locks after five attempts" time="0">
            <skipped/>
        </testcase>
    </testsuite>
</testsuites>
`

// mocha 11.8.0 — `mocha --reporter xunit`
const mocha = `<testsuite name="Mocha Tests" tests="2" failures="0" errors="0" skipped="1" timestamp="Sun, 16 Aug 2026 14:35:52 GMT" time="0.001">
<testcase classname="" name="REQ-AUTH-001 rejects a bad password" file="/tmp/m/a.test.cjs" time="0"/>
<testcase classname="" name="REQ-AUTH-002 locks after five attempts" file="/tmp/m/a.test.cjs" time="0"><skipped/></testcase>
</testsuite>
`

// node 24.22.2 — `node --test --test-reporter=junit`. Only the absolute path
// in `file` was rewritten to `/v/`.
const nodeJunit = "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<testsuites>\n" +
	"\t<testcase name=\"REQ-AUTH-001 rejects a bad password\" time=\"0.000925\" classname=\"test\" file=\"/v/test/a.test.js\"/>\n" +
	"\t<testcase name=\"REQ-AUTH-002 locks after five attempts\" time=\"0.000189\" classname=\"test\" file=\"/v/test/a.test.js\">\n" +
	"\t\t<skipped type=\"skipped\" message=\"not implemented yet\"/>\n\t</testcase>\n" +
	"\t<!-- tests 2 -->\n\t<!-- suites 0 -->\n\t<!-- pass 1 -->\n\t<!-- fail 0 -->\n\t<!-- cancelled 0 -->\n" +
	"\t<!-- skipped 1 -->\n\t<!-- todo 0 -->\n\t<!-- duration_ms 92.107736 -->\n</testsuites>\n"

// node 24.22.2 — `node --test --test-reporter=tap`. Not the default reporter,
// which is `spec` from Node 23 on and is not a report format.
const nodeTap = `TAP version 13
# Subtest: REQ-AUTH-001 rejects a bad password
ok 1 - REQ-AUTH-001 rejects a bad password
  ---
  duration_ms: 1.34885
  type: 'test'
  ...
# Subtest: REQ-AUTH-002 locks after five attempts
ok 2 - REQ-AUTH-002 locks after five attempts # SKIP not implemented yet
  ---
  duration_ms: 0.320101
  type: 'test'
  ...
1..2
# tests 2
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 1
# todo 0
# duration_ms 126.412154
`

// node 24.13.1 — `node --test --test-reporter=tap`, over:
//
//	it('REQ-A-001 ran', () => {});
//	it.todo('REQ-A-002 placeholder with no body');
//	it.todo('REQ-A-003 todo whose body fails', () => { assert.fail('not implemented'); });
//	it('REQ-A-004 parses a # TODO marker in its input', () => {});
//	it.skip('REQ-A-005 skipped', () => {});
//
// The suite exited 0. Only the absolute paths in `location` and `stack` were
// rewritten to `/v/`, by script; no `ok`/`not ok` line was touched.
const nodeTapTodo = `TAP version 13
# Subtest: REQ-A-001 ran
ok 1 - REQ-A-001 ran
  ---
  duration_ms: 0.5376
  type: 'test'
  ...
# Subtest: REQ-A-002 placeholder with no body
ok 2 - REQ-A-002 placeholder with no body # TODO
  ---
  duration_ms: 0.4106
  type: 'test'
  ...
# Subtest: REQ-A-003 todo whose body fails
not ok 3 - REQ-A-003 todo whose body fails # TODO
  ---
  duration_ms: 0.7449
  type: 'test'
  location: '/v/t.test.mjs:5:4'
  failureType: 'testCodeFailure'
  error: 'not implemented'
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  operator: 'fail'
  stack: |-
    TestContext.<anonymous> (file:///v/t.test.mjs:5:59)
    Test.runInAsyncScope (node:async_hooks:214:14)
    Test.run (node:internal/test_runner/test:1103:25)
    Test.processPendingSubtests (node:internal/test_runner/test:785:18)
    Test.postRun (node:internal/test_runner/test:1232:19)
    Test.run (node:internal/test_runner/test:1160:12)
    async Test.processPendingSubtests (node:internal/test_runner/test:785:7)
  ...
# Subtest: REQ-A-004 parses a \# TODO marker in its input
ok 4 - REQ-A-004 parses a \# TODO marker in its input
  ---
  duration_ms: 0.0685
  type: 'test'
  ...
# Subtest: REQ-A-005 skipped
ok 5 - REQ-A-005 skipped # SKIP
  ---
  duration_ms: 0.8503
  type: 'test'
  ...
1..5
# tests 5
# suites 0
# pass 2
# fail 0
# cancelled 0
# skipped 1
# todo 2
# duration_ms 76.452
`

func TestEmitters(t *testing.T) {
	for _, e := range []struct{ emitter, format, text string }{
		{"vitest 4.1.10 --reporter=junit", "junit", vitest},
		{"mocha 11.8.0 --reporter xunit", "junit", mocha},
		{"node 24 --test-reporter=junit", "junit", nodeJunit},
		{"node 24 --test-reporter=tap", "tap", nodeTap},
	} {
		r := read(t, e.format, e.text)
		if r.Error != "" {
			t.Errorf("%s: refused a valid report: %s", e.emitter, r.Error)
			continue
		}
		if !has(r, "REQ-AUTH-001") {
			t.Errorf("%s: the test that RAN is missing: %q", e.emitter, r.Names)
		}
		// A skipped test reaching spec-trace proves a requirement with a test that never ran.
		if has(r, "REQ-AUTH-002") {
			t.Errorf("%s: a skipped test was reported as executed: %q", e.emitter, r.Names)
		}
	}
}

// The same runner's JUnit reporter marks both todos `<skipped type="todo">`.
func TestNodeTapTodoIsNotProof(t *testing.T) {
	r := read(t, "tap", nodeTapTodo)
	switch {
	case r.Error != "":
		t.Fatalf("refused a valid report: %s", r.Error)
	case has(r, "REQ-A-002"):
		t.Fatalf("a bodiless it.todo was reported as executed: %s", names(r))
	case has(r, "REQ-A-003"):
		t.Fatalf("a todo whose body FAILED was reported as executed: %s", names(r))
	case !has(r, "REQ-A-001"):
		t.Fatalf("the test that ran was dropped: %s", names(r))
	case !has(r, "REQ-A-004"):
		t.Fatalf(`an escaped \# in a name was read as a directive: %s`, names(r))
	case r.Skipped != 3:
		t.Fatalf("expected the skip and both todos counted as not-run, got skipped=%d", r.Skipped)
	}
}

// ---- a verdict per test

// One run over two files, as each emitter reported it: area's file imports a
// module that does not exist yet, so REQ-GEO-001 never ran; in perim's,
// REQ-GEO-002 failed and REQ-GEO-003 passed. Run under node 24.22.2; only the
// absolute paths were rewritten to `/v/`, by script. mocha 12.0.3 over the
// same two files wrote no report at all.

const nodeJunitNoLoad = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
	<testcase name="cap/node/area.test.mjs" time="0.061817" classname="test" file="/v/cap/node/area.test.mjs" failure="test failed">
		<failure type="testCodeFailure" message="test failed">
[Error: test failed] { code: 'ERR_TEST_FAILURE', failureType: 'testCodeFailure', cause: 'test failed', exitCode: 1, signal: null }
		</failure>
	</testcase>
	<testcase name="REQ-GEO-002 perimeter of a square" time="0.001671" classname="test" file="/v/cap/node/perim.test.mjs" failure="0 == 8">
		<failure type="testCodeFailure" message="0 == 8">
[Error [ERR_TEST_FAILURE]: 0 == 8] {
  code: 'ERR_TEST_FAILURE',
  failureType: 'testCodeFailure',
  cause: AssertionError [ERR_ASSERTION]: 0 == 8
      at TestContext.&lt;anonymous> (file:///v/cap/node/perim.test.mjs:4:58)
      at Test.runInAsyncScope (node:async_hooks:227:14)
      at Test.run (node:internal/test_runner/test:1402:25)
      at Test.start (node:internal/test_runner/test:1262:17)
      at startSubtestAfterBootstrap (node:internal/test_runner/harness:387:17) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 0,
    expected: 8,
    operator: '==',
    diff: 'simple'
  }
}
		</failure>
	</testcase>
	<testcase name="REQ-GEO-003 perimeter of nothing" time="0.000639" classname="test" file="/v/cap/node/perim.test.mjs"/>
	<!-- tests 3 -->
	<!-- suites 0 -->
	<!-- pass 1 -->
	<!-- fail 2 -->
	<!-- cancelled 0 -->
	<!-- skipped 0 -->
	<!-- todo 0 -->
	<!-- duration_ms 87.745664 -->
</testsuites>
`

const nodeTapNoLoad = `TAP version 13
# node:internal/modules/esm/resolve:272
#     throw new ERR_MODULE_NOT_FOUND(
#           ^
# Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/v/cap/node/area.mjs' imported from /v/cap/node/area.test.mjs
#     at finalizeResolution (node:internal/modules/esm/resolve:272:11)
#     at moduleResolve (node:internal/modules/esm/resolve:879:10)
#     at defaultResolve (node:internal/modules/esm/resolve:1006:11)
#     at \#cachedDefaultResolve (node:internal/modules/esm/loader:705:20)
#     at \#resolveAndMaybeBlockOnLoaderThread (node:internal/modules/esm/loader:725:38)
#     at ModuleLoader.resolveSync (node:internal/modules/esm/loader:763:56)
#     at \#resolve (node:internal/modules/esm/loader:687:17)
#     at ModuleLoader.getOrCreateModuleJob (node:internal/modules/esm/loader:607:35)
#     at ModuleJob.syncLink (node:internal/modules/esm/module_job:276:33)
#     at ModuleJob.link (node:internal/modules/esm/module_job:381:17) {
#   code: 'ERR_MODULE_NOT_FOUND',
#   url: 'file:///v/cap/node/area.mjs'
# }
# Node.js v24.22.2
# Subtest: cap/node/area.test.mjs
not ok 1 - cap/node/area.test.mjs
  ---
  duration_ms: 68.248338
  type: 'test'
  location: '/v/cap/node/area.test.mjs:1:1'
  failureType: 'testCodeFailure'
  exitCode: 1
  signal: ~
  error: 'test failed'
  code: 'ERR_TEST_FAILURE'
  ...
# Subtest: REQ-GEO-002 perimeter of a square
not ok 2 - REQ-GEO-002 perimeter of a square
  ---
  duration_ms: 1.751202
  type: 'test'
  location: '/v/cap/node/perim.test.mjs:4:1'
  failureType: 'testCodeFailure'
  error: '0 == 8'
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 8
  actual: 0
  operator: '=='
  stack: |-
    TestContext.<anonymous> (file:///v/cap/node/perim.test.mjs:4:58)
    Test.runInAsyncScope (node:async_hooks:227:14)
    Test.run (node:internal/test_runner/test:1402:25)
    Test.start (node:internal/test_runner/test:1262:17)
    startSubtestAfterBootstrap (node:internal/test_runner/harness:387:17)
  ...
# Subtest: REQ-GEO-003 perimeter of nothing
ok 3 - REQ-GEO-003 perimeter of nothing
  ---
  duration_ms: 0.265809
  type: 'test'
  ...
1..3
# tests 3
# suites 0
# pass 1
# fail 2
# cancelled 0
# skipped 0
# todo 0
# duration_ms 97.795254
`

const jestJunitNoLoad = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="jest tests" tests="2" failures="1" errors="0" time="0.677">
  <testsuite name="undefined" errors="0" failures="1" skipped="0" timestamp="2026-11-04T21:22:58" time="0.308" tests="2">
    <testcase classname=" REQ-GEO-002 perimeter of a square" name=" REQ-GEO-002 perimeter of a square" time="0.006">
      <failure>Error: expect(received).toBe(expected) // Object.is equality

Expected: 8
Received: 0
    at Object.toBe (/v/cap/jest/perim.test.js:2:68)
    at Promise.finally.completed (/v/node_modules/jest-circus/build/jestAdapterInit.js:1834:28)
    at new Promise (&lt;anonymous&gt;)
    at callAsyncCircusFn (/v/node_modules/jest-circus/build/jestAdapterInit.js:1774:10)
    at _callCircusTest (/v/node_modules/jest-circus/build/jestAdapterInit.js:1167:40)
    at processTicksAndRejections (node:internal/process/task_queues:104:5)
    at _runTestInContext (/v/node_modules/jest-circus/build/jestAdapterInit.js:1103:3)
    at runTestWithContext (/v/node_modules/jest-circus/build/jestAdapterInit.js:996:5)
    at _runTestsForDescribeBlockOnce (/v/node_modules/jest-circus/build/jestAdapterInit.js:1008:11)
    at _runTestsForDescribeBlock (/v/node_modules/jest-circus/build/jestAdapterInit.js:824:5)
    at run (/v/node_modules/jest-circus/build/jestAdapterInit.js:789:3)
    at runAndTransformResultsToJestFormat (/v/node_modules/jest-circus/build/jestAdapterInit.js:2300:21)
    at jestAdapter (/v/node_modules/jest-circus/build/runner.js:111:19)
    at runTestInternal (/v/node_modules/jest-runner/build/testWorker.js:247:16)
    at runTest (/v/node_modules/jest-runner/build/testWorker.js:315:7)
    at Object.worker (/v/node_modules/jest-runner/build/testWorker.js:479:12)</failure>
    </testcase>
    <testcase classname=" REQ-GEO-003 perimeter of nothing" name=" REQ-GEO-003 perimeter of nothing" time="0">
    </testcase>
  </testsuite>
</testsuites>`

const vitestNoLoad = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="3" failures="2" errors="0" time="0.009661289">
    <testsuite name="cap/vt/area.spec.mjs" timestamp="2026-11-04T21:22:59.503Z" hostname="vm" tests="1" failures="1" errors="0" skipped="0" time="0">
        <testcase classname="cap/vt/area.spec.mjs" name="cap/vt/area.spec.mjs" time="0">
            <failure message="Cannot find module &apos;./area.mjs&apos; imported from /v/cap/vt/area.spec.mjs" type="Error">
Error: Cannot find module &apos;./area.mjs&apos; imported from /v/cap/vt/area.spec.mjs
 ❯ cap/vt/area.spec.mjs:2:1

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯
Serialized Error: { code: &apos;ERR_MODULE_NOT_FOUND&apos; }
            </failure>
        </testcase>
    </testsuite>
    <testsuite name="cap/vt/perim.spec.mjs" timestamp="2026-11-04T21:22:59.510Z" hostname="vm" tests="2" failures="1" errors="0" skipped="0" time="0.009661289">
        <testcase classname="cap/vt/perim.spec.mjs" name="REQ-GEO-002 perimeter of a square" time="0.00771756">
            <failure message="expected +0 to be 8 // Object.is equality" type="AssertionError">
AssertionError: expected +0 to be 8 // Object.is equality

- Expected
+ Received

- 8
+ 0

 ❯ cap/vt/perim.spec.mjs:3:68
            </failure>
        </testcase>
        <testcase classname="cap/vt/perim.spec.mjs" name="REQ-GEO-003 perimeter of nothing" time="0.000466628">
        </testcase>
    </testsuite>
</testsuites>
`

func TestAFileThatDidNotLoadReportsNoTestOfItsOwn(t *testing.T) {
	for _, e := range []struct{ emitter, format, text string }{
		{"node 24.22.2 --test-reporter=junit", "junit", nodeJunitNoLoad},
		{"node 24.22.2 --test-reporter=tap", "tap", nodeTapNoLoad},
		{"jest 30.5.2 with jest-junit 17.0.0", "junit", jestJunitNoLoad},
		{"vitest 5.1.0 --reporter=junit", "junit", vitestNoLoad},
	} {
		r := read(t, e.format, e.text)
		if r.Error != "" {
			t.Errorf("%s: refused a valid report: %s", e.emitter, r.Error)
			continue
		}
		for _, c := range []struct{ id, want string }{{"REQ-GEO-001", Absent}, {"REQ-GEO-002", Fail}, {"REQ-GEO-003", Pass}} {
			if got := r.Verdict(c.id); got != c.want {
				t.Errorf("%s: %s read %s, want %s (ran %q, failed %q)", e.emitter, c.id, got, c.want, r.Names, r.Failed)
			}
		}
	}
}

// A test that did not run is absent however it was kept from running.
func TestASkipAndATodoAreAbsent(t *testing.T) {
	for _, e := range []struct{ emitter, format, text string }{
		{"vitest 4.1.10 --reporter=junit", "junit", vitest},
		{"mocha 11.8.0 --reporter xunit", "junit", mocha},
		{"node 24 --test-reporter=junit", "junit", nodeJunit},
		{"node 24 --test-reporter=tap", "tap", nodeTap},
	} {
		r := read(t, e.format, e.text)
		if got := r.Verdict("REQ-AUTH-001"); got != Pass {
			t.Errorf("%s: the test that ran read %s", e.emitter, got)
		}
		if got := r.Verdict("REQ-AUTH-002"); got != Absent {
			t.Errorf("%s: the skipped test read %s", e.emitter, got)
		}
	}
	// A todo whose body failed is not a failure: the suite exited 0.
	if got := read(t, "tap", nodeTapTodo).Verdict("REQ-A-003"); got != Absent {
		t.Errorf("a failing todo read %s", got)
	}
}

// What mocha leaves when a file does not load: nothing to read is not "absent".
func TestNoReportIsUnknown(t *testing.T) {
	if got := Read("junit", "nope.xml", t.TempDir()).Verdict("REQ-GEO-001"); got != Unknown {
		t.Fatalf("a report never written read %s", got)
	}
}

// The id is matched as spec-trace binds it, `_` spelling included.
func TestVerdictBindsAsSpecTrace(t *testing.T) {
	r := read(t, "junit", `<testsuites><testcase name="test_REQ_A_001_rejects"><error message="boom"/></testcase><testcase name="REQ-A-0020 fails"><failure/></testcase></testsuites>`)
	if got := r.Verdict("REQ-A-001"); got != Fail {
		t.Fatalf("an <error> on test_REQ_A_001 read %s: %+v", got, r)
	}
	if got := r.Verdict("REQ-A-002"); got != Absent {
		t.Fatalf("REQ-A-0020 was read as REQ-A-002: %s", got)
	}
}

// ---- the shapes a hand-written fixture would not have produced

func TestJunitShapes(t *testing.T) {
	for _, c := range []struct {
		name, xml   string
		ran, notRan []string
	}{
		{"a skipped case does not suppress the cases before it",
			"<testsuites>\n  <testcase name=\"REQ-A-001 first\"/>\n  <testcase name=\"REQ-A-002 second\"></testcase>\n  <testcase name=\"REQ-A-003 third\"><skipped/></testcase>\n</testsuites>",
			[]string{"REQ-A-001", "REQ-A-002"}, []string{"REQ-A-003"}},
		{"a failure message that quotes XML does not invent a test case",
			"<testsuites>\n  <testcase name=\"REQ-A-001 real\"><failure><![CDATA[expected <testcase name=\"REQ-A-999 fake\"/> here]]></failure></testcase>\n</testsuites>",
			[]string{"REQ-A-001"}, []string{"REQ-A-999"}},
		// Stripped kind by kind, CDATA first, the quoted opener would run through a real case.
		{"a CDATA opener quoted inside a comment does not swallow the cases after it",
			"<testsuites>\n  <!-- an emitter note quoting <![CDATA[ -->\n  <testcase name=\"REQ-A-001 real\"/>\n  <!-- and its close ]]> -->\n</testsuites>",
			[]string{"REQ-A-001"}, nil},
		// The dangerous direction: a comment read as markup proves with a test that did not run.
		{"a comment that never closes hides what follows it",
			"<testsuites>\n  <testcase name=\"REQ-A-001 real\"/>\n  <!-- disabled: <testcase name=\"REQ-A-002 commented out\"/>\n</testsuites>",
			[]string{"REQ-A-001"}, []string{"REQ-A-002"}},
		// Read as "never ran", a plain red test would be routed to the traceability check.
		{"a failing test counts as executed",
			`<testsuites><testcase name="REQ-A-001 red"><failure message="boom"/></testcase></testsuites>`,
			[]string{"REQ-A-001"}, nil},
	} {
		r := read(t, "junit", c.xml)
		if r.Error != "" {
			t.Errorf("%s: %s", c.name, r.Error)
			continue
		}
		for _, id := range c.ran {
			if !has(r, id) {
				t.Errorf("%s: %s was dropped: %q", c.name, id, r.Names)
			}
		}
		for _, id := range c.notRan {
			if has(r, id) {
				t.Errorf("%s: %s was reported as executed: %q", c.name, id, r.Names)
			}
		}
	}
}

func TestEntitiesInANameAreDecoded(t *testing.T) {
	r := read(t, "junit", `<testsuites><testcase name="REQ-A-001 a &amp; b &lt;c&gt; &quot;d&quot;"/></testsuites>`)
	if r.Error != "" || len(r.Names) == 0 || r.Names[0] != `REQ-A-001 a & b <c> "d"` {
		t.Fatalf("entities not decoded: %q %s", r.Names, r.Error)
	}
}

func TestTapFailingCountsSkipAndTodoDoNot(t *testing.T) {
	r := read(t, "tap", "TAP version 13\nnot ok 1 - REQ-A-001 failed but ran\nok 2 - REQ-A-002 skipped # SKIP later\nok 3 - REQ-A-003 todo # TODO known gap\n    ok 4 - REQ-A-004 nested subtest\n1..4")
	switch {
	case r.Error != "":
		t.Fatal(r.Error)
	case !has(r, "REQ-A-001"):
		t.Fatalf("a failing TAP line read as not-run: %s", names(r))
	case has(r, "REQ-A-002"):
		t.Fatalf("a # SKIP line was reported as executed: %s", names(r))
	case has(r, "REQ-A-003"):
		t.Fatalf("a # TODO line was reported as executed: %s", names(r))
	case !has(r, "REQ-A-004"):
		t.Fatalf("an indented subtest was dropped: %s", names(r))
	}
}

// Emitters escape a `#` inside a name as `\#`: only an unescaped `#` opens a directive.
func TestTapEscapedHashIsPartOfTheName(t *testing.T) {
	r := read(t, "tap", "TAP version 13\nok 1 - REQ-A-001 prints a \\# SKIP line verbatim\n1..1")
	if r.Error != "" || !has(r, "REQ-A-001") {
		t.Fatalf("the name was read as a SKIP directive: %+v", r)
	}
}

// ---- refusals must be distinguishable from an empty run

func TestMissingReportIsAnError(t *testing.T) {
	r := Read("junit", "nope.xml", t.TempDir())
	if r.Error == "" {
		t.Fatal(`a report never written reported zero tests, which reads as "every requirement is unproven"`)
	}
	if !regexp.MustCompile(`verify\.test|reporter flag`).MatchString(r.Error) {
		t.Fatalf("the error does not point at the likely cause: %s", r.Error)
	}
}

func TestUnknownFormatIsRefused(t *testing.T) {
	if r := read(t, "xunit-ish", "<testsuites/>"); r.Error == "" {
		t.Fatal("an unsupported format was accepted")
	}
}

// `skipped` tells "the suite never ran" (a missing reporter flag) from "it ran
// and everything was disabled" (a finding about the repo).
func TestAllSkippedIsNotEmpty(t *testing.T) {
	all := read(t, "junit", `<testsuites><testcase name="REQ-A-001 x"><skipped/></testcase></testsuites>`)
	if all.Error != "" || len(all.Names) != 0 || all.Skipped != 1 {
		t.Fatalf("all skipped: %+v", all)
	}
	if nothing := read(t, "junit", "<testsuites></testsuites>"); nothing.Skipped != 0 {
		t.Fatalf("an empty report claimed skips: %+v", nothing)
	}
	if tap := read(t, "tap", "TAP version 13\nok 1 - REQ-A-001 x # SKIP nope\n1..1"); tap.Skipped != 1 {
		t.Fatalf("TAP skips are not counted: %+v", tap)
	}
}

func TestEmptyReportIsNotAnError(t *testing.T) {
	r := read(t, "junit", "<testsuites></testsuites>")
	if r.Error != "" || len(r.Names) != 0 {
		t.Fatalf("an empty well-formed report: %+v", r)
	}
}
