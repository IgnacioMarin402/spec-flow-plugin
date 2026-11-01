package e2e

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// ---- every delta line is one the engine reads (ADR-048) --------------------

func notReported(out string, want []string, format string) []string {
	var missed []string
	for _, w := range want {
		if !regexp.MustCompile(strings.ReplaceAll(format, "%s", regexp.QuoteMeta(w))).MatchString(out) {
			missed = append(missed, w)
		}
	}
	return missed
}

func TestTraceDeltaShape(t *testing.T) {
	t.Parallel()
	one := func(section string) []map[string]string {
		return []map[string]string{{"specflow/archive/add/spec.md": shippedWith(section)}}
	}
	base := map[string]string{"specs/user.md": userSpec}
	for _, c := range []struct {
		name    string
		base    map[string]string
		commits []map[string]string
		check   func(t *testing.T, r Result)
	}{
		{"a SHIPPED change of this branch with a delta the engine does not read is reported", base,
			one("  - ADDED REQ-USER-002 — indented\n- **ADDED** REQ-USER-003 — bold\n- ADDED: REQ-USER-004 — colon\n- ADDED `REQ-USER-005` — backticks\n" +
				"| ADDED | REQ-USER-006 | table |\n- [ADDED] REQ-USER-007 — bracketed\n- REQ-USER-008 (ADDED) — after\n- [x] ADDED REQ-USER-009 — checkbox\n" +
				"- added REQ-USER-010 — lowercase\n### ADDED\n- ADDED\n  REQ-USER-011 — wrapped\n"),
			func(t *testing.T, r Result) {
				if r.Status == 0 {
					t.Fatalf("deltas no check reads passed: %s", r.Out())
				}
				if m := notReported(r.Out(), []string{"indented", "bold", "colon", "backticks", "table |", "bracketed", "after", "checkbox", "lowercase", "wrapped"}, `%s" names REQ-USER-0\d\d, which no delta line`); len(m) > 0 {
					t.Fatalf("not reported: %v. %s", m, r.Out())
				}
			}},
		{"a SHIPPED change of this branch naming two ids, or a range, in one delta is reported", base,
			one("- ADDED REQ-USER-002, REQ-USER-003 — export and import\n- ADDED REQ-USER-004 and REQ-USER-005 — sync\n- ADDED REQ-USER-006; REQ-USER-007 — reports\n" +
				"- ADDED REQ-USER-008 to REQ-USER-009 — audit\n- ADDED REQ-USER-010–012 — archive\n- ADDED REQ-USER-013..REQ-USER-014 — restore\n- ADDED REQ-USER-015 - REQ-USER-016 purge\n"),
			func(t *testing.T, r Result) {
				m := notReported(r.Out(), []string{"REQ-USER-002,", "REQ-USER-004 and", "REQ-USER-006;", "REQ-USER-008 to", "REQ-USER-010–012", "REQ-USER-013..", "REQ-USER-015 -"}, `"- ADDED %s[^"]*" names more than one id`)
				if r.Status == 0 || len(m) > 0 {
					t.Fatalf("not reported: %v. %s", m, r.Out())
				}
			}},
		// A verb later in a line is prose; a note need not be a delta; a separator starts the text.
		{"in a SHIPPED change, prose, notes, quotes, fences and an id in the text are not deltas", map[string]string{"specs/user.md": twoReqs},
			[]map[string]string{{"specflow/archive/tidy/spec.md": shippedWith("> What this change does to `specs/`.\n" +
				"- CHANGED REQ-USER-001 (wording), tense fixed\n" +
				"- CHANGED REQ-USER-002 (wording) — REQ-USER-001 says the rest\n" +
				"  - Changed from the old phrasing, which read as two claims\n" +
				"- ADDED REQ-USER-004 — the new flow\n" +
				"  which replaces what the REMOVED REQ-USER-001 did\n" +
				"- Added a note to the README\n" +
				"- Changed: none\n" +
				"> Note: the ADDED REQ-USER-002 is behind a flag.\n" +
				"```\n- ADDED REQ-USER-099 — an example, not a delta\n| ADDED | REQ-USER-098 |\n```\n")}},
			func(t *testing.T, r Result) {
				mustNotMatch(t, `which no delta line|more than one id|REQ-USER-09[89]`, r.Out(), "a line that is not a delta was refused")
				mustMatch(t, `REQ-USER-004 is ADDED by`, r.Out(), "the check that refuses never ran")
			}},
		{"a SHIPPED change of this branch with its deltas under another heading, or outside the section, is reported", base,
			[]map[string]string{{
				"specflow/archive/capital/spec.md":   "# Spec — a\n\n**Status:** SHIPPED 2026-10-17\n\n## Requirement Deltas\n- ADDED REQ-USER-002 — export\n",
				"specflow/archive/deeper/spec.md":    "# Spec — b\n\n**Status:** SHIPPED 2026-10-17\n\n### Requirement deltas\n- ADDED REQ-USER-003 — import\n",
				"specflow/archive/openspec/spec.md":  "# Spec — c\n\n**Status:** SHIPPED 2026-10-17\n\n## ADDED Requirements\n### REQ-USER-004 — sync\n",
				"specflow/archive/elsewhere/spec.md": "# Spec — d\n\n**Status:** SHIPPED 2026-10-17\n\n## Deltas\n- ADDED REQ-USER-005 — audit\n"}},
			func(t *testing.T, r Result) {
				for slug, said := range map[string]string{"capital": `has "## Requirement Deltas"`, "deeper": `has "### Requirement deltas"`,
					"openspec": "declares a delta outside `## Requirement deltas` (\"## ADDED Requirements\")", "elsewhere": "declares a delta outside `## Requirement deltas` (\"- ADDED REQ-USER-005"} {
					if !strings.Contains(r.Out(), "specflow/archive/"+slug+"/spec.md "+said) {
						t.Fatalf("not reported: %s. %s", slug, r.Out())
					}
				}
			}},
		{"a SHIPPED change's example in a code fence declares nothing", base,
			one("- none — infrastructure only\n```\n- ADDED REQ-USER-099 — an example, not a delta\n```\n"),
			func(t *testing.T, r Result) { passes(t, r, "an example in a fence was held as a delta") }},
		{"a SHIPPED change of this branch naming a second id after a space, or a second number, is reported", base,
			one("- ADDED REQ-USER-002 REQ-USER-003 — export and import\n- ADDED REQ-USER-004, 005 — sync\n- ADDED REQ-USER-006 to 007 — reports\n"),
			func(t *testing.T, r Result) {
				m := notReported(r.Out(), []string{"REQ-USER-002 REQ-USER-003", "REQ-USER-004, 005", "REQ-USER-006 to 007"}, `"- ADDED %s — [^"]*" names more than one id`)
				if r.Status == 0 || len(m) > 0 {
					t.Fatalf("not reported: %v. %s", m, r.Out())
				}
			}},
		{"a SHIPPED change with its verb after the id, another bullet, a quote or another verb is reported", base,
			one("| REQ-USER-002 | Export to CSV | ADDED |\n- REQ-USER-003 ADDED — export\n– ADDED REQ-USER-004 — an en dash\n> - ADDED REQ-USER-005 — quoted\n- MODIFIED REQ-USER-001 — now also PDF\n- DELETED REQ-USER-001 — gone\n"),
			func(t *testing.T, r Result) {
				for _, w := range []string{"Export to CSV | ADDED |", "REQ-USER-003 ADDED — export", "an en dash", "quoted", "now also PDF", "gone"} {
					if !strings.Contains(r.Out(), w+`" names REQ-USER-`) {
						t.Fatalf("not reported: %s. %s", w, r.Out())
					}
				}
			}},
		{"a SHIPPED change's comment, nested fence or indented example declares nothing", base,
			one("- none — infrastructure only\n<!--\n- ADDED REQ-USER-003 — dropped\n-->\n````md\n```\n- ADDED REQ-USER-099 — an example\n```\n````\n" +
				"~~~\n```\n- ADDED REQ-USER-098 — an example\n```\n~~~\n\nFor example:\n\n    - ADDED REQ-USER-097 — an example\n"),
			func(t *testing.T, r Result) { passes(t, r, "an example was held as a delta") }},
		{"a SHIPPED change with a fence never closed, or lines ended by CR alone, is still held", base,
			[]map[string]string{{"specflow/archive/open/spec.md": shippedWith("```\n- ADDED REQ-USER-002 — export\n"),
				"specflow/archive/cr/spec.md": strings.ReplaceAll(shippedWith("- ADDED REQ-USER-003 — import\n"), "\n", "\r")}},
			func(t *testing.T, r Result) {
				failsWith(t, r, `REQ-USER-002 is ADDED by specflow/archive/open`, "a delta in an unclosed fence went unread")
				mustMatch(t, `REQ-USER-003 is ADDED by specflow/archive/cr`, r.Out(), "a delta ended by CR went unread")
			}},
		// Outside the section, a word in capitals that names no id is not a delta.
		{"outside its deltas, a SHIPPED change may lead a line with a word in capitals", base,
			[]map[string]string{{"specflow/archive/cart/spec.md": "# Spec — cart\n\n**Status:** SHIPPED 2026-10-17\n\n## Non-functional / constraints\n- `REMOVED` items never reappear after a sync\n\n## Notes\nADDED in response to issue #12.\n\n## Requirement deltas\n- ADDED REQ-USER-002 — the cart syncs\n"}},
			func(t *testing.T, r Result) {
				mustNotMatch(t, "outside `## Requirement deltas`", r.Out(), "a constraint was refused as a delta")
				mustMatch(t, `REQ-USER-002 is ADDED by`, r.Out(), "the check that refuses never ran")
			}},
		{"a SHIPPED change of this branch that names an id and has no deltas section is reported", base,
			[]map[string]string{{"specflow/archive/add/spec.md": "# Spec — add\n\n**Status:** SHIPPED 2026-10-17\n\nThe user can export their data (REQ-USER-002).\n"}},
			func(t *testing.T, r Result) {
				failsWith(t, r, "specflow/archive/add/spec\\.md has no `## Requirement deltas` section", "a SHIPPED change with no deltas section passed")
			}},
		// An id is what a check binds: a line naming one no delta reads is refused, whatever its verb's case.
		{"a SHIPPED change with a table row in title case beside a delta is reported", base,
			one("- ADDED REQ-USER-001 — import\n| REQ-USER-002 | Added | export to CSV |\n| added | REQ-USER-003 | sync |\n"),
			func(t *testing.T, r Result) {
				failsWith(t, r, `"\| REQ-USER-002 \| Added \| export to CSV \|" names REQ-USER-002`, "a row naming an id no delta reads passed")
				mustMatch(t, `"\| added \| REQ-USER-003 \| sync \|" names REQ-USER-003`, r.Out(), "a row naming an id no delta reads passed")
			}},
		{"a SHIPPED change whose delta text quotes a comment marker hides no delta", base,
			[]map[string]string{{"specflow/archive/html/spec.md": shippedWith("- ADDED REQ-USER-001 — strips `<!--` from names\n- ADDED REQ-USER-002 — export\n- ADDED REQ-USER-003 — strips `-->` too\n")}},
			func(t *testing.T, r Result) {
				failsWith(t, r, `REQ-USER-002 is ADDED by specflow/archive/html`, "deltas between quoted comment markers went unread")
				mustMatch(t, `REQ-USER-003 is ADDED by specflow/archive/html`, r.Out(), "deltas between quoted comment markers went unread")
			}},
		{"in a SHIPPED change, HTTP words, CRUD headings and numbers in the text are not deltas", map[string]string{"specs/user.md": twoReqs},
			[]map[string]string{{"specflow/archive/api/spec.md": "# Spec — api\n\n**Status:** SHIPPED 2026-10-17\n\n## Constraints\n| /users/:id | DELETE | REQ-USER-001 |\n- REQ-USER-001 (deleted users are hidden) is unchanged\n\n" +
				"## Requirement deltas\n### Update\n- ADDED REQ-USER-002 - 404 or 410 for a deleted user\n  - REQ-USER-002 DELETE /users/:id answers 204\n  - UPDATE statements run in one transaction\n### Delete\n- ADDED REQ-USER-009 — the check runs\n"}},
			func(t *testing.T, r Result) {
				mustNotMatch(t, "which no delta line|more than one id|outside `## Requirement deltas`", r.Out(), "a correct line was refused")
				mustMatch(t, `REQ-USER-009 is ADDED by`, r.Out(), "the check that refuses never ran")
				mustNotMatch(t, `REQ-USER-002 is ADDED by`, r.Out(), "a declared id was held")
			}},
		// `REQ-USER-10` is no id: copied into specs/ and a test, it binds nothing.
		{"a SHIPPED change with a malformed id in a delta line is reported", base,
			one("- ADDED REQ-USER-001 — import\n- ADDED REQ-USER-10 — export to CSV\n"),
			func(t *testing.T, r Result) {
				failsWith(t, r, `"- ADDED REQ-USER-10 — export to CSV" names REQ-USER-10, which no check reads as an id`, "a malformed id passed")
			}},
		{"a SHIPPED change whose delta text starts with a dash and names another id holds one delta",
			map[string]string{"specs/user.md": twoReqs, ".spec-flow/config.json": traceContract("tests/user.test.ts::REQ-USER-001 a", "tests/user.test.ts::REQ-USER-002 b")},
			[]map[string]string{{"specflow/archive/drop/spec.md": shippedWith("- REMOVED REQ-USER-003 – superseded by REQ-USER-002\n")}},
			func(t *testing.T, r Result) { passes(t, r, "a delta whose text names an id after a dash was refused") }},
		{"a SHIPPED fix brief that says it has no delta in other words passes", base,
			[]map[string]string{{"specflow/archive/fix-thing/spec.md": "# Fix — thing\n\n**Status:** SHIPPED 2026-10-17\n\n## Case\n2 WEAK-TEST\n\n## Requirement deltas\nNo change — REQ-USER-001 is right; its test missed a case\n"}},
			func(t *testing.T, r Result) { passes(t, r, "a section that says it has no delta was refused") }},
		// Ids are permanent: what a later change removed stays removed.
		{"an id an inherited change REMOVED later is retired, not missing",
			map[string]string{"specs/user.md": userSpec, "specflow/archive/old/spec.md": shippedSpec("ADDED REQ-USER-002 — the user can export"), "specflow/archive/drop/spec.md": shippedSpec("REMOVED REQ-USER-002 — export is gone")},
			[]map[string]string{{"specflow/archive/old/spec.md": shippedSpec("ADDED REQ-USER-002 — the user can export their data")}},
			func(t *testing.T, r Result) {
				passes(t, r, "a requirement a shipped change removed was reported missing")
			}},
		{"an ADDED id an archived change retired in another spelling is a reused id",
			map[string]string{"specs/user.md": userSpec, "specflow/archive/old/spec.md": shippedWith("- REMOVED REQ-USER-003, REQ-USER-004 — both gone\n")},
			[]map[string]string{{"specflow/again/spec.md": "# Spec — again\n\n## Requirement deltas\n- ADDED REQ-USER-004 — back again\n", "specflow/again/proposal.md": "# Proposal\n\nWhy.\n"}},
			func(t *testing.T, r Result) {
				failsWith(t, r, `ADDs REQ-USER-004, which this spec or a shipped change REMOVED`, "a retired id was given to a new requirement")
			}},
		// ---- a change has a folder of its own in the archive
		{"a change folded inside another change's archive folder is reported", base,
			[]map[string]string{{"specflow/archive/fix-login/spec.md": "# Fix — login\n\n**Status:** SHIPPED 2026-07-30\n\n## Requirement deltas\n- none\n",
				"specflow/archive/fix-login/fix-login/spec.md": "# Fix — login again\n\n**Status:** SHIPPED 2026-10-17\n\n## Requirement deltas\n- ADDED REQ-USER-002 — x\n"}},
			func(t *testing.T, r Result) {
				failsWith(t, r, `specflow/archive/fix-login/fix-login/ holds a change spec inside another change's folder`, "a nested change passed")
			}},
		{"a folder nested inside an archived change the base already had is not held here",
			map[string]string{"specs/user.md": userSpec, "specflow/archive/old/spec.md": "# Spec — old\n\n**Status:** SHIPPED 2026-07-30\n\n## Requirement deltas\n- none\n",
				"specflow/archive/old/old/spec.md": "# Spec — old again\n\n**Status:** SHIPPED 2026-08-01\n\n## Requirement deltas\n- none\n"},
			[]map[string]string{{"README.md": "unrelated\n"}},
			func(t *testing.T, r Result) { passes(t, r, "this branch was blocked over a fold it inherited") }},
		{"a folder this branch nested inside an archived change the base had is reported",
			map[string]string{"specs/user.md": userSpec, "specflow/archive/fix-login/spec.md": "# Fix — login\n\n**Status:** SHIPPED 2026-07-30\n\n## Requirement deltas\n- none\n"},
			[]map[string]string{{"specflow/archive/fix-login/fix-login/spec.md": "# Fix — login again\n\n**Status:** REJECTED 2026-10-17\n\n## Requirement deltas\n- none\n"}},
			func(t *testing.T, r Result) {
				failsWith(t, r, `fix-login/fix-login/ holds a change spec`, "a fold this branch made inside another change passed")
			}},
		// The base's own change is still the base's when this branch nests a fold in it.
		{"a fold nested inside the base's change does not make that change this branch's",
			map[string]string{"specs/user.md": userSpec, "specflow/archive/foo/spec.md": shippedSpec("ADDED REQ-USER-005 — drift from before")},
			[]map[string]string{{"specflow/archive/foo/foo/spec.md": "# Spec — foo again\n\n**Status:** REJECTED 2026-10-17\n\n## Requirement deltas\n- none\n"}},
			func(t *testing.T, r Result) {
				mustNotMatch(t, `REQ-USER-005`, r.Out(), "the base's change was blamed on this branch")
				mustMatch(t, `foo/foo/ holds a change spec`, r.Out(), "the nested fold was not reported")
			}},
	} {
		c := c
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			c.check(t, traceBranch(t, c.base, c.commits, branchOpts{}))
		})
	}
	// A fold an earlier run nested is that run's: said until this run's fold.
	t.Run("before the fold, a fold an earlier run of this branch nested is said, not failed", func(t *testing.T) {
		t.Parallel()
		r := traceBranch(t, map[string]string{"specs/user.md": userSpec, "specflow/archive/fix-login/spec.md": "# Fix — login\n\n**Status:** SHIPPED 2026-07-30\n\n## Requirement deltas\n- none\n"},
			[]map[string]string{{"specflow/archive/fix-login/fix-login/spec.md": "# Fix — login again\n\n**Status:** REJECTED 2026-10-17\n\n## Requirement deltas\n- none\n"}, twoRuns[1]},
			branchOpts{state: map[string]string{"phase": "implement"}})
		passes(t, r, "run two's milestone gate failed over run one's fold")
		mustMatch(t, `(?s)held from the fold's gate on.*fix-login/fix-login/ holds a change spec`, r.Out(), "the nested fold went unsaid")
	})
	// Only where a filesystem tells the two apart can both be written.
	t.Run("two archived folders a case apart are reported, unless both are the base's", func(t *testing.T) {
		t.Parallel()
		probe := t.TempDir()
		write(t, filepath.Join(probe, "Aa"), "")
		if _, err := os.Stat(filepath.Join(probe, "aA")); err == nil {
			t.Skip("this filesystem folds case")
		}
		archivedAs := func(name string) map[string]string {
			return map[string]string{"specflow/archive/" + name + "/spec.md": "# Fix — " + name + "\n\n**Status:** REJECTED 2026-07-30\n\n## Requirement deltas\n- none\n"}
		}
		r := traceBranch(t, merge(map[string]string{"specs/user.md": userSpec}, archivedAs("Fix-Login")), []map[string]string{archivedAs("fix-login")}, branchOpts{})
		failsWith(t, r, `specflow/archive/Fix-Login/ and specflow/archive/fix-login/ differ only in case`, "a case-variant fold of this branch passed")
		r = traceBranch(t, merge(map[string]string{"specs/user.md": userSpec}, archivedAs("Fix-Login"), archivedAs("fix-login")), []map[string]string{{"README.md": "unrelated\n"}}, branchOpts{})
		passes(t, r, "this branch was blocked over a pair it inherited")
	})
}

