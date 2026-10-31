package repocheck

// ModelPins holds that every agent routes to a model TIER and nothing this
// plugin ships names a model VERSION (ADR-013). The order matters: finding NO
// agents is a failure, because a check that only forbids a token reports a
// directory it never reached exactly as it reports a clean one. Then no
// shipped file names a version, in an id or in prose: the frontmatter is what
// Claude Code obeys, the prose is what the model reads.
//
// `decisions/` is not scanned: a record claims a moment, and ADR-013 has to
// name the dated id it removed to say what changed.

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/IgnacioMarin402/spec-flow-plugin/internal/agents"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/jsre"
)

// InheritsEffort are the agents that take the human's session effort, each
// with the reason. An agent missing here AND declaring no effort fails: that
// is indistinguishable from nobody having considered it (ADR-015).
var InheritsEffort = map[string]string{
	"implementer": "the milestone decides the work, and its difficulty is the plan's claim rather than this file's — a human who dials their session up for a hard feature should reach the code that feature needs",
}

// Where routing is described. `hooks`, `cmd` and `internal` route nothing,
// but a version reaches prose through whichever file nobody thought to scan.
var (
	ModelPinDirs  = []string{"agents", "modes", "commands", "hooks", "cmd", "internal", "skills", ".claude/skills"}
	ModelPinExts  = []string{".go", ".md", ".json", ".ts", ".tsx"}
	ModelPinFiles = []string{"README.md", "REFERENCE.md", "CLAUDE.md", "BACKLOG.md", ".github/workflows/ci.yml"}
)

const modelPinSelf = "internal/repocheck/modelpins.go"

var versioned = []struct {
	re    *jsre.RE
	label string
}{
	// Anchored on the vendor prefix, so the bare alias ADR-013 requires never matches.
	{jsre.MustCompile(`\bclaude-(opus|sonnet|haiku|fable)[\w.-]*`, "i"), "a pinned model id"},
	// The lookbehind keeps this off the tail of a full id, which the pattern
	// above owns: a pin is reported once, under one label.
	{jsre.MustCompile(`(?<!claude-)\b(opus|sonnet|haiku|fable)[ -]\d`, "i"), "a tier with a version number"},
}

var (
	modelLine  = regexp.MustCompile(`(?m)^model:[ \t]*(\S+)`)
	descLine   = regexp.MustCompile(`(?m)^description:[ \t]*(.+)$`)
	effortLine = regexp.MustCompile(`(?m)^effort:[ \t]*(\S+)`)
)

func frontmatter(text string) (string, bool) {
	if !strings.HasPrefix(text, "---") {
		return "", false
	}
	end := strings.Index(text[3:], "\n---")
	if end == -1 {
		return "", false
	}
	return text[3 : 3+end], true
}

func ModelPins(root string) Report {
	r := Report{Name: "model-pins", Advice: "An agent names the tier its job needs and lets the harness resolve the current model of that tier. A version belongs in decisions/, where a record claims a moment. See ADR-013."}
	files := mdIn(root, "agents")
	if len(files) == 0 {
		r.Problems = append(r.Problems, "no agent files were found under agents/. That is a failure rather than a clean run: this check would otherwise report a directory it cannot see exactly as it reports one with nothing wrong in it.")
	}
	var routing []string
	for _, file := range files {
		head, ok := frontmatter(readRel(root, "agents/"+file))
		if !ok {
			r.Problems = append(r.Problems, fmt.Sprintf("agents/%s has no frontmatter block, so Claude Code registers no agent for it at all.", file))
			continue
		}
		m := modelLine.FindStringSubmatch(head)
		if m == nil {
			r.Problems = append(r.Problems, fmt.Sprintf("agents/%s declares no `model:`. An omitted model means `inherit` — the agent silently runs on whatever the main session is using, so a cheap pass can run on the most expensive model and nothing says so.", file))
			continue
		}
		declared := m[1]
		if !contains(agents.Aliases, declared) {
			r.Problems = append(r.Problems, fmt.Sprintf("agents/%s routes to `%s`, which is not one of the tier aliases (%s). A pinned id freezes this agent on one model as the tiers move past it — see ADR-013.", file, declared, strings.Join(agents.Aliases, ", ")))
			continue
		}
		// Presence, not exclusivity: naming another tier as well is ordinary.
		desc := ""
		if d := descLine.FindStringSubmatch(head); d != nil {
			desc = d[1]
		}
		if !regexp.MustCompile(`(?i)\b` + declared + `\b`).MatchString(desc) {
			r.Problems = append(r.Problems, fmt.Sprintf("agents/%s routes to `%s` and its `description` never says so. The description is what the orchestrator reads to know what a spawn costs, so a frontmatter re-route that stops there is invisible at exactly the moment the routing is chosen.", file, declared))
			continue
		}
		name := strings.TrimSuffix(file, ".md")
		effort, hasEffort := "", false
		if e := effortLine.FindStringSubmatch(head); e != nil {
			effort, hasEffort = e[1], true
		}
		_, inherits := InheritsEffort[name]
		switch {
		case hasEffort && !contains(agents.EffortLevels, effort):
			r.Problems = append(r.Problems, fmt.Sprintf("agents/%s declares `effort: %s`, which is not one of %s. Nothing downstream will complain: a spawn discards an effort it cannot read, so a typo here is a setting that looks applied and is not — see ADR-015.", file, effort, strings.Join(agents.EffortLevels, ", ")))
			continue
		case !hasEffort && !inherits:
			r.Problems = append(r.Problems, fmt.Sprintf("agents/%s declares no `effort:` and is not listed in InheritsEffort in %s. An agent with no effort inherits the human's session, so the flow's cost stops being a property of the flow — a cheap pass runs at `max` whenever someone's session is. Declare one, or record there why this agent should follow the session, so the asymmetry is a decision rather than the one nobody got to.", file, modelPinSelf))
			continue
		case hasEffort && inherits:
			r.Problems = append(r.Problems, fmt.Sprintf("agents/%s declares `effort: %s` while InheritsEffort in %s still says it should follow the session. One of the two is stale, and the file that loses is whichever nobody re-read.", file, effort, modelPinSelf))
			continue
		}
		if !hasEffort {
			effort = "inherited from the session"
		}
		routing = append(routing, fmt.Sprintf("%s -> %s, effort %s", name, declared, effort))
	}
	scanned := surfaces(root, ModelPinDirs, ModelPinExts, ModelPinFiles, modelPinSelf)
	for _, f := range scanned {
		for i, line := range strings.Split(readRel(root, f), "\n") {
			for _, v := range versioned {
				if v.re.Test(line) {
					r.Problems = append(r.Problems, fmt.Sprintf("%s:%d  %s\n    %s", f, i+1, v.label, strings.TrimSpace(line)))
				}
			}
		}
	}
	r.OK = fmt.Sprintf("%d file(s) name no version; %d agent(s) route by tier.\n  %s", len(scanned), len(routing), strings.Join(routing, "\n  "))
	return r
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}
