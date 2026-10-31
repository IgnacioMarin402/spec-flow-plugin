// Package hooks is every hook this plugin registers, one function each, run
// as `spec-flow hook <name>`. Every hook fails open on a crash except the
// gate, whose crash would allow a stop it never judged.
package hooks

import (
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/IgnacioMarin402/spec-flow-plugin/internal/agents"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/hookio"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/humanturn"
)

// Hook is one registered hook.
type Hook struct {
	Main    func(*hookio.Ctx)
	OnError func(*hookio.Ctx, any)
}

// All are the hooks by the name hooks.json runs them under.
var All = map[string]Hook{
	"agent-gate":         {Main: AgentGate},
	"arm-gate":           {Main: ArmGate},
	"dispatch-guard":     {Main: DispatchGuard},
	"gate":               {Main: Gate, OnError: gateFailClosed},
	"human-turn":         {Main: HumanTurn},
	"lint-on-write":      {Main: LintOnWrite},
	"model-route":        {Main: ModelRoute},
	"no-gate-cmds":       {Main: NoGateCmds},
	"opus-budget":        {Main: OpusBudget},
	"orchestrator-scope": {Main: OrchestratorScope},
	"phase-guard":        {Main: PhaseGuard},
	"preflight":          {Main: Preflight},
	"register-agent":     {Main: RegisterAgent},
	"run-trace":          {Main: RunTrace},
	"session-start":      {Main: SessionStart},
	"stale-resume":       {Main: StaleResume},
	"token-trace":        {Main: TokenTrace},
}

var promptTag = regexp.MustCompile(`^\s*<([\w-]+)`)

// HumanTurn — Stop, UserPromptSubmit and PostToolUse on AskUserQuestion —
// records when the turn ends and when a prompt or an answer arrives, for the
// case 3 check (ADR-036). Never what was said. A prompt opening with a tag is
// what the harness delivers and is recorded under the tag's name;
// `<pasted_content>` is a person. Only where the engine was adopted: the
// prompt that starts a run arrives before its phase is written.
func HumanTurn(c *hookio.Ctx) {
	root := hookio.ProjectDir()
	if !hookio.Exists(filepath.Join(root, ".spec-flow", "config.json")) {
		return
	}
	p := c.Payload()
	line := ""
	switch hookio.JSString(p["hook_event_name"]) {
	case "Stop":
		line = "turn-end"
	case "PostToolUse":
		if p["tool_name"] == "AskUserQuestion" {
			line = "prompt from=question"
		}
	case "UserPromptSubmit":
		from := "human"
		if m := promptTag.FindStringSubmatch(hookio.JSString(p["prompt"])); m != nil && m[1] != "pasted_content" {
			from = m[1]
		}
		line = "prompt from=" + from
	}
	if line != "" {
		hookio.AppendLine(filepath.Join(hookio.StateDir(root), humanturn.Log), hookio.NowISO()+" "+line)
	}
}

const staleHours = 6

// SessionStart resets a phase a dead run left behind. A run in progress
// rewrites the phase on every step, so only an abandoned one is old. Every
// phase that arms anything is reset — preflight arms on all of them, and an
// abandoned `plan` would refuse every spawn in the repository. `blocked` too:
// a wait nobody touched for hours is one nobody is coming back to.
func SessionStart(c *hookio.Ctx) {
	c.Payload()
	root := hookio.ProjectDir()
	phaseFile := hookio.PhasePath(root)
	st, err := os.Stat(phaseFile)
	if err != nil {
		return
	}
	// ReadPhase, never the owner check: this hook's subject is a phase whose
	// owner is gone. A committed phase reads as none and is left alone.
	phase := hookio.ReadPhase(root)
	if !hookio.IsRunPhase(phase) {
		return
	}
	age := time.Since(st.ModTime()).Hours()
	if age < staleHours {
		return
	}
	state := hookio.StateDir(root)
	hookio.WriteFile(phaseFile, "idle")
	hookio.WriteFile(filepath.Join(state, "gate_attempts"), "0")
	// The seal names a session never coming back; left, it would stand every
	// later session down.
	hookio.ReleasePhase(root)
	// The position arms nothing, so it is kept: "start over" becomes "this run
	// was at Mk, and its plan is still on disk".
	at := strings.Fields(hookio.ReadFileOrDefault(filepath.Join(state, "current-milestone"), ""))
	msg := fmt.Sprintf("[spec-flow] Phase was '%s' and untouched for %dh, so it was treated as an abandoned run and reset to 'idle'. The lint/test gate is disarmed.", phase, int(math.Floor(age)))
	if len(at) >= 2 {
		msg += fmt.Sprintf(` That run was implementing %s of "%s"; its plan is still at specflow/%s/, and specflow/%s/milestones/%s.md is where it stopped.`, at[1], at[0], at[0], at[0], at[1])
	}
	msg += " To pick it up rather than start over, run /spec-flow:resume — it reads where the run stopped off disk."
	fmt.Fprintln(c.Stdout, msg)
}

