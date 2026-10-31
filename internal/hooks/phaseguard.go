package hooks

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/IgnacioMarin402/spec-flow-plugin/internal/canrun"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/contract"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/gitscope"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/hookio"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/humanturn"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/jsre"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/proc"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/shell"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/spectime"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/unscoped"
)

// Phases is the whole vocabulary, the one executable copy of it.
var Phases = append(append([]string{}, hookio.RunPhases...), "done", "idle")

var (
	// What a tool may write to START a run; `blocked` is the gate's alone.
	startsARun = []string{"spec", "plan", "review", "implement"}
	// What a run moves to once its spec is signed off or triaged.
	leavesSpec = []string{"plan", "review", "implement"}
)

func liveChanges(root string) []string {
	var out []string
	for _, e := range hookio.Subdirs(filepath.Join(root, "specflow")) {
		if e != "archive" {
			out = append(out, e)
		}
	}
	return out
}

// GatePassedHead is whether a gate passed the current commit, nil when git
// cannot say: the same short sha and `result=pass` the gate decides by.
func GatePassedHead(root string) *bool {
	res := proc.Git(root, "rev-parse", "--short", "HEAD")
	if !res.OK() {
		return nil
	}
	sha := strings.TrimSpace(res.Stdout)
	hist := hookio.ReadFileOrDefault(filepath.Join(hookio.StateDir(root), "gate-history.log"), "")
	passed := false
	for _, l := range strings.Split(hist, "\n") {
		if f := strings.Split(l, " "); len(f) > 1 && f[1] == sha && strings.Contains(l, " result=pass ") {
			passed = true
		}
	}
	return &passed
}

var (
	producerStart = jsre.MustCompile("[^;&|\\n(`]*$", "")
	producerRe    = regexp.MustCompile(`(?:^|\s)(printf|echo)\s+`)
	escapeRe      = regexp.MustCompile(`\\(0[0-7]{0,3}|.)`)
	shellEscaped  = regexp.MustCompile(`\\(.)`)
	dqEscaped     = regexp.MustCompile("\\\\([\\\\$`\"\n])")
)

// shellWord is a token as the shell hands it to the program: quotes removed,
// and a backslash outside single quotes taking the next character literally.
func shellWord(tok string) string {
	switch {
	case len(tok) >= 2 && tok[0] == '\'' && tok[len(tok)-1] == '\'':
		return tok[1 : len(tok)-1]
	case len(tok) >= 2 && tok[0] == '"' && tok[len(tok)-1] == '"':
		return dqEscaped.ReplaceAllString(tok[1:len(tok)-1], "$1")
	}
	return strings.Trim(shellEscaped.ReplaceAllString(tok, "$1"), `'"`)
}

