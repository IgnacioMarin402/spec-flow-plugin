// Package jsre is a regular expression with ECMAScript semantics, for the
// patterns that need lookaround: Go's RE2 refuses `(?<!…)` and `(?!…)`, and
// rewriting each by hand is where a port changes what a check accepts.
// Offsets are bytes into the input, as everywhere else in Go.
package jsre

import (
	"strings"
	"unicode/utf8"

	"github.com/dlclark/regexp2"
)

// RE is a compiled ECMAScript pattern.
type RE struct{ re *regexp2.Regexp }

// MustCompile compiles pattern with JS flags: any of "i", "m", "s".
func MustCompile(pattern, flags string) *RE {
	opts := regexp2.RegexOptions(regexp2.ECMAScript)
	multiline, dotAll := false, false
	for _, f := range flags {
		switch f {
		case 'i':
			opts |= regexp2.IgnoreCase
		case 'm':
			multiline = true
		case 's':
			dotAll = true
			opts |= regexp2.Singleline
		}
	}
	return &RE{regexp2.MustCompile(lineEnds(pattern, multiline, dotAll), opts)}
}

// terminators end a line in JS, for `^` and `$` under m and for `.`. regexp2
// ends one only at \n: a file whose lines end in \r alone would be one line.
const terminators = `\n\r\u2028\u2029`

// lineEnds spells out, outside a character class, what JS means by `^` and
// `$` under m and by `.` without s.
func lineEnds(pattern string, multiline, dotAll bool) string {
	var b strings.Builder
	class := false
	for i := 0; i < len(pattern); i++ {
		c := pattern[i]
		switch {
		case c == '\\' && i+1 < len(pattern):
			b.WriteString(pattern[i : i+2])
			i++
			continue
		case class:
			class = c != ']'
		case c == '[':
			class = true
		case c == '^' && multiline:
			b.WriteString(`(?<![^` + terminators + `])`)
			continue
		case c == '$' && multiline:
			b.WriteString(`(?![^` + terminators + `])`)
			continue
		case c == '.' && !dotAll:
			b.WriteString(`[^` + terminators + `]`)
			continue
		}
		b.WriteByte(c)
	}
	return b.String()
}

// Match is one match: its byte span and its groups.
type Match struct {
	Index, End int
	groups     []string
	has        []bool
}

// Text is the whole match.
func (m *Match) Text() string { return m.groups[0] }

// Group is group i's text, `""` when it did not take part.
func (m *Match) Group(i int) string {
	if m == nil || i >= len(m.groups) {
		return ""
	}
	return m.groups[i]
}

// Has says whether group i took part in the match.
func (m *Match) Has(i int) bool { return m != nil && i < len(m.has) && m.has[i] }

// Test reports whether s holds a match.
func (r *RE) Test(s string) bool {
	ok, err := r.re.MatchString(s)
	return err == nil && ok
}

// offsets maps a rune index of s to its byte index; regexp2 counts runes.
func offsets(s string) []int {
	out := make([]int, 0, len(s)+1)
	for i := 0; i < len(s); {
		out = append(out, i)
		_, w := utf8.DecodeRuneInString(s[i:])
		i += w
	}
	return append(out, len(s))
}

func convert(m *regexp2.Match, offs []int) *Match {
	gs := m.Groups()
	out := &Match{Index: offs[m.Index], End: offs[m.Index+m.Length], groups: make([]string, len(gs)), has: make([]bool, len(gs))}
	for i, g := range gs {
		if len(g.Captures) > 0 {
			out.groups[i] = g.String()
			out.has[i] = true
		}
	}
	return out
}

// Exec is the first match in s, or nil.
func (r *RE) Exec(s string) *Match {
	m, err := r.re.FindStringMatch(s)
	if err != nil || m == nil {
		return nil
	}
	return convert(m, offsets(s))
}

// ExecAll is every match in s, left to right, as a /g regex finds them.
func (r *RE) ExecAll(s string) []*Match {
	m, err := r.re.FindStringMatch(s)
	if err != nil || m == nil {
		return nil
	}
	offs := offsets(s)
	var all []*Match
	for m != nil {
		all = append(all, convert(m, offs))
		if m, err = r.re.FindNextMatch(m); err != nil {
			break
		}
	}
	return all
}

// Search is the byte index of the first match, or -1.
func (r *RE) Search(s string) int {
	if m := r.Exec(s); m != nil {
		return m.Index
	}
	return -1
}

// ReplaceAll replaces every match with what f returns for it.
func (r *RE) ReplaceAll(s string, f func(*Match) string) string {
	all := r.ExecAll(s)
	if len(all) == 0 {
		return s
	}
	out := make([]byte, 0, len(s))
	at := 0
	for _, m := range all {
		out = append(out, s[at:m.Index]...)
		out = append(out, f(m)...)
		at = m.End
	}
	return string(append(out, s[at:]...))
}

// Split cuts s at every match, as String.prototype.split does with a regex
// that has no capturing group.
func (r *RE) Split(s string) []string {
	all := r.ExecAll(s)
	parts := make([]string, 0, len(all)+1)
	at := 0
	for _, m := range all {
		if m.End == m.Index && (m.Index == 0 || m.Index == len(s)) {
			continue
		}
		parts = append(parts, s[at:m.Index])
		at = m.End
	}
	return append(parts, s[at:])
}
