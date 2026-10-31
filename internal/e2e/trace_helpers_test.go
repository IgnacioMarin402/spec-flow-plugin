package e2e

// spec-trace is what makes `specs/` authoritative: it binds a requirement id
// to the test that proves it, in both directions. Each case builds a
// repository from a file map, runs the real check against it, and asserts a
// problem is REPORTED — exit 1 and named — never merely survived: a parser
// that matches nothing looks exactly like a repository where everything is
// proven.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

// omit opts a default file out of a case's repository.
const omit = "\x00omit"

func traceConfig(edit func(trace map[string]any)) string {
	trace := map[string]any{"specs_dir": "specs", "proof_dir": "tests", "proof_suffix": ".test.ts",
		"executed_tests": toAny(ran("tests/user.test.ts::REQ-USER-001 the user can do the thing")), "report": nil, "not_a_capability": []any{"README.md"}}
	if edit != nil {
		edit(trace)
	}
	b, _ := json.MarshalIndent(map[string]any{
		"contract_version": 1,
		"verify": map[string]any{"scope_globs": []any{"*.ts"}, "lint": toAny(noop()), "lint_no_fix": toAny(noop()), "test": toAny(noop()),
			"test_name": "fixture-test", "lint_name": "fixture-lint", "lint_config_hint": "fixture.config"},
		"trace":           trace,
		"extra_checks":    []any{},
		"unscoped_denied": map[string]any{"scripts": []any{}, "tools": []any{}, "scoped_allowed": []any{}, "scoped_alternative": "", "scoped_examples": []any{}},
	}, "", "  ")
	return string(b)
}

// ran is a proof source reporting exactly these lines as the tests that RAN.
func ran(lines ...string) []string {
	ops := []string{}
	for _, l := range lines {
		ops = append(ops, "out="+l)
	}
	return toolCmd(ops...)
}

// traceContract is the default contract whose report is these lines; none
// is a suite that ran and reported nothing.
func traceContract(lines ...string) string {
	return traceConfig(func(tr map[string]any) { tr["executed_tests"] = toAny(ran(lines...)) })
}

// reportContract replaces the proof source by a report FILE, or by nothing.
func reportContract(report map[string]any) string {
	return traceConfig(func(tr map[string]any) {
		delete(tr, "executed_tests")
		if report != nil {
			tr["report"] = report
		}
	})
}

func capSpec(id, title, scope string) string {
	if id == "" {
		id = "REQ-USER-001"
	}
	if title == "" {
		title = "the user can do the thing"
	}
	if scope == "" {
		scope = "modules/user"
	}
	return "<!-- spec-scope: " + scope + " -->\n\n# User\n\n### " + id + " — " + title + "\n\nThe system does the thing.\n"
}

var userSpec = capSpec("", "", "")

const junitRan = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="fixture" tests="1" failures="0">
    <testsuite name="tests/user.test.ts" tests="1" failures="0">
        <testcase classname="tests/user.test.ts" name="REQ-USER-001 the user can do the thing" time="0.001">
        </testcase>
    </testsuite>
</testsuites>
`

const junitSkipped = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="fixture" tests="1" failures="0">
    <testsuite name="tests/user.test.ts" tests="1" failures="0" skipped="1">
        <testcase classname="tests/user.test.ts" name="REQ-USER-001 the user can do the thing" time="0">
            <skipped/>
        </testcase>
    </testsuite>
</testsuites>
`

// skillsRequired asks for the milestone field, and reports nothing.
func skillsRequired() string {
	return traceConfig(func(tr map[string]any) {
		tr["require_skills_field"] = true
		tr["executed_tests"] = toAny(ran())
	})
}

func writeFiles(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	for rel, content := range files {
		if content == omit {
			continue
		}
		write(t, filepath.Join(dir, filepath.FromSlash(rel)), content)
	}
}

// runTrace runs the real spec-trace against project.
func runTrace(t *testing.T, project string, args ...string) Result {
	t.Helper()
	argv := cliArgv(engineDir, append([]string{"trace"}, args...)...)
	if oracle != "" {
		argv = append([]string{"node", filepath.Join(oracle, "scripts", "spec-trace.mjs")}, args...)
	}
	return run(os.TempDir(), []string{"CLAUDE_PROJECT_DIR=" + project}, "", argv...)
}

// traceRepo builds a repository from files, the contract merged in unless
// the case wrote its own, and runs spec-trace there.
func traceRepo(t *testing.T, files map[string]string, args ...string) (Result, string) {
	t.Helper()
	dir := t.TempDir()
	all := map[string]string{".spec-flow/config.json": traceConfig(nil)}
	for k, v := range files {
		all[k] = v
	}
	writeFiles(t, dir, all)
	return runTrace(t, dir, args...), dir
}

