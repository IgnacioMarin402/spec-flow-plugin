// Package cli is every command a terminal, CI or the orchestrator runs:
// `spec-flow <command>`. A terminal and CI have neither `${CLAUDE_PLUGIN_ROOT}`
// nor Claude Code, so each command resolves the repository it judges itself.
package cli

import (
	"bufio"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/IgnacioMarin402/spec-flow-plugin/internal/agents"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/canrun"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/contract"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/engine"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/gitscope"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/hookio"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/proc"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/spectime"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/spectrace"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/tracelines"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/unscoped"
)

// Commands are `spec-flow <name>`.
var Commands = map[string]func([]string) int{
	"check":     Check,
	"config":    Config,
	"init":      Init,
	"lines":     Lines,
	"models":    Models,
	"resume":    Resume,
	"stats":     Stats,
	"status":    Status,
	"telemetry": Telemetry,
	"trace":     Trace,
}

func projectRoot() string { return hookio.ProjectDir() }

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// Trace is `spec-flow trace [--list]`.
func Trace(args []string) int {
	return spectrace.Run(projectRoot(), contains(args, "--list"), os.Stdout, os.Stderr)
}

// Config is `spec-flow config`: the contract as every hook reads it, or why
// it does not load.
func Config(args []string) int {
	root := projectRoot()
	cfg, err := contract.Load(root)
	if err != nil {
		fmt.Fprintf(os.Stderr, "spec-flow config: %v\n", err)
		return 1
	}
	var checks []string
	for _, c := range cfg.ExtraChecks {
		checks = append(checks, c.Name)
	}
	if len(checks) == 0 {
		checks = []string{"(none)"}
	}
	fmt.Printf("spec-flow config: OK — contract v%v, read from %s (%s).\n", cfg.Version, cfg.Source, root)
	fmt.Printf("  lint:  %s\n  test:  %s\n  scope: %s\n  extra checks: %s\n", strings.Join(cfg.Verify.Lint, " "), strings.Join(cfg.Verify.Test, " "), strings.Join(cfg.Verify.ScopeGlobs, ", "), strings.Join(checks, ", "))
	return 0
}

// Check is `spec-flow check [--no-fix]`: lint over the files this branch
// changed, the whole suite, then the unscoped checks — in the gate's order,
// so "same files, same commands, same result" holds by construction.
func Check(args []string) int {
	root := projectRoot()
	fix := !contains(args, "--no-fix")
	if err := gitscope.AssertRepoRoot(root); err != nil {
		fmt.Fprintf(os.Stderr, "spec-flow check: %v\n", err)
		return 1
	}
	cfg, err := contract.Load(root)
	if err != nil {
		fmt.Fprintf(os.Stderr, "spec-flow check: %v\n", err) // unguarded: a version it cannot read stops it
		return 1
	}
	base, err := gitscope.ResolveBase(root, cfg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "spec-flow check: %v\n", err)
		return 1
	}
	files := gitscope.ChangedFiles(root, cfg.Verify.ScopeGlobs, base)
	lintRc := 0
	if len(files) == 0 {
		head := proc.Git(root, "rev-parse", "HEAD")
		switch {
		case head.OK() && strings.TrimSpace(head.Stdout) == base:
			fmt.Printf("No changed files in scope: the base resolved to HEAD itself, so the diff is empty by construction — %s is not sitting this out because nothing changed. Work on a branch off your base, or declare verify.base_ref in .spec-flow/config.json. The gate blocks on this.\n", cfg.Verify.LintName)
		case gitscope.ScopeMatchesNothing(root, cfg.Verify.ScopeGlobs):
			fmt.Printf("No changed files in scope — and verify.scope_globs (%s) matches no file this repository tracks at all, so %s can never run on any commit. These are git pathspecs: `*` already crosses `/`, so \"*.ts\" covers every depth and \"**/*.ts\" skips the repo root. Fix \"scope_globs\" under \"verify\" in .spec-flow/config.json, or re-run `spec-flow init`. The gate blocks on this.\n", strings.Join(cfg.Verify.ScopeGlobs, ", "), cfg.Verify.LintName)
		default:
			fmt.Printf("No changed files in scope vs %s — skipping lint.\n", base)
		}
	} else {
		fmt.Printf("Checking %d changed file(s) vs %s:\n", len(files), base)
		for _, f := range files {
			fmt.Printf("  %s\n", f)
		}
		fmt.Println()
		lint, label := cfg.Verify.Lint, ""
		if !fix {
			lint, label = cfg.Verify.LintNoFix, "(no fix)"
		}
		fmt.Printf("--- %s %s ---\n", cfg.Verify.LintName, label)
		lintRc = inherit(root, append(append([]string{}, lint...), files...))
		fmt.Println()
	}
	fmt.Printf("--- %s ---\n", cfg.Verify.TestName)
	contract.PrepareReport(root, cfg)
	testRc := inherit(root, cfg.Verify.Test)
	fmt.Println()
	result := unscoped.Run(root, cfg)
	for _, c := range result.Checks {
		fmt.Printf("--- %s ---\n%s\n\n", c.Name, c.Out)
	}
	fmt.Printf("engine %s\n", engine.Revision(engine.Root()))
	if lintRc == 0 && testRc == 0 && result.AllPass {
		fmt.Printf("OK — lint, tests and the unscoped checks pass (%s).\n", unscoped.Summary(result))
		return 0
	}
	fmt.Printf("FAILED — lint rc=%d, tests rc=%d, %s\n", lintRc, testRc, unscoped.Summary(result))
	return 1
}

