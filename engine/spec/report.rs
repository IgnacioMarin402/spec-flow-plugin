//! Reads the report FORMATS a runner already emits into the
//! line-per-executed-test shape spec-trace consumes. A format is not a
//! runner: `<skipped/>` is in the JUnit schema and `# SKIP` is a TAP
//! directive, so no runner is named here (ADR-005).
//!
//! A reader never guesses: every failure is a reason, not an empty list, since
//! "no tests reported" and "the file was not there" are a red and a broken
//! contract. A FAILED test counts as executed; whether the suite passed is its
//! exit code, and `failed` names the tests that did not. A TODO never counts:
//! it is the marking that hides a failure from that exit code.

use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;

use crate::jsre::Re;
use crate::repo::contract::REPORT_FORMATS;
use crate::spec::shape;

/// What a report says: the names of the tests that ran, which of those
/// failed, and how many it skipped — or why it says nothing.
#[derive(Debug, Default)]
pub struct Report {
    pub names: Vec<String>,
    pub failed: Vec<String>,
    pub skipped: usize,
    pub error: String,
}

/// What a report says of one requirement's test.
#[derive(Debug, PartialEq)]
pub enum Verdict {
    Pass,
    Fail,
    /// Skipped, never written, or in a file that did not load.
    Absent,
    /// The report could not be read.
    Unknown,
}

impl Report {
    fn refused(error: String) -> Report {
        Report {
            error,
            ..Report::default()
        }
    }

    /// What the report says of the tests whose names carry `id`, matched as
    /// spec-trace binds them. A file that did not load reports no test of its
    /// own — node and vitest name one failed case after the file, jest-junit
    /// reports nothing — so it never reads as a test that failed.
    #[allow(dead_code)] // its own tests read it; no hook does yet
    pub fn verdict(&self, id: &str) -> Verdict {
        if !self.error.is_empty() {
            return Verdict::Unknown;
        }
        let mut verdict = Verdict::Absent;
        for name in &self.names {
            if !shape::ids_in(name).iter().any(|i| i == id) {
                continue;
            }
            if self.failed.contains(name) {
                return Verdict::Fail;
            }
            verdict = Verdict::Pass;
        }
        verdict
    }
}

static DEC_ENTITY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"&#([0-9]+);").unwrap());
static HEX_ENTITY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"&#x([0-9a-fA-F]+);").unwrap());

/// A code point as Go's `string(rune(n))` writes it: U+FFFD where none is.
fn char_of(n: Option<u32>) -> Option<char> {
    Some(n.and_then(char::from_u32).unwrap_or('\u{FFFD}'))
}

/// Only the predefined entities and numeric escapes: a report is
/// machine-written.
fn decode_entities(text: &str) -> String {
    let text = DEC_ENTITY.replace_all(text, |c: &regex::Captures| match c[1].parse::<i64>() {
        Ok(n) => char_of(u32::try_from(n).ok()).unwrap().to_string(),
        Err(_) => c[0].to_string(),
    });
    let text = HEX_ENTITY.replace_all(&text, |c: &regex::Captures| {
        match i32::from_str_radix(&c[1], 16) {
            Ok(n) => char_of(u32::try_from(n).ok()).unwrap().to_string(),
            Err(_) => c[0].to_string(),
        }
    });
    let mut text = text.into_owned();
    // `&amp;` last, or `&amp;lt;` would decode twice.
    for (e, c) in [
        ("&quot;", "\""),
        ("&apos;", "'"),
        ("&lt;", "<"),
        ("&gt;", ">"),
        ("&amp;", "&"),
    ] {
        text = text.replace(e, c);
    }
    text
}

fn index_from(s: &str, sub: &str, from: usize) -> Option<usize> {
    s.get(from..)?.find(sub).map(|i| i + from)
}

/// CDATA sections and comments removed in one left-to-right pass: each can
/// quote the other's opener, and a `<testcase` quoted in a failure message is
/// not a test case. One never closed runs to the end, as for an XML parser —
/// read as markup, a commented-out case would count as executed.
fn strip_opaque(xml: &str) -> String {
    let mut out = String::with_capacity(xml.len());
    let mut at = 0;
    loop {
        let comment = index_from(xml, "<!--", at);
        let cdata = index_from(xml, "<![CDATA[", at);
        let (start, end) = match (comment, cdata) {
            (None, None) => {
                out.push_str(&xml[at..]);
                return out;
            }
            (Some(c), d) if d.is_none_or(|d| c < d) => (c, index_from(xml, "-->", c + 4)),
            (_, Some(d)) => (d, index_from(xml, "]]>", d + 9)),
            _ => unreachable!(),
        };
        out.push_str(&xml[at..start]);
        let Some(end) = end else { return out };
        at = end + 3;
    }
}

