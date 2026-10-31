package e2e

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

// routed is model-route's rewritten input, or nil when it emitted nothing.
func routed(r Result) map[string]any {
	var v struct {
		HookSpecificOutput struct {
			UpdatedInput map[string]any `json:"updatedInput"`
		} `json:"hookSpecificOutput"`
	}
	if strings.TrimSpace(r.Stdout) == "" || json.Unmarshal([]byte(r.Stdout), &v) != nil {
		return nil
	}
	return v.HookSpecificOutput.UpdatedInput
}

func withRouting(t *testing.T, repo string, agents map[string]any) {
	write(t, filepath.Join(repo, ".claude", "spec-flow.config.json"), toJSON(map[string]any{"max_opus_calls": 6, "agents": agents}))
}

// reviewerElsewhere is a tier the reviewer does not ship with, read off the
// frontmatter under test: routing there is a re-route whatever its tier becomes.
func reviewerElsewhere() string {
	m := regexp.MustCompile(`(?m)^model:[ \t]*(\S+)`).FindStringSubmatch(read(filepath.Join(engineDir, "agents", "reviewer.md")))
	for _, tier := range []string{"haiku", "sonnet", "opus"} {
		if m == nil || tier != m[1] {
			return tier
		}
	}
	return ""
}

func agentSpawn(typ string, extra map[string]any) map[string]any {
	in := map[string]any{"subagent_type": typ}
	for k, v := range extra {
		in[k] = v
	}
	return map[string]any{"tool_name": "Agent", "tool_input": in}
}

func modelRoute(t *testing.T, repo string, p map[string]any, attended string) Result {
	t.Helper()
	h := Hook{}
	if attended != "" {
		h.Env = []string{"CLAUDE_CODE_SESSION_ATTENDED=" + attended}
	}
	return h.run(t, "model-route", p, repo)
}

