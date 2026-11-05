package hooks

import (
	"fmt"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strings"

	"github.com/IgnacioMarin402/spec-flow-plugin/internal/agentblocks"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/agents"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/argv"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/contract"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/engine"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/gitscope"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/hookio"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/jsre"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/shell"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/specshape"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/spectime"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/testreport"
)

var (
	runnerWrapper = regexp.MustCompile(`^(npx|pnpm|yarn|bunx)$`)
	runnerSub     = regexp.MustCompile(`^(exec|dlx|run)$`)
	gitCmd        = regexp.MustCompile(`^\s*git(\s|$)`)
	redirection   = regexp.MustCompile(`\d*[<>]{1,2}&?\s*[^\s;|&<>]*`)
	chainParts    = regexp.MustCompile(`;|&&|\|\||\||&|\n`)
	groupChars    = regexp.MustCompile("[()`]")
	pmWord        = regexp.MustCompile(`^(pnpm|npm|npx|yarn|node)$`)
	// jest and vitest count the tests that failed apart from the files that
	// did, and a file that did not load is only the second.
	failedTests   = jsre.MustCompile(`^\s*Tests:?\s.*\bfailed\b`, "m")
	failedFiles   = jsre.MustCompile(`^\s*(Test Suites:|Test Files)\s.*\bfailed\b`, "m")
	passedSummary = jsre.MustCompile(`^\s*Tests:?\s.*\bpassed\b`, "m")
	noTests       = regexp.MustCompile(`(?i)\bNo tests? (files )?found\b`)
	couldNotFind  = jsre.MustCompile(`^Could not find '`, "m")
	singlePipe    = regexp.MustCompile(`(^|[^|])\|([^|]|$)`)
	notFound      = regexp.MustCompile(`Exit code 12[67]\b|command not found|is not recognized as`)
	wordAgentID   = regexp.MustCompile(`^[\w-]+$`)
	skillMiss     = regexp.MustCompile(`SKILL_MISS:\s*([^\n"\\]+)`)
	lowerWord     = regexp.MustCompile(`^[a-z]+$`)
	pathSeps      = regexp.MustCompile(`[\\/]`)
)

var (
	// mocha counts the tests that failed, and abandons the run, uncounted, on
	// a file it cannot load.
	mochaFailing = jsre.MustCompile(`^\s*[1-9]\d* failing\b`, "m")
	mochaAborted = jsre.MustCompile(`^\s*Exception during run:`, "m")
	// A failed case in node --test's default reporter; TAP is read as TAP.
	specFailed = jsre.MustCompile(`^\s*✖ (.+) \(\d+(?:\.\d+)?ms\)\s*$`, "m")
)

// runsRunner says whether the runner is the program a command runs, rather
// than a word in it: `npx vitest run x` runs it, `grep vitest package.json`
// does not. A multi-word name (`node --test`) needs its first word in
// program position and the rest after.
func runsRunner(cmd, testName string) bool {
	words := strings.Fields(testName)
	tokens := strings.Fields(cmd)
	at := func(k int) string {
		if k < len(tokens) {
			return tokens[k]
		}
		return ""
	}
	i := 0
	for assignment.MatchString(at(i)) {
		i++
	}
	if runnerWrapper.MatchString(at(i)) || (at(i) == "npm" && at(i+1) == "exec") {
		if at(i) == "npm" {
			i += 2
		} else {
			i++
		}
		if runnerSub.MatchString(at(i)) {
			i++
		}
	}
	if len(words) > 0 && argv.Basename(at(i)) == words[0] {
		all := true
		for _, w := range words[1:] {
			if i+1 > len(tokens) || !slices.Contains(tokens[i+1:], w) {
				all = false
			}
		}
		if all {
			return true
		}
	}
	_, name := argv.ToolAt(tokens, i)
	return len(words) == 1 && name == testName
}

// failedCases are the cases a run's output names as failed: `not ok` in TAP,
// `✖ <name> (<n>ms)` from node --test's default reporter.
func failedCases(out string) []string {
	names := testreport.Parse("tap", out).Failed
	for _, m := range specFailed.ExecAll(out) {
		names = append(names, m.Group(1))
	}
	return names
}

