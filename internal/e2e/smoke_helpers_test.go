package e2e

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// repoOpts is the throwaway repository a case runs in.
type repoOpts struct {
	phase        string
	noContract   bool
	noGit        bool
	commitPhase  bool
	noCommit     bool
	contractEdit func(map[string]any)
}

func smokeContract(edit func(map[string]any)) string {
	c := map[string]any{
		"contract_version": 1,
		"verify": map[string]any{
			"scope_globs":      []any{"*.ts"},
			"lint":             toAny(toolCmd("exit=0")),
			"lint_no_fix":      toAny(toolCmd("exit=0")),
			"test":             toAny(toolCmd("exit=0")),
			"test_name":        "ftest",
			"lint_name":        "flint",
			"lint_config_hint": "f.config",
		},
		"trace": map[string]any{
			"specs_dir":        "specs",
			"proof_dir":        "tests",
			"proof_suffix":     ".spec.ts",
			"executed_tests":   toAny(toolCmd("exit=0")),
			"not_a_capability": []any{},
		},
		"extra_checks": []any{},
		"unscoped_denied": map[string]any{
			"scripts":            []any{"test", "lint"},
			"tools":              []any{"eslint", "ftest"},
			"scoped_allowed":     []any{"check"},
			"scoped_alternative": "npm run check",
			"scoped_examples":    []any{"npm run check"},
		},
	}
	if edit != nil {
		edit(c)
	}
	return toJSON(c)
}

func toAny(s []string) []any {
	out := make([]any, len(s))
	for i, v := range s {
		out[i] = v
	}
	return out
}

// writeRun writes the contract and the phase under dir: what a run arms on.
func writeRun(t *testing.T, dir, phase string, edit func(map[string]any)) {
	t.Helper()
	write(t, filepath.Join(dir, ".spec-flow", "config.json"), smokeContract(edit))
	write(t, filepath.Join(dir, ".claude", "state", "phase"), phase)
}

// initRepo is `git init` and one commit on main, so a merge-base exists.
func initRepo(t *testing.T, dir string, commitPhase, commit bool) {
	t.Helper()
	gitQuiet(dir, "init", "-q", ".")
	gitQuiet(dir, "symbolic-ref", "HEAD", "refs/heads/main")
	gitQuiet(dir, "config", "user.email", "smoke@example.com")
	gitQuiet(dir, "config", "user.name", "smoke")
	gitQuiet(dir, "config", "core.autocrlf", "false")
	if commit {
		gitQuiet(dir, "commit", "-q", "--allow-empty", "-m", "baseline")
	}
	// The shape a repository the user did not write can arrive in (ADR-017).
	if commitPhase {
		gitQuiet(dir, "add", "-f", "--", ".claude/state/phase")
		gitQuiet(dir, "commit", "-q", "-m", "a phase this repository committed")
	}
}

func makeRepo(t *testing.T, o repoOpts) string {
	t.Helper()
	repo := t.TempDir()
	if o.phase == "" {
		o.phase = "implement"
	}
	_ = os.MkdirAll(filepath.Join(repo, "specflow"), 0o755)
	if o.noContract {
		write(t, filepath.Join(repo, ".claude", "state", "phase"), o.phase)
	} else {
		writeRun(t, repo, o.phase, o.contractEdit)
	}
	if !o.noGit {
		initRepo(t, repo, o.commitPhase, !o.noCommit)
	}
	return repo
}

func statePath(repo, name string) string { return filepath.Join(repo, ".claude", "state", name) }

func phaseOf(repo string) string { return read(statePath(repo, "phase")) }

func setPhase(t *testing.T, repo, phase string) { write(t, statePath(repo, "phase"), phase) }

func counterOf(repo, name string) string {
	v := strings.TrimSpace(read(statePath(repo, name)))
	if v == "" {
		return "0"
	}
	return v
}

func traceText(repo string) string { return read(statePath(repo, "run-trace.log")) }

// editContract rewrites repo's contract through edit.
func editContract(t *testing.T, repo string, edit func(map[string]any)) {
	t.Helper()
	path := filepath.Join(repo, ".spec-flow", "config.json")
	var c map[string]any
	if err := json.Unmarshal([]byte(read(path)), &c); err != nil {
		t.Fatal(err)
	}
	edit(c)
	write(t, path, toJSON(c))
}

func sub(m map[string]any, k string) map[string]any { return m[k].(map[string]any) }

func expectStatus(t *testing.T, r Result, want int, why string) {
	t.Helper()
	if r.Status != want {
		t.Fatalf("%s: exit %d, want %d\nstdout: %s\nstderr: %s", why, r.Status, want, r.Stdout, r.Stderr)
	}
}

func mustMatch(t *testing.T, pattern, text, why string) {
	t.Helper()
	if !regexp.MustCompile(pattern).MatchString(text) {
		t.Fatalf("%s: no %q in:\n%s", why, pattern, text)
	}
}

func mustNotMatch(t *testing.T, pattern, text, why string) {
	t.Helper()
	if regexp.MustCompile(pattern).MatchString(text) {
		t.Fatalf("%s: %q found in:\n%s", why, pattern, text)
	}
}

// subagentStop is a SubagentStop payload as Claude Code 2.1.283 delivers it.
func subagentStop(extra map[string]any) map[string]any {
	p := map[string]any{"hook_event_name": "SubagentStop", "session_id": "spawner-session", "agent_id": "a0123456789abcdef", "agent_type": "spec-flow:reviewer"}
	for k, v := range extra {
		p[k] = v
	}
	return p
}