// StaleResume — PreToolUse on SendMessage — denies resuming one of this
// plugin's agents whose prompt cache has expired: the message would first
// re-send its whole context (ADR-025). Outside a run it stands down.
func StaleResume(c *hookio.Ctx) {
	if !hookio.IsRunPhase(hookio.ReadPhase(hookio.ProjectDir())) {
		return
	}
	cold := agents.ColdResume(c.Payload())
	if cold == nil {
		return
	}
	c.Fail(fmt.Sprintf("[spec-flow] not resuming %s %s: its last turn was %d minutes ago and its "+
		"prompt cache lasts %d, so this message would first re-send its whole ~%dk-token "+
		"context. Start a NEW %s with an Agent call instead: the same inputs its predecessor was given, plus what this "+
		"message says. The run's state is on disk, not in that agent's context (ADR-025).\n",
		cold.Agent, cold.To, int(math.Round(cold.AgeMin)), cold.TTLMin, int(math.Round(float64(cold.Context)/1000)), cold.Agent))
}

// ModelRoute — PreToolUse on a spawn — rewrites a spawn of this plugin's
// agents: the project's routing into its `model` (ADR-014), and
// `run_in_background: true` in an attended session (ADR-023). Both rewrites
// live here because each sibling hook is handed the ORIGINAL input. No
// permissionDecision: a hook that picks a model has no business answering
// that. Not gated on the phase: routing is the project's standing answer.
func ModelRoute(c *hookio.Ctx) {
	p := c.Payload()
	input := hookio.Obj(p["tool_input"])
	shipped := agents.ShippedRouting()
	if len(shipped) == 0 {
		return
	}
	names := make([]string, 0, len(shipped))
	for n := range shipped {
		names = append(names, n)
	}
	agent := agents.MatchAgent(agents.NameishFields(input), names)
	if agent == "" {
		return // another plugin's agent, or the harness's: untouched
	}
	root := hookio.ProjectDir()
	model, source, problems := agents.ResolveModel(root, agent, shipped)
	if len(problems) > 0 {
		c.Fail("[spec-flow] the model routing in .claude/spec-flow.config.json cannot be applied:\n\n  - " + strings.Join(problems, "\n  - ") +
			"\n\nFix the file, or remove its \"agents\" block to fall back to the routing this plugin ships. " +
			"This is a denial rather than a shrug because a routing block that reads as though it works and " +
			"routes nothing is the failure this engine exists to close.\n")
	}
	reRouted := source == "project" && model != ""
	if reRouted {
		def := shipped[agent]
		if def == "" {
			def = "none"
		}
		hookio.AppendUnique(filepath.Join(hookio.StateDir(root), "model-routes.log"), fmt.Sprintf("%s -> %s (project override; shipped default is %s)", agent, model, def))
	}
	// `claude -p` terminates background agents 600 s after its turn ends, and
	// runs hooks with CLAUDE_CODE_SESSION_ATTENDED=0 (ADR-023).
	attended := os.Getenv("CLAUDE_CODE_SESSION_ATTENDED") != "0"
	if !reRouted && !attended {
		return
	}
	updated := map[string]any{}
	for k, v := range input {
		updated[k] = v
	}
	if reRouted {
		updated["model"] = model
	}
	if attended {
		updated["run_in_background"] = true
	}
	fmt.Fprint(c.Stdout, hookio.Marshal(map[string]any{"hookSpecificOutput": map[string]any{"hookEventName": "PreToolUse", "updatedInput": updated}}))
}

