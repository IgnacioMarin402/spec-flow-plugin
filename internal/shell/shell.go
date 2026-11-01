// Package shell reads a Bash command the way the phase-write readers and
// orchestrator-scope need it: which parts a shell treats as text, and where a
// write lands after a `cd`. One scanner for every reader (B69): two readings
// of one command's quoting would disagree about what it writes.
package shell

import (
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/IgnacioMarin402/spec-flow-plugin/internal/jsre"
)

// PhaseFile names the phase file in a path or a command, anchored past the
// name: `phase.session` and `phase-guard-unmatched.log` are not the phase.
var PhaseFile = jsre.MustCompile(`\.claude[\\/]state[\\/]phase(?![\w.-])`, "")

const (
	redirectOp = `>>?\|?`
	writeOp    = redirectOp + `|\btee(?:\s+-a)?`
	part       = `"[^"]*"|'[^']*'|[^'"\s|;&]`
	intoPhase  = `\s*(?:` + part + `)*?(?:"[^"]*?|'[^']*?|[^'"\s|;&]*?)\.claude[\\/]state[\\/]phase(?![\w.-])`
)

// PhaseRedirect and PhaseWrite find a redirect (or a `tee`) into the phase
// file, its path quoted or not, whole or in parts. Test them on the `Text` of
// PhaseWriteText.
var (
	PhaseRedirect = jsre.MustCompile(`(?:`+redirectOp+`)`+intoPhase, "")
	PhaseWrite    = jsre.MustCompile(`(?:`+writeOp+`)`+intoPhase, "")
)

// Programs that run text they are handed as code, where a `>` writes a file.
var runsText = jsre.MustCompile("(?:^|[\\s;&|(`])(?:[^\\s;&|()`]*\\/)?(?:a?sh|bash|zsh|dash|ksh|mksh|fish|t?csh|busybox|eval|su|watch|script|parallel|[gmn]?awk|perl)(?=$|[\\s;&|)`])", "")

// What each byte of a command is to a shell.
const (
	Code    byte = iota
	Quoting      // a quote mark, or the backslash of an escape
	Text         // a quoted or escaped character
	Target       // quoted text naming the file a redirect or `tee` writes
	Data         // not a word of the command: a comment, a heredoc and its body
)

// Mask stands for a byte a shell reads as text, one for one, so an index into
// the masked command is an index into the command.
const Mask = '\x01'

func isSpace(c byte) bool {
	return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v'
}

// Masked is cmd with TEXT and DATA bytes replaced by Mask.
func Masked(cmd string, kinds []byte) string {
	b := []byte(cmd)
	for k := range b {
		if kinds[k] == Text || kinds[k] == Data {
			b[k] = Mask
		}
	}
	return string(b)
}

var heredocOp = regexp.MustCompile(`^<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|(\\?)([^\s;&|<>()'"]+))`)
var backticksOrSubst = regexp.MustCompile("\\$\\(|`")

type pendingDoc struct {
	word         string
	quoted, tabs bool
}

