package e2e

// The gate is what every other guarantee rests on, so it is tested by
// running it: a throwaway repository, the engine installed apart from it, and
// what the real hook did. A Stop hook blocks by printing a decision and
// exiting 0 — a non-zero exit is no failure at all — so "did it say block,
// and did it write down what it judged" is the assertion, never the exit.
//
// Two properties of the scaffolding are load-bearing: every case has a real
// base and a commit changing a tracked file, so the scope is NON-EMPTY, and
// the base branch is a parameter, never one name.

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func noop() []string { return toolCmd("exit=0") }
func red() []string  { return toolCmd("exit=1") }

const (
	junitProves = `<testsuites><testcase name="REQ-FIX-001 the fix"/></testsuites>` + "\n"
	junitSkips  = `<testsuites><testcase name="REQ-FIX-001 the fix"><skipped/></testcase></testsuites>` + "\n"
	fixSpec     = "<!-- spec-scope: modules/fix -->\n\n# Fix\n\n### REQ-FIX-001 — the fix\n\nThe system is fixed.\n"
)

// suiteWriting is a suite that writes body as its report, as a real one does
// on every run: the gate removes the previous report first.
func suiteWriting(body string) []string { return toolCmd("write=reports/junit.xml=" + body) }

type gateOpts struct {
	phase           string
	specTraceRed    bool
	dirty           bool
	extraChecks     []map[string]any
	contractVersion int
	crash           bool
	gateAttempts    string
	history         func(sha string) string
	lint, test      []string
	noScopeChange   bool // commit real work, none of it in scope
	baseBranch      string
	scopeGlobs      []string
	engineCheckout  bool
	commitPhase     bool
	phaseOwner      string
	baseRef         string
	stayOnBase      bool
	report          map[string]any
	specs           map[string]string
	openAt          string
}

type gateRepo struct{ engine, repo, gitDir string }

var crashEngine string

// crashingEngine is an engine whose unscoped checks throw: a second build
// under the `gatecrash` tag in Go, the same sabotage the JavaScript copy took.
func crashingEngine(t *testing.T) string {
	t.Helper()
	engine := copyEngine(t)
	if oracle != "" {
		p := filepath.Join(engine, "scripts", "unscoped-checks.mjs")
		find := "export function runUnscopedChecks(root, config) {"
		write(t, p, strings.Replace(read(p), find, find+"\n  throw new Error(\"simulated engine defect\");", 1))
		return engine
	}
	cmd := exec.Command("go", "build", "-tags", "gatecrash", "-o", binary(engine), "./cmd/spec-flow")
	cmd.Dir = repoRoot
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("building the crashing engine: %v\n%s", err, out)
	}
	return engine
}

