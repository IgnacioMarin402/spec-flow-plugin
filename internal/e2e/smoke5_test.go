package e2e

import (
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const unreadyBrief = "# Fix — my-change\n\n## Case\n3 SPEC-WRONG\n\n## Requirement deltas\n- CHANGED REQ-USER-001 — now right\n"

func engageImplementer(t *testing.T, repo string) Result {
	t.Helper()
	return runHook(t, "arm-gate", map[string]any{"session_id": "s", "tool_name": "Agent", "tool_input": map[string]any{"subagent_type": "implementer", "prompt": "specflow/my-change/plan.md specflow/my-change/milestones/M1.md"}}, repo)
}

// arm-gate writes `implement` itself, and that write never passed phase-guard.
func TestArmGateFromSpec(t *testing.T) {
	t.Run("does not carry a brief out of spec that phase-guard would hold there", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{phase: "spec"})
		writeChange(t, repo, unreadyBrief, false, "")
		write(t, filepath.Join(repo, "specflow", "my-change", "plan.md"), "# Plan — my-change\n")
		r := engageImplementer(t, repo)
		if p := phaseOf(repo); p != "spec" {
			t.Fatalf("engaging the implementer moved the phase to %q over a CHANGED with no kind", p)
		}
		expectStatus(t, r, 2, "the implementer was engaged over a brief that is not ready")
		mustMatch(t, `CHANGED`, r.Stderr, "the denial does not name the problem")
		mustMatch(t, `spec-writer`, r.Stderr, "the denial does not route it")
	})
	// Guard: the backstop still holds when the orchestrator forgets the write.
	t.Run("still arms from spec over a brief that is ready", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{phase: "spec"})
		writeChange(t, repo, strings.Replace(unreadyBrief, "REQ-USER-001 —", "REQ-USER-001 (correction) —", 1), false, "")
		write(t, filepath.Join(repo, "specflow", "my-change", "plan.md"), "# Plan — my-change\n")
		expectStatus(t, engageImplementer(t, repo), 0, "a ready brief was denied")
		if p := phaseOf(repo); p != "implement" {
			t.Fatalf("phase is %q — the implementer would run with the gate disarmed", p)
		}
	})
}

func TestPhaseGuardMisc(t *testing.T) {
	t.Run("denies blocked from anything but the gate", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		expectStatus(t, runHook(t, "phase-guard", map[string]any{"tool_name": "Write", "tool_input": map[string]any{"file_path": ".claude/state/phase", "content": "blocked"}}, repo), 2, "a tool wrote blocked")
	})
	t.Run("ignores an unrelated command", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		write(t, filepath.Join(repo, "specflow", "my-change", ".keep"), "")
		expectStatus(t, runHook(t, "phase-guard", bash("git status"), repo), 0, "an unrelated command")
	})
}

func lintMarker(repo string) []string {
	return toolCmd("write=" + filepath.Join(repo, "LINTER-RAN") + "=x")
}

func TestLintOnWrite(t *testing.T) {
	t.Run("ignores an out-of-scope file", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		expectStatus(t, runHook(t, "lint-on-write", map[string]any{"tool_input": map[string]any{"file_path": "README.md"}}, repo), 0, "lint-on-write")
	})
	t.Run("is transparent outside implement", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{phase: "idle"})
		expectStatus(t, runHook(t, "lint-on-write", map[string]any{"tool_input": map[string]any{"file_path": "example/thing.ts"}}, repo), 0, "lint-on-write")
	})
	// The linter leaves evidence: one that exits 0 silently looks the same as one never run.
	t.Run("runs the linter when the phase came from a run", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		editContract(t, repo, func(c map[string]any) { sub(c, "verify")["lint_no_fix"] = toAny(lintMarker(repo)) })
		write(t, filepath.Join(repo, "thing.ts"), "export const a = 1;\n")
		expectStatus(t, runHook(t, "lint-on-write", map[string]any{"tool_input": map[string]any{"file_path": filepath.Join(repo, "thing.ts")}}, repo), 0, "lint-on-write")
		if !exists(filepath.Join(repo, "LINTER-RAN")) {
			t.Fatal("the linter never ran on an in-scope write mid-implement")
		}
	})
}

