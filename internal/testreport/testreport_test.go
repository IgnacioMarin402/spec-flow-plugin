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
