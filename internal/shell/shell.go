// Package shell reads a Bash command the way every hook that reads one needs
// it: which parts a shell treats as text, and where a write lands after a
// `cd`. One scanner for every reader (B69): two readings of one command's
// quoting would disagree about what it runs or writes.
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
	at           int // its index in the heredocs scan returns
}

// heredoc is a `<<` operator at op and its body, cmd[from:to], the line that
// ends it left out.
type heredoc struct{ op, from, to int }

// Kinds is what each byte of cmd is to a shell, or nil when the command runs
// text as code and none of it is text. What runs inside quotes stays code —
// `$(…)`, backquotes, an unquoted heredoc line holding one — and quoting this
// cannot close is left as code: read as code, a command names more writes,
// never fewer.
func Kinds(cmd string) []byte {
	kinds, _ := scan(cmd)
	if runsText.Test(Masked(cmd, kinds)) {
		return nil
	}
	return kinds
}

// scan is what each byte of cmd is to a shell, read as if no program ran its
// text as code, and its heredocs.
func scan(cmd string) ([]byte, []heredoc) {
	n := len(cmd)
	kinds := make([]byte, n)
	var docs []heredoc
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
		d.at = len(docs)
		docs = append(docs, heredoc{op: i, from: n, to: n})
		pending = append(pending, d)
		mark(i, i+m[1], Data)
		i += m[1]
	}
	// Each pending body, through the line that ends it. An unquoted heredoc
	// expands, so a line of one holding `$(` or a backquote is left as code.
	bodies := func() {
		waiting := pending
		pending = nil
		for _, d := range waiting {
			docs[d.at].from = min(i, n)
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
				if last {
					docs[d.at].to = i
				}
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
	return kinds, docs
}

// MaskRune keeps a quoted or escaped character inside its word: whitespace and
// `> | & ; <` move into the private-use range, which Unmask undoes.
func MaskRune(r rune) rune {
	if strings.ContainsRune(" \t\n\r\f\v<>|&;", r) {
		return 0xE000 + r
	}
	return r
}

// Unmask is s with what MaskRune moved put back.
func Unmask(s string) string {
	return strings.Map(func(r rune) rune {
		if r >= 0xE000 && r <= 0xE07F {
			return r - 0xE000
		}
		return r
	}, s)
}

// A list ends where the next one starts: a pipeline stays one, so the text
// `echo "…" | sh` hands its shell is in the list that runs it.
var listSep = regexp.MustCompile(`;|&&|\|\||\n`)

var (
	// Shells run their `-c` value, or with no script named, their stdin.
	shells = wordSet("sh bash zsh dash ksh mksh ash fish csh tcsh")
	// These run only a `-c` value as a shell command.
	dashC = wordSet("su script")
	// Words before the program that leave it the program.
	wrappers   = wordSet("sudo env exec command nohup time timeout nice ionice stdbuf xargs busybox")
	assignWord = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*=`)
)

func wordSet(s string) map[string]bool {
	m := map[string]bool{}
	for _, w := range strings.Fields(s) {
		m[w] = true
	}
	return m
}

func baseName(s string) string {
	return s[strings.LastIndexAny(s, `/\`)+1:]
}

func allDigits(s string) bool {
	return s != "" && strings.Trim(s, "0123456789") == ""
}

// word is one word of a command, cmd[from:to], and text, what the program
// receives.
type word struct {
	from, to int
	text     string
	target   bool // a redirect's file, not an argument
	here     bool // `<<<`'s word: stdin
}

// command is one command of a pipeline; piped when the one before feeds its
// stdin.
type command struct {
	words []word
	docs  []heredoc
	piped bool
}

// commands splits cmd[a:b], one list, into its commands and their words.
func commands(cmd string, kinds []byte, docs []heredoc, a, b int) []command {
	cmds := []command{{}}
	var text []byte
	from := -1
	redirect, here := false, false
	flush := func(k int) {
		if from < 0 {
			return
		}
		c := &cmds[len(cmds)-1]
		c.words = append(c.words, word{from, k, string(text), redirect && !here, here})
		from, text, redirect, here = -1, nil, false, false
	}
	for k := a; k < b; {
		c := cmd[k]
		switch {
		case kinds[k] == Data:
			flush(k)
			for _, d := range docs {
				if d.op == k {
					cmds[len(cmds)-1].docs = append(cmds[len(cmds)-1].docs, d)
				}
			}
			k++
		case kinds[k] == Code && isSpace(c):
			flush(k)
			k++
		case kinds[k] == Code && c == '|':
			flush(k)
			redirect, here = false, false
			cmds = append(cmds, command{piped: true})
			k++
		case kinds[k] == Code && (c == '<' || c == '>'):
			if allDigits(string(text)) && from >= 0 && kinds[k-1] == Code {
				from, text = -1, nil // `2>`: the descriptor is the operator's
			}
			flush(k)
			if strings.HasPrefix(cmd[k:], "<<<") {
				here = true
				k += 3
				continue
			}
			redirect = true
			k++
		case kinds[k] == Code && c == '&':
			flush(k)
			if k+1 < b && cmd[k+1] == '>' || k > a && (cmd[k-1] == '>' || cmd[k-1] == '<') {
				k++ // `&>`, `>&`: part of a redirect
				continue
			}
			redirect, here = false, false
			cmds = append(cmds, command{})
			k++
		case kinds[k] == Quoting:
			if from < 0 {
				from = k
			}
			k++
			// A continued line: the backslash and its newline are not there.
			if cmd[k-1] == '\\' && strings.HasPrefix(cmd[k:], "\n") {
				k++
			} else if cmd[k-1] == '\\' && strings.HasPrefix(cmd[k:], "\r\n") {
				k += 2
			}
		default:
			if from < 0 {
				from = k
			}
			text = append(text, c)
			k++
		}
	}
	flush(b)
	return cmds
}

// shellCode is what the commands of one pipeline hand a shell to run: words,
// by where they start, and heredoc bodies. Only that — an argument to a
// script, or text perl or awk reads, runs no shell command.
func shellCode(cmds []command) (map[int]word, []heredoc) {
	code := map[int]word{}
	var bodies []heredoc
	for ci, c := range cmds {
		var args []word
		for _, w := range c.words {
			if !w.target && !w.here {
				args = append(args, w)
			}
		}
		runner := func(k int) bool {
			p := baseName(args[k].text)
			return shells[p] || dashC[p] || p == "eval"
		}
		i, wrapped := 0, false
		for ; i < len(args); i++ {
			t := args[i].text
			if wrappers[baseName(t)] {
				wrapped = true
			} else if strings.HasPrefix(t, "-") {
				// A wrapper's flag may take a value: `sudo -u ci bash`.
				if wrapped && i+1 < len(args) && !runner(i+1) && !strings.HasPrefix(args[i+1].text, "-") {
					i++
				}
			} else if !assignWord.MatchString(t) && !allDigits(t) {
				break
			}
		}
		if i == len(args) {
			continue
		}
		prog, rest := baseName(args[i].text), args[i+1:]
		if prog == "eval" {
			for _, w := range rest {
				code[w.from] = w
			}
			continue
		}
		if !shells[prog] && !dashC[prog] {
			continue
		}
		stdin := shells[prog]
	flags:
		for j := 0; j < len(rest); j++ {
			t := rest[j].text
			switch {
			case t == "-o" || t == "+o" || t == "-O" || t == "+O":
				j++ // its value
			case len(t) > 1 && t[0] == '-' && t[1] != '-' && strings.ContainsRune(t, 'c'):
				if j+1 < len(rest) {
					code[rest[j+1].from] = rest[j+1]
				}
				stdin = false
				break flags
			case strings.HasPrefix(t, "-") || strings.HasPrefix(t, "+"):
			case shells[prog]:
				stdin = false // a script file, and its arguments
				break flags
			}
		}
		if !stdin {
			continue
		}
		for _, w := range c.words {
			if w.here {
				code[w.from] = w
			}
		}
		bodies = append(bodies, c.docs...)
		if !c.piped || ci == 0 {
			continue
		}
		var feed []word
		for _, w := range cmds[ci-1].words {
			if !w.target && !w.here {
				feed = append(feed, w)
			}
		}
		if len(feed) == 0 {
			continue
		}
		switch baseName(feed[0].text) {
		case "echo":
			for _, w := range feed[1:] {
				if !strings.HasPrefix(w.text, "-") {
					code[w.from] = w
				}
			}
		case "cat":
			bodies = append(bodies, cmds[ci-1].docs...)
		}
	}
	return code, bodies
}

// Words is cmd as the readers of its words take it: quote marks, comments,
// heredocs and line continuations gone, and each quoted or escaped word whole,
// masked by MaskRune. What a shell is handed to run — `sh -c '…'`, `eval`,
// `echo '…' | sh`, a heredoc or `<<<` a shell reads — is read as a command of
// its own between `;`s: read as text, `sh -c 'npm test'` runs no test.
func Words(cmd string) string {
	kinds, docs := scan(cmd)
	masked := Masked(cmd, kinds)
	var b strings.Builder
	last := 0
	for _, m := range append(listSep.FindAllStringIndex(masked, -1), []int{len(cmd), len(cmd)}) {
		if m[0] >= 2 && kinds[m[0]-2] == Quoting && cmd[m[0]-2:m[0]] == "\\\r" {
			continue // `\` CR LF continues the line
		}
		code, bodies := shellCode(commands(cmd, kinds, docs, last, m[0]))
		writeWords(&b, cmd, kinds, last, m[0], code)
		for _, d := range bodies {
			b.WriteString(" ; " + Words(cmd[d.from:d.to]) + " ; ")
		}
		b.WriteString(cmd[m[0]:m[1]])
		last = m[1]
	}
	return b.String()
}

func writeWords(b *strings.Builder, cmd string, kinds []byte, from, to int, code map[int]word) {
	for k := from; k < to; {
		if w, ok := code[k]; ok {
			b.WriteString(" ; " + Words(w.text) + " ; ")
			k = w.to
			continue
		}
		switch kinds[k] {
		case Code:
			b.WriteByte(cmd[k])
			k++
		case Data:
			k++
		case Quoting:
			k++
			if cmd[k-1] == '\\' && strings.HasPrefix(cmd[k:], "\n") {
				k++
			} else if cmd[k-1] == '\\' && strings.HasPrefix(cmd[k:], "\r\n") {
				k += 2
			}
		default:
			r, w := utf8.DecodeRuneInString(cmd[k:])
			b.WriteRune(MaskRune(r))
			k += w
		}
	}
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
