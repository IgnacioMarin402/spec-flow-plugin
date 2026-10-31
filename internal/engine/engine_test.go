package engine

// The `engine=` field of every gate-history line (ADR-018), for the shapes a
// real install arrives in: a checkout of its own, a marketplace copy with no
// `.git` named for its commit, and a copy with no `.git` inside someone
// else's repository.

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func commit(t *testing.T, dir string) string {
	t.Helper()
	for _, args := range [][]string{{"init", "-q", "."}, {"-c", "user.email=r@example.com", "-c", "user.name=r", "commit", "-q", "--allow-empty", "-m", "a revision"}} {
		if out, err := exec.Command("git", append([]string{"-C", dir}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	out, _ := exec.Command("git", "-C", dir, "rev-parse", "--short=12", "HEAD").Output()
	return strings.TrimSpace(string(out))
}

func TestRevision(t *testing.T) {
	t.Run("a checkout of its own reports its HEAD", func(t *testing.T) {
		engine := t.TempDir()
		if head := commit(t, engine); Revision(engine) != head {
			t.Fatalf("got %q, want %q", Revision(engine), head)
		}
	})
	// `plugins/cache/<marketplace>/<plugin>/<sha>/`
	t.Run("a marketplace copy with no .git reports the commit its directory is named for", func(t *testing.T) {
		dir := filepath.Join(t.TempDir(), "spec-flow", "1d7e03d21d4d")
		os.MkdirAll(dir, 0o755)
		if got := Revision(dir); got != "1d7e03d21d4d" {
			t.Fatalf("got %q", got)
		}
	})
	// A fallback is never mistaken for a revision.
	t.Run("a copy with no .git inside another repository does not report that repository", func(t *testing.T) {
		outer := t.TempDir()
		head := commit(t, outer)
		engine := filepath.Join(outer, "engine")
		os.MkdirAll(engine, 0o755)
		if got := Revision(engine); got == head || got != "v?" {
			t.Fatalf("got %q (the enclosing repository is %q)", got, head)
		}
	})
}
