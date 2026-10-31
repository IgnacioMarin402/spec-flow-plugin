// Package testreport reads the report FORMATS a runner already emits into the
// line-per-executed-test shape spec-trace consumes. A format is not a runner:
// `<skipped/>` is in the JUnit schema and `# SKIP` is a TAP directive, so no
// runner is named here (ADR-005).
//
// A reader never guesses: every failure is a reason, not an empty list, since
// "no tests reported" and "the file was not there" are a red and a broken
// contract. A FAILED test counts as executed; whether it passed is the suite's
// exit code. A TODO never counts: it is the marking that hides a failure from
// that exit code.
package testreport

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/IgnacioMarin402/spec-flow-plugin/internal/jsre"
)

// Formats the engine reads.
var Formats = []string{"junit", "tap"}

// Report is what a report says: the names of the tests that ran and how many
// it skipped — or why it says nothing.
type Report struct {
	Names   []string
	Skipped int
	Error   string
}

var (
	decEntity = regexp.MustCompile(`&#(\d+);`)
	hexEntity = regexp.MustCompile(`&#x([0-9a-fA-F]+);`)
)

// Only the predefined entities and numeric escapes: a report is machine-written.
func decodeEntities(text string) string {
	text = decEntity.ReplaceAllStringFunc(text, func(s string) string {
		n, err := strconv.Atoi(decEntity.FindStringSubmatch(s)[1])
		if err != nil {
			return s
		}
		return string(rune(n))
	})
	text = hexEntity.ReplaceAllStringFunc(text, func(s string) string {
		n, err := strconv.ParseInt(hexEntity.FindStringSubmatch(s)[1], 16, 32)
		if err != nil {
			return s
		}
		return string(rune(n))
	})
	for _, e := range [][2]string{{"&quot;", `"`}, {"&apos;", "'"}, {"&lt;", "<"}, {"&gt;", ">"}, {"&amp;", "&"}} {
		text = strings.ReplaceAll(text, e[0], e[1]) // &amp; last, or `&amp;lt;` would decode twice
	}
	return text
}

// stripOpaque removes CDATA sections and comments in one left-to-right pass:
// each can quote the other's opener, and a `<testcase` quoted in a failure
// message is not a test case. One never closed runs to the end, as for an XML
// parser — read as markup, a commented-out case would count as executed.
func stripOpaque(xml string) string {
	var out strings.Builder
	at := 0
	for {
		comment := indexFrom(xml, "<!--", at)
		cdata := indexFrom(xml, "<![CDATA[", at)
		if comment == -1 && cdata == -1 {
			out.WriteString(xml[at:])
			return out.String()
		}
		isComment := comment != -1 && (cdata == -1 || comment < cdata)
		start, end := cdata, indexFrom(xml, "]]>", cdata+9)
		if isComment {
			start, end = comment, indexFrom(xml, "-->", comment+4)
		}
		out.WriteString(xml[at:start])
		if end == -1 {
			return out.String()
		}
		at = end + 3
	}
}

func indexFrom(s, sub string, from int) int {
	if from > len(s) {
		return -1
	}
	if i := strings.Index(s[from:], sub); i >= 0 {
		return i + from
	}
	return -1
}

var (
	testcase  = regexp.MustCompile(`<testcase\b([^>]*?)(/)?>`)
	skippedEl = regexp.MustCompile(`<skipped\b`)
	nameDq    = regexp.MustCompile(`\bname\s*=\s*"([^"]*)"`)
	nameSq    = regexp.MustCompile(`\bname\s*=\s*'([^']*)'`)
)

// JUnit: every `<testcase>` anywhere, executed unless it holds `<skipped>`.
// Root element, nesting and attribute order are free to differ.
func readJunit(xml string) Report {
	r := Report{Names: []string{}}
	doc := stripOpaque(xml)
	for _, m := range testcase.FindAllStringSubmatchIndex(doc, -1) {
		attrs := doc[m[2]:m[3]]
		selfClosing := m[4] >= 0
		// The body is bounded by the NEXT `</testcase>`, or one skipped case
		// late in the file would suppress every case before it.
		if !selfClosing {
			body := doc[m[1]:]
			if close := strings.Index(body, "</testcase>"); close != -1 {
				body = body[:close]
			}
			if skippedEl.MatchString(body) {
				r.Skipped++
				continue
			}
		}
		name := nameDq.FindStringSubmatch(attrs)
		if name == nil {
			name = nameSq.FindStringSubmatch(attrs)
		}
		if name != nil {
			r.Names = append(r.Names, decodeEntities(name[1]))
		}
	}
	return r
}

var (
	tapLine = regexp.MustCompile(`^(not\s+)?ok\b\s*(\d+)?\s*(?:-\s*)?(.*)$`)
	// After an UNESCAPED `#`: emitters write a `#` in a test's name as `\#`.
	tapDirective = jsre.MustCompile(`(?<!\\)#\s*(SKIP|TODO)\b`, "i")
)

// TAP 13: `# SKIP` and `# TODO` follow an `ok`, so the status word alone would
// count every skip as a pass. A TODO is not proof: its failure leaves the exit
// code at 0, and `it.todo` reports `ok` without running anything.
func readTap(text string) Report {
	r := Report{Names: []string{}}
	for _, raw := range strings.Split(text, "\n") {
		m := tapLine.FindStringSubmatch(strings.TrimSpace(raw))
		if m == nil {
			continue
		}
		rest := m[3]
		if tapDirective.Test(rest) {
			r.Skipped++
			continue
		}
		if name := strings.TrimSpace(rest); name != "" {
			r.Names = append(r.Names, name)
		}
	}
	return r
}

// Read reads `trace.report`. `skipped` separates the two ways a report names
// no executed test: zero cases means the suite never ran; cases all skipped
// means it ran and proved nothing.
func Read(format, path, root string) Report {
	if !contains(Formats, format) {
		f, _ := json.Marshal(format)
		if format == "" {
			f = []byte("undefined")
		}
		return Report{Error: "trace.report.format must be one of " + strings.Join(Formats, ", ") + " — got " + string(f)}
	}
	file := path
	if !filepath.IsAbs(path) {
		file = filepath.Join(root, path)
	}
	if _, err := os.Stat(file); err != nil {
		return Report{Error: "trace.report.path points at " + path + ", which does not exist after the suite ran. " +
			"The report is written BY your test command, so this usually means nothing in it writes the report — the reporter flag is missing from verify.test, or the reporter was removed from the runner's own config — rather than that the tests failed. " +
			"A report left over from an earlier run is removed before each suite, so it cannot stand in for this one."}
	}
	b, err := os.ReadFile(file)
	if err != nil {
		return Report{Error: "trace.report.path (" + path + ") could not be read: " + err.Error()}
	}
	if format == "junit" {
		return readJunit(string(b))
	}
	return readTap(string(b))
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}
