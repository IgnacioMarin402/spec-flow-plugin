package e2e

// Cold start: a Node repository, from nothing to a green `spec-flow check`,
// through the route the README documents. Every other test exercises a
// piece; this is the claim a reader forms from the front page, and the only
// check that fails when adoption breaks for a reason no single piece owns.
// Nothing is installed and nothing is hand-written: the suite is `node
// --test`, whose JUnit report is written by the runner itself.

import (
	"encoding/json"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// documented is `<engine>/bin/spec-flow <args>`, run from dir with no
// CLAUDE_PROJECT_DIR: a real adopter in a terminal has none.
func documented(t *testing.T, dir string, args ...string) Result {
	t.Helper()
	argv := append([]string{filepath.Join(engineDir, "bin", "spec-flow")}, args...)
	if oracle != "" {
		argv = cliArgv(engineDir, args...)
	}
	return run(dir, []string{"CLAUDE_PROJECT_DIR="}, "", argv...)
}

// nodeRepo is an ordinary Node repository, committed on main.
func nodeRepo(t *testing.T, scripts map[string]string, files map[string]string) string {
	t.Helper()
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("a Node repository's own suite needs node")
	}
	repo := t.TempDir()
	write(t, filepath.Join(repo, "package.json"), toJSON(map[string]any{"name": "cold-start", "version": "1.0.0", "type": "module", "scripts": scripts})+"\n")
	writeFiles(t, repo, files)
	git(t, repo, "init", "-q", ".")
	git(t, repo, "symbolic-ref", "HEAD", "refs/heads/main")
	git(t, repo, "add", "-A")
	git(t, repo, "commit", "-qm", "baseline")
	return repo
}

func editJSON(t *testing.T, path string, edit func(map[string]any)) {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(read(path)), &m); err != nil {
		t.Fatalf("%s: %v", path, err)
	}
	edit(m)
	write(t, path, toJSON(m)+"\n")
}

// branchOff commits what is there, then a change on a feature branch.
func branchOff(t *testing.T, repo, file, text string) {
	t.Helper()
	git(t, repo, "add", "-A")
	git(t, repo, "commit", "-qm", "adopt spec-flow")
	git(t, repo, "checkout", "-qb", "feature")
	write(t, filepath.Join(repo, filepath.FromSlash(file)), text)
	git(t, repo, "add", "-A")
	git(t, repo, "commit", "-qm", "work")
}

func TestColdStart(t *testing.T) {
	files := map[string]string{
		// A real linter, installing nothing: `node --check` fails on a syntax error.
		"lint.js":      "import { execFileSync } from 'node:child_process';\nfor (const file of process.argv.slice(2)) execFileSync(process.execPath, ['--check', file]);\n",
		"lib/login.js": "export const login = (user, password) => password === \"right\";\n",
		"test/auth.test.js": "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { login } from '../lib/login.js';\n\n" +
			"test('REQ-AUTH-001 a bad password is rejected', () => {\n  assert.equal(login('u', 'wrong'), false);\n});\n",
	}
	// Enough files for the scope globs to be a reading rather than a guess.
	for _, name := range []string{"session", "token", "user", "audit"} {
		files["lib/"+name+".js"] = "export const " + name + " = () => '" + name + "';\n"
	}
	// Through an interpreter on purpose: `node` names no runner, so both the
	// runner name and the reporter flag must be read from the argv.
	repo := nodeRepo(t, map[string]string{"test": "node --test", "lint": "node lint.js"}, files)

	init := documented(t, repo, "init")
	path := filepath.Join(repo, ".spec-flow", "config.json")
	if !exists(path) {
		t.Fatalf("init wrote no contract:\n%s", init.Out())
	}
	w := readWritten(t, repo)
	if w.Trace.Report == nil || w.Trace.Report.Format == "" || w.Trace.Report.Path == "" {
		t.Fatalf("init did not declare a readable report source: %+v", w.Trace)
	}
	appended := false
	for _, tok := range w.Verify.Test {
		appended = appended || strings.Contains(tok, w.Trace.Report.Path)
	}
	if !appended {
		t.Fatalf("verify.test does not write the report the contract points at: %q", w.Verify.Test)
	}
	if exists(filepath.Join(repo, ".spec-flow", "tests-that-ran.mjs")) {
		t.Fatal("a translator stub was written though nothing points at it")
	}
	// Counted so that growth in adoption cost is visible rather than absorbed.
	if m := missingLines(init.Out()); len(m) > 2 {
		t.Fatalf("a Node repo is now asked for %d fields:\n%s", len(m), strings.Join(m, "\n"))
	}
	if w.Verify.TestName != "node --test" {
		t.Fatalf("test_name is %q", w.Verify.TestName)
	}

	// The adopter fills in only what init NAMED.
	editJSON(t, path, func(c map[string]any) {
		v := c["verify"].(map[string]any)
		v["scope_globs"], v["lint_name"], v["lint_config_hint"] = []any{"*.js"}, "fixture-lint", "package.json"
	})
	write(t, filepath.Join(repo, "specs", "auth.md"), "<!-- spec-scope: lib -->\n\n# Auth\n\n### REQ-AUTH-001 — a bad password is rejected\n\nThe system rejects a login whose password does not match.\n")
	branchOff(t, repo, "lib/login.js", "export const login = (user, password) => password === \"right\"; // changed\n")

	green := documented(t, repo, "check")
	if green.Status != 0 {
		t.Fatalf("spec-flow check failed on a repo init configured:\n%s", green.Out())
	}
	mustMatch(t, `every one proven by a test`, green.Out(), "spec-trace did not report the requirement as proven")
	if !exists(filepath.Join(repo, filepath.FromSlash(w.Trace.Report.Path))) {
		t.Fatalf("no report at %s after the suite ran — the appended flag does not produce one", w.Trace.Report.Path)
	}

	// From a subdirectory the contract is not where the engine looks (ADR-027).
	inside := documented(t, filepath.Join(repo, "lib"), "check")
	if inside.Status == 0 {
		t.Fatalf("the check went green from lib/, judging a subdirectory as the repository:\n%s", inside.Out())
	}
	mustMatch(t, `repository root`, inside.Out(), "the refusal from lib/ does not name the root")

	// The test still exists and names the requirement; the runner reports it skipped.
	write(t, filepath.Join(repo, "test", "auth.test.js"), "import { test } from 'node:test';\n\ntest('REQ-AUTH-001 a bad password is rejected', { skip: 'wip' }, () => {});\n")
	skipped := documented(t, repo, "check")
	if skipped.Status == 0 {
		t.Fatalf("a requirement stayed proven after its test stopped running:\n%s", skipped.Out())
	}
	mustMatch(t, `REQ-AUTH-001`, skipped.Out(), "the failure did not name the requirement whose proof disappeared")
}