func gateFixture(t *testing.T, o gateOpts) gateRepo {
	t.Helper()
	if o.phase == "" {
		o.phase = "implement"
	}
	if o.lint == nil {
		o.lint = noop()
	}
	if o.test == nil {
		o.test = noop()
	}
	if o.baseBranch == "" {
		o.baseBranch = "main"
	}
	if o.scopeGlobs == nil {
		o.scopeGlobs = []string{"*.ts"}
	}
	if o.contractVersion == 0 {
		o.contractVersion = 1
	}
	if o.gateAttempts == "" {
		o.gateAttempts = "0"
	}
	b := gateRepo{engine: engineDir, gitDir: t.TempDir()}
	switch {
	case o.crash:
		b.engine = crashingEngine(t)
	case o.engineCheckout:
		b.engine = copyEngine(t)
		for _, args := range [][]string{{"init", "-q", "."}, {"symbolic-ref", "HEAD", "refs/heads/main"}, {"config", "core.autocrlf", "false"}, {"add", "-A"}, {"commit", "-qm", "engine at its first revision"}} {
			git(t, b.engine, args...)
		}
	}
	b.repo = b.gitDir
	if o.openAt != "" {
		b.repo = filepath.Join(b.gitDir, o.openAt)
	}
	for _, args := range [][]string{{"init", "-q", "."}, {"symbolic-ref", "HEAD", "refs/heads/" + o.baseBranch}, {"config", "user.email", "fixture@example.com"}, {"config", "user.name", "fixture"}, {"config", "core.autocrlf", "false"}} {
		git(t, b.gitDir, args...)
	}
	verify := map[string]any{"scope_globs": toAny(o.scopeGlobs), "lint": toAny(o.lint), "lint_no_fix": toAny(noop()), "test": toAny(o.test),
		"test_name": "fixture-test", "lint_name": "fixture-lint", "lint_config_hint": "fixture.config"}
	if o.baseRef != "" {
		verify["base_ref"] = o.baseRef
	}
	trace := map[string]any{"specs_dir": "specs", "proof_dir": "tests", "proof_suffix": ".spec.ts", "not_a_capability": []any{}}
	if o.report != nil {
		trace["report"] = o.report
	} else {
		trace["executed_tests"] = toAny(noop())
	}
	extras := []any{}
	for _, e := range o.extraChecks {
		extras = append(extras, e)
	}
	contract, _ := json.MarshalIndent(map[string]any{"contract_version": o.contractVersion, "verify": verify, "trace": trace, "extra_checks": extras,
		"unscoped_denied": map[string]any{"scripts": []any{}, "tools": []any{}, "scoped_allowed": []any{}, "scoped_alternative": "", "scoped_examples": []any{}}}, "", "  ")
	write(t, filepath.Join(b.repo, ".spec-flow", "config.json"), string(contract))
	write(t, filepath.Join(b.repo, ".gitignore"), ".claude/state/\n")
	write(t, filepath.Join(b.repo, "a.ts"), "export const a = 1;\n")
	specs := o.specs
	if o.specTraceRed && specs == nil {
		// A requirement nothing reports a test for: the real spec-trace, red.
		specs = map[string]string{"specs/fix.md": fixSpec}
	}
	for rel, content := range specs {
		write(t, filepath.Join(b.repo, rel), content)
	}
	git(t, b.gitDir, "add", "-A")
	git(t, b.gitDir, "commit", "-qm", "baseline on "+o.baseBranch)
	// The base every case diffs against is a real ancestor, never HEAD itself.
	if !o.stayOnBase {
		git(t, b.gitDir, "checkout", "-q", "-b", "feature")
		if o.noScopeChange {
			write(t, filepath.Join(b.repo, "notes.md"), "# notes\n\nReal work, none of it matching scope_globs.\n")
		} else {
			write(t, filepath.Join(b.repo, "b.ts"), "export const changed = 1;\n")
		}
		git(t, b.gitDir, "add", "-A")
		git(t, b.gitDir, "commit", "-qm", "change")
	}
	if o.dirty {
		write(t, filepath.Join(b.repo, "dirty.txt"), "uncommitted\n")
	}
	write(t, statePath(b.repo, "phase"), o.phase)
	write(t, statePath(b.repo, "gate_attempts"), o.gateAttempts)
	if o.phaseOwner != "" {
		write(t, statePath(b.repo, "phase.session"), o.phaseOwner)
	}
	if o.commitPhase {
		git(t, b.gitDir, "add", "-f", "--", filepath.ToSlash(filepath.Join(o.openAt, ".claude/state/phase")))
		git(t, b.gitDir, "commit", "-qm", "a phase this repository committed")
	}
	// After the commits: a history has to name the commit the gate judges.
	if o.history != nil {
		write(t, statePath(b.repo, "gate-history.log"), o.history(git(t, b.gitDir, "rev-parse", "--short", "HEAD")))
	}
	return b
}

type gateRun struct {
	Result
	history, failureLog, lintArgv string
	hasLintArgv                   bool
}

// rejected is a block that is a GATE FAILED, never a pass reported through
// the same channel (ADR-010).
func (g gateRun) rejected() bool {
	return g.Blocked() && !strings.Contains(g.Reason(), "spec-flow: gate PASSED")
}

func runGate(t *testing.T, b gateRepo, payload map[string]any, env ...string) gateRun {
	t.Helper()
	if payload == nil {
		payload = map[string]any{}
	}
	r := Hook{Engine: b.engine, Env: env}.run(t, "gate", payload, b.repo)
	g := gateRun{Result: r,
		history:    strings.TrimSpace(read(statePath(b.repo, "gate-history.log"))),
		failureLog: strings.TrimSpace(read(statePath(b.repo, "gate-failure.log"))),
	}
	if exists(statePath(b.repo, "lint-argv.log")) {
		g.lintArgv, g.hasLintArgv = read(statePath(b.repo, "lint-argv.log")), true
	}
	return g
}

func withGate(t *testing.T, o gateOpts) gateRun {
	t.Helper()
	return runGate(t, gateFixture(t, o), nil)
}

// maxDirtySkips is kept in step with the gate's by hand: a drift turns one
// of the two streak cases red, loudly.
const maxDirtySkips = 10

func skipDirtyHistory(n int) func(string) string {
	return func(sha string) string {
		var b strings.Builder
		for i := 0; i < n; i++ {
			fmt.Fprintf(&b, "2026-08-01T00:00:%02dZ %s phase=implement attempt=0 result=skip-dirty lint=- test=- unscoped=- files=1\n", i, sha)
		}
		return b.String()
	}
}

func judgedHistory(sha string) string {
	return "2026-08-01T00:00:00Z " + sha + " phase=implement attempt=0 result=pass lint=0 test=0 unscoped=0 files=1\n"
}

const deadRunning = "2026-08-01T00:00:00Z abc1234 phase=implement attempt=0 result=running lint=- test=- unscoped=- files=-\n"