// handed is whether name is one of the paths the run was handed: node --test
// names a file it could not load by that path, as a failed case of its own.
func handed(name string, targets []string) bool {
	norm := func(p string) string {
		return strings.TrimSuffix(strings.TrimPrefix(strings.ReplaceAll(p, `\`, "/"), "./"), "/")
	}
	for _, t := range targets {
		if ok, _ := path.Match(norm(t), norm(name)); ok {
			return true
		}
	}
	return false
}

// traceTest is a scoped test run and its verdict, read off what the runner
// printed. Red only when it reports a test that failed: a red verdict credits
// test-first, and a file that did not load ran none of its tests, so it is
// `absent`, never red (see ADR-053). A failure the hook cannot read either way
// is `?`, and its `why=` says what was not given.
func traceTest(input map[string]any, res any, testName string, failure *testFailure) string {
	if testName == "" {
		return "" // no contract read -> no runner name to look for
	}
	// Read through the shell's quoting: a commit message naming the runner runs
	// nothing, and `sh -c '<runner> …'` runs it.
	cmd := shell.Words(hookio.JSString(input["command"]))
	namesRunner := regexp.MustCompile(`(^|[^a-zA-Z-])` + regexp.QuoteMeta(testName) + `([^a-zA-Z-]|$)`)
	// The commands in a chain that run it — not git, whose arguments only name
	// it — and what each was handed, past any redirection.
	var runs []string
	for _, part := range chainParts.Split(cmd, -1) {
		if namesRunner.MatchString(part) && !gitCmd.MatchString(part) {
			runs = append(runs, strings.TrimSpace(groupChars.ReplaceAllString(part, " ")))
		}
	}
	if len(runs) == 0 {
		return ""
	}
	var out string
	if failure != nil {
		out = failure.err
	} else {
		var parts []string
		if m, ok := res.(map[string]any); ok {
			for _, k := range []string{"stdout", "stderr"} {
				if s, ok := m[k].(string); ok {
					parts = append(parts, s)
				}
			}
		}
		s, _ := res.(string)
		out = strings.Join(append(parts, s), "\n")
	}
	var targets []string
	runner := false
	for _, part := range runs {
		runner = runner || runsRunner(part, testName)
		for _, tok := range strings.Fields(redirection.ReplaceAllString(part, " ")) {
			segs := pathSeps.Split(tok, -1)
			last := segs[len(segs)-1]
			// A word with quoted whitespace in it would split the trace line.
			if !strings.HasPrefix(tok, "-") && strings.ContainsAny(tok, "/.") && !strings.Contains(last, testName) && !pmWord.MatchString(tok) && shell.Unmask(tok) == tok {
				targets = append(targets, tok)
			}
		}
	}
	target := strings.Join(targets, ",")
	if target == "" {
		target = "-"
	}
	testFailed, fileFailed := false, false
	for _, name := range failedCases(out) {
		if handed(name, targets) {
			fileFailed = true
		} else {
			testFailed = true
		}
	}
	verdict, why := "?", ""
	switch {
	case failedTests.Test(out) || strings.Contains(out, "✕") || mochaFailing.Test(out) || testFailed:
		verdict = "red"
	case fileFailed || failedFiles.Test(out) || mochaAborted.Test(out):
		verdict = "absent"
	case passedSummary.Test(out):
		if failure != nil {
			why = "summary-passed"
		} else {
			verdict = "green"
		}
	case noTests.MatchString(out) || couldNotFind.Test(out):
		verdict = "none"
	case failure == nil:
		why = "no-summary"
		if singlePipe.MatchString(cmd) {
			why = "pipe" // a pipe's exit is its last command's
		}
	case failure.interrupted:
		why = "interrupted"
	case notFound.MatchString(out):
		why = "not-found"
	case target == "-":
		why = "no-path"
	case !runner:
		why = "not-the-runner"
	default:
		why = "no-summary"
	}
	line := fmt.Sprintf("test verdict=%s target=%s", verdict, target)
	if why != "" {
		line += " why=" + why
	}
	return line
}

type testFailure struct {
	err         string
	interrupted bool
}

// traceReturn is what a subagent returned — for the reviewer, that IS the
// open question. Read at SubagentStop, never off the spawn's response, which
// echoes the PROMPT and its expected statuses. One line per agent, at its
// FIRST stop: stats reads every `agent type=` line as a fresh spawn.
func traceReturn(p hookio.Payload, traceFile, missLog string) string {
	typ := whitespace(hookio.JSString(hookio.Nullish(p["agent_type"], "?")))
	agentID := ""
	if s, ok := p["agent_id"].(string); ok && wordAgentID.MatchString(s) {
		agentID = s
	}
	if agentID != "" {
		if trace, ok := hookio.ReadText(traceFile); ok && jsre.MustCompile(` agent type=.* agent_id=`+regexp.QuoteMeta(agentID)+`(\s|$)`, "m").Test(trace) {
			return ""
		}
	}
	text := agents.HandedBack(p)
	ret := agentblocks.ParseReturn(text)
	if ret != nil {
		// A skill the milestone failed to route had nowhere to go but prose; on
		// a line it survives into the telemetry. Whitespace-free: `k=v` pairs.
		var misses []string
		seen := map[string]bool{}
		for _, m := range skillMiss.FindAllStringSubmatch(text, -1) {
			if v := whitespace(strings.TrimSpace(m[1])); v != "" && !seen[v] {
				seen[v] = true
				misses = append(misses, v)
			}
		}
		line := fmt.Sprintf("agent type=%s status=%s", typ, ret.Status)
		if len(misses) > 0 {
			line += " skill_miss=" + strings.Join(misses, ",")
		}
		// The effort the agent actually ran at, after every layer had its say.
		if level, ok := hookio.Obj(p["effort"])["level"].(string); ok && lowerWord.MatchString(level) {
			line += " effort=" + level
		}
		if agentID != "" {
			line += " agent_id=" + agentID
		}
		return line
	}
	report := "empty"
	if text != "" {
		report = "no STATUS line"
	}
	hookio.AppendUnique(missLog, `{"payload_keys":`+hookio.Marshal(hookio.Keys(p))+`,"report":`+hookio.Marshal(report)+`}`)
	return ""
}

var spaces = regexp.MustCompile(`\s+`)

func whitespace(s string) string { return spaces.ReplaceAllString(s, "-") }

var editTools = regexp.MustCompile(`^(Write|Edit|MultiEdit)$`)

// wrotePhase is whether this call wrote the phase file.
func wrotePhase(tool string, input map[string]any) bool {
	if editTools.MatchString(tool) {
		return shell.PhaseFile.Test(hookio.JSString(hookio.Nullish(input["file_path"], input["filePath"])))
	}
	return tool == "Bash" && shell.PhaseWrite.Test(shell.PhaseWriteText(hookio.JSString(input["command"])).Text)
}

// RunTrace — PostToolUse on Write|Edit|Read|Bash, PostToolUseFailure on Bash,
// and SubagentStop — the run's observable timeline. It enforces NOTHING and
// always exits 0: what an agent read (the path only), wrote, ran as a test,
// and returned. A payload it cannot read leaves its key names in
// run-trace-unmatched.log. The one call it answers is a test run whose file
// did not load, with how to make it a red run.
func RunTrace(c *hookio.Ctx) {
	root := hookio.ProjectDir()
	// Creates nothing, and a committed phase never started a run (ADR-017).
	phase := hookio.ReadPhase(root)
	if phase == "" || phase == "idle" {
		return
	}
	p := c.Payload()
	tool := hookio.JSString(hookio.Nullish(p["tool_name"], p["toolName"]))
	input := hookio.Obj(hookio.Nullish(p["tool_input"], p["toolInput"]))
	res := hookio.Nullish(p["tool_response"], p["tool_result"], p["tool_output"], p["response"])
	// `done` stands down but for the call that wrote it: that turn is the
	// run's last (ADR-043). Not into a committed `.claude/state/` (ADR-040).
	if phase == "done" && (!wrotePhase(tool, input) || hookio.StateIsTracked(root)) {
		return
	}
	state := hookio.StateDir(root)
	traceFile := filepath.Join(state, "run-trace.log")
	missLog := filepath.Join(state, "run-trace-unmatched.log")

	line := ""
	switch {
	case phase == "done":
		line = "closed tool=" + tool
	case hookio.JSString(p["hook_event_name"]) == "SubagentStop":
		line = traceReturn(p, traceFile, missLog)
	case editTools.MatchString(tool):
		// The ORDER of writes is the signal. In scope as the gate reads it; no
		// contract, nothing traced rather than a language assumed.
		file := hookio.JSString(hookio.Nullish(input["file_path"], input["filePath"]))
		if cfg, err := contract.Load(root); err == nil && file != "" && gitscope.InScope(root, file, cfg.Verify.ScopeGlobs) {
			line = "write file=" + file
		}
	case tool == "Read":
		if file := hookio.JSString(hookio.Nullish(input["file_path"], input["filePath"])); file != "" {
			line = "read file=" + file
		}
	case tool == "Bash":
		testName := ""
		if cfg, err := contract.Load(root); err == nil {
			testName = cfg.Verify.TestName
		}
		var failure *testFailure
		if hookio.JSString(p["hook_event_name"]) == "PostToolUseFailure" {
			failure = &testFailure{hookio.Str(p["error"]), p["is_interrupt"] == true}
		}
		line = traceTest(input, res, testName, failure)
	}
	if line == "" {
		return
	}
	// Absent rather than empty when the payload names no session: an empty
	// field would read as "one session". On a return line the id is the
	// SPAWNER's; the agent is `agent_id=`.
	id := ""
	for _, v := range []any{p["session_id"], p["sessionId"]} {
		if s, ok := v.(string); ok && wordAgentID.MatchString(s) {
			id = " session=" + s
			break
		}
	}
	byAgent := ""
	if s, ok := p["agent_id"].(string); ok && wordAgentID.MatchString(s) && !strings.HasPrefix(line, "agent type=") {
		byAgent = " agent_id=" + s
	}
	hookio.AppendLine(traceFile, fmt.Sprintf("%s phase=%s%s %s%s", hookio.NowISO(), phase, id, line, byAgent))
	// Said while the implementer can still turn the run into a red one, which
	// nothing after it can (ADR-053). Context, not a block: the run harmed nothing.
	if strings.HasPrefix(line, "test verdict=absent ") {
		event := hookio.JSString(p["hook_event_name"])
		if event == "" {
			event = "PostToolUse"
		}
		fmt.Fprint(c.Stdout, hookio.Marshal(map[string]any{"hookSpecificOutput": map[string]any{"hookEventName": event, "additionalContext": didNotLoad}}))
	}
}

const didNotLoad = "[spec-flow] That test file did not load, so none of its tests ran: this is not a red run. " +
	"If what it imports does not exist yet, write its signature first — exported, unimplemented — " +
	"then run the test again and confirm it fails on what it asserts."

var (
	ownType     = regexp.MustCompile(`^spec-flow:([a-z][a-z-]*)$`)
	mdLink      = regexp.MustCompile(`\]\(([^)\s]+)\)`)
	pathNoise   = regexp.MustCompile("[`'\"*]")
	caseFive    = regexp.MustCompile(`^\W*5\b`)
	liveSpecRef = regexp.MustCompile(`^specflow/([^/]+)/spec\.md$`)
	readLine    = regexp.MustCompile(` read file=(.*) agent_id=`)
)

// contractStatuses are the statuses name's contract declares, modes included.
func contractStatuses(name string) []string {
	root := engine.Root()
	path := filepath.Join(root, "agents", name+".md")
	if !hookio.Exists(path) {
		return nil
	}
	main, ok := hookio.ReadText(path)
	if !ok {
		// A contract this copy ships and cannot read is a broken install, not
		// "no contract": it crashes, and the crash lets the return through.
		panic("cannot read " + path)
	}
	texts := []string{main}
	entries, _ := os.ReadDir(filepath.Join(root, "modes"))
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), name+"-") && strings.HasSuffix(e.Name(), ".md") {
			if t, ok := hookio.ReadText(filepath.Join(root, "modes", e.Name())); ok {
				texts = append(texts, t)
			}
		}
	}
	return agentblocks.DeclaredStatuses(strings.Join(texts, "\n"))
}

