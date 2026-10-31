package e2e

// stats exports nothing, gates nothing and always exits 0: its whole surface
// is what it prints, so every case runs it against a synthetic repository.
//
// The case that carries the design is "a file read in two DIFFERENT
// milestones is not a re-read": a fresh session per milestone is the
// contract, so only a repeat INSIDE one is the cold-start cost.

import (
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

// stamp is minutes past a fixed origin, so a case reads as an ordering.
func stamp(minute int) string {
	return time.Date(2026, 8, 21, 10, minute, 0, 0, time.UTC).Format("2006-01-02T15:04:05Z")
}

func readAt(minute int, file, session string) string {
	s := ""
	if session != "" {
		s = " session=" + session
	}
	return stamp(minute) + " phase=implement" + s + " read file=" + file
}

func readIn(minute int, phase, file string) string {
	return stamp(minute) + " phase=" + phase + " read file=" + file
}

func agentAt(minute int, kind, session string) string {
	s := ""
	if session != "" {
		s = " session=" + session
	}
	return stamp(minute) + " phase=implement" + s + " agent type=" + kind + " status=DONE"
}

func passAt(minute int) string {
	return stamp(minute) + " abc1234 cc=1.0 engine=0.1.0 phase=implement attempt=1 result=pass lint=0 test=0 unscoped=ok files=1"
}

type snapshot struct {
	slug        string
	gate, trace []string
}

type statsRun struct {
	trace, gate []string
	archived    []snapshot
	files       map[string]string
	traceFor    func(repo string) []string
}

func lines(ls []string) string {
	if len(ls) == 0 {
		return ""
	}
	return strings.Join(ls, "\n") + "\n"
}

// statsReport is what stats printed over a repository holding exactly these
// lines. A snapshot is a slice of the live log, so the same lines in both
// tiers is what a run taken on this machine looks like on disk.
func statsReport(t *testing.T, s statsRun) Result {
	t.Helper()
	repo := t.TempDir()
	write(t, filepath.Join(repo, ".spec-flow", "config.json"), smokeContract(nil))
	write(t, statePath(repo, "phase"), "implement")
	live := s.trace
	if s.traceFor != nil {
		live = append(append([]string{}, live...), s.traceFor(repo)...)
	}
	write(t, statePath(repo, "run-trace.log"), lines(live))
	write(t, statePath(repo, "gate-history.log"), lines(s.gate))
	writeFiles(t, repo, s.files)
	for _, snap := range s.archived {
		dir := filepath.Join(repo, "specflow", "archive", snap.slug, "telemetry")
		// CRLF on purpose: a snapshot committed from Windows reaches a reader
		// as CRLF while the live log it was sliced from is LF.
		for file, body := range map[string][]string{"gate-history.log": snap.gate, "run-trace.log": snap.trace} {
			if len(body) > 0 {
				write(t, filepath.Join(dir, file), strings.Join(body, "\r\n")+"\r\n")
			}
		}
	}
	return run(repo, []string{"CLAUDE_PROJECT_DIR=" + repo}, "", cliArgv(engineDir, "stats")...)
}

func wantAll(t *testing.T, out string, texts ...string) {
	t.Helper()
	for _, s := range texts {
		if !strings.Contains(out, s) {
			t.Fatalf("expected the report to contain %q.\n--- report ---\n%s", s, out)
		}
	}
}

func wantNone(t *testing.T, out, why string, texts ...string) {
	t.Helper()
	for _, s := range texts {
		if strings.Contains(out, s) {
			t.Fatalf("%s (%q).\n--- report ---\n%s", why, s, out)
		}
	}
}

// claimsSplit is the report CLAIMING a cross-session split, as opposed to
// explaining that it could not make one.
var claimsSplit = regexp.MustCompile(`\d+ across sessions|re-read across sessions:`)

var testFirstSection = regexp.MustCompile(`(?m)^Test-first\n((?s:.*?))\n\n`)

// testFirst is the Test-first section alone: the warnings below it carry other sections' words.
func testFirst(out string) string {
	if m := testFirstSection.FindStringSubmatch(out); m != nil {
		return m[1]
	}
	return ""
}

func writeAt(minute int, file string) string {
	return stamp(minute) + " phase=implement write file=" + file
}

func ranOn(minute int, verdict, target, why string) string {
	s := stamp(minute) + " phase=implement test verdict=" + verdict + " target=" + target
	if why != "" {
		s += " why=" + why
	}
	return s
}

func ranPlace(minute int, verdict, why string) string {
	return ranOn(minute, verdict, "tests/orders/place.spec.ts", why)
}

// threePairs wrote three tests, then the runs, then the three modules.
func threePairs(runs ...string) []string {
	out := []string{writeAt(1, "tests/orders/place.spec.ts"), writeAt(2, "tests/orders/cancel.spec.ts"), writeAt(3, "tests/orders/ship.spec.ts")}
	out = append(out, runs...)
	return append(out, writeAt(20, "lib/orders/place.ts"), writeAt(21, "lib/orders/cancel.ts"), writeAt(22, "lib/orders/ship.ts"))
}

const ordersSpec = "<!-- spec-scope: lib/orders -->\n\n# Orders\n\n### REQ-ORDERS-001 — an order is placed\n\nThe system places it.\n"

func changeFiles(base string) map[string]string {
	return map[string]string{
		base + "/spec.md": "# Spec — ship-orders: ship an order\n\n## User stories\n- **US-1** — as a clerk I ship an order\n\n## Requirement deltas\n- ADDED REQ-ORDERS-002 — an order ships\n\n## Out of scope\nnone\n",
		base + "/milestones/M1.md": "# M1 — ship (covers US-1)\n\n- Objective: ship\n- Skills: none\n- Files to add/change: lib/orders/ship.ts, tests/orders-ship.spec.ts\n- Steps: one\n- Spec deltas: ADDED REQ-ORDERS-002\n" +
			"- Tests to add/change: tests/orders-ship.spec.ts — REQ-ORDERS-002 ships\n- What this could break: nothing outside the deltas, it adds a file\n- Depends on: none\n",
	}
}

func tokLine(minute int, phase, rest string) string {
	return stamp(minute) + " phase=" + phase + " tokens model=model-alpha " + rest
}

func ago(d time.Duration) string { return time.Now().Add(-d).UTC().Format("2006-01-02T15:04:05.000Z") }

func TestStats(t *testing.T) {
	t.Parallel()
	gateFail := func(minute int, class string) string {
		return stamp(minute) + " abc1234 cc=1.0 engine=0.1.0 phase=implement attempt=1 result=" + class + " lint=0 test=1 unscoped=ok files=1"
	}
	gateDirty := func(minute int) string {
		return stamp(minute) + " abc1234 cc=1.0 engine=0.1.0 phase=implement attempt=0 result=skip-dirty lint=- test=- unscoped=- files=1"
	}
	agentCheck := func(minute int, result, why string) string {
		return stamp(minute) + " phase=review agent-check agent=spec-flow:reviewer result=" + result + " why=" + why + " agent_id=a1"
	}
	dispatch := func(minute int, phase, who, result, why string) string {
		return stamp(minute) + " phase=" + phase + " session=s dispatch agent=" + who + " tool=Agent result=" + result + " why=" + why
	}
	noRun := func(minute int, phase, who string) string { return dispatch(minute, phase, who, "record", "no-run") }
	orders := func(base string) map[string]string {
		return merge(map[string]string{"specs/orders.md": ordersSpec}, changeFiles(base))
	}

	for _, c := range []struct {
		name  string
		run   statsRun
		check func(t *testing.T, r Result)
	}{
		{"one implementer session and no repeat reads is the clean case",
			statsRun{trace: []string{readAt(1, "x/one.ts", ""), agentAt(2, "implementer", ""), readAt(3, "x/two.ts", "")}, gate: []string{passAt(4)}},
			func(t *testing.T, r Result) {
				expectStatus(t, r, 0, "this command must always exit 0")
				wantAll(t, r.Out(), "milestone 1: 1 implementer session(s), no file read twice")
				wantNone(t, r.Out(), "warned about spawns when there was only one", "spawned the implementer")
			}},
		{"a second implementer spawn inside one milestone is reported and warned",
			statsRun{trace: []string{agentAt(1, "implementer", ""), readAt(2, "x/one.ts", ""), agentAt(3, "implementer", ""), readAt(4, "x/one.ts", "")}, gate: []string{passAt(5)}},
			func(t *testing.T, r Result) {
				expectStatus(t, r, 0, "this command must always exit 0")
				wantAll(t, r.Out(), "milestone 1: 2 implementer session(s)", "spawned the implementer 2 times")
			}},
		// Every real trace line carries `spec-flow:<role>`.
		{"a namespaced implementer is counted in its milestone",
			statsRun{trace: []string{agentAt(1, "spec-flow:implementer", ""), readAt(2, "x/one.ts", ""), agentAt(3, "spec-flow:implementer", "")}, gate: []string{passAt(5)}},
			func(t *testing.T, r Result) { wantAll(t, r.Out(), "milestone 1: 2 implementer session(s)") }},
		{"a namespaced reviewer is the reviewer, so its rubber-stamp check runs",
			statsRun{trace: []string{stamp(1) + " phase=review agent type=spec-flow:reviewer status=APPROVED", stamp(2) + " phase=review agent type=spec-flow:reviewer status=APPROVED", stamp(3) + " phase=review agent type=spec-flow:reviewer status=APPROVED"}},
			func(t *testing.T, r Result) {
				wantAll(t, r.Out(), "reviewer: 3 APPROVED", "the reviewer approved all 3 plan(s)")
			}},
		{"the same file read twice inside one milestone counts as a re-read",
			statsRun{trace: []string{agentAt(1, "implementer", ""), readAt(2, "x/one.ts", ""), readAt(3, "x/one.ts", ""), readAt(4, "x/one.ts", "")}, gate: []string{passAt(5)}},
			func(t *testing.T, r Result) {
				wantAll(t, r.Out(), "1 file(s) re-read, 2 extra read(s)", "most re-read: one.ts +2")
			}},
		{"a file read in two DIFFERENT milestones is not a re-read",
			statsRun{trace: []string{agentAt(1, "implementer", ""), readAt(2, "x/one.ts", ""), agentAt(5, "implementer", ""), readAt(6, "x/one.ts", "")}, gate: []string{passAt(3), passAt(7)}},
			func(t *testing.T, r Result) {
				wantAll(t, r.Out(), "milestone 1: 1 implementer session(s), no file read twice", "milestone 2: 1 implementer session(s), no file read twice")
				wantNone(t, r.Out(), "counted a cross-milestone read as a re-read", "most re-read:")
			}},
		{"work after the last PASS is still a milestone, marked as unfinished",
			statsRun{trace: []string{agentAt(1, "implementer", ""), readAt(2, "x/one.ts", ""), agentAt(4, "implementer", ""), readAt(5, "x/two.ts", "")}, gate: []string{passAt(3)}},
			func(t *testing.T, r Result) {
				wantAll(t, r.Out(), "milestone 2 (never reached a PASS): 1 implementer session(s)")
			}},

		// ---- attribution: which SESSION did the re-reading. The number is the
		// same in all four; only the session ids tell them apart.
		{"a file re-read by two sessions inside one milestone is the cold-start cost",
			statsRun{trace: []string{agentAt(1, "implementer", "s1"), readAt(2, "x/one.ts", "s1"), agentAt(3, "implementer", "s1"), readAt(4, "x/one.ts", "s2")}, gate: []string{passAt(5)}},
			func(t *testing.T, r Result) {
				wantAll(t, r.Out(), "1 across sessions", "re-read across sessions: one.ts x1", "the only re-read a cache could remove")
			}},
		{"the same session re-reading its own file is not counted across sessions",
			statsRun{trace: []string{agentAt(1, "implementer", "s1"), readAt(2, "x/one.ts", "s1"), readAt(3, "x/one.ts", "s1")}, gate: []string{passAt(4)}},
			func(t *testing.T, r Result) {
				wantAll(t, r.Out(), "1 file(s) re-read, 1 extra read(s)")
				if claimsSplit.MatchString(r.Out()) {
					t.Fatalf("one session's own re-read was reported as a cold start.\n%s", r.Out())
				}
			}},
		{"a trace with no session ids reports attribution as unavailable, not as zero",
			statsRun{trace: []string{agentAt(1, "implementer", ""), readAt(2, "x/one.ts", ""), readAt(3, "x/one.ts", "")}, gate: []string{passAt(4)}},
			func(t *testing.T, r Result) {
				wantAll(t, r.Out(), "attribution: UNAVAILABLE")
				if claimsSplit.MatchString(r.Out()) {
					t.Fatalf("claimed a split over a trace that carries no session id.\n%s", r.Out())
				}
			}},
		// Whether a subagent's payload carries its own session id or its
		// parent's is undocumented: read as perfect reuse, this is wrong.
		{"one session id across several spawns is reported as unmeasured, not as reuse",
			statsRun{trace: []string{agentAt(1, "implementer", "s1"), readAt(2, "x/one.ts", "s1"), agentAt(3, "architect", "s1"), readAt(4, "x/one.ts", "s1")}, gate: []string{passAt(5)}},
			func(t *testing.T, r Result) {
				wantAll(t, r.Out(), "attribution: ONE session id across 2 subagent spawn(s)", "treat those numbers as unmeasured, not as zero")
			}},
		// A subagent's tool call carries its parent's session id and its own agent_id.
		{"reads attributed to two agents under one spawner session are two sessions",
			statsRun{trace: []string{agentAt(1, "implementer", "s1"), readAt(2, "x/one.ts", "s1") + " agent_id=a1", agentAt(3, "implementer", "s1"), readAt(4, "x/one.ts", "s1") + " agent_id=a2"}, gate: []string{passAt(5)}},
			func(t *testing.T, r Result) {
				wantAll(t, r.Out(), "re-read across sessions: one.ts x1", "across 2 session(s)")
			}},
		// Token lines name the agent; the return line names its role and effort.
		{"a run's tokens are reported by role, with the orchestrator apart",
			statsRun{trace: []string{agentAt(1, "spec-flow:reviewer", "s1") + " effort=low agent_id=a1",
				tokLine(2, "implement", "sidechain=true in=10 out=300 cache_read=0 cache_write=0 think=0 msgs=1 max_prompt=12000 agent_id=a1"),
				tokLine(3, "implement", "sidechain=false in=10 out=900 cache_read=0 cache_write=0 think=0 msgs=1 max_prompt=12000"),
				tokLine(4, "implement", "sidechain=true in=10 out=50 cache_read=0 cache_write=0 think=0 msgs=1 max_prompt=12000 agent_id=a9")}, gate: []string{passAt(5)}},
			func(t *testing.T, r Result) {
				wantAll(t, r.Out(), "orchestrator  model-alpha  in 10  out ≥900", "reviewer (1 agent(s), effort low)  model-alpha  in 10  out ≥300",
					"unattributed (1 agent(s))  model-alpha  in 10  out ≥50", "largest prompt 12k")
			}},
		// A role's cost is its messages times the prompt each re-read.
		{"each role reports its messages and its average prompt per message",
			statsRun{trace: []string{agentAt(1, "spec-flow:reviewer", "s1") + " agent_id=a1",
				tokLine(2, "implement", "sidechain=false in=10 out=100 cache_read=100000 cache_write=10000 think=0 msgs=2 max_prompt=60000"),
				tokLine(3, "implement", "sidechain=false in=10 out=100 cache_read=200000 cache_write=20000 think=0 msgs=3 max_prompt=60000"),
				tokLine(4, "implement", "sidechain=true in=1 out=1 cache_read=0 cache_write=0 think=0 msgs=1 max_prompt=9 agent_id=a1")}, gate: []string{passAt(5)}},
			func(t *testing.T, r Result) { wantAll(t, r.Out(), "largest prompt 60k  5 msg, ~66k prompt/msg") }},
		// An advisor is billed at its own model's rates, outside the request that consulted it.
		{"an advisor's tokens are reported apart, under the role that consulted it",
			statsRun{trace: []string{stamp(1) + " phase=plan agent type=spec-flow:planner status=PLAN_READY effort=high agent_id=a1",
				stamp(2) + " phase=plan tokens model=model-alpha sidechain=true in=10 out=300 cache_read=0 cache_write=0 msgs=1 max_prompt=9 think=0 agent_id=a1",
				stamp(3) + " phase=plan tokens model=model-gamma sidechain=true advisor=true in=10 out=1612 cache_read=0 cache_write=0 msgs=1 max_prompt=9 agent_id=a1",
				stamp(4) + " phase=plan tokens model=model-gamma sidechain=false advisor=true in=10 out=40 cache_read=0 cache_write=0 msgs=1 max_prompt=9"}, gate: []string{passAt(5)}},
			func(t *testing.T, r Result) {
				wantAll(t, r.Out(), "planner (1 agent(s), effort high)  model-alpha  in 10  out ≥300", "advisor ← planner (1 agent(s))  model-gamma  in 10  out ≥2k",
					"advisor ← orchestrator  model-gamma  in 10  out ≥40", "model-gamma  advisor   in 20  out ≥2k  cache_read 0  think ?")
			}},
		// A 1-hour write costs 2× input and a 5-minute one 1.25×: priced only once split.
		{"a role's cache writes are split by TTL where every line of it carries the split",
			statsRun{trace: []string{agentAt(1, "spec-flow:reviewer", "s1") + " agent_id=a1",
				tokLine(2, "implement", "sidechain=true in=10 out=1 cache_read=0 cache_write=1200 think=0 cache_write_5m=1200 cache_write_1h=0 msgs=1 max_prompt=9 agent_id=a1"),
				tokLine(3, "implement", "sidechain=true in=10 out=1 cache_read=0 cache_write=300 think=0 cache_write_5m=100 cache_write_1h=200 msgs=1 max_prompt=9 agent_id=a1"),
				tokLine(4, "implement", "sidechain=false in=10 out=1 cache_read=0 cache_write=700 think=0 cache_write_5m=0 cache_write_1h=700 msgs=1 max_prompt=9"),
				tokLine(5, "implement", "sidechain=false in=10 out=1 cache_read=0 cache_write=50 think=0 msgs=1 max_prompt=9")}, gate: []string{passAt(6)}},
			func(t *testing.T, r Result) {
				mustNotMatch(t, `orchestrator .*\(5m `, r.Out(), "a split was printed for a role with a line that carried none")
				wantAll(t, r.Out(), "cache_write 2k (5m 1k, 1h 200)")
			}},
		// A PASS with no failure since the previous PASS; skip-dirty is no failure.
		{"passed-the-first-time counts a PASS with no failure since the previous one",
			statsRun{gate: []string{gateFail(1, "fail"), passAt(2), gateDirty(3), passAt(4), gateFail(5, "fail"), gateFail(6, "fail"), passAt(7)}},
			func(t *testing.T, r Result) { wantAll(t, r.Out(), "passed the first time: 1 of 3 PASS(es)") }},
		// The gate never writes a bare `fail`: every refusal is `fail:<class>`.
		{"passed-the-first-time counts the failures the gate writes",
			statsRun{gate: []string{gateFail(1, "fail:behaviour"), passAt(2), gateDirty(3), passAt(4), gateFail(5, "fail:lint/trace"), gateFail(6, "fail:killed"), passAt(7)}},
			func(t *testing.T, r Result) { wantAll(t, r.Out(), "passed the first time: 1 of 3 PASS(es)") }},
		{"returns the agent gate sent back are counted by why, and so are the ones let through or not fully judged",
			statsRun{trace: []string{agentCheck(1, "block", "no-status"), agentCheck(2, "block", "no-status"), agentCheck(3, "cap", "no-status"), agentCheck(4, "skip", "unattributed"), agentAt(5, "spec-flow:reviewer", "s1") + " agent_id=a1"}, gate: []string{passAt(6)}},
			func(t *testing.T, r Result) {
				wantAll(t, r.Out(), "agent gate: 2 return(s) sent back (no-status x2), 1 let through at the cap (no-status x1), 1 not fully judged (unattributed x1).", "reviewer: 1 DONE")
			}},
		// ADR-035: the guard's records by agent and reason, and how often arm-gate moved the phase.
		{"dispatches off the commands' contract are counted by agent and reason, and so are the gate's armings",
			statsRun{trace: []string{dispatch(1, "implement", "reviewer", "record", "phase"), dispatch(2, "implement", "implementer", "record", "no-milestone,other-files"),
				dispatch(3, "plan", "implementer", "armed", "phase"), dispatch(4, "spec", "implementer", "deny", "case-3-unanswered")}, gate: []string{passAt(5)}},
			func(t *testing.T, r Result) {
				wantAll(t, r.Out(), "dispatch: 2 off the commands' contract (reviewer:phase x1, implementer:no-milestone x1, implementer:other-files x1), recorded, not denied; the gate armed by arm-gate 1 time(s), the implementer denied 1 time(s) (implementer:case-3-unanswered x1).",
					"read the `dispatch` lines with --raw")
			}},
		// ADR-040: told apart from the rules ADR-035 weighs, since nothing counted or traced them.
		{"a spec-writer or planner with no run phase reads as a run that skipped step 0",
			statsRun{trace: []string{noRun(1, "done", "spec-writer"), noRun(2, "done", "planner")}, gate: []string{passAt(3)}},
			func(t *testing.T, r Result) {
				wantNone(t, r.Out(), "no-run dispatches were reported as rules to weigh", "read the `dispatch` lines with --raw")
				wantAll(t, r.Out(), "dispatch: 0 off the commands' contract, recorded, not denied", "2 spec-writer or planner spawn(s) with no run phase (spec-writer:no-run x1, planner:no-run x1)")
			}},
		// A question between runs lands before the next `--mark`, in `(current)` for good.
		{"any other agent outside a run is reported, not warned about, and is no run",
			statsRun{trace: []string{noRun(9, "done", "architect"), noRun(10, "done", "implementer")}, archived: []snapshot{{slug: "refunds", gate: []string{passAt(5)}, trace: []string{agentAt(4, "spec-flow:implementer", "")}}}},
			func(t *testing.T, r Result) {
				wantNone(t, r.Out(), "a question between runs read as a skipped step 0", "skipped writing `spec`")
				wantNone(t, r.Out(), "the slice holding only outside-run lines was counted as a run", "across 2 run(s)")
				wantAll(t, r.Out(), "outside a run: 2 of this flow's agent(s) put to work (architect:no-run x1, implementer:no-run x1)")
			}},
		// ADR-034: a run where orchestrator-scope never armed is not one where nothing was denied.
		{"a run where orchestrator-scope or the case 3 check stood down says so",
			statsRun{gate: []string{passAt(1)}, files: map[string]string{".claude/state/orchestrator-scope-unmatched.log": "x phase=spec tool=Read unattributed\n", ".claude/state/human-turn-unmatched.log": "x case-3 check stood down\n"}},
			func(t *testing.T, r Result) {
				wantAll(t, r.Out(), "note: 1 session calls orchestrator-scope let through", "note: 1 case 3 checks that stood down")
			}},
		{"no telemetry at all says so, and still exits 0", statsRun{},
			func(t *testing.T, r Result) {
				expectStatus(t, r, 0, "this command must always exit 0")
				wantAll(t, r.Out(), "Session reuse", "no run trace yet")
			}},

		// ---- reads against the change's scope, read off the deltas and the
		// milestone paths: over a scope of nothing, the answer is UNKNOWN.
		{"reads are split against the scope read off the deltas and the milestone paths",
			statsRun{files: orders("specflow/archive/ship-orders"), archived: []snapshot{{slug: "ship-orders", trace: []string{
				readIn(1, "plan", "lib/orders/place.ts"), readIn(2, "plan", "lib/billing/invoice.ts"), readIn(3, "plan", "lib/billing/tax.ts"),
				readIn(4, "plan", "lib/billing/refund.ts"), readIn(5, "plan", "specs/orders.md"), readIn(6, "plan", "/opt/elsewhere/engine/scripts/gate.mjs")}}}},
			func(t *testing.T, r Result) {
				wantAll(t, r.Out(), "ship-orders: scope lib/orders, tests (from specs/orders.md, 2 milestone path(s))",
					"plan: 6 read(s), 4 outside the scope — lib/billing x3, (outside the repository) x1", "the planner read more outside the change's scope (4) than inside it (2)")
			}},
		{"a planner reading mostly inside the scope is reported and not warned about",
			statsRun{files: orders("specflow/archive/ship-orders"), archived: []snapshot{{slug: "ship-orders", trace: []string{readIn(1, "plan", "lib/orders/place.ts"), readIn(2, "plan", "lib/orders/cancel.ts"), readIn(3, "plan", "lib/billing/tax.ts")}}}},
			func(t *testing.T, r Result) {
				wantAll(t, r.Out(), "plan: 3 read(s), 1 outside the scope — lib/billing x1")
				wantNone(t, r.Out(), "warned about a planner that mostly stayed inside the scope", "read more outside")
			}},
		{"a change whose scope cannot be derived reports UNKNOWN, not zero",
			statsRun{files: map[string]string{"specflow/archive/mystery/spec.md": "# Spec — mystery\n\n## Requirement deltas\n- none — wiring only\n"}, archived: []snapshot{{slug: "mystery", trace: []string{readIn(1, "plan", "lib/billing/tax.ts")}}}},
			func(t *testing.T, r Result) {
				wantAll(t, r.Out(), "mystery: scope UNKNOWN")
				wantNone(t, r.Out(), "counted reads against a scope that could not be derived", "outside the scope")
			}},
		{"an absolute path under the repo is the repo's own file, whichever slashes it carries, and a live change scopes the current run",
			statsRun{files: orders("specflow/ship-orders"), traceFor: func(repo string) []string {
				return []string{readIn(1, "plan", filepath.Join(repo, "lib", "orders", "place.ts")), readIn(2, "plan", filepath.Join(repo, "lib", "billing", "tax.ts"))}
			}},
			func(t *testing.T, r Result) {
				wantAll(t, r.Out(), "scope lib/orders, tests (from specs/orders.md, 2 milestone path(s))", "plan: 2 read(s), 1 outside the scope — lib/billing x1")
			}},

		// ---- the two tiers overlap: a snapshot is a slice of the live log, so
		// reading both as runs inflates every number invisibly.
		{"a snapshot that duplicates the live log is one invocation, not two",
			statsRun{gate: []string{passAt(4)}, archived: []snapshot{{slug: "shipped", gate: []string{passAt(4)}}}},
			func(t *testing.T, r Result) {
				wantAll(t, r.Out(), "1 invocation(s)")
				wantNone(t, r.Out(), "counted one gate invocation twice, once per tier", "2 invocation(s)")
			}},
		{"a live line with no snapshot yet is still counted",
			statsRun{gate: []string{passAt(4), passAt(6)}, archived: []snapshot{{slug: "shipped", gate: []string{passAt(4)}}}},
			func(t *testing.T, r Result) {
				wantAll(t, r.Out(), "2 invocation(s)")
				wantNone(t, r.Out(), "double-counted the archived line", "3 invocation(s)")
			}},
		{"a milestone held in both tiers is reported once",
			func() statsRun {
				trace, gate := []string{agentAt(1, "implementer", ""), readAt(2, "x/one.ts", ""), readAt(3, "x/one.ts", "")}, []string{passAt(4)}
				return statsRun{trace: trace, gate: gate, archived: []snapshot{{slug: "shipped", trace: trace, gate: gate}}}
			}(),
			func(t *testing.T, r Result) {
				if n := strings.Count(r.Out(), "milestone 1:"); n != 1 {
					t.Fatalf("milestone 1 was reported %d time(s); the run happened once.\n%s", n, r.Out())
				}
			}},
		// Recorded on Windows under another user's directory, every read
		// pointed "outside the repository" from here.
		{"an archived run recorded under another root reads as this repo",
			statsRun{files: orders("specflow/archive/ship-orders"), archived: []snapshot{{slug: "ship-orders", trace: []string{
				readIn(1, "plan", `C:\Users\someone\work\shop\specflow\ship-orders\spec.md`), readIn(2, "plan", `C:\Users\someone\work\shop\lib\orders\place.ts`),
				readIn(3, "plan", `C:\Users\someone\work\shop\lib\billing\tax.ts`), readIn(4, "plan", `C:\Users\someone\AppData\engine\scripts\gate.mjs`)}}}},
			func(t *testing.T, r Result) {
				wantAll(t, r.Out(), "plan: 4 read(s), 2 outside the scope — lib/billing x1, (outside the repository) x1")
			}},

		// ---- test-first: a test written, run red, then the code
		{"a test written, run red, then its code is red-first",
			statsRun{trace: []string{writeAt(1, "tests/orders/place.spec.ts"), ranPlace(2, "red", ""), writeAt(3, "lib/orders/place.ts")}},
			func(t *testing.T, r Result) { wantAll(t, testFirst(r.Out()), "OK   lib/orders/place.ts  (red-first)") }},
		{"code written before its test is code-first",
			statsRun{trace: []string{writeAt(1, "lib/orders/place.ts"), writeAt(2, "tests/orders/place.spec.ts")}},
			func(t *testing.T, r Result) { wantAll(t, testFirst(r.Out()), "MISS lib/orders/place.ts  (code-first)") }},
		// Read long after both were written, a module and its test read as "code first".
		{"a module and its test that were only read are not paired",
			statsRun{trace: []string{readAt(1, "lib/orders/place.ts", ""), readAt(2, "tests/orders/place.spec.ts", ""), writeAt(3, "lib/other.ts")}},
			func(t *testing.T, r Result) {
				wantNone(t, testFirst(r.Out()), "paired two files that were only read", "place.ts")
			}},
		// A run the trace could not judge is not a run that did not happen.
		{"a test run with no readable verdict is unmeasured, not missed",
			statsRun{trace: []string{writeAt(1, "tests/orders/place.spec.ts"), ranPlace(2, "?", "pipe"), writeAt(3, "lib/orders/place.ts")}},
			func(t *testing.T, r Result) {
				wantNone(t, testFirst(r.Out()), "reported an unreadable run as no red run", "no-red-run")
				wantAll(t, testFirst(r.Out()), "?    lib/orders/place.ts  (a test run the trace could not judge: pipe)")
				wantAll(t, r.Out(), "unmeasured, not missed")
			}},
		{"a `?` from before why= existed is unmeasured too",
			statsRun{trace: []string{writeAt(1, "tests/orders/place.spec.ts"), ranPlace(2, "?", ""), writeAt(3, "lib/orders/place.ts")}},
			func(t *testing.T, r Result) {
				wantAll(t, testFirst(r.Out()), "(a test run the trace could not judge: not-recorded)")
			}},
		{"a `?` that was not a failed test run leaves the miss standing",
			statsRun{trace: []string{writeAt(1, "tests/orders/place.spec.ts"), ranPlace(2, "?", "not-the-runner"), writeAt(3, "lib/orders/place.ts")}},
			func(t *testing.T, r Result) { wantAll(t, testFirst(r.Out()), "MISS lib/orders/place.ts  (no-red-run)") }},
		{"the test-first warning counts source files and the runs they span",
			func() statsRun {
				one := []string{writeAt(1, "tests/orders/place.spec.ts"), writeAt(2, "lib/orders/place.ts")}
				var two []string
				for _, l := range one {
					two = append(two, strings.Replace(l, "10:0", "11:0", 1))
				}
				return statsRun{archived: []snapshot{{slug: "one", trace: one}, {slug: "two", trace: two}}}
			}(),
			func(t *testing.T, r Result) {
				wantAll(t, r.Out(), "2 of 2 source file(s) across 2 runs show no red test run before the code")
			}},
		// A verdict is evidence for the test it ran, not for every test written before it.
		{"a red run of one test credits that test alone",
			statsRun{trace: threePairs(ranOn(10, "red", "tests/orders/place.spec.ts", ""))},
			func(t *testing.T, r Result) {
				wantAll(t, testFirst(r.Out()), "OK   lib/orders/place.ts  (red-first)", "MISS lib/orders/cancel.ts  (no-red-run)", "MISS lib/orders/ship.ts  (no-red-run)")
			}},
		{"an unreadable run of one test leaves the others missed, not unmeasured",
			statsRun{trace: threePairs(ranOn(10, "?", "tests/orders/place.spec.ts", "pipe"))},
			func(t *testing.T, r Result) {
				wantAll(t, testFirst(r.Out()), "?    lib/orders/place.ts  (a test run the trace could not judge: pipe)", "MISS lib/orders/ship.ts  (no-red-run)")
			}},
		{"a red run of the tests' directory credits each test under it",
			statsRun{trace: threePairs(ranOn(10, "red", "tests/orders", ""))},
			func(t *testing.T, r Result) {
				wantAll(t, testFirst(r.Out()), "OK   lib/orders/place.ts  (red-first)", "OK   lib/orders/cancel.ts  (red-first)", "OK   lib/orders/ship.ts  (red-first)")
			}},
		{"a red run that names no path is unjudged, not credited",
			statsRun{trace: threePairs(ranOn(10, "red", "-", ""))},
			func(t *testing.T, r Result) {
				wantAll(t, testFirst(r.Out()), "?    lib/orders/ship.ts  (a test run the trace could not judge: no-path)")
			}},
		// A whole-suite run with its output thrown away, as an older trace recorded it.
		{"a target holding only a redirection names no path",
			statsRun{trace: threePairs(ranOn(10, "red", ">/dev/null;", ""))},
			func(t *testing.T, r Result) {
				wantAll(t, testFirst(r.Out()), "?    lib/orders/ship.ts  (a test run the trace could not judge: no-path)")
			}},
		// jest and vitest match an argument anywhere in a path: `place.spec.ts` runs `replace.spec.ts` too.
		{"a name found inside a test's name, not at a path segment, is unjudged",
			statsRun{trace: []string{writeAt(1, "tests/orders/replace.spec.ts"), ranOn(2, "red", "place.spec.ts", ""), writeAt(3, "lib/orders/replace.ts")}},
			func(t *testing.T, r Result) {
				wantAll(t, testFirst(r.Out()), "?    lib/orders/replace.ts  (a test run the trace could not judge: pattern)")
			}},
		// A run that loaded a config or a module, or matched a glob, ran a suite the trace cannot see into.
		{"a run naming only a config, a module, or a glob is unjudged, never a miss",
			statsRun{trace: threePairs(ranOn(10, "red", "config/unit.json", ""), ranOn(11, "red", "ts-node/register", ""), ranOn(12, "red", "tests/orders/*.spec.ts", ""))},
			func(t *testing.T, r Result) {
				wantAll(t, testFirst(r.Out()), "?    lib/orders/ship.ts  (a test run the trace could not judge: no-test-path,glob)")
			}},
		{"a run of another directory of tests is not a run of these",
			statsRun{trace: threePairs(ranOn(10, "red", "tests/billing", ""))},
			func(t *testing.T, r Result) { wantAll(t, testFirst(r.Out()), "MISS lib/orders/ship.ts  (no-red-run)") }},
		{"a target is matched past ./, ../, a subshell paren, and from Git Bash",
			func() statsRun {
				at := func(p string) string { return `C:\Users\i\repo\` + strings.ReplaceAll(p, "/", `\`) }
				trace := []string{writeAt(1, at("tests/orders/place.spec.ts")), writeAt(2, at("tests/orders/cancel.spec.ts")), writeAt(3, at("tests/orders/ship.spec.ts")), writeAt(4, at("tests/orders/pack.spec.ts")),
					ranOn(5, "red", "./tests/orders/place.spec.ts", ""), ranOn(6, "red", "../tests/orders/cancel.spec.ts)", ""),
					ranOn(7, "red", "/c/Users/i/repo/tests/orders/ship.spec.ts", ""), ranOn(8, "red", `tests\\orders\\pack.spec.ts`, "")}
				for i, m := range []string{"place", "cancel", "ship", "pack"} {
					trace = append(trace, writeAt(10+i, at("lib/orders/"+m+".ts")))
				}
				return statsRun{trace: trace}
			}(),
			func(t *testing.T, r Result) {
				wantAll(t, testFirst(r.Out()), "place.ts  (red-first)", "cancel.ts  (red-first)", "ship.ts  (red-first)", "pack.ts  (red-first)")
			}},
		// Two changes in one log can each write a `utils.spec.ts`.
		{"a source is credited by a red run of any test under its test's name",
			statsRun{trace: []string{writeAt(1, "tests/item/utils.spec.ts"), writeAt(2, "lib/item/utils.ts"), writeAt(3, "tests/city/utils.spec.ts"), ranOn(4, "red", "tests/city/utils.spec.ts", ""), writeAt(5, "lib/city/utils.ts")}},
			func(t *testing.T, r Result) {
				wantAll(t, testFirst(r.Out()), "OK   lib/city/utils.ts  (red-first)", "MISS lib/item/utils.ts  (no-red-run)")
			}},
		// The shape a real run left: Windows paths written, a relative target
		// run, and a target from before run-trace kept only the runner's command.
		{"a target is matched to a Windows path, and past what another command left in it",
			statsRun{trace: []string{writeAt(1, `C:\Users\someone\repo\tests\orders\place.spec.ts`), writeAt(2, `C:\Users\someone\repo\tests\orders\ship.spec.ts`),
				ranOn(3, "red", "tests/orders/place.spec.ts;,>/dev/null;,node_modules/eslint/bin/eslint.js", ""),
				writeAt(4, `C:\Users\someone\repo\lib\orders\place.ts`), writeAt(5, `C:\Users\someone\repo\lib\orders\ship.ts`)}},
			func(t *testing.T, r Result) {
				wantAll(t, testFirst(r.Out()), "place.ts  (red-first)")
				wantNone(t, testFirst(r.Out()), "credited a test no run named", "ship.ts  (red-first)")
			}},

		// ---- the gate: a PASS followed by nothing. The next milestone's
		// implementer works as long as it takes; the next gate line comes after.
		{"a PASS followed by the next milestone working is not a stall",
			statsRun{archived: []snapshot{{slug: "shipped", gate: []string{passAt(0), passAt(11)}, trace: []string{agentAt(1, "implementer", ""), readAt(2, "lib/orders/place.ts", ""), readAt(9, "lib/orders/ship.ts", "")}}}},
			func(t *testing.T, r Result) {
				wantNone(t, r.Out(), "called a working milestone a stall", "had to be nudged")
			}},
		{"a PASS followed by nothing at all is a stall",
			statsRun{archived: []snapshot{{slug: "shipped", gate: []string{passAt(0), passAt(15)}, trace: []string{readAt(15, "lib/orders/place.ts", "")}}}},
			func(t *testing.T, r Result) { wantAll(t, r.Out(), "had to be nudged") }},
		// A closed run's last PASS is followed by the line that closed it.
		{"a PASS followed by the run closing is no stall, whenever the next run starts",
			statsRun{archived: []snapshot{{slug: "two-runs", gate: []string{passAt(0), passAt(200)}, trace: []string{stamp(1) + " phase=done session=s closed tool=Write", readAt(200, "lib/orders/place.ts", "")}}}},
			func(t *testing.T, r Result) {
				wantNone(t, r.Out(), "called a finished run a stall", "had to be nudged")
			}},
		// What the closing turn costs lands in `(current)` after the snapshot.
		{"the closing turn's tokens, left in (current), are no run of their own",
			statsRun{trace: []string{stamp(30) + " phase=done session=s tokens model=model-alpha sidechain=false in=10 out=7 cache_read=0 cache_write=0 think=0 msgs=1 max_prompt=900"},
				archived: []snapshot{{slug: "refunds", gate: []string{passAt(5)}, trace: []string{readAt(4, "lib/orders/place.ts", "")}}}},
			func(t *testing.T, r Result) {
				wantNone(t, r.Out(), "the closing turn was counted as a run", "across 2 run(s)")
				wantAll(t, r.Out(), "1 invocation(s): 1 pass")
			}},
		{"a closed run shows no open milestone, and its closing turn is charged to it",
			statsRun{trace: []string{stamp(7) + " phase=done session=s1 tokens model=model-alpha sidechain=false in=10 out=7 cache_read=0 cache_write=0 think=0 msgs=1 max_prompt=900"},
				archived: []snapshot{{slug: "refunds", gate: []string{passAt(5)}, trace: []string{
					stamp(3) + " phase=plan session=s1 tokens model=model-alpha sidechain=true in=1 out=1 cache_read=0 cache_write=0 think=0 msgs=1 max_prompt=9 agent_id=a1",
					stamp(3) + " phase=plan session=s1 agent type=spec-flow:planner status=PLAN_READY agent_id=a1",
					readAt(4, "lib/orders/place.ts", ""), stamp(6) + " phase=done session=s1 closed tool=Write"}}}},
			func(t *testing.T, r Result) {
				wantNone(t, r.Out(), "a closed run shows an open milestone", "never reached a PASS")
				wantNone(t, r.Out(), "the closing turn stayed in (current)", "[(current)]")
				mustMatch(t, `(?s)by role \[refunds\]:.*?orchestrator\s+model-alpha\s+in 10\s+out ≥7 `, r.Out(), "the closing turn was not charged to its run")
			}},
		{"a live PASS with an implementer still working is not stalled right now",
			statsRun{gate: []string{ago(30*time.Minute) + " abc1234 cc=1.0 engine=0.1.0 phase=implement attempt=1 result=pass lint=0 test=0 unscoped=ok files=1"},
				trace: []string{ago(time.Minute) + " phase=implement read file=lib/orders/place.ts agent_id=a1"}},
			func(t *testing.T, r Result) {
				wantNone(t, r.Out(), "called a working milestone stalled", "stalled RIGHT NOW")
			}},
		{"a live PASS with nothing since is stalled right now",
			statsRun{gate: []string{ago(30*time.Minute) + " abc1234 cc=1.0 engine=0.1.0 phase=implement attempt=1 result=pass lint=0 test=0 unscoped=ok files=1"}},
			func(t *testing.T, r Result) { wantAll(t, r.Out(), "the run looks stalled RIGHT NOW") }},
	} {
		c := c
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			c.check(t, statsReport(t, c.run))
		})
	}
}
