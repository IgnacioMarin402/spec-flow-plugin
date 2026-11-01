package repocheck

// LineEnds holds the engine's multi-line patterns to jsre. Go's regexp ends
// a line only at \n, so under (?m) its `$` never matches before the \r a
// Windows checkout puts there, and a capability spec read that way has no
// scope marker. jsre reads a line as JavaScript does.

import (
	"fmt"
	"regexp"
	"strings"
)

var multilineRE2 = regexp.MustCompile("regexp\\.MustCompile\\(`\\(\\?[a-z]*m")

func LineEnds(root string) Report {
	r := Report{Name: "line-ends"}
	files := 0
	for _, d := range []string{"cmd", "internal"} {
		for _, f := range walk(root, d, []string{".go"}, "internal/repocheck", "internal/build") {
			if strings.HasSuffix(f, "_test.go") {
				continue
			}
			files++
			for i, line := range strings.Split(readRel(root, f), "\n") {
				if multilineRE2.MatchString(line) {
					r.Problems = append(r.Problems, fmt.Sprintf("%s:%d  a multi-line Go regexp: under (?m) its `$` never matches before a \\r, so a CRLF file reads as one with no line ends. Use jsre.MustCompile(pattern, \"m\").\n    %s", f, i+1, strings.TrimSpace(line)))
				}
			}
		}
	}
	if files == 0 {
		r.Problems = append(r.Problems, "found no engine source under cmd/ or internal/: a scan that reaches nothing passes as a clean one does.")
	}
	r.OK = fmt.Sprintf("%d engine source file(s), every multi-line pattern read as JavaScript reads a line.", files)
	return r
}
