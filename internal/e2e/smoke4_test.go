package e2e

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func unmatchedLog(repo string) string {
	return strings.TrimSpace(read(statePath(repo, "phase-guard-unmatched.log")))
}

// B69: a commit message naming a phase write was judged as one, and an
// escape or a heredoc hid a real write next to it.
func TestPhaseGuardQuoting(t *testing.T) {
	t.Run("reads quoted text, a heredoc body and a comment as text", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		seedGateHistory(t, repo, "fail:behaviour")
		for _, c := range []string{
			`git commit -m "note: printf done > .claude/state/phase comes later"`,
			`git commit -m 'printf done | tee .claude/state/phase' && git push`,
			`git commit -m "a > b" -m "then printf done > .claude/state/phase"`,
			"git commit -m \"$(cat <<'EOF'\nnote: printf done >\n.claude/state/phase comes later\nEOF\n)\"",
			"git commit -F - <<'EOF'\nnote: printf done > .claude/state/phase\nEOF",
			`git commit -m "step 1; cd .claude/state" && printf done > phase`,
			"echo checked # then printf done > .claude/state/phase",
		} {
			expectStatus(t, runHook(t, "phase-guard", bash(c), repo), 0, "`"+c+"` was denied as a phase write")
		}
		if u := unmatchedLog(repo); u != "" {
			t.Fatalf("text was logged as a write that got past: %s", u)
		}
	})
	t.Run("reads a phase write the quoting beside it does not hide", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		seedGateHistory(t, repo, "fail:behaviour")
		for _, c := range []string{
			`git commit -m "x > y" && printf done > .claude/state/phase`,
			`printf "done" > ".claude/state/phase"`,
			`printf done > "$CLAUDE_PROJECT_DIR"/.claude/state/phase`,
			`git commit -m 'it'\''s done' && printf done > .claude/state/phase`,
			`git commit -m "a \"b" && printf done > .claude/state/phase && echo "c"`,
			"git commit -m \"$(cat <<'EOF'\nfix: the \"reviewer's\" verdict\nEOF\n)\" && printf done > .claude/state/phase",
			`echo "M3 -> done" && printf done > .claude/state/phase`,
			`echo implement > /tmp/note && printf done > .claude/state/phase`,
			`x="$(printf done > .claude/state/phase)"`,
			"bash <<'EOF'\nprintf done > .claude/state/phase\nEOF",
			"x=$((1 << 2))\nprintf done > .claude/state/phase",
		} {
			expectStatus(t, runHook(t, "phase-guard", bash(c), repo), 2, "`"+c+"` wrote an unearned done")
		}
	})
	t.Run("logs a phase write handed to a shell as text", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		seedGateHistory(t, repo, "fail:behaviour")
		for _, c := range []string{"sh -c 'printf done > .claude/state/phase'", "eval 'printf done > .claude/state/phase'"} {
			runHook(t, "phase-guard", bash(c), repo)
		}
		if u := unmatchedLog(repo); u != "sh\neval" {
			t.Fatalf("want sh and eval logged as writes that got past, got %q", u)
		}
	})
	t.Run("run-trace closes a run on a phase write, never on text that names one", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{phase: "done"})
		post := func(c string) { runHook(t, "run-trace", postTool("s", "Bash", map[string]any{"command": c}), repo) }
		for _, c := range []string{`git commit -m "note: printf done > .claude/state/phase comes later"`, "git commit -F - <<'EOF'\nnote: printf done > .claude/state/phase\nEOF"} {
			post(c)
			if traceText(repo) != "" {
				t.Fatalf("`%s` closed the run:\n%s", c, traceText(repo))
			}
		}
		for _, c := range []string{`git commit -m "x > y" && printf done > ".claude/state/phase"`, `printf done > "$CLAUDE_PROJECT_DIR"/.claude/state/phase`, "sh -c 'printf done > .claude/state/phase'"} {
			os.Remove(statePath(repo, "run-trace.log"))
			post(c)
			mustMatch(t, `(?m) phase=done session=s closed tool=Bash$`, traceText(repo), "`"+c+"` left no closing line")
		}
	})
	t.Run("a cd makes no other file named phase, nor another state file, a phase write", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		seedGateHistory(t, repo, "fail:behaviour")
		for _, c := range []string{"cd .claude/state && printf 0 > gate_attempts", "cd docs && printf done > phase", "echo cd .claude/state && printf done > phase", "cd .claude/state && cat phase > /tmp/p"} {
			expectStatus(t, runHook(t, "phase-guard", bash(c), repo), 0, "`"+c+"` was denied as a phase write")
		}
		if exists(statePath(repo, "phase-guard-unmatched.log")) {
			t.Fatalf("logged as an unread phase write: %s", unmatchedLog(repo))
		}
	})
	t.Run("a phase write it cannot read after a cd is logged under its writer, not cd", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		runHook(t, "phase-guard", bash("cd .claude/state && cat /tmp/x > phase"), repo)
		if u := unmatchedLog(repo); u != "cat" {
			t.Fatalf("want the writer cat logged, got %q", u)
		}
	})
}

