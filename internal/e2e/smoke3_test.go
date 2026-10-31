package e2e

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

func usageEntry(out int) string {
	return toJSON(map[string]any{"type": "assistant", "message": map[string]any{"id": fmt.Sprintf("m%d", out), "role": "assistant", "model": "model-alpha",
		"usage": map[string]any{"input_tokens": 1, "output_tokens": out, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}}}) + "\n"
}

func postTool(session, tool string, input map[string]any) map[string]any {
	return map[string]any{"session_id": session, "hook_event_name": "PostToolUse", "tool_name": tool, "tool_input": input}
}

func nonEmptyLines(text string) []string {
	var out []string
	for _, l := range strings.Split(text, "\n") {
		if l != "" {
			out = append(out, l)
		}
	}
	return out
}

func anyLine(lines []string, pattern string) bool {
	re := regexp.MustCompile(pattern)
	for _, l := range lines {
		if re.MatchString(l) {
			return true
		}
	}
	return false
}

// ---- the turn that closes a run (ADR-043) ----------------------------------

func TestTheClosingTurn(t *testing.T) {
	phaseWrite := func(repo string) map[string]any {
		return map[string]any{"file_path": statePath(repo, "phase"), "content": "done"}
	}
	t.Run("the turn that writes done leaves a line, with its tokens, and the turns after it none", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		session := filepath.Join(repo, "sess.jsonl")
		stop := func() {
			runHook(t, "token-trace", map[string]any{"session_id": "s", "hook_event_name": "Stop", "transcript_path": session}, repo)
		}
		write(t, session, usageEntry(100))
		stop()
		setPhase(t, repo, "done")
		runHook(t, "run-trace", postTool("s", "Write", phaseWrite(repo)), repo)
		appendTo(t, session, usageEntry(7))
		stop()
		appendTo(t, session, usageEntry(3))
		stop()
		lines := nonEmptyLines(traceText(repo))
		if !anyLine(lines, ` phase=done session=s closed tool=Write$`) {
			t.Fatalf("no line for the write that closed the run:\n%s", traceText(repo))
		}
		if !anyLine(lines, ` phase=done .* tokens .* out=7 `) {
			t.Fatalf("the closing turn's tokens were dropped:\n%s", traceText(repo))
		}
		if anyLine(lines, ` out=3 `) {
			t.Fatalf("a turn after the run was charged to it:\n%s", traceText(repo))
		}
	})
	t.Run("a run closed from Bash leaves its line, and a read of the phase none", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{phase: "done"})
		runHook(t, "run-trace", postTool("s", "Bash", map[string]any{"command": "cat .claude/state/phase"}), repo)
		if traceText(repo) != "" {
			t.Fatalf("a read of the phase file closed the run:\n%s", traceText(repo))
		}
		runHook(t, "run-trace", postTool("s", "Bash", map[string]any{"command": "printf done > .claude/state/phase"}), repo)
		mustMatch(t, `(?m) phase=done session=s closed tool=Bash$`, traceText(repo), "no line for a run closed from Bash")
	})
	t.Run("a run is closed by each way the phase file is written, and by nothing else", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{phase: "done"})
		post := func(tool string, input map[string]any) { runHook(t, "run-trace", postTool("s", tool, input), repo) }
		post("Write", map[string]any{"file_path": filepath.Join(repo, "README.md"), "content": "x"})
		post("Read", map[string]any{"file_path": statePath(repo, "phase")})
		post("Bash", map[string]any{"command": "git status --short > /tmp/st.txt; cat .claude/state/phase"})
		if traceText(repo) != "" {
			t.Fatalf("a call that did not write the phase closed the run:\n%s", traceText(repo))
		}
		post("Bash", map[string]any{"command": "printf 'done' | tee .claude/state/phase"})
		post("Bash", map[string]any{"command": "echo done >| .claude/state/phase"})
		post("Bash", map[string]any{"command": `printf done > "/Users/First Last/My Projects/app/.claude/state/phase"`})
		post("Edit", map[string]any{"file_path": statePath(repo, "phase"), "old_string": "implement", "new_string": "done"})
		post("Write", map[string]any{"file_path": `C:\Users\someone\app\.claude\state\phase`, "content": "done"})
		post("Write", map[string]any{"filePath": statePath(repo, "phase"), "content": "done"})
		if got := allOf(`(?m) closed tool=(\S+)$`, traceText(repo)); got != "Bash,Bash,Bash,Edit,Write,Write" {
			t.Fatalf("want Bash,Bash,Bash,Edit,Write,Write, got %q:\n%s", got, traceText(repo))
		}
	})
	t.Run("a run closed after a cd into .claude/state leaves its line", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{phase: "done"})
		for _, c := range []string{"cd .claude/state && printf done > phase", "cd .claude/state/ && printf done | tee phase"} {
			runHook(t, "run-trace", postTool("s", "Bash", map[string]any{"command": c}), repo)
		}
		if n := len(regexp.MustCompile(`(?m) closed tool=Bash$`).FindAllString(traceText(repo), -1)); n != 2 {
			t.Fatalf("want two closes after a cd, got %d:\n%s", n, traceText(repo))
		}
	})
	t.Run("another session's turn after the run closed is not charged, and the closer's still is", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		a, b := filepath.Join(repo, "a.jsonl"), filepath.Join(repo, "b.jsonl")
		stop := func(session, transcript string) {
			runHook(t, "token-trace", map[string]any{"session_id": session, "hook_event_name": "Stop", "transcript_path": transcript}, repo)
		}
		write(t, a, usageEntry(100))
		stop("sa", a)
		setPhase(t, repo, "done")
		runHook(t, "run-trace", postTool("sa", "Write", phaseWrite(repo)), repo)
		write(t, b, usageEntry(50))
		stop("sb", b)
		appendTo(t, a, usageEntry(7))
		stop("sa", a)
		lines := nonEmptyLines(traceText(repo))
		if anyLine(lines, ` session=sb .*tokens`) {
			t.Fatalf("another session's turn was charged to the run:\n%s", traceText(repo))
		}
		if !anyLine(lines, ` phase=done session=sa .*tokens .* out=7 `) {
			t.Fatalf("the closing turn was not charged:\n%s", traceText(repo))
		}
	})
	// A committed `.claude/state/` is content: its log may link out (ADR-040).
	t.Run("a run closed in a repository that committed .claude/state leaves no line in it", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{phase: "done", commitPhase: true})
		shipped := "2026-01-01T00:00:00.000Z phase=done session=s closed tool=Write\n"
		write(t, statePath(repo, "run-trace.log"), shipped)
		gitQuiet(repo, "add", "-f", "--", ".claude/state/run-trace.log")
		gitQuiet(repo, "commit", "-q", "-m", "a log this repository committed")
		session := filepath.Join(repo, "sess.jsonl")
		write(t, session, usageEntry(5))
		runHook(t, "run-trace", postTool("s", "Write", phaseWrite(repo)), repo)
		runHook(t, "token-trace", map[string]any{"session_id": "s", "hook_event_name": "Stop", "transcript_path": session}, repo)
		if traceText(repo) != shipped {
			t.Fatalf("wrote into a .claude/state the repository committed:\n%s", traceText(repo))
		}
	})
}

