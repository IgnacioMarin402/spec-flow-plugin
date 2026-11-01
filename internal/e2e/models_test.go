package e2e

// `spec-flow models`' failure mode is not crashing but being confidently
// wrong: a run that never found the project's config prints tidy rows saying
// "plugin default", exactly like a repo that configured nothing. So these
// cases are about attribution — and one holds the report to naming no model
// for a tier nothing pinned (ADR-013).

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/IgnacioMarin402/spec-flow-plugin/internal/agents"
)

// Model ids are assembled, never spelled: the model-pins check scans this file.
var (
	vendor       = strings.Join([]string{"claude", ""}, "-")
	pinnedSonnet = strings.Join([]string{vendor + "sonnet", "4", "9"}, "-")
	pinnedOpus   = strings.Join([]string{vendor + "opus", "4", "8"}, "-")
)

// aDirectory is a folder where a file should be: there, and no read of it succeeds.
const aDirectory = "\x00dir"

var shippedNames = []string{"architect", "implementer", "planner", "reviewer", "spec-writer"}

// models runs the report in a throwaway repository holding exactly files,
// with the ambient routing environment cleared and env set over it.
func models(t *testing.T, files map[string]string, env ...string) Result {
	t.Helper()
	root := t.TempDir()
	os.MkdirAll(filepath.Join(root, ".claude"), 0o755)
	for rel, text := range files {
		if text == aDirectory {
			os.MkdirAll(filepath.Join(root, rel), 0o755)
		} else {
			write(t, filepath.Join(root, rel), text)
		}
	}
	clean := []string{"CLAUDE_CODE_EFFORT_LEVEL="}
	for _, tier := range agents.Aliases {
		clean = append(clean, "ANTHROPIC_DEFAULT_"+strings.ToUpper(tier)+"_MODEL=")
	}
	return run(root, append(clean, env...), "", cliArgv(engineDir, "models")...)
}

// row is one agent's row, whitespace collapsed.
func row(out, agent string) string {
	re := regexp.MustCompile(`^\s+` + regexp.QuoteMeta(agent) + `\s`)
	for _, l := range strings.Split(out, "\n") {
		if re.MatchString(l) {
			return strings.Join(strings.Fields(l), " ")
		}
	}
	return ""
}