static TESTCASE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"<testcase(?-u:\b)([^>]*?)(/)?>").unwrap());
static SKIPPED_EL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<skipped(?-u:\b)").unwrap());
static FAILED_EL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"<(failure|error)(?-u:\b)").unwrap());
static NAME_DQ: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?-u:\b)name[\t\n\x0C\r ]*=[\t\n\x0C\r ]*"([^"]*)""#).unwrap());
static NAME_SQ: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?-u:\b)name[\t\n\x0C\r ]*=[\t\n\x0C\r ]*'([^']*)'").unwrap());

/// JUnit: every `<testcase>` anywhere, executed unless it holds `<skipped>`,
/// failed when it holds `<failure>` or `<error>`. Root element, nesting and
/// attribute order are free to differ.
fn read_junit(xml: &str) -> Report {
    let mut r = Report::default();
    let doc = strip_opaque(xml);
    for m in TESTCASE.captures_iter(&doc) {
        let attrs = m.get(1).map_or("", |a| a.as_str());
        let mut failed = false;
        // The body is bounded by the NEXT `</testcase>`, or one skipped case
        // late in the file would suppress every case before it.
        if m.get(2).is_none() {
            let body = &doc[m.get(0).unwrap().end()..];
            let body = body.find("</testcase>").map_or(body, |c| &body[..c]);
            if SKIPPED_EL.is_match(body) {
                r.skipped += 1;
                continue;
            }
            failed = FAILED_EL.is_match(body);
        }
        if let Some(name) = NAME_DQ.captures(attrs).or_else(|| NAME_SQ.captures(attrs)) {
            let name = decode_entities(&name[1]);
            if failed {
                r.failed.push(name.clone());
            }
            r.names.push(name);
        }
    }
    r
}

static TAP_LINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(not[\t\n\x0C\r ]+)?ok(?-u:\b)[\t\n\x0C\r ]*([0-9]+)?[\t\n\x0C\r ]*(?:-[\t\n\x0C\r ]*)?(.*)$")
        .unwrap()
});
/// After an UNESCAPED `#`: emitters write a `#` in a test's name as `\#`.
static TAP_DIRECTIVE: LazyLock<Re> = LazyLock::new(|| Re::new(r"(?<!\\)#\s*(SKIP|TODO)\b", "i"));

/// TAP 13: `# SKIP` and `# TODO` follow an `ok`, so the status word alone
/// would count every skip as a pass. A TODO is not proof: its failure leaves
/// the exit code at 0, and `it.todo` reports `ok` without running anything.
fn read_tap(text: &str) -> Report {
    let mut r = Report::default();
    for raw in text.split('\n') {
        let Some(m) = TAP_LINE.captures(raw.trim()) else {
            continue;
        };
        let rest = m.get(3).map_or("", |g| g.as_str());
        if TAP_DIRECTIVE.test(rest) {
            r.skipped += 1;
            continue;
        }
        let name = rest.trim();
        if !name.is_empty() {
            if m.get(1).is_some() {
                r.failed.push(name.into());
            }
            r.names.push(name.into());
        }
    }
    r
}

fn format_error(format: &str) -> String {
    if REPORT_FORMATS.contains(&format) {
        return String::new();
    }
    let f = if format.is_empty() {
        "undefined".into()
    } else {
        serde_json::to_string(format).unwrap_or_default()
    };
    format!(
        "trace.report.format must be one of {} — got {f}",
        REPORT_FORMATS.join(", ")
    )
}

/// `text` already in hand read as a report in `format`: what a runner
/// printed in that format, where `read` reads the file it wrote.
pub fn parse(format: &str, text: &str) -> Report {
    let e = format_error(format);
    if !e.is_empty() {
        return Report::refused(e);
    }
    if format == "junit" {
        read_junit(text)
    } else {
        read_tap(text)
    }
}