func TestGate(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name  string
		o     gateOpts
		check func(t *testing.T, r gateRun)
	}{
		// ---- the reason this exists: engine and repo are never one directory
		{"reads CLAUDE_PROJECT_DIR, never its own install location", gateOpts{}, func(t *testing.T, r gateRun) {
			if r.rejected() {
				t.Fatalf("the gate rejected a green tree: %s", r.Stderr)
			}
			mustMatch(t, `result=pass`, r.history, "no pass recorded in the REPO's own state")
		}},
		// If this reads files=0, base resolution stopped finding main and every case is back to never invoking lint.
		{"a green run against real changes reports the real scope (files=1)", gateOpts{}, func(t *testing.T, r gateRun) {
			mustMatch(t, `files=1\b`, r.history, "expected files=1")
		}},
		// The failure this engine keeps having: a hook that dies allows the stop.
		{"an unexpected throw inside the engine blocks the stop and records it", gateOpts{crash: true}, func(t *testing.T, r gateRun) {
			if !r.Blocked() {
				t.Fatal("the gate threw and ALLOWED the stop — a milestone nothing checked would read as a clean pass")
			}
			mustMatch(t, `result=fail:hook-error`, r.history, "blocked, but left no hook-error line")
		}},
		// A timed-out hook renders no decision; a surviving `running` line is the evidence.
		{"an armed gate records the attempt before it runs anything", gateOpts{}, func(t *testing.T, r gateRun) {
			mustNotMatch(t, `result=running`, r.history, "the run left its own `running` line behind")
			mustMatch(t, `result=pass`, r.history, "expected the running line replaced by the outcome")
		}},
		{"a gate killed mid-judgement is reported by the next one, not forgotten", gateOpts{history: func(string) string { return deadRunning }}, func(t *testing.T, r gateRun) {
			if !r.Blocked() {
				t.Fatalf("a previous gate died without judging and this one allowed the stop: %s", r.history)
			}
			mustMatch(t, `result=fail:killed`, r.history, "the kill was not recorded as such")
			mustMatch(t, `(?i)timeout|time budget`, r.Stdout, "the block does not name the likely cause")
		}},
		{"the report clears the evidence, so it does not block forever", gateOpts{history: func(string) string { return deadRunning }}, func(t *testing.T, r gateRun) {
			mustNotMatch(t, ` result=running `, r.history, "the dangling line survived its own report")
		}},
		// ---- the one deliberate fail-CLOSED case
		{"an unrecognized contract_version blocks loudly instead of falling back to defaults", gateOpts{contractVersion: 999}, func(t *testing.T, r gateRun) {
			if !r.Blocked() {
				t.Fatal("a contract version this engine does not understand did not block the stop")
			}
			mustMatch(t, `fail:contract`, r.history, "history did not record a contract failure")
		}},
		{"a red unscoped check blocks the stop and records why", gateOpts{specTraceRed: true}, func(t *testing.T, r gateRun) {
			if !r.Blocked() {
				t.Fatal("the gate did not block for a failing check")
			}
			mustMatch(t, `result=fail`, r.history, "history did not record the failure")
			if !strings.Contains(r.failureLog, "spec-trace") {
				t.Fatal("the failure log does not name the check that failed")
			}
		}},
		// A traceability failure on a green suite is an edit, not a re-plan.
		{"spec-trace alone, with lint and the suite green, takes the cheap route", gateOpts{specTraceRed: true}, func(t *testing.T, r gateRun) {
			mustMatch(t, `result=fail:lint/trace`, r.history, "a traceability failure must classify as lint/trace")
			mustMatch(t, `test=0`, r.history, "the suite was meant to be green")
			mustMatch(t, `the tests pass, so the plan is NOT in question`, r.Reason(), "the block did not route to the direct fix")
			if regexp.MustCompile(`(?i)re-?plan`).MatchString(r.Reason()) && !strings.Contains(r.Reason(), "Do NOT re-plan") {
				t.Fatalf("the block asked for a re-plan on a green suite: %s", r.Reason())
			}
		}},
		{"a green run is never rejected, and always records the pass", gateOpts{}, func(t *testing.T, r gateRun) {
			if r.rejected() {
				t.Fatal("the gate rejected a tree where every check passed")
			}
			mustMatch(t, `result=pass`, r.history, "expected a pass line")
			mustMatch(t, `spec=0`, r.history, "the declared check did not report its field")
		}},
		// A first pass wakes the orchestrator on the channel that reaches a human (ADR-010).
		{"a green run on a NEW commit wakes the orchestrator", gateOpts{}, func(t *testing.T, r gateRun) {
			if !r.Blocked() {
				t.Fatalf("a first-time pass did not block — nothing will advance the run: %s", r.Stdout)
			}
			mustMatch(t, `spec-flow: gate PASSED`, r.Reason(), "the block does not announce a pass")
			mustMatch(t, `(?i)next milestone|MODE=FOLD|'done'`, r.Reason(), "the pass block does not say what to do next")
			mustNotMatch(t, `^GATE FAILED`, r.Reason(), "a pass block reads like a failure block")
		}},
		{"a real JUnit report proving the requirement wakes the orchestrator and tells it what passed", gateOpts{report: map[string]any{"format": "junit", "path": "reports/junit.xml"}, test: suiteWriting(junitProves), specs: map[string]string{"specs/fix.md": fixSpec}}, func(t *testing.T, r gateRun) {
			if !r.Blocked() {
				t.Fatalf("a real JUnit report proving the requirement did not wake the run: %s", r.Stdout)
			}
			mustMatch(t, `result=pass`, r.history, "expected a pass line")
			mustMatch(t, `spec-flow: gate PASSED`, r.Reason(), "passed without telling the human")
		}},
		// A skip is "ran, and did not run", never "the report never appeared".
		{"a real JUnit report marking the requirement <skipped/> blocks as an unproven requirement", gateOpts{report: map[string]any{"format": "junit", "path": "reports/junit.xml"}, test: suiteWriting(junitSkips), specs: map[string]string{"specs/fix.md": fixSpec}}, func(t *testing.T, r gateRun) {
			if !r.Blocked() {
				t.Fatal("a requirement whose only test was <skipped/> passed the gate")
			}
			mustMatch(t, `result=fail`, r.history, "history did not record the failure")
			mustMatch(t, `spec=[1-9]`, r.history, "spec-trace did not report itself as the failing check")
			if !strings.Contains(r.failureLog, "REQ-FIX-001") || !strings.Contains(r.failureLog, "has no test") {
				t.Fatalf("the failure does not name the unproven requirement: %s", r.failureLog)
			}
			mustNotMatch(t, `reporter flag|does not exist`, r.failureLog, "a skip was reported as a missing report file")
			mustNotMatch(t, `reported no tests at all`, r.failureLog, "a report with one skipped case read as saying nothing")
		}},
		// The path is the adopter's: one naming a source file must never cost them that file.
		{"a report path naming a file that is not a report never loses that file", gateOpts{report: map[string]any{"format": "junit", "path": "a.ts"}, specs: map[string]string{"specs/fix.md": fixSpec}}, func(t *testing.T, r gateRun) {
			if !r.rejected() {
				t.Fatalf("a report path naming a source file passed the gate: %s", r.Stdout)
			}
		}},
		// Every spawn runs in the background (ADR-023): a stop ends a turn, not a milestone.
		{"a dirty tree on a commit already judged is skipped, not judged, and says nothing", gateOpts{specTraceRed: true, dirty: true, history: judgedHistory}, func(t *testing.T, r gateRun) {
			if r.Blocked() {
				t.Fatal("a dirty tree was judged; an implementer mid-write would be reported as a failure")
			}
			mustMatch(t, `result=skip-dirty`, r.history, "expected skip-dirty")
			if strings.TrimSpace(r.Stdout) != "" {
				t.Fatalf("the gate spoke about a tree it did not judge: %s", r.Stdout)
			}
		}},
		// The orchestrator committed and waits for a verdict nothing will deliver (ADR-012).
		{"a dirty tree on a commit nothing has judged wakes the run", gateOpts{dirty: true}, func(t *testing.T, r gateRun) {
			if !r.Blocked() {
				t.Fatalf("the gate skipped a commit nothing has judged and said nothing: %s", r.history)
			}
			mustMatch(t, `(?i)dirty`, r.Reason(), "the block does not say what is wrong")
			mustMatch(t, `result=skip-dirty`, r.history, "expected the skip still recorded")
		}},
		{"the wake fires once per commit, not on every stop the tree is dirty", gateOpts{dirty: true, history: skipDirtyHistory(1)}, func(t *testing.T, r gateRun) {
			if r.Blocked() || strings.TrimSpace(r.Stdout) != "" {
				t.Fatalf("the same unjudged commit was reported twice: %s", r.Stdout)
			}
		}},
		{"a tree that has stayed dirty for a whole streak wakes the run", gateOpts{dirty: true, history: skipDirtyHistory(maxDirtySkips - 1)}, func(t *testing.T, r gateRun) {
			if !r.Blocked() {
				t.Fatalf("the %dth skip in a row said nothing: %s", maxDirtySkips, r.history)
			}
			mustMatch(t, `(?i)dirty`, r.Reason(), "the block does not say what is wrong")
			mustMatch(t, `result=skip-dirty`, r.history, "expected the skip still recorded")
		}},
		{"the escalation fires once per streak, not on every stop past the threshold", gateOpts{dirty: true, history: skipDirtyHistory(maxDirtySkips)}, func(t *testing.T, r gateRun) {
			if r.Blocked() || strings.TrimSpace(r.Stdout) != "" {
				t.Fatalf("the gate spoke twice about the same unbroken streak: %s", r.Stdout)
			}
		}},
		// Transparent means silent too: every session in every repository fires Stop.
		{"outside an implement phase the hook is transparent", gateOpts{phase: "idle", specTraceRed: true}, func(t *testing.T, r gateRun) {
			if r.Blocked() || r.history != "" || strings.TrimSpace(r.Stdout) != "" {
				t.Fatalf("the gate acted outside a run: %s %s", r.Stdout, r.history)
			}
		}},
		{"a repo's own extra_checks are read from the contract and appear in the history line", gateOpts{extraChecks: []map[string]any{{"name": "fixture-extra", "field": "extra", "green": "(fixture extra ok)", "hint": "fixture hint", "cmd": toAny(toolCmd("out=fixture-extra: OK")), "class": "lint/trace"}}}, func(t *testing.T, r gateRun) {
			if r.rejected() {
				t.Fatalf("an all-green tree with an extra check was rejected: %s", r.Stderr)
			}
			mustMatch(t, `extra=0`, r.history, "the declared extra check's field did not appear")
		}},
		// A runner treats trailing paths as a filter over TEST files: scoping the suite is a false red.
		{"verify.test runs with no file arguments", gateOpts{test: toolCmd("failargs", "--")}, func(t *testing.T, r gateRun) {
			if r.rejected() {
				t.Fatalf("verify.test is scoped to changed files again: %s", r.failureLog)
			}
			mustMatch(t, `result=pass`, r.history, "expected a pass line")
		}},
		{"verify.lint stays scoped to changed files (b.ts), and never receives untouched debt (a.ts)", gateOpts{lint: toolCmd("argsto=.claude/state/lint-argv.log", "--")}, func(t *testing.T, r gateRun) {
			if !r.hasLintArgv {
				t.Fatal("the lint stand-in never ran")
			}
			if !strings.Contains(r.lintArgv, "b.ts") || strings.Contains(r.lintArgv, "a.ts") {
				t.Fatalf("verify.lint received %q", r.lintArgv)
			}
		}},
		// A base that cannot be resolved is a REFUSAL, never an empty scope.
		{"an unresolvable base branch blocks loudly instead of silently checking nothing", gateOpts{baseBranch: "release/7.x", lint: red(), test: red()}, func(t *testing.T, r gateRun) {
			if !r.Blocked() {
				t.Fatalf("the gate allowed the stop with no base: %s", r.history)
			}
			mustMatch(t, `result=fail:base`, r.history, "expected fail:base")
			mustMatch(t, `base_ref`, r.Stdout, "the block does not name the contract field that fixes this")
		}},
		{"verify.base_ref resolves a base no candidate in the ladder could find", gateOpts{baseBranch: "release/7.x", baseRef: "release/7.x"}, func(t *testing.T, r gateRun) {
			if r.rejected() {
				t.Fatalf("an explicit base_ref was rejected: %s", r.Stdout)
			}
			mustMatch(t, `result=pass`, r.history, "expected a pass line")
			mustMatch(t, `files=1\b`, r.history, "base_ref was declared but not read")
		}},
		// `files=` separates the two fail:base doors in the record.
		{"a declared base_ref that git cannot resolve blocks rather than falling back", gateOpts{baseRef: "origin/does-not-exist", lint: red(), test: red()}, func(t *testing.T, r gateRun) {
			if !r.Blocked() {
				t.Fatalf("a bogus base_ref fell back to an empty scope: %s", r.history)
			}
			mustMatch(t, `result=fail:base`, r.history, "expected fail:base")
			mustMatch(t, `files=-`, r.history, "nothing was counted here; a count reads as the other door")
		}},
		// An empty diff is a fact about the diff, never grounds to skip the suite (ADR-008).
		{"a milestone that changed no file in scope still runs the suite", gateOpts{noScopeChange: true, test: red()}, func(t *testing.T, r gateRun) {
			if !r.Blocked() {
				t.Fatalf("no file in scope changed, so the suite was skipped: %s", r.history)
			}
			mustMatch(t, `result=fail:behaviour`, r.history, "expected fail:behaviour")
			mustMatch(t, `files=0\b`, r.history, "expected files=0")
		}},
		{"an empty scope reports lint as not-run, never as clean", gateOpts{noScopeChange: true, test: red()}, func(t *testing.T, r gateRun) {
			mustMatch(t, `lint=-`, r.history, "history claims a lint result for a linter never invoked")
			mustNotMatch(t, `\(clean\)`, r.failureLog, "the failure log reports the linter as clean over files it never received")
		}},
		// Work done ON the base branch: the scope is empty for every milestone of the run.
		{"a base that resolves to HEAD itself is refused, not read as an empty milestone", gateOpts{stayOnBase: true}, func(t *testing.T, r gateRun) {
			if !r.Blocked() {
				t.Fatalf("the base resolved to HEAD and the gate passed anyway: %s", r.history)
			}
			mustMatch(t, `result=fail:base`, r.history, "expected fail:base")
			mustMatch(t, `files=0\b`, r.history, "this door counted an empty scope")
		}},
		{"the refusal names the branch it is standing on, and what to do about it", gateOpts{stayOnBase: true}, func(t *testing.T, r gateRun) {
			mustMatch(t, `base_ref`, r.Stdout, "the block does not point at the field that fixes it")
			mustMatch(t, `(?i)branch`, r.Stdout, "the block does not mention branching")
		}},
		{"an empty scope on a real branch still passes", gateOpts{noScopeChange: true}, func(t *testing.T, r gateRun) {
			if r.rejected() {
				t.Fatalf("real work outside scope_globs was refused as a degenerate base: %s", r.Stdout)
			}
			mustMatch(t, `result=pass`, r.history, "expected a pass line")
			mustMatch(t, `files=0\b`, r.history, "expected files=0")
		}},
		// `**/*.ts` skips the repository root, where b.ts is.
		{"a scope_globs spelled the npm way is refused by the contract", gateOpts{scopeGlobs: []string{"**/*.ts"}, lint: red()}, func(t *testing.T, r gateRun) {
			if !r.Blocked() {
				t.Fatalf("a linter that exits 1 was never invoked and the stop was allowed: %s", r.history)
			}
			mustMatch(t, `result=fail:contract`, r.history, "expected fail:contract")
			mustMatch(t, `scope_globs`, r.Reason(), "the block never names the field")
			mustMatch(t, `"\*\.ts"`, r.Reason(), "the block does not spell out the form that works")
		}},
		{"a scope that matches nothing the repo tracks is refused", gateOpts{scopeGlobs: []string{"nope/*.ts"}, lint: red()}, func(t *testing.T, r gateRun) {
			if !r.Blocked() {
				t.Fatalf("an inert scope passed with the linter never invoked: %s", r.history)
			}
			mustMatch(t, `result=fail:scope`, r.history, "expected fail:scope")
			mustMatch(t, `files=0\b`, r.history, "expected files=0")
			mustMatch(t, `scope_globs`, r.Stdout, "the block never names the field")
		}},
		// The unit of a run is the repository (ADR-027).
		{"a project directory inside the repository but not at its root is refused", gateOpts{openAt: "back", lint: red()}, func(t *testing.T, r gateRun) {
			if !r.rejected() {
				t.Fatalf("a subdirectory was judged as the repository: %s", r.history)
			}
			mustMatch(t, `result=fail:root`, r.history, "expected fail:root")
			mustMatch(t, `repository root`, r.Stdout, "the block does not say where to open the repository")
		}},
		// A phase git tracks came with the repository, not from a run (ADR-017).
		{"a phase the repository COMMITTED arms nothing", gateOpts{commitPhase: true, lint: red(), test: red()}, func(t *testing.T, r gateRun) {
			if r.Blocked() || r.history != "" {
				t.Fatalf("a committed phase armed the gate: %s %s", r.Stdout, r.history)
			}
		}},
		{"a payload with no session id arms a sealed phase rather than standing down", gateOpts{phaseOwner: "session-a", lint: red()}, func(t *testing.T, r gateRun) {
			if !r.Blocked() {
				t.Fatalf("an absent session_id disarmed the gate: %s", r.history)
			}
		}},
		// A red test on attempt 1 goes to the implementer; only a second is evidence against the plan.
		{"a red test on attempt 1 routes to the implementer directly", gateOpts{test: red()}, func(t *testing.T, r gateRun) {
			mustMatch(t, `result=fail:behaviour`, r.history, "expected fail:behaviour")
			mustNotMatch(t, `MODE=REPLAN`, r.Stdout, "attempt 1 already told the orchestrator to REPLAN")
			mustMatch(t, `attempt 1`, r.Stdout, "the block did not name attempt 1")
		}},
		{"a red test that survives one attempt routes to REPLAN", gateOpts{test: red(), gateAttempts: "1"}, func(t *testing.T, r gateRun) {
			mustMatch(t, `result=fail:behaviour`, r.history, "expected fail:behaviour")
			mustMatch(t, `MODE=REPLAN`, r.Stdout, "attempt 2 did not route to REPLAN")
		}},
		{"an extra_check declared class:'behaviour' routes like a red test, not like lint", gateOpts{extraChecks: []map[string]any{{"name": "fixture-behaviour-check", "field": "beh", "green": "(ok)", "hint": "fixture hint", "cmd": toAny(toolCmd("exit=1")), "class": "behaviour"}}}, func(t *testing.T, r gateRun) {
			mustMatch(t, `result=fail:behaviour`, r.history, "expected fail:behaviour")
			mustNotMatch(t, `MODE=REPLAN`, r.Stdout, "attempt 1 of a behaviour-classed check routed to REPLAN")
		}},
	}
	for _, branch := range []string{"master", "develop", "trunk"} {
		branch := branch
		cases = append(cases, struct {
			name  string
			o     gateOpts
			check func(t *testing.T, r gateRun)
		}{"a repo whose default branch is " + branch + " is still judged", gateOpts{baseBranch: branch, lint: red(), test: red()}, func(t *testing.T, r gateRun) {
			if !r.Blocked() || strings.Contains(r.history, "result=pass") {
				t.Fatalf("a red tree read as a pass on %s: %s", branch, r.history)
			}
			mustMatch(t, `files=1\b`, r.history, "the base is still unresolved")
		}})
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			c.check(t, withGate(t, c.o))
		})
	}
	t.Run("a report path naming a source file leaves it untouched", func(t *testing.T) {
		t.Parallel()
		b := gateFixture(t, gateOpts{report: map[string]any{"format": "junit", "path": "a.ts"}, specs: map[string]string{"specs/fix.md": fixSpec}})
		runGate(t, b, nil)
		if read(filepath.Join(b.repo, "a.ts")) != "export const a = 1;\n" {
			t.Fatal("the gate deleted or changed a.ts, a tracked source file the report path named")
		}
	})
	for _, c := range []struct {
		name  string
		tasks []any
		pass  bool
	}{
		{"a stop while a subagent is still running judges nothing", []any{map[string]any{"id": "a0123456789abcdef", "type": "subagent", "status": "running", "agent_type": "spec-flow:implementer"}}, false},
		{"a subagent that has finished does not hold the gate", []any{map[string]any{"id": "a0123456789abcdef", "type": "subagent", "status": "completed"}}, true},
		{"a background shell does not hold the gate: it may never finish", []any{map[string]any{"id": "b1", "type": "shell", "status": "running"}}, true},
	} {
		c := c
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			r := runGate(t, gateFixture(t, gateOpts{}), map[string]any{"background_tasks": c.tasks})
			if c.pass {
				mustMatch(t, `result=pass`, r.history, "it kept the gate from judging")
			} else if r.Blocked() || r.history != "" {
				t.Fatalf("the gate judged a commit while its implementer was still running: %s %s", r.Stdout, r.history)
			}
		})
	}
}

