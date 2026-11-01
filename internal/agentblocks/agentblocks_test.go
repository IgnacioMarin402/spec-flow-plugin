package agentblocks

// An agent's markdown is read from wherever the plugin was installed, and git
// hands a Windows checkout CRLF: a parser anchored to `\n` finds nothing
// there and everything on the machine it was written on.

import (
	"reflect"
	"strings"
	"testing"
)

var block = []string{"```", "STATUS: FOLDED", "ARCHIVED: specflow/archive/x/", "GAPS: none", "```"}

func TestReturnBlocks(t *testing.T) {
	for _, end := range []string{"\n", "\r\n"} {
		n, fields := ReturnBlocks(strings.Join(block, end))
		if n != 1 || !reflect.DeepEqual(fields, []string{"STATUS", "ARCHIVED", "GAPS"}) {
			t.Errorf("%q: %d %q", end, n, fields)
		}
	}
	// The caller tells "declares none" from "the anchor moved" by this count.
	for _, text := range []string{"# just prose\n", "", "```bash\nSTATUS=1 npm test\n```"} {
		if n, fields := ReturnBlocks(text); n != 0 || len(fields) != 0 {
			t.Errorf("%q: %d %q", text, n, fields)
		}
	}
}

func TestUnroutedFields(t *testing.T) {
	// A field named only inside a longer field name is not routed.
	if got := UnroutedFields([]string{"QUESTIONS"}, "route `OPEN_QUESTIONS:` to the human", nil); !reflect.DeepEqual(got, []string{"QUESTIONS"}) {
		t.Errorf("got %q", got)
	}
	if got := UnroutedFields([]string{"READ"}, "expect `STATUS: SPEC_READY`", nil); !reflect.DeepEqual(got, []string{"READ"}) {
		t.Errorf("got %q", got)
	}
	if got := UnroutedFields([]string{"GAPS", "STATUS"}, "read its `GAPS:` line", map[string]string{"STATUS": "discriminator"}); len(got) != 0 {
		t.Errorf("got %q", got)
	}
}

func TestDeclaredStatuses(t *testing.T) {
	md := "x\n```\nSTATUS: NEEDS_INPUT\nOPEN_QUESTIONS:\n```\ny\r\n```\r\nSTATUS: SPEC_READY\r\nSPEC_PATH: a\r\n```\r\n"
	if got := DeclaredStatuses(md); !reflect.DeepEqual(got, []string{"NEEDS_INPUT", "SPEC_READY"}) {
		t.Errorf("got %q", got)
	}
}

func TestParseReturn(t *testing.T) {
	r := ParseReturn("Done.\n\n```\nSTATUS: SPEC_READY\nSPEC_PATH: specflow/x/spec.md\nSUMMARY: two lines\n```\nSTATUS: NOT_THIS\n")
	if r == nil || r.Status != "SPEC_READY" || !reflect.DeepEqual(r.Fields, map[string]string{"SPEC_PATH": "specflow/x/spec.md", "SUMMARY": "two lines"}) {
		t.Errorf("got %+v", r)
	}
	if r := ParseReturn("no block here"); r != nil {
		t.Errorf("got %+v", r)
	}
	// A status that opens a line, emphasis allowed; not one named mid-sentence.
	if r := ParseReturn("The previous round ended with STATUS: NEEDS_INPUT; the answers are in.\n\n```\nSTATUS: SPEC_READY\nSPEC_PATH: specflow/x/spec.md\n```"); r == nil || r.Status != "SPEC_READY" {
		t.Errorf("round 2: %+v", r)
	}
	if r := ParseReturn("**STATUS:** APPROVED\n**NOTES:** none"); r == nil || r.Status != "APPROVED" || !reflect.DeepEqual(r.Fields, map[string]string{"NOTES": "none"}) {
		t.Errorf("emphasis: %+v", r)
	}
	if r := ParseReturn("STATUS: **APPROVED**"); r == nil || r.Status != "APPROVED" {
		t.Errorf("an emphasised value: %+v", r)
	}
	if r := ParseReturn("The plan header says STATUS: N/A."); r != nil {
		t.Errorf("mid-sentence: %+v", r)
	}
}

func TestOpenQuestions(t *testing.T) {
	for text, want := range map[string]int{
		// the top-level questions, not the options under them
		"```\nSTATUS: NEEDS_INPUT\nOPEN_QUESTIONS:\n- Which store?\n  - (a) Postgres\n  - (b) Redis\n- Soft delete?\n```\nThanks.\n- not a question": 2,
		"STATUS: NEEDS_INPUT\r\nOPEN_QUESTIONS:\r\n1. a\r\n2. b\r\n3. c\r\n4. d\r\n":                                                                 4,
		"STATUS: NEEDS_INPUT\nOPEN_QUESTIONS:\n": 0,
		// it stops at the end of the list, and numbered questions win over flush options
		"STATUS: NEEDS_INPUT\nOPEN_QUESTIONS:\n- Which store?\n- Soft delete?\n\nWhat I found:\n- the table has no index\n- the API is versioned\n": 2,
		"```\nSTATUS: NEEDS_INPUT\nOPEN_QUESTIONS:\n1. Which store?\n- Postgres\n- Redis\n2. Soft delete?\n- yes\n- no\n```":                        2,
	} {
		if got := OpenQuestions(text); got != want {
			t.Errorf("%q: %d, want %d", text, got, want)
		}
	}
}