// inherit runs argv with this process's own stdout and stderr.
func inherit(root string, argv []string) int {
	if len(argv) == 0 {
		return 1
	}
	return proc.Inherit(root, argv...)
}

// Status is `spec-flow status`: the state a run leaves between turns,
// rendered. Report only.
func Status(args []string) int {
	root := projectRoot()
	state := filepath.Join(root, ".claude", "state")
	read := func(f string) string { return hookio.ReadFileOrDefault(filepath.Join(state, f), "") }
	say := func(format string, a ...any) { fmt.Printf(format+"\n", a...) }

	say("spec-flow status — report only, nothing here gates anything")
	say("repo: %s\n", root)
	phase, owner := read("phase"), read("phase.session")
	say("Run")
	if phase == "" || phase == "idle" || phase == "done" {
		p := phase
		if p == "" {
			p = "(none)"
		}
		say("  phase: %s — no run is armed. The hooks that enforce anything stand down here.", p)
	} else if owner != "" {
		say("  phase: %s (owned by session %s)", phase, owner)
	} else {
		say("  phase: %s", phase)
	}
	if m := strings.Fields(read("current-milestone")); len(m) >= 2 {
		impl := ""
		if len(m) > 2 {
			impl = fmt.Sprintf(" (implementer session %s)", m[2])
		}
		say("  milestone: %s of %s%s", m[1], m[0], impl)
	} else if phase == "implement" {
		say("  milestone: not recorded — no implementer has been spawned in this run yet.")
	}
	if attempts, _ := strconv.Atoi(read("gate_attempts")); attempts > 0 {
		say("  consecutive gate failures: %d (the cap, and what happens at it, is the gate's — see the failure log below)", attempts)
	}
	say("")

	history := readLines(filepath.Join(state, "gate-history.log"))
	say("Gate")
	if len(history) == 0 {
		say("  no gate history — this repo has not run a milestone through the gate.")
	} else {
		lastLine := history[len(history)-1]
		last := tracelines.Parse(lastLine)
		q := func(k string) string {
			if v, ok := last.Get(k); ok {
				return v
			}
			return "?"
		}
		say("  last: %s — %s (lint %s, test %s)", q("result"), shaOf(lastLine), q("lint"), q("test"))
		if last.At != nil {
			say("        at %s, engine %s, claude code %s", last.At.UTC().Format("2006-01-02T15:04:05Z"), q("engine"), q("cc"))
		}
		if last.F("result") == "running" {
			say("  WARNING: that line was never replaced, so the gate was killed mid-judgement.")
			say("  Nothing it was judging was verified. The next armed run reports it.")
		}
		tally := newCounter()
		for _, l := range history {
			tally.add(undefined(tracelines.Parse(l), "result"), 1)
		}
		say("  history: %d invocation(s) — %s", len(history), tally.join("%[2]d %[1]s"))
	}
	if read("gate-failure.log") != "" {
		failure := readLines(filepath.Join(state, "gate-failure.log"))
		say("  the last failure is on disk (%d line(s)): .claude/state/gate-failure.log", len(failure))
		for _, l := range failure {
			if strings.HasPrefix(l, "=== GATE FAILURE") {
				say("  %s", strings.TrimSuffix(strings.TrimPrefix(l, "=== "), " ==="))
				break
			}
		}
	}
	say("")

	var entries []tracelines.Entry
	for _, l := range readLines(filepath.Join(state, "run-trace.log")) {
		entries = append(entries, tracelines.Parse(l))
	}
	rows := tracelines.SummarizeTokens(entries)
	say("Cost")
	if len(rows) == 0 {
		say("  no token accounting recorded — token-trace writes it at each stop of an armed run.")
	} else {
		width := 0
		for _, r := range rows {
			width = max(width, len(r.Model))
		}
		for _, r := range rows {
			say("  %s", tracelines.TokenRow(r, width))
		}
		say("  out and think are floors (≥): some messages never get their final count written.")
		say("  This is the live state only. `spec-flow stats` adds every archived run.")
	}
	say("")
	say("Everything above is written by the run itself. `spec-flow stats` reads the same")
	say("state plus the archived runs, and asks what it means.")
	return 0
}