func TestGateAcrossStops(t *testing.T) {
	t.Parallel()
	commit := func(t *testing.T, b gateRepo, file string) {
		write(t, filepath.Join(b.repo, file), "export const c = 1;\n")
		git(t, b.gitDir, "add", "--", file)
		git(t, b.gitDir, "commit", "-qm", "the next milestone")
	}
	// Stop fires more than once over one clean tree; waking on each would thrash.
	t.Run("a second stop on the same commit does not re-wake the model", func(t *testing.T) {
		t.Parallel()
		b := gateFixture(t, gateOpts{})
		if !runGate(t, b, nil).Blocked() {
			t.Fatal("the first pass did not wake the orchestrator")
		}
		second := runGate(t, b, nil)
		if second.Blocked() {
			t.Fatalf("a second stop with no new commit re-blocked: %s", second.Stdout)
		}
		if second.Reason() == "" {
			t.Fatalf("the second stop said nothing at all, reading like a hung run: %s", second.Stdout)
		}
	})
	// Counted, not timed: a stopwatch on a loaded box flips either way.
	t.Run("a repeat stop on a commit already passed does not run the suite again", func(t *testing.T) {
		t.Parallel()
		b := gateFixture(t, gateOpts{test: toolCmd("append=.claude/state/ran.log=x")})
		runGate(t, b, nil)
		if n := len(read(statePath(b.repo, "ran.log"))); n != 1 {
			t.Fatalf("the suite ran %d time(s) on the first stop", n)
		}
		second := runGate(t, b, nil)
		if second.Blocked() || second.Reason() == "" {
			t.Fatalf("the repeat stop re-woke the model or said nothing: %s", second.Stdout)
		}
		if n := len(read(statePath(b.repo, "ran.log"))); n != 1 {
			t.Fatalf("the suite ran again on a stop whose only outcome was \"already reported\" (%d runs)", n)
		}
	})
	t.Run("a new commit is judged even though the one before it just passed", func(t *testing.T) {
		t.Parallel()
		b := gateFixture(t, gateOpts{test: toolCmd("append=.claude/state/ran.log=x")})
		runGate(t, b, nil)
		commit(t, b, "c.ts")
		second := runGate(t, b, nil)
		if n := len(read(statePath(b.repo, "ran.log"))); n != 2 {
			t.Fatalf("the suite did not run for the new commit: %s", second.history)
		}
		if !second.Blocked() {
			t.Fatal("the new commit's pass did not wake the orchestrator")
		}
	})
	// The report is what the gate's own suite writes: read as dirt, every other milestone goes unjudged.
	t.Run("the report the suite writes does not read as a dirty tree at the next stop", func(t *testing.T) {
		t.Parallel()
		b := gateFixture(t, gateOpts{report: map[string]any{"format": "junit", "path": "reports/junit.xml"}, specs: map[string]string{"specs/fix.md": fixSpec}, test: suiteWriting(junitProves)})
		mustMatch(t, `result=pass`, runGate(t, b, nil).history, "the first milestone was not judged")
		commit(t, b, "c.ts")
		second := runGate(t, b, nil)
		mustNotMatch(t, `result=skip-dirty`, second.history, "the second milestone was skipped over the gate's own report")
		mustMatch(t, `result=pass`, second.history, "the second milestone was not judged")
	})
	// The previous run's report names a test this run never ran.
	t.Run("a report the suite no longer writes is not proof", func(t *testing.T) {
		t.Parallel()
		b := gateFixture(t, gateOpts{report: map[string]any{"format": "junit", "path": "reports/junit.xml"}, specs: map[string]string{"specs/fix.md": fixSpec}, test: suiteWriting(junitProves)})
		mustMatch(t, `result=pass`, runGate(t, b, nil).history, "the first milestone did not pass")
		editContract(t, b.repo, func(c map[string]any) { sub(c, "verify")["test"] = toAny(noop()) })
		git(t, b.gitDir, "add", "--", ".spec-flow/config.json")
		git(t, b.gitDir, "commit", "-qm", "the suite stops writing its report")
		second := runGate(t, b, nil)
		lines := strings.Split(second.history, "\n")
		mustNotMatch(t, `result=pass`, lines[len(lines)-1], "the gate passed on a report written by the PREVIOUS run")
		if !second.rejected() {
			t.Fatalf("the gate did not reject the milestone: %s", second.Stdout)
		}
		mustMatch(t, `does not exist`, second.failureLog, "the refusal does not say the report was never written")
	})
	// Two sessions in one repository share `.claude/state/` (ADR-017).
	t.Run("a phase sealed to another session is not this session's business", func(t *testing.T) {
		t.Parallel()
		b := gateFixture(t, gateOpts{phaseOwner: "session-a", lint: red(), test: red()})
		r := runGate(t, b, map[string]any{"session_id": "session-b"})
		if r.Blocked() || r.history != "" {
			t.Fatalf("session B judged session A's milestone: %s %s", r.Stdout, r.history)
		}
	})
	t.Run("the session that owns the phase is still judged", func(t *testing.T) {
		t.Parallel()
		b := gateFixture(t, gateOpts{phaseOwner: "session-a", lint: red()})
		r := runGate(t, b, map[string]any{"session_id": "session-a"})
		mustMatch(t, `result=fail:lint/trace`, r.history, "the owning session's red lint was not caught")
	})
	// engine= is a revision: a value two builds cannot both answer (ADR-018).
	t.Run("engine= names a revision, and moves when the engine does", func(t *testing.T) {
		t.Parallel()
		b := gateFixture(t, gateOpts{engineCheckout: true, lint: red()})
		runGate(t, b, nil)
		git(t, b.engine, "commit", "--allow-empty", "-qm", "a second engine revision")
		second := runGate(t, b, nil)
		var engines []string
		for _, m := range regexp.MustCompile(` engine=(\S+)`).FindAllStringSubmatch(second.history, -1) {
			engines = append(engines, m[1])
		}
		if len(engines) != 2 || !regexp.MustCompile(`^[0-9a-f]{7,40}$`).MatchString(engines[0]) || engines[0] == engines[1] {
			t.Fatalf("want two different revisions, got %v", engines)
		}
	})
}