// pathIn is the path a `*_PATH` value names: a markdown link's target, else
// its first token, backticks, quotes and emphasis stripped.
func pathIn(raw string) string {
	target := raw
	if m := mdLink.FindStringSubmatch(raw); m != nil {
		target = m[1]
	}
	if f := strings.Fields(pathNoise.ReplaceAllString(target, "")); len(f) > 0 {
		return f[0]
	}
	return ""
}

type problem struct{ why, reason string }

func problemWith(ret *agentblocks.Return, statuses []string, root string) *problem {
	if !slices.Contains(statuses, ret.Status) {
		return &problem{"undeclared-status", fmt.Sprintf("`STATUS: %s` is not a status your contract declares (%s), and the orchestrator routes only those. Return the one that fits.", ret.Status, strings.Join(statuses, ", "))}
	}
	for _, key := range ret.Order {
		raw := ret.Fields[key]
		if !strings.HasSuffix(key, "_PATH") || raw == "" {
			continue
		}
		path := pathIn(raw)
		full := path
		if !filepath.IsAbs(path) {
			full = filepath.Join(root, path)
		}
		if !hookio.Exists(full) {
			return &problem{"missing-path", fmt.Sprintf("`%s: %s` — there is no file at `%s`. Write it, or return the path you wrote.", key, raw, path)}
		}
	}
	return nil
}

