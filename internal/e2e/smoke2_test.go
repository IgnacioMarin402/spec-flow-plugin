package e2e

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
	"time"
)

func gateReturn(t *testing.T, repo string, extra map[string]any) Result {
	t.Helper()
	return runHook(t, "agent-gate", subagentStop(extra), repo)
}

func writeChange(t *testing.T, repo, body string, proposal bool, slug string) {
	t.Helper()
	if slug == "" {
		slug = "my-change"
	}
	write(t, filepath.Join(repo, "specflow", slug, "spec.md"), body)
	if proposal {
		write(t, filepath.Join(repo, "specflow", slug, "proposal.md"), "# Proposal — x\n")
	}
}

// ---- agent-gate: a return the orchestrator cannot route is sent back (ADR-031)

func TestAgentGate(t *testing.T) {
	review := repoOpts{phase: "review"}
	t.Run("sends back a first reply with no STATUS, and an undeclared status", func(t *testing.T) {
		repo := makeRepo(t, review)
		for _, c := range [][2]string{{"Looks fine to me.", "no-status"}, {"STATUS: SPEC_READY", "undeclared-status"}} {
			r := gateReturn(t, repo, map[string]any{"agent_id": "a-" + c[1], "last_assistant_message": c[0]})
			if r.Status != 0 || !r.Blocked() {
				t.Fatalf("%q was not sent back (exit %d): %s", c[0], r.Status, r.Out())
			}
			mustMatch(t, "agent-check agent=spec-flow:reviewer result=block why="+c[1]+" agent_id=a-"+c[1], traceText(repo), "no agent-check line")
		}
	})
	t.Run("lets an empty reply through and records it", func(t *testing.T) {
		repo := makeRepo(t, review)
		if r := gateReturn(t, repo, map[string]any{"last_assistant_message": ""}); r.Blocked() {
			t.Fatalf("an empty reply was sent back: %s", r.Stdout)
		}
		mustMatch(t, `result=skip why=empty`, traceText(repo), "no skip line")
	})
	t.Run("lets a resumed agent answer in prose", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{phase: "implement"})
		write(t, statePath(repo, "run-trace.log"), "2026-01-01T00:00:00Z phase=implement agent type=spec-flow:implementer status=IMPLEMENTED agent_id=impl1\n")
		if r := gateReturn(t, repo, map[string]any{"agent_type": "spec-flow:implementer", "agent_id": "impl1", "last_assistant_message": "Fixed both lint violations in lib/a.ts."}); r.Blocked() {
			t.Fatalf("a resumed implementer's prose answer was sent back: %s", r.Stdout)
		}
	})
	t.Run("reads a status and a path the way a model decorates them", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{phase: "plan"})
		write(t, filepath.Join(repo, "specflow", "x", "plan.md"), "# Plan\n")
		for i, reply := range []string{
			"**STATUS:** PLAN_READY\n**PLAN_PATH:** specflow/x/plan.md",
			"STATUS: PLAN_READY\nPLAN_PATH: specflow/x/plan.md (index + 3 milestones)",
			"STATUS: PLAN_READY\nPLAN_PATH: [plan.md](specflow/x/plan.md)",
			"Round two; the last one ended with STATUS: NEEDS_INPUT.\n\nSTATUS: PLAN_READY\nPLAN_PATH: `specflow/x/plan.md`",
		} {
			if r := gateReturn(t, repo, map[string]any{"agent_type": "spec-flow:planner", "agent_id": fmt.Sprintf("p%d", i), "last_assistant_message": reply}); r.Blocked() {
				t.Fatalf("a well-formed return was sent back: %q -> %s", reply, r.Stdout)
			}
		}
	})
	t.Run("sends back a path to a file that is not there, and passes one that is", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{phase: "plan"})
		plan := map[string]any{"agent_type": "spec-flow:planner", "last_assistant_message": "```\nSTATUS: PLAN_READY\nPLAN_PATH: specflow/x/plan.md\n```"}
		if r := gateReturn(t, repo, plan); !r.Blocked() || !strings.Contains(r.Stdout, "PLAN_PATH") {
			t.Fatalf("a missing PLAN_PATH was not sent back: %s", r.Stdout)
		}
		write(t, filepath.Join(repo, "specflow", "x", "plan.md"), "# Plan\n")
		plan["agent_id"] = "another-agent"
		if r := gateReturn(t, repo, plan); r.Blocked() {
			t.Fatalf("an existing PLAN_PATH was sent back: %s", r.Stdout)
		}
	})
	t.Run("passes a declared status and writes nothing", func(t *testing.T) {
		repo := makeRepo(t, review)
		r := gateReturn(t, repo, map[string]any{"last_assistant_message": "STATUS: APPROVED\nNOTES: none"})
		if r.Status != 0 || r.Stdout != "" {
			t.Fatalf("a declared status was not let through (exit %d): %s", r.Status, r.Stdout)
		}
		mustNotMatch(t, `agent-check`, traceText(repo), "a clean return left a line")
	})
	t.Run("sends an agent back at most twice, then lets it through and says so", func(t *testing.T) {
		repo := makeRepo(t, review)
		for n := 1; n <= 2; n++ {
			if !gateReturn(t, repo, map[string]any{"last_assistant_message": "no block"}).Blocked() {
				t.Fatalf("block %d did not happen", n)
			}
		}
		if gateReturn(t, repo, map[string]any{"last_assistant_message": "no block", "stop_hook_active": true}).Blocked() {
			t.Fatal("a third stop was sent back: the cap is two")
		}
		mustMatch(t, `result=cap why=no-status`, traceText(repo), "the cap left no line")
	})
	t.Run("with no agent id blocks only a first stop", func(t *testing.T) {
		repo := makeRepo(t, review)
		noID := func(extra map[string]any) Result {
			p := subagentStop(extra)
			delete(p, "agent_id")
			return runHook(t, "agent-gate", p, repo)
		}
		if !noID(map[string]any{"last_assistant_message": "STATUS: SPEC_READY"}).Blocked() {
			t.Fatal("a first stop was let through")
		}
		if noID(map[string]any{"last_assistant_message": "STATUS: SPEC_READY", "stop_hook_active": true}).Blocked() {
			t.Fatal("a stop the hook already continued was sent back again, with nothing to count blocks by")
		}
		if noID(map[string]any{"last_assistant_message": "prose"}).Blocked() {
			t.Fatal("prose with no agent id was judged as a first reply")
		}
	})
	// ADR-017 keeps the owner check to hooks certain to run in the sealing session.
	t.Run("judges a return whatever session sealed the phase", func(t *testing.T) {
		repo := makeRepo(t, review)
		write(t, statePath(repo, "phase.session"), "someone-else")
		if !gateReturn(t, repo, map[string]any{"last_assistant_message": "STATUS: SPEC_READY"}).Blocked() {
			t.Fatal("the owner seal stood the agent gate down")
		}
	})
	t.Run("leaves alone another plugin's agent, and a return outside a run", func(t *testing.T) {
		repo := makeRepo(t, review)
		for _, typ := range []string{"spec-writer", "other:reviewer", "spec-flow:nobody"} {
			if gateReturn(t, repo, map[string]any{"agent_type": typ, "last_assistant_message": "prose"}).Blocked() {
				t.Fatalf("%s was judged against spec-flow's contracts", typ)
			}
		}
		setPhase(t, repo, "idle")
		if gateReturn(t, repo, map[string]any{"last_assistant_message": "prose"}).Blocked() {
			t.Fatal("a return outside any run was sent back")
		}
	})
	t.Run("that crashes lets the return through", func(t *testing.T) {
		repo := makeRepo(t, review)
		engine := copyEngine(t)
		os.Remove(filepath.Join(engine, "agents", "reviewer.md"))
		os.MkdirAll(filepath.Join(engine, "agents", "reviewer.md"), 0o755) // reading it fails
		r := Hook{Engine: engine}.run(t, "agent-gate", subagentStop(map[string]any{"last_assistant_message": "prose"}), repo)
		mustMatch(t, `hook error`, r.Stderr, "the crash path was not reached")
		if r.Status != 0 || r.Blocked() {
			t.Fatalf("a crash blocked the agent (exit %d): %s", r.Status, r.Stdout)
		}
	})
}