func TestModelRoute(t *testing.T) {
	elsewhere := reviewerElsewhere()
	t.Run("leaves the model alone when the project declares no routing", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		r := modelRoute(t, repo, agentSpawn("planner", nil), "")
		expectStatus(t, r, 0, "model-route")
		if _, ok := routed(r)["model"]; ok {
			t.Fatalf("set a model for a repo that configured nothing: %s", r.Stdout)
		}
	})
	// ADR-023: a foreground spawn blocks the chat with no sign of progress.
	t.Run("runs every spawn of this plugin in the background", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		r := modelRoute(t, repo, agentSpawn("spec-flow:spec-writer", map[string]any{"prompt": "x", "run_in_background": false}), "1")
		in := routed(r)
		if in["run_in_background"] != true || in["prompt"] != "x" {
			t.Fatalf("the spawn was left in the foreground, or lost its input: %s", r.Stdout)
		}
	})
	// `claude -p` terminates background agents 600 s after its turn ends.
	t.Run("leaves an unattended session in the foreground", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		spawn := agentSpawn("spec-flow:spec-writer", map[string]any{"prompt": "x"})
		if routed(modelRoute(t, repo, spawn, "0"))["run_in_background"] == true {
			t.Fatal("an unattended spawn was sent to the background")
		}
		withRouting(t, repo, map[string]any{"spec-writer": "opus"})
		in := routed(modelRoute(t, repo, spawn, "0"))
		if in["model"] != "opus" || in["run_in_background"] == true {
			t.Fatalf("want opus in the foreground, got %v", in)
		}
	})
	t.Run("rewrites the spawn the project re-routed", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		withRouting(t, repo, map[string]any{"reviewer": elsewhere})
		in := routed(modelRoute(t, repo, agentSpawn("reviewer", map[string]any{"prompt": "x"}), ""))
		if in["model"] != elsewhere || in["prompt"] != "x" {
			t.Fatalf("want model %s with the input kept, got %v", elsewhere, in)
		}
	})
	t.Run("sends the architect to Fable when the project routes it there", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		withRouting(t, repo, map[string]any{"architect": "fable"})
		in := routed(modelRoute(t, repo, agentSpawn("spec-flow:architect", map[string]any{"prompt": "Which port owns this?"}), ""))
		if in["model"] != "fable" || in["prompt"] != "Which port owns this?" {
			t.Fatalf("got %v", in)
		}
	})
	t.Run("leaves the model of an agent the project did not re-route alone", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		withRouting(t, repo, map[string]any{"reviewer": elsewhere})
		if _, ok := routed(modelRoute(t, repo, agentSpawn("planner", nil), ""))["model"]; ok {
			t.Fatal("re-routed a spawn nobody re-routed")
		}
	})
	t.Run("treats restating the shipped default as no re-route", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		withRouting(t, repo, map[string]any{"planner": "opus"})
		if _, ok := routed(modelRoute(t, repo, agentSpawn("planner", nil), ""))["model"]; ok {
			t.Fatal("reported a change nobody made")
		}
		if exists(statePath(repo, "model-routes.log")) {
			t.Fatal("logged a re-route nobody made")
		}
	})
	t.Run("denies a routing block naming an agent that does not exist", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		withRouting(t, repo, map[string]any{"reviwer": "sonnet"})
		r := modelRoute(t, repo, agentSpawn("reviewer", nil), "")
		expectStatus(t, r, 2, "a name nothing matches routes nothing")
		mustMatch(t, `reviwer`, r.Stderr, "denied without naming the entry that is wrong")
		mustMatch(t, `reviewer`, r.Stderr, "denied without naming the agents that do exist")
	})
	t.Run("denies a full model id, where the tool call would have", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		withRouting(t, repo, map[string]any{"reviewer": strings.Join([]string{"claude", "haiku", "4-5"}, "-")})
		expectStatus(t, modelRoute(t, repo, agentSpawn("reviewer", nil), ""), 2, "a pinned id fails the spawn's own schema")
	})
	t.Run("reads a routing written after a byte-order mark, and denies the entry that is wrong", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		write(t, filepath.Join(repo, ".claude", "spec-flow.config.json"), "\xef\xbb\xbf"+`{"agents":{"reviwer":"sonnet"}}`)
		r := modelRoute(t, repo, agentSpawn("reviewer", nil), "")
		expectStatus(t, r, 2, "behind a byte-order mark the routing was never read")
		mustMatch(t, `reviwer`, r.Stderr, "denied without naming the entry that is wrong")
	})
	t.Run("reads a file that is not a JSON object as no routing, and does not crash on it", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		for _, text := range []string{"null", "[]", "6"} {
			write(t, filepath.Join(repo, ".claude", "spec-flow.config.json"), text)
			r := modelRoute(t, repo, agentSpawn("reviewer", nil), "")
			expectStatus(t, r, 0, text)
			mustNotMatch(t, `hook error`, r.Stderr, text+": the hook crashed")
		}
	})
	t.Run("passes through an agent this plugin does not ship", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		withRouting(t, repo, map[string]any{"reviewer": elsewhere})
		r := modelRoute(t, repo, agentSpawn("general-purpose", nil), "")
		expectStatus(t, r, 0, "an unrelated agent must never be touched")
		if strings.TrimSpace(r.Stdout) != "" {
			t.Fatal("rewrote a spawn that is none of this plugin's business")
		}
	})
	t.Run("does not block unrelated work over its own broken config", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		withRouting(t, repo, map[string]any{"reviwer": "sonnet"})
		expectStatus(t, modelRoute(t, repo, agentSpawn("general-purpose", nil), ""), 0, "a broken routing block blocked unrelated work")
	})
	t.Run("applies outside a run, unlike the budget", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{phase: "idle"})
		withRouting(t, repo, map[string]any{"architect": "sonnet"})
		if routed(modelRoute(t, repo, agentSpawn("architect", nil), ""))["model"] != "sonnet" {
			t.Fatal("a one-off question to the architect ignored the routing")
		}
	})
	t.Run("leaves a deduped trace of what it re-routed", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		withRouting(t, repo, map[string]any{"reviewer": elsewhere})
		modelRoute(t, repo, agentSpawn("reviewer", nil), "")
		modelRoute(t, repo, agentSpawn("reviewer", nil), "")
		lines := nonEmptyLines(read(statePath(repo, "model-routes.log")))
		if len(lines) != 1 || !strings.Contains(lines[0], "reviewer -> "+elsewhere) {
			t.Fatalf("want one line naming the re-route, got %q", lines)
		}
	})
}

type onDisk struct {
	id, typ, ttl string
	context      int
	ageMin       float64
}

