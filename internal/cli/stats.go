package cli

import (
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/IgnacioMarin402/spec-flow-plugin/internal/contract"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/hookio"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/jsre"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/tracelines"
)

// The orchestrator schedules its post-PASS check-in about two minutes out,
// so ten is well past "slow" and into "nothing is coming".
const stallMinutes = 10

type run struct {
	name        string
	gate, trace []tracelines.Entry
	rawGate     []string
	rawTrace    []string
}

func readLines(path string) []string {
	text, ok := hookio.ReadText(path)
	if !ok {
		return nil
	}
	var out []string
	for _, l := range strings.Split(text, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			out = append(out, l)
		}
	}
	return out
}

var (
	sessionField = regexp.MustCompile(` session=(\S+)`)
	closedLine   = regexp.MustCompile(` closed tool=`)
)

func lineAt(l string) (time.Time, bool) {
	t, err := time.Parse(time.RFC3339Nano, strings.SplitN(l, " ", 2)[0])
	return t, err == nil
}

// collectRuns is one entry per run: the live one first, then every archived
// snapshot. A snapshot is a slice of the live log, so a run taken on this
// machine is in both, and counting both doubles every total with no symptom.
// The archived tier wins the tie: it carries the run's slug.
func collectRuns(root, state string) []*run {
	var archived []*run
	for _, base := range []string{filepath.Join(root, "specflow", "archive"), filepath.Join(root, "specflow")} {
		entries, err := os.ReadDir(base)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if e.Name() == "archive" {
				continue
			}
			dir := filepath.Join(base, e.Name(), "telemetry")
			if hookio.Exists(dir) {
				archived = append(archived, &run{name: e.Name(), rawGate: readLines(filepath.Join(dir, "gate-history.log")), rawTrace: readLines(filepath.Join(dir, "run-trace.log"))})
			}
		}
	}
	// Trimmed, so a snapshot committed with CRLF matches the log it came from.
	seen := map[string]bool{}
	for _, r := range archived {
		for _, l := range append(append([]string{}, r.rawGate...), r.rawTrace...) {
			seen[l] = true
		}
	}
	live := &run{name: "(current)"}
	for _, l := range readLines(filepath.Join(state, "gate-history.log")) {
		if !seen[l] {
			live.rawGate = append(live.rawGate, l)
		}
	}
	// The closing turn's tokens land after the snapshot (ADR-043): each goes
	// to the archived run whose `closed` line names its session, the latest
	// before it.
	type close struct {
		run     *run
		at      time.Time
		session string
	}
	var closes []close
	for _, r := range archived {
		for _, l := range r.rawTrace {
			if closedLine.MatchString(l) {
				at, ok := lineAt(l)
				if !ok {
					continue
				}
				s := ""
				if m := sessionField.FindStringSubmatch(l); m != nil {
					s = m[1]
				}
				closes = append(closes, close{r, at, s})
			}
		}
	}
	for _, l := range readLines(filepath.Join(state, "run-trace.log")) {
		if seen[l] {
			continue
		}
		if strings.Contains(l, " phase=done ") && strings.Contains(l, " tokens model=") {
			at, ok := lineAt(l)
			s := ""
			if m := sessionField.FindStringSubmatch(l); m != nil {
				s = m[1]
			}
			var owner *close
			for i := range closes {
				c := &closes[i]
				if ok && c.session != "" && c.session == s && !c.at.After(at) && (owner == nil || c.at.After(owner.at)) {
					owner = c
				}
			}
			if owner != nil {
				owner.run.rawTrace = append(owner.run.rawTrace, l)
				continue
			}
		}
		live.rawTrace = append(live.rawTrace, l)
	}
	var runs []*run
	for _, r := range append([]*run{live}, archived...) {
		for _, l := range r.rawGate {
			r.gate = append(r.gate, tracelines.Parse(l))
		}
		for _, l := range r.rawTrace {
			e := tracelines.Parse(l)
			if t, ok := e.Get("type"); ok {
				e.Fields["type"] = tracelines.RoleOf(t)
			}
			r.trace = append(r.trace, e)
		}
		if r.name == "(current)" || len(r.gate) > 0 || len(r.trace) > 0 {
			runs = append(runs, r)
		}
	}
	return runs
}

// outsideRun is this flow's agent put to work with no run phase (ADR-040):
// on its own it is no run, nor is the closing turn's tokens (ADR-043).
func outsideRun(e tracelines.Entry) bool {
	return strings.Contains(e.Raw, " dispatch ") && e.F("why") == "no-run"
}

func afterClose(e tracelines.Entry) bool { return outsideRun(e) || e.F("phase") == "done" }

func minutesBetween(a, b time.Time) int { return int(math.Round(b.Sub(a).Minutes())) }

// counter keeps keys in first-seen order, as a JavaScript object does.
type counter struct {
	order []string
	n     map[string]int
}

func newCounter() *counter { return &counter{n: map[string]int{}} }

func (c *counter) add(k string, by int) {
	if _, ok := c.n[k]; !ok {
		c.order = append(c.order, k)
	}
	c.n[k] += by
}

func (c *counter) join(format string) string {
	parts := make([]string, len(c.order))
	for i, k := range c.order {
		parts[i] = fmt.Sprintf(format, k, c.n[k])
	}
	return strings.Join(parts, ", ")
}

// ranked is the keys by count, highest first, ties in first-seen order.
func (c *counter) ranked() []string {
	keys := append([]string{}, c.order...)
	sort.SliceStable(keys, func(i, j int) bool { return c.n[keys[i]] > c.n[keys[j]] })
	return keys
}

func undefined(e tracelines.Entry, k string) string {
	if v, ok := e.Get(k); ok {
		return v
	}
	return "undefined"
}

var notAFailedRun = map[string]bool{"not-the-runner": true, "not-found": true, "summary-passed": true}

var (
	backslashes  = regexp.MustCompile(`\\+`)
	tokenEdges   = regexp.MustCompile("^[(`]+|[;&|)`]+$")
	dotSlashes   = regexp.MustCompile(`^(\.\.?/)+`)
	gitBashDrive = regexp.MustCompile(`^/([a-z])/`)
	redirTok     = regexp.MustCompile(`^[<>]|^\d+>`)
	globChars    = regexp.MustCompile(`[*?[\]{}]`)
	winDrive     = regexp.MustCompile(`^[a-zA-Z]:`)
	proofDirTrim = regexp.MustCompile(`^\./?|/$`)
	extOfGlob    = regexp.MustCompile(`\*(\.[^*/]+)$`)
)