// ---- agent-gate: what a spec-writer hands back (ADR-030) ------------------

func writerSpec(deltas string) string {
	return "# Spec — my-change: x\n\n## Requirement deltas\n" + deltas + "\n\n## Assumptions\n- none\n\n## Out of scope\n- nothing\n"
}

func specReady(extra map[string]any) map[string]any {
	p := map[string]any{"agent_type": "spec-flow:spec-writer", "agent_id": "writer1",
		"last_assistant_message": "```\nSTATUS: SPEC_READY\nSPEC_PATH: specflow/my-change/spec.md\nPROPOSAL_PATH: specflow/my-change/proposal.md\nSUMMARY: x\n```"}
	for k, v := range extra {
		p[k] = v
	}
	return p
}

// writerRepo is specs/ with its contract and one capability, and the change.
func writerRepo(t *testing.T, repo, deltas string) {
	t.Helper()
	if deltas == "" {
		deltas = "- ADDED REQ-USER-002 — another thing"
	}
	write(t, filepath.Join(repo, "specs", "README.md"), "# specs\n")
	write(t, filepath.Join(repo, "specs", "user.md"), "<!-- spec-scope: lib/user -->\n### REQ-USER-001 — a thing\n")
	writeChange(t, repo, writerSpec(deltas), true, "")
}

func readBy(t *testing.T, repo, agentID string, files ...string) {
	t.Helper()
	var b strings.Builder
	for _, f := range files {
		fmt.Fprintf(&b, "2026-01-01T00:00:00Z phase=spec session=spawner-session read file=%s agent_id=%s\n", filepath.Join(repo, f), agentID)
	}
	write(t, statePath(repo, "run-trace.log"), b.String())
}

const (
	triagedCase3 = "STATUS: TRIAGED\nCASE: 3\nSPEC_PATH: specflow/my-change/spec.md"
	workOrder    = "\nPLAN_PATH: specflow/my-change/plan.md\nWORK_ORDER_PATH: specflow/my-change/milestones/M1.md"
)

// writeFix is a fix brief and the work order its triage writes (ADR-033).
func writeFix(t *testing.T, repo string, withOrder bool) {
	t.Helper()
	writeChange(t, repo, "# Fix — my-change\n\n## Case\n3 SPEC-WRONG\n\n## Requirement deltas\n- CHANGED REQ-USER-001 (correction) — now right\n", false, "")
	if withOrder {
		write(t, filepath.Join(repo, "specflow", "my-change", "plan.md"), "# Plan — my-change\n")
		write(t, filepath.Join(repo, "specflow", "my-change", "milestones", "M1.md"), "# M1\n- Skills: none\n")
	}
}