func TestSessionStart(t *testing.T) {
	t.Run("resets a stale phase", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		age(t, statePath(repo, "phase"), 8*time.Hour)
		expectStatus(t, runHook(t, "session-start", map[string]any{}, repo), 0, "session-start")
		if p := phaseOf(repo); p != "idle" {
			t.Fatalf("phase is %q, expected idle", p)
		}
	})
	t.Run("a stale-phase reset disarms the run without forgetting where it was", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		write(t, statePath(repo, "current-milestone"), "add-users M2 abc123def4567890a")
		age(t, statePath(repo, "phase"), 8*time.Hour)
		r := runHook(t, "session-start", map[string]any{}, repo)
		expectStatus(t, r, 0, "session-start")
		if phaseOf(repo) != "idle" {
			t.Fatal("the stale phase was not disarmed")
		}
		if !exists(statePath(repo, "current-milestone")) {
			t.Fatal("the reset erased the position too, so the run is still unresumable")
		}
		mustMatch(t, `M2`, r.Stdout, "the message did not say where the run stopped")
		mustMatch(t, `add-users`, r.Stdout, "the message did not say where the run stopped")
		mustNotMatch(t, `re-run /spec-flow`, r.Stdout, "it tells the user to start over though it knows where the run was")
		mustMatch(t, `/spec-flow:resume`, r.Stdout, "it does not name the command that picks the run up (ADR-024)")
	})
	t.Run("leaves a fresh phase alone", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		runHook(t, "session-start", map[string]any{}, repo)
		if p := phaseOf(repo); p != "implement" {
			t.Fatalf("phase is %q, expected implement (untouched)", p)
		}
	})
}

