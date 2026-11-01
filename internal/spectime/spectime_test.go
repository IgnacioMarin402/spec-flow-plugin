package spectime

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// A file under the archive is no change: a live change named like it would be
// refused over a clash with nothing the fold could land in.
func TestArchivedSlugsAreFolders(t *testing.T) {
	root := t.TempDir()
	os.MkdirAll(filepath.Join(root, "specflow", "archive", "add-users"), 0o755)
	os.WriteFile(filepath.Join(root, "specflow", "archive", "fix-login"), []byte("a file, not a change\n"), 0o644)
	if got := ArchivedSlugs(root); !reflect.DeepEqual(got, []string{"add-users"}) {
		t.Fatalf("got %q", got)
	}
}
