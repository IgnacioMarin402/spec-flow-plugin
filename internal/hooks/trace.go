package hooks

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"

	"github.com/IgnacioMarin402/spec-flow-plugin/internal/agentblocks"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/agents"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/argv"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/contract"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/engine"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/gitscope"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/hookio"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/shell"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/specshape"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/spectime"
)

var (
	runnerWrapper = regexp.MustCompile(`^(npx|pnpm|yarn|bunx)$`)
	runnerSub     = regexp.MustCompile(`^(exec|dlx|run)$`)
	lineCont      = regexp.MustCompile(`\\\r?\n`)
	gitCmd        = regexp.MustCompile(`^\s*git(\s|$)`)
	quotedNoSpace = regexp.MustCompile(`"([^"\s]+)"|'([^'\s]+)'`)
	redirection   = regexp.MustCompile(`\d*[<>]{1,2}&?\s*[^\s;|&<>]*`)
	chainParts    = regexp.MustCompile(`;|&&|\|\||\||&|\n`)
	groupChars    = regexp.MustCompile("[()`]")
	pmWord        = regexp.MustCompile(`^(pnpm|npm|npx|yarn|node)$`)
	failedSummary = regexp.MustCompile(`(?m)^\s*(Tests:?|Test Suites:|Test Files)\s.*\bfailed\b`)
	passedSummary = regexp.MustCompile(`(?m)^\s*Tests:?\s.*\bpassed\b`)
	noTests       = regexp.MustCompile(`(?i)\bNo tests? (files )?found\b`)
	couldNotFind  = regexp.MustCompile(`(?m)^Could not find '`)
	singlePipe    = regexp.MustCompile(`(^|[^|])\|([^|]|$)`)
	notFound      = regexp.MustCompile(`Exit code 12[67]\b|command not found|is not recognized as`)
	wordAgentID   = regexp.MustCompile(`^[\w-]+$`)
	skillMiss     = regexp.MustCompile(`SKILL_MISS:\s*([^\n"\\]+)`)
	lowerWord     = regexp.MustCompile(`^[a-z]+$`)
	pathSeps      = regexp.MustCompile(`[\\/]`)
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
			if i+1 > len(tokens) || !contains(tokens[i+1:], w) {
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

// traceTest is a scoped test run and whether it was red. The event is the
// exit status: non-zero arrives as PostToolUseFailure. Red only when the
// runner itself, run on a path, failed — a red verdict credits test-first, so
// an unsure failure is `?`, and its `why=` says what was not given.
func traceTest(input map[string]any, res any, testName string, failure *testFailure) string {
	if testName == "" {
		return "" // no contract read -> no runner name to look for
	}
	raw := lineCont.ReplaceAllString(strings.SplitN(hookio.JSString(input["command"]), "<<", 2)[0], " ")
	cmd := quotedRe.ReplaceAllString(raw, " ")
	if gitCmd.MatchString(cmd) {
		return ""
	}
	namesRunner := regexp.MustCompile(`(^|[^a-zA-Z-])` + regexp.QuoteMeta(testName) + `([^a-zA-Z-]|$)`)
	if !namesRunner.MatchString(cmd) {
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
	// What the runner was handed: the paths of the commands in a chain that
	// run it, past any redirection.
	t := quotedRe.ReplaceAllString(quotedNoSpace.ReplaceAllString(raw, " $1$2 "), " ")
	t = redirection.ReplaceAllString(t, " ")
	var targets []string
	for _, part := range chainParts.Split(t, -1) {
		if !namesRunner.MatchString(part) {
			continue
		}
		for _, tok := range strings.Fields(groupChars.ReplaceAllString(part, " ")) {
			segs := pathSeps.Split(tok, -1)
			last := segs[len(segs)-1]
			if !strings.HasPrefix(tok, "-") && strings.ContainsAny(tok, "/.") && !strings.Contains(last, testName) && !pmWord.MatchString(tok) {
				targets = append(targets, tok)
			}
		}
	}
	target := strings.Join(targets, ",")
	if target == "" {
		target = "-"
	}
	verdict, why := "?", ""
	switch {
	case failedSummary.MatchString(out) || strings.Contains(out, "✕"):
		verdict = "red"
	case passedSummary.MatchString(out):
		if failure != nil {
			why = "summary-passed"
		} else {
			verdict = "green"
		}
	case noTests.MatchString(out) || couldNotFind.MatchString(out):
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
	case !runsRunner(cmd, testName):
		why = "not-the-runner"
	default:
		verdict = "red"
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
		if trace, ok := hookio.ReadText(traceFile); ok && regexp.MustCompile(`(?m) agent type=.* agent_id=`+regexp.QuoteMeta(agentID)+`(\s|$)`).MatchString(trace) {
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

func whitespace(s string) string { return regexp.MustCompile(`\s+`).ReplaceAllString(s, "-") }

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
// run-trace-unmatched.log.
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
}

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
	if !contains(statuses, ret.Status) {
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
		if f := specshape.CapabilityOf(d.ID, specs); f != "" && !contains(expected, f) {
			expected = append(expected, f)
		}
	}
	if readme := filepath.Join(specsDir, "README.md"); hookio.Exists(readme) && !contains(expected, readme) {
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
		if attributedTrace.MatchString(l) {
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
