package repocheck

// A scan prints a count and passes when it finds nothing, so one reaching
// the wrong files is indistinguishable from a clean repo. These cases hold
// each scan to every surface it claims, one surface per case so a failure
// names which. The surface lists are written out rather than read from the
// check: a fixture agreeing with the check would agree with a dropped
// directory too. Every banned token is assembled at runtime: this directory
// is one the checks scan.

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

func tree(t *testing.T, files map[string]string) string {
	t.Helper()
	root := t.TempDir()
	for rel, text := range files {
		p := filepath.Join(root, filepath.FromSlash(rel))
		os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func merged(ms ...map[string]string) map[string]string {
	out := map[string]string{}
	for _, m := range ms {
		for k, v := range m {
			out[k] = v
		}
	}
	return out
}

var okCount = regexp.MustCompile(`OK — (\d+) file\(s\)`)

func count(r Report) int {
	if len(r.Problems) > 0 {
		return -1
	}
	m := okCount.FindStringSubmatch(r.String())
	if m == nil {
		return -1
	}
	n, _ := strconv.Atoi(m[1])
	return n
}

func reported(t *testing.T, r Report, file string) {
	t.Helper()
	if len(r.Problems) == 0 {
		t.Fatalf("%s is not scanned: the check passed over it, which is what it reports for a clean repo.\n%s", file, r)
	}
	if !strings.Contains(r.String(), file) {
		t.Fatalf("reported a problem but not the file that carries it (%s).\n%s", file, r)
	}
}

func clean(t *testing.T, r Report, why string) {
	t.Helper()
	if len(r.Problems) > 0 {
		t.Fatalf("%s.\n%s", why, r)
	}
}

// ---- no-repo-refs ----------------------------------------------------------

var (
	framework    = strings.Join([]string{"Nest", "JS"}, "")
	couplingDirs = []string{"hooks", "cmd", "internal", "commands", "agents", "modes", ".claude/skills", "skills", "decisions", "evals"}
	couplingExts = []string{".go", ".md", ".json", ".ts", ".tsx", ".sh", ".yaml"}
	couplingDocs = []string{"README.md", "REFERENCE.md", "CLAUDE.md", "LICENSE", "BACKLOG.md", ".github/workflows/ci.yml", "bin/spec-flow"}
)

func TestNoRepoRefsReachesEverySurface(t *testing.T) {
	planted := "The engine is a " + framework + " plugin.\n"
	for _, d := range couplingDirs {
		reported(t, NoRepoRefs(tree(t, map[string]string{d + "/planted.md": planted})), d+"/planted.md")
	}
	for _, f := range couplingDocs {
		reported(t, NoRepoRefs(tree(t, map[string]string{f: planted})), f)
	}
	// Every other case plants a `.md`: an extension dropped from the list would go unseen.
	for _, e := range couplingExts {
		reported(t, NoRepoRefs(tree(t, map[string]string{"evals/planted" + e: planted})), "evals/planted"+e)
	}
	reported(t, NoRepoRefs(tree(t, map[string]string{"internal/lib/deep.md": planted})), "internal/lib/deep.md")
}

func TestNoRepoRefsBoundaries(t *testing.T) {
	planted := "The engine is a " + framework + " plugin.\n"
	clean(t, NoRepoRefs(tree(t, map[string]string{"evals/results/run/report.md": planted})), "evals/results/ was read, so a local eval run turns the check red over what a model wrote")
	r := NoRepoRefs(tree(t, map[string]string{noRepoSelf: planted}))
	clean(t, r, "the check reported itself for naming what it bans, so it can never be green")
	if count(r) != 0 {
		t.Fatalf("expected the only file present, the check itself, excluded: %s", r)
	}
	// SCAN_FILES exists to name the prose outside the extensions.
	clean(t, NoRepoRefs(tree(t, map[string]string{"hooks/notes.txt": planted})), "the walk read a .txt file")
	files := map[string]string{}
	for _, d := range couplingDirs {
		files[d+"/clean.md"] = "Nothing here names one repo.\n"
	}
	for _, f := range couplingDocs {
		files[f] = "Nothing here names one repo.\n"
	}
	if n, want := count(NoRepoRefs(tree(t, files))), len(couplingDirs)+len(couplingDocs); n != want {
		t.Fatalf("the check read %d file(s) where %d was the only correct answer: a count below the surfaces is what an unscanned directory looks like", n, want)
	}
}

// ---- model-pins ------------------------------------------------------------

var (
	pinnedID     = strings.Join([]string{"claude", "opus", "5"}, "-")
	numberedTier = strings.Join([]string{"Opus", "5"}, " ")
	pinDirs      = []string{"agents", "modes", "commands", "hooks", "cmd", "internal", "skills", ".claude/skills"}
	pinExts      = []string{".go", ".md", ".json", ".ts", ".tsx"}
	pinDocs      = []string{"README.md", "REFERENCE.md", "CLAUDE.md", "BACKLOG.md", ".github/workflows/ci.yml"}
)

// agent is a valid agent, so a case about the ban is not also failing the routing.
func agent(name, model, description string, effort *string) string {
	if model == "" {
		model = "sonnet"
	}
	if description == "" {
		description = "Does a job (" + model + ")."
	}
	line := "effort: medium\n"
	if effort != nil {
		line = ""
		if *effort != "" {
			line = "effort: " + *effort + "\n"
		}
	}
	return "---\nname: " + name + "\ndescription: " + description + "\nmodel: " + model + "\n" + line + "---\n\nBody.\n"
}

func none() *string          { s := ""; return &s }
func level(l string) *string { return &l }

// pins scans a tree holding files and, unless it opts out, a valid agent: an
// empty agents/ is itself a failure, which would mask every other case.
func pins(t *testing.T, files map[string]string, baseline bool) Report {
	if baseline {
		files = merged(map[string]string{"agents/base.md": agent("base", "", "", nil)}, files)
	}
	return ModelPins(tree(t, files))
}

func TestModelPinsReachesEverySurface(t *testing.T) {
	for _, d := range pinDirs {
		text := "Routes to " + pinnedID + ".\n"
		if d == "agents" {
			// A VALID agent, or the routing half would name the path for another reason.
			text = agent("planted", "sonnet", "Does a job (Sonnet), once "+pinnedID+".", nil)
		}
		r := pins(t, map[string]string{d + "/planted.md": text}, true)
		reported(t, r, d+"/planted.md")
		if !strings.Contains(r.String(), "a pinned model id") {
			t.Fatalf("reported a problem, but not the ban.\n%s", r)
		}
	}
	for _, f := range pinDocs {
		reported(t, pins(t, map[string]string{f: "The planner runs on " + numberedTier + ".\n"}, true), f)
	}
	for _, e := range pinExts {
		reported(t, pins(t, map[string]string{"hooks/planted" + e: "const model = '" + pinnedID + "';\n"}, true), "hooks/planted"+e)
	}
	reported(t, pins(t, map[string]string{"internal/lib/deep.md": "Routes to " + pinnedID + ".\n"}, true), "internal/lib/deep.md")
}

func TestModelPinsBoundaries(t *testing.T) {
	// A record claims a moment, and ADR-013 cannot say what changed without naming it.
	clean(t, pins(t, map[string]string{"decisions/012-a-record.md": "We removed " + pinnedID + " on this date.\n"}, true), "a record naming the id it retired was reported")
	// Without this the check could be green by forbidding the alias ADR-013 requires.
	clean(t, pins(t, map[string]string{"commands/route.md": "Routing: reviewer = haiku; implementer = sonnet; planner = opus. The Opus budget counts the last one.\n"}, true), "the bare aliases and tier words were reported")
	clean(t, pins(t, map[string]string{modelPinSelf: pinnedID + "\n"}, true), "the check reported itself")
	files := map[string]string{}
	for _, d := range pinDirs {
		files[d+"/clean.md"] = "Nothing here names a version.\n"
	}
	files["agents/clean.md"] = agent("clean", "", "", nil)
	for _, f := range pinDocs {
		files[f] = "Nothing here names a version.\n"
	}
	// One per surface, plus the baseline agent.
	if n, want := count(pins(t, files, true)), len(pinDirs)+len(pinDocs)+1; n != want {
		t.Fatalf("the check read %d file(s) where %d was the only correct answer", n, want)
	}
}

func TestModelPinsRouting(t *testing.T) {
	for _, c := range []struct {
		name     string
		files    map[string]string
		baseline bool
		says     string // "" when the tree must pass
	}{
		// The failure this check exists to close: a directory it never reached reads as clean.
		{"an agents/ directory the check cannot see is a failure, not a clean run", nil, false, "no agent files"},
		{"an agent pinned to a full model id is reported", map[string]string{"agents/pinned.md": "---\nname: pinned\ndescription: Does a job (Opus).\nmodel: " + pinnedID + "\n---\n\nBody.\n"}, true, "not one of the tier aliases"},
		// Omitting it means inherit: a cheap pass silently runs on the session's model.
		{"an agent declaring no model is reported", map[string]string{"agents/inherits.md": "---\nname: inherits\ndescription: Does a job.\n---\n\nBody.\n"}, true, "declares no"},
		{"an agent whose description contradicts its routing is reported", map[string]string{"agents/drifted.md": agent("drifted", "haiku", "Reviews the plan (Sonnet, read-only).", nil)}, true, "never says so"},
		// What is required is presence, not exclusivity.
		{"naming another agent's tier in a description is allowed", map[string]string{"agents/escalates.md": agent("escalates", "haiku", "Reviews the plan (Haiku). Escalates hard doubts to the Opus planner.", nil)}, true, ""},
		// Nothing reads a frontmatter effort back: these are all that stands between a typo and a setting that reads as applied.
		{"an effort level that does not exist is reported", map[string]string{"agents/typo.md": agent("typo", "sonnet", "Does a job (Sonnet).", level("hihg"))}, true, "not one of"},
		{"an agent that declares no effort and is not recorded as inheriting is reported", map[string]string{"agents/quiet.md": agent("quiet", "sonnet", "Does a job (Sonnet).", none())}, true, "InheritsEffort"},
		{"an agent recorded as inheriting may omit effort", map[string]string{"agents/implementer.md": agent("implementer", "sonnet", "Implements (Sonnet).", none())}, true, ""},
		{"an agent recorded as inheriting must not also declare an effort", map[string]string{"agents/implementer.md": agent("implementer", "sonnet", "Implements (Sonnet).", level("high"))}, true, "stale"},
	} {
		t.Run(c.name, func(t *testing.T) {
			r := pins(t, c.files, c.baseline)
			if c.says == "" {
				clean(t, r, "a correct tree was reported")
				return
			}
			if len(r.Problems) == 0 || !strings.Contains(r.String(), c.says) {
				t.Fatalf("want a problem saying %q.\n%s", c.says, r)
			}
		})
	}
	// Printing the routing is what makes an unread agents/ visible in CI output.
	r := pins(t, map[string]string{"agents/deep.md": agent("deep", "opus", "Advises (Opus).", nil)}, true)
	clean(t, r, "a clean tree was reported as pinned")
	if !strings.Contains(r.String(), "deep -> opus") || !strings.Contains(r.String(), "base -> sonnet") {
		t.Fatalf("the check passed without naming what each agent routes to.\n%s", r)
	}
}

// ---- plugin-paths: the state inventory and the mod's modules ---------------

// stateTable is a REFERENCE whose state table lists names, plus the baseline's.
func stateTable(names ...string) string {
	rows := []string{"## `.claude/state/`", "", "| file | what it holds |", "|---|---|"}
	for _, n := range append([]string{"base.log"}, names...) {
		rows = append(rows, "| `"+n+"` | x |")
	}
	return strings.Join(append(rows, "", "---", ""), "\n")
}

// paths scans a tree holding files plus a baseline that names `base.log`
// literally — an inventory finding no name is its own failure — and a
// manifest registering every hook the binary dispatches.
func paths(t *testing.T, files map[string]string, modules ...string) Report {
	var entries []string
	for _, h := range HookNames {
		entries = append(entries, `{"type":"command","command":"x","args":["hook","`+h+`"]}`)
	}
	mods := ""
	if len(modules) > 0 {
		mods = `,"modules":["` + strings.Join(modules, `","`) + `"]`
	}
	return PluginPaths(tree(t, merged(map[string]string{
		"internal/base/base.go": "package base\n\nfunc f(state string) { appendLine(filepath.Join(state, \"base.log\")) }\n",
		"REFERENCE.md":          stateTable(),
		"hooks/hooks.json":      `{"hooks":{"Stop":[{"hooks":[` + strings.Join(entries, ",") + `]}]}` + mods + `}`,
	}, files)))
}

func reportsState(t *testing.T, r Report, file, name string) {
	t.Helper()
	if !strings.Contains(r.String(), file+" names .claude/state/"+name) {
		t.Fatalf("expected %s reported for %s.\n%s", file, name, r)
	}
}

func TestStateInventory(t *testing.T) {
	// The shape internal/humanturn writes its log in: a constant another package exports.
	exported := map[string]string{
		"internal/lib/log.go":  "package lib\n\nconst Log = \"kept.log\"\n",
		"internal/writer/w.go": "package writer\n\nfunc f(root string) { appendLine(filepath.Join(hookio.StateDir(root), lib.Log)) }\n",
	}
	t.Run("a constant another package exports is followed to its literal", func(t *testing.T) {
		reportsState(t, paths(t, exported), "internal/writer/w.go", "kept.log")
	})
	t.Run("a constant the package binds at its top level is followed, from any of its files", func(t *testing.T) {
		reportsState(t, paths(t, map[string]string{
			"internal/reader/names.go": "package reader\n\nconst (\n\tlog = \"kept.log\"\n)\n",
			"internal/reader/r.go":     "package reader\n\nfunc f(root string) { read(filepath.Join(root, \".claude\", \"state\", log)) }\n",
		}), "internal/reader/r.go", "kept.log")
	})
	t.Run("a followed name with its row passes", func(t *testing.T) {
		clean(t, paths(t, merged(exported, map[string]string{"REFERENCE.md": stateTable("kept.log")})), "a listed name was reported")
	})
	// Each path goes through a parameter or a local: a scan that guessed would
	// take the name from a package it was never qualified with, or from a
	// constant inside another function, and report a name no path holds.
	t.Run("a parameter or a local is not guessed at", func(t *testing.T) {
		clean(t, paths(t, map[string]string{
			"internal/names/n.go":  "package names\n\nconst LOG = \"elsewhere.log\"\n",
			"internal/param/p.go":  "package param\n\nfunc read(LOG string) string { return readFile(filepath.Join(state, LOG)) }\n",
			"internal/scoped/s.go": "package scoped\n\nfunc f() string {\n\tconst LOG = \"inner.log\"\n\treturn LOG\n}\n\nfunc g(LOG string) string { return filepath.Join(state, LOG) }\n",
		}), "a name guessed from elsewhere was reported")
	})
	t.Run("a test file names no state the engine writes", func(t *testing.T) {
		clean(t, paths(t, map[string]string{"internal/base/base_test.go": "package base\n\nvar p = filepath.Join(state, \"fixture-only.log\")\n"}), "a test's own state name was reported")
	})
}

func TestModuleInventory(t *testing.T) {
	view := map[string]string{"hooks/view.tsx": "export const register = () => {}\n"}
	types := func(p string) map[string]string {
		return map[string]string{".claude-plugin/plugin.json": `{"name":"p","types":"` + p + `"}`}
	}
	flags := func(t *testing.T, r Report, text string) {
		t.Helper()
		if !strings.Contains(r.String(), text) {
			t.Fatalf("expected %q.\n%s", text, r)
		}
	}
	t.Run("a module hooks.json names and the package does not ship is reported", func(t *testing.T) {
		flags(t, paths(t, nil, "./view.tsx"), "names the module hooks/view.tsx")
	})
	t.Run("a module that ships and hooks.json never names is reported", func(t *testing.T) {
		flags(t, paths(t, view), "hooks/view.tsx exists but")
	})
	t.Run("a types contract the manifest names and the package does not ship is reported", func(t *testing.T) {
		flags(t, paths(t, merged(view, types("./hooks/view-state.d.ts")), "./view.tsx"), "names the types contract")
	})
	t.Run("a module and its contract, shipped and named, pass", func(t *testing.T) {
		clean(t, paths(t, merged(view, map[string]string{"hooks/view.test.tsx": "", "hooks/view-state.d.ts": ""}, types("./hooks/view-state.d.ts")), "./view.tsx"), "a shipped, named module was reported")
	})
}

func TestHookInventory(t *testing.T) {
	r := PluginPaths(tree(t, map[string]string{"hooks/hooks.json": `{"hooks":{"Stop":[{"hooks":[{"command":"x","args":["hook","nonesuch"]}]}]}}`}))
	if !strings.Contains(r.String(), "registers `hook nonesuch`, which the binary does not dispatch") {
		t.Fatalf("a manifest entry for a hook the binary lacks passed.\n%s", r)
	}
	if !strings.Contains(r.String(), "dispatches `hook gate` and hooks.json never registers it") {
		t.Fatalf("a hook the binary dispatches and the manifest never registers passed.\n%s", r)
	}
	r = PluginPaths(tree(t, map[string]string{"commands/run.md": "Run `${CLAUDE_PLUGIN_ROOT}/bin/nonesuch`.\n"}))
	if !strings.Contains(r.String(), "commands/run.md:1  bin/nonesuch does not exist in this package") {
		t.Fatalf("a call site naming a path the package does not ship passed.\n%s", r)
	}
}
