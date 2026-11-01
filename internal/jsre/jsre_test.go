package jsre

import "testing"

// Each want is what `new RegExp(pattern, flags).test(input)` answers in node.
func TestLineTerminatorsAreJavaScripts(t *testing.T) {
	for _, c := range []struct {
		pattern, flags, input string
		want                  bool
	}{
		{`^B`, "m", "A\rB", true},
		{`A$`, "m", "A\rB", true},
		{`^B`, "m", "A B", true},
		{`^B`, "m", "A\nB", true},
		{`^B`, "", "A\nB", false},
		{`A$`, "", "A\n", false},
		{`A.B`, "", "A\rB", false},
		{`A.B`, "", "A B", false},
		{`A.B`, "s", "A B", true},
		{`A[.^$]B`, "m", "A.B", true},
		{`A[.^$]B`, "m", "A\rB", false},
		{`A\.B`, "", "AxB", false},
		{`[\]^]x`, "m", "^x", true},
		{`^\*\*Status:\*\*\s+SHIPPED\b`, "m", "# Spec\r\r**Status:** SHIPPED 2026-10-17\r", true},
	} {
		if got := MustCompile(c.pattern, c.flags).Test(c.input); got != c.want {
			t.Errorf("/%s/%s on %q: %v, JS says %v", c.pattern, c.flags, c.input, got, c.want)
		}
	}
}

func TestOffsetsAreBytes(t *testing.T) {
	m := MustCompile(`b+`, "").Exec("ñbb")
	if m == nil || m.Index != 2 || m.End != 4 {
		t.Fatalf("got %+v", m)
	}
}