func TestModels(t *testing.T) {
	t.Parallel()
	agents.AgentsDir = func() string { return filepath.Join(engineDir, "agents") }
	// The reviewer as this repo ships it, read rather than restated.
	reviewer := agents.Shipped()["reviewer"]
	elsewhere := ""
	for _, tier := range []string{"haiku", "sonnet", "opus"} {
		if tier != reviewer.Model {
			elsewhere = tier
			break
		}
	}
	if reviewer.Effort == "" {
		t.Fatal("the reviewer declares no effort, and the effort cases need an agent that does: point them at one")
	}
	ok := func(t *testing.T, r Result) {
		t.Helper()
		expectStatus(t, r, 0, "the report failed")
	}
	routing := func(v string) map[string]string { return map[string]string{".claude/spec-flow.config.json": v} }
	for _, c := range []struct {
		name  string
		files map[string]string
		env   []string
		check func(t *testing.T, r Result)
	}{
		{"a repo that configured nothing gets every agent, all on the shipped default", nil, nil, func(t *testing.T, r Result) {
			ok(t, r)
			for _, a := range shippedNames {
				if rw := row(r.Out(), a); !strings.Contains(rw, "plugin default") {
					t.Fatalf("%s was not attributed to the plugin: %q\n%s", a, rw, r.Out())
				}
			}
			wantAll(t, r.Out(), "Nothing is re-routed")
		}},
		// Rows only: the header prints the repo's path.
		{"with nothing pinned, no agent row names a model", nil, nil, func(t *testing.T, r Result) {
			for _, a := range shippedNames {
				if rw := row(r.Out(), a); strings.Contains(rw, vendor) {
					t.Fatalf("named a concrete model for a tier nothing pinned: %s", rw)
				}
			}
		}},
		{"a re-route is attributed to the project, and says what it replaced", routing(toJSON(map[string]any{"agents": map[string]string{"reviewer": elsewhere}})), nil, func(t *testing.T, r Result) {
			ok(t, r)
			rw := row(r.Out(), "reviewer")
			if !strings.Contains(rw, elsewhere) || !strings.Contains(rw, "project") || !strings.Contains(rw, "was "+reviewer.Model) {
				t.Fatalf("the re-route: %s", rw)
			}
			wantAll(t, r.Out(), "1 agent(s) re-routed")
		}},
		{"restating the shipped default is not reported as a re-route", routing(`{"agents":{"planner":"opus"}}`), nil, func(t *testing.T, r Result) {
			ok(t, r)
			wantAll(t, row(r.Out(), "planner"), "restates the default")
			wantAll(t, r.Out(), "Nothing is re-routed")
		}},
		{"a routing block that cannot be applied exits non-zero and names the entry", routing(`{"agents":{"reviwer":"sonnet"}}`), nil, func(t *testing.T, r Result) {
			if r.Status == 0 {
				t.Fatalf("a repo whose every spec-flow spawn is being denied got a clean report:\n%s", r.Out())
			}
			wantAll(t, r.Out(), "reviwer")
		}},
		{"a tier pinned in settings.json is credited to that file", map[string]string{".claude/settings.json": toJSON(map[string]any{"env": map[string]string{"ANTHROPIC_DEFAULT_SONNET_MODEL": pinnedSonnet}})}, nil, func(t *testing.T, r Result) {
			ok(t, r)
			wantAll(t, row(r.Out(), "implementer"), pinnedSonnet, "settings.json")
			wantAll(t, row(r.Out(), "architect"), "unpinned")
		}},
		{"settings.local.json wins over settings.json", map[string]string{
			".claude/settings.json":       toJSON(map[string]any{"env": map[string]string{"ANTHROPIC_DEFAULT_OPUS_MODEL": pinnedSonnet}}),
			".claude/settings.local.json": toJSON(map[string]any{"env": map[string]string{"ANTHROPIC_DEFAULT_OPUS_MODEL": pinnedOpus}})}, nil, func(t *testing.T, r Result) {
			wantAll(t, row(r.Out(), "planner"), pinnedOpus, "settings.local.json")
		}},
		{"a real environment variable wins over both files", map[string]string{".claude/settings.json": toJSON(map[string]any{"env": map[string]string{"ANTHROPIC_DEFAULT_OPUS_MODEL": pinnedSonnet}})},
			[]string{"ANTHROPIC_DEFAULT_OPUS_MODEL=" + pinnedOpus}, func(t *testing.T, r Result) {
				wantAll(t, row(r.Out(), "planner"), pinnedOpus, "the environment")
			}},
		// ---- effort: the one layer with no project override to report
		{"an agent that declares its own effort is reported as the one deciding it", nil, nil, func(t *testing.T, r Result) {
			ok(t, r)
			wantAll(t, row(r.Out(), "reviewer"), reviewer.Effort+" (agent)")
			wantAll(t, row(r.Out(), "implementer"), "your session")
		}},
		{"a session effortLevel is reported for the agents that inherit, and not for the ones that do not", map[string]string{".claude/settings.json": `{"effortLevel":"xhigh"}`}, nil, func(t *testing.T, r Result) {
			ok(t, r)
			wantAll(t, row(r.Out(), "implementer"), "xhigh (session)")
			wantAll(t, row(r.Out(), "reviewer"), reviewer.Effort+" (agent)")
		}},
		// It beats the frontmatter, a spawn's effort and the session's (2.1.294).
		{"CLAUDE_CODE_EFFORT_LEVEL in the environment is reported as deciding every agent", nil, []string{"CLAUDE_CODE_EFFORT_LEVEL=max"}, func(t *testing.T, r Result) {
			ok(t, r)
			for _, a := range []string{"reviewer", "implementer"} {
				wantAll(t, row(r.Out(), a), "max (CLAUDE_CODE_EFFORT_LEVEL, the environment)")
			}
			wantAll(t, r.Out(), "CLAUDE_CODE_EFFORT_LEVEL is set")
		}},
		{"CLAUDE_CODE_EFFORT_LEVEL in a settings env block is reported with that file as its source", map[string]string{".claude/settings.json": `{"effortLevel":"xhigh","env":{"CLAUDE_CODE_EFFORT_LEVEL":"medium"}}`}, nil, func(t *testing.T, r Result) {
			ok(t, r)
			wantAll(t, row(r.Out(), "implementer"), "medium (CLAUDE_CODE_EFFORT_LEVEL, .claude/settings.json)")
		}},
		{"a CLAUDE_CODE_EFFORT_LEVEL that is not a level is not reported as deciding", nil, []string{"CLAUDE_CODE_EFFORT_LEVEL=bogus"}, func(t *testing.T, r Result) {
			ok(t, r)
			wantAll(t, row(r.Out(), "reviewer"), reviewer.Effort+" (agent)")
			wantAll(t, r.Out(), "is not an effort level")
		}},
		// In a table about which layer decided what, a shifted column reads as a misattributed row.
		{"every column stays aligned when a heading is longer than its values", nil, nil, func(t *testing.T, r Result) {
			lines := strings.Split(r.Out(), "\n")
			for i, header := range lines {
				if !strings.Contains(header, "AGENT") || !strings.Contains(header, "EFFORT") || i+1 >= len(lines) {
					continue
				}
				first := lines[i+1]
				for heading, value := range map[string]string{"TIER DECIDED BY": "plugin default", "EFFORT": "high"} {
					if strings.Index(header, heading) != strings.Index(first, value) {
						t.Fatalf("%q does not start under %q.\n%s\n%s", value, heading, header, first)
					}
				}
				return
			}
			t.Fatalf("no header row:\n%s", r.Out())
		}},
		// One reading of the file: a byte-order mark is not part of it, here as in the hook.
		{"a routing written after a byte-order mark is reported as the hook applies it", routing("\xef\xbb\xbf" + toJSON(map[string]any{"agents": map[string]string{"reviewer": elsewhere}})), nil, func(t *testing.T, r Result) {
			ok(t, r)
			wantAll(t, row(r.Out(), "reviewer"), elsewhere, "project")
		}},
		{"a file the run start refuses exits non-zero and says why: JSON", routing(`{ "agents": { "reviewer": "sonnet" }, }`), nil, func(t *testing.T, r Result) {
			if r.Status == 0 {
				t.Fatalf("a file no run starts with got exit 0:\n%s", r.Out())
			}
			wantAll(t, r.Out(), "does not parse as JSON")
		}},
		{"a file the run start refuses exits non-zero and says why: a budget", routing(`{"max_architect_calls":"three"}`), nil, func(t *testing.T, r Result) {
			if r.Status == 0 {
				t.Fatalf("a file no run starts with got exit 0:\n%s", r.Out())
			}
			wantAll(t, r.Out(), "max_architect_calls")
		}},
		{"a settings file that cannot be read exits non-zero and says why", routing(aDirectory), nil, func(t *testing.T, r Result) {
			if r.Status == 0 {
				t.Fatalf("exit 0:\n%s", r.Out())
			}
			wantAll(t, r.Out(), "could not be read")
			mustNotMatch(t, `\n\s+at |goroutine \d`, r.Out(), "it crashed instead of saying why")
		}},
		// An unparseable settings file is Claude Code's to complain about.
		{"a settings file that is not valid JSON does not take the report down", map[string]string{".claude/settings.json": "{ not json"}, nil, func(t *testing.T, r Result) {
			ok(t, r)
			if row(r.Out(), "planner") == "" {
				t.Fatalf("the report came back empty:\n%s", r.Out())
			}
		}},
	} {
		c := c
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			c.check(t, models(t, c.files, c.env...))
		})
	}
}