func shaOf(line string) string {
	if f := strings.Split(line, " "); len(f) > 1 {
		return f[1]
	}
	return ""
}

var telemetryLogs = []string{"run-trace.log", "gate-history.log"}

// Telemetry is `spec-flow telemetry --mark | <SLUG>`: the run's slice of the
// cumulative logs moved into its change folder, which is what `stats` reads
// once the state is gone. `--mark` at intake records where this run starts.
func Telemetry(args []string) int {
	root := projectRoot()
	state := filepath.Join(root, ".claude", "state")
	offsetFile := filepath.Join(state, "run-offset")
	if contains(args, "--mark") {
		_ = os.MkdirAll(state, 0o755)
		offsets := map[string]int{}
		total := 0
		for _, f := range telemetryLogs {
			offsets[f] = len(nonBlank(filepath.Join(state, f)))
			total += offsets[f]
		}
		hookio.WriteFile(offsetFile, hookio.Marshal(offsets)+"\n")
		if total == 0 {
			fmt.Println("telemetry: mark set at an empty state — this run starts the record.")
		} else {
			fmt.Printf("telemetry: mark set — %d pre-existing line(s) will be excluded from this run's slice.\n", total)
		}
		return 0
	}
	slug := ""
	for _, a := range args {
		if !strings.HasPrefix(a, "-") {
			slug = a
			break
		}
	}
	if slug == "" {
		fmt.Println("telemetry: usage — spec-flow telemetry --mark | spec-flow telemetry <SLUG>")
		return 1
	}
	target := ""
	for _, c := range []string{filepath.Join(root, "specflow", "archive", slug), filepath.Join(root, "specflow", slug)} {
		if hookio.Exists(c) {
			target = c
			break
		}
	}
	if target == "" {
		fmt.Printf("telemetry: FAILED — no change folder named \"%s\" under specflow/ or specflow/archive/.\n", slug)
		return 1
	}
	offsets := map[string]float64{}
	if b, err := os.ReadFile(offsetFile); err == nil {
		if json.Unmarshal(b, &offsets) != nil {
			fmt.Println("telemetry: the mark could not be read — taking the whole log, which may include earlier runs.")
			offsets = map[string]float64{}
		}
	}
	dir := filepath.Join(target, "telemetry")
	_ = os.MkdirAll(dir, 0o755)
	var written []string
	for _, f := range telemetryLogs {
		lines := nonBlank(filepath.Join(state, f))
		from := min(int(offsets[f]), len(lines))
		slice := lines[from:]
		if len(slice) == 0 {
			continue
		}
		hookio.WriteFile(filepath.Join(dir, f), strings.Join(slice, "\n")+"\n")
		written = append(written, fmt.Sprintf("%s (%d line(s))", f, len(slice)))
	}
	if len(written) == 0 {
		fmt.Printf("telemetry: nothing to snapshot for \"%s\" — the run produced no trace.\n", slug)
		return 0
	}
	shown := strings.ReplaceAll(strings.Replace(dir, root, ".", 1), `\`, "/")
	fmt.Printf("telemetry: snapshotted into %s — %s\n", shown, strings.Join(written, ", "))
	return 0
}

// nonBlank are a file's lines that are not blank, untrimmed.
func nonBlank(path string) []string {
	text, ok := hookio.ReadText(path)
	if !ok {
		return nil
	}
	var out []string
	for _, l := range strings.Split(text, "\n") {
		if strings.TrimSpace(l) != "" {
			out = append(out, l)
		}
	}
	return out
}

var (
	fixHeading  = regexp.MustCompile(`(?m)^#\s*Fix\b`)
	statusStamp = regexp.MustCompile(`(?m)^\*\*Status:\*\*\s*([A-Z]+)`)
	milestoneMd = regexp.MustCompile(`^M(\d+)\.md$`)
	mNumber     = regexp.MustCompile(`^M\d+$`)
	resultField = regexp.MustCompile(` result=(\S+)`)
)

// Resume is `spec-flow resume [<SLUG>]`: the step an unfinished run resumes
// at, read off disk. What `/spec-flow:resume` acts on is its `NEXT:` line.
// It never fails: a state it cannot read is `NEXT: UNKNOWN`.
func Resume(args []string) (code int) {
	defer func() {
		if r := recover(); r != nil {
			if e, ok := r.(nextStep); ok {
				fmt.Printf("\nNEXT: %s\nWHY: %s\n", e.step, e.why)
				code = 0
				return
			}
			fmt.Printf("\nNEXT: UNKNOWN\nWHY: the state could not be read (%v); `spec-flow status` shows what is there.\n", r)
			code = 0
		}
	}()
	root := projectRoot()
	state := filepath.Join(root, ".claude", "state")
	specflow := filepath.Join(root, "specflow")
	asked := ""
	if len(args) > 0 {
		asked = args[0]
	}
	// What is there and cannot be read is UNKNOWN, never read as absent: a
	// file where a directory belongs is not a repository with no changes.
	read := func(p string) string {
		b, err := os.ReadFile(p)
		if err != nil && hookio.Exists(p) {
			panic(err)
		}
		return hookio.Trim(string(b))
	}
	list := func(p string) []os.DirEntry {
		entries, err := os.ReadDir(p)
		if err != nil && hookio.Exists(p) {
			panic(err)
		}
		return entries
	}
	say := func(format string, a ...any) { fmt.Printf(format+"\n", a...) }
	next := func(step, why string) { panic(nextStep{step, why}) }

	var atBase []string
	if cfg, err := contract.Load(root); err == nil {
		if base, err := gitscope.ResolveBase(root, cfg); err == nil {
			atBase = gitscope.ChangesAtBase(root, base)
		}
	}
	var live []string
	for _, e := range list(specflow) {
		if d := e.Name(); d != "archive" && !contains(atBase, d) && hookio.Exists(filepath.Join(specflow, d, "spec.md")) {
			live = append(live, d)
		}
	}
	sort.Strings(live)
	phase := read(filepath.Join(state, "phase"))
	at := strings.Fields(read(filepath.Join(state, "current-milestone")))
	atSlug, atMilestone := "", ""
	if len(at) > 0 {
		atSlug = at[0]
	}
	if len(at) > 1 {
		atMilestone = at[1]
	}

	say("spec-flow resume — where an unfinished run stands, read off disk")
	say("repo: %s\n", root)
	if len(atBase) > 0 {
		say("not runs of this branch — the base branch has them: %s", strings.Join(atBase, ", "))
	}
	if phase == "blocked" {
		next("BLOCKED", "the gate reached its attempt cap and wrote `blocked` itself; a human decides from .claude/state/gate-failure.log.")
	}
	slug := asked
	if contains(atBase, slug) {
		next("NONE", fmt.Sprintf("specflow/%s/ is on the base branch, so no run of this branch created it; a run cannot start over it (ADR-032).", slug))
	}
	if slug == "" {
		if len(live) > 1 {
			say("live changes: %s", strings.Join(live, ", "))
			next("CHOOSE", "more than one change is live in specflow/; name the one to resume.")
		}
		if len(live) == 1 {
			slug = live[0]
		}
	}
	if slug == "" && atSlug != "" && hookio.Exists(filepath.Join(specflow, "archive", atSlug, "spec.md")) && phase != "done" {
		slug = atSlug
	}
	if slug == "" {
		next("NONE", "no change is live in specflow/ and none is half-closed; there is nothing to resume.")
	}
	liveDir := filepath.Join(specflow, slug)
	archived := !hookio.Exists(filepath.Join(liveDir, "spec.md")) && hookio.Exists(filepath.Join(specflow, "archive", slug, "spec.md"))
	dir := liveDir
	if archived {
		dir = filepath.Join(specflow, "archive", slug)
	}
	if !hookio.Exists(filepath.Join(dir, "spec.md")) {
		next("NONE", fmt.Sprintf("specflow/%s/spec.md does not exist, live or archived.", slug))
	}
	spec := read(filepath.Join(dir, "spec.md"))
	fix := fixHeading.MatchString(spec)
	status := ""
	if m := statusStamp.FindStringSubmatch(spec); m != nil {
		status = m[1]
	}
	proposal, plan := hookio.Exists(filepath.Join(dir, "proposal.md")), hookio.Exists(filepath.Join(dir, "plan.md"))
	var milestones []int
	for _, e := range list(filepath.Join(dir, "milestones")) {
		if m := milestoneMd.FindStringSubmatch(e.Name()); m != nil {
			n, _ := strconv.Atoi(m[1])
			milestones = append(milestones, n)
		}
	}
	sort.Ints(milestones)
	n := len(milestones)
	head := ""
	if res := proc.Git(root, "rev-parse", "--short", "HEAD"); res.OK() {
		head = strings.TrimSpace(res.Stdout)
	}
	var onHead []string
	for _, l := range strings.Split(read(filepath.Join(state, "gate-history.log")), "\n") {
		if l = hookio.Trim(l); l != "" && shaOf(l) == head {
			onHead = append(onHead, l)
		}
	}
	verdict := ""
	if len(onHead) > 0 {
		if m := resultField.FindStringSubmatch(onHead[len(onHead)-1]); m != nil {
			verdict = m[1]
		}
	}
	var dirty []string
	if st := proc.Git(root, "status", "--porcelain"); st.Err == nil {
		for _, l := range strings.Split(st.Stdout, "\n") {
			if strings.TrimSpace(l) != "" && !stateDirRe.MatchString(l) {
				dirty = append(dirty, l)
			}
		}
	}
	started := 0
	if atSlug == slug && mNumber.MatchString(atMilestone) {
		started, _ = strconv.Atoi(atMilestone[1:])
	}
	var startedAt time.Time
	if started > 0 {
		if st, err := os.Stat(filepath.Join(state, "current-milestone")); err == nil {
			startedAt = st.ModTime()
		}
	}
	passedSince := false
	for _, l := range onHead {
		if t, ok := lineAt(l); ok && strings.Contains(l, " result=pass ") && !t.Before(startedAt) {
			passedSince = true
		}
	}

	kind, arch := "a /spec-flow change", ""
	if fix {
		kind = "a /spec-fix brief"
	}
	if archived {
		arch = ", archived"
	}
	say("change: %s — %s%s", slug, kind, arch)
	yes := func(b bool) string {
		if b {
			return "yes"
		}
		return "no"
	}
	st := ""
	if status != "" {
		st = " (Status: " + status + ")"
	}
	ms := "none"
	if n > 0 {
		parts := make([]string, n)
		for i, m := range milestones {
			parts[i] = fmt.Sprintf("M%d", m)
		}
		ms = strings.Join(parts, ", ")
	}
	say("  spec.md: yes%s · proposal.md: %s · plan.md: %s · milestones: %s", st, yes(proposal), yes(plan), ms)
	ph, inFlight := phase, "none recorded"
	if ph == "" {
		ph = "(none)"
	}
	if started > 0 {
		inFlight = fmt.Sprintf("M%d", started)
	}
	say("  phase: %s · milestone in flight: %s", ph, inFlight)
	h, v, tree := head, "not judged by the gate", "clean"
	if h == "" {
		h = "?"
	}
	if verdict != "" {
		v = "gate " + verdict
	}
	if len(dirty) > 0 {
		tree = fmt.Sprintf("dirty (%d path(s))", len(dirty))
	}
	say("  HEAD %s: %s · tree: %s", h, v, tree)

	if archived {
		s := status
		if s == "" {
			s = "none"
		}
		next("DONE", fmt.Sprintf("the fold archived specflow/%s/ (Status: %s) and the run never wrote `done`.", slug, s))
	}
	switch status {
	case "REJECTED":
		next("ARCHIVE-REJECTED", "the spec is stamped REJECTED and still live; the rejection was never archived.")
	case "SHIPPED":
		next("FOLD", "the change spec is stamped SHIPPED but was never archived; finish the fold.")
	}
	if !fix && !proposal {
		next("SPEC", "spec.md exists without proposal.md, so the spec step never finished; the requirement has to come from the human again.")
	}
	if !plan || (fix && started == 0) {
		unready := spectime.Problems(root, []string{slug}, true)
		step, why := "SIGN-OFF", "the spec is written and no plan exists: the human sign-off is the step no file records, so it is asked for again."
		if fix {
			step = "WORK-ORDER"
			why = "the triage brief is written and no work order exists yet, so a new triage writes it."
			if plan && n > 0 {
				why = "the triage wrote the brief and its work order, and no implementer was ever spawned for it; a case 3 is confirmed by the human again, since nothing on disk records it."
			}
		}
		if len(unready) > 0 {
			why += " The spec is not ready to build from, so a new spec-writer revises it first: " + strings.Join(unready, " ")
		}
		next(step, why)
	}
	if started == 0 {
		next("REVIEW", "the plan exists and no milestone was ever started; its review is not on disk, so it runs again.")
	}
	if passedSince {
		if started < n {
			next(fmt.Sprintf("IMPLEMENT M%d", started+1), fmt.Sprintf("M%d passed the gate on %s; M%d is next.", started, head, started+1))
		}
		next("FOLD", fmt.Sprintf("M%d, the last milestone, passed the gate on %s.", started, head))
	}
	why := fmt.Sprintf("M%d was in flight and has no pass on %s.", started, head)
	switch {
	case len(dirty) > 0:
		why = fmt.Sprintf("M%d was in flight and never passed; the tree holds %d uncommitted path(s) from the session that died.", started, len(dirty))
	case strings.HasPrefix(verdict, "fail"):
		why = fmt.Sprintf("M%d failed the gate on %s; .claude/state/gate-failure.log says why.", started, head)
	}
	next(fmt.Sprintf("IMPLEMENT M%d", started), why)
	return 0
}

type nextStep struct{ step, why string }

var stateDirRe = regexp.MustCompile(`\.claude[\\/]state[\\/]`)

// Models is `spec-flow models`: what each agent will actually run on, and
// which layer decided it. Its failure mode is not crashing; it is five tidy
// rows saying "plugin default" over a config it never found.
func Models(args []string) int {
	root, _ := os.Getwd()
	type layer struct {
		label    string
		settings map[string]any
	}
	var layers []layer // lowest precedence first
	for _, label := range []string{".claude/settings.json", ".claude/settings.local.json"} {
		b, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(label)))
		if err != nil {
			continue
		}
		var s map[string]any
		if json.Unmarshal(b, &s) == nil && s != nil {
			layers = append(layers, layer{label, s})
		}
	}
	type found struct{ value, source string }
	pins := map[string]found{}
	for _, l := range layers {
		env, ok := l.settings["env"].(map[string]any)
		if !ok {
			continue
		}
		for _, tier := range agents.Aliases {
			if v, ok := env["ANTHROPIC_DEFAULT_"+strings.ToUpper(tier)+"_MODEL"].(string); ok && v != "" {
				pins[tier] = found{v, l.label}
			}
		}
	}
	for _, tier := range agents.Aliases {
		if v := os.Getenv("ANTHROPIC_DEFAULT_" + strings.ToUpper(tier) + "_MODEL"); v != "" {
			pins[tier] = found{v, "the environment"}
		}
	}
	var session *found
	for _, l := range layers {
		if v, ok := l.settings["effortLevel"].(string); ok && v != "" {
			session = &found{v, l.label}
		}
	}
	var envLevel *found
	for _, l := range layers {
		if v, ok := hookio.Obj(l.settings["env"])["CLAUDE_CODE_EFFORT_LEVEL"].(string); ok && v != "" {
			envLevel = &found{v, l.label}
		}
	}
	if v := os.Getenv("CLAUDE_CODE_EFFORT_LEVEL"); v != "" {
		envLevel = &found{v, "the environment"}
	}
	valid := envLevel != nil && contains(agents.EffortLevels, strings.ToLower(envLevel.value))

	meta := agents.Shipped()
	shipped := agents.ShippedRouting()
	routing, _ := agents.ProjectRouting(root, shipped)
	if problems := canrun.SettingsProblems(root); len(problems) > 0 {
		fmt.Fprint(os.Stderr, "spec-flow models: .claude/spec-flow.config.json cannot be applied.\n\n")
		for _, p := range problems {
			fmt.Fprintf(os.Stderr, "  - %s\n", p)
		}
		fmt.Fprint(os.Stderr, "\nNo run starts until it is fixed, and a route that cannot be applied denies every spawn of a spec-flow agent.\n")
		return 1
	}
	declared := map[string]bool{}
	if b, err := os.ReadFile(agents.ProjectConfigPath(root)); err == nil {
		settings, _ := agents.ProjectConfig(string(b))
		for k := range hookio.Obj(settings["agents"]) {
			declared[strings.ToLower(k)] = true
		}
	}
	names := agents.Roles()
	if len(names) == 0 {
		fmt.Fprintln(os.Stderr, "spec-flow models: no agents found. This engine is not installed where it thinks it is.")
		return 1
	}
	type row struct{ agent, tier, effort, decided, resolves string }
	var rows []row
	for _, a := range names {
		fallback := shipped[a]
		tier := fallback
		if t, ok := routing[a]; ok {
			tier = t
		}
		decided := "plugin default"
		switch {
		case !declared[a]:
		case tier == fallback:
			decided = "project (restates the default)"
		default:
			decided = "project (was " + fallback + ")"
		}
		resolves := "unpinned"
		if p, ok := pins[tier]; ok {
			resolves = fmt.Sprintf("%s (%s)", p.value, p.source)
		}
		effort := "your session"
		switch {
		case valid:
			effort = fmt.Sprintf("%s (CLAUDE_CODE_EFFORT_LEVEL, %s)", envLevel.value, envLevel.source)
		case meta[a].Effort != "":
			effort = meta[a].Effort + " (agent)"
		case session != nil:
			effort = session.value + " (session)"
		}
		rows = append(rows, row{a, tier, effort, decided, resolves})
	}
	headings := []string{"AGENT", "TIER", "EFFORT", "TIER DECIDED BY", "TIER PINNED TO"}
	cells := func(r row) []string { return []string{r.agent, r.tier, r.effort, r.decided, r.resolves} }
	widths := make([]int, len(headings))
	for i, h := range headings {
		widths[i] = len([]rune(h))
		for _, r := range rows {
			widths[i] = max(widths[i], len([]rune(cells(r)[i])))
		}
	}
	line := func(cs []string) string {
		parts := make([]string, len(cs))
		for i, c := range cs {
			parts[i] = tracelines.PadEnd(c, widths[i])
		}
		return strings.TrimRight("  "+strings.Join(parts, "  "), " ")
	}
	fmt.Printf("spec-flow models — how each agent will be routed in %s\n\n", root)
	fmt.Println(line(headings))
	overridden := 0
	for _, r := range rows {
		fmt.Println(line(cells(r)))
		if strings.HasPrefix(r.decided, "project (was") {
			overridden++
		}
	}
	fmt.Println()
	if overridden == 0 {
		fmt.Printf("  Nothing is re-routed. To change one, add an \"agents\" block to\n  .claude/spec-flow.config.json — for example { \"agents\": { \"architect\": \"sonnet\" } }.\n  The value is a tier (%s), never a model id.\n", strings.Join(agents.Aliases, ", "))
	} else {
		fmt.Printf("  %d agent(s) re-routed by this project. A hook applies it at spawn time;\n", overridden)
		fmt.Println("  the orchestrator is not asked to, and cannot forget to.")
	}
	fmt.Print("\n  \"unpinned\" means Claude Code resolves that tier to whatever is current, which is\n" +
		"  the whole point of naming a tier. To pin one, that is Claude Code's own setting\n" +
		"  rather than this engine's: an ANTHROPIC_DEFAULT_<TIER>_MODEL entry in\n" +
		"  .claude/settings.json's \"env\" block. A tier is per agent; a pin is per session.\n\n" +
		"  EFFORT marked (agent) is declared in that agent's own frontmatter and this project\n" +
		"  cannot change it: a project override routes a tier, not an effort. The rest follow\n" +
		"  the session, which \"effortLevel\" in .claude/settings.json sets for all of them at once.\n")
	if envLevel != nil && !valid {
		fmt.Printf("\n  CLAUDE_CODE_EFFORT_LEVEL=%s (%s) is not an effort level (%s),\n  so this report does not read it as overriding the column above.\n", envLevel.value, envLevel.source, strings.Join(agents.EffortLevels, ", "))
	}
	if valid {
		fmt.Printf("\n  CLAUDE_CODE_EFFORT_LEVEL is set (%s), so every agent runs at %s:\n  it overrides each agent's own effort and the session's. Unset it to let them apply.\n", envLevel.source, envLevel.value)
	}
	return 0
}

