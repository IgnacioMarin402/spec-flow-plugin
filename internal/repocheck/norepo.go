package repocheck

// NoRepoRefs fails if any engine file couples itself to one consuming repo:
// its vocabulary, or the reasoning pattern only its history supports. The
// engine depends on a contract the repo implements (`.spec-flow/config.json`),
// never on the repo; this is what makes that arrow verifiable.
//
//   - vocabulary tokens couple the engine to one codebase. Under ADR-007 the
//     line is one repo's vocabulary, not one ecosystem's: a test runner's
//     name is not coupling, its package manager, framework and layer names are.
//   - a "read the archive for precedent" INSTRUCTION couples the engine to
//     one repo's HISTORY: plan quality becomes a function of how long the repo
//     has existed. `planner.md` keeps the archive out of a plan (ADR-026).
//     Narrower than banning `specflow/archive`, the engine's own convention.

import (
	"fmt"
	"regexp"
	"strings"
)

// The surfaces it claims. Every prose doc goes in NoRepoFiles: the moment a
// reference doc is split out of the README, an unscanned one is the path of
// least resistance for the vocabulary this keeps out. Both skill directories:
// `.claude/skills` is this repo's own, `skills` ships to adopters (ADR-006).
var (
	NoRepoDirs  = []string{"hooks", "cmd", "internal", "commands", "agents", "modes", ".claude/skills", "skills", "decisions", "evals"}
	NoRepoExts  = []string{".go", ".md", ".json", ".ts", ".tsx", ".sh", ".yaml"}
	NoRepoFiles = []string{"README.md", "REFERENCE.md", "CLAUDE.md", "LICENSE", "BACKLOG.md", ".github/workflows/ci.yml", "bin/spec-flow"}
)

// noRepoSelf names what it bans, necessarily.
const noRepoSelf = "internal/repocheck/norepo.go"

// Written by each `claude plugin eval` run and gitignored: a model's output.
const evalResults = "evals/results"

// Whole-word or path-shaped: a substring match on "application" would also
// flag the English word.
var banned = []struct {
	re    *regexp.Regexp
	label string
}{
	{regexp.MustCompile(`\bsrc/`), "src/"},
	{regexp.MustCompile(`\bapplication/|\bapplication layer\b|application/use-cases`), "application (the hexagonal layer)"},
	{regexp.MustCompile(`\binfrastructure/|\binfrastructure layer\b`), "infrastructure (the hexagonal layer)"},
	{regexp.MustCompile(`\bdomain/(services|interfaces|value-objects|models)?\b`), "domain/ (the hexagonal layer)"},
	{regexp.MustCompile(`\bpnpm run\b`), "pnpm run"},
	{regexp.MustCompile(`\beslint\.config\.mjs\b`), "eslint.config.mjs"},
	{regexp.MustCompile(`(?i)\bNestJS\b`), "NestJS"},
	{regexp.MustCompile(`\bdomain-service-trace\b`), "domain-service-trace"},
	// Proximity, not a path-string ban.
	{regexp.MustCompile(`(?i)\barchive\b[^.]{0,60}\b(precedent|inspiration)\b|\b(precedent|inspiration)\b[^.]{0,60}\barchive\b`),
		"reads the archive for precedent/inspiration — shape guidance from one repo's history, not this repo's job"},
}

func NoRepoRefs(root string) Report {
	files := surfaces(root, NoRepoDirs, NoRepoExts, NoRepoFiles, noRepoSelf, evalResults)
	r := Report{Name: "no-repo-refs", Advice: "The engine must run identically against any consuming repo. A value that belongs to one repo goes in that repo's .spec-flow/config.json, not in this file."}
	for _, f := range files {
		for i, line := range strings.Split(readRel(root, f), "\n") {
			for _, b := range banned {
				if b.re.MatchString(line) {
					r.Problems = append(r.Problems, fmt.Sprintf("%s:%d  %s\n    %s", f, i+1, b.label, strings.TrimSpace(line)))
				}
			}
		}
	}
	r.OK = fmt.Sprintf("%d file(s) clean of repo-specific vocabulary and history.", len(files))
	return r
}