// Kinds is what each byte of cmd is to a shell, or nil when the command runs
// text as code and none of it is text. What runs inside quotes stays code —
// `$(…)`, backquotes, an unquoted heredoc line holding one — and quoting this
// cannot close is left as code: read as code, a command names more writes,
// never fewer.
func Kinds(cmd string) []byte {
	n := len(cmd)
	kinds := make([]byte, n)
	mark := func(from, to int, kind byte) {
		if to > n {
			to = n
		}
		for k := from; k < to; k++ {
			kinds[k] = kind
		}
	}
	at := func(k int) byte {
		if k < 0 || k >= n {
			return 0
		}
		return cmd[k]
	}
	plain := func(k int) bool { return kinds[k] != Text && kinds[k] != Data }
	inWord := func(k int) bool { return !plain(k) || !(isSpace(cmd[k]) || strings.IndexByte("|;&<>", cmd[k]) >= 0) }
	before := func(k int) int {
		for k >= 0 && plain(k) && isSpace(cmd[k]) {
			k--
		}
		return k
	}
	wordAt := func(k int) string {
		from := k
		for from > 0 && inWord(from-1) {
			from--
		}
		return cmd[from : k+1]
	}
	// Whether the word a quote at `pos` belongs to follows a write operator.
	target := func(pos int) bool {
		k := pos - 1
		for k >= 0 && inWord(k) {
			k--
		}
		k = before(k)
		if k < 0 || !plain(k) {
			return false
		}
		if cmd[k] == '>' || (cmd[k] == '|' && at(k-1) == '>') {
			return true
		}
		word := wordAt(k)
		if word == "-a" {
			k = before(k - 2)
			word = ""
			if k >= 0 {
				word = wordAt(k)
			}
		}
		if !strings.HasSuffix(word, "tee") {
			return false
		}
		if len(word) == 3 {
			return true
		}
		c := word[len(word)-4]
		return !(c == '_' || c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z')
	}

	var pending []pendingDoc
	i := 0
	var code func(close byte)
	var single func(ansi bool)
	var double func()

	// `$((…))` and `((…))`, where `<<` shifts: code, through its `))`.
	arithmetic := func() {
		if cmd[i] == '$' {
			i += 3
		} else {
			i += 2
		}
		for depth := 0; i < n; i++ {
			if cmd[i] == '(' {
				depth++
			} else if cmd[i] == ')' {
				was := depth
				depth--
				if was == 0 && at(i+1) == ')' {
					i += 2
					return
				}
			}
		}
	}
	heredoc := func() {
		m := heredocOp.FindStringSubmatchIndex(cmd[i:])
		if m == nil {
			i += 2
			return
		}
		group := func(g int) (string, bool) {
			if m[2*g] < 0 {
				return "", false
			}
			return cmd[i+m[2*g] : i+m[2*g+1]], true
		}
		d := pendingDoc{tabs: m[3] > m[2]}
		w2, ok2 := group(2)
		w3, ok3 := group(3)
		w5, ok5 := group(5)
		esc, _ := group(4)
		switch {
		case ok2:
			d.word = w2
		case ok3:
			d.word = w3
		default:
			d.word = w5
		}
		d.quoted = !ok5 || esc == `\`
		pending = append(pending, d)
		mark(i, i+m[1], Data)
		i += m[1]
	}
	// Each pending body, through the line that ends it. An unquoted heredoc
	// expands, so a line of one holding `$(` or a backquote is left as code.
	bodies := func() {
		docs := pending
		pending = nil
		for _, d := range docs {
			for i < n {
				end := strings.IndexByte(cmd[i:], '\n')
				if end == -1 {
					end = n
				} else {
					end += i
				}
				line := cmd[i:end]
				cmp := line
				if d.tabs {
					cmp = strings.TrimLeft(line, "\t")
				}
				last := cmp == d.word
				if d.quoted || last || !backticksOrSubst.MatchString(line) {
					mark(i, end, Data)
				}
				i = end + 1
				if last {
					break
				}
			}
		}
	}
	escape := func(kind byte) {
		mark(i, i+1, Quoting)
		w := 1
		if i+1 < n {
			_, w = utf8.DecodeRuneInString(cmd[i+1:])
		}
		mark(i+1, i+1+w, kind)
		i += 1 + w
	}
	// Up to `close` (`)` of a `$(`, a backquote) or the end, past it.
	code = func(close byte) {
		depth := 0
		for i < n {
			c := cmd[i]
			if close != 0 && c == close && (close != ')' || depth == 0) {
				i++
				return
			}
			if close == ')' && (c == '(' || c == ')') {
				if c == '(' {
					depth++
				} else {
					depth--
				}
			}
			switch {
			case c == '\\':
				escape(Text)
			case c == '\'' || (c == '$' && at(i+1) == '\''):
				single(c == '$')
			case c == '"':
				double()
			case strings.HasPrefix(cmd[i:], "$((") || strings.HasPrefix(cmd[i:], "(("):
				arithmetic()
			case c == '$' && at(i+1) == '(':
				i += 2
				code(')')
			case c == '`':
				i++
				code('`')
			case c == '#' && (i == 0 || isSpace(cmd[i-1]) || strings.IndexByte(";&|(", cmd[i-1]) >= 0):
				end := strings.IndexByte(cmd[i:], '\n')
				if end == -1 {
					end = n
				} else {
					end += i
				}
				mark(i, end, Data)
				i = end
			case strings.HasPrefix(cmd[i:], "<<<"):
				i += 3
			case strings.HasPrefix(cmd[i:], "<<"):
				heredoc()
			case c == '\n' && len(pending) > 0:
				i++
				bodies()
			default:
				i++
			}
		}
	}
	// `'…'`, and `$'…'`, where a backslash escapes the quote.
	single = func(ansi bool) {
		from := i
		open := from + 1
		if ansi {
			open++
		}
		end := open
		for end < n && cmd[end] != '\'' {
			if ansi && cmd[end] == '\\' {
				end += 2
			} else {
				end++
			}
		}
		if end >= n {
			i = n
			return
		}
		mark(from, open, Quoting)
		if target(from) {
			mark(open, end, Target)
		} else {
			mark(open, end, Text)
		}
		mark(end, end+1, Quoting)
		i = end + 1
	}
	double = func() {
		from := i
		kind := Text
		if target(from) {
			kind = Target
		}
		mark(i, i+1, Quoting)
		i++
		for i < n && cmd[i] != '"' {
			switch {
			case cmd[i] == '\\':
				escape(kind)
			case strings.HasPrefix(cmd[i:], "$(("):
				arithmetic()
			case strings.HasPrefix(cmd[i:], "$("):
				i += 2
				code(')')
			case cmd[i] == '`':
				i++
				code('`')
			default:
				mark(i, i+1, kind)
				i++
			}
		}
		if i >= n {
			mark(from, n, Code)
			return
		}
		mark(i, i+1, Quoting)
		i++
	}

	code(0)
	if runsText.Test(Masked(cmd, kinds)) {
		return nil
	}
	return kinds
}