func TestPhaseGuardEndsOfARun(t *testing.T) {
	t.Run("denies done when no gate ever judged the current commit", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		r := runHook(t, "phase-guard", map[string]any{"tool_name": "Write", "tool_input": map[string]any{"file_path": ".claude/state/phase", "content": "done"}}, repo)
		expectStatus(t, r, 2, "done was allowed with no gate verdict at all")
	})
	t.Run("denies idle mid-implement", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		seedGateHistory(t, repo, "fail:behaviour")
		expectStatus(t, runHook(t, "phase-guard", phaseBash("idle"), repo), 2, "idle was allowed from implement after a red gate")
	})
	t.Run("denies idle over a change folder that was never recorded", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{phase: "spec"})
		os.MkdirAll(filepath.Join(repo, "specflow", "my-change"), 0o755)
		r := runHook(t, "phase-guard", phaseBash("idle"), repo)
		expectStatus(t, r, 2, "idle was allowed with specflow/my-change/ still live")
		mustMatch(t, `my-change`, r.Stderr, "the denial does not name the folder")
	})
	// Guards: the protocol's own paths to idle must keep passing.
	t.Run("allows idle once the rejection is archived", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{phase: "spec"})
		os.MkdirAll(filepath.Join(repo, "specflow", "archive", "my-change"), 0o755)
		expectStatus(t, runHook(t, "phase-guard", phaseBash("idle"), repo), 0, "the protocol's own rejection path was denied")
	})
	t.Run("allows idle from blocked", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{phase: "blocked"})
		os.MkdirAll(filepath.Join(repo, "specflow", "my-change"), 0o755)
		expectStatus(t, runHook(t, "phase-guard", phaseBash("idle"), repo), 0, "a human abandoning a blocked run was refused")
	})
}

// ---- leaving `spec` needs a spec its first gate would accept (ADR-030) ----

const signedSpec = "# Spec — my-change: x\n\n## Requirement deltas\n- ADDED REQ-USER-001 — a thing\n\n## Assumptions\n- none\n\n## Out of scope\n- nothing\n"

func writePhase(t *testing.T, repo, value string) Result {
	t.Helper()
	return runHook(t, "phase-guard", phaseBash(value), repo)
}

