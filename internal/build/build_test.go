package main

import (
	"bytes"
	"os"
	"path/filepath"
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
