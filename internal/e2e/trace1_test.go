package e2e

import (
	"regexp"
	"strings"
	"testing"
)

// ==== proof comes from what the runner REPORTED as executed (ADR-001) ======

func TestTraceProof(t *testing.T) {
	t.Parallel()
	t.Run("a vendored dependency tree does not register as this repo's proof", func(t *testing.T) {
		t.Parallel()
		r, _ := traceRepo(t, map[string]string{"specs/user.md": userSpec, "tests/user.test.ts": "it('REQ-USER-001 x', () => {});\n",
			"venv/lib/site-packages/pkg/tests/vendored.test.ts": "it('REQ-USER-999 a third party proves its own thing', () => {});\n"})
		mustNotMatch(t, `REQ-USER-999`, r.Out(), "a vendored test became this repo's problem")
		passes(t, r, "a repo whose own specs and tests agree was blocked")
	})
	// The shape observed from a real reporter that concatenates suite titles.
	t.Run("a name built from a suite path proves a requirement", func(t *testing.T) {
		t.Parallel()
		r, _ := traceRepo(t, map[string]string{".spec-flow/config.json": traceContract("auth > rejects > REQ-USER-001 the user can do the thing"), "specs/user.md": userSpec})
		passes(t, r, "an executed test whose reported name nests the id was read as absent")
	})
	// `_` read as `-`: a title written the way identifiers are still binds.
	t.Run("an id written with underscores still binds", func(t *testing.T) {
		t.Parallel()
		r, _ := traceRepo(t, map[string]string{".spec-flow/config.json": reportContract(map[string]any{"format": "junit", "path": "reports/junit.xml"}), "specs/user.md": userSpec,
			"reports/junit.xml": `<?xml version="1.0" encoding="utf-8"?>` + "\n" + `<testsuites><testsuite name="suite" tests="1" failures="0"><testcase classname="test/user.test.ts" name="test_REQ_USER_001_the_user_can_do_the_thing" time="0.001"/></testsuite></testsuites>` + "\n"})
		passes(t, r, "a test that ran and passed was reported as absent over its spelling")
	})
	t.Run("a junit report proves a requirement", func(t *testing.T) {
		t.Parallel()
		r, _ := traceRepo(t, map[string]string{".spec-flow/config.json": reportContract(map[string]any{"format": "junit", "path": "reports/junit.xml"}), "reports/junit.xml": junitRan, "specs/user.md": userSpec})
		passes(t, r, "an executed test named in a junit report was reported as absent")
	})
	// `<skipped/>` is in the JUnit schema: "did it run" is answered without the runner.
	t.Run("a test that is <skipped/> in the report does not prove its requirement", func(t *testing.T) {
		t.Parallel()
		r, _ := traceRepo(t, map[string]string{".spec-flow/config.json": reportContract(map[string]any{"format": "junit", "path": "reports/junit.xml"}), "reports/junit.xml": junitSkipped, "specs/user.md": userSpec})
		failsWith(t, r, `has no test`, "a skipped test proved a requirement")
		mustNotMatch(t, `reported no tests at all`, r.Out(), "a report with one skipped case read as saying nothing at all")
	})
	t.Run("a report file that was never written is a refusal, not \"has no test\"", func(t *testing.T) {
		t.Parallel()
		r, _ := traceRepo(t, map[string]string{".spec-flow/config.json": reportContract(map[string]any{"format": "junit", "path": "reports/junit.xml"}), "specs/user.md": userSpec})
		failsWith(t, r, `reporter flag|does not exist`, "the refusal did not name the likely cause")
		mustNotMatch(t, `has no test`, r.Out(), "a missing report read as an unproven requirement")
	})
}

// ---- opting out, and the one thing that makes it honest ------------------