// Fix (a): `scope_globs` are git pathspecs, from the repository root, for the
// write-time readers as for the gate. Fails on the JavaScript engine: it
// matched `lib/*.ts` against the absolute path Claude Code sends, so the
// linter never ran on `lib/a/b.ts` and the write was never traced, while the
// gate linted that same file.
func TestScopeGlobsAreReadAsTheGateReadsThem(t *testing.T) {
	scoped := func(t *testing.T, globs ...string) string {
		repo := makeRepo(t, repoOpts{})
		editContract(t, repo, func(c map[string]any) {
			sub(c, "verify")["scope_globs"] = toAny(globs)
			sub(c, "verify")["lint_no_fix"] = toAny(lintMarker(repo))
		})
		write(t, filepath.Join(repo, "lib", "a", "b.ts"), "export const a = 1;\n")
		return repo
	}
	write := func(repo string) map[string]any {
		return map[string]any{"tool_name": "Write", "tool_input": map[string]any{"file_path": filepath.Join(repo, "lib", "a", "b.ts")}}
	}
	for _, globs := range [][]string{{"lib/*.ts"}, {"lib"}, {"*.ts"}} {
		t.Run("lint-on-write runs under "+strings.Join(globs, ","), func(t *testing.T) {
			repo := scoped(t, globs...)
			runHook(t, "lint-on-write", write(repo), repo)
			if !exists(filepath.Join(repo, "LINTER-RAN")) {
				t.Fatalf("%v selects lib/a/b.ts for the gate and not for the write-time linter", globs)
			}
		})
		t.Run("run-trace traces the write under "+strings.Join(globs, ","), func(t *testing.T) {
			repo := scoped(t, globs...)
			runHook(t, "run-trace", write(repo), repo)
			mustMatch(t, `write file=.*lib[\\/]a[\\/]b\.ts`, traceText(repo), "the write was not traced")
		})
	}
	t.Run("a path outside the repository is in no scope", func(t *testing.T) {
		repo := scoped(t, "*.ts")
		elsewhere := filepath.Join(t.TempDir(), "x.ts")
		runHook(t, "lint-on-write", map[string]any{"tool_input": map[string]any{"file_path": elsewhere}}, repo)
		if exists(filepath.Join(repo, "LINTER-RAN")) {
			t.Fatal("a file outside the repository was linted")
		}
	})
}

// ---- ADR-017: whose state is this? ----------------------------------------

func TestACommittedPhaseArmsNothing(t *testing.T) {
	committed := repoOpts{commitPhase: true}
	t.Run("does not arm the whole-repo deny", func(t *testing.T) {
		repo := makeRepo(t, committed)
		expectStatus(t, runHook(t, "no-gate-cmds", bash("npm run test"), repo), 0, "a committed phase denied a command")
	})
	t.Run("does not arm the phase guard", func(t *testing.T) {
		repo := makeRepo(t, committed)
		expectStatus(t, runHook(t, "phase-guard", map[string]any{"tool_name": "Write", "tool_input": map[string]any{"file_path": ".claude/state/phase", "content": "triage"}}, repo), 0, "a committed phase denied a write")
	})
	t.Run("does not arm the write-time linter", func(t *testing.T) {
		repo := makeRepo(t, committed)
		editContract(t, repo, func(c map[string]any) { sub(c, "verify")["lint_no_fix"] = toAny(lintMarker(repo)) })
		write(t, filepath.Join(repo, "thing.ts"), "export const a = 1;\n")
		expectStatus(t, runHook(t, "lint-on-write", map[string]any{"tool_input": map[string]any{"file_path": filepath.Join(repo, "thing.ts")}}, repo), 0, "lint-on-write")
		if exists(filepath.Join(repo, "LINTER-RAN")) {
			t.Fatal("the repository's own argv ran off a phase git tracks")
		}
	})
	t.Run("is not flipped to implement by arm-gate", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{phase: "plan", commitPhase: true})
		expectStatus(t, runHook(t, "arm-gate", map[string]any{"tool_input": map[string]any{"subagent_type": "implementer"}}, repo), 0, "arm-gate")
		if p := phaseOf(repo); p != "plan" {
			t.Fatalf("arm-gate rewrote a tracked file: phase is now %q", p)
		}
	})
	t.Run("is left alone by session-start rather than dirtying the repo", func(t *testing.T) {
		repo := makeRepo(t, committed)
		age(t, statePath(repo, "phase"), 8*time.Hour)
		expectStatus(t, runHook(t, "session-start", map[string]any{}, repo), 0, "session-start")
		if phaseOf(repo) != "implement" {
			t.Fatal("session-start wrote over a file git tracks")
		}
		mustNotMatch(t, `state[\\/]phase`, git(t, repo, "status", "--porcelain"), "the repo is dirty on a tracked file it did not touch")
	})
}

