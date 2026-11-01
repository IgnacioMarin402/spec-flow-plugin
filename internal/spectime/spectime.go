// Package spectime holds a live change spec to what spec-trace checks at the
// gate, plus what only its writing is held to: its assumptions (ADR-030), the
// shape of its deltas and its name. phase-guard denies leaving `spec` on them.
package spectime

import (
	"os"
	"path/filepath"

	"github.com/IgnacioMarin402/spec-flow-plugin/internal/specshape"
)

// ArchivedSlugs are the change folders under `specflow/archive/`.
func ArchivedSlugs(root string) []string {
	entries, err := os.ReadDir(filepath.Join(root, "specflow", "archive"))
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		if e.IsDir() {
			out = append(out, e.Name())
		}
	}
	return out
}

func read(path string) (string, bool) {
	b, err := os.ReadFile(path)
	return string(b), err == nil
}

func exists(path string) bool { _, err := os.Stat(path); return err == nil }

// Problems is one message per problem across slugs, each naming its spec. The
// deltas' shape is held here, not at every gate: a run signed off before a
// spelling was refused must not fail its milestones over it (ADR-048). The
// name (clash) only while nothing names the folder yet.
func Problems(root string, slugs []string, clash bool) []string {
	archive := filepath.Join(root, "specflow", "archive")
	archived := ArchivedSlugs(root)
	var bodies []string
	for _, slug := range archived {
		if b, ok := read(filepath.Join(archive, slug, "spec.md")); ok {
			bodies = append(bodies, b)
		}
	}
	var found []string
	for _, slug := range slugs {
		body, ok := read(filepath.Join(root, "specflow", slug, "spec.md"))
		if !ok {
			continue // a folder mid-write is not a failure
		}
		if clash {
			if taken := specshape.ArchiveClash(slug, archived); taken != "" {
				found = append(found, taken)
			}
		}
		if a := specshape.AssumptionsProblem(body); a != "" {
			found = append(found, "specflow/"+slug+"/spec.md "+a+".")
		}
		if s := specshape.DeltasSectionProblem(body, true); s != "" {
			found = append(found, "specflow/"+slug+"/spec.md "+s)
		}
		for _, u := range specshape.UnreadDeltas(body) {
			found = append(found, "specflow/"+slug+"/spec.md: "+specshape.ExplainUnread(u))
		}
		found = append(found, specshape.LiveSpecProblems(slug, body, exists(filepath.Join(root, "specflow", slug, "proposal.md")), bodies)...)
	}
	return found
}

// LeavingSpec is what leaving `spec` is held to: every live change with no
// plan yet, and every fix brief, whose triage writes its plan inside `spec`
// (ADR-033). phase-guard and arm-gate both ask it, so they cannot disagree.
func LeavingSpec(root string) []string {
	dir := filepath.Join(root, "specflow")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var unplanned []string
	for _, e := range entries {
		if !e.IsDir() || e.Name() == "archive" {
			continue
		}
		slug := e.Name()
		body, isSpec := read(filepath.Join(dir, slug, "spec.md"))
		if !exists(filepath.Join(dir, slug, "plan.md")) || (isSpec && specshape.IsFixBrief(body)) {
			unplanned = append(unplanned, slug)
		}
	}
	return Problems(root, unplanned, true)
}
