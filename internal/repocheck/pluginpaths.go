package repocheck

// PluginPaths holds every call site this package's prose and manifest make
// to it: a `${CLAUDE_PLUGIN_ROOT}/...` path a command, agent or skill tells
// the model to run, or hooks.json resolves, must ship. An instruction that
// names a path the package does not have silently does not run — the gate's
// failure, one layer up in the prose. Then the inventories, in both
// directions: the hooks the binary dispatches against hooks.json, the mod's
// modules (ADR-037), every state file the code names against REFERENCE's
// table, and every cross-doc anchor against the heading it names.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/IgnacioMarin402/spec-flow-plugin/internal/hooks"
)

// `skills` is the plugin-root directory, not `.claude/skills`: the first
// ships to adopters, and carries the same call sites a command does.
var (
	PathDirs = []string{"commands", "agents", "modes", "hooks", "skills"}
	PathExts = []string{".md", ".json"}
)

// HookNames are the hooks the binary dispatches: `spec-flow hook <name>`.
var HookNames = func() []string {
	names := make([]string, 0, len(hooks.All))
	for n := range hooks.All {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}()

var (
	// The trailing class stops at whatever markdown wrapped it.
	placeholder = regexp.MustCompile(`\$\{CLAUDE_PLUGIN_ROOT\}/([A-Za-z0-9._\-/]+)`)
	registered  = regexp.MustCompile(`"hook",\s*"([A-Za-z0-9._-]+)"`)
)

// The shapes the engine writes a state path in. The file name may be a
// constant bound to a literal at the top level of its package, or exported
// by the package it is qualified with. Anything else — a parameter, a local,
// a computed string — is not followed: what it holds would be a guess.
var (
	stateShapes = []*regexp.Regexp{
		regexp.MustCompile(`filepath\.Join\(\s*(?:state|(?:hookio\.)?StateDir\([^)]*\))\s*,\s*(?:"([^"]+)"|([A-Za-z_][\w.]*))\s*\)`),
		regexp.MustCompile(`"\.claude",\s*"state",\s*(?:"([^"]+)"|([A-Za-z_][\w.]*))`),
		regexp.MustCompile(`\.claude/state/([A-Za-z0-9_-][A-Za-z0-9_.-]*[A-Za-z0-9_-])`),
	}
	// Column 0 only, so a constant inside a function is never taken for a package's.
	topConst   = regexp.MustCompile(`(?m)^const\s+([A-Za-z_]\w*)\s*(?:\w+\s*)?=\s*"([^"\n]+)"`)
	constBlock = regexp.MustCompile(`(?ms)^const \((.*?)^\)`)
	blockConst = regexp.MustCompile(`(?m)^\s+([A-Za-z_]\w*)\s*(?:\w+\s*)?=\s*"([^"\n]+)"`)
	tableCode  = regexp.MustCompile("`([^`]+)`")
	docLink    = regexp.MustCompile(`\]\(([A-Za-z.]*\.md)?#([^)]+)\)`)
	notAnchor  = regexp.MustCompile(`[^a-z0-9 _-]`)
)

// packageConsts is name -> literal for every string constant declared at the
// top level of the Go package in root/dir.
func packageConsts(root, dir string) map[string]string {
	out := map[string]string{}
	entries, _ := os.ReadDir(filepath.Join(root, filepath.FromSlash(dir)))
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".go") || strings.HasSuffix(e.Name(), "_test.go") {
			continue
		}
		text := readRel(root, dir+"/"+e.Name())
		for _, m := range topConst.FindAllStringSubmatch(text, -1) {
			out[m[1]] = m[2]
		}
		for _, b := range constBlock.FindAllStringSubmatch(text, -1) {
			for _, m := range blockConst.FindAllStringSubmatch(b[1], -1) {
				out[m[1]] = m[2]
			}
		}
	}
	return out
}