/// `trace.report`, read. `skipped` separates the two ways a report names no
/// executed test: zero cases means the suite never ran; cases all skipped
/// means it ran and proved nothing.
pub fn read(format: &str, path: &str, root: &Path) -> Report {
    let e = format_error(format);
    if !e.is_empty() {
        return Report::refused(e);
    }
    let file = root.join(path);
    if !file.exists() {
        return Report::refused(format!(
            "trace.report.path points at {path}, which does not exist after the suite ran. \
             The report is written BY your test command, so this usually means nothing in it writes the report — the reporter flag is missing from verify.test, or the reporter was removed from the runner's own config — rather than that the tests failed. \
             A report left over from an earlier run is removed before each suite, so it cannot stand in for this one."
        ));
    }
    match std::fs::read(&file) {
        Ok(b) => parse(format, &String::from_utf8_lossy(&b)),
        Err(e) => Report::refused(format!("trace.report.path ({path}) could not be read: {e}")),
    }
}

#[cfg(test)]
mod tests {
    //! Every JUnit and TAP capture below is a byte-for-byte copy of a real
    //! emitter's output, named with the version that produced it, copied by
    //! script: a parser checked against XML written by hand is checked against
    //! its author's assumptions.

    use super::*;

    fn read_text(format: &str, text: &str) -> Report {
        let dir = std::env::temp_dir().join(format!(
            "spec-flow-report-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("report"), text).unwrap();
        let r = read(format, "report", &dir);
        let _ = std::fs::remove_dir_all(&dir);
        r
    }

    static COUNTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

    fn has(r: &Report, id: &str) -> bool {
        r.names.join("|").contains(id)
    }

    const VITEST: &str = r###"<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="2" failures="0" errors="0" time="0.002392605">
    <testsuite name="v/a.test.js" timestamp="2026-08-16T14:35:52.636Z" hostname="vm" tests="2" failures="0" errors="0" skipped="1" time="0.002392605">
        <testcase classname="v/a.test.js" name="REQ-AUTH-001 rejects a bad password" time="0.001053755">
        </testcase>
        <testcase classname="v/a.test.js" name="REQ-AUTH-002 locks after five attempts" time="0">
            <skipped/>
        </testcase>
    </testsuite>
</testsuites>
"###;

    const MOCHA: &str = r###"<testsuite name="Mocha Tests" tests="2" failures="0" errors="0" skipped="1" timestamp="Sun, 16 Aug 2026 14:35:52 GMT" time="0.001">
<testcase classname="" name="REQ-AUTH-001 rejects a bad password" file="/tmp/m/a.test.cjs" time="0"/>
<testcase classname="" name="REQ-AUTH-002 locks after five attempts" file="/tmp/m/a.test.cjs" time="0"><skipped/></testcase>
</testsuite>
"###;

    const NODE_TAP: &str = r###"TAP version 13
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
"###;

    const NODE_TAP_TODO: &str = r###"TAP version 13
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
"###;

    const NODE_JUNIT_NO_LOAD: &str = r###"<?xml version="1.0" encoding="utf-8"?>
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
"###;

    const NODE_TAP_NO_LOAD: &str = r###"TAP version 13
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
"###;

    const JEST_JUNIT_NO_LOAD: &str = r###"<?xml version="1.0" encoding="UTF-8"?>
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
</testsuites>"###;

    const VITEST_NO_LOAD: &str = r###"<?xml version="1.0" encoding="UTF-8" ?>
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
"###;

    const NODE_JUNIT: &str = concat!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<testsuites>\n",
        "\t<testcase name=\"REQ-AUTH-001 rejects a bad password\" time=\"0.000925\" classname=\"test\" file=\"/v/test/a.test.js\"/>\n",
        "\t<testcase name=\"REQ-AUTH-002 locks after five attempts\" time=\"0.000189\" classname=\"test\" file=\"/v/test/a.test.js\">\n",
        "\t\t<skipped type=\"skipped\" message=\"not implemented yet\"/>\n\t</testcase>\n",
        "\t<!-- tests 2 -->\n\t<!-- suites 0 -->\n\t<!-- pass 1 -->\n\t<!-- fail 0 -->\n\t<!-- cancelled 0 -->\n",
        "\t<!-- skipped 1 -->\n\t<!-- todo 0 -->\n\t<!-- duration_ms 92.107736 -->\n</testsuites>\n"
    );

    const EMITTERS: [(&str, &str, &str); 4] = [
        ("vitest 4.1.10 --reporter=junit", "junit", VITEST),
        ("mocha 11.8.0 --reporter xunit", "junit", MOCHA),
        ("node 24 --test-reporter=junit", "junit", NODE_JUNIT),
        ("node 24 --test-reporter=tap", "tap", NODE_TAP),
    ];

    #[test]
    fn emitters() {
        for (emitter, format, text) in EMITTERS {
            let r = read_text(format, text);
            assert_eq!(r.error, "", "{emitter}: refused a valid report");
            assert!(
                has(&r, "REQ-AUTH-001"),
                "{emitter}: the test that RAN is missing: {:?}",
                r.names
            );
            // A skipped test reaching spec-trace proves a requirement with a test that never ran.
            assert!(
                !has(&r, "REQ-AUTH-002"),
                "{emitter}: a skipped test was reported as executed: {:?}",
                r.names
            );
        }
    }

    /// The same runner's JUnit reporter marks both todos `<skipped type="todo">`.
    #[test]
    fn node_tap_todo_is_not_proof() {
        let r = read_text("tap", NODE_TAP_TODO);
        assert_eq!(r.error, "");
        assert!(
            !has(&r, "REQ-A-002"),
            "a bodiless it.todo was reported as executed"
        );
        assert!(
            !has(&r, "REQ-A-003"),
            "a todo whose body FAILED was reported as executed"
        );
        assert!(has(&r, "REQ-A-001"), "the test that ran was dropped");
        assert!(
            has(&r, "REQ-A-004"),
            r"an escaped \# in a name was read as a directive"
        );
        assert_eq!(r.skipped, 3, "the skip and both todos count as not-run");
    }

    #[test]
    fn a_file_that_did_not_load_reports_no_test_of_its_own() {
        for (emitter, format, text) in [
            (
                "node 24.22.2 --test-reporter=junit",
                "junit",
                NODE_JUNIT_NO_LOAD,
            ),
            ("node 24.22.2 --test-reporter=tap", "tap", NODE_TAP_NO_LOAD),
            (
                "jest 30.5.2 with jest-junit 17.0.0",
                "junit",
                JEST_JUNIT_NO_LOAD,
            ),
            ("vitest 5.1.0 --reporter=junit", "junit", VITEST_NO_LOAD),
        ] {
            let r = read_text(format, text);
            assert_eq!(r.error, "", "{emitter}");
            for (id, want) in [
                ("REQ-GEO-001", Verdict::Absent),
                ("REQ-GEO-002", Verdict::Fail),
                ("REQ-GEO-003", Verdict::Pass),
            ] {
                assert_eq!(
                    r.verdict(id),
                    want,
                    "{emitter}: {id} (ran {:?}, failed {:?})",
                    r.names,
                    r.failed
                );
            }
        }
    }

    /// A test that did not run is absent however it was kept from running.
    #[test]
    fn a_skip_and_a_todo_are_absent() {
        for (emitter, format, text) in EMITTERS {
            let r = read_text(format, text);
            assert_eq!(r.verdict("REQ-AUTH-001"), Verdict::Pass, "{emitter}");
            assert_eq!(r.verdict("REQ-AUTH-002"), Verdict::Absent, "{emitter}");
        }
        // A todo whose body failed is not a failure: the suite exited 0.
        assert_eq!(
            read_text("tap", NODE_TAP_TODO).verdict("REQ-A-003"),
            Verdict::Absent
        );
    }

    /// What mocha leaves when a file does not load: nothing to read is not
    /// "absent".
    #[test]
    fn no_report_is_unknown() {
        let r = read(
            "junit",
            "nope.xml",
            &std::env::temp_dir().join("spec-flow-no-such-dir"),
        );
        assert_eq!(r.verdict("REQ-GEO-001"), Verdict::Unknown);
        // Refusals must be distinguishable from an empty run.
        assert!(
            r.error.contains("verify.test") || r.error.contains("reporter flag"),
            "{}",
            r.error
        );
    }

    /// The id is matched as spec-trace binds it, `_` spelling included.
    #[test]
    fn verdict_binds_as_spec_trace() {
        let r = read_text(
            "junit",
            r#"<testsuites><testcase name="test_REQ_A_001_rejects"><error message="boom"/></testcase><testcase name="REQ-A-0020 fails"><failure/></testcase></testsuites>"#,
        );
        assert_eq!(r.verdict("REQ-A-001"), Verdict::Fail);
        assert_eq!(
            r.verdict("REQ-A-002"),
            Verdict::Absent,
            "REQ-A-0020 was read as REQ-A-002"
        );
    }

    #[test]
    fn junit_shapes() {
        for (name, xml, ran, not_ran) in [
            (
                "a skipped case does not suppress the cases before it",
                "<testsuites>\n  <testcase name=\"REQ-A-001 first\"/>\n  <testcase name=\"REQ-A-002 second\"></testcase>\n  <testcase name=\"REQ-A-003 third\"><skipped/></testcase>\n</testsuites>",
                &["REQ-A-001", "REQ-A-002"][..],
                &["REQ-A-003"][..],
            ),
            (
                "a failure message that quotes XML does not invent a test case",
                "<testsuites>\n  <testcase name=\"REQ-A-001 real\"><failure><![CDATA[expected <testcase name=\"REQ-A-999 fake\"/> here]]></failure></testcase>\n</testsuites>",
                &["REQ-A-001"][..],
                &["REQ-A-999"][..],
            ),
            (
                "a CDATA opener quoted inside a comment does not swallow the cases after it",
                "<testsuites>\n  <!-- an emitter note quoting <![CDATA[ -->\n  <testcase name=\"REQ-A-001 real\"/>\n  <!-- and its close ]]> -->\n</testsuites>",
                &["REQ-A-001"][..],
                &[][..],
            ),
            (
                "a comment that never closes hides what follows it",
                "<testsuites>\n  <testcase name=\"REQ-A-001 real\"/>\n  <!-- disabled: <testcase name=\"REQ-A-002 commented out\"/>\n</testsuites>",
                &["REQ-A-001"][..],
                &["REQ-A-002"][..],
            ),
            (
                "a failing test counts as executed",
                r#"<testsuites><testcase name="REQ-A-001 red"><failure message="boom"/></testcase></testsuites>"#,
                &["REQ-A-001"][..],
                &[][..],
            ),
        ] {
            let r = read_text("junit", xml);
            assert_eq!(r.error, "", "{name}");
            for id in ran {
                assert!(has(&r, id), "{name}: {id} was dropped: {:?}", r.names);
            }
            for id in not_ran {
                assert!(
                    !has(&r, id),
                    "{name}: {id} was reported as executed: {:?}",
                    r.names
                );
            }
        }
    }

    #[test]
    fn entities_in_a_name_are_decoded() {
        let r = read_text(
            "junit",
            r#"<testsuites><testcase name="REQ-A-001 a &amp; b &lt;c&gt; &quot;d&quot; &#233;&#xe9;"/></testsuites>"#,
        );
        assert_eq!(r.names, [r#"REQ-A-001 a & b <c> "d" éé"#]);
    }

    #[test]
    fn tap_failing_counts_skip_and_todo_do_not() {
        let r = read_text(
            "tap",
            "TAP version 13\nnot ok 1 - REQ-A-001 failed but ran\nok 2 - REQ-A-002 skipped # SKIP later\nok 3 - REQ-A-003 todo # TODO known gap\n    ok 4 - REQ-A-004 nested subtest\n1..4",
        );
        assert_eq!(r.error, "");
        assert!(has(&r, "REQ-A-001"), "a failing TAP line read as not-run");
        assert!(
            !has(&r, "REQ-A-002"),
            "a # SKIP line was reported as executed"
        );
        assert!(
            !has(&r, "REQ-A-003"),
            "a # TODO line was reported as executed"
        );
        assert!(has(&r, "REQ-A-004"), "an indented subtest was dropped");
    }

    /// Emitters escape a `#` inside a name as `\#`: only an unescaped `#`
    /// opens a directive.
    #[test]
    fn tap_escaped_hash_is_part_of_the_name() {
        let r = read_text(
            "tap",
            "TAP version 13\nok 1 - REQ-A-001 prints a \\# SKIP line verbatim\n1..1",
        );
        assert!(r.error.is_empty() && has(&r, "REQ-A-001"), "{r:?}");
    }

    #[test]
    fn unknown_format_is_refused() {
        assert!(!read_text("xunit-ish", "<testsuites/>").error.is_empty());
    }

    /// `skipped` tells "the suite never ran" (a missing reporter flag) from
    /// "it ran and everything was disabled" (a finding about the repo).
    #[test]
    fn all_skipped_is_not_empty() {
        let all = read_text(
            "junit",
            r#"<testsuites><testcase name="REQ-A-001 x"><skipped/></testcase></testsuites>"#,
        );
        assert!(
            all.error.is_empty() && all.names.is_empty() && all.skipped == 1,
            "{all:?}"
        );
        assert_eq!(read_text("junit", "<testsuites></testsuites>").skipped, 0);
        assert_eq!(
            read_text(
                "tap",
                "TAP version 13\nok 1 - REQ-A-001 x # SKIP nope\n1..1"
            )
            .skipped,
            1
        );
    }

    #[test]
    fn empty_report_is_not_an_error() {
        let r = read_text("junit", "<testsuites></testsuites>");
        assert!(r.error.is_empty() && r.names.is_empty(), "{r:?}");
    }
}
