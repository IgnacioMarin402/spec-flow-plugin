package e2e

// The live view carries its own copy of the readers the hooks use (a mod runs
// no binary's code). hooks/readers.golden.ts holds the answers: the engine's
// readers are held to it by a cargo test, hooks/live-view.test.tsx holds the
// TypeScript ones, and this holds `spec-flow lines`, which the view runs on a
// log one read cannot take, through the binary.

import (
	"encoding/json"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

type golden struct {
	LinesOf []struct {
		Text   string `json:"text"`
		Needle string `json:"needle"`
		Since  any    `json:"since"`
		Want   struct {
			N    int      `json:"n"`
			Last []string `json:"last"`
		} `json:"want"`
	} `json:"linesOf"`
}

func readGolden(t *testing.T) golden {
	t.Helper()
	text := read(filepath.Join(repoRoot, "hooks", "readers.golden.ts"))
	at := strings.Index(text, "export default ")
	if at == -1 {
		t.Fatal("hooks/readers.golden.ts holds no `export default` table")
	}
	var g golden
	if err := json.Unmarshal([]byte(text[at+len("export default "):]), &g); err != nil {
		t.Fatalf("hooks/readers.golden.ts: %v", err)
	}
	return g
}

func TestLinesAgreesWithTheLiveView(t *testing.T) {
	changedInPort(t, "`spec-flow lines` is this engine's")
	g := readGolden(t)
	if len(g.LinesOf) == 0 {
		t.Fatal("the golden table holds no linesOf case")
	}
	for _, c := range g.LinesOf {
		path := filepath.Join(t.TempDir(), "run-trace.log")
		write(t, path, c.Text)
		since := "-Infinity"
		if f, ok := c.Since.(float64); ok {
			since = strconv.FormatFloat(f, 'f', -1, 64)
		}
		r := run(repoRoot, nil, "", cliArgv(engineDir, "lines", path, since, c.Needle)...)
		want := strings.Join(append([]string{strconv.Itoa(c.Want.N)}, c.Want.Last...), "\n")
		if r.Status != 0 || r.Stdout != want {
			t.Errorf("spec-flow lines since %s needle %q = %q (exit %d), want %q", since, c.Needle, r.Stdout, r.Status, want)
		}
	}
}