func TestPhaseGuardLeavingSpec(t *testing.T) {
	spec := repoOpts{phase: "spec"}
	t.Run("denies plan while the spec says nothing of what it assumed", func(t *testing.T) {
		repo := makeRepo(t, spec)
		writeChange(t, repo, strings.Replace(signedSpec, "## Assumptions\n- none\n\n", "", 1), true, "")
		r := writePhase(t, repo, "plan")
		expectStatus(t, r, 2, "plan was allowed over a spec with no Assumptions")
		mustMatch(t, "my-change/spec\\.md has no `## Assumptions`", r.Stderr, "the denial does not name the spec and the section")
		mustMatch(t, `sign-off again`, r.Stderr, "the denial does not send the change back to sign-off")
	})
	t.Run("denies plan over what spec-trace would reject at the first gate", func(t *testing.T) {
		repo := makeRepo(t, spec)
		writeChange(t, repo, strings.Replace(signedSpec, "## Out of scope", "## Decision\nchosen\n\n## Out of scope", 1), false, "")
		r := writePhase(t, repo, "plan")
		expectStatus(t, r, 2, "plan was allowed over a spec carrying ## Decision with no proposal.md")
		mustMatch(t, `## Decision`, r.Stderr, "the denial misses ## Decision")
		mustMatch(t, `no proposal\.md`, r.Stderr, "the denial misses the proposal")
	})
	t.Run("denies plan over an ADDED that pairs a prohibition with another claim", func(t *testing.T) {
		repo := makeRepo(t, spec)
		writeChange(t, repo, strings.Replace(signedSpec, "a thing", "filters by A and B, never by C", 1), true, "")
		r := writePhase(t, repo, "plan")
		expectStatus(t, r, 2, "plan was allowed over a prohibition sharing its id")
		mustMatch(t, `REQ-USER-001`, r.Stderr, "the denial does not name the delta")
		mustMatch(t, `id of its own`, r.Stderr, "the denial does not name the split")
	})
	t.Run("denies plan over a delta line the engine does not read", func(t *testing.T) {
		repo := makeRepo(t, spec)
		writeChange(t, repo, strings.Replace(signedSpec, "- ADDED REQ-USER-001 — a thing", "- **ADDED** REQ-USER-001 — a thing", 1), true, "")
		r := writePhase(t, repo, "plan")
		expectStatus(t, r, 2, "plan was allowed over a delta no check reads")
		mustMatch(t, `names REQ-USER-001, which no delta line`, r.Stderr, "the denial does not quote the line")
	})
	for _, c := range [][3]string{
		{"a heading spelled another way", strings.Replace(signedSpec, "## Requirement deltas", "## Requirement Deltas", 1), `has "## Requirement Deltas"`},
		{"deltas outside their section", strings.Replace(signedSpec, "## Requirement deltas\n- ADDED REQ-USER-001 — a thing", "## ADDED Requirements\n### REQ-USER-001 — a thing", 1), "declares a delta outside"},
		{"no deltas section", strings.Replace(signedSpec, "## Requirement deltas\n- ADDED REQ-USER-001 — a thing\n", "", 1), "has no `## Requirement deltas` section"},
		{"a section saying nothing the engine reads", strings.Replace(signedSpec, "- ADDED REQ-USER-001 — a thing", "This change adds the export.", 1), "says nothing the engine reads"},
	} {
		t.Run("denies plan over "+c[0], func(t *testing.T) {
			repo := makeRepo(t, spec)
			writeChange(t, repo, c[1], true, "")
			r := writePhase(t, repo, "plan")
			expectStatus(t, r, 2, "plan was allowed over deltas no check reads")
			if !strings.Contains(r.Stderr, c[2]) {
				t.Fatalf("the denial does not say %q: %s", c[2], r.Stderr)
			}
		})
	}
	archived := func(t *testing.T, repo string) {
		write(t, filepath.Join(repo, "specflow", "archive", "my-change", "spec.md"), "# Spec — my-change\n\n**Status:** SHIPPED 2026-07-30\n\n## Requirement deltas\n- none\n")
	}
	t.Run("denies plan over a change named like an archived one", func(t *testing.T) {
		repo := makeRepo(t, spec)
		writeChange(t, repo, signedSpec, true, "")
		archived(t, repo)
		r := writePhase(t, repo, "plan")
		expectStatus(t, r, 2, "plan was allowed over a change the fold would move inside another")
		mustMatch(t, `has the name of an archived change`, r.Stderr, "the denial does not name the clash")
	})
	// On a case-insensitive filesystem the fold moves My-Change into my-change.
	t.Run("denies plan over a name the archive has in another case", func(t *testing.T) {
		repo := makeRepo(t, spec)
		writeChange(t, repo, signedSpec, true, "My-Change")
		archived(t, repo)
		r := writePhase(t, repo, "plan")
		expectStatus(t, r, 2, "plan was allowed over a name differing from an archived one only in case")
		mustMatch(t, `has the name of an archived change`, r.Stderr, "the denial does not name the clash")
	})
	t.Run("allows leaving spec with each prohibition on its own id", func(t *testing.T) {
		repo := makeRepo(t, spec)
		writeChange(t, repo, strings.Replace(signedSpec, "- ADDED REQ-USER-001 — a thing", "- ADDED REQ-USER-001 — filters by A and B\n- ADDED REQ-USER-002 — never filters by C", 1), true, "")
		expectStatus(t, writePhase(t, repo, "plan"), 0, "a prohibition on its own id was denied")
	})
	unready := "# Fix — my-change\n\n## Case\n3 SPEC-WRONG\n\n## Requirement deltas\n- CHANGED REQ-USER-001 — now right\n"
	t.Run("denies implement over a fix brief whose CHANGED says no kind", func(t *testing.T) {
		repo := makeRepo(t, spec)
		writeChange(t, repo, unready, false, "")
		expectStatus(t, writePhase(t, repo, "implement"), 2, "implement was allowed over a CHANGED with no kind")
	})
	// The triage writes a fix's plan inside `spec` (ADR-033).
	t.Run("holds a fix brief to its spec-time checks even once its triage wrote the plan", func(t *testing.T) {
		repo := makeRepo(t, spec)
		writeChange(t, repo, unready, false, "")
		write(t, filepath.Join(repo, "specflow", "my-change", "plan.md"), "# Plan — my-change\n")
		expectStatus(t, writePhase(t, repo, "implement"), 2, "implement was allowed over a fix brief with a CHANGED of no kind, because it had a plan")
	})
	t.Run("allows leaving spec with a signed-off spec, and a fix brief without assumptions", func(t *testing.T) {
		repo := makeRepo(t, spec)
		writeChange(t, repo, signedSpec, true, "")
		writeChange(t, repo, "# Fix — a-fix\n\n## Case\n3 SPEC-WRONG\n\n## Requirement deltas\n- CHANGED REQ-USER-002 (correction) — now right\n", false, "a-fix")
		expectStatus(t, writePhase(t, repo, "plan"), 0, "a ready spec and a ready fix brief were denied")
	})
	t.Run("does not hold the change being signed off to another one already planned", func(t *testing.T) {
		repo := makeRepo(t, spec)
		writeChange(t, repo, strings.Replace(signedSpec, "## Assumptions\n- none\n\n", "", 1), true, "planned-before")
		write(t, filepath.Join(repo, "specflow", "planned-before", "plan.md"), "# Plan\n")
		writeChange(t, repo, signedSpec, true, "")
		expectStatus(t, writePhase(t, repo, "plan"), 0, "plan was denied over a change that already has a plan")
	})
	t.Run("does not hold a run already past spec to the assumptions rule", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{phase: "plan"})
		writeChange(t, repo, strings.Replace(signedSpec, "## Assumptions\n- none\n\n", "", 1), true, "")
		expectStatus(t, writePhase(t, repo, "review"), 0, "a run planned before the section existed was denied review")
	})
}
