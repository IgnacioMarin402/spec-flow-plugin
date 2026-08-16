#!/usr/bin/env node
// Readers for the test-report FORMATS a runner can already emit, turning one
// into the line-per-executed-test shape `spec-trace` consumes.
//
// This is the half of ADR-002 that record got wrong, and ADR-005 supersedes it:
// it refused a runner list, correctly, and concluded that the adopter must
// therefore write code. A report FORMAT is not a runner. `<skipped/>` is in the
// JUnit schema and `# SKIP` is a TAP directive — both answer "did this test
// run?" without anything here knowing what produced the file. That is a data
// shape, which ADR-001 permits, and it is why no runner is named below.
//
// What a reader must never do is guess. Every failure here returns a reason
// instead of an empty list: "no tests reported" and "the file was not where the
// contract said" are the same value to a caller that only gets an array, and
// the first one is a legitimate red while the second is a broken contract. See
// spec-trace.mjs, which refuses on either rather than reporting requirements
// unproven.
//
// A FAILED test counts as executed. The question this answers is whether a test
// bearing the requirement's id ran at all; whether it passed is `verify.test`'s
// exit code, which the gate judges separately and which blocks on its own.
import { readFileSync, existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export const FORMATS = ['junit', 'tap'];

/**
 * XML entities in an attribute value. Only the five predefined ones plus
 * numeric escapes — a report is machine-written, so a custom DTD is not a case
 * this has to survive, and pretending otherwise would be a parser nobody
 * verified against a real emitter.
 */
function decodeEntities(text) {
  return text
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * CDATA sections and comments hold arbitrary text — a failure message that
 * quotes XML, a stack trace, a diff of a fixture. Both are removed before
 * anything below looks for a tag, because a `<testcase` inside a failure
 * message is not a test case and would otherwise be counted as one.
 */
function stripOpaque(xml) {
  return xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '').replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * JUnit XML. Verified against three real emitters, which disagree about
 * everything except the two things this reads:
 *
 *   - a passing case may be self-closing (`<testcase ... />`) or paired with a
 *     `</testcase>`, with or without whitespace between them;
 *   - the root element may be `<testsuites>` or a bare `<testsuite>`, and the
 *     `<?xml?>` declaration may be absent.
 *
 * Neither variation is read at all: the scan is for `<testcase>` elements
 * anywhere in the document, and a case counts as executed unless it contains a
 * `<skipped>` child. Nesting depth, suite names and attribute order are
 * therefore free to differ, which is what makes this a format reader rather
 * than a reader for the three files it was tested on.
 */
function readJunit(xml) {
  const names = [];
  let skipped = 0;
  const doc = stripOpaque(xml);
  const open = /<testcase\b([^>]*?)(\/)?>/g;

  let match;
  while ((match = open.exec(doc)) !== null) {
    const attrs = match[1];
    const selfClosing = match[2] === '/';

    // Only the paired form can carry a `<skipped>` child, and the body is
    // bounded by the NEXT `</testcase>` rather than searched to the end of the
    // document — otherwise one skipped case late in the file would suppress
    // every case before it.
    let wasSkipped = false;
    if (!selfClosing) {
      const close = doc.indexOf('</testcase>', open.lastIndex);
      const body = close === -1 ? doc.slice(open.lastIndex) : doc.slice(open.lastIndex, close);
      wasSkipped = /<skipped\b/.test(body);
    }
    if (wasSkipped) {
      skipped += 1;
      continue;
    }

    const name = /\bname\s*=\s*"([^"]*)"/.exec(attrs) ?? /\bname\s*=\s*'([^']*)'/.exec(attrs);
    if (name) names.push(decodeEntities(name[1]));
  }

  return { names, skipped };
}

/**
 * TAP 13. `# SKIP` is a directive in the specification, which is what makes
 * this readable without knowing the producer — and it is also why the check
 * cannot be "does the line start with `not ok`": a skipped test is reported as
 * `ok` with the directive appended, so a reader that only looked at the status
 * word would count every skip as a pass.
 *
 * Leading whitespace is significant to TAP's subtest nesting and irrelevant
 * here: a nested `ok` is still a test that ran.
 *
 * `# TODO` is deliberately NOT excluded. A todo test executed; the directive
 * says its failure is tolerated, which is a statement about the result, not
 * about whether it ran.
 */
function readTap(text) {
  const names = [];
  let skipped = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const match = /^(not\s+)?ok\b\s*(\d+)?\s*(?:-\s*)?(.*)$/.exec(line);
    if (!match) continue;

    const rest = match[3] ?? '';
    // The directive is separated from the description by an unescaped `#`.
    const directive = /#\s*(SKIP|TODO)\b/i.exec(rest);
    if (directive && directive[1].toUpperCase() === 'SKIP') {
      skipped += 1;
      continue;
    }

    const name = (directive ? rest.slice(0, directive.index) : rest).trim();
    if (name) names.push(name);
  }
  return { names, skipped };
}

/**
 * Reads `trace.report` and returns `{ names, skipped }` or `{ error }`.
 *
 * Never a bare array, and `skipped` is not decoration: it separates the two
 * ways a report can name no executed test, which a command-based source cannot
 * tell apart at all. A file with zero test cases in it means the suite never
 * ran — the reporter flag is missing, or the path is stale. A file with cases
 * in it that were ALL skipped means the suite ran and proved nothing, which is
 * a finding about the repo rather than about the contract. Collapsing those
 * sends someone to fix a flag when the real answer is that every test naming
 * the requirement is disabled.
 */
export function readReport(report, root) {
  const { format, path } = report ?? {};
  if (!FORMATS.includes(format)) {
    return { error: `trace.report.format must be one of ${FORMATS.join(', ')} — got ${JSON.stringify(format)}` };
  }

  const file = isAbsolute(path) ? path : join(root, path);
  if (!existsSync(file)) {
    return {
      error:
        `trace.report.path points at ${path}, which does not exist after the suite ran. ` +
        `The report is written BY your test command, so this usually means the reporter flag is missing from verify.test rather than that the tests failed.`,
    };
  }

  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    return { error: `trace.report.path (${path}) could not be read: ${err.message}` };
  }

  return format === 'junit' ? readJunit(text) : readTap(text);
}
