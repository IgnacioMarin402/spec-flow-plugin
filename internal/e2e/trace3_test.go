package e2e

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const userTest = "it('REQ-USER-001 x', () => {});\n"

type traceCase struct {
	name  string
	files map[string]string
	check func(t *testing.T, r Result)
}

func runTraceCases(t *testing.T, cases []traceCase) {
	t.Helper()
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			r, _ := traceRepo(t, c.files)
			c.check(t, r)
		})
	}
}

func TestTraceBinding(t *testing.T) {
	t.Parallel()
	runTraceCases(t, []traceCase{
		// Where a test lives is no evidence; location is not consulted at all.
		{"a reported test proves its requirement wherever it lives", map[string]string{"specs/user.md": userSpec,
			".spec-flow/config.json": traceContract("somewhere/nobody/would/guess::REQ-USER-001 the user can do the thing")},
			func(t *testing.T, r Result) {
				passes(t, r, "a test the runner reported was rejected for where it lives")
			}},
		// Where a test goes is the anatomy statement's to say (ADR-026).
		{"an unproven requirement is sent to the proof surface, not to a path composed from the scope", map[string]string{"specs/user.md": userSpec,
			".spec-flow/config.json": traceContract("tests/other.test.ts::an unrelated test that did run")},
			func(t *testing.T, r Result) {
				failsWith(t, r, `\btests\b`, "the remedy does not name the proof surface")
				mustMatch(t, `\.test\.ts`, r.Out(), "the remedy does not name the proof surface")
				mustNotMatch(t, `modules/user/tests`, r.Out(), "the remedy composed a directory nothing declared")
			}},
		{"a REJECTED change keeps the grace — it asserts nothing landed", map[string]string{
			"specflow/archive/turned-down/spec.md":     "# Spec — turned down\n\n**Status:** REJECTED 2026-07-30\n\nDeltas.\n",
			"specflow/archive/turned-down/proposal.md": "# Proposal\n\nWhy not.\n",
			".spec-flow/config.json":                   traceContract("an unrelated test that proves no requirement")},
			func(t *testing.T, r Result) {
				passes(t, r, "a rejected change blocked a repo that has shipped nothing")
			}},
		// The adoption grace covers the binding and nothing else.
		{"the empty-specs grace does not swallow the other checks", map[string]string{
			"specflow/mine/spec.md":     "# Spec — mine\n\n## Decision\nThis belongs in proposal.md.\n",
			"tests/placeholder.test.ts": "it(\"unrelated\", () => {});\n"},
			func(t *testing.T, r Result) {
				failsWith(t, r, `proposal\.md`, "a leaked ## Decision and no proposal.md passed")
			}},

		// ---- the Skills field, when the contract asks for it: `none` is an
		// answer; absent or empty cannot be told from a planner that never looked.
		{"a live milestone with no Skills field fails", skillsMilestone("- Objective: do the thing\n- Files to add/change: lib/a.ts\n", skillsRequired()),
			func(t *testing.T, r Result) { failsWith(t, r, `Skills`, "a milestone said nothing about skills") }},
		{"`Skills: none` is a legitimate answer and passes", skillsMilestone("- Objective: do the thing\n- Skills: none\n", skillsRequired()),
			func(t *testing.T, r Result) { passes(t, r, `"none" was rejected`) }},
		{"a Skills field with nothing after the colon fails, like the absent one it is", skillsMilestone("- Objective: do the thing\n- Skills:\n- Files to add/change: lib/a.ts\n", skillsRequired()),
			func(t *testing.T, r Result) { failsWith(t, r, `Skills`, "an empty Skills field passed") }},
		{"a Skills field holding only whitespace fails too", skillsMilestone("- Objective: do the thing\n- **Skills**:   \n", skillsRequired()),
			func(t *testing.T, r Result) {
				if r.Status == 0 {
					t.Fatalf(`"Skills:" plus spaces passed as an answer: %s`, r.Out())
				}
			}},
		// Skills reach a session from places this engine cannot read, so the default asks nothing.
		{"a milestone with no Skills field passes when the contract never asked for one", skillsMilestone("- Objective: do the thing\n- Files to add/change: lib/a.ts\n", traceContract()),
			func(t *testing.T, r Result) { passes(t, r, "a project was failed for a field it never asked for") }},
		// The flag decides whether a gate can fail: a value to interpret is refused.
		{"a non-boolean require_skills_field is refused, not coerced", map[string]string{"specs/user.md": userSpec, "tests/user.test.ts": userTest,
			".spec-flow/config.json": traceConfig(func(tr map[string]any) { tr["require_skills_field"] = "false" })},
			func(t *testing.T, r Result) { failsWith(t, r, `require_skills_field`, `a quoted "false" was accepted`) }},

		// ---- the happy path, and the separators a requirement heading may use
		{"a requirement proven by a test title passes, in both directions", map[string]string{"specs/user.md": userSpec, "tests/user.test.ts": "it('REQ-USER-001 lets the user do the thing', () => {});\n"},
			func(t *testing.T, r Result) {
				passes(t, r, "a fully proven spec was reported as drift")
				mustMatch(t, `1 requirement`, r.Out(), "did not report the requirement it checked")
			}},
		{"a heading shaped like a requirement and not read as one is reported", map[string]string{"specs/user.md": userSpec + "\n### REQ-USER-10 — export to CSV\n\nThe system exports.\n\n#### REQ-USER-011 — import\n\nThe system imports.\n"},
			func(t *testing.T, r Result) {
				for _, h := range []string{"### REQ-USER-10 — export to CSV", "#### REQ-USER-011 — import"} {
					if r.Status == 0 || !strings.Contains(r.Out(), `"`+h+`" is no requirement the engine reads`) {
						t.Fatalf("not reported: %s. %s", h, r.Out())
					}
				}
			}},
		{"a sub-heading naming a declared id, a word like req-, and a fenced example are not reported", map[string]string{"specs/user.md": userSpec + "\n#### REQ-USER-001 — examples\n\nGiven a user.\n\n## Req-to-Pay\n\nThe flow.\n\n```\n### REQ-USER-10 — not like this\n```\n"},
			func(t *testing.T, r Result) { passes(t, r, "a correct capability spec was refused") }},
		{"a requirement heading parses with an em dash, a hyphen or a colon", map[string]string{
			"specs/user.md":          "<!-- spec-scope: modules/user -->\n\n### REQ-USER-001 — em dash\n\n### REQ-USER-002 - hyphen\n\n### REQ-USER-003: colon\n",
			".spec-flow/config.json": traceContract("REQ-USER-001 a", "REQ-USER-002 b", "REQ-USER-003 c")},
			func(t *testing.T, r Result) {
				passes(t, r, "one of the three separators failed to parse")
				mustMatch(t, `3 requirement`, r.Out(), "expected all 3 headings to parse")
			}},

		// ---- both directions
		{"a requirement with no test is reported", map[string]string{"specs/user.md": userSpec, ".spec-flow/config.json": traceContract("an unrelated test")},
			func(t *testing.T, r Result) { failsWith(t, r, `REQ-USER-001`, "an unproven requirement passed") }},
		{"a test tag with no requirement behind it is reported", map[string]string{"specs/user.md": userSpec, ".spec-flow/config.json": traceContract("REQ-USER-001 ok", "REQ-USER-999 orphan")},
			func(t *testing.T, r Result) { failsWith(t, r, `REQ-USER-999`, "an orphan test tag passed") }},
		// A table-driven test reports one line per case, already expanded.
		{"a parameterised test proves through its expanded names", map[string]string{"specs/user.md": userSpec, ".spec-flow/config.json": traceContract("REQ-USER-001 handles 1", "REQ-USER-001 handles 2")},
			func(t *testing.T, r Result) { passes(t, r, "a table-driven test did not register as proof") }},
		// No source file is read at all, so an id anywhere in one proves nothing.
		{"an id present in source but absent from the report is not proof", map[string]string{"specs/user.md": userSpec,
			".spec-flow/config.json": traceContract("tests/user.test.ts::something else entirely"),
			"tests/user.test.ts": "// REQ-USER-001 is mentioned here\nconst describeThing = (a) => (b) => a + b;\ndescribeThing('x')('REQ-USER-001 this is not a test');\n" +
				"it('REQ-USER-001 a real declaration that the runner did not report', () => {});\n"},
			func(t *testing.T, r Result) {
				failsWith(t, r, `REQ-USER-001`, "an id no reported test carried registered as proof")
			}},
		// Whatever a language calls skipping, a skipped test is absent from the report.
		{"a test that exists in every skipped form is not proof", map[string]string{"specs/user.md": userSpec,
			".spec-flow/config.json": traceContract("tests/other.test.ts::an unrelated test that did run"),
			"tests/user.test.ts":     "it.skip('REQ-USER-001 skipped', () => {});\n",
			"tests/todo.test.ts":     "test.todo('REQ-USER-001 not written yet');\n",
			"tests/suite.test.ts":    "describe.skip('REQ-USER-001', () => { it('x', () => {}); });\n",
			"tests/runtime.test.ts":  "it('REQ-USER-001', (t) => { t.skip('not today'); });\n"},
			func(t *testing.T, r Result) { failsWith(t, r, `REQ-USER-001`, "a skipped test registered as proof") }},
		{"tests the runner reports as executed count as proof", map[string]string{
			"specs/user.md":          "<!-- spec-scope: modules/user -->\n\n### REQ-USER-001 — a\n\n### REQ-USER-002 — b\n",
			".spec-flow/config.json": traceContract("REQ-USER-001 runs", "REQ-USER-002 runs")},
			func(t *testing.T, r Result) { passes(t, r, "a running test was rejected as proof") }},
		{"a requirement id that does not match its spec filename is reported", map[string]string{"specs/user.md": capSpec("REQ-BILLING-001", "", ""), "tests/user.test.ts": "it('REQ-BILLING-001 x', () => {});\n"},
			func(t *testing.T, r Result) {
				failsWith(t, r, `REQ-USER-`, "an id that drifted from its filename passed")
			}},
		{"a spec with no scope marker is reported", map[string]string{"specs/user.md": "# User\n\n### REQ-USER-001 — no marker\n", "tests/user.test.ts": userTest},
			func(t *testing.T, r Result) { failsWith(t, r, `scope marker`, "a spec with no scope marker passed") }},
		{"a repo with no specs and nothing archived says what it is not checking", map[string]string{".spec-flow/config.json": traceContract()},
			func(t *testing.T, r Result) {
				passes(t, r, "an unconfigured repo failed")
				mustMatch(t, `no requirements to bind`, r.Out(), `silence here reads as "all proven"`)
				mustMatch(t, `still checked`, r.Out(), "it did not say the grace covers only the binding")
			}},
		// No tree is read, so a dependency's tests cannot be this repo's whatever its directory.
		{"a dependency's own tests are never judged as this repo's", map[string]string{"specs/user.md": userSpec, "tests/user.test.ts": userTest,
			"node_modules/pkg/tests/dep.test.ts": "it('REQ-USER-404 from a dependency', () => {});\n"},
			func(t *testing.T, r Result) { passes(t, r, "a dependency's own test files were judged") }},
	})
}