func samePathKey(root, path string) string {
	full := path
	if !filepath.IsAbs(path) {
		full = filepath.Join(root, path)
	}
	full = filepath.Clean(full)
	if runtime.GOOS == "windows" {
		return strings.ToLower(full)
	}
	return full
}

func slugOf(root, raw string) string {
	full := raw
	if !filepath.IsAbs(raw) {
		full = filepath.Join(root, raw)
	}
	rel, err := filepath.Rel(root, full)
	if err != nil {
		return ""
	}
	if m := liveSpecRef.FindStringSubmatch(filepath.ToSlash(rel)); m != nil {
		return m[1]
	}
	return ""
}

// specWriterProblems: a round asks at most MaxOpenQuestions; a spec handed
// back is live, passes its spec-time checks, changes only ids `specs/`
// declares, and — for SPEC_READY — was written after reading specs/README.md
// and every capability spec its deltas touch (ADR-030). skips name what could
// not be judged.
func specWriterProblems(ret *agentblocks.Return, text, root, agentID, trace, phase string) (problems []problem, skips []string) {
	if ret.Status == "NEEDS_INPUT" {
		n := agentblocks.OpenQuestions(text)
		if n == 0 {
			problems = append(problems, problem{"no-questions", "`STATUS: NEEDS_INPUT` with no question under `OPEN_QUESTIONS:` gives the human nothing to answer. List the questions, or write the spec."})
		}
		if n > agentblocks.MaxOpenQuestions {
			m := agentblocks.MaxOpenQuestions
			problems = append(problems, problem{"too-many-questions", fmt.Sprintf("You asked %d questions; a round asks at most %d. Keep the %d whose answers would change the deltas most. Decide the rest and record each in the spec's `## Assumptions`, or ask it next round.", n, m, m)})
		}
		return problems, skips
	}
	if ret.Status != "SPEC_READY" && ret.Status != "TRIAGED" {
		return nil, nil
	}
	// Case 5 is not a fix: stamped REJECTED and archived, its name must be free (ADR-048).
	if ret.Status == "TRIAGED" && caseFive.MatchString(ret.Fields["CASE"]) {
		rejected := slugOf(root, pathIn(ret.Fields["SPEC_PATH"]))
		if rejected != "" && rejected != "archive" {
			if clash := specshape.ArchiveClash(rejected, spectime.ArchivedSlugs(root)); clash != "" {
				problems = append(problems, problem{"spec-shape", clash})
			}
		}
		return problems, skips
	}
	// The triage read the code, so it writes the work order, or the
	// orchestrator would read that code again (ADR-033).
	if ret.Status == "TRIAGED" {
		var unnamed []string
		for _, k := range []string{"PLAN_PATH", "WORK_ORDER_PATH"} {
			if ret.Fields[k] == "" {
				unnamed = append(unnamed, "`"+k+":`")
			}
		}
		if len(unnamed) > 0 {
			s := ""
			if len(unnamed) > 1 {
				s = "s"
			}
			problems = append(problems, problem{"no-work-order", fmt.Sprintf("A triage of case 1 to 4 writes the work order the implementer builds from — `specflow/<SLUG>/plan.md` and `specflow/<SLUG>/milestones/M1.md` — and returns %s naming it. Write it, and return the line%s.", strings.Join(unnamed, " and "), s)})
			return problems, skips
		}
	}
	raw := pathIn(ret.Fields["SPEC_PATH"])
	slug := slugOf(root, raw)
	if slug == "" || slug == "archive" {
		problems = append(problems, problem{"not-live", fmt.Sprintf("`SPEC_PATH: %s` is not a live change spec. It names `specflow/<SLUG>/spec.md`, outside `specflow/archive/`.", raw)})
		return problems, skips
	}
	// The name only in `spec`: mid-run a rename would strand the milestone (ADR-048).
	if shape := spectime.Problems(root, []string{slug}, phase == "spec"); len(shape) > 0 {
		problems = append(problems, problem{"spec-shape", "The spec is not ready to build from:\n- " + strings.Join(shape, "\n- ")})
	}
	cfg, err := contract.Load(root)
	if err != nil {
		return problems, append(skips, "no-contract")
	}
	specsDir := filepath.Join(root, cfg.Trace.SpecsDir)
	notCap := map[string]bool{}
	for _, n := range cfg.Trace.NotACapability {
		notCap[n] = true
	}
	var specs []specshape.Spec
	_ = filepath.Walk(specsDir, func(path string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() && strings.HasSuffix(path, ".md") && !notCap[filepath.Base(path)] {
			body, _ := hookio.ReadText(path)
			specs = append(specs, specshape.Spec{File: path, IDs: specshape.DeclaredIDs(body)})
		}
		return nil
	})
	body, _ := hookio.ReadText(filepath.Join(root, "specflow", slug, "spec.md"))
	own := specshape.Deltas(body)
	var unknown []string
	for _, d := range own {
		if d.Verb == "ADDED" {
			continue
		}
		declared := false
		for _, s := range specs {
			if s.IDs[d.ID] {
				declared = true
			}
		}
		if !declared {
			unknown = append(unknown, "`"+d.Verb+" "+d.ID+"`")
		}
	}
	if len(unknown) > 0 {
		problems = append(problems, problem{"unknown-id", fmt.Sprintf("%s name no requirement declared under %s/. A CHANGED or REMOVED id must already exist there: use the id it declares, or make it an ADDED.", strings.Join(unknown, ", "), cfg.Trace.SpecsDir)})
	}
	if ret.Status != "SPEC_READY" {
		return problems, skips
	}
	var expected []string
	for _, d := range own {
		if f := specshape.CapabilityOf(d.ID, specs); f != "" && !slices.Contains(expected, f) {
			expected = append(expected, f)
		}
	}
	if readme := filepath.Join(specsDir, "README.md"); hookio.Exists(readme) && !slices.Contains(expected, readme) {
		expected = append(expected, readme)
	}
	if len(expected) == 0 {
		return problems, skips
	}
	// Attribution exists when some tool call was recorded with an agent id;
	// without it, no read can be told from a missing one. The Read tool only.
	lines := strings.Split(trace, "\n")
	attributed := false
	for _, l := range lines {
		if attributedTrace.Test(l) {
			attributed = true
		}
	}
	if agentID == "" || !attributed {
		return problems, append(skips, "unattributed")
	}
	read := map[string]bool{}
	for _, l := range lines {
		if strings.HasSuffix(l, " agent_id="+agentID) {
			if m := readLine.FindStringSubmatch(l); m != nil && m[1] != "" {
				read[samePathKey(root, m[1])] = true
			}
		}
	}
	var unread []string
	for _, f := range expected {
		if !read[samePathKey(root, f)] {
			r, _ := filepath.Rel(root, f)
			unread = append(unread, filepath.ToSlash(r))
		}
	}
	if len(unread) > 0 {
		problems = append(problems, problem{"unread", fmt.Sprintf("You wrote this spec without reading %s in this run. Read them — the contract, and the requirements your deltas add to or change — and check the deltas against them. (This check sees the Read tool only.)", strings.Join(unread, ", "))})
	}
	return problems, skips
}

