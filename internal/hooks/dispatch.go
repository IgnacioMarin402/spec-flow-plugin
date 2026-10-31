package hooks

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/IgnacioMarin402/spec-flow-plugin/internal/agents"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/canrun"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/gitscope"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/hookio"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/humanturn"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/spectime"
)

// OpusBudget — PreToolUse on a spawn and on SendMessage — holds the flow's
// two escalation roles to their caps, one each: planner (`max_opus_calls`) and
// architect (`max_architect_calls`) (ADR-038). A budget the model must
// remember to count is not a budget. It counts roles, not models: what runs
// away is the escalation loop, whatever tier it sits on (ADR-014).
//
// A SendMessage counts too. An unrecognised recipient is allowed uncounted
// and leaves its field NAMES — never content — in opus-budget-unmatched.log.
// `max_opus_calls` keeps its name: a rename would read a configured cap as
// absent. Two inaccuracies err small and cannot disarm it: it counts the
// INTENT to spawn, and read-then-write is not atomic.
func OpusBudget(c *hookio.Ctx) {
	root := hookio.ProjectDir()
	// The owner check is safe here: only an orchestrating session spawns (ADR-017).
	p := c.Payload()
	phase := hookio.ReadOwnedPhase(root, hookio.JSString(p["session_id"]))
	if phase == "" || phase == "idle" || phase == "done" {
		return
	}
	state := hookio.StateDir(root)
	input := hookio.Obj(p["tool_input"])
	nameish := agents.NameishFields(input)
	agent := agents.MatchAgent(nameish, []string{"planner", "architect"})
	if agent == "" {
		// register-agent maps opaque ids back to the type they were spawned as.
		registry := map[string]string{}
		if text, ok := hookio.ReadText(filepath.Join(state, "agent-registry")); ok {
			for _, line := range strings.Split(text, "\n") {
				if f := strings.Fields(line); len(f) >= 2 {
					registry[f[0]] = f[1]
				}
			}
		}
		for _, v := range nameish {
			if t := registry[v]; t == "planner" || t == "architect" {
				agent = t
				break
			}
		}
	}
	if agent == "" {
		log := filepath.Join(state, "opus-budget-unmatched.log")
		if hookio.JSString(p["tool_name"]) == "SendMessage" {
			// Keys ONLY: values embed per-session ids, which would defeat the dedup.
			hookio.AppendUnique(log, `{"keys":`+hookio.Marshal(hookio.Keys(input))+`}`)
		} else {
			// Usually a cheap agent doing its job; a RENAMED Opus agent looks the same.
			shape := strings.Join(nameish, " ")
			if shape == "" {
				shape = strings.Join(hookio.Keys(input), ",")
			}
			hookio.AppendUnique(log, hookio.Marshal(map[string]string{"unmatched-spawn": shape}))
		}
		return
	}
	// A resume stale-resume denies is not a consult: its replacement is charged.
	if hookio.JSString(p["tool_name"]) == "SendMessage" && agents.ColdResume(p) != nil {
		return
	}
	budget := agents.Budgets[agent]
	countFile := filepath.Join(state, budget.Counter)
	max := agents.BudgetCap(hookio.ReadFileOrDefault(agents.ProjectConfigPath(root), ""), agent)
	if max < 0 {
		c.Fail(fmt.Sprintf("[spec-flow] %s in .claude/spec-flow.config.json is not a number of calls, so no count of %s calls can be held to it. "+
			"Do not spawn or message the %s. Tell the human: they set %s to a whole number (%d by default) or remove it.\n", budget.Key, agent, agent, budget.Key, budget.Fallback))
	}
	used := 0
	fmt.Sscan(hookio.ReadFileOrDefault(countFile, "0"), &used)
	if used >= max {
		c.Fail(fmt.Sprintf("[spec-flow] escalation budget exhausted: %d/%d calls to the %s this run.\n\n", used, max, agent) +
			fmt.Sprintf("Stop the loop. Do NOT spawn or message another %s. Summarize for the ", agent) +
			"human (HITL): which milestone is stuck, what the gate reported, and what you " +
			fmt.Sprintf("would ask the %s if you could. Then wait.\n\n", agent) +
			"If the run legitimately needs more, the human can raise " + budget.Key + " in " +
			".claude/spec-flow.config.json or reset the counter:\n" +
			"  printf '0' > .claude/state/" + budget.Counter + "\n")
	}
	hookio.WriteFile(countFile, fmt.Sprint(used+1))
}