// stateNames is each state file name the engine's Go source names, with the
// first file naming it.
func stateNames(root string) map[string]string {
	var sources []string
	for _, d := range []string{"cmd", "internal"} {
		for _, f := range walk(root, d, []string{".go"}, "internal/repocheck", "internal/e2e") {
			if !strings.HasSuffix(f, "_test.go") {
				sources = append(sources, f)
			}
		}
	}
	consts := map[string]map[string]string{}
	constsOf := func(dir string) map[string]string {
		if consts[dir] == nil {
			consts[dir] = packageConsts(root, dir)
		}
		return consts[dir]
	}
	names := map[string]string{}
	for _, f := range sources {
		text := readRel(root, f)
		dir := filepath.ToSlash(filepath.Dir(filepath.FromSlash(f)))
		for _, shape := range stateShapes {
			for _, m := range shape.FindAllStringSubmatch(text, -1) {
				name := m[1]
				if name == "" && len(m) > 2 && m[2] != "" {
					if pkg, id, qualified := strings.Cut(m[2], "."); qualified {
						name = constsOf("internal/" + pkg)[id]
					} else {
						name = constsOf(dir)[m[2]]
					}
				}
				if _, seen := names[name]; name != "" && !seen {
					names[name] = f
				}
			}
		}
	}
	return names
}

// stateRows are REFERENCE's `.claude/state/` table rows, as patterns.
func stateRows(reference string) []*regexp.Regexp {
	start := strings.Index(reference, "## `.claude/state/`")
	if start == -1 {
		return nil
	}
	table := reference[start:]
	if end := strings.Index(table, "\n---"); end != -1 {
		table = table[:end]
	}
	var covers []*regexp.Regexp
	for _, row := range strings.Split(table, "\n") {
		if !strings.HasPrefix(row, "| `") {
			continue
		}
		stem := ""
		for _, m := range tableCode.FindAllStringSubmatch(strings.Split(row, "|")[1], -1) {
			// `gate-failure.log` / `.full.log`: a token starting with a dot is
			// a sibling of the previous one, written short.
			name := m[1]
			if strings.HasPrefix(name, ".") {
				name = stem + name
			} else {
				stem = strings.TrimSuffix(name, filepath.Ext(name))
			}
			covers = append(covers, regexp.MustCompile(`^`+strings.ReplaceAll(regexp.QuoteMeta(name), `\*`, `.*`)+`$`))
		}
	}
	return covers
}

// anchorOf is GitHub's rule: lowercase, drop everything that is not a
// letter, digit, space, underscore or hyphen, then spaces to hyphens.
func anchorOf(heading string) string {
	h := strings.ToLower(strings.TrimSpace(strings.TrimLeft(heading, "#")))
	return strings.ReplaceAll(notAnchor.ReplaceAllString(h, ""), " ", "-")
}

