package specshape

import (
	"reflect"
	"regexp"
	"strings"
	"testing"
)

func specWith(assumptions string) string {
	return "# Spec — x\n\n## Requirement deltas\n- ADDED REQ-A-001 — a thing\n" + assumptions + "\n## Out of scope\n- nothing\n"
}

func TestAssumptions(t *testing.T) {
	for _, s := range []string{
		specWith("\n## Assumptions\n- none\n"),
		specWith("\n## Assumptions\n- emails are unique — a merge flow is needed if not\n"),
		specWith("\n## Assumptions\n1. emails are unique — a merge flow if not\n"),
		specWith("\n## Assumptions\n+ none\n"),
		"# Fix — x\n\n## Case\n2 WEAK-TEST\n", // a fix brief is exempt
	} {
		if p := AssumptionsProblem(s); p != "" {
			t.Errorf("refused: %q\n%s", p, s)
		}
	}
	if p := AssumptionsProblem(specWith("")); !strings.Contains(p, "no `## Assumptions` section") {
		t.Errorf("no section: %q", p)
	}
	if p := AssumptionsProblem(specWith("\n## Assumptions\n\n")); !strings.Contains(p, "empty") {
		t.Errorf("an empty section: %q", p)
	}
}

// A delta touches the spec declaring its id, else the longest prefix, else none.
func TestCapabilityOf(t *testing.T) {
	specs := []Spec{{File: "specs/user.md", IDs: DeclaredIDs("### REQ-USER-001 — a\n### REQ-USER-PROFILE-007 — moved here\n")}, {File: "specs/user-profile.md", IDs: map[string]bool{}}}
	for id, want := range map[string]string{"REQ-USER-PROFILE-007": "specs/user.md", "REQ-USER-PROFILE-008": "specs/user-profile.md", "REQ-USER-002": "specs/user.md", "REQ-ORDER-001": ""} {
		if got := CapabilityOf(id, specs); got != want {
			t.Errorf("%s: %q, want %q", id, got, want)
		}
	}
	// An ADDED id whose capability has no file touches no other capability.
	if got := CapabilityOf("REQ-USER-PROFILE-001", []Spec{{File: "specs/user.md", IDs: DeclaredIDs("### REQ-USER-001 — a\n")}}); got != "" {
		t.Errorf("got %q", got)
	}
}

// ---- the deltas: one grammar, read or refused

func deltasOf(section string) string {
	return "# Spec — x\n\n## Requirement deltas\n" + section + "\n\n## Assumptions\n- none\n"
}

func readOf(section string) []string {
	out := []string{}
	for _, d := range Deltas(deltasOf(section)) {
		out = append(out, d.Verb+" "+d.ID)
	}
	return out
}

func refusedOf(section string) []string {
	out := []string{}
	for _, u := range UnreadDeltas(deltasOf(section)) {
		out = append(out, u.Why)
	}
	return out
}

func eq(t *testing.T, got, want []string, why string) {
	t.Helper()
	if len(got) == 0 && len(want) == 0 {
		return
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("%s: got %q, want %q", why, got, want)
	}
}

