package hooks

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/IgnacioMarin402/spec-flow-plugin/internal/contract"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/engine"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/gitscope"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/hookio"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/proc"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/unscoped"
)

const maxAttempts = 5

// MaxDirtySkips is consecutive dirty skips before the run is woken — well
// past what a busy milestone produces, because early is noise on the one
// outcome that needs nothing done. The gate tests keep their own copy.
const MaxDirtySkips = 10

// The planner reads gate-failure.log on every REPLAN, so it is budgeted; the
// untruncated output stays in gate-failure.full.log for a human.
const (
	maxLintLines = 40
	maxTestLines = 60
)

func shortSha(root string) string {
	if res := proc.Git(root, "rev-parse", "--short", "HEAD"); res.OK() {
		return strings.TrimSpace(res.Stdout)
	}
	return "-"
}

var ccVersion = regexp.MustCompile(`^\d+\.\d+\.\d+[\w.+-]*$`)

// claudeCodeVersion is the `version` of the transcript's last line that
// carries one, else `?` (ADR-041): a resumed session's transcript holds every
// build it ran under. Read from the end, widening until a whole line answers.
func claudeCodeVersion(p hookio.Payload) string {
	path := hookio.First(p["transcript_path"], p["transcriptPath"])
	if path == "" {
		return "?"
	}
	f, err := os.Open(path)
	if err != nil {
		return "?"
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return "?"
	}
	size := st.Size()
	for span := int64(256 * 1024); ; span *= 4 {
		length := min(size, span)
		buf := make([]byte, length)
		if _, err := f.ReadAt(buf, size-length); err != nil && length > 0 {
			return "?"
		}
		lines := strings.Split(string(buf), "\n")
		if length < size {
			lines = lines[1:] // begins mid-line
		}
		for i := len(lines) - 1; i >= 0; i-- {
			var entry struct {
				Version any `json:"version"`
			}
			if json.Unmarshal([]byte(lines[i]), &entry) != nil {
				continue
			}
			// Whitespace-free, because the history is read back by a split.
			if v, ok := entry.Version.(string); ok && ccVersion.MatchString(v) {
				return v
			}
		}
		if length == size {
			return "?"
		}
	}
}

func truncate(text string, max int) string {
	lines := strings.Split(text, "\n")
	if len(lines) <= max {
		return text
	}
	return strings.Join(lines[:max], "\n") + fmt.Sprintf("\n... [%d more lines — see .claude/state/gate-failure.full.log]", len(lines)-max)
}

var testSignal = regexp.MustCompile(`^\s*(●|✕|Tests:|Suites:|Test Suites:)`)

// summarizeTests keeps the failure blocks and the totals; with no marker it
// keeps the TAIL, where a runner prints its summary — a full suite's head is
// pass spew, spent on the most expensive model in the flow.
func summarizeTests(text string, max int) string {
	var picked []string
	for _, l := range strings.Split(text, "\n") {
		if testSignal.MatchString(l) {
			picked = append(picked, l)
		}
	}
	if len(picked) > 0 {
		return truncate(strings.Join(picked, "\n"), max)
	}
	lines := strings.Split(text, "\n")
	if len(lines) <= max {
		return text
	}
	return fmt.Sprintf("... [%d more lines above — see .claude/state/gate-failure.full.log]\n%s", len(lines)-max, strings.Join(lines[len(lines)-max:], "\n"))
}

// gateArmed is set once the gate knows it is armed, so the fail-closed
// handler can still write a history line and a block after a crash.
var gateArmed func(result, lint, test, fields, files string)

var (
	runningLine  = regexp.MustCompile(` result=running `)
	skipDirty    = regexp.MustCompile(` result=skip-dirty `)
	passLine     = regexp.MustCompile(` result=pass `)
	stateDirLine = regexp.MustCompile(`\.claude[\\/]state[\\/]`)
	porcelainQ   = regexp.MustCompile(`^"|"$`)
)

func nonEmptyLines(text string) []string {
	var out []string
	for _, l := range strings.Split(text, "\n") {
		if l != "" {
			out = append(out, l)
		}
	}
	return out
}

func shaOf(line string) string {
	if f := strings.Split(line, " "); len(f) > 1 {
		return f[1]
	}
	return ""
}