func PluginPaths(root string) Report {
	r := Report{Name: "plugin-paths", Advice: "A command that names a path the package does not ship is an instruction that silently does not run, and a hook nothing registers is a guarantee nobody is keeping. Ship the file, or stop claiming it."}
	add := func(format string, a ...any) { r.Problems = append(r.Problems, fmt.Sprintf(format, a...)) }
	checked := 0
	for _, f := range surfaces(root, PathDirs, PathExts, nil, "") {
		for i, line := range strings.Split(readRel(root, f), "\n") {
			for _, m := range placeholder.FindAllStringSubmatch(line, -1) {
				checked++
				if !exists(root, m[1]) {
					add("%s:%d  %s does not exist in this package", f, i+1, m[1])
				}
			}
		}
	}

	// ---- the hooks, both directions: one the binary dispatches and the
	// manifest never registers ships and never fires; one the manifest
	// registers and the binary lacks is a guarantee it cannot keep.
	manifest := readRel(root, "hooks/hooks.json")
	inManifest := map[string]bool{}
	for _, m := range registered.FindAllStringSubmatch(manifest, -1) {
		inManifest[m[1]] = true
	}
	for _, h := range HookNames {
		if !inManifest[h] {
			add("the binary dispatches `hook %s` and hooks.json never registers it — it ships and never fires", h)
		}
	}
	for _, h := range sortedKeys(inManifest) {
		if !contains(HookNames, h) {
			add("hooks.json registers `hook %s`, which the binary does not dispatch", h)
		}
	}

	// ---- the mod's modules, both directions; a `*.test.tsx` is `claude plugin test`'s.
	var parsed struct {
		Modules []string `json:"modules"`
	}
	json.Unmarshal([]byte(manifest), &parsed)
	var modules []string
	for _, m := range parsed.Modules {
		modules = append(modules, strings.TrimPrefix(m, "./"))
	}
	entries, _ := os.ReadDir(filepath.Join(root, "hooks"))
	for _, e := range entries {
		if n := e.Name(); strings.HasSuffix(n, ".tsx") && !strings.HasSuffix(n, ".test.tsx") && !contains(modules, n) {
			add("hooks/%s exists but hooks.json never names it in modules — it ships and never loads", n)
		}
	}
	for _, m := range modules {
		if !exists(root, "hooks/"+m) {
			add("hooks.json names the module hooks/%s, which this package does not ship", m)
		}
	}
	// `types` is optional, and so is the manifest here: `claude plugin
	// validate` is what requires the manifest.
	var plugin struct {
		Types string `json:"types"`
	}
	if json.Unmarshal([]byte(readRel(root, ".claude-plugin/plugin.json")), &plugin) == nil && plugin.Types != "" && !exists(root, plugin.Types) {
		add(".claude-plugin/plugin.json names the types contract %s, which this package does not ship", plugin.Types)
	}

	// ---- every state file the code names has a row. Code to table only: the
	// table may describe a family (`*-unmatched.log`) the code builds by name.
	names := stateNames(root)
	covers := stateRows(readRel(root, "REFERENCE.md"))
	if len(names) == 0 || len(covers) == 0 {
		add("the .claude/state inventory found %d state file name(s) in the code and %d row name(s) in REFERENCE.md. One of the two stopped matching; a check that finds nothing passes forever.", len(names), len(covers))
	} else {
		for _, name := range sortedKeys(names) {
			covered := false
			for _, c := range covers {
				covered = covered || c.MatchString(name)
			}
			if !covered {
				add("%s names .claude/state/%s, which REFERENCE.md's `.claude/state/` table does not list.", names[name], name)
			}
		}
	}

	// ---- cross-doc anchors
	docs := []string{"README.md", "REFERENCE.md", "CLAUDE.md", "BACKLOG.md"}
	anchors := map[string]map[string]bool{}
	for _, d := range docs {
		if !exists(root, d) {
			continue
		}
		anchors[d] = map[string]bool{}
		for _, l := range strings.Split(readRel(root, d), "\n") {
			if strings.HasPrefix(l, "#") {
				anchors[d][anchorOf(l)] = true
			}
		}
	}
	anchorsChecked := 0
	for _, d := range docs {
		if anchors[d] == nil {
			continue
		}
		for _, m := range docLink.FindAllStringSubmatch(readRel(root, d), -1) {
			where := m[1]
			if where == "" {
				where = d
			}
			defined := anchors[where]
			if defined == nil {
				continue // a doc this check does not scan
			}
			anchorsChecked++
			if !defined[m[2]] {
				add("%s links to %s#%s, which names no heading there. A reader following it lands at the top of the page and has to hunt.", d, where, m[2])
			}
		}
	}
	r.OK = fmt.Sprintf("%d plugin-root path(s) referenced, all present; %d hook(s), each registered in hooks.json; %d module(s), each shipped and named; %d state file(s) named in the code, each listed in REFERENCE; %d cross-doc anchor(s), every one resolving.",
		checked, len(HookNames), len(modules), len(names), anchorsChecked)
	return r
}
