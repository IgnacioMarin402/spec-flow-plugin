package agents

import (
	"encoding/json"
	"reflect"
	"regexp"
	"testing"
)

func TestProjectConfig(t *testing.T) {
	// A file written after a byte-order mark is the same file.
	if s, p := ProjectConfig("\xef\xbb\xbf{\"max_opus_calls\": 2}"); p != "" || !reflect.DeepEqual(s, map[string]any{"max_opus_calls": 2.0}) {
		t.Errorf("after a BOM: %v %q", s, p)
	}
	for _, text := range []string{"", "  \n", "\xef\xbb\xbf"} {
		if s, p := ProjectConfig(text); p != "" || len(s) != 0 {
			t.Errorf("an empty file %q sets something: %v %q", text, s, p)
		}
	}
	if _, p := ProjectConfig(`{ "max_opus_calls": 2, }`); !regexp.MustCompile(`does not parse as JSON`).MatchString(p) {
		t.Errorf("an unparseable file: %q", p)
	}
	for _, text := range []string{"null", "[]", "6", `"six"`} {
		if s, p := ProjectConfig(text); len(s) != 0 || !regexp.MustCompile(`not a JSON object`).MatchString(p) {
			t.Errorf("%s: %v %q", text, s, p)
		}
	}
}

func TestMilestoneRef(t *testing.T) {
	for _, c := range []struct {
		prompt            any
		change, milestone string
		ok                bool
	}{
		// The work order, in either separator.
		{"implement specflow/add-users/milestones/M2.md per the plan", "add-users", "M2", true},
		{`implement C:\repo\specflow\add-users\milestones\M2.md`, "add-users", "M2", true},
		{"`specflow/add-users/milestones/M12.md`", "add-users", "M12", true},
		// The work order wins over a milestone file named before it.
		{"see docs/milestones/M1.md, then implement specflow/add-users/milestones/M2.md", "add-users", "M2", true},
		{"after milestones/M1.md, implement specflow/add-users/milestones/M2.md", "add-users", "M2", true},
		// A bare milestones/<Mk>.md names the milestone; one deeper in a path names nothing.
		{"re-read plan.md and milestones/M3.md", "", "M3", true},
		{"re-read `milestones\\M3.md`", "", "M3", true},
		{"see docs/milestones/M1.md", "", "", false},
		{"see ./milestones/M1.md", "", "", false},
		{"implement the plan", "", "", false},
		{"specflow/add-users/plan.md", "", "", false},
		{nil, "", "", false},
		{map[string]any{"prompt": "specflow/add-users/milestones/M2.md"}, "", "", false},
	} {
		ch, m, ok := MilestoneRef(c.prompt)
		if ch != c.change || m != c.milestone || ok != c.ok {
			t.Errorf("MilestoneRef(%v) = %q %q %v, want %q %q %v", c.prompt, ch, m, ok, c.change, c.milestone, c.ok)
		}
	}
}

func TestBudgetCap(t *testing.T) {
	capOf := func(v any) int {
		b, _ := json.Marshal(map[string]any{"max_architect_calls": v})
		return BudgetCap(string(b), "architect")
	}
	// Number() reads each of these as a count, and a fraction is no number of
	// calls: none is what a person set. Nor is null, which reads as no cap.
	for _, v := range []any{true, false, []any{5}, []any{}, "", "  ", "six", map[string]any{}, -1, 2.5, "2.5", "0x10", "1e1", "-1", nil} {
		if c := capOf(v); c != -1 {
			t.Errorf("%v read as the cap %d", v, c)
		}
	}
	for v, want := range map[any]int{0: 0, 3: 3, "4": 4, " 5 ": 5} {
		if c := capOf(v); c != want {
			t.Errorf("%v read as %d, want %d", v, c, want)
		}
	}
	for _, text := range []string{"", "{ not json", "{}", "null", "[]", "6"} {
		want := 6
		if c := BudgetCap(text, "planner"); c != want {
			t.Errorf("%q: %d, want the default %d", text, c, want)
		}
	}
	if c := BudgetCap("", "architect"); c != 3 {
		t.Errorf("the architect's default: %d", c)
	}
	if c := BudgetCap("\xef\xbb\xbf{\"max_opus_calls\": 2}", "planner"); c != 2 {
		t.Errorf("after a BOM: %d", c)
	}
	if c := BudgetCap("\xef\xbb\xbf{\"max_architect_calls\": \"three\"}", "architect"); c != -1 {
		t.Errorf("after a BOM, a cap that is no number: %d", c)
	}
}
