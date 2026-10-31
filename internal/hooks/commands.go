package hooks

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/IgnacioMarin402/spec-flow-plugin/internal/argv"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/contract"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/engine"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/gitscope"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/hookio"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/proc"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/shell"
)

var (
	quotedRe     = regexp.MustCompile(`"[^"]*"|'[^']*'`)
	pathChar     = regexp.MustCompile(`[\\/.]`)
	compoundSep  = regexp.MustCompile(`&&|\|\||;|\|`)
	assignment   = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*=`)
	shSuffix     = regexp.MustCompile(`\.sh$`)
	packageTools = regexp.MustCompile(`^(pnpm|npm|yarn|npx)$`)
)

type denied struct{ wholeRepoScripts, tools, scopedAllowed map[string]bool }

func set(list []string) map[string]bool {
	m := map[string]bool{}
	for _, v := range list {
		m[v] = true
	}
	return m
}

// Path-SHAPED, as unscoped reads argv[1]: a subcommand (`run`) or a flag's
// value (`--max-warnings 0`) is not a scope.
func namesAPath(args []string) bool {
	for _, a := range args {
		if !strings.HasPrefix(a, "-") && a != "." && a != "./" && pathChar.MatchString(a) {
			return true
		}
	}
	return false
}

// classify is "" to allow, else the name of the whole-repo run it denies.
func classify(cmd string, d denied) string {
	if cmd == "" {
		return ""
	}
	// Quoted text and heredoc bodies are data: a commit message saying
	// `; ftest covers it` runs nothing. A quoted path still scopes.
	command := quotedRe.ReplaceAllStringFunc(strings.SplitN(cmd, "<<", 2)[0], func(q string) string {
		if pathChar.MatchString(q[1 : len(q)-1]) {
			return " ./quoted "
		}
		return " "
	})
	// A compound command is denied if ANY of its parts is.
	for _, part := range compoundSep.Split(command, -1) {
		t := strings.Fields(part)
		// `NODE_ENV=test vitest run` runs vitest, as the other readers of a
		// command already take it.
		for len(t) > 0 && assignment.MatchString(t[0]) {
			t = t[1:]
		}
		if len(t) == 0 {
			continue
		}
		// The scoped escape hatch, on whole tokens: a substring would swallow
		// `--checkCoverage` on a runner whose name contains "check".
		allowed := false
		for _, tok := range t {
			if d.scopedAllowed[shSuffix.ReplaceAllString(argv.Basename(tok), "")] {
				allowed = true
			}
		}
		if allowed {
			continue
		}
		at := func(k int) string {
			if k < len(t) {
				return t[k]
			}
			return ""
		}
		i := 0
		if packageTools.MatchString(t[0]) {
			i++
			if at(i) == "run" || at(i) == "exec" {
				i++
			}
			if at(i) == "" || d.scopedAllowed[at(i)] {
				continue
			}
			if d.wholeRepoScripts[at(i)] {
				// `npm test -- <path>` hands the path to the script: scoped, as
				// the tool run on a path is.
				if namesAPath(t[i+1:]) {
					continue
				}
				return at(i)
			}
			if !d.tools[argv.Basename(at(i))] {
				continue
			}
		} else if t[0] == "node" {
			// `node node_modules/<tool>/bin/<tool>.js` is how the gate itself
			// runs a tool, so it is scoped like the bare name.
			var name string
			i, name = argv.ToolAt(t, 0)
			if at(i) == "" || !d.tools[name] {
				continue
			}
		} else if !d.tools[argv.Basename(t[0])] {
			continue
		}
		// A runtime that is also the runner runs tests only through `test`.
		if argv.Runtimes[argv.Basename(at(i))] && at(i+1) != "test" {
			continue
		}
		if !namesAPath(t[i+1:]) {
			return at(i)
		}
	}
	return ""
}

// NoGateCmds — PreToolUse on Bash — keeps WHOLE-REPO lint and test runs out of
// a run: the full output is mostly about files the milestone never touched,
// and it lands in the agent's context. The scoped forms stay allowed, and only
// during `implement`. A consistency guard, not a security boundary: `sh -c`
// or an alias evades it, and the gate re-runs the real checks on Stop.
func NoGateCmds(c *hookio.Ctx) {
	root := hookio.ProjectDir()
	// ReadPhase: a deny over a phase the repository committed is one nobody
	// in the session can explain (ADR-017).
	if hookio.ReadPhase(root) != "implement" {
		return
	}
	cmd := hookio.JSString(hookio.Obj(c.Payload()["tool_input"])["command"])
	if cmd == "" {
		return
	}
	cfg, err := contract.Load(root)
	if err != nil {
		return // a bad contract must not block every Bash call; the gate reports it
	}
	u := cfg.UnscopedDenied
	name := classify(cmd, denied{set(u.Scripts), set(u.Tools), set(u.ScopedAllowed)})
	if name == "" {
		return
	}
	var rest []string
	for _, e := range u.ScopedExamples {
		if e != u.ScopedAlternative {
			rest = append(rest, "`"+e+"`")
		}
	}
	hint := ""
	if len(rest) > 0 {
		hint = " (" + strings.Join(rest, ", ") + ")"
	}
	c.Fail(fmt.Sprintf("[spec-flow] Denied: `%s` runs over the WHOLE repo, and the flow is ", name) +
		"mid-run. Not because checking your work is wrong — because the full output is " +
		"mostly about files this milestone never touched, and it lands in your context.\n\n" +
		"Run the scoped check instead — same commands, only the files this branch changed:\n\n" +
		"    " + u.ScopedAlternative + "\n\n" +
		// The repository's declaration first, then the one that cannot be
		// wrong: THIS engine's copy, which needs nothing installed.
		"The same check with nothing installed, which is the copy the gate itself runs:\n\n" +
		"    " + engineCommand("check") + "\n\n" +
		"Scoped invocations are allowed too" + hint + ", and so is the tool run on a file path. " +
		"If you are the implementer, your test-first red run names the test file's path; " +
		"for anything else, end your turn and the gate reports back.\n\n" +
		// No disarm recipe, on purpose: an agent reads this far more often than
		// a human, and `idle` stands every guard down at once.
		"A human who needs the whole repo can stand the flow down — see Phases in the plugin's REFERENCE.\n")
}

// engineCommand is this engine's own CLI with sub, as a shell would run it:
// the launcher that ships beside the binaries, so it is the copy that RAN.
func engineCommand(sub string) string {
	exe := filepath.ToSlash(filepath.Join(engine.Root(), "bin", "spec-flow"))
	if strings.ContainsAny(exe, " \t") {
		exe = `"` + exe + `"`
	}
	return exe + " " + sub
}

var (
	writable        = []string{".claude/state/", "specflow/"}
	readable        = append(append([]string{}, writable...), "specs/", ".spec-flow/", ".claude/")
	hooksOnly       = regexp.MustCompile(`^\.claude/state/[^/]+\.log$`)
	attributedTrace = regexp.MustCompile(`(?m) (?:read|write) file=.* agent_id=[\w-]+$| test verdict=.* agent_id=[\w-]+$`)
	redirectTarget  = regexp.MustCompile(`(?:^|[^0-9&>])>>?\s*([^\s&|;<>]+)`)
	sedInPlace      = regexp.MustCompile(`^-[a-zA-Z]*i`)
)

// inRepo is path relative to the repository with `/`, or `""` when outside it.
func inRepo(root, path string) (string, bool) {
	abs := path
	if !filepath.IsAbs(path) {
		abs = filepath.Join(root, path)
	}
	rel, err := filepath.Rel(root, abs)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", false
	}
	return filepath.ToSlash(rel), true
}

func under(rel string, prefixes []string) bool {
	for _, p := range prefixes {
		if rel == strings.TrimSuffix(p, "/") || strings.HasPrefix(rel, p) {
			return true
		}
	}
	return false
}

func readableRel(rel string) bool {
	return under(rel, readable) || (!strings.Contains(rel, "/") && strings.HasSuffix(rel, ".md"))
}

// A quoted or escaped word keeps its whitespace and its `> | & ; <` as
// characters: masked into the private-use range, restored on the way out.
func maskRune(r rune) rune {
	if strings.ContainsRune(" \t\n\r\f\v<>|&;", r) {
		return 0xE000 + r
	}
	return r
}

func unmask(s string) string {
	return strings.Map(func(r rune) rune {
		if r >= 0xE000 && r <= 0xE07F {
			return r - 0xE000
		}
		return r
	}, s)
}

// bashWrites are the paths a command writes, moves or deletes, as far as its
// plain forms say.
func bashWrites(cmd string) []string {
	kinds := shell.Kinds(cmd)
	command := cmd
	if kinds != nil {
		var b strings.Builder
		for k := 0; k < len(cmd); {
			r, w := utf8.DecodeRuneInString(cmd[k:])
			switch kinds[k] {
			case shell.Quoting, shell.Data:
			case shell.Code:
				b.WriteString(cmd[k : k+w])
			default:
				b.WriteRune(maskRune(r))
			}
			k += w
		}
		command = b.String()
	}
	var paths []string
	for _, m := range redirectTarget.FindAllStringSubmatch(command, -1) {
		paths = append(paths, m[1])
	}
	for _, part := range compoundSep.Split(command, -1) {
		t := strings.Fields(part)
		for len(t) > 0 && assignment.MatchString(t[0]) {
			t = t[1:]
		}
		if len(t) > 1 && t[0] == "git" && (t[1] == "mv" || t[1] == "rm") {
			t = t[1:]
		}
		if len(t) == 0 {
			continue
		}
		var args []string
		for _, a := range t[1:] {
			if !strings.HasPrefix(a, "-") {
				args = append(args, a)
			}
		}
		switch t[0] {
		case "mv", "rm", "rmdir", "unlink", "tee":
			paths = append(paths, args...)
		case "cp":
			if len(args) > 0 {
				paths = append(paths, args[len(args)-1])
			}
		case "sed":
			inPlace := false
			for _, a := range t {
				if sedInPlace.MatchString(a) {
					inPlace = true
				}
			}
			if inPlace && len(args) > 1 {
				paths = append(paths, args[len(args)-1])
			}
		}
	}
	var out []string
	for _, p := range paths {
		if p = unmask(p); p != "" && !strings.HasPrefix(p, "&") && p != "/dev/null" {
			out = append(out, p)
		}
	}
	return out
}

func uniq(list []string) []string {
	var out []string
	seen := map[string]bool{}
	for _, v := range list {
		if !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	return out
}

// OrchestratorScope — PreToolUse on Read, the writes and Bash — keeps the
// orchestrator routing during a run (ADR-034): in the repository it may read
// `specflow/`, `specs/`, `.spec-flow/`, `.claude/` and the root's `*.md`, and
// write only `.claude/state/` and `specflow/`, the hooks' own logs excepted.
// A subagent's call carries its `agent_id`, the session's none — the whole
// test — so it arms only once the trace shows this build attributes calls.
func OrchestratorScope(c *hookio.Ctx) {
	root := hookio.ProjectDir()
	phase := hookio.ReadPhase(root)
	if !hookio.IsRunPhase(phase) {
		return
	}
	p := c.Payload()
	if hookio.First(p["agent_id"]) != "" {
		return // a subagent: its role decides what it touches
	}
	trace, _ := hookio.ReadText(filepath.Join(hookio.StateDir(root), "run-trace.log"))
	if !attributedTrace.MatchString(trace) {
		hookio.AppendLine(filepath.Join(hookio.StateDir(root), "orchestrator-scope-unmatched.log"), fmt.Sprintf("%s phase=%s tool=%s unattributed", hookio.NowISO(), phase, hookio.JSString(p["tool_name"])))
		return
	}
	tool := hookio.JSString(p["tool_name"])
	input := hookio.Obj(p["tool_input"])
	route := "The agent whose job it is does it — the implementer writes code and tests for a milestone, the spec-writer writes `specs/` and `specflow/` — and a human edits the contract. " +
		"If a human asked for this mid-run, it belongs to the milestone's implementer or to after the run; standing the run down is theirs to do, from their own terminal (ADR-034)."
	if tool == "Read" {
		rel, ok := inRepo(root, hookio.JSString(input["file_path"]))
		if !ok || readableRel(rel) {
			return
		}
		c.Deny(fmt.Sprintf("the orchestrator reading %s during a run. Every file this session reads stays in its context for the rest of the run and is paid again on each message it sends (ADR-033); the agent that needs the code reads it, and its context ends with it. ", rel) +
			"Ask that agent, or read the gate's log under .claude/state/, which names the files and lines.")
	}
	var written []string
	if tool == "Bash" {
		written = bashWrites(shell.ResolveCd(hookio.JSString(input["command"])))
	} else if f := hookio.JSString(hookio.Nullish(input["file_path"], input["notebook_path"], input["filePath"])); f != "" {
		written = []string{f}
	}
	var outside []string
	for _, w := range written {
		if rel, ok := inRepo(root, w); ok && (!under(rel, writable) || hooksOnly.MatchString(rel)) {
			outside = append(outside, rel)
		}
	}
	if len(outside) == 0 {
		return
	}
	allLogs := true
	for _, rel := range outside {
		if !hooksOnly.MatchString(rel) {
			allLogs = false
		}
	}
	if allLogs {
		c.Deny(fmt.Sprintf("the orchestrator writing %s. The logs under .claude/state/ are what the hooks append and decide on; a line this session wrote would be evidence nothing produced (ADR-036).", strings.Join(uniq(outside), ", ")))
	}
	c.Deny(fmt.Sprintf("the orchestrator writing, moving or deleting %s during a run. This session routes: during a run it writes only .claude/state/ and specflow/. %s", strings.Join(uniq(outside), ", "), route))
}

const lintMaxLines = 30

// LintOnWrite — PostToolUse on Write|Edit — lints the file just written,
// while it is still in the agent's context: cheaper than a gate cycle.
// WITHOUT --fix: a rewrite behind the agent's back fails its next edit as
// "modified externally". Only during `implement`.
func LintOnWrite(c *hookio.Ctx) {
	root := hookio.ProjectDir()
	// The repository's own linter is spawned, so a committed phase is content (ADR-017).
	if hookio.ReadPhase(root) != "implement" {
		return
	}
	input := hookio.Obj(c.Payload()["tool_input"])
	file := hookio.JSString(hookio.Nullish(input["file_path"], input["filePath"]))
	cfg, err := contract.Load(root)
	if err != nil {
		return // a bad contract degrades to "nothing in scope", never to a deny
	}
	// The gate's own reading of the scope: a git pathspec, from the root.
	if !gitscope.InScope(root, file, cfg.Verify.ScopeGlobs) {
		return
	}
	onDisk := file
	if !filepath.IsAbs(onDisk) {
		onDisk = filepath.Join(root, onDisk)
	}
	if !hookio.Exists(onDisk) || len(cfg.Verify.LintNoFix) == 0 {
		return
	}
	bin, args := cfg.Verify.LintNoFix[0], cfg.Verify.LintNoFix[1:]
	// Only a path-shaped binary can be checked against a location; this guard
	// exists only to skip a repository mid-install.
	if checkable, present := argv.ResolvableOnDisk(argv.BinaryOf(cfg.Verify.LintNoFix), root); checkable && !present {
		return
	}
	res := proc.Run(proc.Options{Dir: root}, append(cfg.Verify.LintNoFix, file)...)
	if res.Err != nil {
		// Not "lint passed": logged once per binary, so a linter that cannot
		// be spawned does not disarm this hook in silence.
		hookio.AppendUnique(filepath.Join(hookio.StateDir(root), "lint-on-write-unmatched.log"), fmt.Sprintf("%s %s: %v", bin, strings.Join(args, " "), res.Err))
		return
	}
	if res.Status == 0 {
		return
	}
	lines := strings.Split(res.Out(), "\n")
	short := strings.Join(lines[:min(len(lines), lintMaxLines)], "\n")
	if len(lines) > lintMaxLines {
		short += fmt.Sprintf("\n... (%d lines total, truncated)", len(lines))
	}
	c.Fail(fmt.Sprintf("[spec-flow] %s flagged the file you just wrote — fix it now, while it is ", cfg.Verify.LintName) +
		"still in front of you. Fixing it here costs one edit; letting it reach the gate " +
		"costs a full retry cycle.\n\n" + short + "\n\n" +
		fmt.Sprintf("If the violation comes from a project rule in %s, read its ", cfg.Verify.LintConfigHint) +
		"message: it names what the rule protects and why it exists.\n")
}
