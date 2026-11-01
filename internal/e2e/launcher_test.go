package e2e

// On a platform this engine ships no binary for, the launcher answers every
// hook with an error notice; the gate is the one a run cannot lose, so an
// armed one refuses the stop rather than letting it pass unjudged.

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestTheLauncherFailsAnArmedGateClosedWhereNoBinaryShips(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows runs bin/spec-flow.exe, not the launcher")
	}
	changedInPort(t, "the JavaScript engine had no launcher")
	fake := t.TempDir()
	write(t, filepath.Join(fake, "uname"), "#!/bin/sh\ncase $1 in -s) echo FreeBSD ;; -m) echo amd64 ;; esac\n")
	os.Chmod(filepath.Join(fake, "uname"), 0o755)
	env := func(repo string) []string {
		return []string{"PATH=" + fake + string(os.PathListSeparator) + os.Getenv("PATH"), "CLAUDE_PROJECT_DIR=" + repo}
	}
	launcher := filepath.Join(repoRoot, "bin", "spec-flow")
	stop := func(active bool) string {
		return toJSON(map[string]any{"hook_event_name": "Stop", "session_id": "s", "stop_hook_active": active})
	}

	repo := makeRepo(t, repoOpts{phase: "implement"})
	r := run(repo, env(repo), stop(false), launcher, "hook", "gate")
	if !r.Blocked() {
		t.Fatalf("an armed gate let the stop through on a platform with no binary (exit %d):\n%s", r.Status, r.Out())
	}
	mustMatch(t, `treat NOTHING as verified`, r.Reason(), "the refusal does not say nothing was judged")
	// Once per stop: refused again, the session would never end.
	if r := run(repo, env(repo), stop(true), launcher, "hook", "gate"); r.Blocked() {
		t.Fatal("the stop was refused again while the session continued for the first refusal")
	}
	idle := makeRepo(t, repoOpts{phase: "idle"})
	for _, h := range []string{"gate", "phase-guard"} {
		r := run(idle, env(idle), stop(false), launcher, "hook", h)
		if r.Blocked() || r.Status != 1 {
			t.Fatalf("hook %s with no run armed: exit %d, blocked %v; want the notice alone (exit 1)", h, r.Status, r.Blocked())
		}
		mustMatch(t, `ships no binary for FreeBSD amd64`, r.Stderr, "the notice does not name the platform")
	}
}