func TestTraceRepoCases(t *testing.T) {
	t.Parallel()
	for _, c := range []struct {
		name  string
		files map[string]string
		check func(t *testing.T, r Result)
	}{
		// A run signed off before a spelling was refused builds on; its fold is held to it.
		{"a live spec with a delta the engine does not read does not fail a milestone gate", map[string]string{"specs/user.md": userSpec,
			"specflow/add-io/spec.md":     "# Spec — add io\n\n## Requirement deltas\n- ADDED REQ-USER-002, REQ-USER-003 — export and import\n- **ADDED** REQ-USER-004 — sync\n",
			"specflow/add-io/proposal.md": "# Proposal\n\nWhy.\n"},
			func(t *testing.T, r Result) {
				passes(t, r, "a milestone gate failed over a spelling its run was signed off with")
			}},
		// A name the archive gains mid-run is refused at spec time, never at a milestone gate.
		{"a live change named like an archived one is not failed at a milestone gate", map[string]string{"specs/user.md": userSpec,
			"specflow/archive/fix-login/spec.md": "# Fix — login\n\n**Status:** SHIPPED 2026-07-30\n\n## Requirement deltas\n- none\n",
			"specflow/fix-login/spec.md":         "# Spec — fix login again\n\n## Requirement deltas\n- none\n",
			"specflow/fix-login/proposal.md":     "# Proposal\n\nWhy.\n"},
			func(t *testing.T, r Result) {
				passes(t, r, "a milestone gate failed over a clash its run cannot rename its way out of")
			}},
		{"an archived change's own milestones and telemetry are not changes", map[string]string{"specs/user.md": userSpec,
			"specflow/archive/add-users/spec.md":                 "# Spec — add users\n\n**Status:** SHIPPED 2026-07-30\n\n## Requirement deltas\n- none\n",
			"specflow/archive/add-users/milestones/M1.md":        "# M1\n",
			"specflow/archive/add-users/telemetry/run-trace.log": "x\n"},
			func(t *testing.T, r Result) { passes(t, r, "a change's own files were read as a nested change") }},
		// ---- an empty spec layer: grace while adopting, contradiction after a ship
		{"an empty spec layer passes while nothing has shipped yet", map[string]string{".spec-flow/config.json": traceContract("an unrelated test that proves no requirement")},
			func(t *testing.T, r Result) {
				passes(t, r, "a repo mid-adoption was blocked")
				mustMatch(t, `no requirements to bind`, r.Out(), "unexpected output")
			}},
		{"an empty spec layer FAILS once a change ships a requirement it claims landed", map[string]string{
			"specflow/archive/add-users/spec.md":     "# Spec — add users\n\n**Status:** SHIPPED 2026-07-30\n\n## Requirement deltas\n- ADDED REQ-USER-001 — the user can do the thing\n",
			"specflow/archive/add-users/proposal.md": "# Proposal\n\nWhy.\n",
			"tests/placeholder.test.ts":              "it(\"unrelated\", () => {});\n"},
			func(t *testing.T, r Result) {
				failsWith(t, r, `SHIPPED`, "a change claims its deltas landed in an empty specs/, and spec-trace reported green")
			}},
		// `/spec-fix` case 4 and any wiring-only change ship with no deltas, by contract.
		{"a SHIPPED change with no requirement deltas keeps the grace", map[string]string{
			"specflow/archive/wiring-only/spec.md":     "# Fix — wiring only\n\n**Status:** SHIPPED 2026-08-14\n\n## Case\ncase 4 — INFRA\n\n## Requirement deltas\n- none — infrastructure only\n",
			"specflow/archive/wiring-only/proposal.md": "# Proposal\n\nWhy.\n",
			".spec-flow/config.json":                   traceContract("an unrelated test that proves no requirement")},
			func(t *testing.T, r Result) { passes(t, r, "an infrastructure fix with no deltas blocked the gate") }},
		// A stale artifact cannot be REPORTED as having run; no build-directory skip list is wanted.
		{"a stale test surviving only in build output does not prove a requirement", map[string]string{"specs/user.md": userSpec,
			".spec-flow/config.json":  traceContract("tests/other.test.ts::an unrelated test that did run"),
			"dist/tests/user.test.ts": "it('REQ-USER-001 lets the user do the thing', () => {});\n"},
			func(t *testing.T, r Result) { failsWith(t, r, `REQ-USER-001`, "a build artifact counted as proof") }},
	} {
		c := c
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			r, _ := traceRepo(t, c.files)
			c.check(t, r)
		})
	}
}