// Keep is how many of the lines that count `lines` hands back.
const Keep = 10000

// Lines is `spec-flow lines <path> <since> <needle>`, for the live view: a
// log one read in the mod cannot take, streamed — how many lines count, then
// the last Keep of them, oldest first. A line counts when it holds needle and
// is stamped at or after since (ms); with since -Infinity, any non-blank line.
func Lines(args []string) int {
	if len(args) < 3 {
		fmt.Fprintln(os.Stderr, "spec-flow lines: usage — spec-flow lines <path> <since-ms> <needle>")
		return 1
	}
	path, needle := args[0], args[2]
	since, err := strconv.ParseFloat(args[1], 64)
	if args[1] == "-Infinity" {
		since, err = math.Inf(-1), nil
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "spec-flow lines: %q is not a number of milliseconds\n", args[1])
		return 1
	}
	f, err := os.Open(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "spec-flow lines: %v\n", err)
		return 1
	}
	defer f.Close()
	ring := make([]string, Keep)
	n := 0
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1024*1024), 64*1024*1024)
	for sc.Scan() {
		l := strings.TrimSuffix(sc.Text(), "\r")
		if Counts(l, needle, since) {
			ring[n%Keep] = l
			n++
		}
	}
	out := []string{strconv.Itoa(n)}
	if n <= Keep {
		out = append(out, ring[:n]...)
	} else {
		out = append(append(out, ring[n%Keep:]...), ring[:n%Keep]...)
	}
	fmt.Print(strings.Join(out, "\n"))
	return 0
}

// Counts is whether a log line counts for the live view — the one filter the
// mod applies to a log it reads whole, so a count does not change when a log
// crosses what one read takes. The golden table holds both to it.
func Counts(line, needle string, since float64) bool {
	if !strings.Contains(line, needle) {
		return false
	}
	if math.IsInf(since, -1) {
		return strings.TrimSpace(line) != ""
	}
	t, ok := lineAt(line)
	return ok && float64(t.UnixNano())/1e6 >= since
}