// Gate — Stop, while the phase is `implement` — the external lint, test and
// spec gate, run outside the model.
//
//   - Lint is scoped to the files the branch changed; the suite never is, and
//     never skips, not even on an empty scope (ADR-008). The base is never
//     guessed: a wrong one manufactures an empty scope.
//   - A dirty tree is not judged: a background implementer may be mid-write.
//     A streak of them wakes the run once, and so does a dirty tree on a
//     commit no gate has judged (ADR-012).
//   - `running` goes into the history before anything is judged and every
//     outcome replaces it. One that survives is proof the invocation was
//     killed — a timed-out Stop hook renders no decision, and that ALLOWS the
//     stop — and the next armed gate reports it.
//   - The first pass on a commit wakes the orchestrator (ADR-010); a repeat
//     stop on a clean tree and a passed sha spawns NOTHING.
//   - At its cap it writes `blocked` and hands the run to a human.
func Gate(c *hookio.Ctx) {
	// The payload says which session this Stop is: Stop fires for the
	// orchestrating turn, so the owner check is safe here (ADR-017).
	p := c.Payload()
	root := hookio.ProjectDir()
	phaseFile := hookio.PhasePath(root)
	phase := hookio.ReadOwnedPhase(root, hookio.JSString(p["session_id"]))
	if phase != "implement" {
		return // nothing recorded: a Stop fires in every session
	}
	// A subagent still running means this stop ends the orchestrator's TURN,
	// not a milestone (ADR-023). Subagents only: a dev server may never end.
	if tasks, ok := p["background_tasks"].([]any); ok {
		for _, t := range tasks {
			if m := hookio.Obj(t); m["type"] == "subagent" && m["status"] == "running" {
				return
			}
		}
	}
	state := hookio.StateDir(root)
	attFile := filepath.Join(state, "gate_attempts")
	logFile := filepath.Join(state, "gate-failure.log")
	fullLogFile := filepath.Join(state, "gate-failure.full.log")
	histFile := filepath.Join(state, "gate-history.log")
	attemptsNow := func() string { return hookio.ReadFileOrDefault(attFile, "0") }
	cc := claudeCodeVersion(p)
	revision := engine.Revision(engine.Root())
	// `cc=` and `engine=` are recorded, never checked (ADR-004, ADR-041,
	// ADR-018). The live view reads a failure's checks as the fields between
	// `result=` and `files=` (ADR-047).
	line := func(result, lint, test, fields, files string) string {
		return fmt.Sprintf("%s %s cc=%s engine=%s phase=%s attempt=%s result=%s lint=%s test=%s %s files=%s",
			time.Now().UTC().Format("2006-01-02T15:04:05Z"), shortSha(root), cc, revision, phase, attemptsNow(), result, lint, test, fields, files)
	}
	replaceRunning := func(text string) {
		lines := nonEmptyLines(hookio.ReadFileOrDefault(histFile, ""))
		if len(lines) > 0 && runningLine.MatchString(lines[len(lines)-1]) {
			lines = lines[:len(lines)-1]
		}
		hookio.WriteFile(histFile, strings.Join(append(lines, text), "\n")+"\n")
	}
	hist := func(result, lint, test, fields, files string) {
		replaceRunning(line(result, lint, test, fields, files))
	}

	// A dangling `running` from a PREVIOUS invocation: that gate was killed
	// mid-judgement. Replaced, not appended beside, or every future stop would
	// block on the same dead invocation.
	previous := nonEmptyLines(hookio.ReadFileOrDefault(histFile, ""))
	if len(previous) > 0 && runningLine.MatchString(previous[len(previous)-1]) {
		gateArmed = hist
		hist("fail:killed", "-", "-", "unscoped=-", "-")
		hookio.Block(c.Stdout, "GATE FAILED — the previous gate invocation never finished. Its history line says `running` and no outcome ever replaced it, which means the process was killed before it could judge anything: nothing was linted, tested or traced for that stop, and the stop was ALLOWED, because a Stop hook that renders no decision allows one. "+
			"The usual cause is `verify.test` exceeding the Stop hook's time budget (1800s as this plugin declares it). Treat the previous milestone as UNVERIFIED. "+
			"Do not change the phase. Show this to a human: either the suite needs to be a smaller smoke subset in `verify.test`, or the timeout in the plugin's hooks.json needs raising. Then end your turn — the next gate runs normally.")
		return
	}
	// This invocation's claim on the log, before anything is spawned.
	hookio.AppendLine(histFile, line("running", "-", "-", "unscoped=-", "-"))
	gateArmed = hist

	// Ahead of the contract: one read from a subdirectory is the wrong one
	// (ADR-027). Ahead of the dirty check, whose paths git spells from the root.
	if err := gitscope.AssertRepoRoot(root); err != nil {
		hist("fail:root", "-", "-", "unscoped=-", "-")
		hookio.Block(c.Stdout, fmt.Sprintf("GATE FAILED — %v Do not proceed and do not change the phase. Nothing was linted, tested or traced, so treat NOTHING as verified.", err))
		return
	}
	// The one deliberate fail-CLOSED case: an unrecognised contract blocks loudly.
	cfg, err := contract.Load(root)
	if err != nil {
		hist("fail:contract", "-", "-", "unscoped=missing", "-")
		hookio.Block(c.Stdout, fmt.Sprintf("GATE FAILED — the contract could not be read: %v Do not proceed. A human needs to fix .spec-flow/config.json (or the engine's own supported version) before this run can continue.", err))
		return
	}

	// ---- quiescence guard ----------------------------------------------------
	// `.claude/state/` is excluded: the gate's own writes land there. So is
	// `trace.report.path`: the SUITE writes it, and the gate runs the suite,
	// so every armed run leaves it behind. Prefix, because git collapses an
	// untracked directory into one entry.
	status := proc.Git(root, "status", "--porcelain")
	reportPath := ""
	if cfg.Trace.Report != nil {
		reportPath = strings.ReplaceAll(cfg.Trace.Report.Path, `\`, "/")
	}
	isReportDirt := func(l string) bool {
		if reportPath == "" || len(l) < 3 {
			return false
		}
		path := strings.ReplaceAll(porcelainQ.ReplaceAllString(l[3:], ""), `\`, "/")
		prefix := path
		if !strings.HasSuffix(prefix, "/") {
			prefix += "/"
		}
		return path == reportPath || strings.HasPrefix(reportPath, prefix)
	}
	var dirty []string
	if status.OK() {
		for _, l := range strings.Split(status.Stdout, "\n") {
			if strings.TrimSpace(l) != "" && !stateDirLine.MatchString(l) && !isReportDirt(l) {
				dirty = append(dirty, l)
			}
		}
	}
	if len(dirty) > 0 {
		n := strconv.Itoa(len(dirty))
		hist("skip-dirty", "-", "-", unscoped.HistDashes(cfg), n)
		// A dirty tree on a commit NO gate has judged is not an implementer
		// mid-write: the orchestrator committed and waits for a verdict nothing
		// will deliver (ADR-012). Once per commit; a sha of `-` cannot tell.
		sha := shortSha(root)
		judged := false
		for _, l := range previous {
			if shaOf(l) == sha {
				judged = true
			}
		}
		if sha != "-" && !judged {
			hookio.Block(c.Stdout, fmt.Sprintf("GATE SKIPPED — the working tree is dirty on %s, a commit no gate has ever judged: nothing was linted, tested or traced for it, and this stop was ALLOWED, because a dirty tree is not a failure. ", sha)+
				fmt.Sprintf("Uncommitted paths: %s. If a subagent is still writing — an implementer, or the spec-writer folding — that is what the skip is for: say so and end your turn again; this is reported once per commit, not on every stop. ", n)+
				"If none is running, you are waiting for a verdict that will never arrive: run `git status`, commit what is left to this milestone's branch, and end your turn so the gate judges a clean tree. "+
				"A `git mv` stages a rename carrying the file's OLD content, so a file edited and then moved needs an explicit `git add` — a plain `git commit` drops the edit and leaves exactly this. Do not change the phase.")
			return
		}
		// Skipping is right for one stop and wrong forever. The streak is on
		// disk already; reported on `==`, so an unbroken streak wakes ONCE.
		prior := 0
		for i := len(previous) - 1; i >= 0 && skipDirty.MatchString(previous[i]); i-- {
			prior++
		}
		if prior+1 == MaxDirtySkips {
			hookio.Block(c.Stdout, fmt.Sprintf("GATE SKIPPED %d times in a row — the working tree has been dirty at every stop, so this milestone has never been judged: nothing was linted, tested or traced, and each of those stops was ALLOWED because a dirty tree is not a failure. ", MaxDirtySkips)+
				fmt.Sprintf("Uncommitted paths: %s. That guard exists for a subagent writing in the background, and this no longer looks like one. ", n)+
				"Find out which: if a subagent is still working, let it finish and say nothing. If none is, the work was left uncommitted and no gate will ever see it — commit it to this milestone's branch, then end your turn so the gate runs against a clean tree. Do not change the phase.")
		}
		return
	}

	// ---- the verdict this commit already has --------------------------------
	// The tree is clean and the sha carries a `pass`: nothing this gate may
	// judge can have changed. ADR-008 forbids scoping the suite, not
	// re-running it over an identical tree. Every field `-`: reprinting
	// `lint=0` for commands that did not run is the lie lintField refuses.
	judgedSha := shortSha(root)
	if judgedSha != "-" {
		for _, l := range previous {
			if shaOf(l) == judgedSha && passLine.MatchString(l) {
				hist("pass", "-", "-", unscoped.HistDashes(cfg), "-")
				hookio.Notice(c.Stdout, fmt.Sprintf("spec-flow: gate PASSED — %s. Already reported for this commit, and not re-judged: the tree is clean and nothing has been committed since, so the verdict cannot have changed. Nothing more happens on its own unless you act.", judgedSha))
				return
			}
		}
	}

	// ---- scope: the files this branch touched ---------------------------------
	// An unresolvable base is a contract a human fixes, not an engine defect.
	base, err := gitscope.ResolveBase(root, cfg)
	if err != nil {
		hist("fail:base", "-", "-", unscoped.HistDashes(cfg), "-")
		hookio.Block(c.Stdout, fmt.Sprintf("GATE FAILED — the base branch could not be resolved: %v Do not proceed and do not change the phase. Nothing was linted or tested, so treat NOTHING as verified. A human needs to add \"base_ref\" under \"verify\" in .spec-flow/config.json.", err))
		return
	}
	files := gitscope.ChangedFiles(root, cfg.Verify.ScopeGlobs, base)

	// ---- the base that resolved, to the tip ------------------------------------
	// Work done ON the base branch empties the diff by construction, and lint
	// — the one scoped check — would never run while `lint=-` reads as honest.
	// Not in preflight: a fresh branch sits at its base until its first commit.
	if head := proc.Git(root, "rev-parse", "HEAD"); head.OK() && strings.TrimSpace(head.Stdout) == base {
		branch := "(unknown)"
		if b := proc.Git(root, "rev-parse", "--abbrev-ref", "HEAD"); b.OK() {
			branch = strings.TrimSpace(b.Stdout)
		}
		// `files` — zero, and COUNTED — tells this refusal from the one above.
		hist("fail:base", "-", "-", unscoped.HistDashes(cfg), strconv.Itoa(len(files)))
		hookio.Block(c.Stdout, fmt.Sprintf("GATE FAILED — the base resolved to HEAD itself, so the changed-file scope is empty by construction and %s was never invoked. ", cfg.Verify.LintName)+
			fmt.Sprintf("Branch \"%s\" has no commit the base does not already have. Either this work is being done directly ON the base branch, in which case the scope will be empty for every milestone of this run, or this milestone committed nothing at all. ", branch)+
			"Do not proceed and do not change the phase. Nothing was linted, so treat NOTHING as verified. A human fixes this by doing the run's work on its own branch, or by declaring the ref this work is judged against as \"base_ref\" under \"verify\" in .spec-flow/config.json.")
		return
	}

	// ---- the scope that can never match ----------------------------------------
	if len(files) == 0 && gitscope.ScopeMatchesNothing(root, cfg.Verify.ScopeGlobs) {
		hist("fail:scope", "-", "-", unscoped.HistDashes(cfg), "0")
		hookio.Block(c.Stdout, fmt.Sprintf("GATE FAILED — verify.scope_globs (%s) matches no file this repository tracks, so the changed-file scope is empty by construction and %s was never invoked. ", strings.Join(cfg.Verify.ScopeGlobs, ", "), cfg.Verify.LintName)+
			"This is not a milestone that touched nothing in scope: nothing could ever be in scope, on any commit, so the history's `lint=-` would read as clean for the whole run. "+
			"Do not proceed and do not change the phase. Nothing was linted, so treat NOTHING as verified. A human fixes this in \"scope_globs\" under \"verify\" in .spec-flow/config.json — these are git pathspecs, where `*` already crosses `/`, so \"*.ts\" covers every depth and \"**/*.ts\" skips the repo root. `spec-flow init` regenerates the field from this repo.")
		return
	}

	// Lint is scoped, so it has nothing to do when nothing in scope changed.
	lintOut, lintRc := "(no files in scope changed)", 0
	if len(files) > 0 {
		res := proc.Run(proc.Options{Dir: root}, append(append([]string{}, cfg.Verify.Lint...), files...)...)
		lintOut, lintRc = res.Out(), exitOrOne(res)
	}
	// The suite runs on EVERY armed gate, scoped to nothing: its outcome is
	// a property of the system, and an empty diff is not always real.
	contract.PrepareReport(root, cfg)
	testRes := proc.Run(proc.Options{Dir: root}, cfg.Verify.Test...)
	testOut, testRc := testRes.Out(), exitOrOne(testRes)

	// AFTER the suite: spec-trace reads what THIS run of it reported.
	result := unscoped.Run(root, cfg)
	lintField := "-"
	if len(files) > 0 {
		lintField = strconv.Itoa(lintRc)
	}
	if lintRc == 0 && testRc == 0 && result.AllPass {
		sha := shortSha(root)
		hist("pass", lintField, strconv.Itoa(testRc), unscoped.HistFields(result), strconv.Itoa(len(files)))
		hookio.WriteFile(attFile, "0")
		hookio.WriteFile(logFile, "")
		hookio.WriteFile(fullLogFile, "")
		// A pass WAKES the orchestrator: an interactive session discards a
		// Stop hook's systemMessage (ADR-010).
		summary := fmt.Sprintf("spec-flow: gate PASSED — %s (%s %s, %s %d, %s).", sha, cfg.Verify.LintName, lintField, cfg.Verify.TestName, testRc, unscoped.HistFields(result))
		hookio.Block(c.Stdout, summary+" Advance the run now: start the NEXT milestone with a fresh implementer Agent call, or if none remain, invoke spec-writer in MODE=FOLD; if this was the fold's own gate re-run, write 'done' into .claude/state/phase. Do not re-run lint or tests yourself and do not repeat what already passed.")
		return
	}

	// ---- failure path -----------------------------------------------------
	attempts, _ := strconv.Atoi(attemptsNow())
	attempts++
	hookio.WriteFile(attFile, strconv.Itoa(attempts))
	// A traceability failure groups with lint: its common cause is a test that
	// never named the requirement, an edit. A red test is behaviour, and so is
	// a check the contract declared `behaviour`.
	failureClass := "lint/trace"
	if testRc != 0 {
		failureClass = "behaviour"
	}
	for _, ch := range result.Checks {
		if ch.RC != 0 && ch.Class == "behaviour" {
			failureClass = "behaviour"
		}
	}
	var sections, terse []string
	for _, ch := range result.Checks {
		sections = append(sections, fmt.Sprintf("--- %s (rc=%d) ---\n%s", ch.Name, ch.RC, ch.Out))
		body := ch.Out
		if ch.RC == 0 {
			body = ch.Green
		}
		terse = append(terse, fmt.Sprintf("--- %s (rc=%d) ---\n%s", ch.Name, ch.RC, body))
	}
	header := []string{
		fmt.Sprintf("=== GATE FAILURE (attempt %d/%d, class: %s) ===", attempts, maxAttempts, failureClass),
		fmt.Sprintf("--- scope (%d changed file(s) vs %s) ---", len(files), base),
		strings.Join(files, "\n"),
		"",
		fmt.Sprintf("--- %s (rc=%s) ---", cfg.Verify.LintName, lintField),
	}
	extra := func(s []string) string {
		if len(s) == 0 {
			return ""
		}
		return "\n" + strings.Join(s, "\n\n")
	}
	hookio.WriteFile(fullLogFile, strings.Join(append(append([]string{}, header...), lintOut, "", fmt.Sprintf("--- %s (rc=%d) ---", cfg.Verify.TestName, testRc), testOut, extra(sections)), "\n"))
	// `(clean)` would claim a linter passed over files it was never given.
	lintShort := lintOut
	if len(files) > 0 {
		lintShort = "(clean)"
		if lintRc != 0 {
			lintShort = truncate(lintOut, maxLintLines)
		}
	}
	testShort := "(all passing)"
	if testRc != 0 {
		testShort = summarizeTests(testOut, maxTestLines)
	}
	hookio.WriteFile(logFile, strings.Join(append(append([]string{}, header...), lintShort, "", fmt.Sprintf("--- %s (rc=%d, failures only) ---", cfg.Verify.TestName, testRc), testShort, extra(terse)), "\n"))
	hist("fail:"+failureClass, lintField, strconv.Itoa(testRc), unscoped.HistFields(result), strconv.Itoa(len(files)))

	summary := unscoped.Summary(result)
	switch {
	case attempts >= maxAttempts:
		// Repeated failure of any class means a human should look.
		hookio.WriteFile(attFile, "0")
		hookio.WriteFile(phaseFile, "blocked")
		hookio.Block(c.Stdout, fmt.Sprintf("GATE FAILED %d times (lint rc=%s, test rc=%d, %s). Auto-loop stopped to avoid thrashing; the phase is now 'blocked' so this stop-and-wait is allowed. Read .claude/state/gate-failure.log, summarize the blocker for the human (HITL), and wait. After their guidance, write 'implement' into .claude/state/phase and resume the milestone.", attempts, lintField, testRc, summary))
	case failureClass == "lint/trace" && attempts <= 2:
		// Lint only: the implementer fixes it directly, no re-plan.
		hookio.Block(c.Stdout, fmt.Sprintf("GATE FAILED on lint and/or the unscoped checks (lint rc=%s, %s); the tests pass, so the plan is NOT in question. Do NOT re-plan and do NOT change the phase. Route the fix back to the session whose edits are being checked — the implementer of the CURRENT milestone, or the spec-writer if you just ran the FOLD step — with the output in .claude/state/gate-failure.log, and have it fix exactly those violations — nothing else. Note that the linter already applied everything auto-fixable, so what remains needs a real edit; if a violation comes from a project rule in %s, read its message, which explains what it protects. %s Then end your turn so the gate runs again.", lintField, summary, cfg.Verify.LintConfigHint, unscoped.FailedHints(result)))
	case failureClass == "behaviour" && attempts == 1:
		// The first red after a milestone is overwhelmingly a bug in the code
		// just written: an Opus REPLAN before a direct fix is expensive-first.
		hookio.Block(c.Stdout, fmt.Sprintf("GATE FAILED (lint rc=%s, test rc=%d, %s), attempt 1/%d. Do NOT re-plan yet and do NOT change the phase. Route the fix back to the implementer of the CURRENT milestone with the output in .claude/state/gate-failure.log: fix the code (and any lint violation alongside it) so everything passes. Do NOT skip, delete, or weaken the failing test to make this pass — spec-trace does not catch a test that still exists but no longer asserts anything. If you believe the PLAN itself is wrong rather than the code, say so in your reply instead of patching around the test. Then end your turn so the gate runs again.", lintField, testRc, summary, maxAttempts))
	default:
		hookio.Block(c.Stdout, fmt.Sprintf("GATE FAILED (lint rc=%s, test rc=%d, %s, class=%s) on the files this branch changed. Do NOT patch ad-hoc. Loop back to the PLAN phase: (1) write 'plan' into .claude/state/phase, (2) invoke the planner subagent in MODE=REPLAN for the CURRENT milestone, pointing it at the failure log .claude/state/gate-failure.log, (3) re-invoke the implementer for that milestone, (4) set phase back to 'implement'. The full output is in .claude/state/gate-failure.log.", lintField, testRc, summary, failureClass))
	}
}

func exitOrOne(r proc.Result) int {
	if r.Status < 0 {
		return 1
	}
	return r.Status
}

// gateFailClosed is the one fail-CLOSED handler: a Stop hook that exits 0
// without a block ALLOWS the stop, so a crash here would report a clean
// milestone. Code written with the gate off looks like code that passed it.
func gateFailClosed(c *hookio.Ctx, r any) {
	if gateArmed == nil {
		return // not an armed run: nothing to fail closed about
	}
	gateArmed("fail:hook-error", "-", "-", "unscoped=missing", "-")
	hookio.Block(c.Stdout, fmt.Sprintf("GATE FAILED — the gate itself threw before it could judge anything: %s. ", hookio.ErrText(r))+
		"This is a defect in the engine, not in the milestone: nothing was linted, tested or traced, so treat NOTHING as verified. "+
		"Do not retry blindly and do not change the phase. Show this to a human, with the stack from stderr.")
	fmt.Fprintf(c.Stderr, "[spec-flow] gate threw: %s\n", hookio.ErrText(r))
}
