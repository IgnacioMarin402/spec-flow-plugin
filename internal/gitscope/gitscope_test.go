package gitscope

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// A git that answers in another language unless asked for `C`, as a localised
// installation does: the text match in AssertRepoRoot has to survive it.
func TestAssertRepoRootPinsGitsLanguage(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("a fake git on PATH needs an executable on Windows")
	}
	bin := t.TempDir()
	os.WriteFile(filepath.Join(bin, "git"), []byte("#!/bin/sh\nif [ \"$LC_ALL\" = \"C\" ]; then\n  echo \"fatal: not a git repository (or any of the parent directories): .git\" >&2\nelse\n"+
		"  echo \"fatal: no es un repositorio git (ni ninguno de los directorios superiores): .git\" >&2\nfi\nexit 128\n"), 0o755)
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("LC_ALL", "") // the pin has to come from the engine, not from this shell
	os.Unsetenv("LC_ALL")
	err := AssertRepoRoot(t.TempDir())
	if err == nil || !strings.Contains(err.Error(), "not inside a git repository") {
		t.Fatalf("got %v", err)
	}
}