func retriage(t *testing.T, repo string) Result {
	t.Helper()
	writerRepo(t, repo, "")
	writeChange(t, repo, "# Fix — my-change\n\n## Case\n2 WEAK-TEST\n\n## Requirement deltas\n- none — the test was incomplete\n", false, "")
	write(t, filepath.Join(repo, "specflow", "my-change", "plan.md"), "# Plan\n\none milestone: M1\n")
	write(t, filepath.Join(repo, "specflow", "my-change", "milestones", "M1.md"), "# M1\n")
	write(t, filepath.Join(repo, "specflow", "archive", "My-Change", "spec.md"), "# Fix — My-Change\n\n**Status:** REJECTED 2026-07-30\n\n## Requirement deltas\n- none\n")
	return gateReturn(t, repo, map[string]any{"agent_type": "spec-flow:spec-writer",
		"last_assistant_message": "STATUS: TRIAGED\nCASE: 2 WEAK-TEST\nSPEC_PATH: specflow/my-change/spec.md\nPLAN_PATH: specflow/my-change/plan.md\nWORK_ORDER_PATH: specflow/my-change/milestones/M1.md"})
}

func TestAgentGateSpecWriter(t *testing.T) {
	spec := repoOpts{phase: "spec"}
	t.Run("holds a NEEDS_INPUT round to one to three questions, options not counted", func(t *testing.T) {
		repo := makeRepo(t, spec)
		ask := func(items ...string) Result {
			return gateReturn(t, repo, map[string]any{"agent_type": "spec-flow:spec-writer", "agent_id": fmt.Sprintf("w%d", len(items)), "last_assistant_message": "STATUS: NEEDS_INPUT\nOPEN_QUESTIONS:\n" + strings.Join(items, "\n")})
		}
		if r := ask("- a?", "- b?", "- c?", "- d?"); !r.Blocked() || !strings.Contains(r.Stdout, "at most 3") {
			t.Fatalf("four questions were let through: %s", r.Stdout)
		}
		if !ask().Blocked() {
			t.Fatal("a NEEDS_INPUT with no question was let through")
		}
		if r := ask("- a?", "  - (1) this", "  - (2) that", "- b?", "- c?"); r.Blocked() {
			t.Fatalf("three questions with options were sent back: %s", r.Stdout)
		}
	})
	t.Run("sends back a SPEC_READY whose spec phase-guard would not let leave spec", func(t *testing.T) {
		repo := makeRepo(t, spec)
		writerRepo(t, repo, "")
		writeChange(t, repo, strings.Replace(writerSpec("- ADDED REQ-USER-002 — x"), "## Assumptions\n- none\n\n", "", 1), true, "")
		readBy(t, repo, "writer1", "specs/README.md", "specs/user.md")
		if r := gateReturn(t, repo, specReady(nil)); !r.Blocked() || !strings.Contains(r.Stdout, "## Assumptions") {
			t.Fatalf("a spec with no Assumptions was let through: %s", r.Stdout)
		}
	})
	t.Run("sends back a CHANGED or REMOVED on an id specs/ never declared", func(t *testing.T) {
		repo := makeRepo(t, spec)
		writerRepo(t, repo, "- CHANGED REQ-USER-009 (wording) — clearer\n- REMOVED REQ-USER-001 — gone")
		readBy(t, repo, "writer1", "specs/README.md", "specs/user.md")
		r := gateReturn(t, repo, specReady(nil))
		if !r.Blocked() || !strings.Contains(r.Stdout, "CHANGED REQ-USER-009") {
			t.Fatalf("an unknown CHANGED id was let through: %s", r.Stdout)
		}
		mustNotMatch(t, `REMOVED REQ-USER-001`, r.Stdout, "a declared REMOVED id was reported")
	})
	t.Run("sends back a SPEC_READY written without reading the capability its deltas touch", func(t *testing.T) {
		repo := makeRepo(t, spec)
		writerRepo(t, repo, "")
		readBy(t, repo, "writer1", "specs/README.md")
		if r := gateReturn(t, repo, specReady(nil)); !r.Blocked() || !strings.Contains(r.Stdout, "specs/user.md") || strings.Contains(r.Stdout, "README") {
			t.Fatalf("the unread capability was not the one named: %s", r.Stdout)
		}
		readBy(t, repo, "writer1", "specs/README.md", "specs/user.md")
		if r := gateReturn(t, repo, specReady(nil)); r.Blocked() {
			t.Fatalf("a spec-writer that read both was sent back: %s", r.Stdout)
		}
	})
	// token-trace takes agent ids from transcript names, not tool payloads.
	t.Run("does not take a token line as proof that reads are attributed", func(t *testing.T) {
		repo := makeRepo(t, spec)
		writerRepo(t, repo, "")
		write(t, statePath(repo, "run-trace.log"), "2026-01-01T00:00:00Z phase=spec read file="+filepath.Join(repo, "specs/user.md")+"\n"+
			"2026-01-01T00:00:01Z phase=spec tokens model=m sidechain=true in=1 out=1 cache_read=0 cache_write=0 think=0 msgs=1 max_prompt=2 agent_id=writer1\n")
		if r := gateReturn(t, repo, specReady(nil)); r.Blocked() {
			t.Fatalf("reads with no agent id were judged: %s", r.Stdout)
		}
	})
	t.Run("does not demand a read of another capability for a new one", func(t *testing.T) {
		repo := makeRepo(t, spec)
		writerRepo(t, repo, "- ADDED REQ-USER-PROFILE-001 — a profile")
		readBy(t, repo, "writer1", "specs/README.md")
		if r := gateReturn(t, repo, specReady(nil)); r.Blocked() {
			t.Fatalf("specs/user.md was demanded for REQ-USER-PROFILE-001: %s", r.Stdout)
		}
	})
	t.Run("lets a case 5 brief through: it is rejected, not built", func(t *testing.T) {
		repo := makeRepo(t, spec)
		writerRepo(t, repo, "")
		writeChange(t, repo, "# Fix — my-change\n\n## Case\n5 NOT-A-FIX\n\n## Requirement deltas\n- CHANGED REQ-USER-001 — would stop cascading\n", false, "")
		if r := gateReturn(t, repo, map[string]any{"agent_type": "spec-flow:spec-writer", "last_assistant_message": "STATUS: TRIAGED\nCASE: 5 NOT-A-FIX\nSPEC_PATH: specflow/my-change/spec.md"}); r.Blocked() {
			t.Fatalf(`a case 5 brief was held to "ready to build": %s`, r.Stdout)
		}
	})
	t.Run("sends back a case 5 brief named like an archived change", func(t *testing.T) {
		repo := makeRepo(t, spec)
		writerRepo(t, repo, "")
		writeChange(t, repo, "# Fix — my-change\n\n## Case\n5 NOT-A-FIX\n\n## Requirement deltas\n- none\n", false, "")
		write(t, filepath.Join(repo, "specflow", "archive", "my-change", "spec.md"), "# Fix — my-change\n\n**Status:** REJECTED 2026-07-30\n\n## Requirement deltas\n- none\n")
		r := gateReturn(t, repo, map[string]any{"agent_type": "spec-flow:spec-writer", "last_assistant_message": "STATUS: TRIAGED\nCASE: 5 NOT-A-FIX\nSPEC_PATH: specflow/my-change/spec.md"})
		if !r.Blocked() || !strings.Contains(r.Stdout, "has the name of an archived change") {
			t.Fatalf("a case 5 the orchestrator would archive inside another change went through: %s", r.Stdout)
		}
	})
	// A re-triage mid-run works on the folder the run's milestone names.
	t.Run("does not send a re-triage mid-run to rename the folder its milestone names", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{phase: "implement"})
		if r := retriage(t, repo); r.Blocked() {
			t.Fatalf("a re-triage during implement was sent back: %s", r.Stdout)
		}
	})
	t.Run("sends back a triage in spec named like an archived change", func(t *testing.T) {
		repo := makeRepo(t, spec)
		if r := retriage(t, repo); !r.Blocked() || !strings.Contains(r.Stdout, "has the name of an archived change") {
			t.Fatalf("a brief the fold would move inside another change went through: %s", r.Stdout)
		}
	})
	t.Run("does not judge reads it cannot attribute, and says so", func(t *testing.T) {
		repo := makeRepo(t, spec)
		writerRepo(t, repo, "")
		write(t, statePath(repo, "run-trace.log"), "2026-01-01T00:00:00Z phase=spec read file="+filepath.Join(repo, "specs/README.md")+"\n")
		if r := gateReturn(t, repo, specReady(nil)); r.Blocked() {
			t.Fatalf("unattributed reads were judged: %s", r.Stdout)
		}
		mustMatch(t, `agent-check agent=spec-flow:spec-writer result=skip why=unattributed`, traceText(repo), "no skip line")
	})
	t.Run("lets a ready fix brief through without the reads or the assumptions a change spec owes", func(t *testing.T) {
		repo := makeRepo(t, spec)
		writerRepo(t, repo, "")
		writeFix(t, repo, true)
		readBy(t, repo, "someone-else", "specs/README.md")
		if r := gateReturn(t, repo, map[string]any{"agent_type": "spec-flow:spec-writer", "last_assistant_message": triagedCase3 + workOrder}); r.Blocked() {
			t.Fatalf("a ready fix brief was sent back: %s", r.Stdout)
		}
	})
	// The orchestrator writing the work order would read the code again (ADR-033).
	t.Run("sends back a triage of case 1 to 4 that names no work order", func(t *testing.T) {
		repo := makeRepo(t, spec)
		writerRepo(t, repo, "")
		writeFix(t, repo, true)
		r := gateReturn(t, repo, map[string]any{"agent_type": "spec-flow:spec-writer", "last_assistant_message": triagedCase3})
		if !r.Blocked() || !strings.Contains(r.Stdout, "PLAN_PATH") || !strings.Contains(r.Stdout, "WORK_ORDER_PATH") {
			t.Fatalf("a triage with no work order went through, or the reason does not name both lines: %s", r.Stdout)
		}
	})
	t.Run("sends back a triage naming a work order that is not on disk", func(t *testing.T) {
		repo := makeRepo(t, spec)
		writerRepo(t, repo, "")
		writeFix(t, repo, false)
		if !gateReturn(t, repo, map[string]any{"agent_type": "spec-flow:spec-writer", "last_assistant_message": triagedCase3 + workOrder}).Blocked() {
			t.Fatal("a triage naming files it never wrote went through")
		}
	})
}

