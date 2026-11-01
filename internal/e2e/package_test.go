package e2e

// The distribution is this repository: the plugin is a copy of a commit, and
// a terminal or CI runs a clone's bin/spec-flow (ADR-051). A clone carries
// what is COMMITTED and nothing else — so this runs the clone, never this
// tree: a binary missing from HEAD, built from other source, or committed
// without its executable bit fails here and nowhere else.

import (
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

func TestACloneRunsAsItShips(t *testing.T) {
	changedInPort(t, "the JavaScript engine shipped through npm")
	if git(t, repoRoot, "status", "--porcelain", "--", "bin") != "" {
		t.Skip("bin/ has uncommitted changes: a clone would not carry them")
	}
	clone := filepath.Join(t.TempDir(), "spec-flow-plugin")
	git(t, repoRoot, "clone", "-q", "--no-hardlinks", repoRoot, clone)
	head := git(t, clone, "rev-parse", "--short=12", "HEAD")

	repo := makeRepo(t, repoOpts{})
	shipped := func(engine string, args ...string) Result {
		return run(repo, []string{"CLAUDE_PROJECT_DIR="}, "", append([]string{filepath.Join(engine, "bin", "spec-flow")}, args...)...)
	}
	r := shipped(clone, "check")
	if r.Status != 0 {
		t.Fatalf("the clone's spec-flow check failed:\n%s", r.Out())
	}
	// The plugin stamps `engine=` into every gate line (ADR-018): the clone names its commit.
	mustMatch(t, `(?m)^engine `+head+`$`, r.Out(), "the clone did not name its own commit")
	for _, sub := range []string{"trace", "stats", "status", "resume", "models"} {
		if r := shipped(clone, sub); r.Status != 0 && sub != "trace" || regexp.MustCompile(`panic:|goroutine \d`).MatchString(r.Out()) {
			t.Errorf("spec-flow %s from the clone: exit %d\n%s", sub, r.Status, r.Out())
		}
	}

	// A marketplace copy has no `.git` and is named for its commit.
	cache := filepath.Join(t.TempDir(), "spec-flow", head)
	if err := copyTree(clone, cache); err != nil {
		t.Fatal(err)
	}
	os.RemoveAll(filepath.Join(cache, ".git"))
	r = shipped(cache, "check")
	if r.Status != 0 {
		t.Fatalf("a copy with no .git failed:\n%s", r.Out())
	}
	mustMatch(t, `(?m)^engine `+head+`$`, r.Out(), "a marketplace copy did not name the commit its directory is named for")
}