// AgentGate — SubagentStop — holds a spec-flow agent's return to its own
// contract before the orchestrator acts on it (ADR-031). Narrow, because it
// blocks: only this plugin's agents during a run; at most MaxBlocks per
// agent; a missing STATUS only where a return is owed; anything it cannot
// read passes, and a crash exits 0.
func AgentGate(c *hookio.Ctx) {
	root := hookio.ProjectDir()
	p := c.Payload()
	typ := hookio.JSString(p["agent_type"])
	m := ownType.FindStringSubmatch(typ)
	if m == nil {
		return
	}
	name := m[1]
	session := hookio.JSString(p["session_id"])
	phase := hookio.ReadPhase(root)
	if !hookio.IsRunPhase(phase) {
		return
	}
	statuses := contractStatuses(name)
	if len(statuses) == 0 {
		return
	}
	agentID := ""
	if s, ok := p["agent_id"].(string); ok && wordAgentID.MatchString(s) {
		agentID = s
	}
	traceFile := filepath.Join(hookio.StateDir(root), "run-trace.log")
	trace, _ := hookio.ReadText(traceFile)
	text := agents.HandedBack(p)
	ret := agentblocks.ParseReturn(text)
	var problems []problem
	var skips []string
	if ret == nil {
		// A reply with no status is judged only where a return is owed: at the
		// first stop, or after a block. Once run-trace holds a return for this
		// id, the agent is answering a SendMessage, in prose.
		returned := agentID != "" && regexp.MustCompile(` agent type=\S+ status=\S+.* agent_id=`+regexp.QuoteMeta(agentID)+`(\s|$)`).MatchString(trace)
		owed := p["stop_hook_active"] == true || (agentID != "" && !returned)
		if strings.TrimSpace(text) == "" {
			skips = append(skips, "empty")
		} else if owed {
			want := make([]string, len(statuses))
			for i, s := range statuses {
				want[i] = "STATUS: " + s
			}
			problems = append(problems, problem{"no-status", "Your reply has no line opening with `STATUS:`, so the orchestrator has nothing to route. End with the return block your contract declares: " + strings.Join(want, ", ") + "."})
		}
	} else if found := problemWith(ret, statuses, root); found != nil {
		problems = append(problems, *found)
	} else if name == "spec-writer" {
		problems, skips = specWriterProblems(ret, text, root, agentID, trace, phase)
	}

	// `agent=`, not `type=`; the live view reads `result= why= agent_id=` in
	// this order (ADR-047).
	record := func(result, why string) {
		s := ""
		if wordAgentID.MatchString(session) {
			s = " session=" + session
		}
		id := ""
		if agentID != "" {
			id = " agent_id=" + agentID
		}
		hookio.AppendLine(traceFile, fmt.Sprintf("%s phase=%s%s agent-check agent=%s result=%s why=%s%s", hookio.NowISO(), phase, s, typ, result, why, id))
	}
	if len(problems) == 0 {
		if len(skips) > 0 {
			record("skip", strings.Join(skips, ","))
		}
		return
	}
	blocks := 0
	if agentID != "" {
		mine := regexp.MustCompile(` agent-check .*result=block .*agent_id=` + regexp.QuoteMeta(agentID) + `(\s|$)`)
		for _, l := range strings.Split(trace, "\n") {
			if mine.MatchString(l) {
				blocks++
			}
		}
	} else if p["stop_hook_active"] == true {
		blocks = agentblocks.MaxBlocks
	}
	result := "block"
	if blocks >= agentblocks.MaxBlocks {
		result = "cap"
	}
	whys := make([]string, len(problems))
	reasons := make([]string, len(problems))
	for i, pr := range problems {
		whys[i], reasons[i] = pr.why, pr.reason
	}
	record(result, strings.Join(whys, ","))
	if result == "block" {
		hookio.Block(c.Stdout, "[spec-flow] "+strings.Join(reasons, "\n\n"))
	}
}