func jsonl(entries ...any) string {
	var b strings.Builder
	for _, e := range entries {
		b.WriteString(toJSON(e) + "\n")
	}
	return b.String()
}

func assistantText(text string) map[string]any {
	return map[string]any{"type": "assistant", "message": map[string]any{"content": []any{map[string]any{"type": "text", "text": text}}}}
}

func handback(message string) map[string]any {
	return map[string]any{"type": "assistant", "message": map[string]any{"content": []any{map[string]any{"type": "tool_use", "name": "SubagentHandback", "input": map[string]any{"message": message}}}}}
}

// lateHandback is a stop whose handback line lands after the stop fires
// (ADR-050), appended by someone else while the hook runs.
func lateHandback(t *testing.T, transcript, message string, after time.Duration) {
	t.Helper()
	write(t, transcript, jsonl(assistantText("working")))
	timer := time.AfterFunc(after, func() {
		f, err := os.OpenFile(transcript, os.O_APPEND|os.O_WRONLY, 0o644)
		if err == nil {
			f.WriteString(jsonl(handback(message)))
			f.Close()
		}
	})
	t.Cleanup(func() { timer.Stop() })
}

func TestRunTraceReturns(t *testing.T) {
	t.Run("logs a subagent STATUS", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		expectStatus(t, runHook(t, "run-trace", subagentStop(map[string]any{"last_assistant_message": "STATUS: APPROVED"}), repo), 0, "run-trace")
		mustMatch(t, `agent type=spec-flow:reviewer status=APPROVED`, traceText(repo), "no return line")
	})
	// The orchestrator's prompts name the statuses they expect back.
	t.Run("takes no status from a spawn, whose response echoes the prompt", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		prompt := "If anything is ambiguous, return STATUS: NEEDS_INPUT."
		for _, resp := range []map[string]any{
			{"isAsync": true, "status": "async_launched", "agentId": "a0123456789abcdef", "prompt": prompt},
			{"status": "completed", "prompt": prompt, "agentId": "a0123456789abcdef", "content": []any{map[string]any{"type": "text", "text": "STATUS: SPEC_READY"}}},
		} {
			expectStatus(t, runHook(t, "run-trace", map[string]any{"tool_name": "Agent", "tool_input": map[string]any{"subagent_type": "spec-flow:spec-writer", "prompt": prompt}, "tool_response": resp}, repo), 0, "run-trace")
		}
		mustNotMatch(t, `agent type=`, traceText(repo), "a spawn's tool response was recorded as the agent's return")
	})
	t.Run("reads a report handed back through SubagentHandback, not the line after it", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		transcript := filepath.Join(repo, "agent-a0123456789abcdef.jsonl")
		write(t, transcript, jsonl(handback("STATUS: SPEC_READY\nSPEC_PATH: specflow/x/spec.md"), assistantText("Report delivered to the orchestrator via SubagentHandback.")))
		expectStatus(t, runHook(t, "run-trace", subagentStop(map[string]any{"agent_type": "spec-flow:spec-writer", "last_assistant_message": "Report delivered to the orchestrator via SubagentHandback.", "agent_transcript_path": transcript}), repo), 0, "run-trace")
		mustMatch(t, `agent type=spec-flow:spec-writer status=SPEC_READY`, traceText(repo), "the report the caller received was not recorded")
	})
	t.Run("run-trace and agent-gate read a handback written after the stop fires", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{phase: "review"})
		forTrace := filepath.Join(repo, "agent-trace.jsonl")
		lateHandback(t, forTrace, "STATUS: APPROVED\nNOTES: none", 300*time.Millisecond)
		expectStatus(t, runHook(t, "run-trace", subagentStop(map[string]any{"agent_id": "late1", "agent_transcript_path": forTrace}), repo), 0, "run-trace")
		mustMatch(t, `agent type=spec-flow:reviewer status=APPROVED .*agent_id=late1`, traceText(repo), "run-trace lost a return that landed 300 ms after the stop")
		forGate := filepath.Join(repo, "agent-gate.jsonl")
		lateHandback(t, forGate, "STATUS: APPROVED\nNOTES: none", 300*time.Millisecond)
		expectStatus(t, runHook(t, "agent-gate", subagentStop(map[string]any{"agent_id": "late2", "agent_transcript_path": forGate}), repo), 0, "agent-gate")
		mustNotMatch(t, `agent-check .*why=empty agent_id=late2`, traceText(repo), "agent-gate skipped a return that landed 300 ms after the stop")
	})
	t.Run("a handback that never comes is waited on for a bounded time, then read as empty", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{phase: "review"})
		transcript := filepath.Join(repo, "agent-none.jsonl")
		write(t, transcript, jsonl(assistantText("working")))
		start := time.Now()
		expectStatus(t, runHook(t, "run-trace", subagentStop(map[string]any{"agent_id": "never", "agent_transcript_path": transcript}), repo), 0, "run-trace")
		if took := time.Since(start); took > 5*time.Second {
			t.Fatalf("run-trace held a stop %v for a handback that never came", took)
		}
		mustNotMatch(t, `agent type=`, traceText(repo), "a line was written with no status to put on it")
		if !strings.Contains(read(statePath(repo, "run-trace-unmatched.log")), `"report":"empty"`) {
			t.Fatal("the empty return left no record of its shape")
		}
	})
	t.Run("writes one line per agent, a resumed session stopping again under the same id", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		runHook(t, "run-trace", subagentStop(map[string]any{"last_assistant_message": "STATUS: CHANGES_REQUESTED"}), repo)
		runHook(t, "run-trace", subagentStop(map[string]any{"last_assistant_message": "STATUS: APPROVED"}), repo)
		var lines []string
		for _, l := range strings.Split(traceText(repo), "\n") {
			if strings.Contains(l, "agent type=") {
				lines = append(lines, l)
			}
		}
		if len(lines) != 1 || !strings.Contains(lines[0], "status=CHANGES_REQUESTED") {
			t.Fatalf("want the first return alone, got:\n%s", strings.Join(lines, "\n"))
		}
	})
	t.Run("records the shape of a return that carries no STATUS", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		expectStatus(t, runHook(t, "run-trace", subagentStop(map[string]any{"last_assistant_message": "all done"}), repo), 0, "run-trace")
		mustNotMatch(t, `agent type=`, traceText(repo), "a line was written with no status to put on it")
		if !exists(statePath(repo, "run-trace-unmatched.log")) {
			t.Fatal("a return the trace could not read left no record of its shape")
		}
	})
	// The one observable that had nowhere to go but prose.
	t.Run("records a reported skill-routing miss", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		runHook(t, "run-trace", subagentStop(map[string]any{"agent_type": "spec-flow:implementer", "last_assistant_message": "STATUS: IMPLEMENTED\nSKILL_MISS: where does it live\nNOTES: fine"}), repo)
		mustMatch(t, `skill_miss=where-does-it-live`, traceText(repo), "the miss did not reach the trace")
		mustMatch(t, `status=IMPLEMENTED`, traceText(repo), "the status field was lost")
	})
	t.Run("writes no skill_miss field when none was reported", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		runHook(t, "run-trace", subagentStop(map[string]any{"agent_type": "spec-flow:implementer", "last_assistant_message": "STATUS: IMPLEMENTED"}), repo)
		mustNotMatch(t, `skill_miss`, traceText(repo), "an empty field was written")
	})
	t.Run("records the effort an agent ran at on its return line", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		runHook(t, "run-trace", subagentStop(map[string]any{"last_assistant_message": "STATUS: APPROVED", "effort": map[string]any{"level": "low"}}), repo)
		mustMatch(t, `status=APPROVED effort=low agent_id=`, traceText(repo), "no effort on the return line")
	})
}