// subagentOnDisk is the shape a run leaves: the session transcript, and
// beside it the agent's own with its .meta.json, last written ageMin ago.
func subagentOnDisk(t *testing.T, repo string, o onDisk) map[string]any {
	t.Helper()
	if o.id == "" {
		o.id = "a0123456789abcdef"
	}
	if o.typ == "" {
		o.typ = "spec-flow:spec-writer"
	}
	if o.ttl == "" {
		o.ttl = "5m"
	}
	if o.context == 0 {
		o.context = 206000
	}
	session := filepath.Join(repo, "sess.jsonl")
	write(t, session, "")
	dir := filepath.Join(repo, "sess", "subagents")
	file := filepath.Join(dir, "agent-"+o.id+".jsonl")
	split := map[string]any{"ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 0}
	split["ephemeral_"+o.ttl+"_input_tokens"] = 998
	usage := map[string]any{"input_tokens": 2, "cache_read_input_tokens": o.context - 1000, "cache_creation_input_tokens": 998, "cache_creation": split}
	write(t, file, toJSON(map[string]any{"type": "assistant", "isSidechain": true, "message": map[string]any{"id": "msg_1", "model": "model-alpha", "usage": usage}})+"\n")
	write(t, filepath.Join(dir, "agent-"+o.id+".meta.json"), toJSON(map[string]any{"agentType": o.typ}))
	age(t, file, time.Duration(o.ageMin*float64(time.Minute)))
	return map[string]any{"transcript_path": session, "tool_name": "SendMessage", "tool_input": map[string]any{"to": o.id, "message": "close the gap", "summary": "close the gap"}}
}

func TestStaleResume(t *testing.T) {
	t.Run("denies resuming an agent whose cache expired, and says the cost and the way out", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		r := runHook(t, "stale-resume", subagentOnDisk(t, repo, onDisk{ageMin: 30}), repo)
		expectStatus(t, r, 2, "a 30-minute-old spec-writer was resumed")
		mustMatch(t, `206k`, r.Stderr, "the denial does not say what the resume would have re-sent")
		mustMatch(t, `NEW spec-writer`, r.Stderr, "the denial does not name the way out")
	})
	for _, c := range []struct {
		name string
		o    onDisk
	}{
		{"lets a warm agent be resumed", onDisk{ageMin: 1}},
		{"reads the TTL off the agent: a 1-hour cache at 30 minutes is warm", onDisk{ageMin: 30, ttl: "1h"}},
		{"leaves an agent that is not this plugin's alone", onDisk{ageMin: 30, typ: "Explore"}},
	} {
		t.Run(c.name, func(t *testing.T) {
			repo := makeRepo(t, repoOpts{})
			expectStatus(t, runHook(t, "stale-resume", subagentOnDisk(t, repo, c.o), repo), 0, c.name)
		})
	}
	t.Run("stands down outside a run", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{phase: "idle"})
		expectStatus(t, runHook(t, "stale-resume", subagentOnDisk(t, repo, onDisk{ageMin: 30}), repo), 0, "a message outside any run was denied")
	})
	t.Run("allows a recipient it cannot see", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		p := subagentOnDisk(t, repo, onDisk{ageMin: 30})
		p["tool_input"] = map[string]any{"to": "someone-else", "message": "x"}
		expectStatus(t, runHook(t, "stale-resume", p, repo), 0, "a message was denied over a transcript that does not exist")
	})
	t.Run("opus-budget charges a warm planner resume and not one stale-resume denies", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		write(t, statePath(repo, "agent-registry"), "a0123456789abcdef planner\n")
		runHook(t, "opus-budget", subagentOnDisk(t, repo, onDisk{ageMin: 30, typ: "spec-flow:planner"}), repo)
		if c := counterOf(repo, "opus_calls"); c != "0" {
			t.Fatalf("a resume stale-resume denies was charged (%s)", c)
		}
		runHook(t, "opus-budget", subagentOnDisk(t, repo, onDisk{ageMin: 1, typ: "spec-flow:planner"}), repo)
		if c := counterOf(repo, "opus_calls"); c != "1" {
			t.Fatalf("a warm planner resume was charged %s, want 1", c)
		}
	})
	t.Run("opus-budget denies a warm planner resume while its cap is not a number of calls", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		write(t, statePath(repo, "agent-registry"), "a0123456789abcdef planner\n")
		write(t, filepath.Join(repo, ".claude", "spec-flow.config.json"), `{"max_opus_calls":"six"}`)
		r := runHook(t, "opus-budget", subagentOnDisk(t, repo, onDisk{ageMin: 1, typ: "spec-flow:planner"}), repo)
		expectStatus(t, r, 2, "a resume went through under a cap no count can reach")
		mustMatch(t, `max_opus_calls`, r.Stderr, "the denial does not name the key")
	})
}

// ---- the orchestrator routes, and a hook keeps it routing (ADR-034) ------

func attributed(t *testing.T, repo string) {
	write(t, statePath(repo, "run-trace.log"), "2026-01-01T00:00:00Z phase=implement session=s read file="+filepath.Join(repo, "specs", "user.md")+" agent_id=writer1\n")
}

func scope(t *testing.T, repo string, p map[string]any) Result {
	t.Helper()
	return runHook(t, "orchestrator-scope", p, repo)
}

func sessionWrite(t *testing.T, repo, rel string) Result {
	return scope(t, repo, map[string]any{"session_id": "s", "tool_name": "Write", "tool_input": map[string]any{"file_path": filepath.Join(repo, rel), "content": "x"}})
}

func sessionRead(t *testing.T, repo, path string) Result {
	return scope(t, repo, map[string]any{"session_id": "s", "tool_name": "Read", "tool_input": map[string]any{"file_path": path}})
}

func sessionBash(t *testing.T, repo, cmd string) Result {
	return scope(t, repo, map[string]any{"session_id": "s", "tool_name": "Bash", "tool_input": map[string]any{"command": cmd}})
}