// ---- the position a resume needs survives -----------------------------------

func implementerSpawn(input map[string]any, resp map[string]any) map[string]any {
	in := map[string]any{"subagent_type": "implementer"}
	for k, v := range input {
		in[k] = v
	}
	return map[string]any{"tool_name": "Agent", "tool_input": in, "tool_response": resp}
}

func TestRegisterAgentPosition(t *testing.T) {
	at := func(repo string) string { return strings.TrimSpace(read(statePath(repo, "current-milestone"))) }
	t.Run("records the milestone and session an implementer was given", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		expectStatus(t, runHook(t, "register-agent", implementerSpawn(map[string]any{"prompt": "implement specflow/add-users/milestones/M2.md per the plan"}, map[string]any{"session_id": "abc123def4567890a"}), repo), 0, "register-agent")
		if got := at(repo); got != "add-users M2 abc123def4567890a" {
			t.Fatalf("recorded %q", got)
		}
	})
	// However the session spells a path, and whether or not an id comes back.
	t.Run("records the milestone from a Windows path, and with no id in the response", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		write(t, statePath(repo, "current-milestone"), "add-users M1 abc123def4567890a")
		runHook(t, "register-agent", implementerSpawn(map[string]any{"prompt": `implement C:\repo\specflow\add-users\milestones\M2.md per the plan`}, map[string]any{"session_id": "abc123def4567890b"}), repo)
		if got := at(repo); got != "add-users M2 abc123def4567890b" {
			t.Fatalf("a backslashed path left %q", got)
		}
		runHook(t, "register-agent", implementerSpawn(map[string]any{"prompt": "implement specflow/add-users/milestones/M3.md per the plan"}, map[string]any{}), repo)
		if got := at(repo); got != "add-users M3" {
			t.Fatalf("a response with no id left %q", got)
		}
	})
	// The live view finds the agent by the milestone it read off the same spawn.
	t.Run("records the work order its prompt names, not one its description or another path names", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		spawn := func(input map[string]any) {
			runHook(t, "register-agent", implementerSpawn(input, map[string]any{}), repo)
		}
		spawn(map[string]any{"description": "redo specflow/add-users/milestones/M1.md", "prompt": "implement specflow/add-users/milestones/M2.md per the plan"})
		if got := at(repo); got != "add-users M2" {
			t.Fatalf("a description naming M1 left %q", got)
		}
		spawn(map[string]any{"prompt": "see docs/milestones/M1.md, then implement specflow/add-users/milestones/M3.md"})
		if got := at(repo); got != "add-users M3" {
			t.Fatalf("a milestone file named before the work order left %q", got)
		}
		spawn(map[string]any{"prompt": "resume, with plan.md and milestones/M4.md"})
		if got := at(repo); got != "add-users M3" {
			t.Fatalf("a work order naming no change left %q", got)
		}
	})
}

// ---- a run that cannot run here does not start (ADR-028) ---------------------

func phaseWriteBy(repo, session, content string) map[string]any {
	return map[string]any{"session_id": session, "tool_name": "Write", "tool_input": map[string]any{"file_path": statePath(repo, "phase"), "content": content}}
}

func startRun(t *testing.T, repo string) Result {
	t.Helper()
	return runHook(t, "phase-guard", phaseWriteBy(repo, "session-a", "spec"), repo)
}

func changeFolder(t *testing.T, repo, slug string) {
	t.Helper()
	write(t, filepath.Join(repo, "specflow", slug, "spec.md"), "# Spec — "+slug+"\n")
	gitQuiet(repo, "add", "-f", "--", "specflow/"+slug)
	gitQuiet(repo, "commit", "-q", "-m", "add "+slug)
}

// parkedOnBase is a change folder committed on the base, then a branch off it.
func parkedOnBase(t *testing.T, repo, slug string) {
	t.Helper()
	if slug == "" {
		slug = "parked"
	}
	changeFolder(t, repo, slug)
	gitQuiet(repo, "checkout", "-q", "-b", "feature")
}