// cc= is the Claude Code that ran the session, read off the transcript (ADR-041).
func TestGateClaudeCodeVersion(t *testing.T) {
	t.Parallel()
	transcript := func(t *testing.T, entries ...any) string {
		path := filepath.Join(t.TempDir(), "session.jsonl")
		write(t, path, jsonl(entries...))
		return path
	}
	lying := "CLAUDE_CODE_VERSION=2.1.42"
	long := make([]any, 0, 402)
	for i := 0; i < 400; i++ {
		long = append(long, map[string]any{"type": "user", "version": "2.1.293", "message": map[string]any{"content": strings.Repeat("y", 1000)}})
	}
	for _, c := range []struct {
		name    string
		entries []any
		path    string
		want    string
	}{
		{"the last version the transcript carries, never CLAUDE_CODE_VERSION", []any{map[string]any{"type": "user", "version": "2.1.293"}, map[string]any{"type": "assistant", "version": "2.1.296", "toolUseResult": map[string]any{"version": "0.1.0"}}, map[string]any{"type": "ai-title"}}, "", "2.1.296"},
		{"? when the Stop names no transcript", nil, "-", "?"},
		{"? when the transcript cannot be read", nil, filepath.Join(os.TempDir(), "spec-flow-no-such-transcript.jsonl"), "?"},
		{"? when no line of the transcript carries a version", []any{map[string]any{"type": "ai-title"}, map[string]any{"type": "mode"}}, "", "?"},
		{"the build a resumed session runs on now, past its older lines", append(long, map[string]any{"type": "user", "version": "2.1.296"}, map[string]any{"type": "ai-title"}), "", "2.1.296"},
		{"read from a last line longer than the tail the gate reads first", []any{map[string]any{"type": "user", "version": "2.1.293"}, map[string]any{"type": "user", "version": "2.1.296", "message": map[string]any{"content": strings.Repeat("x", 600_000)}}}, "", "2.1.296"},
	} {
		c := c
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			payload := map[string]any{}
			switch c.path {
			case "-":
			case "":
				payload["transcript_path"] = transcript(t, c.entries...)
			default:
				payload["transcript_path"] = c.path
			}
			r := runGate(t, gateFixture(t, gateOpts{}), payload, lying)
			mustMatch(t, ` cc=`+regexp.QuoteMeta(c.want)+` `, r.history, "cc=")
		})
	}
}
