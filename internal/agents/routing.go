// Package agents knows this plugin's agents: which tier each runs on and who
// decided it (ADR-014), the escalation budgets (ADR-038), who a spawn or a
// SendMessage is for, and what a stopped agent handed back.
package agents

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/IgnacioMarin402/spec-flow-plugin/internal/engine"
)

// Aliases are the tiers a spawn may be routed to — measured: a hook rewriting
// a spawn's `model` to a full id is refused as a schema error (ADR-014).
var Aliases = []string{"opus", "sonnet", "haiku", "fable"}

// EffortLevels a subagent's frontmatter may declare. Nothing here APPLIES
// one: the project routes a tier, not an effort (ADR-015).
var EffortLevels = []string{"low", "medium", "high", "xhigh", "max"}

// Agent is what a shipped agent's frontmatter declares; Effort `""` inherits the session's.
type Agent struct{ Model, Effort string }

var (
	nameField   = regexp.MustCompile(`(?m)^name:[ \t]*(\S+)`)
	modelField  = regexp.MustCompile(`(?m)^model:[ \t]*(\S+)`)
	effortField = regexp.MustCompile(`(?m)^effort:[ \t]*(\S+)`)
)

// AgentsDir is `<engine>/agents`, never the consuming repository's.
var AgentsDir = func() string { return filepath.Join(engine.Root(), "agents") }

// Shipped is what each shipped agent declares, read off the frontmatter
// Claude Code obeys — a second copy would be a claim about the routing. Empty
// when unreadable, which every caller treats as "no opinion".
func Shipped() map[string]Agent {
	agents := map[string]Agent{}
	entries, err := os.ReadDir(AgentsDir())
	if err != nil {
		return agents
	}
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		b, err := os.ReadFile(filepath.Join(AgentsDir(), e.Name()))
		if err != nil {
			continue
		}
		text := string(b)
		if !strings.HasPrefix(text, "---") {
			continue
		}
		end := strings.Index(text[3:], "\n---")
		if end == -1 {
			continue
		}
		head := text[3 : 3+end]
		name := strings.TrimSuffix(e.Name(), ".md")
		if m := nameField.FindStringSubmatch(head); m != nil {
			name = m[1]
		}
		model := modelField.FindStringSubmatch(head)
		if model == nil {
			continue
		}
		a := Agent{Model: model[1]}
		if m := effortField.FindStringSubmatch(head); m != nil {
			a.Effort = m[1]
		}
		agents[strings.ToLower(name)] = a
	}
	return agents
}

// Roles are the shipped agents' names, sorted.
func Roles() []string {
	shipped := Shipped()
	names := make([]string, 0, len(shipped))
	for n := range shipped {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

// ShippedRouting is agent name -> tier.
func ShippedRouting() map[string]string {
	out := map[string]string{}
	for n, a := range Shipped() {
		out[n] = a.Model
	}
	return out
}

// ProjectConfigPath is `.claude/spec-flow.config.json`: run-scoped settings,
// not the architectural contract — a cost knob there would move
// `contract_version` for every adopter.
func ProjectConfigPath(root string) string {
	return filepath.Join(root, ".claude", "spec-flow.config.json")
}

// ProjectConfig is that file's settings read the one way every reader reads
// them — the caps, the routing, the run-start check and the live view
// (ADR-047). An empty file has none and no problem; one that does not parse,
// or is not an object, has none and says why. A BOM is not part of the JSON.
func ProjectConfig(text string) (settings map[string]any, problem string) {
	text = strings.TrimPrefix(text, "\xef\xbb\xbf")
	if strings.TrimSpace(text) == "" {
		return map[string]any{}, ""
	}
	var v any
	if err := json.Unmarshal([]byte(text), &v); err != nil {
		return map[string]any{}, fmt.Sprintf("does not parse as JSON (%v), so none of its settings apply", err)
	}
	m, ok := v.(map[string]any)
	if !ok {
		return map[string]any{}, "is not a JSON object, so none of its settings apply"
	}
	return m, ""
}

// ProjectRouting is the project's overrides, plus everything wrong with them.
// Problems are returned, not swallowed: a typo'd agent name reads as though it
// routes something and routes nothing, forever. A file that does not parse
// routes nothing, as it caps nothing.
func ProjectRouting(root string, shipped map[string]string) (routing map[string]string, problems []string) {
	routing = map[string]string{}
	b, err := os.ReadFile(ProjectConfigPath(root))
	if err != nil {
		return routing, nil
	}
	settings, _ := ProjectConfig(string(b))
	declared, present := settings["agents"]
	if !present {
		return routing, nil
	}
	m, ok := declared.(map[string]any)
	if !ok {
		return routing, []string{`"agents" is not an object mapping an agent name to a tier, so nothing in it can be applied.`}
	}
	known := make([]string, 0, len(shipped))
	for n := range shipped {
		known = append(known, n)
	}
	sort.Strings(known)
	names := make([]string, 0, len(m))
	for n := range m {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, raw := range names {
		tier := m[raw]
		name := strings.ToLower(raw)
		if len(known) > 0 && !contains(known, name) {
			problems = append(problems, fmt.Sprintf(`"agents": { "%s": ... } names no agent this plugin ships (%s). `, raw, strings.Join(known, ", "))+
				"A name nothing matches routes nothing, and reads exactly like a routing that works.")
			continue
		}
		t, ok := tier.(string)
		if !ok || !contains(Aliases, t) {
			problems = append(problems, fmt.Sprintf(`"agents": { "%s": %s } is not one of %s. `, raw, jsonText(tier), strings.Join(Aliases, ", "))+
				"A spawn only accepts a tier — a full model id is refused by the tool call itself.")
			continue
		}
		routing[name] = t
	}
	return routing, problems
}

func jsonText(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// ResolveModel is the tier agent will run on and who decided it. `project`
// only when the override differs from the shipped default: restating the
// default is not a re-route.
func ResolveModel(root, agent string, shipped map[string]string) (model, source string, problems []string) {
	name := strings.ToLower(agent)
	routing, problems := ProjectRouting(root, shipped)
	fallback := shipped[name]
	if override := routing[name]; override != "" && override != fallback {
		return override, "project", problems
	}
	return fallback, "default", problems
}