func readOf(file string, extra map[string]any) map[string]any {
	p := map[string]any{"tool_name": "Read", "tool_input": map[string]any{"file_path": file}}
	for k, v := range extra {
		p[k] = v
	}
	return p
}

func TestRunTraceReads(t *testing.T) {
	t.Run("logs a read path", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		runHook(t, "run-trace", readOf("specs/user.md", nil), repo)
		mustMatch(t, `read file=specs/user\.md`, traceText(repo), "no read line")
	})
	// Without it a path read twice is one observation with two opposite readings.
	t.Run("records which session read a file", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		runHook(t, "run-trace", readOf("specs/user.md", map[string]any{"session_id": "abc123def456"}), repo)
		mustMatch(t, `session=abc123def456`, traceText(repo), "the read was recorded with no session")
		mustMatch(t, `read file=specs/user\.md`, traceText(repo), "the path was lost")
	})
	// Absent, not empty: an empty field reads as one session downstream.
	t.Run("writes no session field when the payload names none", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		runHook(t, "run-trace", readOf("specs/user.md", nil), repo)
		mustNotMatch(t, `session=`, traceText(repo), "a session field was written over a payload that named none")
	})
	t.Run("attributes a read made inside a subagent to that agent", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		runHook(t, "run-trace", readOf("specs/user.md", map[string]any{"session_id": "spawner-session", "agent_id": "a0123456789abcdef", "agent_type": "spec-flow:spec-writer"}), repo)
		mustMatch(t, `read file=specs/user\.md agent_id=a0123456789abcdef`, traceText(repo), "the read names no agent")
	})
	t.Run("an agent whose reads carry its id still gets its return line", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		p := subagentStop(map[string]any{"tool_name": "Read", "tool_input": map[string]any{"file_path": "specs/user.md"}})
		delete(p, "hook_event_name")
		runHook(t, "run-trace", p, repo)
		runHook(t, "run-trace", subagentStop(map[string]any{"last_assistant_message": "STATUS: APPROVED"}), repo)
		mustMatch(t, `agent type=spec-flow:reviewer status=APPROVED`, traceText(repo), "the agent's own read suppressed its return")
	})
	t.Run("a read in the main session names no agent", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		runHook(t, "run-trace", readOf("specs/user.md", map[string]any{"session_id": "main"}), repo)
		mustNotMatch(t, `agent_id=`, traceText(repo), "a main-session read was charged to an agent")
	})
}