func TestOrchestratorScope(t *testing.T) {
	armed := func(t *testing.T) string {
		repo := makeRepo(t, repoOpts{})
		attributed(t, repo)
		return repo
	}
	t.Run("denies the session writing code during a run, and names who does it", func(t *testing.T) {
		repo := armed(t)
		r := sessionWrite(t, repo, "lib/a.ts")
		expectStatus(t, r, 2, "the session wrote lib/a.ts mid-run")
		mustMatch(t, `implementer`, r.Stderr, "the denial does not route the work")
	})
	t.Run("lets a subagent write code", func(t *testing.T) {
		repo := armed(t)
		expectStatus(t, scope(t, repo, map[string]any{"session_id": "s", "agent_id": "impl1", "tool_name": "Edit", "tool_input": map[string]any{"file_path": filepath.Join(repo, "lib/a.ts"), "old_string": "a", "new_string": "b"}}), 0, "an implementer's edit was denied")
	})
	t.Run("lets the session write its state and the change folder", func(t *testing.T) {
		repo := armed(t)
		for _, rel := range []string{".claude/state/gate_attempts", "specflow/my-change/spec.md"} {
			expectStatus(t, sessionWrite(t, repo, rel), 0, "the session was denied "+rel)
		}
	})
	t.Run("denies the session reading code, and lets it read specs, the change, the root docs and anything outside", func(t *testing.T) {
		repo := armed(t)
		expectStatus(t, sessionRead(t, repo, filepath.Join(repo, "lib", "a.ts")), 2, "the session read lib/a.ts mid-run")
		for _, p := range []string{filepath.Join(repo, "specs", "user.md"), filepath.Join(repo, "specflow", "my-change", "spec.md"), filepath.Join(repo, "CLAUDE.md"), filepath.Join(os.TempDir(), "elsewhere", "commands", "spec-flow.md")} {
			expectStatus(t, sessionRead(t, repo, p), 0, "the session was denied "+p)
		}
	})
	for _, c := range []struct {
		name string
		cmds []string
		want int
	}{
		{"denies a Bash move of a human's plan out of specflow/", []string{"git mv specflow/city-gym docs/backlog/city-gym"}, 2},
		{"denies a redirect or a sed -i into code", []string{"echo x > lib/a.ts", "sed -i 's/a/b/' lib/a.ts"}, 2},
		{"lets the session's own Bash steps through", []string{
			"printf 0 > .claude/state/gate_attempts && printf 0 > .claude/state/opus_calls && printf 0 > .claude/state/architect_calls && spec-flow telemetry --mark",
			`git add -A && git commit -m "move lib/a.ts into lib/b" && git push`,
			"git mv specflow/my-change specflow/archive/my-change",
			"spec-flow stats 2>&1 > /dev/null",
		}, 0},
		// B61: a quoted `>` read as a redirect denied a real run's milestone commit.
		{"reads quoted text as text, not as a redirect or a second command", []string{
			`git add -A && git commit -m "map RETURNED_TO_SENDER -> RETURNED" && git push`,
			"git commit -m \"feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nRefs: #12\"",
			"git commit -m 'run lint; rm lib/a.ts is not run' && git push",
			`git commit -m "a | tee lib/a.ts, and a << b" && git push`,
		}, 0},
		{"still denies a redirect into code after quoted text, and one whose target is quoted", []string{`git log -1 --format="%s -> %b" > lib/a.ts`, `echo hi > "lib/my file.ts"`, `printf "a > b" | tee lib/a.ts`}, 2},
		// The quoting B61 read as text hid a write.
		{"reads a write to code handed to a shell, past an escaped quote or after a heredoc", []string{
			"sh -c 'echo x > lib/a.ts'",
			`eval "echo x > lib/a.ts"`,
			`git commit -m "a \"b" && echo x > lib/a.ts && echo "c"`,
			"cat > specflow/notes.md <<'EOF'\nnotes\nEOF\necho x > lib/a.ts",
		}, 2},
		{"reads a heredoc body and a comment as text", []string{
			"git commit -F - <<'EOF'\nmap RETURNED_TO_SENDER -> RETURNED\nEOF",
			"tee specflow/notes.md <<'EOF'\nrm lib/a.ts; echo x > lib/b.ts\nEOF",
			"git status # then echo x > lib/a.ts",
		}, 0},
		{"denies the session writing a log the hooks decide on", []string{`echo "x prompt from=human" >> .claude/state/human-turn.log`, "printf 'x result=pass ' >> .claude/state/gate-history.log"}, 2},
	} {
		t.Run(c.name, func(t *testing.T) {
			repo := armed(t)
			for _, cmd := range c.cmds {
				expectStatus(t, sessionBash(t, repo, cmd), c.want, "`"+cmd+"`")
			}
		})
	}
	t.Run("a Write over a log the hooks decide on is denied", func(t *testing.T) {
		repo := armed(t)
		expectStatus(t, sessionWrite(t, repo, ".claude/state/run-trace.log"), 2, "a Write over run-trace.log went through")
	})
	// The same reader as phase-guard's: a write after a cd lands under it.
	t.Run("reads a write after a cd where it lands", func(t *testing.T) {
		repo := armed(t)
		expectStatus(t, sessionBash(t, repo, "cd .claude/state && printf 0 > gate_attempts && printf 0 > opus_calls"), 0, "the session's counter reset after a cd was denied")
		expectStatus(t, sessionBash(t, repo, "cd lib/deep && printf x > ../a.ts"), 2, "a write into lib/ after a cd went through")
	})
	t.Run("stands down outside a run", func(t *testing.T) {
		repo := armed(t)
		setPhase(t, repo, "idle")
		expectStatus(t, sessionWrite(t, repo, "lib/a.ts"), 0, "an edit outside any run was denied")
	})
	t.Run("stands down until the trace shows this build attributes calls, and says so", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		expectStatus(t, sessionWrite(t, repo, "lib/a.ts"), 0, "it denied with no evidence that subagent calls carry an agent_id")
		if !exists(statePath(repo, "orchestrator-scope-unmatched.log")) {
			t.Fatal("it stood down without recording why")
		}
	})
}