// runCovers is what a run's `target=` says about test: "true" when a path in
// it names the test or a directory above it from a segment start; "false"
// only when it names other tests outright; otherwise why it cannot say. A
// MISS claims no red run happened, so nothing short of other tests named
// reads as "ran something else".
func runCovers(target, test string, proof proofLayout) string {
	windows := winDrive.MatchString(test)
	norm := func(p string) string { return strings.ToLower(backslashes.ReplaceAllString(p, "/")) }
	if target == "" {
		target = "-"
	}
	var tokens []string
	for _, t := range strings.Split(target, ",") {
		t = strings.TrimSuffix(dotSlashes.ReplaceAllString(tokenEdges.ReplaceAllString(norm(t), ""), ""), "/")
		if windows {
			t = gitBashDrive.ReplaceAllString(t, "$1:/")
		}
		if t != "" && t != "-" && t != "." && !redirTok.MatchString(t) {
			tokens = append(tokens, t)
		}
	}
	if len(tokens) == 0 {
		return "no-path"
	}
	for _, t := range tokens {
		if globChars.MatchString(t) {
			return "glob"
		}
	}
	path := "/" + norm(test)
	for _, t := range tokens {
		if strings.Contains(path, "/"+strings.TrimPrefix(t, "/")) {
			return "true"
		}
	}
	for _, t := range tokens {
		if strings.Contains(path, strings.TrimPrefix(t, "/")) {
			return "pattern"
		}
	}
	dir := proofDirTrim.ReplaceAllString(norm(proof.dir), "")
	for _, t := range tokens {
		if (proof.suffix != "" && strings.HasSuffix(t, strings.ToLower(proof.suffix))) || (dir != "" && strings.HasPrefix(t+"/", dir+"/")) {
			return "false"
		}
	}
	return "no-test-path"
}

type proofLayout struct{ suffix, dir string }

func baseOf(p string) string {
	parts := regexp.MustCompile(`[\\/]`).Split(p, -1)
	return parts[len(parts)-1]
}

func iso(t time.Time) string { return hookio.ISO(t) }

var (
	reqID       = jsre.MustCompile(`(?<![A-Z0-9])REQ-([A-Z0-9-]+)-\d{3}(?!\d)`, "")
	scopeMark   = regexp.MustCompile(`(?m)^<!--\s*spec-scope:\s*(.+?)\s*-->$`)
	filesField  = jsre.MustCompile(`(?:^|\n)[-*][ \t]*\**Files to add\/change\**[ \t]*:([\s\S]*?)(?=\n[-*][ \t]*\**[A-Z][^:\n]*\**[ \t]*:|\n#|$)`, "")
	namedPathRe = regexp.MustCompile(`[\w.@-]+(?:/[\w.@-]+)+/?`)
	h2Split     = regexp.MustCompile(`(?m)^## `)
	deltasStart = regexp.MustCompile(`^Requirement deltas`)
	archiveRead = regexp.MustCompile(`specflow[\\/]archive`)
	absOrDrive  = regexp.MustCompile(`^([a-zA-Z]:)?/`)
)