// seedGateHistory is one gate line judging the repository's current HEAD.
func seedGateHistory(t *testing.T, repo, result string) {
	t.Helper()
	sha := git(t, repo, "rev-parse", "--short", "HEAD")
	write(t, statePath(repo, "gate-history.log"), fmt.Sprintf("2026-01-01T00:00:00Z %s cc=? engine=smoke phase=implement attempt=0 result=%s lint=0 test=0 spec=0 files=1\n", sha, result))
}

func TestPhaseGuardStart(t *testing.T) {
	t.Run("refuses the write that starts a run where the engine cannot run, and leaves nothing armed", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{noContract: true, phase: " "})
		r := startRun(t, repo)
		expectStatus(t, r, 2, "a run was started in a repository with no contract")
		mustMatch(t, `Nothing has started`, r.Stderr, "the denial does not say that nothing is armed")
		if exists(statePath(repo, "phase.session")) {
			t.Fatal("a refused start sealed the phase to the session anyway")
		}
	})
	// A start that skips the seal is a run no gate owns (ADR-017).
	t.Run("lets a run start where the engine can run, and seals it", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{phase: " "})
		expectStatus(t, startRun(t, repo), 0, "a valid repository was refused a run")
		if read(statePath(repo, "phase.session")) != "session-a" {
			t.Fatal("the start of a run was not sealed to the session that wrote it")
		}
	})
	// From idle it would be a run nobody started and no gate capped.
	t.Run("denies blocked outside a run too: it is the gate's alone", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{noContract: true, phase: " "})
		expectStatus(t, runHook(t, "phase-guard", phaseWriteBy(repo, "", "blocked"), repo), 2, "a tool wrote blocked from idle")
	})
	// ---- a change the base branch already has is not this run's (ADR-032)
	t.Run("refuses to start a run over a change the base branch already has", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{phase: " "})
		parkedOnBase(t, repo, "")
		r := startRun(t, repo)
		expectStatus(t, r, 2, "a run started with specflow/parked/ inherited from the base")
		mustMatch(t, `specflow/parked/`, r.Stderr, "the refusal does not name the folder")
		mustNotMatch(t, `spec-flow init`, r.Stderr, "the refusal sends the human to init, which fixes nothing here")
	})
	t.Run("lets a run start over a change this branch created, the one a resume picks up", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{phase: " "})
		gitQuiet(repo, "checkout", "-q", "-b", "feature")
		changeFolder(t, repo, "mine")
		expectStatus(t, startRun(t, repo), 0, "a resume of this branch's own change was refused")
	})
	// git quotes a non-ASCII name; read quoted, the base's folder matches nothing.
	t.Run("refuses to start over a change the base has under a non-ASCII name", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{phase: " "})
		parkedOnBase(t, repo, "añadir-exportación")
		expectStatus(t, startRun(t, repo), 2, "a run started over specflow/añadir-exportación/ inherited from the base")
	})
	// A setting a hook would refuse mid-run is refused before anything is armed.
	for _, c := range [][3]string{
		{"a cap that is not a whole number of calls", `{"max_architect_calls":"three"}`, "max_architect_calls"},
		{"a cap of null", `{"max_opus_calls":null}`, "max_opus_calls"},
		{"a file that does not parse", `{ "max_opus_calls": 2, }`, "does not parse as JSON"},
		{"a route to an agent this plugin does not ship", `{"agents":{"plannr":"sonnet"}}`, "plannr"},
	} {
		t.Run("refuses to start over "+c[0], func(t *testing.T) {
			repo := makeRepo(t, repoOpts{phase: " "})
			write(t, filepath.Join(repo, ".claude", "spec-flow.config.json"), c[1])
			r := startRun(t, repo)
			expectStatus(t, r, 2, "a run started over "+c[0])
			if !strings.Contains(r.Stderr, c[2]) {
				t.Fatalf("the refusal does not name what to fix: %s", r.Stderr)
			}
			mustNotMatch(t, `spec-flow init`, r.Stderr, "the refusal sends the human to init, which does not write this file")
			if exists(statePath(repo, "phase.session")) {
				t.Fatal("a refused start sealed the phase anyway")
			}
		})
	}
	t.Run("refuses to start over a settings file it cannot read", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{phase: " "})
		os.MkdirAll(filepath.Join(repo, ".claude", "spec-flow.config.json"), 0o755)
		r := startRun(t, repo)
		expectStatus(t, r, 2, "a run started over a settings file no hook can read")
		mustMatch(t, `could not be read`, r.Stderr, "the refusal does not say the file could not be read")
	})
	t.Run("lets a run start with caps and a routing every hook can apply", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{phase: " "})
		write(t, filepath.Join(repo, ".claude", "spec-flow.config.json"), "\xef\xbb\xbf"+`{"max_opus_calls":"4","max_architect_calls":0,"agents":{"architect":"fable"}}`)
		expectStatus(t, startRun(t, repo), 0, "a run was refused over settings every hook applies")
	})
	t.Run("leaves the phase file's siblings alone", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		r := runHook(t, "phase-guard", map[string]any{"tool_name": "Write", "tool_input": map[string]any{"file_path": statePath(repo, "phase.session"), "content": "abc123def456"}}, repo)
		expectStatus(t, r, 0, "a write to phase.session was judged as a phase write")
	})
	// A start this hook cannot read goes through to preflight (ADR-028); the
	// blind-spot log says the guard was bypassed, outside a run too.
	t.Run("records a start it could not read", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{noContract: true, phase: " "})
		runHook(t, "phase-guard", bash("printf 'spec' | tee .claude/state/phase"), repo)
		if !strings.Contains(read(statePath(repo, "phase-guard-unmatched.log")), "tee") {
			t.Fatal("an unreadable start left no line in phase-guard-unmatched.log")
		}
	})
}

