package e2e

// The step `resume` names, for every state a run can be left in. A wrong
// verdict is a resumed run that repeats a milestone, skips one, or plans over
// a spec nobody approved.

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

const (
	resumeSpec     = "# Spec — add-cities: cities\n\n## Requirement deltas\n- ADDED   REQ-CITY-001 — a city has a name\n"
	resumeFix      = "# Fix — fix-empty-filter: an empty filter\n\n## Case\n1 UNSPECIFIED\n"
	resumeProposal = "# Proposal — add-cities: cities\n\n## Source\nAdd cities.\n"
	resumePlan     = "# Plan — add-cities\n"
)

// stamped is the stamp a fold or a rejection writes: directly under the heading.
func stamped(text, status string) string {
	heading, rest, _ := strings.Cut(text, "\n")
	return heading + "\n\n**Status:** " + status + " 2026-09-27\n" + rest
}

type runState struct {
	files, dirty           map[string]string
	phase                  *string
	milestone, verdict     string
	verdictAge, startedAge time.Duration
}

// resumeRepo is a repository in one run state: files committed, dirty
// written after, and a gate verdict stamped on HEAD verdictAge ago.
func resumeRepo(t *testing.T, s runState) string {
	t.Helper()
	dir := t.TempDir()
	git(t, dir, "init", "-q", ".")
	git(t, dir, "symbolic-ref", "HEAD", "refs/heads/main")
	write(t, filepath.Join(dir, ".gitignore"), ".claude/state/\n")
	writeFiles(t, dir, s.files)
	git(t, dir, "add", "-A")
	git(t, dir, "commit", "-q", "--allow-empty", "-m", "state")
	writeFiles(t, dir, s.dirty)
	os.MkdirAll(filepath.Join(dir, ".claude", "state"), 0o755)
	if s.phase == nil {
		s.phase = phased("implement")
	}
	write(t, statePath(dir, "phase"), *s.phase)
	if s.milestone != "" {
		at := statePath(dir, "current-milestone")
		write(t, at, s.milestone+" abc123def4567890a")
		if s.startedAge == 0 {
			s.startedAge = 60 * time.Minute
		}
		age(t, at, s.startedAge)
	}
	if s.verdict != "" {
		if s.verdictAge == 0 {
			s.verdictAge = 5 * time.Minute
		}
		sha := git(t, dir, "rev-parse", "--short", "HEAD")
		at := time.Now().Add(-s.verdictAge).UTC().Format("2006-01-02T15:04:05Z")
		write(t, statePath(dir, "gate-history.log"), at+" "+sha+" cc=? engine=fixture phase=implement attempt=0 result="+s.verdict+" lint=0 test=0 spec=0 files=1\n")
	}
	return dir
}

type resumed struct {
	code           int
	out, next, why string
}

func resume(t *testing.T, dir string, args ...string) resumed {
	t.Helper()
	r := run(os.TempDir(), []string{"CLAUDE_PROJECT_DIR=" + dir}, "", cliArgv(engineDir, append([]string{"resume"}, args...)...)...)
	line := func(key string) string {
		if m := regexp.MustCompile(`(?m)^` + key + `: (.+)$`).FindStringSubmatch(r.Stdout); m != nil {
			return m[1]
		}
		return ""
	}
	return resumed{r.Status, r.Stdout, line("NEXT"), line("WHY")}
}

func expectNext(t *testing.T, r resumed, next string) {
	t.Helper()
	if r.code != 0 {
		t.Fatalf("exited %d; a report must always exit 0\n%s", r.code, r.out)
	}
	if r.next != next {
		t.Fatalf("NEXT: %q, want %s\n%s", r.next, next, r.out)
	}
}

func feature(extra map[string]string) map[string]string {
	return merge(map[string]string{"specflow/add-cities/spec.md": resumeSpec, "specflow/add-cities/proposal.md": resumeProposal}, extra)
}

func planned(extra map[string]string) map[string]string {
	return feature(merge(map[string]string{"specflow/add-cities/plan.md": resumePlan, "specflow/add-cities/milestones/M1.md": "# M1\n", "specflow/add-cities/milestones/M2.md": "# M2\n"}, extra))
}

// A plan committed on the base and never run is not a run of a branch off it
// (ADR-032): offered as one, resume enters a run phase-guard refuses to start.
func parkedRepo(t *testing.T, own map[string]string) string {
	dir := resumeRepo(t, runState{files: map[string]string{".spec-flow/config.json": smokeContract(nil), "specflow/parked/spec.md": resumeSpec,
		"specflow/parked/proposal.md": resumeProposal, "specflow/parked/plan.md": resumePlan}, phase: phased("idle")})
	git(t, dir, "checkout", "-q", "-b", "feature")
	writeFiles(t, dir, own)
	git(t, dir, "add", "-A")
	git(t, dir, "commit", "-q", "--allow-empty", "-m", "own")
	return dir
}

