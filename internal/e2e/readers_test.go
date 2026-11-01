package e2e

// The live view carries its own copy of the readers the hooks use (a mod runs
// no binary's code). hooks/readers.golden.ts holds the answers; this holds
// the Go readers to them, and hooks/live-view.test.tsx the TypeScript ones.

import (
	"encoding/json"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/IgnacioMarin402/spec-flow-plugin/internal/agentblocks"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/agents"
	enginecli "github.com/IgnacioMarin402/spec-flow-plugin/internal/cli"
)

type golden struct {
	MaxBlocks int `json:"maxBlocks"`
	Keep      int `json:"keep"`
	Budgets   map[string]struct {
		Key      string `json:"key"`
		Fallback int    `json:"fallback"`
		Counter  string `json:"counter"`
	} `json:"budgets"`
	ParseReturn []struct {
		Text string `json:"text"`
		Want *struct {
			Status string            `json:"status"`
			Fields map[string]string `json:"fields"`
		} `json:"want"`
	} `json:"parseReturn"`
	ProjectConfig []struct {
		Text     string         `json:"text"`
		Settings map[string]any `json:"settings"`
		Problem  string         `json:"problem"`
	} `json:"projectConfig"`
	BudgetCap []struct {
		Text string `json:"text"`
		Role string `json:"role"`
		Want *int   `json:"want"`
	} `json:"budgetCap"`
	MilestoneRef []struct {
		Prompt any `json:"prompt"`
		Want   *struct {
			Change    string `json:"change"`
			Milestone string `json:"milestone"`
		} `json:"want"`
	} `json:"milestoneRef"`
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

func TestGoReadersAgreeWithTheLiveViews(t *testing.T) {
	changedInPort(t, "the readers' Go copies are this engine's")
	g := readGolden(t)
	if agentblocks.MaxBlocks != g.MaxBlocks || enginecli.Keep != g.Keep {
		t.Errorf("MaxBlocks %d, Keep %d; the table says %d, %d", agentblocks.MaxBlocks, enginecli.Keep, g.MaxBlocks, g.Keep)
	}
	for role, b := range g.Budgets {
		if got := agents.Budgets[role]; got.Key != b.Key || got.Fallback != b.Fallback || got.Counter != b.Counter {
			t.Errorf("budget %s: %+v, the table says %+v", role, got, b)
		}
	}
	if len(agents.Budgets) != len(g.Budgets) {
		t.Errorf("%d budgets, the table has %d", len(agents.Budgets), len(g.Budgets))
	}
	for _, c := range g.ParseReturn {
		got := agentblocks.ParseReturn(c.Text)
		switch {
		case c.Want == nil && got != nil, c.Want != nil && got == nil:
			t.Errorf("ParseReturn(%q) = %+v, want %+v", c.Text, got, c.Want)
		case c.Want != nil && (got.Status != c.Want.Status || !reflect.DeepEqual(got.Fields, c.Want.Fields) && len(got.Fields)+len(c.Want.Fields) > 0):
			t.Errorf("ParseReturn(%q) = %+v, want %+v", c.Text, got, c.Want)
		}
	}
	for _, c := range g.ProjectConfig {
		settings, problem := agents.ProjectConfig(c.Text)
		kind := ""
		if strings.Contains(problem, "does not parse") {
			kind = "parse"
		} else if problem != "" {
			kind = "object"
		}
		if kind != c.Problem || !reflect.DeepEqual(settings, c.Settings) && len(settings)+len(c.Settings) > 0 {
			t.Errorf("ProjectConfig(%q) = %v %q, want %v %q", c.Text, settings, problem, c.Settings, c.Problem)
		}
	}
	for _, c := range g.BudgetCap {
		want := -1
		if c.Want != nil {
			want = *c.Want
		}
		if got := agents.BudgetCap(c.Text, c.Role); got != want {
			t.Errorf("BudgetCap(%q, %s) = %d, want %d", c.Text, c.Role, got, want)
		}
	}
	for _, c := range g.MilestoneRef {
		change, milestone, ok := agents.MilestoneRef(c.Prompt)
		if ok != (c.Want != nil) || ok && (change != c.Want.Change || milestone != c.Want.Milestone) {
			t.Errorf("MilestoneRef(%v) = %q %q %v, want %+v", c.Prompt, change, milestone, ok, c.Want)
		}
	}
	// `spec-flow lines` is what the view runs on a log one read cannot take.
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