func has(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

func TestADeltaIsOneLine(t *testing.T) {
	eq(t, readOf("- ADDED   REQ-A-001 — a\n* CHANGED REQ-A-002 (wording) — b\n-REMOVED REQ-A-003 — c"), []string{"ADDED REQ-A-001", "CHANGED REQ-A-002", "REMOVED REQ-A-003"}, "read")
	eq(t, refusedOf("- ADDED REQ-A-001 — a"), nil, "refused")
}

func TestADeltaSpelledAnyOtherWayIsRefused(t *testing.T) {
	for _, line := range []string{
		"- ADDED\n  REQ-A-002 — wrapped after its verb", "| ADDED | REQ-A-002 | a table row |", "- [ADDED] REQ-A-002 — bracketed",
		"- (ADDED) REQ-A-002 — in parentheses", "- REQ-A-002 (ADDED) — the verb after the id", "- [x] ADDED REQ-A-002 — a checkbox",
		"- **ADDED** REQ-A-002 — bold", "+ ADDED REQ-A-002 — a plus sign", "  - ADDED REQ-A-002 — indented", "### ADDED REQ-A-002 — a heading",
		"- added REQ-A-002 — lowercase", "- ADDED: REQ-A-002 — a colon",
		// the verb after the id, another bullet, or in a quote
		"| REQ-A-002 | Export to CSV | ADDED |", "- REQ-A-002 ADDED — export", "- REQ-A-002: ADDED — export", "– ADDED REQ-A-002 — an en dash",
		"• ADDED REQ-A-002 — a bullet", "> - ADDED REQ-A-002 — quoted", "- Added REQ-A-002 — export", "· ADDED REQ-A-002 — a middle dot",
		" - ADDED REQ-A-002 — a no-break space before the dash", "a) ADDED REQ-A-002 — a lettered list", "- NEW REQ-A-002 — another word",
		"- REQ-A-002 Added — the verb after the id", "- REQ-A-002 — ADDED: the verb in the text",
		// a verb another format writes
		"- MODIFIED REQ-A-001 — now also PDF", "- UPDATED REQ-A-001 — x", "- DELETED REQ-A-001 — gone", "- RENAMED REQ-A-001 — to export", "- Updated REQ-A-001 wording",
	} {
		eq(t, readOf(line), nil, line)
		if !has(refusedOf(line), "unread") {
			t.Errorf("skipped, not refused: %q", line)
		}
	}
}

func TestASecondIDOrARangeIsRefused(t *testing.T) {
	for _, line := range []string{
		"- ADDED REQ-A-002, REQ-A-003 — two", "- ADDED REQ-A-002 and REQ-A-003 — two", "- ADDED REQ-A-002; REQ-A-003 — two",
		"- ADDED REQ-A-002 to REQ-A-004 — a range", "- ADDED REQ-A-002–004 — a range", "- ADDED REQ-A-002..REQ-A-004 — a range",
		"- ADDED REQ-A-009 - REQ-A-010 a range", "- CHANGED REQ-A-001 (wording), REQ-A-002 — two", "- ADDED REQ-A-002 REQ-A-003 — two",
		"- ADDED REQ-A-001, 002 — export and import", "- ADDED REQ-A-001 to 002 — x", "- ADDED REQ-A-001 – 002 — x", "- ADDED REQ-A-001/002 — x",
		"- ADDED REQ-A-002—004 — x", "- ADDED REQ-A-002 .. 004 — x", "- ADDED REQ-A-002 & 003 — x", "- ADDED REQ-A-002 and 003 — x", "- ADDED REQ-A-001~003 — x",
		"- ADDED REQ-A-001 - and REQ-A-003 — two", // a dash before a joining word joins
	} {
		eq(t, refusedOf(line), []string{"two-ids"}, line)
	}
	// A number the text goes on from is the text.
	for _, line := range []string{
		"- ADDED REQ-A-001 — 300 requests per second", "- ADDED REQ-A-001 100 users can export at once", "- ADDED REQ-A-001: 500 errors are retried",
		"- ADDED REQ-A-001 - 500 errors are retried", "- CHANGED REQ-A-001 (wording) — 300 ms", "- ADDED REQ-A-002 - 404 or 410 for a deleted user",
		"- ADDED REQ-A-002 – 100 to 200 ms jitter is tolerated", "- ADDED REQ-A-002 - 401, not 403, for a bad token", "- CHANGED REQ-A-001 (wording) - 300. Still the same",
		"- ADDED REQ-A-002 - export, filtered as REQ-A-001 says", "- REMOVED REQ-A-003 – superseded by REQ-A-002",
	} {
		eq(t, refusedOf(line), nil, line)
	}
	for _, id := range []string{"REQ-RFC-822-001", "REQ-ADR-009-010", "REQ-A-002-004"} {
		eq(t, readOf("- ADDED "+id+" — x"), []string{"ADDED " + id}, id)
		eq(t, refusedOf("- ADDED "+id+" — x"), nil, id)
	}
}

func TestProseNotesAndAnIDInTheTextAreNeitherReadNorRefused(t *testing.T) {
	section := strings.Join([]string{"> What this change does to `specs/`.", "- REMOVED REQ-A-001 (REQ-A-004 supersedes it)", "- REMOVED REQ-A-005 — REQ-A-006 replaces it",
		"- ADDED REQ-A-007 — 300 requests per second", "  - Removed because nobody uses it", "- Added the export button to the README", "- Changed: none",
		"Changed nothing in specs/.", "- none — infrastructure only"}, "\n")
	eq(t, readOf(section), []string{"REMOVED REQ-A-001", "REMOVED REQ-A-005", "ADDED REQ-A-007"}, "read")
	eq(t, refusedOf(section), nil, "refused")
	fenced := "- none — infrastructure only\n```\n- ADDED REQ-A-099 — an example\n| ADDED | REQ-A-098 |\n```"
	eq(t, readOf(fenced), nil, "a fenced example read")
	eq(t, refusedOf(fenced), nil, "a fenced example refused")
}

func TestDeltasSectionProblem(t *testing.T) {
	at := func(body string) string { return DeltasSectionProblem(body, false) }
	for body, want := range map[string]string{
		"# S\n\n## Requirement Deltas\n- ADDED REQ-A-002 — x\n":  `has "## Requirement Deltas"`,
		"# S\n\n### Requirement deltas\n- ADDED REQ-A-002 — x\n": `has "### Requirement deltas"`,
		"# S\n\n## ADDED Requirements\n### REQ-A-002 — x\n":      "outside `## Requirement deltas` (\"## ADDED Requirements\")",
		"# S\n\n## Deltas\n- ADDED REQ-A-002 — x\n":              "outside",
	} {
		if p := at(body); !strings.Contains(p, want) {
			t.Errorf("%q: %q, want %q", body, p, want)
		}
	}
	for _, body := range []string{"# S\n\n## Context\nWe added REQ-A-002 last time.\n\n## Requirement deltas\n- none\n", "# S\n\n```\n## Requirement Deltas\n```\n\n## Requirement deltas\n- none\n"} {
		if p := at(body); p != "" {
			t.Errorf("refused %q: %q", body, p)
		}
	}
	body := "# S\n\n## User stories\n- US-1 — x\n"
	if p := DeltasSectionProblem(body, true); !strings.Contains(p, "no `## Requirement deltas` section") {
		t.Errorf("no section where one is needed: %q", p)
	}
	if p := DeltasSectionProblem(body, false); p != "" {
		t.Errorf("no section where none is needed: %q", p)
	}
	if p := DeltasSectionProblem("# S\n\n## MODIFIED Requirements\n### Requirement: x\n\n## Requirement deltas\n- none\n", true); !strings.Contains(p, "outside `## Requirement deltas` (\"## MODIFIED Requirements\")") {
		t.Errorf("another format's verb: %q", p)
	}
}

func TestMalformedIDs(t *testing.T) {
	for _, id := range []string{"REQ-A-10", "REQ-A-02", "REQ-A-0002", "REQ_A_002", "req-a-002"} {
		section := "- ADDED REQ-A-001 — import\n- ADDED " + id + " — export"
		eq(t, readOf(section), []string{"ADDED REQ-A-001"}, id)
		eq(t, refusedOf(section), []string{"malformed"}, id)
	}
	eq(t, refusedOf("- ADDED REQ-A-001 — import\n| REQ-A-10 | Added |"), []string{"malformed"}, "a table row")
	// A word that merely starts like an id is no malformed id.
	eq(t, refusedOf(strings.Join([]string{"- ADDED REQ-A-002 — logs the `req_id` of every export", "- ADDED REQ-A-003 — the req-res cycle times out after 30 s",
		"- ADDED REQ-A-004 — a Req-to-Pay approval needs two signatures, as asked in REQ-1234", "  - req_headers are logged, never bodies",
		"- ADDED REQ-A-005 — export, proven by `TestExport/REQ-A-005_rejects_empty`"}, "\n")), nil, "words like an id")
}

func TestAVerbInCapitalsLeadsADelta(t *testing.T) {
	eq(t, refusedOf("- ADDED REQ-A-001 — import\n- ADDED: the export button"), []string{"no-id"}, "no id")
	eq(t, refusedOf("### ADDED\n- ADDED REQ-A-001 — import"), nil, "a heading grouping deltas")
	row := UnreadDeltas(deltasOf("- ADDED REQ-A-002 — export\n| ADDED | REQ-A-002 |"))
	if len(row) != 1 || row[0].Why != "not-a-delta" || strings.Contains(ExplainUnread(row[0]), "names no id") {
		t.Errorf("a row restating a delta: %+v", row)
	}
	for _, line := range []string{"| REQ-A-002 | Added | export to CSV |", "| added | REQ-A-002 | export to CSV |", "| Removed | REQ-A-002 |", "| Added | REQ-A-002 | x |"} {
		section := "- ADDED REQ-A-001 — import\n" + line
		eq(t, readOf(section), []string{"ADDED REQ-A-001"}, line)
		eq(t, refusedOf(section), []string{"unread"}, line)
	}
	eq(t, refusedOf("- ADDED REQ-A-001 — export; ADDED REQ-A-002 — import"), []string{"unread"}, "a second delta in the text")
	eq(t, refusedOf("- ADDED REQ-A-001 — export; ADDED REQ-A-002 — import\n- ADDED REQ-A-002 — import"), nil, "a second delta it declares")
}

// A note names only ids its deltas read; a delta's own text may name any.
func TestNotes(t *testing.T) {
	section := strings.Join([]string{"- REMOVED REQ-A-001 — legacy export; REQ-A-004 will replace it in a follow-up", "  - Removed for now; REQ-A-001 goes with its test",
		"- ADDED REQ-A-005 — sync", "  - Added after review; REQ-A-005 stays behind a flag", "> REQ-A-005 ships dark."}, "\n")
	eq(t, readOf(section), []string{"REMOVED REQ-A-001", "ADDED REQ-A-005"}, "read")
	eq(t, refusedOf(section), nil, "refused")
	for _, note := range []string{"  - Removed for now; REQ-A-004 will replace it", "- Changed from thirty; REQ-A-003 keeps its timeout", "REQ-A-003 keeps its timeout."} {
		eq(t, refusedOf("- REMOVED REQ-A-001 — legacy export\n"+note), []string{"unread"}, note)
	}
	api := strings.Join([]string{"### Create", "- ADDED REQ-API-008 — POST /users creates a user", "### Update", "- ADDED REQ-API-009 — PUT /users/:id replaces it",
		"  - REQ-API-009 DELETE /users/:id answers 204", "  - UPDATE statements run in one transaction", "### Delete", "- REMOVED REQ-API-010 — the batch delete",
		"  - DELETE /legacy/users now answers 410", "  - DEPRECATED since v2.3"}, "\n")
	eq(t, readOf(api), []string{"ADDED REQ-API-008", "ADDED REQ-API-009", "REMOVED REQ-API-010"}, "HTTP words read")
	eq(t, refusedOf(api), nil, "HTTP words refused")
}

func TestRetiredIDs(t *testing.T) {
	eq(t, RetiredIDs(deltasOf("- REMOVED REQ-A-001 — legacy export\n  - Removed for now; REQ-A-004 will replace it in a follow-up")), []string{"REQ-A-001"}, "a note retires nothing")
	eq(t, RetiredIDs(deltasOf("- Removed REQ-A-004 — x\n- REQ-A-005 (removed)\n| Removed | REQ-A-006 |")), nil, "another case retires nothing")
	eq(t, RetiredIDs(deltasOf("| REMOVED | REQ-A-006 |")), []string{"REQ-A-006"}, "a row in capitals")
	eq(t, RetiredIDs(deltasOf("- REMOVED REQ-A-001, REQ-A-002 — both")), []string{"REQ-A-001", "REQ-A-002"}, "two ids")
	eq(t, RetiredIDs(deltasOf("  - REMOVED REQ-A-003\n- **REMOVED** REQ-A-004\n- REQ-A-005 (REMOVED)")), []string{"REQ-A-003", "REQ-A-004", "REQ-A-005"}, "any spelling")
	eq(t, RetiredIDs(deltasOf("- REMOVED REQ-A-006 (REQ-A-007 supersedes it)\n- ADDED REQ-A-008 — x")), []string{"REQ-A-006"}, "an id in the text")
	archived := "# Spec — old\n\n**Status:** SHIPPED 2026-07-30\n\n## Requirement deltas\n- REMOVED REQ-A-001, REQ-A-002 — both gone\n"
	eq(t, ReusedIDs(deltasOf("- ADDED REQ-A-002 — again"), []string{archived}), []string{"REQ-A-002"}, "reused")
	eq(t, ReusedIDs(deltasOf("- ADDED REQ-A-002 — again"), []string{strings.Replace(archived, "SHIPPED", "REJECTED", 1)}), nil, "a change turned down removed nothing")
}

func TestCodeDeclaresNothing(t *testing.T) {
	for _, section := range []string{
		"- ADDED REQ-A-001 — x\n<!--\n- ADDED REQ-A-003 — dropped\n-->",
		"- ADDED REQ-A-001 — x\n````md\n```\n- ADDED REQ-A-099 — an example\n```\n````",
		"- ADDED REQ-A-001 — x\n~~~md\n```\n- ADDED REQ-A-099 — an example\n```\n~~~",
		"- ADDED REQ-A-001 — x\n\nFor example:\n\n    - ADDED REQ-A-099 — an example",
	} {
		eq(t, readOf(section), []string{"ADDED REQ-A-001"}, section)
		eq(t, refusedOf(section), nil, section)
	}
	// A comment marker in a code span hides nothing, and a fence ends with its list item.
	eq(t, readOf("- ADDED REQ-A-001 — strips `<!--` from names\n- ADDED REQ-A-002 — export\n- ADDED REQ-A-003 — strips `-->` too"), []string{"ADDED REQ-A-001", "ADDED REQ-A-002", "ADDED REQ-A-003"}, "quoted markers")
	eq(t, readOf("- ADDED REQ-A-001 — x\n  ```\n- ADDED REQ-A-002 — y\n  ```"), []string{"ADDED REQ-A-001", "ADDED REQ-A-002"}, "a fence in a list item")
	// A fence never closed, and lines ended by CR alone, still declare.
	eq(t, readOf("```\n- ADDED REQ-A-002 — x"), []string{"ADDED REQ-A-002"}, "an unclosed fence")
	for _, end := range []string{"\r", "\r\n"} {
		var ids []string
		for _, d := range Deltas(strings.ReplaceAll(deltasOf("- ADDED REQ-A-002 — x"), "\n", end)) {
			ids = append(ids, d.ID)
		}
		eq(t, ids, []string{"REQ-A-002"}, "line ends "+strings.ReplaceAll(strings.ReplaceAll(end, "\r", `\r`), "\n", `\n`))
	}
}

func TestOutsideTheSection(t *testing.T) {
	at := func(body string) string { return DeltasSectionProblem(body, true) }
	around := func(outside string) string {
		return "# S\n\n" + outside + "\n\n## Requirement deltas\n- ADDED REQ-A-002 — x\n"
	}
	for _, outside := range []string{
		"## Non-functional / constraints\n- `REMOVED` items never reappear after a sync\n- `ADDED` events carry the item id",
		"## Symptom\n- ADDED role admin to user 42\n- ADDED role admin to user 42", "## Notes\nADDED in response to issue #12.",
		"## User stories\n- ADDED value: users export", "## States\n### Update\n### Deleted",
		"## API\n| /users/:id | DELETE | REQ-A-001 |\n- REQ-A-001 (deleted users are hidden) is unchanged\n### REQ-A-002: DELETE /users/:id",
		"## States\n| DELETED | REQ-A-001 |", "## Context\n- added REQ-A-003 last time, as prose",
	} {
		if p := at(around(outside)); p != "" {
			t.Errorf("refused %q: %q", outside, p)
		}
	}
	if p := at(around("## Deltas\n- ADDED REQ-A-003 — y")); !strings.Contains(p, "outside `## Requirement deltas` (\"- ADDED REQ-A-003") {
		t.Errorf("a delta outside: %q", p)
	}
	if p := at(around("## Deltas\n| REMOVED | REQ-A-003 |")); !strings.Contains(p, "outside `## Requirement deltas` (\"| REMOVED | REQ-A-003 |\")") {
		t.Errorf("a row outside: %q", p)
	}
}

func TestASectionTheEngineReadsNothingIn(t *testing.T) {
	at := func(section string) string {
		return DeltasSectionProblem("# S\n\n## Requirement deltas\n"+section+"\n", true)
	}
	for _, s := range []string{"This change adds the export.", "### ADDED", "\n    - ADDED REQ-A-002 — indented into a code block", ""} {
		if p := at(s); !strings.Contains(p, "says nothing the engine reads") {
			t.Errorf("%q: %q", s, p)
		}
	}
	for _, s := range []string{"- none — infrastructure only", "- **None**", "- added REQ-A-002 — refused as a line instead"} {
		if p := at(s); p != "" {
			t.Errorf("%q: %q", s, p)
		}
	}
	if p := DeltasSectionProblem("# S\n\n## Requirement deltas\nprose\n", false); p != "" {
		t.Errorf("not needed: %q", p)
	}
	// It says it has no delta in the words writers use.
	for _, none := range []string{"None — infrastructure only", "_None._", "- n/a — wiring only", "- No requirement changes — wiring only", "- No deltas: wiring only",
		"1. none — wiring only", "  - none — wiring only", "> none — wiring only", "- Nothing changes in specs/ — wiring only",
		"No change — REQ-A-001 is right; its test missed a case", "- No new requirements — wiring only",
		"- No spec change: REQ-A-001 is right; its test missed the empty filter", "- Unchanged — REQ-A-001 stays as written", "Not applicable — infrastructure only"} {
		if p := at(none); p != "" {
			t.Errorf("%q: %q", none, p)
		}
		eq(t, refusedOf(none), nil, none)
	}
	eq(t, refusedOf("- No longer exports CSV (REQ-A-002)"), []string{"unread"}, "a sentence about a requirement")
}

// ---- a prohibition has an id of its own (ADR-045)

func problems(deltas, heading string) []string {
	if heading == "" {
		heading = "# Spec — x"
	}
	return LiveSpecProblems("x", heading+"\n\n## Requirement deltas\n"+deltas+"\n\n## Out of scope\n- nothing\n", true, nil)
}

func TestProhibitions(t *testing.T) {
	refused := func(delta string) {
		t.Helper()
		found := problems(delta, "")
		if len(found) != 1 || !regexp.MustCompile(`(?s)REQ-A-001.*prohibition|prohibition.*REQ-A-001`).MatchString(found[0]) || !strings.Contains(found[0], "id of its own") {
			t.Errorf("not refused: %s\n%q", delta, found)
		}
	}
	passes := func(delta string) {
		t.Helper()
		if found := problems(delta, ""); len(found) != 0 {
			t.Errorf("refused: %s\n%q", delta, found)
		}
	}
	for _, d := range []string{
		// paired with what the requirement allows
		"- ADDED REQ-A-001 — filters by A and B, never by C", "- ADDED REQ-A-001 — filters by A and B and never by C", "- ADDED REQ-A-001 — filters by A and B but never by C",
		"- ADDED REQ-A-001 — lists the user's orders and must not list another user's", "- ADDED REQ-A-001 — returns the order; a locked account cannot read it",
		"- ADDED REQ-A-001 — admins can delete a post — other users cannot", "- ADDED REQ-A-001: returns 404, never 500, for a missing order",
		// stated first and paired after
		"- ADDED REQ-A-001 — never stores the card, and masks it in the receipt", "- ADDED REQ-A-001 — only admins can delete a post, and the delete is logged",
		"- ADDED REQ-A-001 — when the cart is empty, checkout is never offered, and a hint is shown",
	} {
		refused(d)
	}
	for _, d := range []string{
		// only a prohibition
		"- ADDED REQ-A-001 — a guest cannot delete an order", "- ADDED REQ-A-001 — the search must not filter by C", "- ADDED REQ-A-001 — a filter never matches on C",
		"- ADDED REQ-A-001 — only an admin may delete a post", "- ADDED REQ-A-001 — Only admins and owners may delete a post",
		"- ADDED REQ-A-001 — never sends email or SMS to an unverified address", "- ADDED REQ-A-001 — filters only by name, city and country",
		"- ADDED REQ-A-001 — when the cart is empty, checkout is never offered",
		// a subordinate clause describes
		"- ADDED REQ-A-001 — returns 404 when the user cannot be found", "- ADDED REQ-A-001 — returns 404 when the user cannot be found, and logs the lookup",
		"- ADDED REQ-A-001 — cancels an order that was never paid, and emails the buyer", "- ADDED REQ-A-001 — lists a user who has never logged in as dormant, and emails them weekly",
		// ordinary uses of the words
		"- ADDED REQ-A-001 — returns not only the order but also its lines", "- ADDED REQ-A-001 — lists the only admin first, and the rest by name",
		"- ADDED REQ-A-001 — lists read-only fields, and sorts them by name", "- ADDED REQ-A-001 — lists never-expiring tokens; sorts them by owner",
		"- ADDED REQ-A-001 — the `--only` flag narrows the export, and the `neverExpires` field is listed", `- ADDED REQ-A-001 — answers "cannot be empty" for a blank name, and keeps the draft`,
		"- ADDED REQ-A-001 — onlyActive narrows the list, and neverSent is shown",
		// several claims with no prohibition are not this rule's business
		"- ADDED REQ-A-001 — filters by A and B, sorts by C; pages by 20",
		// outside an ADDED delta
		"- CHANGED REQ-A-001 (wording) — filters by A and B, never by C", "- REMOVED REQ-A-001 — filtered by A and B, never by C",
	} {
		passes(d)
	}
	body := "# Spec — x\n\nIt filters by A and B, and never by C.\n\n## Requirement deltas\n- ADDED REQ-A-001 — filters by A and B\n\n## Out of scope\n- sorting, and never paging\n"
	if found := LiveSpecProblems("x", body, true, nil); len(found) != 0 {
		t.Errorf("words outside the deltas were read: %q", found)
	}
	// A case 1 adds a requirement as a feature does.
	if found := problems("- ADDED REQ-A-001 — filters by A and B, never by C", "# Fix — x\n\n## Case\n1 UNSPECIFIED"); len(found) != 1 || !strings.Contains(found[0], "prohibition") {
		t.Errorf("a fix brief: %q", found)
	}
	found := problems("- ADDED REQ-A-001 — filters by A, never by C\n- ADDED REQ-A-002 — never sorts by C\n- ADDED REQ-A-003 — sorts by B; never by C", "")
	if len(found) != 2 || !strings.Contains(found[0], "REQ-A-001") || !strings.Contains(found[1], "REQ-A-003") {
		t.Errorf("each paired delta is named, and only those: %q", found)
	}
}