func normPath(p string) string {
	p = strings.ReplaceAll(p, `\`, "/")
	p = strings.TrimPrefix(p, "./")
	return strings.TrimRight(p, "/")
}

// Stats is `spec-flow stats`: the telemetry a run leaves, and what it says.
// It NEVER fails and gates nothing: the change policy refuses a proposal with
// no failing run attached, and what was missing was evidence, not a rule.
func Stats(args []string) int {
	root := projectRoot()
	state := filepath.Join(root, ".claude", "state")
	rawDump := contains(args, "--raw")
	var warn []string
	say := func(format string, a ...any) { fmt.Printf(format+"\n", a...) }

	phase := "(none)"
	if hookio.Exists(filepath.Join(state, "phase")) {
		phase = hookio.ReadFileOrDefault(filepath.Join(state, "phase"), "")
	}
	say("spec-flow stats — report only, nothing here gates anything")
	say("current phase: %s\n", phase)

	// ---- 1. the gate, and whether a PASS stranded the run ----------------------
	runs := collectRuns(root, state)
	current := runs[0]
	var gate []tracelines.Entry
	for _, r := range runs {
		gate = append(gate, r.gate...)
	}
	activity := func(r *run) []time.Time {
		var ts []time.Time
		for _, e := range append(append([]tracelines.Entry{}, r.gate...), r.trace...) {
			if e.At != nil {
				ts = append(ts, *e.At)
			}
		}
		return ts
	}
	say("Gate")
	if len(gate) == 0 {
		say("  no gate history yet — run /spec-flow at least once.")
	} else {
		tally := newCounter()
		for _, g := range gate {
			tally.add(undefined(g, "result"), 1)
		}
		withData := 0
		for _, r := range runs {
			has := len(r.gate) > 0
			for _, e := range r.trace {
				if !afterClose(e) {
					has = true
				}
			}
			if has {
				withData++
			}
		}
		scope := ""
		if withData > 1 {
			scope = fmt.Sprintf(" across %d run(s)", withData)
		}
		say("  %d invocation(s)%s: %s", len(gate), scope, tally.join("%[2]d %[1]s"))
		// A PASS with no failure since the previous PASS: a stretch between two
		// passes stands in for a milestone. Every failing outcome counts —
		// the gate writes `fail:<class>`.
		passes, firstTime := 0, 0
		for _, r := range runs {
			failed := false
			for _, g := range r.gate {
				if strings.HasPrefix(g.F("result"), "fail") {
					failed = true
				}
				if g.F("result") != "pass" {
					continue
				}
				passes++
				if !failed {
					firstTime++
				}
				failed = false
			}
		}
		if passes > 0 {
			say("  passed the first time: %d of %d PASS(es) had no failure since the previous one", firstTime, passes)
		}
		// A stalled run is a PASS followed by nothing, in EITHER log.
		var worst *struct {
			gap  int
			at   time.Time
			name string
		}
		for _, r := range runs {
			times := activity(r)
			sort.SliceStable(times, func(i, j int) bool { return times[i].Before(times[j]) })
			for _, g := range r.gate {
				if g.F("result") != "pass" || g.At == nil {
					continue
				}
				for _, t := range times {
					if t.After(*g.At) {
						gap := minutesBetween(*g.At, t)
						if worst == nil || gap > worst.gap {
							worst = &struct {
								gap  int
								at   time.Time
								name string
							}{gap, *g.At, r.name}
						}
						break
					}
				}
			}
		}
		if worst != nil {
			where := ""
			if len(runs) > 1 {
				where = " in " + worst.name
			}
			say("  longest quiet after a PASS: %dm%s (%s)", worst.gap, where, iso(worst.at))
			if worst.gap >= stallMinutes {
				warn = append(warn, fmt.Sprintf("a PASS was followed by %dm with nothing running%s — the run had to be nudged.", worst.gap, where))
			}
		}
		if n := len(current.gate); n > 0 {
			last := current.gate[n-1]
			if last.F("result") == "pass" && phase == "implement" && last.At != nil {
				latest := *last.At
				for _, t := range activity(current) {
					if t.After(latest) {
						latest = t
					}
				}
				idle := minutesBetween(latest, time.Now())
				say("  last gate line is a PASS, phase still `implement`, %dm since anything ran", idle)
				if idle >= stallMinutes {
					warn = append(warn, fmt.Sprintf("the run looks stalled RIGHT NOW: %dm with nothing running since a PASS, phase still armed. Nothing re-wakes the orchestrator on a pass.", idle))
				}
			}
		}
	}
	say("")

	// ---- 2. test-first, by its observable signature ----------------------------
	// The pairing reads the contract — proof_suffix and the source extensions
	// — and pairs on BASENAME: a test need not sit beside its source. An
	// unreadable contract makes it UNKNOWN, said out loud, not an absence.
	var trace []tracelines.Entry
	for _, r := range runs {
		trace = append(trace, r.trace...)
	}
	var expectedTestName func(string) string
	pairingProblem := ""
	proof := proofLayout{}
	if cfg, err := contract.Load(root); err == nil {
		suffix := cfg.Trace.ProofSuffix
		proof = proofLayout{suffix, cfg.Trace.ProofDir}
		var exts []string
		for _, g := range cfg.Verify.ScopeGlobs {
			ext := strings.TrimPrefix(g, "*")
			if m := extOfGlob.FindStringSubmatch(g); m != nil {
				ext = m[1] // `lib/*.ts` names `.ts` as `*.ts` does
			}
			if strings.HasPrefix(ext, ".") && !contains(exts, ext) {
				exts = append(exts, ext)
			}
		}
		if suffix == "" || len(exts) == 0 {
			pairingProblem = "the contract names no proof_suffix or no source extension, so a source file cannot be paired to its test"
		} else {
			expectedTestName = func(file string) string {
				name := baseOf(file)
				if strings.HasSuffix(name, suffix) {
					return "" // this IS a test file
				}
				for _, e := range exts {
					if strings.HasSuffix(name, e) {
						return name[:len(name)-len(e)] + suffix
					}
				}
				return ""
			}
		}
	} else {
		pairingProblem = fmt.Sprintf("the contract could not be read (%s)", strings.SplitN(err.Error(), "\n", 2)[0])
	}

	type verdict struct{ file, status, why, run string }
	var verdicts []verdict
	if expectedTestName != nil {
		for _, r := range runs {
			var order []string
			firstWrite := map[string]int{}
			for i, e := range r.trace {
				if e.F("file") == "" || !strings.Contains(e.Raw, " write file=") {
					continue // a READ says nothing about when a file was written
				}
				if _, ok := firstWrite[e.F("file")]; !ok {
					firstWrite[e.F("file")] = i
					order = append(order, e.F("file"))
				}
			}
			type written struct {
				file string
				at   int
			}
			testsByName := map[string][]written{}
			for _, f := range order {
				testsByName[baseOf(f)] = append(testsByName[baseOf(f)], written{f, firstWrite[f]})
			}
			for _, file := range order {
				sourceIdx := firstWrite[file]
				testName := expectedTestName(file)
				if testName == "" {
					continue
				}
				tests, ok := testsByName[testName]
				if !ok {
					continue
				}
				specIdx := tests[0].at
				for _, t := range tests {
					if t.at < specIdx {
						specIdx = t.at
					}
				}
				// Only a run of this test speaks for it.
				coversAt := func(target string, at int) string {
					reason := ""
					for _, t := range tests {
						if t.at >= at {
							continue
						}
						a := runCovers(target, t.file, proof)
						if a == "true" {
							return "true"
						}
						if a != "false" && reason == "" {
							reason = a
						}
					}
					if reason != "" {
						return reason
					}
					return "false"
				}
				type run struct {
					e      tracelines.Entry
					covers string
				}
				var between []run
				for i, e := range r.trace {
					if i > specIdx && i < sourceIdx && e.F("verdict") != "" {
						if cov := coversAt(e.F("target"), i); cov != "false" {
							between = append(between, run{e, cov})
						}
					}
				}
				var unjudged []run
				red := false
				for _, b := range between {
					v := b.e.F("verdict")
					why, hasWhy := b.e.Get("why")
					if (v == "?" && !(hasWhy && notAFailedRun[why])) || (v == "red" && b.covers != "true") {
						unjudged = append(unjudged, b)
					}
					if v == "red" && b.covers == "true" {
						red = true
					}
				}
				status := "no-red-run"
				switch {
				case specIdx > sourceIdx:
					status = "code-first"
				case red:
					status = "red-first"
				case len(unjudged) > 0:
					status = "no-verdict"
				}
				var whys []string
				for _, u := range unjudged {
					w := u.covers
					if u.e.F("verdict") != "red" {
						w = "not-recorded"
						if v, ok := u.e.Get("why"); ok {
							w = v
						}
					}
					if !contains(whys, w) {
						whys = append(whys, w)
					}
				}
				verdicts = append(verdicts, verdict{file, status, strings.Join(whys, ","), r.name})
			}
		}
	}
	say("Test-first")
	switch {
	case expectedTestName == nil:
		say("  UNKNOWN — %s.", pairingProblem)
		say(`  This is not "no misses found": nothing was measured. Fix the contract to get an answer.`)
	case len(trace) == 0:
		say("  no run trace yet — run-trace writes it during a live run.")
	case len(verdicts) == 0:
		say("  no source file was written alongside its own test in this trace.")
	default:
		across := map[string]bool{}
		missed, unjudged := 0, 0
		for _, v := range verdicts {
			mark := map[string]string{"red-first": "OK  ", "no-verdict": "?   "}[v.status]
			if mark == "" {
				mark = "MISS"
			}
			where := ""
			if len(runs) > 1 {
				where = "  [" + v.run + "]"
			}
			what := v.status
			if v.status == "no-verdict" {
				what = "a test run the trace could not judge: " + v.why
			}
			say("  %s %s  (%s)%s", mark, v.file, what, where)
			across[v.run] = true
			if v.status == "code-first" || v.status == "no-red-run" {
				missed++
			}
			if v.status == "no-verdict" {
				unjudged++
			}
		}
		scope := ""
		if len(across) > 1 {
			scope = fmt.Sprintf(" across %d runs", len(across))
		}
		if missed > 0 {
			warn = append(warn, fmt.Sprintf("%d of %d source file(s)%s show no red test run before the code. A test written after the implementation mirrors it and passes on day one.", missed, len(verdicts), scope))
		}
		if unjudged > 0 {
			warn = append(warn, fmt.Sprintf("%d of %d source file(s)%s had their test run before the code, with a verdict the trace could not read (why= in run-trace.log) — unmeasured, not missed.", unjudged, len(verdicts), scope))
		}
	}
	say("")

	// ---- 3. the reviewer, and whether it reviews -------------------------------
	var agentLines []tracelines.Entry
	for _, e := range trace {
		if e.F("type") != "" && e.F("status") != "" {
			agentLines = append(agentLines, e)
		}
	}
	say("Agents")
	if len(agentLines) == 0 {
		say("  no subagent outcomes recorded yet.")
	} else {
		var types []string
		byAgent := map[string]*counter{}
		for _, a := range agentLines {
			t := a.F("type")
			if _, ok := byAgent[t]; !ok {
				byAgent[t] = newCounter()
				types = append(types, t)
			}
			byAgent[t].add(a.F("status"), 1)
		}
		for _, t := range types {
			say("  %s: %s", t, byAgent[t].join("%[2]d %[1]s"))
		}
		if rv, ok := byAgent["reviewer"]; ok {
			total := 0
			for _, n := range rv.n {
				total += n
			}
			if total >= 3 && rv.n["APPROVED"] == total {
				warn = append(warn, fmt.Sprintf("the reviewer approved all %d plan(s) it saw, never escalating. Either the planner is that good or the step is a rubber-stamp — worth deciding once the sample is big enough.", total))
			}
		}
	}
	// A return the agent gate sent back is counted under the status it was
	// sent back with; these lines say how often that happens (ADR-031).
	var checks []tracelines.Entry
	for _, e := range trace {
		if strings.Contains(e.Raw, " agent-check ") {
			checks = append(checks, e)
		}
	}
	if len(checks) > 0 {
		tally := func(result string) (int, string) {
			c := newCounter()
			n := 0
			for _, e := range checks {
				if e.F("result") == result {
					c.add(undefined(e, "why"), 1)
					n++
				}
			}
			return n, c.join("%s x%d")
		}
		sent, sentT := tally("block")
		capped, cappedT := tally("cap")
		skipped, skippedT := tally("skip")
		out := fmt.Sprintf("  agent gate: %d return(s) sent back", sent)
		if sent > 0 {
			out += " (" + sentT + ")"
		}
		out += fmt.Sprintf(", %d let through at the cap", capped)
		if capped > 0 {
			out += " (" + cappedT + ")"
		}
		if skipped > 0 {
			out += fmt.Sprintf(", %d not fully judged (%s)", skipped, skippedT)
		}
		say("%s.", out)
	}
	// What the orchestrator dispatched that the commands do not describe (ADR-035).
	var dispatched []tracelines.Entry
	for _, e := range trace {
		if strings.Contains(e.Raw, " dispatch ") {
			dispatched = append(dispatched, e)
		}
	}
	if len(dispatched) > 0 {
		tallyOf := func(list []tracelines.Entry) string {
			c := newCounter()
			for _, e := range list {
				for _, why := range strings.Split(undefined(e, "why"), ",") {
					c.add(undefined(e, "agent")+":"+why, 1)
				}
			}
			return c.join("%s x%d")
		}
		var recorded, armed, denied, outside []tracelines.Entry
		for _, e := range dispatched {
			switch e.F("result") {
			case "record":
				if outsideRun(e) {
					outside = append(outside, e)
				} else {
					recorded = append(recorded, e)
				}
			case "armed":
				armed = append(armed, e)
			case "deny":
				denied = append(denied, e)
			}
		}
		out := fmt.Sprintf("  dispatch: %d off the commands' contract", len(recorded))
		if len(recorded) > 0 {
			out += " (" + tallyOf(recorded) + ")"
		}
		out += fmt.Sprintf(", recorded, not denied; the gate armed by arm-gate %d time(s)", len(armed))
		if len(denied) > 0 {
			out += fmt.Sprintf(", the implementer denied %d time(s) (%s)", len(denied), tallyOf(denied))
		}
		say("%s.", out)
		if len(outside) > 0 {
			say("  outside a run: %d of this flow's agent(s) put to work (%s), with no budget, trace or agent gate.", len(outside), tallyOf(outside))
		}
		if len(recorded) > 0 {
			warn = append(warn, fmt.Sprintf("%d dispatch(es) the commands do not describe (%s). Each went through; read the `dispatch` lines with --raw before a rule becomes a denial (ADR-035).", len(recorded), tallyOf(recorded)))
		}
		// Step 0 writes the phase before either is spawned.
		var unarmed []tracelines.Entry
		for _, e := range outside {
			if a := e.F("agent"); a == "spec-writer" || a == "planner" {
				unarmed = append(unarmed, e)
			}
		}
		if len(unarmed) > 0 {
			warn = append(warn, fmt.Sprintf("%d spec-writer or planner spawn(s) with no run phase (%s): no budget, trace or agent gate applied to them. A run that skipped writing `spec`, or whose phase was reset under it, looks like this (ADR-040).", len(unarmed), tallyOf(unarmed)))
		}
	}
	say("")

	// ---- 3b. does the plan's skill routing actually land? ----------------------
	misses := newCounter()
	nMisses := 0
	for _, e := range trace {
		if v := e.F("skill_miss"); v != "" {
			for _, m := range strings.Split(v, ",") {
				misses.add(m, 1)
				nMisses++
			}
		}
	}
	say("Skill routing")
	switch {
	case len(agentLines) == 0:
		say("  no subagent outcomes recorded yet.")
	case nMisses == 0:
		say("  no misses reported across %d subagent return(s).", len(agentLines))
	default:
		ranked := misses.ranked()
		parts := make([]string, len(ranked))
		for i, m := range ranked {
			parts[i] = fmt.Sprintf("%s x%d", m, misses.n[m])
		}
		say("  %d miss(es): %s", nMisses, strings.Join(parts, ", "))
		if top := ranked[0]; misses.n[top] >= 3 {
			warn = append(warn, fmt.Sprintf(`"%s" was needed but not routed %d times. A skill the planner keeps missing usually has a description that does not match the decision it actually applies to — the description is what the planner routes on.`, top, misses.n[top]))
		}
	}
	say("")

	// ---- 4. what the run READ, against the change's scope -----------------------
	// The scope is derived, never guessed: a change whose spec and milestones
	// name nothing readable reports UNKNOWN rather than zero (ADR-026).
	var reads []tracelines.Entry
	for _, e := range trace {
		if strings.Contains(e.Raw, " read file=") {
			reads = append(reads, e)
		}
	}
	rootNorm := normPath(root)
	say("Reads")
	if len(reads) == 0 {
		say("  no reads recorded — run-trace logs these only during a live run.")
	} else {
		byPhase := newCounter()
		for _, r := range reads {
			p := r.F("phase")
			if _, ok := r.Get("phase"); !ok {
				p = "?"
			}
			byPhase.add(p, 1)
		}
		say("  %d file read(s): %s", len(reads), byPhase.join("%[2]d in %[1]s"))
		archiveReads, inPlan := 0, 0
		for _, r := range reads {
			if archiveRead.MatchString(r.Raw) {
				archiveReads++
				if r.F("phase") == "plan" {
					inPlan++
				}
			}
		}
		if archiveReads > 0 {
			while := ""
			if inPlan > 0 {
				while = fmt.Sprintf(" (%d while planning)", inPlan)
			}
			say("  %d of them under specflow/archive/%s", archiveReads, while)
			if inPlan > 0 {
				warn = append(warn, fmt.Sprintf("%d archived change spec(s) were read during the plan phase. The planner's contract keeps the archive out of a plan (ADR-026): a past change describes one problem's shape, and what generalised from past runs is in the contracts. Worth reading the plan for what it took from there.", inPlan))
			}
		}
		specsDir, proofDir := "specs", ""
		if cfg, err := contract.Load(root); err == nil {
			specsDir, proofDir = cfg.Trace.SpecsDir, cfg.Trace.ProofDir
		}
		var alwaysIn []string
		for _, d := range []string{specsDir, proofDir, "specflow", ".spec-flow", ".claude", "CLAUDE.md"} {
			if d != "" {
				alwaysIn = append(alwaysIn, normPath(d))
			}
		}
		for _, r := range runs {
			var runReads []tracelines.Entry
			for _, e := range r.trace {
				if strings.Contains(e.Raw, " read file=") && e.F("file") != "" {
					runReads = append(runReads, e)
				}
			}
			if len(runReads) == 0 {
				continue
			}
			label := ""
			if len(runs) > 1 {
				label = r.name + ": "
			}
			dir := changeDir(root, r.name)
			var dirs, from []string
			if dir != "" {
				dirs, from = changeScope(root, dir, specsDir)
			}
			if len(dirs) == 0 {
				why := "no change folder under specflow/ names this run"
				if dir != "" {
					why = "its spec names no scoped capability and its milestones name no path"
				}
				say("  %sscope UNKNOWN — %s, so nothing here says which reads were outside it.", label, why)
				continue
			}
			say("  %sscope %s (from %s)", label, strings.Join(dirs, ", "), strings.Join(from, ", "))
			scopeDirs := append(append([]string{}, alwaysIn...), dirs...)
			inScope := func(rel string) bool {
				for _, d := range scopeDirs {
					if rel == d || strings.HasPrefix(rel, d+"/") {
						return true
					}
				}
				return false
			}
			recorded := recordedRoot(r)
			var phases []string
			for _, e := range runReads {
				p := e.F("phase")
				if _, ok := e.Get("phase"); !ok {
					p = "?"
				}
				if !contains(phases, p) {
					phases = append(phases, p)
				}
			}
			for _, ph := range phases {
				outside := newCounter()
				inside, total := 0, 0
				for _, e := range runReads {
					p := e.F("phase")
					if _, ok := e.Get("phase"); !ok {
						p = "?"
					}
					if p != ph {
						continue
					}
					total++
					rel, ok := insideRepo(e.F("file"), rootNorm, recorded)
					if ok && inScope(rel) {
						inside++
						continue
					}
					// Two segments deep — the module, in most layouts.
					key := "(outside the repository)"
					if ok {
						segs := strings.Split(rel, "/")
						key = strings.Join(segs[:min(2, len(segs))], "/")
					}
					outside.add(key, 1)
				}
				ranked := outside.ranked()
				where := ""
				if len(ranked) > 0 {
					parts := make([]string, 0, 5)
					for _, d := range ranked[:min(5, len(ranked))] {
						parts = append(parts, fmt.Sprintf("%s x%d", d, outside.n[d]))
					}
					where = " — " + strings.Join(parts, ", ")
				}
				out := total - inside
				say("    %s: %d read(s), %d outside the scope%s", ph, total, out, where)
				if ph == "plan" && out > inside {
					in := ""
					if len(runs) > 1 {
						in = "in " + r.name + " "
					}
					warn = append(warn, fmt.Sprintf("%sthe planner read more outside the change's scope (%d) than inside it (%d)%s. That is a planner learning how this repo builds a module from its source. A repo that states its anatomy — a skill, or a CLAUDE.md section — is what makes those reads unnecessary, and the planner's contract sends it there first (ADR-026).", in, out, inside, where))
				}
			}
		}
	}
	say("")

	// ---- 5. session reuse --------------------------------------------------------
	// A milestone is what happened between two gate PASSes. A fresh session
	// re-reads what the previous one already had (ADR-025). Two proxies, said so.
	readerOf := func(e tracelines.Entry) string {
		if id := e.F("agent_id"); id != "" {
			return "agent:" + id
		}
		return e.F("session")
	}
	type segment struct {
		closed bool
		events []tracelines.Entry
		run    string
		index  int
	}
	var segments []segment
	for _, r := range runs {
		var passes []*time.Time
		for _, g := range r.gate {
			if g.F("result") == "pass" && g.At != nil {
				passes = append(passes, g.At)
			}
		}
		var events []tracelines.Entry
		for _, e := range r.trace {
			if e.At != nil && !afterClose(e) {
				events = append(events, e)
			}
		}
		sort.SliceStable(events, func(i, j int) bool { return events[i].At.Before(*events[j].At) })
		var start *time.Time
		idx := 0
		for _, end := range append(passes, nil) {
			var in []tracelines.Entry
			for _, e := range events {
				if (start == nil || e.At.After(*start)) && (end == nil || !e.At.After(*end)) {
					in = append(in, e)
				}
			}
			if len(in) > 0 {
				idx++
				segments = append(segments, segment{end != nil, in, r.name, idx})
			}
			start = end
		}
	}
	say("Session reuse")
	if len(segments) == 0 {
		say("  no run trace yet — run-trace writes it during a live run.")
	} else {
		reread, coldT := newCounter(), newCounter()
		for _, s := range segments {
			implementers := 0
			for _, e := range s.events {
				if e.F("type") == "implementer" && e.F("status") != "" {
					implementers++
				}
			}
			type seenFile struct {
				n        int
				sessions map[string]bool
			}
			var files []string
			seen := map[string]*seenFile{}
			for _, e := range s.events {
				if !strings.Contains(e.Raw, " read file=") || e.F("file") == "" {
					continue
				}
				f := e.F("file")
				if _, ok := seen[f]; !ok {
					seen[f] = &seenFile{sessions: map[string]bool{}}
					files = append(files, f)
				}
				seen[f].n++
				if r := readerOf(e); r != "" {
					seen[f].sessions[r] = true
				}
			}
			repeated, extra, cold := 0, 0, 0
			for _, f := range files {
				v := seen[f]
				if v.n <= 1 {
					continue
				}
				repeated++
				extra += v.n - 1
				reread.add(f, v.n-1)
				if len(v.sessions) > 1 {
					cold++
					coldT.add(f, 1)
				}
			}
			where, open, across := "", "", ""
			if len(runs) > 1 {
				where = "[" + s.run + "] "
			}
			if !s.closed {
				open = " (never reached a PASS)"
			}
			if cold > 0 {
				across = fmt.Sprintf(", %d across sessions", cold)
			}
			readsText := "no file read twice"
			if repeated > 0 {
				readsText = fmt.Sprintf("%d file(s) re-read, %d extra read(s)%s", repeated, extra, across)
			}
			say("  %smilestone %d%s: %d implementer session(s), %s", where, s.index, open, implementers, readsText)
			if implementers > 1 {
				of := ""
				if len(runs) > 1 {
					of = " of " + s.run
				}
				warn = append(warn, fmt.Sprintf("milestone %d%s spawned the implementer %d times. The flow returns to one implementer per milestone while its cache is warm; a new one is right only after the previous went cold — a human's answer, a long gate (ADR-025). Any other re-spawn re-read the plan and every touched file into a cold context, which is most of what a run costs.", s.index, of, implementers))
			}
		}
		if ranked := reread.ranked(); len(ranked) > 0 {
			parts := []string{}
			for _, f := range ranked[:min(5, len(ranked))] {
				parts = append(parts, fmt.Sprintf("%s +%d", baseOf(f), reread.n[f]))
			}
			say("  most re-read: %s", strings.Join(parts, ", "))
		}
		if ranked := coldT.ranked(); len(ranked) > 0 {
			parts := []string{}
			for _, f := range ranked[:min(5, len(ranked))] {
				parts = append(parts, fmt.Sprintf("%s x%d", baseOf(f), coldT.n[f]))
			}
			say("  re-read across sessions: %s", strings.Join(parts, ", "))
			warn = append(warn, fmt.Sprintf("%d file(s) were read by more than one session inside a single milestone. That is the only re-read a cache could remove — a repeat within one session is context the model already had.", len(coldT.order)))
		}
		// Whether the split measured anything, said out loud: "0 across
		// sessions" over a trace with no session id answers nothing.
		attributed := 0
		ids := map[string]bool{}
		for _, r := range reads {
			if id := readerOf(r); id != "" {
				attributed++
				ids[id] = true
			}
		}
		spawned := len(agentLines)
		switch {
		case len(reads) == 0:
		case attributed == 0:
			say(`  attribution: UNAVAILABLE — no read carries an agent or session id, so "across sessions" above measured nothing.`)
			say("  Either this trace predates the field or the payloads name no session.")
		case len(ids) == 1 && spawned > 1:
			say("  attribution: ONE session id across %d subagent spawn(s) — reads are landing under the spawner.", spawned)
			warn = append(warn, fmt.Sprintf("every read in this trace carries the same session id while %d subagent(s) were spawned. A subagent's reads are being attributed to whoever spawned it, so the across-session split cannot see a fresh session's cold start — treat those numbers as unmeasured, not as zero.", spawned))
		default:
			say("  attribution: %d/%d read(s) carry an agent or session id, across %d session(s).", attributed, len(reads), len(ids))
		}
		say("  Both numbers are proxies: the trace carries no milestone id, so a milestone here is")
		say("  whatever happened between two gate PASSes.")
	}
	say("")

	// ---- 6. what the run cost, in the unit the budget does not charge ----------
	var tokenLines []tracelines.Entry
	for _, e := range trace {
		if _, ok := e.Get("msgs"); ok && e.F("model") != "" {
			tokenLines = append(tokenLines, e)
		}
	}
	say("Tokens")
	if len(tokenLines) == 0 {
		say("  no token accounting recorded yet — token-trace writes it at each stop, from")
		say("  the transcript Claude Code already keeps. A trace older than that hook has none.")
	} else {
		rows := tracelines.SummarizeTokens(tokenLines)
		width := 0
		for _, r := range rows {
			width = max(width, len(r.Model))
		}
		for _, r := range rows {
			say("  %s", tracelines.TokenRow(r, width))
		}
		total := func(field string, keep func(tracelines.Row) bool) float64 {
			sum := 0.0
			for _, r := range rows {
				if keep == nil || keep(r) {
					sum += r.N[field]
				}
			}
			return sum
		}
		say("  total: in %s, out %s, cache_read %s, cache_write %s", tracelines.Human(total("in", nil)), tracelines.AtLeast(total("out", nil)), tracelines.Human(total("cache_read", nil)), tracelines.Human(total("cache_write", nil)))
		say("  out and think are floors (≥): some messages never get their final count written.")
		subagentOut := total("out", func(r tracelines.Row) bool { return r.Chain == "subagent" })
		spawns := len(agentLines)
		attributed := false
		for _, e := range tokenLines {
			if e.F("agent_id") != "" {
				attributed = true
			}
		}
		switch {
		case attributed:
			byRoleRuns(runs, say)
		case subagentOut > 0 && spawns > 0:
			say("  subagent output: %s across %d recorded spawn(s) — %s/spawn on average.", tracelines.AtLeast(subagentOut), spawns, tracelines.AtLeast(math.Round(subagentOut/float64(spawns))))
			say("  That average is the unit the escalation caps do not charge; it says nothing about which agent.")
		case subagentOut == 0 && spawns > 0:
			say("  %d spawn(s) recorded and no subagent tokens with them.", spawns)
			warn = append(warn, fmt.Sprintf("%d subagent spawn(s) are in this trace and no token line is marked sidechain. Either the spawns predate token-trace reading subagent transcripts, or this build keeps them somewhere other than <session>/subagents/ — treat the per-spawn cost as unmeasured, not as zero.", spawns))
		}
	}
	say("")

	for _, n := range [][2]string{
		{"run-trace-unmatched.log", "subagent returns with no STATUS line"},
		{"opus-budget-unmatched.log", "SendMessage payloads the budget could not attribute"},
		{"register-agent-unmatched.log", "Opus spawns whose session id was not found"},
		{"token-trace-unmatched.log", "stops whose token usage could not be read — a cost of zero here is not a cheap run"},
		{"orchestrator-scope-unmatched.log", "session calls orchestrator-scope let through because the trace showed no agent_id — it was not armed"},
		{"human-turn-unmatched.log", "case 3 checks that stood down because no answer was ever recorded — a case 3 went on unconfirmed"},
	} {
		if c := len(readLines(filepath.Join(state, n[0]))); c > 0 {
			say("note: %d %s — see .claude/state/%s", c, n[1], n[0])
		}
	}
	if len(warn) > 0 {
		say("\nWhat this run is telling you:")
		for _, w := range warn {
			say("  - %s", w)
		}
		say("\nThese are observations, not a verdict. The flow changes on a failing run,\nand one line of telemetry is not one yet — but it is how you get there.")
	}
	if rawDump {
		for _, r := range runs {
			if len(r.gate) == 0 && len(r.trace) == 0 {
				continue
			}
			say("\n=== %s ===", r.name)
			if len(r.gate) > 0 {
				say("--- gate-history.log ---")
				for _, g := range r.gate {
					say("  %s", g.Raw)
				}
			}
			if len(r.trace) > 0 {
				say("--- run-trace.log ---")
				for _, t := range r.trace {
					say("  %s", t.Raw)
				}
			}
		}
	}
	return 0
}

// byRoleRuns: who spent it, per run — the orchestrator by model, then each
// role joined by agent_id to its return line. A sidechain line naming no
// agent is `unattributed`, never guessed. An advisor is charged to whoever
// consulted it.
func byRoleRuns(runs []*run, say func(string, ...any)) {
	for _, r := range runs {
		var lines []tracelines.Entry
		for _, e := range r.trace {
			if _, ok := e.Get("msgs"); ok && e.F("model") != "" {
				lines = append(lines, e)
			}
		}
		if len(lines) == 0 {
			continue
		}
		returned := map[string]tracelines.Entry{}
		for _, e := range r.trace {
			if e.F("type") != "" && e.F("agent_id") != "" {
				returned[e.F("agent_id")] = e
			}
		}
		type row struct {
			role, model                                 string
			agents, efforts                             []string
			in, out, cacheRead, cacheWrite, m5, h1, msg float64
			split                                       bool
			maxPrompt                                   float64
		}
		var order []string
		rows := map[string]*row{}
		n := func(e tracelines.Entry, k string) float64 { return numField(e.F(k)) }
		for _, e := range lines {
			back, hasBack := returned[e.F("agent_id")]
			caller := "orchestrator"
			if e.F("sidechain") == "true" {
				caller = "unattributed"
				if hasBack {
					caller = back.F("type")
				}
			}
			role := caller
			if e.F("advisor") == "true" {
				role = "advisor ← " + caller
			}
			key := role + "|" + e.F("model")
			rw, ok := rows[key]
			if !ok {
				rw = &row{role: role, model: e.F("model"), split: true}
				rows[key] = rw
				order = append(order, key)
			}
			if id := e.F("agent_id"); id != "" && !contains(rw.agents, id) {
				rw.agents = append(rw.agents, id)
			}
			// The effort on the return line is the consulting agent's.
			if hasBack && back.F("effort") != "" && e.F("advisor") != "true" && !contains(rw.efforts, back.F("effort")) {
				rw.efforts = append(rw.efforts, back.F("effort"))
			}
			rw.in += n(e, "in")
			rw.out += n(e, "out")
			rw.cacheRead += n(e, "cache_read")
			rw.cacheWrite += n(e, "cache_write")
			_, has5 := e.Get("cache_write_5m")
			_, has1 := e.Get("cache_write_1h")
			if has5 && has1 {
				rw.m5 += n(e, "cache_write_5m")
				rw.h1 += n(e, "cache_write_1h")
			} else if n(e, "cache_write") > 0 {
				rw.split = false
			}
			rw.msg += n(e, "msgs")
			rw.maxPrompt = math.Max(rw.maxPrompt, n(e, "max_prompt"))
		}
		label := ""
		if len(runs) > 1 {
			label = " [" + r.name + "]"
		}
		say("  by role%s:", label)
		sorted := make([]*row, 0, len(order))
		for _, k := range order {
			sorted = append(sorted, rows[k])
		}
		sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].out > sorted[j].out })
		for _, rw := range sorted {
			who := rw.role
			if len(rw.agents) > 0 {
				eff := ""
				if len(rw.efforts) > 0 {
					eff = ", effort " + strings.Join(rw.efforts, "/")
				}
				who = fmt.Sprintf("%s (%d agent(s)%s)", rw.role, len(rw.agents), eff)
			}
			// A role's cost is its message count times its average prompt (ADR-033).
			perMessage := ""
			if rw.msg > 0 {
				perMessage = fmt.Sprintf("  %s msg, ~%s prompt/msg", tracelines.JSNum(rw.msg), tracelines.Human(math.Round((rw.in+rw.cacheRead+rw.cacheWrite)/rw.msg)))
			}
			ttl := ""
			if rw.split && rw.cacheWrite > 0 {
				ttl = fmt.Sprintf(" (5m %s, 1h %s)", tracelines.Human(rw.m5), tracelines.Human(rw.h1))
			}
			say("    %s  %s  in %s  out %s  cache_read %s  cache_write %s%s  largest prompt %s%s", who, rw.model, tracelines.Human(rw.in), tracelines.AtLeast(rw.out), tracelines.Human(rw.cacheRead), tracelines.Human(rw.cacheWrite), ttl, tracelines.Human(rw.maxPrompt), perMessage)
		}
	}
}

func numField(s string) float64 {
	var f float64
	if _, err := fmt.Sscan(s, &f); err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
		return 0
	}
	return f
}

// recordedRoot is the root an archived run's absolute paths were recorded
// under: the part in front of `specflow/[archive/]<slug>/`.
func recordedRoot(r *run) string {
	if r.name == "(current)" {
		return ""
	}
	own := regexp.MustCompile(`^(([a-zA-Z]:)?/.*)/specflow/(archive/)?` + regexp.QuoteMeta(r.name) + `/`)
	for _, e := range r.trace {
		if f := e.F("file"); f != "" {
			if m := own.FindStringSubmatch(normPath(f)); m != nil {
				return m[1]
			}
		}
	}
	return ""
}

// insideRepo is a read's path relative to this repository, or to the root
// recorded names; ok=false when it points outside. Case-blind where the
// filesystem is.
func insideRepo(file, rootNorm, recorded string) (string, bool) {
	p := normPath(file)
	for _, b := range []struct {
		base      string
		caseBlind bool
	}{{rootNorm, runtime.GOOS == "windows"}, {recorded, winDrive.MatchString(recorded)}} {
		if b.base == "" {
			continue
		}
		under := strings.HasPrefix(p, b.base+"/")
		if b.caseBlind {
			under = strings.HasPrefix(strings.ToLower(p), strings.ToLower(b.base)+"/")
		}
		if under {
			return p[len(b.base)+1:], true
		}
	}
	if absOrDrive.MatchString(p) {
		return "", false
	}
	return p, true
}

// changeDir is the change folder a run's artifacts live in, or `""`.
func changeDir(root, name string) string {
	if name != "(current)" {
		for _, d := range []string{filepath.Join(root, "specflow", "archive", name), filepath.Join(root, "specflow", name)} {
			if hookio.Exists(filepath.Join(d, "spec.md")) {
				return d
			}
		}
		return ""
	}
	// The live tier carries no slug: only a single live change folder names it.
	var live []string
	entries, _ := os.ReadDir(filepath.Join(root, "specflow"))
	for _, e := range entries {
		if e.Name() != "archive" && hookio.Exists(filepath.Join(root, "specflow", e.Name(), "spec.md")) {
			live = append(live, e.Name())
		}
	}
	if len(live) == 1 {
		return filepath.Join(root, "specflow", live[0])
	}
	return ""
}

// changeScope is the directories a change is about: what its deltas'
// capability specs scope plus the directory of every path its milestones name.
func changeScope(root, dir, specsDir string) (dirs, from []string) {
	text := func(f string) string { t, _ := hookio.ReadText(f); return t }
	deltas := ""
	for _, s := range h2Split.Split(text(filepath.Join(dir, "spec.md")), -1) {
		if deltasStart.MatchString(s) {
			deltas = s
			break
		}
	}
	var caps []string
	for _, m := range reqID.ExecAll(deltas) {
		if c := strings.ToLower(m.Group(1)); !contains(caps, c) {
			caps = append(caps, c)
		}
	}
	add := func(d string) {
		if d != "" && !contains(dirs, d) {
			dirs = append(dirs, d)
		}
	}
	for _, c := range caps {
		m := scopeMark.FindStringSubmatch(text(filepath.Join(root, specsDir, c+".md")))
		if m == nil {
			continue
		}
		add(normPath(m[1]))
		from = append(from, specsDir+"/"+c+".md")
	}
	named := 0
	entries, _ := os.ReadDir(filepath.Join(dir, "milestones"))
	var files []string
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".md") {
			files = append(files, e.Name())
		}
	}
	sort.Strings(files)
	for _, f := range files {
		m := filesField.Exec(text(filepath.Join(dir, "milestones", f)))
		if m == nil {
			continue
		}
		for _, p := range namedPathRe.FindAllString(m.Group(1), -1) {
			named++
			if strings.HasSuffix(p, "/") {
				add(normPath(p))
			} else {
				segs := strings.Split(normPath(p), "/")
				add(strings.Join(segs[:len(segs)-1], "/"))
			}
		}
	}
	if named > 0 {
		from = append(from, fmt.Sprintf("%d milestone path(s)", named))
	}
	return dirs, from
}
