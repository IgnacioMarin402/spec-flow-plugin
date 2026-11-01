package main

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// The binaries every session runs are the ones committed, and nothing else
// ties them to the source beside them: rebuilt here, each must be the
// committed file byte for byte. A source change without `go run
// ./internal/build` fails this, and so does a binary edited by hand.
func TestBinariesAreThisSource(t *testing.T) {
	if testing.Short() {
		t.Skip("rebuilds every platform's binary")
	}
	root, _ := filepath.Abs("../..")
	out := t.TempDir()
	if err := build(root, out); err != nil {
		t.Fatal(err)
	}
	for _, target := range targets {
		committed, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(target.out)))
		if err != nil {
			t.Errorf("%s is not committed: run `go run ./internal/build`", target.out)
			continue
		}
		built, _ := os.ReadFile(filepath.Join(out, filepath.FromSlash(target.out)))
		if !bytes.Equal(committed, built) {
			t.Errorf("%s is not what this source builds: run `go run ./internal/build` and commit the result", target.out)
		}
	}
}

// The launcher is a script every hook runs, reviewed as text; a binary is
// never converted or diffed. Attributes are read last line first, so an order
// slip quietly hides the launcher's diffs.
func TestTheLauncherIsTextAndTheBinariesAreNot(t *testing.T) {
	root, _ := filepath.Abs("../..")
	attr := func(path string) string {
		out, err := exec.Command("git", "-C", root, "check-attr", "text", "eol", "diff", "--", path).Output()
		if err != nil {
			t.Skip("not a git checkout")
		}
		return string(out)
	}
	if got := attr("bin/spec-flow"); !strings.Contains(got, "text: set") || !strings.Contains(got, "eol: lf") || !strings.Contains(got, "diff: set") {
		t.Errorf("bin/spec-flow is not LF text with diffs:\n%s", got)
	}
	for _, target := range targets {
		if got := attr(target.out); !strings.Contains(got, "text: unset") || !strings.Contains(got, "diff: unset") {
			t.Errorf("%s may be converted or diffed:\n%s", target.out, got)
		}
	}
}