func TestTraceOptingOut(t *testing.T) {
	t.Parallel()
	report := map[string]any{"format": "junit", "path": "reports/junit.xml"}
	for _, c := range []struct {
		name  string
		files map[string]string
		check func(t *testing.T, r Result)
	}{
		{"no source and no requirements is a pass that says why it passed", map[string]string{".spec-flow/config.json": reportContract(nil)}, func(t *testing.T, r Result) {
			passes(t, r, "a repo with nothing to prove was blocked")
			mustMatch(t, `(?i)not configured`, r.Out(), "it passed without saying it was unarmed")
		}},
		{"no source WITH requirements is refused", map[string]string{".spec-flow/config.json": reportContract(nil), "specs/user.md": userSpec}, func(t *testing.T, r Result) {
			failsWith(t, r, `opt-in|opted out|trace\.report`, "an opt-out that survives its own precondition is a disarmed gate")
		}},
		// Every adopter's first run: init writes trace.report before the flag lands.
		{"a declared report that has not landed yet, with nothing to prove, is not a refusal", map[string]string{".spec-flow/config.json": reportContract(report)}, func(t *testing.T, r Result) {
			passes(t, r, "the contract init writes failed on a repo with no requirements")
			mustMatch(t, `(?i)nothing to bind|no requirement`, r.Out(), "it passed without saying it was unarmed")
		}},
		{"an unarmed source never reports requirements as proven", map[string]string{".spec-flow/config.json": reportContract(report), "specs/user.md": "<!-- spec-scope: modules/user -->\n\n# User\n\nNo requirement declared yet.\n"}, func(t *testing.T, r Result) {
			passes(t, r, "a spec file with no requirement blocked the check")
			mustNotMatch(t, `every one proven by a test`, r.Out(), "it claimed proof while nothing was read")
		}},
		{"the same grace covers the other proof source", map[string]string{".spec-flow/config.json": traceConfig(func(tr map[string]any) { tr["executed_tests"] = toAny(toolCmd("exit=3")) })}, func(t *testing.T, r Result) {
			passes(t, r, "a report source producing nothing blocked a repo with no requirements")
		}},
		{"the unarmed grace does not swallow the other checks", map[string]string{".spec-flow/config.json": reportContract(report), "specflow/archive/old-change/spec.md": "# Old change\n\nNo status line anywhere.\n"}, func(t *testing.T, r Result) {
			failsWith(t, r, `(?i)no status`, "an archived change with no status passed under the grace")
		}},
		{"declaring both sources is refused by the contract, not resolved silently", map[string]string{".spec-flow/config.json": traceConfig(func(tr map[string]any) { tr["report"] = report }), "specs/user.md": userSpec}, func(t *testing.T, r Result) {
			failsWith(t, r, `(?i)both`, "two answers to \"which tests ran\" were accepted")
		}},
		// "Nothing was proven" and "I could not tell" both exit 1: the message tells them apart.
		{"an empty report with requirements is a named refusal, not \"has no test\"", map[string]string{".spec-flow/config.json": traceContract(), "specs/user.md": userSpec}, func(t *testing.T, r Result) {
			failsWith(t, r, `(?i)report|executed_tests|no tests`, "the refusal did not name the report")
			mustNotMatch(t, `has no test`, r.Out(), "an empty report read as an unproven requirement")
		}},
		{"a report command that fails is a refusal, not an absence of proof", map[string]string{".spec-flow/config.json": traceConfig(func(tr map[string]any) { tr["executed_tests"] = toAny(toolCmd("exit=3")) }), "specs/user.md": userSpec}, func(t *testing.T, r Result) {
			if r.Status == 0 {
				t.Fatalf("a broken report command passed: %s", r.Out())
			}
			mustNotMatch(t, `has no test`, r.Out(), "a broken report command read as an unproven requirement")
		}},
	} {
		c := c
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			r, _ := traceRepo(t, c.files)
			c.check(t, r)
		})
	}
}

// ---- a SHIPPED change's deltas landed in specs/ (ADR-048) --------------------