// Fix (b): the value is read as the shell writes it and readPhase reads it
// back — printf's escapes applied, trimmed. Fails on the JavaScript engine:
// `printf 'spec\n'` started a run with no contract, and `printf 'done\n'` was
// denied as an unknown phase instead of being judged as `done`.
func TestPhaseGuardReadsTheValueTheShellWrites(t *testing.T) {
	t.Run("a start written with a trailing newline is refused where the engine cannot run", func(t *testing.T) {
		for _, c := range []string{`printf 'spec\n' > .claude/state/phase`, `printf "spec\n" > .claude/state/phase`, `echo -e 'spec\n' > .claude/state/phase`} {
			repo := makeRepo(t, repoOpts{noContract: true, noGit: true, phase: "idle"})
			r := runHook(t, "phase-guard", map[string]any{"tool_name": "Bash", "tool_input": map[string]any{"command": c}}, repo)
			expectStatus(t, r, 2, c+" started a run the engine cannot run")
			mustMatch(t, `Nothing has started`, r.Stderr, "not refused as a start")
		}
	})
	t.Run("a done written with a trailing newline is judged as done", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		seedGateHistory(t, repo, "fail:behaviour")
		r := runHook(t, "phase-guard", bash(`printf 'done\n' > .claude/state/phase`), repo)
		expectStatus(t, r, 2, "an unearned done went through")
		mustMatch(t, `gate has not passed`, r.Stderr, "it was not judged as a done")
		mustNotMatch(t, `not a phase this engine knows`, r.Stderr, "it was denied as an unknown phase")
	})
	t.Run("a literal backslash bash echo writes is not a phase", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{noContract: true, noGit: true, phase: "idle"})
		r := runHook(t, "phase-guard", bash(`echo 'spec\n' > .claude/state/phase`), repo)
		expectStatus(t, r, 0, "bash's echo writes `spec\\n` literally, which arms nothing")
	})
}

func TestSettingsMidRun(t *testing.T) {
	// Mid-run each hook applies what it can (ADR-028, ADR-049).
	repo := makeRepo(t, repoOpts{})
	cfg := filepath.Join(repo, ".claude", "spec-flow.config.json")
	write(t, cfg, `{ "max_opus_calls": 8, }`)
	for _, agent := range []string{"spec-flow:implementer", "Explore"} {
		expectStatus(t, runHook(t, "preflight", map[string]any{"tool_name": "Agent", "tool_input": map[string]any{"subagent_type": agent}}, repo), 0, "preflight denied "+agent+" over a file every hook reads as the defaults")
	}
	expectStatus(t, runHook(t, "opus-budget", map[string]any{"tool_name": "Agent", "tool_input": map[string]any{"subagent_type": "planner"}}, repo), 0, "the planner was denied under the default cap")
	write(t, cfg, `{"max_architect_calls":"three"}`)
	expectStatus(t, runHook(t, "preflight", map[string]any{"tool_name": "Agent", "tool_input": map[string]any{"subagent_type": "Explore"}}, repo), 0, "preflight denied an unrelated agent over the architect's cap")
	expectStatus(t, runHook(t, "opus-budget", map[string]any{"tool_name": "Agent", "tool_input": map[string]any{"subagent_type": "architect"}}, repo), 2, "the architect went through under a cap no count can reach")
}