func skillsMilestone(fields, contract string) map[string]string {
	return map[string]string{"specflow/add-users/spec.md": "# Spec — add users\n\nDeltas.\n", "specflow/add-users/proposal.md": "# Proposal\n\nWhy.\n",
		"specflow/add-users/milestones/M1.md": "# M1 — first\n\n" + fields, ".spec-flow/config.json": contract}
}

func TestTraceArchive(t *testing.T) {
	t.Parallel()
	proven := func(files map[string]string) map[string]string {
		return merge(map[string]string{"specs/user.md": userSpec, "tests/user.test.ts": userTest}, files)
	}
	live := func(slug, spec string) map[string]string {
		return map[string]string{"specs/user.md": userSpec, "specflow/" + slug + "/spec.md": spec, "specflow/" + slug + "/proposal.md": "# Proposal\n\nWhy.\n"}
	}
	runTraceCases(t, []traceCase{
		{"an archived change with a status passes", proven(map[string]string{"specflow/archive/add-user/spec.md": "# Add user\n\n**Status:** SHIPPED 2026-07-30\n"}),
			func(t *testing.T, r Result) {
				passes(t, r, "a stamped archive entry was reported")
				mustMatch(t, `1 archived change`, r.Out(), "the archive entry was not counted")
			}},
		{"an archived change with no status is reported", proven(map[string]string{"specflow/archive/add-user/spec.md": "# Add user\n\nNo status line here.\n"}),
			func(t *testing.T, r Result) {
				failsWith(t, r, `no status`, "an archived change with no recorded outcome passed")
			}},
		{"an archived folder with no spec.md at all is reported", proven(map[string]string{"specflow/archive/add-user/notes.md": "stray\n"}),
			func(t *testing.T, r Result) {
				if r.Status == 0 {
					t.Fatalf("an archived folder with no spec.md passed: %s", r.Out())
				}
			}},
		// ---- a live change spec stays light; the rationale lives next to it
		{"a live change spec carrying a Decision heading is reported", proven(map[string]string{"specflow/add-user/spec.md": "# Add user\n\n## Decision\n\nWe chose X.\n", "specflow/add-user/proposal.md": "# Why\n"}),
			func(t *testing.T, r Result) {
				failsWith(t, r, `Decision`, "a change spec carrying the rationale headings passed")
			}},
		{"a live change with no proposal.md is reported", proven(map[string]string{"specflow/add-user/spec.md": "# Add user\n\nJust the delta.\n"}),
			func(t *testing.T, r Result) {
				failsWith(t, r, `proposal\.md`, "a change with no recorded reasoning passed")
			}},
		{"a fix brief (## Case) is exempt from the split rule", proven(map[string]string{"specflow/fix-thing/spec.md": "# Fix\n\n## Case\n\n## Decision\n\nInline, and allowed here.\n", "specflow/fix-thing/proposal.md": "# Why\n"}),
			func(t *testing.T, r Result) { passes(t, r, "a /spec-fix brief was held to the split rule") }},

		// ---- ADR-009: CHANGED is proven by nothing, so it says which kind it is.
		{"a CHANGED delta with no kind is reported", live("widen", "# Spec — widen\n\n## Requirement deltas\n- CHANGED REQ-USER-001 — also locks the account after three failures\n"),
			func(t *testing.T, r Result) {
				failsWith(t, r, `REMOVED REQ-USER-001`, "the failure did not name the decomposition that makes the change provable")
			}},
		{"a CHANGED marked (wording) passes", live("tidy", "# Spec — tidy\n\n## Requirement deltas\n- CHANGED REQ-USER-001 (wording) — present tense, same meaning\n"),
			func(t *testing.T, r Result) { passes(t, r, "a re-wording that moves no proof was blocked") }},
		// `(correction)` claims the human review only `/spec-fix` stops for.
		{"a CHANGED marked (correction) outside a fix brief is reported", live("feature", "# Spec — feature\n\n## Requirement deltas\n- CHANGED REQ-USER-001 (correction) — the old text was wrong\n"),
			func(t *testing.T, r Result) {
				failsWith(t, r, `spec-fix`, "a feature spec claimed the fix flow's correction")
			}},
		{"a CHANGED marked (correction) inside a fix brief passes", live("fix-wrong-req", "# Fix — wrong req\n\n## Case\n3 WRONG-SPEC\n\n## Requirement deltas\n- CHANGED REQ-USER-001 (correction) — said 30 days, the system has always done one hour\n"),
			func(t *testing.T, r Result) { passes(t, r, "case 3 was blocked") }},
		// The fix-brief exemption is for the split, never the delta.
		{"a bare CHANGED inside a fix brief is still reported", live("fix-thing", "# Fix — thing\n\n## Case\n3 WRONG-SPEC\n\n## Requirement deltas\n- CHANGED REQ-USER-001 — rewritten\n"),
			func(t *testing.T, r Result) {
				if r.Status == 0 {
					t.Fatalf("the fix-brief exemption swallowed the delta rule: %s", r.Out())
				}
			}},
		{"an invented kind is reported rather than accepted", live("odd", "# Spec — odd\n\n## Requirement deltas\n- CHANGED REQ-USER-001 (minor) — a kind nobody defined\n"),
			func(t *testing.T, r Result) {
				if r.Status == 0 {
					t.Fatalf("an unrecognised kind passed: %s", r.Out())
				}
			}},
		{"a CHANGED named in prose outside the deltas section is not a delta", live("prose", "# Spec — prose\n\n## Requirement deltas\n- none — infrastructure only\n\n## Out of scope\n- CHANGED REQ-USER-001 — deliberately NOT part of this change\n"),
			func(t *testing.T, r Result) {
				passes(t, r, "a sentence outside the deltas section was read as a delta")
			}},

		// ---- ADR-045: a prohibition shares no id with what the requirement allows
		{"an ADDED that pairs a prohibition with another claim is reported at the gate", live("filters", "# Spec — filters\n\n## Requirement deltas\n- ADDED REQ-USER-001 — filters by A and B, never by C\n"),
			func(t *testing.T, r Result) {
				failsWith(t, r, `id of its own`, "a prohibition proven by a test of what it allows passed")
			}},
		{"an ADDED that is only a prohibition passes at the gate", live("filters", "# Spec — filters\n\n## Requirement deltas\n- ADDED REQ-USER-001 — only an admin may filter by C\n"),
			func(t *testing.T, r Result) { passes(t, r, "a prohibition on its own id was blocked") }},

		// ---- an ADDED id is new: ids are permanent so that retiring one is safe
		{"an ADDED id a shipped change REMOVED is reported", merge(live("reuse", "# Spec — reuse\n\n## Requirement deltas\n- ADDED REQ-USER-001 — a different reset flow\n"), map[string]string{
			"specflow/archive/drop/spec.md":     "# Spec — drop\n\n**Status:** SHIPPED 2026-07-30\n\n## Requirement deltas\n- REMOVED REQ-USER-001 — the old reset flow is gone\n",
			"specflow/archive/drop/proposal.md": "# Proposal\n\nWhy.\n"}),
			func(t *testing.T, r Result) {
				failsWith(t, r, `ADDs REQ-USER-001`, "a retired id was handed to a new requirement")
			}},
		{"an ADDED id the same spec REMOVES is reported", live("swap", "# Spec — swap\n\n## Requirement deltas\n- REMOVED REQ-USER-001 — old meaning\n- ADDED REQ-USER-001 — new meaning\n"),
			func(t *testing.T, r Result) {
				failsWith(t, r, `ADDs REQ-USER-001`, "REMOVED plus ADDED on one id passed")
			}},
		// A REJECTED change removed nothing.
		{"an ADDED id that only a rejected change REMOVED passes", merge(live("later", "# Spec — later\n\n## Requirement deltas\n- ADDED REQ-USER-001 — the thing\n"), map[string]string{
			"specflow/archive/no/spec.md":     "# Spec — no\n\n**Status:** REJECTED 2026-07-30 — not wanted\n\n## Requirement deltas\n- REMOVED REQ-USER-001 — proposed, never done\n",
			"specflow/archive/no/proposal.md": "# Proposal\n\nWhy.\n"}),
			func(t *testing.T, r Result) { passes(t, r, "an id retired by nothing was reported as reused") }},
	})
}