var ownAgent = regexp.MustCompile(`(?i)^spec-flow:implementer$`)

// ArmGate — PreToolUse on a spawn and on SendMessage — arms the gate when the
// implementer is put to work: the event that makes the gate necessary is the
// one that arms it, as the gate writes `blocked` itself at its cap. The
// orchestrator still writes `implement`; this is the backstop. Its write must
// be one phase-guard would allow: out of `spec` it denies over a spec that
// fails (ADR-030, ADR-035). It alone denies engaging the implementer over an
// unanswered case 3, because it moves the phase and sibling hooks run in
// parallel (ADR-036). Outside a run it denies this flow's implementer
// (ADR-044); a person's own `implementer` is theirs.
func ArmGate(c *hookio.Ctx) {
	root := hookio.ProjectDir()
	// A phase the REPOSITORY committed is no run to advance (ADR-017).
	read := hookio.ReadPhase(root)
	if (read == "done" || read == "idle") && !hookio.StateIsTracked(root) {
		p := c.Payload()
		named := append(agents.NameishFields(hookio.Obj(p["tool_input"])), agents.RecipientType(p))
		own := false
		for _, t := range named {
			if ownAgent.MatchString(t) {
				own = true
			}
		}
		if !own {
			return
		}
		agents.RecordDispatch(root, p, read, "implementer", "deny", "no-run")
		c.Fail(fmt.Sprintf("[spec-flow] Denied: no run is in progress (phase '%s'), and the implementer works only inside one — its work order is a ", read) +
			"run's plan.md and milestone, and outside a run the gate, lint-on-write and the command deny stand down. To change code " +
			"now, run `/spec-fix <what is wrong>` (a weak test the fold named is its case 2), or `/spec-flow <feature>` for new behaviour (ADR-044).\n")
	}
	phase := read
	if phase == "" {
		phase = "idle"
	}
	if !hookio.IsRunPhase(phase) {
		return
	}
	p := c.Payload()
	agent := agents.MatchAgent(append(agents.NameishFields(hookio.Obj(p["tool_input"])), agents.RecipientType(p)), []string{"implementer"})
	if agent != "implementer" {
		return
	}
	// In every run phase: a re-triage inside `implement` can make a case 3,
	// and no phase write follows it (ADR-036).
	if unconfirmed := humanturn.Unconfirmed(root); len(unconfirmed) > 0 {
		agents.RecordDispatch(root, p, phase, agent, "deny", "case-3-unanswered")
		c.Fail("[spec-flow] Denied: " + humanturn.Denial(unconfirmed, "engaging the implementer") + "\n")
	}
	if phase == "implement" {
		return // already armed
	}
	if phase == "spec" {
		if found := spectime.LeavingSpec(root); len(found) > 0 {
			agents.RecordDispatch(root, p, phase, agent, "deny", "spec-not-ready")
			c.Fail("[spec-flow] Denied: engaging the implementer while the phase is 'spec' leaves spec, and the spec is not ready to build from:\n  - " +
				strings.Join(found, "\n  - ") + "\n\n" +
				"Hand these to a new spec-writer with specflow/<SLUG>/ (MODE=TRIAGE for a /spec-fix brief). Then write the next phase " +
				"yourself — phase-guard judges it — and engage the implementer (ADR-030).\n")
		}
	}
	agents.RecordDispatch(root, p, phase, agent, "armed", "phase")
	hookio.WriteFile(hookio.PhasePath(root), "implement")
	// This hook performs the transition, so it knows who drove it.
	hookio.ClaimPhase(root, hookio.JSString(p["session_id"]))
	// Informational, not a block: the call goes through, armed.
	fmt.Fprintf(c.Stderr, "[spec-flow] Phase was '%s' while the implementer was being engaged; armed the gate (phase -> implement). "+
		"The orchestrator should have written this itself — the hook is the backstop, not the protocol.\n", phase)
}