// ---- what the orchestrator dispatches, recorded before it is denied (ADR-035)

func dispatches(repo string) []string {
	var out []string
	for _, l := range strings.Split(traceText(repo), "\n") {
		if strings.Contains(l, " dispatch ") {
			out = append(out, l)
		}
	}
	return out
}

func spawnTo(t *testing.T, repo, typ, prompt string, extra map[string]any) Result {
	t.Helper()
	p := map[string]any{"session_id": "s", "tool_name": "Agent", "tool_input": map[string]any{"subagent_type": typ, "description": "x", "prompt": prompt}}
	for k, v := range extra {
		p[k] = v
	}
	return runHook(t, "dispatch-guard", p, repo)
}

const implOrder = "Implement specflow/my-change/milestones/M1.md; the approach is in specflow/my-change/plan.md."

func first(lines []string) string {
	if len(lines) == 0 {
		return ""
	}
	return lines[0]
}

func TestDispatch(t *testing.T) {
	t.Run("arm-gate arms on a message that resumes the implementer by its id", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{phase: "blocked"})
		expectStatus(t, runHook(t, "arm-gate", subagentOnDisk(t, repo, onDisk{typ: "spec-flow:implementer", ageMin: 1}), repo), 0, "arm-gate")
		if p := phaseOf(repo); p != "implement" {
			t.Fatalf("phase is %q — the implementer was put back to work with the gate disarmed", p)
		}
	})
	t.Run("arm-gate records each time it arms the gate for the orchestrator", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{phase: "plan"})
		runHook(t, "arm-gate", map[string]any{"session_id": "s", "tool_name": "Agent", "tool_input": map[string]any{"subagent_type": "implementer", "prompt": implOrder}}, repo)
		mustMatch(t, ` phase=plan .*dispatch agent=implementer tool=Agent result=armed why=phase`, first(dispatches(repo)), "no record of the backstop arming")
	})
	t.Run("records an agent put to work in a phase the commands do not dispatch it in, and lets it through", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		expectStatus(t, spawnTo(t, repo, "spec-flow:reviewer", "", nil), 0, "a recorded dispatch was denied")
		mustMatch(t, ` phase=implement .*dispatch agent=reviewer tool=Agent result=record why=phase`, first(dispatches(repo)), "no record of a reviewer mid-implement")
	})
	t.Run("records an implementer handed more than its work order, or less", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		spawnTo(t, repo, "spec-flow:implementer", implOrder+" Start from lib/orders/place.ts and read specflow/my-change/spec.md.", nil)
		spawnTo(t, repo, "spec-flow:implementer", "Implement specflow/my-change/plan.md.", nil)
		d := dispatches(repo)
		if len(d) != 2 {
			t.Fatalf("want two lines, got %q", d)
		}
		mustMatch(t, `why=other-files files=lib/orders/place\.ts,specflow/my-change/spec\.md`, d[0], "files beyond the work order were not recorded")
		mustMatch(t, `why=no-milestone`, d[1], "an implementer with no milestone was not recorded")
	})
	t.Run("records a message to an agent this session never spawned", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		p := subagentOnDisk(t, repo, onDisk{typ: "spec-flow:implementer", ageMin: 1})
		p["tool_input"].(map[string]any)["to"] = "b0123456789abcdef"
		runHook(t, "dispatch-guard", p, repo)
		mustMatch(t, `dispatch agent=- tool=SendMessage result=record why=unknown-target to=b0123456789abcdef`, first(dispatches(repo)), "no record of a message to nobody")
	})
	t.Run("records an agent that is not this flow put to work mid-run", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		spawnTo(t, repo, "Explore", "read lib/ and summarize the orders module", nil)
		mustMatch(t, `dispatch agent=Explore tool=Agent result=record why=not-this-flow`, first(dispatches(repo)), "no record of a general agent mid-run")
	})
	// Guards: what the commands dispatch, as they write it, leaves no line.
	t.Run("leaves no line for the commands' own dispatches", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		setPhase(t, repo, "spec")
		spawnTo(t, repo, "spec-flow:spec-writer", "MODE=TRIAGE the login fails", nil)
		setPhase(t, repo, "review")
		spawnTo(t, repo, "spec-flow:planner", "MODE=CONSULT", nil)
		setPhase(t, repo, "implement")
		spawnTo(t, repo, "spec-flow:implementer", implOrder, nil)
		spawnTo(t, repo, "spec-flow:implementer", filepath.Join(repo, "specflow/my-change/plan.md")+" and "+filepath.Join(repo, "specflow/my-change/milestones/M2.md")+", with .claude/state/gate-failure.log", nil)
		spawnTo(t, repo, "spec-flow:architect", "Which port owns this?", nil)
		spawnTo(t, repo, "spec-flow:spec-writer", "MODE=FOLD specflow/my-change/spec.md", nil)
		runHook(t, "dispatch-guard", subagentOnDisk(t, repo, onDisk{typ: "spec-flow:implementer", ageMin: 1}), repo)
		if d := dispatches(repo); len(d) > 0 {
			t.Fatalf("the commands' own dispatches were recorded:\n%s", strings.Join(d, "\n"))
		}
	})
	t.Run("leaves a subagent's call, and another flow's agent outside a run, alone", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		spawnTo(t, repo, "Explore", "", map[string]any{"agent_id": "impl1"})
		setPhase(t, repo, "idle")
		spawnTo(t, repo, "Explore", "", nil)
		spawnTo(t, repo, "code-reviewer", "review my diff", nil)
		// A bare name is a person's own agent: the harness namespaces this plugin's.
		spawnTo(t, repo, "reviewer", "review my diff", nil)
		spawnTo(t, repo, "other-plugin:planner", "plan this", nil)
		spawnTo(t, repo, "spec-flow:planner", "plan this", map[string]any{"agent_id": "impl1"})
		p := subagentOnDisk(t, repo, onDisk{typ: "spec-flow:implementer", ageMin: 1})
		p["tool_input"].(map[string]any)["to"] = "b0123456789abcdef"
		runHook(t, "dispatch-guard", p, repo)
		if d := dispatches(repo); len(d) > 0 {
			t.Fatalf("recorded outside the orchestrator's run:\n%s", strings.Join(d, "\n"))
		}
	})
}