// bashFailure is a Bash call that exited non-zero, as Claude Code 2.1.294
// delivers it: no tool_response.
func bashFailure(command, err string, extra map[string]any) map[string]any {
	p := map[string]any{"hook_event_name": "PostToolUseFailure", "tool_name": "Bash", "tool_input": map[string]any{"command": command}, "error": err, "is_interrupt": false}
	for k, v := range extra {
		p[k] = v
	}
	return p
}

func verdictOf(repo string) string {
	if m := regexp.MustCompile(`test verdict=(\S+)`).FindStringSubmatch(traceText(repo)); m != nil {
		return m[1]
	}
	return "(nothing traced)"
}

func allOf(pattern, text string) string {
	var out []string
	for _, m := range regexp.MustCompile(pattern).FindAllStringSubmatch(text, -1) {
		out = append(out, m[1])
	}
	return strings.Join(out, ",")
}

// What jest prints for a test written ahead of its module, from a real run.
const jestSuiteFailed = "FAIL tests/a.spec.ts\n  ● Test suite failed to run\n\n    tests/a.spec.ts:1:20 - error TS2307: Cannot find module './a' or its corresponding type declarations.\n\nTest Suites: 1 failed, 1 total\nTests:       0 total\nSnapshots:   0 total"

func TestRunTraceTestRuns(t *testing.T) {
	// A non-zero exit never reaches PostToolUse: read only from there, no red run.
	t.Run("logs a failing scoped test run as red", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		runHook(t, "run-trace", bashFailure("npx ftest run tests/a.spec.ts", "Exit code 1\nexpected 3, got undefined", nil), repo)
		mustMatch(t, `test verdict=red target=tests/a\.spec\.ts`, traceText(repo), "a failing test run was not recorded as red")
	})
	t.Run("targets only what the runner ran in a chain of commands", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		runHook(t, "run-trace", bashFailure("npx ftest run tests/a.spec.ts >/dev/null\nnpx eslint tests/c.spec.ts; eslint tests/b.spec.ts && node node_modules/eslint/bin/eslint.js lib/b.ts", "Exit code 1\nexpected 3, got undefined", nil), repo)
		if got := allOf(` target=(\S+)`, traceText(repo)); got != "tests/a.spec.ts" {
			t.Fatalf("want target=tests/a.spec.ts, got %q", got)
		}
	})
	t.Run("targets the path through a continued line, a subshell, quotes, and a directory named for the runner", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		for _, c := range []string{"npx ftest \\\n  tests/a.spec.ts \\\n  --verbose", "(cd sub && npx ftest run tests/a.spec.ts)", `npx ftest run "tests/a.spec.ts"`, "npx ftest run tests/ftest-utils/a.spec.ts"} {
			runHook(t, "run-trace", bashFailure(c, "Exit code 1\nexpected 3, got undefined", nil), repo)
		}
		if got := allOf(` target=(\S+)`, traceText(repo)); got != "tests/a.spec.ts,tests/a.spec.ts,tests/a.spec.ts,tests/ftest-utils/a.spec.ts" {
			t.Fatalf("got %q", got)
		}
	})
	t.Run("does not call an interrupted test run red", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		runHook(t, "run-trace", bashFailure("npx ftest run tests/a.spec.ts", "Interrupted", map[string]any{"is_interrupt": true}), repo)
		mustMatch(t, `test verdict=\? target=tests/a\.spec\.ts`, traceText(repo), "an interrupted run was given a verdict")
	})
	// A red verdict credits test-first, so red only when the runner failed on a path.
	t.Run("a failing command that only names the runner is not a red run", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		runHook(t, "run-trace", bashFailure("grep -n ftest package.json", "Exit code 1", nil), repo)
		if verdictOf(repo) == "red" {
			t.Fatalf("grep was traced as a failing test run: %s", traceText(repo))
		}
	})
	for _, c := range []struct{ name, cmd, err, want string }{
		{"a runner the shell could not find is not a red run", "ftest tests/a.spec.ts", "Exit code 127\nbash: line 1: ftest: command not found", "?"},
		{"a failing run whose own summary says every test passed is not red", "npx ftest run tests/a.spec.ts", "Exit code 1\n      Tests  3 passed (3)\nERROR: Coverage for lines (12%) does not meet global threshold (80%)", "?"},
		{"a runner launched as node <its script> that fails on a path is a red run", "node --experimental-vm-modules node_modules/ftest/bin/ftest.js tests/a.spec.ts", "Exit code 1\nexpected 3, got undefined", "red"},
	} {
		t.Run(c.name, func(t *testing.T) {
			repo := makeRepo(t, repoOpts{})
			runHook(t, "run-trace", bashFailure(c.cmd, c.err, nil), repo)
			if got := verdictOf(repo); got != c.want {
				t.Fatalf("want %s, got %s: %s", c.want, got, traceText(repo))
			}
		})
	}
	t.Run("a failing run that found no test file is none, in vitest and node wording", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		runHook(t, "run-trace", bashFailure("npx ftest run tests/typo.spec.ts", "Exit code 1\nNo test files found, exiting with code 1", nil), repo)
		runHook(t, "run-trace", bashFailure("npx ftest run tests/typo.spec.ts", "Exit code 1\nCould not find '/x/tests/typo.spec.ts'", nil), repo)
		if got := allOf(`test verdict=(\S+)`, traceText(repo)); got != "none,none" {
			t.Fatalf("want none,none, got %q", got)
		}
	})
	t.Run("a suite that failed to run is red even when a pipe hid the exit status", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		runHook(t, "run-trace", map[string]any{"hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_input": map[string]any{"command": "npx ftest tests/a.spec.ts 2>&1 | tail -20"}, "tool_response": map[string]any{"stdout": jestSuiteFailed, "stderr": ""}}, repo)
		if got := verdictOf(repo); got != "red" {
			t.Fatalf("want red, got %s: %s", got, traceText(repo))
		}
	})
	// init writes the runner as `node <entrypoint>`, the implementer runs what
	// the contract names, and this hook must recognise it — checked against
	// what init actually writes.
	t.Run("the test argv init writes, run on a path and failing, is a red run", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		write(t, filepath.Join(repo, "node_modules", "jest", "bin", "jest.js"), "process.exit(0);\n")
		shim := filepath.Join(repo, "node_modules", ".bin", "jest")
		os.MkdirAll(filepath.Dir(shim), 0o755)
		if runtime.GOOS == "windows" {
			write(t, shim, "#!/bin/sh\nexec node \"$basedir/../jest/bin/jest.js\" \"$@\"\n")
		} else if err := os.Symlink(filepath.Join("..", "jest", "bin", "jest.js"), shim); err != nil {
			t.Fatal(err)
		}
		write(t, filepath.Join(repo, "package.json"), `{"scripts":{"test":"jest"}}`)
		smoke := read(filepath.Join(repo, ".spec-flow", "config.json"))
		init := cli(t, repo, nil, "init", "--force")
		var written struct {
			Verify struct {
				Test     []string `json:"test"`
				TestName string   `json:"test_name"`
			} `json:"verify"`
		}
		json.Unmarshal([]byte(read(filepath.Join(repo, ".spec-flow", "config.json"))), &written)
		if written.Verify.TestName != "jest" || len(written.Verify.Test) == 0 || written.Verify.Test[0] != "node" {
			t.Fatalf("init did not write jest as `node <entrypoint>` — this case tests nothing: %+v %s", written, init.Out())
		}
		var c map[string]any
		json.Unmarshal([]byte(smoke), &c)
		sub(c, "verify")["test"], sub(c, "verify")["test_name"] = toAny(written.Verify.Test), written.Verify.TestName
		write(t, filepath.Join(repo, ".spec-flow", "config.json"), toJSON(c))
		cmd := strings.Join(written.Verify.Test, " ") + " tests/a.spec.ts"
		runHook(t, "run-trace", bashFailure(cmd, "Exit code 1\n"+jestSuiteFailed, nil), repo)
		if got := verdictOf(repo); got != "red" {
			t.Fatalf("want red for `%s`, got %s: %s", cmd, got, traceText(repo))
		}
	})
	t.Run("node running a script that is not the runner is not a red run", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		runHook(t, "run-trace", bashFailure("node scripts/build.mjs --then ftest tests/a.spec.ts", "Exit code 1\nbuild failed", nil), repo)
		if verdictOf(repo) == "red" {
			t.Fatalf("a build script was traced as a failing test run: %s", traceText(repo))
		}
	})
	// A `?` says what the hook was not given.
	t.Run("a run the hook cannot judge says why", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		runHook(t, "run-trace", bashFailure("npx ftest run tests/a.spec.ts", "Interrupted", map[string]any{"is_interrupt": true}), repo)
		runHook(t, "run-trace", bashFailure("ftest tests/a.spec.ts", "Exit code 127\nbash: line 1: ftest: command not found", nil), repo)
		runHook(t, "run-trace", map[string]any{"hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_input": map[string]any{"command": "npx ftest tests/a.spec.ts | tail -5"}, "tool_response": map[string]any{"stdout": "some output", "stderr": ""}}, repo)
		runHook(t, "run-trace", bashFailure("grep -rn ftest tests/a.spec.ts", "Exit code 1", nil), repo)
		if got := allOf(`test verdict=\? \S+ why=(\S+)`, traceText(repo)); got != "interrupted,not-found,pipe,not-the-runner" {
			t.Fatalf("want interrupted,not-found,pipe,not-the-runner, got %q", got)
		}
	})
	t.Run("is silent outside a run", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{phase: "idle"})
		runHook(t, "run-trace", map[string]any{"tool_name": "Write", "tool_input": map[string]any{"file_path": "example/thing.ts"}}, repo)
		if exists(statePath(repo, "run-trace.log")) {
			t.Fatal("traced while idle")
		}
	})
}

