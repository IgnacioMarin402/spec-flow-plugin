package repocheck

// Decisions binds `decisions/` to the code, both directions. A record is
// trusted on two conditions: it claims a MOMENT, not a present state, and it
// is REACHABLE from the code it governs with every citation resolving. A
// citation with no record sends a reader to nothing; a record with no
// citation is not found at the moment someone is about to undo it.

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// Where a citation may appear. `decisions/` is deliberately absent: a record
// citing another is a cross-reference, and counting it would let a record
// keep itself alive.
var (
	CiteDirs  = []string{"hooks", "cmd", "internal", "commands", "agents", "modes", ".claude/skills", "skills"}
	CiteExts  = []string{".go", ".md", ".json", ".ts", ".tsx"}
	CiteFiles = []string{"README.md", "REFERENCE.md", "CLAUDE.md", "BACKLOG.md", ".github/workflows/ci.yml"}
)

const decisionsSelf = "internal/repocheck/decisions.go"

var (
	// Three digits, so a year or an id cannot match.
	citation = regexp.MustCompile(`\bADR-(\d{3})\b`)
	record   = regexp.MustCompile(`^(\d{3})-[a-z0-9-]+\.md$`)
)

func Decisions(root string) Report {
	r := Report{Name: "decisions"}
	records := map[string]string{}
	entries, _ := os.ReadDir(filepath.Join(root, "decisions"))
	for _, e := range entries {
		name := e.Name()
		if name == "README.md" {
			continue
		}
		m := record.FindStringSubmatch(name)
		if m == nil {
			r.Problems = append(r.Problems, fmt.Sprintf("decisions/%s is not named like a record. Use NNN-a-short-slug.md — the number is what a citation resolves against, so a file without one cannot be cited.", name))
			continue
		}
		if prev, dup := records[m[1]]; dup {
			r.Problems = append(r.Problems, fmt.Sprintf("decisions/ has two records numbered %s: %s and %s.", m[1], prev, name))
			continue
		}
		records[m[1]] = name
	}
	cited := map[string][]string{}
	for _, f := range surfaces(root, CiteDirs, CiteExts, CiteFiles, decisionsSelf) {
		for _, m := range citation.FindAllStringSubmatch(readRel(root, f), -1) {
			if !contains(cited[m[1]], f) {
				cited[m[1]] = append(cited[m[1]], f)
			}
		}
	}
	for _, n := range sortedKeys(cited) {
		if _, ok := records[n]; !ok {
			r.Problems = append(r.Problems, fmt.Sprintf("ADR-%s is cited by %s but decisions/ has no record numbered %s. A reader following that citation finds nothing, which is worse than no citation at all.", n, strings.Join(cited[n], ", "), n))
		}
	}
	for _, n := range sortedKeys(records) {
		if _, ok := cited[n]; !ok {
			r.Problems = append(r.Problems, fmt.Sprintf("decisions/%s is cited by nothing. A decision unreachable from the code it governs will not be found at the moment someone is about to undo it. Cite it (`see ADR-%s`) from the file it constrains, or delete it.", records[n], n))
		}
	}
	r.OK = fmt.Sprintf("%d record(s), every one cited; %d citation(s), every one resolving.", len(records), len(cited))
	return r
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