// interpret applies printf's (and `echo -e`'s) backslash escapes.
func interpret(s string) string {
	return escapeRe.ReplaceAllStringFunc(s, func(e string) string {
		switch e[1] {
		case 'n':
			return "\n"
		case 't':
			return "\t"
		case 'r':
			return "\r"
		case 'v':
			return "\v"
		case 'f':
			return "\f"
		case 'a', 'b', 'e', '0':
			return ""
		case '\\':
			return `\`
		}
		return e
	})
}

// bashWrittenValue is the value a Bash command writes into the phase file, as
// readPhase will read it back — the shell's quoting removed, printf's escapes
// applied, trimmed — or `""` when the command cannot be read as a write of one
// value. It needs a redirect into the file, a printf or echo producing it, and
// one argument: anything looser starts guessing, and this hook denies.
func bashWrittenValue(c shell.Command) string {
	redirect := shell.PhaseRedirect.Exec(c.Text)
	if redirect == nil {
		return ""
	}
	// The producer is the command the redirect belongs to, from the separator
	// before it: another command's `echo` in the chain is not what is written.
	start := producerStart.Search(c.Text[:redirect.Index])
	if start < 0 {
		start = 0
	}
	m := producerRe.FindStringSubmatchIndex(c.Text[start:redirect.Index])
	if m == nil {
		return ""
	}
	program := c.Text[start+m[2] : start+m[3]]
	var args []string
	escapes := false
	for _, a := range strings.Fields(c.Cmd[start+m[1] : redirect.Index]) {
		if strings.HasPrefix(a, "-") { // `echo -n`, `printf --`
			if program == "echo" && strings.Contains(a, "e") && !strings.Contains(a, "E") {
				escapes = true
			}
			continue
		}
		if w := shellWord(a); w != "" {
			args = append(args, w)
		}
	}
	// `printf '%s' implement`: a format string is not the value. With no
	// format, the value IS the format, and printf reads its escapes.
	var values []string
	format := ""
	for _, a := range args {
		if strings.Contains(a, "%") {
			if format == "" {
				format = a
			}
		} else {
			values = append(values, a)
		}
	}
	if len(values) != 1 {
		return ""
	}
	v := values[0]
	if (program == "printf" && (format == "" || strings.Contains(format, "%b"))) || escapes {
		v = interpret(v)
	}
	return hookio.Trim(v)
}

var (
	chainSep    = jsre.MustCompile(`&&|\|\||;|\n`, "")
	pipeSep     = jsre.MustCompile(`(?<!>)\|`, "")
	leadingPath = regexp.MustCompile(`^.*[\\/]`)
)

type span struct{ from, to int }

// pieces is [from, to) of each piece of text between matches of sep.
func pieces(text string, sep *jsre.RE, from, to int) []span {
	var found []span
	at := from
	for _, m := range sep.ExecAll(text[from:to]) {
		found = append(found, span{at, from + m.Index})
		at = from + m.End
	}
	return append(found, span{at, to})
}

// recordUnreadableWrite notes, one line per program, a write that got past
// unread: failing open is right here, failing open silently is not. Only
// with a redirect or a pipe INTO the file — a read got past nothing — and the
// program only, never its arguments.
func recordUnreadableWrite(root string, c shell.Command) {
	redirects := shell.PhaseRedirect.Test(c.Text)
	var part *span
	for _, s := range pieces(c.Text, chainSep, 0, len(c.Text)) {
		if shell.PhaseFile.Test(c.Text[s.from:s.to]) {
			s := s
			part = &s
			break
		}
	}
	if part == nil {
		return
	}
	segments := pieces(c.Text, pipeSep, part.from, part.to)
	at := -1
	for i, s := range segments {
		if shell.PhaseFile.Test(c.Text[s.from:s.to]) {
			at = i
			break
		}
	}
	// `cat <phase> | grep x` is a read that contains a pipe.
	if !redirects && at < 1 {
		return
	}
	f := strings.Fields(c.Cmd[segments[at].from:segments[at].to])
	if len(f) == 0 {
		return
	}
	program := leadingPath.ReplaceAllString(f[0], "")
	if program == "" {
		return
	}
	hookio.AppendUnique(filepath.Join(hookio.StateDir(root), "phase-guard-unmatched.log"), program)
}

// PhaseGuard — PreToolUse on Bash|Write|Edit — guards every write to
// `.claude/state/phase`, the spine: each hook arms by matching it against a
// CLOSED set, so a value nobody defined disarms them all at once, silently.
//
//  1. A value outside the vocabulary is denied.
//  2. `blocked` is the gate's own hand-off to a human; a tool writing it is denied.
//  3. A write that ENDS a run is decided from evidence on disk (ADR-022).
//  4. A write that STARTS a run is refused where the engine cannot run
//     (ADR-028, ADR-032, ADR-049): nothing is armed then.
//  5. Leaving `spec` needs a spec its first gate would accept and that states
//     its assumptions (ADR-030), and a case 3 a human has answered (ADR-036).
//
// Recognising the value is deliberately narrow, because this hook DENIES: a
// command that merely mentions the file is allowed. A consistency guard, not
// a security boundary.
func PhaseGuard(c *hookio.Ctx) {
	root := hookio.ProjectDir()
	p := c.Payload()
	// ReadPhase, never the owner check: this is the hook that ASSIGNS
	// ownership (ADR-017).
	phase := hookio.ReadPhase(root)
	inRun := hookio.IsRunPhase(phase)
	input := hookio.Obj(p["tool_input"])
	session := hookio.JSString(p["session_id"])

	written := ""
	if hookio.JSString(p["tool_name"]) == "Bash" {
		command := shell.PhaseWriteText(hookio.JSString(input["command"]))
		written = bashWrittenValue(command)
		// A command writing the phase creates that directory itself, so
		// recording here leaves nothing it did not.
		if written == "" && shell.PhaseFile.Test(command.Cmd) {
			recordUnreadableWrite(root, command)
		}
	} else if shell.PhaseFile.Test(hookio.JSString(hookio.Nullish(input["file_path"], input["filePath"]))) {
		written = hookio.Trim(hookio.JSString(hookio.Nullish(input["content"], input["new_string"])))
	}
	if written == "" {
		return
	}

	// The gate's alone, in a run and out of one.
	if written == "blocked" {
		c.Deny("'blocked' is written by the gate itself, at its attempt cap — it is how the gate hands a run to a human. " +
			"Written by anything else it disarms the gate without that having happened. If you need a human, say so " +
			"and end your turn; the gate still judges what is committed.")
	}

	// ---- a write that STARTS a run is decided from where it starts ---------
	if !inRun {
		if !contains(startsARun, written) {
			return // arms nothing
		}
		if _, err := canrun.CheckStart(root); err != nil {
			tail := " — `spec-flow init`, run from the repository root, writes the contract."
			if k := gitscope.Kind(err); k == "foreign-change" || k == "settings" {
				tail = "."
			}
			c.Deny(fmt.Sprintf("starting a run by writing '%s' into .claude/state/phase, and this engine cannot run in this repository: %v\n\n", written, err) +
				"Nothing has started and nothing is armed. Fix that first, then start the run again" + tail)
		}
		hookio.ClaimPhase(root, session)
		return
	}

	if !contains(Phases, written) {
		c.Fail(fmt.Sprintf("[spec-flow] Denied: '%s' is not a phase this engine knows.\n\n", written) +
			fmt.Sprintf("The phase vocabulary is a CLOSED SET: %s. Every enforcement hook ", strings.Join(Phases, ", ")) +
			"decides whether it is armed by matching this file against those values, and each one " +
			fmt.Sprintf("falls through to \"not my business\" on anything else — so writing '%s' would run ", written) +
			"the flow with the gate, the write-time linter, the whole-repo command deny, preflight " +
			"and the Opus budget ALL disarmed at once, with nothing to say so.\n\n" +
			"Whatever step you are modelling, express it inside the vocabulary: spec work runs under " +
			"`spec`, anything that writes code runs under `implement`. If you are extending the " +
			"orchestrator, that constraint is the design, not an obstacle to route around.\n")
	}

	// ---- leaving `spec` needs a spec its first gate would accept -----------
	if phase == "spec" && contains(leavesSpec, written) {
		if found := spectime.LeavingSpec(root); len(found) > 0 {
			c.Deny(fmt.Sprintf("writing '%s' while the spec is not ready to build from:\n  - %s\n\n", written, strings.Join(found, "\n  - ")) +
				"Hand these to a new spec-writer with specflow/<SLUG>/ (MODE=TRIAGE for a /spec-fix brief). For a /spec-flow " +
				fmt.Sprintf("change, show the human the sign-off again before writing '%s': what they approved is not what is on disk.", written))
		}
		if unconfirmed := humanturn.Unconfirmed(root); len(unconfirmed) > 0 {
			c.Deny(humanturn.Denial(unconfirmed, fmt.Sprintf("writing '%s'", written)))
		}
	}

	// ---- a write that ends the run is decided from evidence ---------------
	// From `blocked` a human is already in the loop: not second-guessed.
	if written == "idle" && phase != "blocked" {
		if phase == "implement" {
			c.Deny("writing 'idle' while the phase is 'implement'. No step of /spec-flow or /spec-fix ends a run from here: " +
				"'idle' disarms the gate with nothing judged, and the next stop passes in silence. If the gate failed, " +
				"follow its message — it routes the fix and the re-plan, and at its cap writes 'blocked' itself. If a " +
				"human asked to abandon the run, standing it down is theirs to do, from their own terminal.")
		}
		if live := liveChanges(root); len(live) > 0 {
			c.Deny(fmt.Sprintf("writing 'idle' with a change still live in specflow/: %s. Both flows record a dropped ", strings.Join(live, ", ")) +
				"change before standing down: stamp `**Status:** REJECTED <YYYY-MM-DD> — <reason>` under the heading " +
				"of its spec.md, move the folder to specflow/archive/, then write 'idle'.")
		}
	}

	// Claimed only for a write that goes through: a denied one changes nothing.
	if written != "done" {
		hookio.ClaimPhase(root, session)
		return
	}

	// ---- is `done` earned? ---------------------------------------------------
	var failures []string
	// Degrades quietly on a bad contract: refusing an unearned `done` is this
	// check's job, policing the contract is the gate's.
	var atBase []string
	if cfg, err := contract.Load(root); err == nil {
		for _, ch := range unscoped.Run(root, cfg).Checks {
			if ch.RC != 0 {
				failures = append(failures, fmt.Sprintf("--- %s ---\n%s", ch.Name, ch.Out))
			}
		}
		if base, err := gitscope.ResolveBase(root, cfg); err == nil {
			atBase = gitscope.ChangesAtBase(root, base)
		}
	}
	// A change never folded is an unfinished run; one the base has is not
	// this run's to fold (ADR-032).
	if live := liveChanges(root); len(live) > 0 {
		marked := make([]string, len(live))
		for i, slug := range live {
			marked[i] = slug
			if contains(atBase, slug) {
				marked[i] = slug + " (the base branch has it: not this run's change)"
			}
		}
		failures = append(failures, "--- unarchived changes in specflow/ ---\n"+strings.Join(marked, "\n"))
	}
	// Only the gate ran the suite, and spec-trace counts a failed test as executed.
	switch passed := GatePassedHead(root); {
	case passed == nil:
		failures = append(failures, "--- the current commit ---\ngit could not name HEAD, so nothing can say a gate passed it.")
	case !*passed:
		failures = append(failures, "--- the current commit ---\nthe gate has not passed it: no line in .claude/state/gate-history.log records result=pass for HEAD.")
	}
	if len(failures) == 0 {
		hookio.ClaimPhase(root, session)
		return
	}
	c.Deny("writing 'done' into .claude/state/phase, and the run is not actually finished. 'done' disarms every " +
		"hook, so it has to be earned, not declared:\n" + strings.Join(failures, "\n") + "\n\n" +
		"Route by what failed: a spec-trace gap belongs to the spec-writer session (FOLD); an unarchived " +
		"specflow/<SLUG>/ of this run means step 5 never ran — invoke spec-writer in MODE=FOLD; one the base branch " +
		"has is not this run's: tell the human, whose call it is to move or archive it, and do neither yourself; a commit the gate has not " +
		"passed needs committing and a turn ended so the gate judges it; any other check the project declared goes " +
		"back to the implementer of the milestone that broke it, with the hint that check carries in " +
		".spec-flow/config.json.")
}