var (
	sessionIDRe = regexp.MustCompile(`^[0-9a-f]{16,32}$`) // observed ids: 17 hex chars
	labeledID   = regexp.MustCompile(`(?i)(?:agent[_ ]?id|session[_ ]?id|session|agent|id|name)[^0-9a-f]{0,5}([0-9a-f]{16,32})\b`)
	failureWord = regexp.MustCompile(`(?i)\b(error|failed|failure|exception|traceback)\b`)
	bareHex     = regexp.MustCompile(`\b[0-9a-f]{16,32}\b`)
)

// RegisterAgent — PostToolUse on a spawn — records which session id belongs
// to which agent: the request names the type and the response the id, and a
// later SendMessage carries only the id. Phase-independent, so an architect
// spawned just before the phase flips is still charged; but a repository with
// no phase never ran this engine and is left alone. Fails open.
func RegisterAgent(c *hookio.Ctx) {
	root := hookio.ProjectDir()
	p := c.Payload()
	input := hookio.Obj(p["tool_input"])
	var typeFields []string
	for _, k := range []string{"subagent_type", "subagentType", "agent_type"} {
		if s, ok := input[k].(string); ok {
			typeFields = append(typeFields, s)
		}
	}
	agent := agents.MatchAgent(typeFields, []string{"planner", "architect", "implementer"})
	if agent == "" || hookio.ReadPhase(root) == "" {
		return
	}
	state := hookio.StateDir(root)
	res := hookio.Nullish(p["tool_response"], p["tool_result"], p["tool_output"], p["response"], p["output"])
	if res == nil {
		res = map[string]any{}
	}
	id := ""
	if m, ok := res.(map[string]any); ok {
		for _, k := range []string{"agent_id", "agentId", "session_id", "sessionId", "agentSessionId", "id", "name"} {
			if s, ok := m[k].(string); ok && sessionIDRe.MatchString(s) {
				id = s
				break
			}
		}
	}
	if id == "" {
		// The bare match is the weakest link — any hex run wins, an MD5 in an
		// error message included — so it is skipped on a failure: a wrong id
		// attributes a LATER SendMessage to the wrong agent.
		text, isStr := res.(string)
		if !isStr {
			text = hookio.Marshal(res)
		}
		if m := labeledID.FindStringSubmatch(text); m != nil {
			id = m[1]
		} else if !failureWord.MatchString(text) {
			id = bareHex.FindString(text)
		}
	}
	// The run's resumable position: written from the SPAWN, by the one reading
	// of a work order. A SendMessage carries no milestone and must not blank it.
	if agent == "implementer" {
		if change, milestone, ok := agents.MilestoneRef(input["prompt"]); ok && change != "" {
			pos := change + " " + milestone
			if id != "" {
				pos += " " + id
			}
			hookio.WriteFile(filepath.Join(state, "current-milestone"), pos)
		}
	}
	if id != "" {
		hookio.AppendUnique(filepath.Join(state, "agent-registry"), id+" "+agent)
		return
	}
	keys := "\"" + typeName(res) + "\""
	if m, ok := res.(map[string]any); ok {
		keys = hookio.Marshal(hookio.Keys(m))
	}
	hookio.AppendUnique(filepath.Join(state, "register-agent-unmatched.log"), `{"payload_keys":`+hookio.Marshal(hookio.Keys(p))+`,"response_keys":`+keys+`}`)
}

func typeName(v any) string {
	switch v.(type) {
	case string:
		return "string"
	case bool:
		return "boolean"
	case nil:
		return "object"
	case []any:
		return "object"
	}
	return "number"
}