// QuotedAsText is cmd with what a shell reads as text masked, byte for byte.
// A redirect or `tee` target stays: it is the path written.
func QuotedAsText(cmd string) string {
	if kinds := Kinds(cmd); kinds != nil {
		return Masked(cmd, kinds)
	}
	return cmd
}

var (
	separators   = regexp.MustCompile(`;|&&|\n`)
	cdWord       = regexp.MustCompile(`^\s*\(?\s*cd\s+((?:"[^"]*"|'[^']*'|[^'"\s;&|)])+)`)
	quotes       = regexp.MustCompile(`["']`)
	trailingSep  = regexp.MustCompile(`(.)[\\/]+$`)
	absolute     = regexp.MustCompile(`^([\\/~]|[A-Za-z]:)`)
	writeTarget  = regexp.MustCompile(`(` + writeOp + `)(\s*)(['"]?)([^'"\s;&|<>]+)`)
	hasSpace     = regexp.MustCompile(`\s`)
	dotSlashHead = regexp.MustCompile(`^\./`)
)

// ResolveCd writes each relative redirect or `tee` target after a `cd` under
// that directory, so `cd .claude/state && printf done > phase` names the phase
// file. Linear: a `cd` in a subshell is taken as lasting, which can only name
// more paths, never fewer. Cut where QuotedAsText leaves a separator.
func ResolveCd(cmd string) string {
	text := QuotedAsText(cmd)
	var pieces []string
	last := 0
	for _, m := range separators.FindAllStringIndex(text, -1) {
		pieces = append(pieces, cmd[last:m[0]], cmd[m[0]:m[1]])
		last = m[1]
	}
	pieces = append(pieces, cmd[last:])

	dir := ""
	var out strings.Builder
	for _, piece := range pieces {
		if m := cdWord.FindStringSubmatch(piece); m != nil {
			to := trailingSep.ReplaceAllString(quotes.ReplaceAllString(m[1], ""), "$1")
			if absolute.MatchString(to) || dir == "" {
				dir = to
			} else {
				dir = dir + "/" + to
			}
			out.WriteString(piece)
			continue
		}
		if dir == "" {
			out.WriteString(piece)
			continue
		}
		open := ""
		if hasSpace.MatchString(dir) {
			open = `"`
		}
		out.WriteString(writeTarget.ReplaceAllStringFunc(piece, func(s string) string {
			g := writeTarget.FindStringSubmatch(s)
			op, space, quote, tgt := g[1], g[2], g[3], dotSlashHead.ReplaceAllString(g[4], "")
			if quote != "" {
				return op + space + quote + dir + "/" + tgt
			}
			return op + space + open + dir + "/" + tgt + open
		}))
	}
	return out.String()
}

// Command is a Bash command as the phase-write readers take it: Cmd with its
// `cd`s resolved, and Text, the same length, with what a shell reads as text
// masked. Match on Text; read values from Cmd at the same place.
type Command struct{ Cmd, Text string }

// PhaseWriteText is command as the phase-write readers take it.
func PhaseWriteText(command string) Command {
	cmd := ResolveCd(command)
	return Command{cmd, QuotedAsText(cmd)}
}