func TestPreflightOverAChangeTheBaseHas(t *testing.T) {
	t.Run("refuses a spawn while a change the base branch has is live", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{phase: "plan"})
		parkedOnBase(t, repo, "")
		r := runHook(t, "preflight", map[string]any{"tool_name": "Agent", "tool_input": map[string]any{"subagent_type": "planner"}}, repo)
		expectStatus(t, r, 2, "a spawn went through with specflow/parked/ from the base live")
		mustMatch(t, `a change the base branch already has`, r.Stderr, "the refusal is not headed with what failed")
	})
	t.Run("past a run's first agent says how to pick the run up", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		parkedOnBase(t, repo, "")
		r := runHook(t, "preflight", map[string]any{"tool_name": "Agent", "tool_input": map[string]any{"subagent_type": "implementer"}}, repo)
		expectStatus(t, r, 2, "a spawn went through with specflow/parked/ from the base live")
		mustMatch(t, `/spec-flow:resume`, r.Stderr, "a run under way is told only to start again")
		mustNotMatch(t, `(?m)^Nothing has run yet`, r.Stderr, "it says nothing has run, mid-run")
	})
}

func phaseBash(value string) map[string]any {
	return bash("printf '" + value + "' > .claude/state/phase")
}

// shippedExport: this branch ships add-export, ADDING REQ-USER-002; specs/
// declares ids, and a test ran for each.
func shippedExport(t *testing.T, repo string, ids ...string) Result {
	t.Helper()
	gitQuiet(repo, "checkout", "-q", "-b", "feature")
	ops := []string{}
	var heads strings.Builder
	for _, id := range ids {
		ops = append(ops, "out=tests/user.spec.ts::"+id+" x")
		heads.WriteString("### " + id + " — a thing\n\n")
	}
	editContract(t, repo, func(c map[string]any) { sub(c, "trace")["executed_tests"] = toAny(toolCmd(ops...)) })
	write(t, filepath.Join(repo, "specs", "user.md"), "<!-- spec-scope: modules/user -->\n\n# User\n\n"+heads.String())
	write(t, filepath.Join(repo, "specflow", "archive", "add-export", "spec.md"), "# Spec — add export\n\n**Status:** SHIPPED 2026-10-17\n\n## Requirement deltas\n- ADDED REQ-USER-002 — the user can export their data\n")
	seedGateHistory(t, repo, "pass")
	return runHook(t, "phase-guard", phaseWriteBy(repo, "", "done"), repo)
}