var opusSpawn = map[string]any{"tool_name": "Task", "tool_input": map[string]any{"subagent_type": "planner"}}

func withSession(p map[string]any, session string) map[string]any {
	out := map[string]any{"session_id": session}
	for k, v := range p {
		out[k] = v
	}
	return out
}

// Only the gate and the budget ask about the seal; the rest fire inside
// subagents too (ADR-017).
func TestThePhaseSeal(t *testing.T) {
	t.Run("a phase sealed to another session does not spend that run's Opus budget", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		write(t, filepath.Join(repo, ".claude", "spec-flow.config.json"), `{"max_opus_calls":2}`)
		write(t, statePath(repo, "opus_calls"), "1")
		write(t, statePath(repo, "phase.session"), "session-a")
		expectStatus(t, runHook(t, "opus-budget", withSession(opusSpawn, "session-b"), repo), 0, "session B was denied against session A's budget")
		if n := read(statePath(repo, "opus_calls")); n != "1" {
			t.Fatalf("session B charged session A's budget: opus_calls is now %q", n)
		}
	})
	// The fail-closed rule: the owner is charged, and so is a payload naming nobody.
	t.Run("a phase sealed to this session still charges it, and so does one sealed to nobody", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		write(t, filepath.Join(repo, ".claude", "spec-flow.config.json"), `{"max_opus_calls":9}`)
		write(t, statePath(repo, "phase.session"), "session-a")
		runHook(t, "opus-budget", withSession(opusSpawn, "session-a"), repo)
		if read(statePath(repo, "opus_calls")) != "1" {
			t.Fatal("the owning session was not charged for its own spawn")
		}
		runHook(t, "opus-budget", opusSpawn, repo)
		if n := read(statePath(repo, "opus_calls")); n != "2" {
			t.Fatalf("a payload with no session_id was not charged (opus_calls %q) — the seal must fail CLOSED", n)
		}
	})
	t.Run("phase-guard seals the phase to the session whose write it allowed", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		expectStatus(t, runHook(t, "phase-guard", map[string]any{"session_id": "session-a", "tool_name": "Write", "tool_input": map[string]any{"file_path": ".claude/state/phase", "content": "implement"}}, repo), 0, "a legitimate phase write was denied")
		if s := read(statePath(repo, "phase.session")); s != "session-a" {
			t.Fatalf("the seal names %q", s)
		}
	})
	t.Run("phase-guard seals nothing when it denied the write", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		expectStatus(t, runHook(t, "phase-guard", map[string]any{"session_id": "session-a", "tool_name": "Write", "tool_input": map[string]any{"file_path": ".claude/state/phase", "content": "triage"}}, repo), 2, "an invented phase was allowed")
		if exists(statePath(repo, "phase.session")) {
			t.Fatal("a denied write claimed the phase")
		}
	})
}