// The setup skill is prose a model acts on: the route it prescribes, the
// buckets it tells the model to read and the fields it tells it to fill are
// claims about this engine that go stale silently. ADR-006 says why the
// runner knowledge is in the skill; this binds what remains to the engine.
// What CI cannot check — whether a model picks the right flag — is
// survivable only because a wrong flag fails LOUDLY, which the last part holds.
func TestSkillContract(t *testing.T) {
	skill := read(filepath.Join(repoRoot, "skills", "spec-flow-setup", "SKILL.md"))
	if skill == "" {
		t.Fatal("skills/spec-flow-setup/SKILL.md does not exist")
	}
	for _, step := range []string{"bin/spec-flow init", "bin/spec-flow check"} {
		if !strings.Contains(skill, step) {
			t.Errorf("the skill no longer tells anyone to run %s, so its procedure has a hole there", step)
		}
	}
	// A repository producing all three buckets: something detected, a runner
	// that cannot be named, and no report flag.
	repo := nodeRepo(t, map[string]string{"test": "node --test", "lint": "node lint.js"}, map[string]string{
		"lint.js": "process.exit(0);\n", "lib/a.js": "export const a = 1;\n",
		"test/a.test.js": "import { test } from 'node:test';\ntest('REQ-CORE-001 holds', () => {});\n",
	})
	init := documented(t, repo, "init")
	for _, label := range []string{"detected", "REVIEW", "MISSING"} {
		if !regexp.MustCompile(`(?m)^\s*` + label + `\b`).MatchString(init.Out()) {
			t.Errorf("init printed no %s line on a repo built to produce all three:\n%s", label, init.Out())
		}
		if !strings.Contains(skill, label) {
			t.Errorf("init prints %s and the skill never mentions it, so that bucket has no reader", label)
		}
	}
	// A dotted field in the skill is an instruction to write that key; a typo
	// ships a config the loader ignores and the model reports as configured.
	path := filepath.Join(repo, ".spec-flow", "config.json")
	var written map[string]any
	if err := json.Unmarshal([]byte(read(path)), &written); err != nil {
		t.Fatalf("init wrote no contract to check the skill against: %v", err)
	}
	named := map[string]bool{}
	for _, m := range regexp.MustCompile("`((?:verify|trace)\\.[a-z_]+(?:\\.[a-z_]+)*)`").FindAllStringSubmatch(skill, -1) {
		named[m[1]] = true
	}
	if len(named) == 0 {
		t.Error("the skill names no `verify.*` or `trace.*` field, so its step 2 tells the model nothing specific")
	}
	for field := range named {
		if field == "trace.executed_tests" {
			continue // the documented alternative to trace.report
		}
		var node any = written
		for _, key := range strings.Split(field, ".") {
			m, _ := node.(map[string]any)
			node = m[key]
		}
		if node == nil {
			t.Errorf("the skill tells the model to set %s, which is not in the contract init writes", field)
		}
	}
	// The flag stripped back out: a test command that runs clean and writes
	// nothing, as a wrong reporter flag leaves it. It must not pass quietly.
	editJSON(t, path, func(c map[string]any) {
		v := c["verify"].(map[string]any)
		v["scope_globs"], v["test_name"], v["lint_name"], v["lint_config_hint"], v["test"] = []any{"*.js"}, "fixture-runner", "fixture-linter", "fixture.config", []any{"node", "--test"}
	})
	write(t, filepath.Join(repo, "specs", "core.md"), "<!-- spec-scope: lib -->\n\n# Core\n\n### REQ-CORE-001 — it holds\n\nThe system holds.\n")
	branchOff(t, repo, "lib/a.js", "export const a = 2;\n")
	red := documented(t, repo, "check")
	if red.Status == 0 {
		t.Fatalf("the route went green with a declared requirement and no report on disk:\n%s", red.Out())
	}
	mustMatch(t, `reporter flag|does not exist|trace\.report`, red.Out(), "the refusal does not name the report, so nothing sends the model to its flag")
	mustNotMatch(t, `has no test`, red.Out(), "a missing report read as a requirement with no test")
}
