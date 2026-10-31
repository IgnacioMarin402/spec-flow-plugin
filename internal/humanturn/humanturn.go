// Package humanturn says whether a human has answered since a case 3 brief
// was written (ADR-036). A case 3 rewrites a requirement to agree with the
// code, which reads in a diff exactly like rewriting it to agree with the bug.
// hooks/human-turn records turn ends and prompts — never what was said — and
// this reads that record. phase-guard and arm-gate share it.
package humanturn

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/IgnacioMarin402/spec-flow-plugin/internal/hookio"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/specshape"
)

// Log is the record's file under `.claude/state/`.
const Log = "human-turn.log"

type event struct {
	at   time.Time
	kind string // turn-end, or a prompt's source
}

var eventLine = regexp.MustCompile(`(?m)^(\S+Z) (turn-end|prompt from=(\S+))\s*$`)

func events(root string) []event {
	text, ok := hookio.ReadText(filepath.Join(root, ".claude", "state", Log))
	if !ok {
		return nil
	}
	var out []event
	for _, m := range eventLine.FindAllStringSubmatch(text, -1) {
		at, err := time.Parse(time.RFC3339Nano, m[1])
		if err != nil {
			continue
		}
		kind := m[2]
		if m[3] != "" {
			kind = m[3]
		}
		out = append(out, event{at, kind})
	}
	return out
}

// A typed prompt counts only after a turn end that also follows `since`: a
// background agent's report-back fires the same hook as a person, and what
// proves the session stopped to wait is the turn having ended first. A
// question's answer arrives inside the turn, by nature.
func answeredSince(log []event, since time.Time) bool {
	var ended *event
	for i := range log {
		if log[i].kind == "turn-end" && log[i].at.After(since) {
			ended = &log[i]
			break
		}
	}
	for _, e := range log {
		if e.kind == "question" && e.at.After(since) {
			return true
		}
		if e.kind == "human" && ended != nil && e.at.After(ended.at) {
			return true
		}
	}
	return false
}

// Brief is a live fix brief correcting a requirement nobody has answered.
type Brief struct {
	Slug string
	IDs  []string
}

// Unconfirmed are the live fix briefs that correct a requirement and that no
// human has answered since their last write. Stands down — and says so in
// human-turn-unmatched.log — while the log holds no answer at all: a build
// that never fires the hook would otherwise hold every case 3 forever.
func Unconfirmed(root string) []Brief {
	dir := filepath.Join(root, "specflow")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	type found struct {
		Brief
		written time.Time
	}
	var briefs []found
	for _, e := range entries {
		if !e.IsDir() || e.Name() == "archive" {
			continue
		}
		spec := filepath.Join(dir, e.Name(), "spec.md")
		st, err := os.Stat(spec)
		if err != nil {
			continue
		}
		body, _ := hookio.ReadText(spec)
		if !specshape.IsFixBrief(body) {
			continue
		}
		var ids []string
		for _, c := range specshape.ChangedDeltas(body) {
			if c.Kind == "correction" {
				ids = append(ids, c.ID)
			}
		}
		if len(ids) > 0 {
			briefs = append(briefs, found{Brief{e.Name(), ids}, st.ModTime()})
		}
	}
	if len(briefs) == 0 {
		return nil
	}
	log := events(root)
	answered := false
	for _, e := range log {
		if e.kind == "human" || e.kind == "question" {
			answered = true
		}
	}
	if !answered {
		slugs := make([]string, len(briefs))
		for i, b := range briefs {
			slugs[i] = b.Slug
		}
		hookio.AppendLine(filepath.Join(hookio.StateDir(root), "human-turn-unmatched.log"), fmt.Sprintf("%s case-3 check stood down: no answer recorded — %s", hookio.NowISO(), strings.Join(slugs, ", ")))
		return nil
	}
	var out []Brief
	for _, b := range briefs {
		if !answeredSince(log, b.written) {
			out = append(out, b.Brief)
		}
	}
	return out
}

// Denial names the briefs and the step the command describes, never the
// record: what is wanted is the human's answer.
func Denial(found []Brief, doing string) string {
	what := make([]string, len(found))
	for i, f := range found {
		what[i] = fmt.Sprintf("specflow/%s/spec.md corrects %s", f.Slug, strings.Join(f.IDs, ", "))
	}
	return fmt.Sprintf("%s while %s — a case 3 — and no human has answered since that brief was last written. ", doing, strings.Join(what, "; ")) +
		"Rewriting a requirement to agree with the code reads, in a diff, exactly like rewriting it to agree with the bug, so a person confirms it first. " +
		"Show the human each requirement id, its current body, the corrected body and the triage's evidence, then end your turn and wait for their answer. " +
		"If they say the requirement was right after all, send the defect back to a new triage (ADR-036)."
}
