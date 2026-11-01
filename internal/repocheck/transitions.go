package repocheck

// Transitions measures how much HISTORY sits in this engine's comments.
// `.claude/skills/engine-comments` splits reasoning three ways, and a
// transition is the one that does not belong where it is written: git holds
// it with the diff attached, and cannot drift from what happened.
//
// The measure is transition TEXT, not comment density. The count is asserted
// EQUAL to TransitionsExpected, not capped: a ceiling only notices the
// direction that gets worse, and a count drifting below it is the stale
// number this check replaces. Zero is deliberately not the target: where an
// old shape is a trap someone is likely to reintroduce, one line naming it is
// an invariant.

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// TransitionDirs hold engine source, the tests included: no file is outside
// the rule, and exempting the fixtures hid real history in four of them.
var TransitionDirs = []string{"hooks", "cmd", "internal"}

// TransitionsExpected is the measured count over TransitionDirs. Change it in
// the commit that changes the comments, saying which way it moved and why.
// A baseline, not a census: some lines are about a superseded thing in the
// DOMAIN rather than a file's own past, and telling those apart would need
// this check to know which sense a sentence means. Its job is to MOVE when
// someone lets history back in, which a stable baseline does as well as a
// pure one. This file's own comments are counted too.
const TransitionsExpected = 0

// Narrow by measurement: a wider first pattern matched ordinary English
// inside an invariant and reported twice the real figure. A miss keeps the
// number flat; a false positive makes it unreadable.
var (
	transition  = regexp.MustCompile(`(?i)\bused to\b|\bpreviously\b|\bthe old\b|\bthis replaced\b|\bno longer\b|\bhad been\b|\bfor a while\b|\bonce before\b|\bshipped in exactly\b`)
	commentLine = regexp.MustCompile(`^\s*(//|\*|/\*)`)
)

// TransitionLines are the comment lines that read as history, as `file:line  text`.
func TransitionLines(root string) (hits []string, files int) {
	var all []string
	for _, d := range TransitionDirs {
		all = append(all, walk(root, d, []string{".go", ".ts", ".tsx"})...)
	}
	for _, f := range all {
		for i, line := range strings.Split(readRel(root, f), "\n") {
			if commentLine.MatchString(line) && transition.MatchString(line) {
				hits = append(hits, fmt.Sprintf("%s:%d  %s", f, i+1, strings.TrimSpace(line)))
			}
		}
	}
	return hits, len(all)
}

func Transitions(root string) Report {
	r := Report{Name: "comment-transitions"}
	hits, files := TransitionLines(root)
	// A scan that reached nothing reports exactly as a clean engine does.
	if files == 0 {
		r.Problems = append(r.Problems, fmt.Sprintf("found no engine source under %s. A scan that reaches nothing passes exactly as a clean one does, so this is a failure rather than a quiet OK.", strings.Join(TransitionDirs, ", ")))
		return r
	}
	if len(hits) != TransitionsExpected {
		by := map[string]int{}
		for _, h := range hits {
			by[strings.SplitN(h, ":", 2)[0]]++
		}
		worst := sortedKeys(by)
		sort.SliceStable(worst, func(i, j int) bool { return by[worst[i]] > by[worst[j]] })
		if len(worst) > 5 {
			worst = worst[:5]
		}
		why := fmt.Sprintf("Fewer than recorded, which is the direction this rule wants, but TransitionsExpected in %s is now stale. Lower it to %d in the same commit.", "internal/repocheck/transitions.go", len(hits))
		if len(hits) > TransitionsExpected {
			why = "Something's history moved back into a comment. Git already holds it with the diff attached: put it in the commit message instead, and see .claude/skills/engine-comments for the one case where naming an old shape IS an invariant. If this line is that case, raise TransitionsExpected and say why in the commit."
		}
		var most []string
		for _, f := range worst {
			most = append(most, fmt.Sprintf("%3d  %s", by[f], f))
		}
		r.Problems = append(r.Problems, fmt.Sprintf("%d transition line(s), and TransitionsExpected says %d. %s\n    Most, by file:\n      %s\n    Every line counted:\n      %s",
			len(hits), TransitionsExpected, why, strings.Join(most, "\n      "), strings.Join(hits, "\n      ")))
	}
	r.OK = fmt.Sprintf("%d transition line(s) across %d engine source file(s), matching what this check records.", len(hits), files)
	return r
}