func TestResume(t *testing.T) {
	t.Parallel()
	idle := phased("idle")
	fixOrder := map[string]string{"specflow/fix-empty-filter/spec.md": resumeFix, "specflow/fix-empty-filter/plan.md": resumePlan, "specflow/fix-empty-filter/milestones/M1.md": "# M1\n"}
	for _, c := range []struct {
		name string
		run  func(t *testing.T)
	}{
		// ---- before any code
		{"no change in flight: NONE", func(t *testing.T) { expectNext(t, resume(t, resumeRepo(t, runState{phase: idle})), "NONE") }},
		{"a spec and its proposal with no plan: SIGN-OFF — the one step no file records", func(t *testing.T) {
			expectNext(t, resume(t, resumeRepo(t, runState{files: feature(nil), phase: idle})), "SIGN-OFF")
		}},
		// phase-guard refuses to leave `spec` with a spec lacking `## Assumptions`.
		{"a sign-off over a spec phase-guard would refuse says the spec-writer revises it first", func(t *testing.T) {
			r := resume(t, resumeRepo(t, runState{files: feature(nil), phase: idle}))
			expectNext(t, r, "SIGN-OFF")
			if !strings.Contains(r.why, "revises it first") || !strings.Contains(r.why, "## Assumptions") {
				t.Fatalf("WHY does not name the problem and the revision: %s", r.why)
			}
		}},
		{"a sign-off over a ready spec asks for nothing else", func(t *testing.T) {
			r := resume(t, resumeRepo(t, runState{files: feature(map[string]string{"specflow/add-cities/spec.md": resumeSpec + "\n## Assumptions\n- none\n"}), phase: idle}))
			expectNext(t, r, "SIGN-OFF")
			mustNotMatch(t, `revises`, r.why, "a ready spec was sent back")
		}},
		{"a spec without its proposal: SPEC — the spec step never finished", func(t *testing.T) {
			expectNext(t, resume(t, resumeRepo(t, runState{files: map[string]string{"specflow/add-cities/spec.md": resumeSpec}, phase: phased("spec")})), "SPEC")
		}},
		{"a fix brief with no work order: WORK-ORDER, not a sign-off", func(t *testing.T) {
			expectNext(t, resume(t, resumeRepo(t, runState{files: map[string]string{"specflow/fix-empty-filter/spec.md": resumeFix}, phase: phased("spec")})), "WORK-ORDER")
		}},
		{"a plan with no milestone ever started: REVIEW", func(t *testing.T) {
			expectNext(t, resume(t, resumeRepo(t, runState{files: planned(nil), phase: phased("review")})), "REVIEW")
		}},
		// The triage writes the work order inside `spec` (ADR-033): until an
		// implementer starts, the fix re-enters at the HITL step.
		{"a fix work order with no implementer ever spawned: WORK-ORDER, so a case 3 is confirmed again", func(t *testing.T) {
			r := resume(t, resumeRepo(t, runState{files: fixOrder}))
			expectNext(t, r, "WORK-ORDER")
			mustMatch(t, `case 3 is confirmed`, r.why, "WHY does not say the case 3 OK is asked again")
		}},
		{"a fix work order whose implementer started: IMPLEMENT M1", func(t *testing.T) {
			expectNext(t, resume(t, resumeRepo(t, runState{files: fixOrder, milestone: "fix-empty-filter M1"})), "IMPLEMENT M1")
		}},
		// ---- during the milestones
		{"M1 passed on HEAD after it started: IMPLEMENT M2", func(t *testing.T) {
			expectNext(t, resume(t, resumeRepo(t, runState{files: planned(nil), milestone: "add-cities M1", verdict: "pass"})), "IMPLEMENT M2")
		}},
		{"the last milestone passed: FOLD", func(t *testing.T) {
			expectNext(t, resume(t, resumeRepo(t, runState{files: planned(nil), milestone: "add-cities M2", verdict: "pass"})), "FOLD")
		}},
		{"a pass stamped BEFORE the milestone started is the previous one's: IMPLEMENT M2 again", func(t *testing.T) {
			expectNext(t, resume(t, resumeRepo(t, runState{files: planned(nil), milestone: "add-cities M2", verdict: "pass", verdictAge: 90 * time.Minute, startedAge: 30 * time.Minute})), "IMPLEMENT M2")
		}},
		{"a milestone in flight on a dirty tree: IMPLEMENT it, and say the tree holds the dead session's work", func(t *testing.T) {
			r := resume(t, resumeRepo(t, runState{files: planned(nil), milestone: "add-cities M1", dirty: map[string]string{"wip/half-written.txt": "half\n"}}))
			expectNext(t, r, "IMPLEMENT M1")
			mustMatch(t, `uncommitted`, r.why, "WHY does not mention the uncommitted work")
		}},
		{"a gate failure on HEAD: IMPLEMENT that milestone, pointing at the failure log", func(t *testing.T) {
			r := resume(t, resumeRepo(t, runState{files: planned(nil), milestone: "add-cities M1", verdict: "fail"}))
			expectNext(t, r, "IMPLEMENT M1")
			mustMatch(t, `gate-failure\.log`, r.why, "WHY does not say where the failure is")
		}},
		{"a milestone of ANOTHER change in the position file is not this change's", func(t *testing.T) {
			expectNext(t, resume(t, resumeRepo(t, runState{files: planned(nil), milestone: "other-change M1", verdict: "pass"})), "REVIEW")
		}},
		// ---- closing
		{"a SHIPPED stamp on a live folder: FOLD — the archive never happened", func(t *testing.T) {
			expectNext(t, resume(t, resumeRepo(t, runState{files: planned(map[string]string{"specflow/add-cities/spec.md": stamped(resumeSpec, "SHIPPED")})})), "FOLD")
		}},
		{"a REJECTED stamp on a live folder: ARCHIVE-REJECTED", func(t *testing.T) {
			expectNext(t, resume(t, resumeRepo(t, runState{files: feature(map[string]string{"specflow/add-cities/spec.md": stamped(resumeSpec, "REJECTED")}), phase: phased("spec")})), "ARCHIVE-REJECTED")
		}},
		{"an archived change whose run never wrote done: DONE", func(t *testing.T) {
			expectNext(t, resume(t, resumeRepo(t, runState{files: map[string]string{"specflow/archive/add-cities/spec.md": stamped(resumeSpec, "SHIPPED"), "specflow/archive/add-cities/proposal.md": resumeProposal}, milestone: "add-cities M2"})), "DONE")
		}},
		{"an archived change the run DID close is not resumed", func(t *testing.T) {
			expectNext(t, resume(t, resumeRepo(t, runState{files: map[string]string{"specflow/archive/add-cities/spec.md": stamped(resumeSpec, "SHIPPED")}, milestone: "add-cities M2", phase: phased("done")})), "NONE")
		}},
		// ---- which change, and what it may not do
		{"two live changes: CHOOSE, and naming one resumes it", func(t *testing.T) {
			dir := resumeRepo(t, runState{files: feature(map[string]string{"specflow/other/spec.md": resumeSpec, "specflow/other/proposal.md": resumeProposal, "specflow/other/plan.md": resumePlan}), phase: idle})
			expectNext(t, resume(t, dir), "CHOOSE")
			expectNext(t, resume(t, dir, "other"), "REVIEW")
		}},
		{"a plan the base branch already has is not offered as the run to resume", func(t *testing.T) {
			r := resume(t, parkedRepo(t, nil))
			expectNext(t, r, "NONE")
			if !strings.Contains(r.out, "the base branch has them: parked") {
				t.Fatalf("the parked plan is not named:\n%s", r.out)
			}
		}},
		{"a plan the base branch has does not stand beside this branch's own change", func(t *testing.T) {
			expectNext(t, resume(t, parkedRepo(t, feature(nil))), "SIGN-OFF")
		}},
		{"a blocked run: BLOCKED — a human decides, not a resume", func(t *testing.T) {
			expectNext(t, resume(t, resumeRepo(t, runState{files: planned(nil), milestone: "add-cities M1", phase: phased("blocked")})), "BLOCKED")
		}},
		{"state it cannot read still ends on a NEXT line, with exit 0", func(t *testing.T) {
			dir := resumeRepo(t, runState{phase: idle})
			write(t, filepath.Join(dir, "specflow"), "a file where a directory belongs\n")
			expectNext(t, resume(t, dir), "UNKNOWN")
		}},
		{"it creates nothing in a repository that never ran the flow", func(t *testing.T) {
			dir := t.TempDir()
			if r := resume(t, dir); r.code != 0 {
				t.Fatalf("exited %d", r.code)
			}
			if exists(filepath.Join(dir, ".claude")) {
				t.Fatal("created .claude/ in a repository with no run")
			}
		}},
	} {
		c := c
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			c.run(t)
		})
	}
}