// ---- this flow's agent with no run phase (ADR-040), and the implementer (ADR-044)

var implementerCall = map[string]any{"session_id": "s", "tool_name": "Agent", "tool_input": map[string]any{"subagent_type": "spec-flow:implementer", "prompt": "strengthen tests/a.spec.ts"}}

func TestOutsideARun(t *testing.T) {
	done := repoOpts{phase: "done"}
	t.Run("dispatch-guard records this flow's agent put to work with no run phase, and lets it through", func(t *testing.T) {
		repo := makeRepo(t, done)
		expectStatus(t, spawnTo(t, repo, "spec-flow:planner", "Plan specflow/my-change/spec.md", nil), 0, "a recorded dispatch was denied")
		spawnTo(t, repo, "spec-flow:reviewer", "Review specflow/my-change/plan.md", nil)
		setPhase(t, repo, "idle")
		spawnTo(t, repo, "spec-flow:spec-writer", "add a refund endpoint", nil)
		os.Remove(statePath(repo, "phase"))
		spawnTo(t, repo, "spec-flow:Architect", "Which port owns this?", nil)
		d := dispatches(repo)
		for _, c := range [][2]string{{"done", "planner"}, {"done", "reviewer"}, {"idle", "spec-writer"}, {"-", "architect"}} {
			if !anyLine(d, ` phase=`+c[0]+` .*dispatch agent=`+c[1]+` tool=Agent result=record why=no-run$`) {
				t.Fatalf("no record of the %s put to work with phase %q:\n%s", c[1], c[0], strings.Join(d, "\n"))
			}
		}
		if len(d) != 4 {
			t.Fatalf("expected four lines:\n%s", strings.Join(d, "\n"))
		}
	})
	t.Run("dispatch-guard records a message to this flow's agent with no run phase", func(t *testing.T) {
		repo := makeRepo(t, done)
		runHook(t, "dispatch-guard", subagentOnDisk(t, repo, onDisk{typ: "spec-flow:spec-writer", ageMin: 1}), repo)
		mustMatch(t, ` phase=done .*dispatch agent=spec-writer tool=SendMessage result=record why=no-run$`, first(dispatches(repo)), "no record of the message")
	})
	t.Run("arm-gate denies this flow's implementer outside a run, and says what to run instead", func(t *testing.T) {
		repo := makeRepo(t, done)
		for _, ph := range []string{"done", "idle"} {
			setPhase(t, repo, ph)
			r := runHook(t, "arm-gate", implementerCall, repo)
			expectStatus(t, r, 2, "an implementer was put to work on "+ph)
			mustMatch(t, `/spec-fix`, r.Stderr, "the denial does not name /spec-fix")
		}
		expectStatus(t, runHook(t, "arm-gate", subagentOnDisk(t, repo, onDisk{typ: "spec-flow:implementer", ageMin: 1}), repo), 2, "a message resumed an implementer on idle")
		// dispatch-guard runs on the same call: the denial is recorded once, by arm-gate.
		runHook(t, "dispatch-guard", implementerCall, repo)
		d := dispatches(repo)
		if len(d) != 3 {
			t.Fatalf("want three denials, one per call:\n%s", strings.Join(d, "\n"))
		}
		for _, l := range d {
			mustMatch(t, ` dispatch agent=implementer tool=\w+ result=deny why=no-run$`, l, "not a denial")
		}
	})
	t.Run("arm-gate leaves outside a run a person's own implementer, the architect, and a repo with no phase", func(t *testing.T) {
		repo := makeRepo(t, done)
		for _, typ := range []string{"implementer", "spec-flow:architect"} {
			expectStatus(t, runHook(t, "arm-gate", agentSpawn(typ, map[string]any{"prompt": "x"}), repo), 0, typ+" was denied on done")
		}
		os.Remove(statePath(repo, "phase"))
		expectStatus(t, runHook(t, "arm-gate", implementerCall, repo), 0, "an implementer was denied in a repo with no phase")
	})
	t.Run("arm-gate leaves alone a repository that committed .claude/state", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{phase: "done", commitPhase: true})
		expectStatus(t, runHook(t, "arm-gate", implementerCall, repo), 0, "denied over a phase the repository committed")
	})
	t.Run("dispatch-guard appends nothing outside a run to a .claude/state the repository committed", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{phase: "done", commitPhase: true})
		spawnTo(t, repo, "spec-flow:architect", "Which port owns this?", nil)
		if exists(statePath(repo, "run-trace.log")) {
			t.Fatalf("a committed phase file was taken for a run the engine kept:\n%s", traceText(repo))
		}
		os.Remove(statePath(repo, "phase"))
		write(t, statePath(repo, "run-trace.log"), "shipped\n")
		gitQuiet(repo, "add", "-f", "--", ".claude/state/run-trace.log")
		gitQuiet(repo, "commit", "-q", "-m", "a log this repository committed")
		spawnTo(t, repo, "spec-flow:architect", "Which port owns this?", nil)
		if l := traceText(repo); l != "shipped\n" {
			t.Fatalf("a line was appended to a log the repository committed:\n%s", l)
		}
	})
	t.Run("dispatch-guard writes a phase outside the vocabulary as one field", func(t *testing.T) {
		repo := makeRepo(t, done)
		setPhase(t, repo, "x\necho from-the-phase-file\n#")
		spawnTo(t, repo, "spec-flow:architect", "Which port owns this?", nil)
		lines := nonEmptyLines(traceText(repo))
		if len(lines) != 1 || !regexp.MustCompile(` phase=xechofrom-the-phase-file# .*why=no-run$`).MatchString(lines[0]) {
			t.Fatalf("the phase file's text split the line:\n%s", traceText(repo))
		}
	})
	t.Run("dispatch-guard leaves a repository the engine never ran in without a .claude/state", func(t *testing.T) {
		dir := t.TempDir()
		runHook(t, "dispatch-guard", map[string]any{"session_id": "s", "tool_name": "Agent", "tool_input": map[string]any{"subagent_type": "spec-flow:planner", "prompt": "x"}}, dir)
		if exists(filepath.Join(dir, ".claude")) {
			t.Fatal("a spawn outside any run created .claude/ in a repository the engine never ran in")
		}
	})
}