// hooksJSON is the plugin's hook registrations.
func hooksJSON(t *testing.T) map[string][]struct {
	Matcher string
	Hooks   []struct {
		Command string
		Args    []string
	}
} {
	t.Helper()
	var m struct {
		Hooks map[string][]struct {
			Matcher string
			Hooks   []struct {
				Command string
				Args    []string
			}
		}
	}
	root := repoRoot
	if oracle != "" {
		root = oracle
	}
	if err := json.Unmarshal([]byte(read(filepath.Join(root, "hooks", "hooks.json"))), &m); err != nil {
		t.Fatal(err)
	}
	return m.Hooks
}

func runsHook(args []string, name string) bool {
	for i, a := range args {
		if strings.HasSuffix(a, "/hooks/"+name+".mjs") || (a == name && i > 0 && args[i-1] == "hook") {
			return true
		}
	}
	return false
}

func TestHooksJSONRegistersRunTraceForAFailingBashCall(t *testing.T) {
	for _, e := range hooksJSON(t)["PostToolUseFailure"] {
		if regexp.MustCompile(`(^|\|)Bash(\||$)`).MatchString(e.Matcher) {
			for _, h := range e.Hooks {
				if runsHook(h.Args, "run-trace") {
					return
				}
			}
		}
	}
	t.Fatal("no PostToolUseFailure entry runs run-trace on Bash — a red test run is never traced")
}

// The manifest is a call site like any other: each entry, run exactly as
// Claude Code runs it — its command and args, the plugin root substituted, no
// shell — reaches a hook, which outside a run lets the call through.
func TestEveryHooksJSONEntryRunsAsWritten(t *testing.T) {
	repo := t.TempDir()
	for event, groups := range hooksJSON(t) {
		for _, g := range groups {
			for _, h := range g.Hooks {
				argv := []string{strings.ReplaceAll(h.Command, "${CLAUDE_PLUGIN_ROOT}", engineDir)}
				for _, a := range h.Args {
					argv = append(argv, strings.ReplaceAll(a, "${CLAUDE_PLUGIN_ROOT}", engineDir))
				}
				r := run(os.TempDir(), []string{"CLAUDE_PROJECT_DIR=" + repo}, toJSON(map[string]any{"hook_event_name": event, "session_id": "s"}), argv...)
				if r.Status != 0 {
					t.Errorf("%s %v exited %d: %s", event, h.Args, r.Status, r.Out())
				}
			}
		}
	}
}