func TestTraceShipped(t *testing.T) {
	t.Parallel()
	inRun := branchOpts{state: map[string]string{"phase": "implement"}}
	for _, c := range []struct {
		name    string
		base    map[string]string
		commits []map[string]string
		o       branchOpts
		check   func(t *testing.T, r Result)
	}{
		{"an ADDED id a SHIPPED change of this branch never wrote into specs/ is reported",
			map[string]string{"specs/user.md": userSpec},
			[]map[string]string{{"specflow/archive/add-export/spec.md": shippedSpec("ADDED REQ-USER-002 — the user can export their data")}}, branchOpts{},
			func(t *testing.T, r Result) {
				failsWith(t, r, `REQ-USER-002 is ADDED by specflow/archive/add-export/spec\.md`, "a shipped requirement nothing proves passed")
			}},
		{"a REMOVED id a SHIPPED change of this branch left in specs/ is reported",
			map[string]string{"specs/user.md": twoReqs, ".spec-flow/config.json": traceContract("tests/user.test.ts::REQ-USER-001 a", "tests/user.test.ts::REQ-USER-002 b")},
			[]map[string]string{{"specflow/archive/drop-export/spec.md": shippedSpec("REMOVED REQ-USER-002 — export is gone")}}, branchOpts{},
			func(t *testing.T, r Result) {
				failsWith(t, r, `REQ-USER-002 is REMOVED by specflow/archive/drop-export/spec\.md`, "a removal that never reached specs/ passed")
			}},
		// ADR-032: judged on its own branch; a run here does not answer for it.
		{"a SHIPPED change the base branch already has is not held here",
			map[string]string{"specs/user.md": userSpec, "specflow/archive/old/spec.md": shippedSpec("ADDED REQ-USER-002 — from before")},
			[]map[string]string{{"README.md": "unrelated\n"}}, branchOpts{},
			func(t *testing.T, r Result) { passes(t, r, "this branch was blocked over a change it inherited") }},
		// Ids are permanent, so one a later change REMOVED is retired.
		{"an ADDED id another change of this branch REMOVED is retired, not missing",
			map[string]string{"specs/user.md": userSpec},
			[]map[string]string{{"specflow/archive/add-export/spec.md": shippedSpec("ADDED REQ-USER-002 — the user can export their data"), "specflow/archive/drop-export/spec.md": shippedSpec("REMOVED REQ-USER-002 — export is gone")}}, branchOpts{},
			func(t *testing.T, r Result) {
				passes(t, r, "a requirement added and then retired was reported missing")
			}},
		// Until the fold its own change is live: an earlier run's is said, not failed.
		{"before the fold, a change the branch shipped earlier is said, not failed",
			map[string]string{"specs/user.md": userSpec}, twoRuns, inRun,
			func(t *testing.T, r Result) {
				passes(t, r, "run two's milestone gate failed over run one's change")
				mustMatch(t, `(?s)held from the fold's gate on.*REQ-USER-002`, r.Out(), "run one's drift went unsaid")
				mustNotMatch(t, `every one proven`, r.Out(), "it still says every requirement is proven")
			}},
		{"from the fold on, an earlier run's change is held",
			map[string]string{"specs/user.md": userSpec},
			[]map[string]string{{"specflow/archive/run-one/spec.md": shippedSpec("ADDED REQ-USER-002 — the user can export their data"), "specflow/archive/run-two/spec.md": shippedSpec("CHANGED REQ-USER-001 (wording) — clearer")}},
			branchOpts{state: map[string]string{"phase": "implement", "current-milestone": "run-two M1 a-implementer"}},
			func(t *testing.T, r Result) {
				failsWith(t, r, `REQ-USER-002 is ADDED by specflow/archive/run-one`, "the fold passed over run one's drift")
			}},
		// current-milestone is written best-effort and cleared by nothing.
		{"a stale current-milestone does not exempt the run's own change",
			map[string]string{"specs/user.md": userSpec},
			[]map[string]string{{"specflow/archive/run-one/spec.md": shippedSpec("CHANGED REQ-USER-001 (wording) — clearer"), "specflow/archive/run-two/spec.md": shippedSpec("ADDED REQ-USER-003 — the user can import data")}},
			branchOpts{state: map[string]string{"phase": "implement", "current-milestone": "run-one M2 a-implementer"}},
			func(t *testing.T, r Result) {
				failsWith(t, r, `REQ-USER-003 is ADDED by specflow/archive/run-two`, "the run's own change escaped under a stale milestone")
			}},
		// A folder is live with a spec in it, and only one the base lacks.
		{"an empty folder its fold left does not make the run's own change an earlier run's",
			map[string]string{"specs/user.md": userSpec}, ownFold, branchOpts{state: map[string]string{"phase": "implement"}, dirs: []string{"specflow/run-one"}},
			func(t *testing.T, r Result) { holdsOwnFold(t, r) }},
		{"a plan parked on the base does not make the run's own change an earlier run's",
			map[string]string{"specs/user.md": userSpec, "specflow/parked/spec.md": "# Spec — parked\n\n## Requirement deltas\n- none\n", "specflow/parked/proposal.md": "# Proposal\n\nWhy.\n"}, ownFold, inRun,
			func(t *testing.T, r Result) { holdsOwnFold(t, r) }},
		{"a live change created before the fold does not make the run's own change an earlier run's",
			map[string]string{"specs/user.md": userSpec},
			append([]map[string]string{{"specflow/other/spec.md": "# Spec — other\n\n## Requirement deltas\n- none\n", "specflow/other/proposal.md": "# Proposal\n\nWhy.\n"}}, ownFold...), inRun,
			func(t *testing.T, r Result) { holdsOwnFold(t, r) }},
		// A live change is as old as its first write.
		{"a live change edited after the fold is as old as its first write",
			map[string]string{"specs/user.md": userSpec},
			append(append([]map[string]string{{"specflow/other/spec.md": "# Spec — other\n\n## Requirement deltas\n- none\n", "specflow/other/proposal.md": "# Proposal\n\nWhy.\n"}}, ownFold...),
				map[string]string{"specflow/other/spec.md": "# Spec — other\n\n## Requirement deltas\n- none — edited after the fold\n"}), inRun,
			func(t *testing.T, r Result) { holdsOwnFold(t, r) }},
		// A fold and the next run's spec in one commit have no order: held as this run's.
		{"a fold committed with the next run is held as that run's",
			map[string]string{"specs/user.md": userSpec},
			[]map[string]string{merge(twoRuns[0], twoRuns[1])}, inRun,
			func(t *testing.T, r Result) {
				failsWith(t, r, `(?m)^ {2}- REQ-USER-002 is ADDED by specflow/archive/run-one`, "a fold committed with the next run passed as an earlier run's")
			}},
		// Outside a run — CI, `check` — no change is an earlier run's.
		{"outside a run, a change the branch shipped earlier is held",
			map[string]string{"specs/user.md": userSpec}, twoRuns, branchOpts{},
			func(t *testing.T, r Result) {
				failsWith(t, r, `(?m)^ {2}- REQ-USER-002 is ADDED by specflow/archive/run-one`, "outside a run, run one's drift was not held")
				mustNotMatch(t, `held from the fold's gate on`, r.Out(), "it was said as an earlier run's")
			}},
		{"an inherited change edited and not yet committed is this branch's",
			map[string]string{"specs/user.md": userSpec, "specflow/archive/old/spec.md": shippedSpec("ADDED REQ-USER-002 — from before")},
			[]map[string]string{{"README.md": "unrelated\n"}},
			branchOpts{uncommitted: map[string]string{"specflow/archive/old/spec.md": shippedSpec("ADDED REQ-USER-002 — from before, typo fixed")}},
			func(t *testing.T, r Result) {
				failsWith(t, r, `REQ-USER-002 is ADDED by specflow/archive/old`, "an edit not yet committed left the change inherited")
			}},
		// Mid-run a milestone writes its delta when it delivers it; only the stamp claims all landed.
		{"a live change is not held to its ADDED ids before it is SHIPPED",
			map[string]string{"specs/user.md": userSpec},
			[]map[string]string{{"specflow/add-export/spec.md": "# Spec — add export\n\n## Requirement deltas\n- ADDED REQ-USER-002 — the user can export their data\n", "specflow/add-export/proposal.md": "# Proposal\n\nWhy.\n"}}, branchOpts{},
			func(t *testing.T, r Result) { passes(t, r, "a milestone not yet delivered was blocked") }},
		{"a REJECTED or SUPERSEDED change of this branch is not held to its deltas",
			map[string]string{"specs/user.md": userSpec},
			[]map[string]string{{"specflow/archive/turned-down/spec.md": "# Spec — x\n\n**Status:** REJECTED 2026-10-17\n\n## Requirement deltas\n- ADDED REQ-USER-002 — export\n",
				"specflow/archive/replaced/spec.md": "# Spec — y\n\n**Status:** SUPERSEDED 2026-10-17\n\n## Requirement deltas\n- ADDED REQ-USER-003 — import\n"}}, branchOpts{},
			func(t *testing.T, r Result) {
				passes(t, r, "a change that asserts nothing landed was held to its deltas")
			}},
		{"an ADDED id a live change of this branch REMOVES is retired, not missing",
			map[string]string{"specs/user.md": userSpec},
			[]map[string]string{{"specflow/archive/add-export/spec.md": shippedSpec("ADDED REQ-USER-002 — the user can export their data"),
				"specflow/drop-export/spec.md": "# Spec — drop export\n\n## Requirement deltas\n- REMOVED REQ-USER-002 — export is gone\n", "specflow/drop-export/proposal.md": "# Proposal\n\nWhy.\n"}}, branchOpts{},
			func(t *testing.T, r Result) {
				passes(t, r, "a requirement this branch is removing was reported missing")
			}},
		// git quotes a non-ASCII name; read quoted, it matches no folder.
		{"a SHIPPED change the base holds under a non-ASCII name is not held here",
			map[string]string{"specs/user.md": userSpec, "specflow/archive/añadir-exportación/spec.md": shippedSpec("ADDED REQ-USER-002 — from before")},
			[]map[string]string{{"README.md": "unrelated\n"}}, branchOpts{},
			func(t *testing.T, r Result) { passes(t, r, "this branch was blocked over a change it inherited") }},
		// The folder name is the base's; the change in it is this branch's.
		{"a SHIPPED change written over a folder the base archived is held here",
			map[string]string{"specs/user.md": userSpec, "specflow/archive/fix-login/spec.md": shippedSpec("CHANGED REQ-USER-001 (wording) — clearer")},
			[]map[string]string{{"specflow/archive/fix-login/spec.md": shippedSpec("ADDED REQ-USER-002 — the user can log in again")}}, branchOpts{},
			func(t *testing.T, r Result) {
				failsWith(t, r, `REQ-USER-002 is ADDED by specflow/archive/fix-login/spec\.md`, "a change this branch shipped escaped under a reused name")
			}},
		{"a project below the repository top tells inherited changes from its own",
			map[string]string{"specs/user.md": userSpec, "specflow/archive/old/spec.md": shippedSpec("ADDED REQ-USER-002 — from before")},
			[]map[string]string{{"specflow/archive/add-import/spec.md": shippedSpec("ADDED REQ-USER-003 — the user can import data")}}, branchOpts{under: "pkg"},
			func(t *testing.T, r Result) {
				mustNotMatch(t, `REQ-USER-002`, r.Out(), "an inherited change was held")
				mustMatch(t, `REQ-USER-003 is ADDED`, r.Out(), "this branch's change was not held")
			}},
	} {
		c := c
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			c.check(t, traceBranch(t, c.base, c.commits, c.o))
		})
	}
	// `check` and the gate fail with no base; the checks that need one fail with them.
	t.Run("with no base to resolve, a SHIPPED change and a nested spec fail alike, with the reason", func(t *testing.T) {
		t.Parallel()
		r, _ := traceRepo(t, map[string]string{"specs/user.md": userSpec,
			"specflow/archive/add-export/spec.md": shippedSpec("ADDED REQ-USER-002 — the user can export their data"),
			"specflow/archive/old/spec.md":        shippedSpec("CHANGED REQ-USER-001 (wording) — clearer"),
			"specflow/archive/old/old/spec.md":    shippedSpec("CHANGED REQ-USER-001 (wording) — clearer still")})
		if r.Status == 0 {
			t.Fatalf("a repo with no base passed: %s", r.Out())
		}
		m := regexp.MustCompile(`- (.*): whether these are this branch's or inherited needs the base, and no base branch could be resolved`).FindStringSubmatch(r.Out())
		if m == nil || !strings.Contains(m[1], "archive/add-export/spec.md") || !strings.Contains(m[1], "archive/old/old/spec.md") {
			t.Fatalf("not both named, or not the reason: %s", r.Out())
		}
		mustMatch(t, `fetch-depth: 0`, r.Out(), "the failure does not say how to fetch the base")
		mustMatch(t, `refs/heads/\*:refs/remotes/origin/\*`, r.Out(), "the failure does not say how to fetch the base")
		mustNotMatch(t, `every one proven`, r.Out(), "it still says every requirement is proven")
	})
}

func merge(maps ...map[string]string) map[string]string {
	out := map[string]string{}
	for _, m := range maps {
		for k, v := range m {
			out[k] = v
		}
	}
	return out
}