// ---- a case 3 waits for a human's answer (ADR-036) -------------------------

const correction = "# Fix — my-change\n\n## Case\n3 SPEC-WRONG\n\n## Requirement deltas\n- CHANGED REQ-USER-001 (correction) — now right\n"

func turnLog(t *testing.T, repo string, minutesAgo float64, event string) {
	at := time.Now().Add(-time.Duration(minutesAgo * float64(time.Minute)))
	appendTo(t, statePath(repo, "human-turn.log"), fmt.Sprintf("%s %s\n", at.UTC().Format("2006-01-02T15:04:05.000Z"), event))
}

// answeredAt: the session ended its turn, then a person typed.
func answeredAt(t *testing.T, repo string, minutesAgo float64) {
	turnLog(t, repo, minutesAgo+0.5, "turn-end")
	turnLog(t, repo, minutesAgo, "prompt from=human")
}

func correctionBrief(t *testing.T, repo string, writtenMinutesAgo float64) {
	writeChange(t, repo, correction, false, "")
	write(t, filepath.Join(repo, "specflow", "my-change", "plan.md"), "# Plan — my-change\n")
	age(t, filepath.Join(repo, "specflow", "my-change", "spec.md"), time.Duration(writtenMinutesAgo*float64(time.Minute)))
}