func TestTraceBranchHeadings(t *testing.T) {
	t.Parallel()
	// ADR-048: renumbering a heading the base has is a spec call, not this branch's.
	t.Run("a malformed requirement heading the base branch already has is said, not failed", func(t *testing.T) {
		t.Parallel()
		r := traceBranch(t, map[string]string{"specs/user.md": userSpec + "\n### REQ-USER-10 — legacy export\n\nThe system exports.\n"},
			[]map[string]string{{"README.md": "unrelated\n"}}, branchOpts{under: "pkg"})
		passes(t, r, "this branch was blocked over a heading it inherited")
		mustMatch(t, `not failed — the base branch already has it.*"### REQ-USER-10 — legacy export"`, r.Out(), "the inherited heading went unsaid")
	})
	t.Run("a malformed requirement heading this branch writes or rewrites fails, beside one it inherited", func(t *testing.T) {
		t.Parallel()
		legacy := userSpec + "\n### REQ-USER-10 — legacy export\n\nThe system exports.\n\n### REQ-USER-20 — legacy import\n\nThe system imports.\n"
		renamed := strings.Replace(legacy, "legacy import", "legacy import, renamed", 1)
		r := traceBranch(t, map[string]string{"specs/user.md": legacy}, []map[string]string{{"specs/user.md": renamed}},
			branchOpts{uncommitted: map[string]string{"specs/user.md": renamed + "\n#### REQ-USER-011 — sync\n\nThe system syncs.\n"}})
		if r.Status == 0 {
			t.Fatalf("headings this branch wrote passed: %s", r.Out())
		}
		for _, h := range []string{`"### REQ-USER-20 — legacy import, renamed"`, `"#### REQ-USER-011 — sync"`} {
			if !strings.Contains(r.Out(), h+" is no requirement") {
				t.Fatalf("not reported: %s. %s", h, r.Out())
			}
		}
		var inherited []string
		for _, l := range strings.Split(r.Out(), "\n") {
			if strings.Contains(l, `"### REQ-USER-10 — legacy export"`) {
				inherited = append(inherited, l)
			}
		}
		for _, l := range inherited {
			if !strings.Contains(l, "not failed") {
				t.Fatalf("the inherited heading was failed with them: %s", r.Out())
			}
		}
		if len(inherited) == 0 {
			t.Fatalf("the inherited heading went unsaid: %s", r.Out())
		}
	})
	// An archived change predates the rule; re-stamping history would rewrite the record.
	t.Run("an archived change keeps its bare CHANGED", func(t *testing.T) {
		t.Parallel()
		r := traceBranch(t, map[string]string{"specs/user.md": userSpec}, []map[string]string{{
			"specflow/archive/old/spec.md":     "# Spec — old\n\n**Status:** SHIPPED 2026-07-30\n\n## Requirement deltas\n- CHANGED REQ-USER-001 — from before this rule\n",
			"specflow/archive/old/proposal.md": "# Proposal\n\nWhy.\n"}}, branchOpts{})
		passes(t, r, "an archived change was held to a rule written after it shipped")
	})
	// Skipped where the OS refuses the link: the case is about the walk.
	t.Run("a circular symlink does not hang or crash the walk", func(t *testing.T) {
		t.Parallel()
		dir := t.TempDir()
		writeFiles(t, dir, map[string]string{".spec-flow/config.json": traceConfig(nil), "specs/user.md": userSpec, "tests/user.test.ts": userTest})
		os.MkdirAll(filepath.Join(dir, "tests", "nested"), 0o755)
		if err := os.Symlink(filepath.Join(dir, "tests"), filepath.Join(dir, "tests", "nested", "loop")); err != nil {
			t.Skipf("no symlink privilege here: %v", err)
		}
		passes(t, runTrace(t, dir), "a circular symlink broke the walk")
	})
}