func TestPhaseGuardVocabularyAndDone(t *testing.T) {
	t.Run("done refusal says a change the base branch has is not this run's to fold", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		parkedOnBase(t, repo, "")
		seedGateHistory(t, repo, "pass")
		r := runHook(t, "phase-guard", phaseWriteBy(repo, "", "done"), repo)
		expectStatus(t, r, 2, "done was allowed over an unarchived change")
		if !strings.Contains(r.Stderr, "parked (the base branch has it: not this run's change)") {
			t.Fatalf("the refusal does not say the folder is not this run's: %s", r.Stderr)
		}
	})
	// spec-trace binds only what specs/ declares (ADR-048).
	t.Run("refuses done over a SHIPPED change of this branch whose ADDED id never reached specs/", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		r := shippedExport(t, repo, "REQ-USER-001")
		expectStatus(t, r, 2, "done was allowed over a shipped requirement no spec declares")
		if !strings.Contains(r.Stderr, "REQ-USER-002 is ADDED by specflow/archive/add-export/spec.md") {
			t.Fatalf("the refusal does not name the id and the change: %s", r.Stderr)
		}
	})
	t.Run("allows done once the ADDED id is in specs/ with a test that ran", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		expectStatus(t, shippedExport(t, repo, "REQ-USER-001", "REQ-USER-002"), 0, "a run whose shipped requirement is declared and proven was refused")
	})
	t.Run("denies a phase outside the closed set", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		r := runHook(t, "phase-guard", phaseBash("triage"), repo)
		expectStatus(t, r, 2, "an invented phase was allowed")
		mustMatch(t, `(?i)closed set`, r.Stderr, "the denial does not explain the vocabulary")
	})
	t.Run("denies an invented phase written with Write, not just Bash", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		expectStatus(t, runHook(t, "phase-guard", phaseWriteBy(repo, "", "verify"), repo), 2, "a Write of an unknown phase was allowed")
	})
	t.Run("allows every phase the orchestrator writes mid-run", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		for _, v := range []string{"spec", "plan", "review", "implement"} {
			expectStatus(t, runHook(t, "phase-guard", phaseBash(v), repo), 0, v+" is in the vocabulary and was denied")
		}
	})
	t.Run("does not deny a command that merely reads the phase file", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		expectStatus(t, runHook(t, "phase-guard", bash("cat .claude/state/phase"), repo), 0, "reading the phase file was denied")
	})
	// The blind spot it cannot see into, made observable — the program, never its content.
	t.Run("lets an unreadable write through and records that it did", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		expectStatus(t, runHook(t, "phase-guard", bash("printf 'done' | tee .claude/state/phase"), repo), 0, "a form the guard cannot read was denied")
		body := read(statePath(repo, "phase-guard-unmatched.log"))
		mustMatch(t, `\btee\b`, body, "the log does not name what got past")
		mustNotMatch(t, `done`, body, "the log captured the command's content")
	})
	t.Run("does not record a command that only reads the phase file", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		for _, c := range []string{"cat .claude/state/phase", "cat .claude/state/phase | grep implement"} {
			runHook(t, "phase-guard", bash(c), repo)
		}
		mustNotMatch(t, `\bcat\b`, read(statePath(repo, "phase-guard-unmatched.log")), "a read was logged as an unreadable write")
	})
	t.Run("denies done with an unarchived specflow folder", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		os.MkdirAll(filepath.Join(repo, "specflow", "my-change"), 0o755)
		r := runHook(t, "phase-guard", phaseBash("done"), repo)
		expectStatus(t, r, 2, "done with an unarchived folder")
		mustMatch(t, `unarchived`, r.Stderr, "no unarchived in the denial")
	})
	t.Run("allows an earned done", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		seedGateHistory(t, repo, "pass")
		expectStatus(t, runHook(t, "phase-guard", phaseBash("done"), repo), 0, "an earned done was denied")
	})
	// ---- a run does not end itself without a verdict (ADR-022)
	t.Run("denies done while the gate has not passed the current commit", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		seedGateHistory(t, repo, "fail:behaviour")
		r := runHook(t, "phase-guard", phaseBash("done"), repo)
		expectStatus(t, r, 2, "done was allowed over a commit whose last verdict was fail:behaviour")
		mustMatch(t, `gate has not passed`, r.Stderr, "the denial does not say what is missing")
	})
	// After a `cd` the file is named relative to it, which the reader never matched.
	t.Run("reads a phase write made after a cd", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		seedGateHistory(t, repo, "fail:behaviour")
		for _, c := range []string{
			"cd .claude/state && printf done > phase",
			"cd .claude; echo done > state/phase",
			"cd .claude && cd state && printf done > phase",
			"cd .claude/state && printf 'done' > ./phase",
			"cd .claude/state/ && printf done > phase",
			"cd .claude/ && printf done > state/phase",
			`cd "$CLAUDE_PROJECT_DIR"/.claude/state && printf done > phase`,
			"cd ${CLAUDE_PROJECT_DIR}/.claude/state/ && printf done > phase",
			`cd ".claude/state" && printf done > phase`,
			"(cd .claude/state && printf done > phase)",
			`cd "My Projects/app/.claude/state" && printf done > phase`,
			"cd .claude/state || exit 1; printf done > phase",
			"cd .claude/state\nprintf done > phase",
			`printf done > "/Users/First Last/app/.claude/state/phase"`,
			"echo done >| .claude/state/phase",
		} {
			expectStatus(t, runHook(t, "phase-guard", bash(c), repo), 2, "`"+c+"` wrote an unearned done")
		}
	})
}