func TestCase3(t *testing.T) {
	spec := repoOpts{phase: "spec"}
	t.Run("phase-guard holds a case 3 in spec until a human has answered since the brief was written", func(t *testing.T) {
		repo := makeRepo(t, spec)
		answeredAt(t, repo, 10)
		correctionBrief(t, repo, 5)
		r := writePhase(t, repo, "implement")
		expectStatus(t, r, 2, "implement was written over a correction no human answered")
		mustNotMatch(t, `human-turn|turn-end`, r.Stderr, "the denial names the record instead of asking for the answer")
		mustMatch(t, `REQ-USER-001`, r.Stderr, "the denial does not name the correction")
		mustMatch(t, `end your turn`, r.Stderr, "the denial does not name the stop")
	})
	t.Run("arm-gate does not engage the implementer over a case 3 no human has answered", func(t *testing.T) {
		repo := makeRepo(t, spec)
		answeredAt(t, repo, 10)
		correctionBrief(t, repo, 5)
		for _, ph := range []string{"spec", "implement"} {
			setPhase(t, repo, ph)
			expectStatus(t, engageImplementer(t, repo), 2, ph+": the implementer was engaged over a correction no human answered")
			if now := phaseOf(repo); now != ph {
				t.Fatalf("%s: the denied engagement still moved the phase to %q", ph, now)
			}
		}
	})
	// The triage's own report-back fires the prompt hook after the brief.
	t.Run("a prompt with no turn end after the brief, or a harness notification, is not an answer", func(t *testing.T) {
		repo := makeRepo(t, spec)
		turnLog(t, repo, 8, "turn-end")
		correctionBrief(t, repo, 5)
		turnLog(t, repo, 2, "prompt from=human")
		expectStatus(t, writePhase(t, repo, "implement"), 2, "a prompt without a stop after the brief counted as an answer")
		turnLog(t, repo, 1.5, "turn-end")
		turnLog(t, repo, 1, "prompt from=task-notification")
		expectStatus(t, writePhase(t, repo, "implement"), 2, "a task notification counted as a person's answer")
	})
	t.Run("human-turn records turn ends, prompts by source and answered questions, and nothing where the engine was never adopted", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		hook := func(p map[string]any, at string) {
			p["session_id"] = "s"
			runHook(t, "human-turn", p, at)
		}
		hook(map[string]any{"hook_event_name": "UserPromptSubmit", "prompt": "yes, the requirement was wrong"}, repo)
		hook(map[string]any{"hook_event_name": "UserPromptSubmit", "prompt": "<task-notification>\n<task-id>a1</task-id>"}, repo)
		hook(map[string]any{"hook_event_name": "UserPromptSubmit", "prompt": "<pasted_content id=\"p1\">\nlog\n</pasted_content> ok"}, repo)
		hook(map[string]any{"hook_event_name": "Stop"}, repo)
		hook(map[string]any{"hook_event_name": "PostToolUse", "tool_name": "AskUserQuestion", "tool_input": map[string]any{}, "tool_response": map[string]any{}}, repo)
		var got []string
		for _, l := range nonEmptyLines(read(statePath(repo, "human-turn.log"))) {
			got = append(got, strings.SplitN(l, " ", 2)[1])
		}
		want := []string{"prompt from=human", "prompt from=task-notification", "prompt from=human", "turn-end", "prompt from=question"}
		if strings.Join(got, "|") != strings.Join(want, "|") {
			t.Fatalf("recorded %q, expected %q", got, want)
		}
		if strings.Contains(read(statePath(repo, "human-turn.log")), "requirement was wrong") {
			t.Fatal("the record copied what the person said")
		}
		bare := t.TempDir()
		hook(map[string]any{"hook_event_name": "UserPromptSubmit", "prompt": "hi"}, bare)
		if exists(filepath.Join(bare, ".claude")) {
			t.Fatal("it wrote state into a repository that never adopted the engine")
		}
	})
	// Guards: an answered case 3 goes on, and a build that never records an
	// answer is not held forever.
	t.Run("a case 3 goes on once a human has answered since the brief, typed after a turn end or through a question", func(t *testing.T) {
		repo := makeRepo(t, spec)
		correctionBrief(t, repo, 5)
		answeredAt(t, repo, 1)
		expectStatus(t, writePhase(t, repo, "implement"), 0, "implement was denied after the human answered")
		expectStatus(t, engageImplementer(t, repo), 0, "the implementer was denied after the human answered")
		correctionBrief(t, repo, 0.5)
		turnLog(t, repo, 0.2, "prompt from=question")
		expectStatus(t, engageImplementer(t, repo), 0, "an answered question did not count")
	})
	t.Run("the case-3 check stands down, and says so, where no answer was ever recorded", func(t *testing.T) {
		repo := makeRepo(t, spec)
		correctionBrief(t, repo, 5)
		expectStatus(t, writePhase(t, repo, "implement"), 0, "a build with no recorded answer held the case 3")
		if !exists(statePath(repo, "human-turn-unmatched.log")) {
			t.Fatal("it stood down without recording why")
		}
	})
}

// The contract as the hooks read it, for a person inspecting it.
func TestConfigShowsTheContractAsTheHooksReadIt(t *testing.T) {
	changedInPort(t, "a command of its own; it was scripts/spec-flow-config.mjs")
	repo := makeRepo(t, repoOpts{})
	r := run(repo, []string{"CLAUDE_PROJECT_DIR="}, "", cliArgv(engineDir, "config")...)
	expectStatus(t, r, 0, "a contract that loads")
	mustMatch(t, `spec-flow config: OK — contract v1, read from file`, r.Out(), "the contract it read")
	mustMatch(t, `(?m)^  scope: \*\.ts$`, r.Out(), "the scope it read")
	write(t, filepath.Join(repo, ".spec-flow", "config.json"), "{ not json")
	r = run(repo, []string{"CLAUDE_PROJECT_DIR="}, "", cliArgv(engineDir, "config")...)
	if r.Status == 0 {
		t.Fatalf("a contract that does not parse was shown as read: %s", r.Out())
	}
}