var (
	urlRe      = regexp.MustCompile(`\w+://\S+`)
	varPathRe  = regexp.MustCompile(`\$\{?\w+\}?/\S*`)
	namedPath  = regexp.MustCompile(`(?:^|[\s"'` + "`" + `(])((?:[A-Za-z]:)?(?:\./|/)?[\w.~-]+(?:/[\w.~-]+)+\.\w{1,8})\b`)
	planRef    = regexp.MustCompile(`specflow/([\w.-]+)/plan\.md`)
	msRef      = regexp.MustCompile(`specflow/([\w.-]+)/milestones/M\d+\.md`)
	driveStart = regexp.MustCompile(`^[A-Za-z]:`)
	ownName    = regexp.MustCompile(`(?i)^spec-flow:([a-z][a-z-]*)$`)
)

// Repository paths a prompt names, past URLs and `${CLAUDE_PLUGIN_ROOT}` paths.
func namedPaths(text, root string) []string {
	repo := strings.TrimSuffix(strings.ReplaceAll(root, `\`, "/"), "/") + "/"
	plain := varPathRe.ReplaceAllString(urlRe.ReplaceAllString(text, ""), "")
	var out []string
	seen := map[string]bool{}
	for _, m := range namedPath.FindAllStringSubmatch(plain, -1) {
		p := m[1]
		if strings.HasPrefix(p, repo) {
			p = p[len(repo):]
		} else {
			p = strings.TrimPrefix(p, "./")
		}
		if !strings.HasPrefix(p, "/") && !driveStart.MatchString(p) && !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	return out
}

// DispatchGuard — PreToolUse on a spawn and on SendMessage — records what
// the orchestrator dispatches that the commands do not describe, and lets it
// through: the rules are read off prose, and a guard denying a step a real
// run needed stalls it with a human waiting (ADR-035). Outside a run it
// records one thing: this flow's agent put to work with no run (ADR-040).
func DispatchGuard(c *hookio.Ctx) {
	root := hookio.ProjectDir()
	phase := hookio.ReadPhase(root)
	_, inRun := agents.DispatchedIn[phase]
	// Outside a run, only where the engine has run before.
	if !inRun && !hookio.Exists(filepath.Join(root, ".claude", "state")) {
		return
	}
	p := c.Payload()
	if hookio.First(p["agent_id"]) != "" {
		return // a subagent's call is not the orchestrator dispatching
	}
	tool := hookio.JSString(p["tool_name"])
	input := hookio.Obj(p["tool_input"])
	roles := agents.Roles()
	var why []string
	var extra []agents.Field

	agent, exactType := "", ""
	if tool == "SendMessage" {
		rec := agents.RecipientRecord(p)
		if rec == nil {
			return
		}
		typ := agents.RecipientType(p)
		exactType = typ
		if exactType == "" {
			exactType = rec.To
		}
		if agent = agents.MatchAgent([]string{exactType}, roles); agent == "" {
			agent = typ
		}
		if agent == "" {
			// An agent this session spawned has a transcript beside its own.
			if inRun && !hookio.Exists(rec.File) {
				agents.RecordDispatch(root, p, phase, "-", "record", "unknown-target", agents.Field{Key: "to", Value: rec.To})
			}
			return
		}
	} else {
		exactType, _ = hookio.FirstStr(input["subagent_type"], input["subagentType"], input["agent_type"])
		if agent = agents.MatchAgent([]string{exactType}, roles); agent == "" {
			agent = exactType
		}
	}

	if !inRun {
		// By the namespaced name only: outside a run is where people use their own.
		own := ""
		if m := ownName.FindStringSubmatch(exactType); m != nil {
			own = strings.ToLower(m[1])
		}
		if own == "implementer" && (phase == "done" || phase == "idle") {
			return // arm-gate's, which denies it (ADR-044)
		}
		if contains(roles, own) && !hookio.StateIsTracked(root) {
			if phase == "" {
				phase = "-"
			}
			agents.RecordDispatch(root, p, phase, own, "record", "no-run")
		}
		return
	}

	if tool != "SendMessage" && agent == "implementer" {
		var parts []string
		for _, k := range []string{"prompt", "description"} {
			if s, ok := input[k].(string); ok {
				parts = append(parts, s)
			}
		}
		text := strings.ReplaceAll(strings.Join(parts, "\n"), `\`, "/")
		plan, milestone := planRef.FindString(text), msRef.FindString(text)
		if plan == "" {
			why = append(why, "no-plan")
		}
		if milestone == "" {
			why = append(why, "no-milestone")
		}
		// The gate's logs are what a respawn after a red gate is handed.
		var other []string
		for _, path := range namedPaths(text, root) {
			if path != plan && path != milestone && !strings.HasPrefix(path, ".claude/state/") {
				other = append(other, path)
			}
		}
		if len(other) > 0 {
			why = append(why, "other-files")
			extra = append(extra, agents.Field{Key: "files", Value: strings.Join(other, ",")})
		}
	}
	if !contains(roles, agent) {
		why = append(why, "not-this-flow")
	} else if agent != "implementer" && !contains(agents.DispatchedIn[phase], agent) {
		why = append(why, "phase")
	}
	if len(why) > 0 {
		if agent == "" {
			agent = "-"
		}
		agents.RecordDispatch(root, p, phase, agent, "record", strings.Join(why, ","), extra...)
	}
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

var preflightHeadings = map[string]string{
	"no-repository":  "this directory is in no git repository.",
	"not-root":       "this directory is not the root of its repository.",
	"contract":       "the contract could not be read.",
	"base":           "the base branch could not be resolved.",
	"foreign-change": "a change the base branch already has is live in specflow/.",
}

// Preflight — PreToolUse on a spawn and on SendMessage — refuses a run the
// engine cannot finish, at its first agent, where a denial costs nothing. A
// hook, because a preflight the model must remember is not one. It checks
// only what stops a run dead: the repository, the contract, the base, and no
// live change the base already holds (ADR-032). Stands down outside a run.
func Preflight(c *hookio.Ctx) {
	root := hookio.ProjectDir()
	// Reads only, and fires on every spawn: creates nothing.
	phase := hookio.ReadPhase(root)
	if phase == "" || phase == "idle" || phase == "done" {
		return
	}
	c.Payload()
	// The check phase-guard makes at the start (ADR-028), but the settings.
	if _, err := canrun.Check(root); err != nil {
		what, ok := preflightHeadings[gitscope.Kind(err)]
		if !ok {
			what = "this engine cannot run here."
		}
		initHelps := ""
		if gitscope.Kind(err) == "contract" {
			initHelps = " `spec-flow init` regenerates the contract from this repo; `spec-flow init --force` overwrites an existing one."
		}
		c.Fail(fmt.Sprintf("[spec-flow] PREFLIGHT FAILED — %s\n\n%v\n\n", what, err) +
			"At a run's first agent nothing has run yet, which is the point of checking here: the same problem would otherwise " +
			"surface at the first gate, after the planner and an implementer had already been spent on a " +
			"milestone this engine could not have verified. Past it, something changed under the run, and what it produced stands.\n\n" +
			// Fires at every spawn, and nothing it reads tells the first from a later one.
			"Fix it, then start the run again — or, past its first agent, pick it up with `/spec-flow:resume`." + initHelps + "\n")
	}
}