type branchOpts struct {
	under       string
	state       map[string]string
	dirs        []string
	uncommitted map[string]string
}

// traceBranch commits base on main, then each map of commits in turn on feat
// off it, where spec-trace runs: the base resolves to main. After the commits:
// uncommitted written over the tree, dirs left as empty folders and state
// under `.claude/state/`, as a run leaves it.
func traceBranch(t *testing.T, base map[string]string, commits []map[string]string, o branchOpts) Result {
	t.Helper()
	repo := t.TempDir()
	project := repo
	if o.under != "" {
		project = filepath.Join(repo, o.under)
	}
	git(t, repo, "init", "-q", ".")
	git(t, repo, "symbolic-ref", "HEAD", "refs/heads/main")
	git(t, repo, "config", "core.autocrlf", "false")
	all := map[string]string{".spec-flow/config.json": traceConfig(nil)}
	for k, v := range base {
		all[k] = v
	}
	writeFiles(t, project, all)
	git(t, repo, "add", "-A")
	git(t, repo, "commit", "-q", "-m", "base")
	git(t, repo, "checkout", "-q", "-b", "feat")
	for i, c := range commits {
		for rel, content := range c {
			if content == omit {
				os.Remove(filepath.Join(project, filepath.FromSlash(rel)))
			}
		}
		writeFiles(t, project, c)
		git(t, repo, "add", "-A")
		git(t, repo, "commit", "-q", "--allow-empty", "-m", "branch "+string(rune('0'+i)))
	}
	writeFiles(t, project, o.uncommitted)
	for _, d := range o.dirs {
		os.MkdirAll(filepath.Join(project, d), 0o755)
	}
	for name, text := range o.state {
		write(t, statePath(project, name), text)
	}
	return runTrace(t, project)
}

func shippedSpec(deltas ...string) string {
	s := "# Spec — x\n\n**Status:** SHIPPED 2026-10-17\n\n## Requirement deltas\n"
	for _, d := range deltas {
		s += "- " + d + "\n"
	}
	return s
}

func shippedWith(section string) string {
	return "# Spec — x\n\n**Status:** SHIPPED 2026-10-17\n\n## Requirement deltas\n" + section
}

var twoReqs = userSpec + "\n### REQ-USER-002 — the user can do another thing\n\nThe system does it.\n"

// twoRuns: a branch that shipped run one's change, then started run two's.
var twoRuns = []map[string]string{
	{"specflow/archive/run-one/spec.md": shippedSpec("ADDED REQ-USER-002 — the user can export their data")},
	{"specflow/run-two/spec.md": "# Spec — run two\n\n## Requirement deltas\n- ADDED REQ-USER-003 — the user can import data\n", "specflow/run-two/proposal.md": "# Proposal\n\nWhy.\n"},
}

// ownFold: run one's change, then its fold, whose ADDED id never reached specs/.
var ownFold = []map[string]string{
	{"specflow/run-one/spec.md": "# Spec — run one\n\n## Requirement deltas\n- ADDED REQ-USER-002 — the user can export their data\n", "specflow/run-one/proposal.md": "# Proposal\n\nWhy.\n"},
	{"specflow/run-one/spec.md": omit, "specflow/run-one/proposal.md": omit,
		"specflow/archive/run-one/spec.md": shippedSpec("ADDED REQ-USER-002 — the user can export their data"), "specflow/archive/run-one/proposal.md": "# Proposal\n\nWhy.\n"},
}

func holdsOwnFold(t *testing.T, r Result) {
	t.Helper()
	if r.Status == 0 || !regexp.MustCompile(`(?m)^ {2}- REQ-USER-002 is ADDED by specflow/archive/run-one`).MatchString(r.Out()) || regexp.MustCompile(`held from the fold's gate on`).MatchString(r.Out()) {
		t.Fatalf("the fold's gate passed over the run's own drift: %s", r.Out())
	}
}

func failsWith(t *testing.T, r Result, pattern, why string) {
	t.Helper()
	if r.Status == 0 {
		t.Fatalf("%s: it passed: %s", why, r.Out())
	}
	mustMatch(t, pattern, r.Out(), why)
}

func passes(t *testing.T, r Result, why string) {
	t.Helper()
	if r.Status != 0 {
		t.Fatalf("%s: %s", why, r.Out())
	}
}
