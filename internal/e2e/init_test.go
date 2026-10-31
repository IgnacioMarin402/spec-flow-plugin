package e2e

// What init writes is held to the claim it makes: that it VALIDATES, through
// the same reader every hook uses, so a contract change turns this red rather
// than reaching an adopter whose gate will not start. Every case builds a
// throwaway repository, runs the real CLI against it, and reads back the file.

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"

	"github.com/IgnacioMarin402/spec-flow-plugin/internal/contract"
)

type bin struct{ name, pkg, entry string }

// installBin fabricates what npm publishes for the host platform: on POSIX
// `node_modules/.bin/x` is a symlink to the package's entrypoint; on Windows
// it is a `#!/bin/sh` script beside `x.cmd`, which node cannot parse.
func installBin(t *testing.T, dir string, b bin) {
	t.Helper()
	write(t, filepath.Join(dir, "node_modules", b.pkg, b.entry), "process.exit(0);\n")
	write(t, filepath.Join(dir, "node_modules", b.pkg, "package.json"), toJSON(map[string]any{"name": b.pkg, "version": "1.0.0", "bin": map[string]string{b.name: "./" + b.entry}}))
	shim := filepath.Join(dir, "node_modules", ".bin", b.name)
	os.MkdirAll(filepath.Dir(shim), 0o755)
	rel := "../" + b.pkg + "/" + b.entry
	if runtime.GOOS != "windows" {
		if err := os.Symlink(filepath.FromSlash(rel), shim); err != nil {
			t.Fatal(err)
		}
		return
	}
	// The `$basedir/../<pkg>/<entry>` token is the only part a resolver reads;
	// the rest is npm's, so a resolver cannot pass on a shape npm never writes.
	write(t, shim, "#!/bin/sh\nbasedir=$(dirname \"$(echo \"$0\" | sed -e 's,\\\\,/,g')\")\n\nif [ -x \"$basedir/node\" ]; then\n"+
		"  exec \"$basedir/node\"  \"$basedir/"+rel+"\" \"$@\"\nelse\n  exec node  \"$basedir/"+rel+"\" \"$@\"\nfi\n")
	write(t, shim+".cmd", "@ECHO off\r\nnode  \"%~dp0\\"+strings.ReplaceAll(rel, "/", `\`)+"\" %*\r\n")
}

type initOpts struct {
	scripts                    map[string]string
	files                      map[string]string
	bins                       []string // empty placeholders: enough for init to PREFER the local path
	installed                  []bin
	gitignore, existing        *string
	noGit, noCommit, noPkgJSON bool
}

func initRepo2(t *testing.T, o initOpts) string {
	t.Helper()
	dir := t.TempDir()
	write(t, filepath.Join(dir, "package.json"), toJSON(map[string]any{"name": "fixture", "scripts": o.scripts}))
	writeFiles(t, dir, o.files)
	for _, b := range o.bins {
		write(t, filepath.Join(dir, "node_modules", ".bin", b), "")
	}
	for _, b := range o.installed {
		installBin(t, dir, b)
	}
	if o.gitignore != nil {
		write(t, filepath.Join(dir, ".gitignore"), *o.gitignore)
	}
	if o.existing != nil {
		write(t, filepath.Join(dir, ".spec-flow", "config.json"), *o.existing)
	}
	// A real repository with a real base branch: scope is a merge-base diff.
	if !o.noGit {
		git(t, dir, "init", "-q", ".")
		git(t, dir, "symbolic-ref", "HEAD", "refs/heads/main")
		if !o.noCommit {
			git(t, dir, "add", "-A")
			git(t, dir, "commit", "-qm", "baseline")
		}
	}
	if o.noPkgJSON {
		os.Remove(filepath.Join(dir, "package.json"))
	}
	return dir
}

func runInit(t *testing.T, dir string, args ...string) Result {
	t.Helper()
	return run(dir, []string{"CLAUDE_PROJECT_DIR=" + dir}, "", cliArgv(engineDir, append([]string{"init"}, args...)...)...)
}

type written struct {
	Verify struct {
		Test, Lint, LintNoFix []string
		TestName, LintName    string
	}
	Trace struct {
		ProofDir, ProofSuffix string
		Report                *struct{ Format, Path string }
		ExecutedTests         []string
	}
	ExtraChecks []struct {
		Name, Field string
		Cmd         []string
	}
	Unscoped struct {
		Tools             []string
		ScopedAlternative string
	}
	Mine bool
}

func readWritten(t *testing.T, dir string) written {
	t.Helper()
	var raw map[string]json.RawMessage
	text := read(filepath.Join(dir, ".spec-flow", "config.json"))
	if err := json.Unmarshal([]byte(text), &raw); err != nil {
		t.Fatalf("the contract does not parse: %v\n%s", err, text)
	}
	var w written
	get := func(key string, into any) { json.Unmarshal(raw[key], into) }
	var verify map[string]json.RawMessage
	get("verify", &verify)
	json.Unmarshal(verify["test"], &w.Verify.Test)
	json.Unmarshal(verify["lint"], &w.Verify.Lint)
	json.Unmarshal(verify["lint_no_fix"], &w.Verify.LintNoFix)
	json.Unmarshal(verify["test_name"], &w.Verify.TestName)
	json.Unmarshal(verify["lint_name"], &w.Verify.LintName)
	var trace map[string]json.RawMessage
	get("trace", &trace)
	json.Unmarshal(trace["proof_dir"], &w.Trace.ProofDir)
	json.Unmarshal(trace["proof_suffix"], &w.Trace.ProofSuffix)
	json.Unmarshal(trace["report"], &w.Trace.Report)
	json.Unmarshal(trace["executed_tests"], &w.Trace.ExecutedTests)
	get("extra_checks", &w.ExtraChecks)
	var unscoped map[string]json.RawMessage
	get("unscoped_denied", &unscoped)
	json.Unmarshal(unscoped["tools"], &w.Unscoped.Tools)
	json.Unmarshal(unscoped["scoped_alternative"], &w.Unscoped.ScopedAlternative)
	get("mine", &w.Mine)
	return w
}

// loadsThroughTheEngine validates dir's contract through the reader every hook uses.
func loadsThroughTheEngine(t *testing.T, dir string) error {
	t.Helper()
	if oracle == "" {
		_, err := contract.Load(dir)
		return err
	}
	r := run(dir, nil, "", "node", "--input-type=module", "-e",
		`import { loadConfig } from `+toJSON("file://"+filepath.ToSlash(filepath.Join(oracle, "scripts", "spec-flow-config.mjs")))+`; loadConfig(process.argv[1]);`, dir)
	if r.Status != 0 {
		return &exec.ExitError{}
	}
	return nil
}

func needNode(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("this case runs what init writes for a Node repository, and needs node")
	}
}

func missingLines(out string) []string {
	var m []string
	for _, l := range strings.Split(out, "\n") {
		if strings.HasPrefix(strings.TrimSpace(l), "MISSING") {
			m = append(m, l)
		}
	}
	return m
}

func hasToken(argv []string, s string) bool {
	for _, a := range argv {
		if a == s {
			return true
		}
	}
	return false
}

// complete is a repository with everything discoverable: scripts, local
// bins, a lint config, tests in their own directory.
func complete(edit func(*initOpts)) initOpts {
	o := initOpts{
		scripts:   map[string]string{"test": "vitest run", "lint": "eslint .", "lint:fix": "eslint . --fix"},
		installed: []bin{{"eslint", "eslint", "bin/eslint.js"}, {"vitest", "vitest", "dist/cli.js"}},
		files: map[string]string{"eslint.config.js": "", "lib/a.ts": "export const a = 1;\n", "lib/b.ts": "export const b = 2;\n", "lib/c.ts": "export const c = 3;\n",
			"test/a.test.ts": "it(\"a\", () => {});\n", "test/b.test.ts": "it(\"b\", () => {});\n"},
	}
	if edit != nil {
		edit(&o)
	}
	return o
}

func withScripts(s map[string]string) func(*initOpts) { return func(o *initOpts) { o.scripts = s } }

func strp(s string) *string { return &s }

func TestInit(t *testing.T) {
	t.Parallel()
	const eslint = "node node_modules/eslint/bin/eslint.js"
	for _, c := range []struct {
		name string
		opts initOpts
		run  func(t *testing.T, dir string)
	}{
		// A fully discoverable repository gets a contract with no field left to
		// write; and init must not present an INFERENCE as a reading.
		{"init finishes with no field left to write, and calls the inferred path an inference", complete(nil), func(t *testing.T, dir string) {
			res := runInit(t, dir)
			if res.Status != 0 {
				t.Fatalf("init refused to finish a repo it could read completely: %s", res.Stdout)
			}
			if m := missingLines(res.Stdout); len(m) > 0 {
				t.Fatalf("a fully discoverable repo still has fields the adopter must supply:\n%s", strings.Join(m, "\n"))
			}
			reviews := regexp.MustCompile(`(?m)^\s*REVIEW\s+(trace\.report|verify\.test)\b`).FindAllString(res.Stdout, -1)
			if len(reviews) != 1 {
				t.Fatalf("the report source was not flagged for review, so an inference reads as a reading: %s", res.Stdout)
			}
			w := readWritten(t, dir)
			if w.Trace.Report == nil || w.Trace.Report.Format != "junit" || w.Trace.Report.Path == "" {
				t.Fatalf("the contract does not declare a readable report source: %+v", w.Trace.Report)
			}
			named := false
			for _, tok := range w.Verify.Test {
				named = named || strings.Contains(tok, w.Trace.Report.Path)
			}
			if !named {
				t.Fatalf("init said it appended a reporter flag and verify.test does not name %s: %q", w.Trace.Report.Path, w.Verify.Test)
			}
			// A file nothing references is what this repo deleted `skills.md` over.
			if exists(filepath.Join(dir, ".spec-flow", "tests-that-ran.mjs")) {
				t.Fatal("a translator stub was written though the contract points at a report file")
			}
			if w.Trace.ExecutedTests != nil {
				t.Fatal("init declared both proof sources, which the contract rejects")
			}
			if err := loadsThroughTheEngine(t, dir); err != nil {
				t.Fatalf("the contract init wrote is one the hooks' own reader rejects: %v", err)
			}
		}},
		// A guard: a fresh stub reports nothing, so a stub that exits 0 would
		// turn every requirement unproven with no edit to blame.
		{"the translator escape hatch is still there, one flag away, and still refuses until finished", complete(nil), func(t *testing.T, dir string) {
			needNode(t)
			runInit(t, dir, "--translator")
			translator := filepath.Join(dir, ".spec-flow", "tests-that-ran.mjs")
			if !exists(translator) {
				t.Fatal("a repo whose runner has no standard report has no way to declare what ran")
			}
			stub := run(dir, nil, "", "node", translator)
			if stub.Status == 0 {
				t.Fatal("an unfinished translator exited 0")
			}
			mustMatch(t, `tests-that-ran`, stub.Out(), "the stub's refusal does not name itself")
		}},
		{"re-running init does not overwrite a translator someone finished", complete(nil), func(t *testing.T, dir string) {
			runInit(t, dir, "--translator")
			translator := filepath.Join(dir, ".spec-flow", "tests-that-ran.mjs")
			mine := "console.log(\"tests/a.test.ts::REQ-USER-001 mine\");\n"
			write(t, translator, mine)
			runInit(t, dir, "--force", "--translator")
			if read(translator) != mine {
				t.Fatal("a finished translator was replaced by a fresh stub")
			}
		}},
		{"it reads the runner and linter out of the repo's own scripts", complete(nil), func(t *testing.T, dir string) {
			runInit(t, dir)
			w := readWritten(t, dir)
			if w.Verify.TestName != "vitest" || !strings.Contains(strings.Join(w.Verify.Test, " "), "vitest") || !hasToken(w.Verify.Test, "run") {
				t.Fatalf("test: %q named %q", w.Verify.Test, w.Verify.TestName)
			}
			if w.Verify.LintName != "eslint" {
				t.Fatalf("lint_name is %q", w.Verify.LintName)
			}
			if strings.Join(w.Verify.Lint, " ") == strings.Join(w.Verify.LintNoFix, " ") {
				t.Fatal("lint and lint_no_fix are identical though the repo declares an autofix script")
			}
		}},
		{"it prefers the locally installed binary over a bare command name", complete(nil), func(t *testing.T, dir string) {
			runInit(t, dir)
			if w := readWritten(t, dir); len(w.Verify.Test) < 2 || w.Verify.Test[0] != "node" || !strings.HasPrefix(w.Verify.Test[1], "node_modules/") {
				t.Fatalf("verify.test does not point at the local install: %q", w.Verify.Test)
			}
		}},
		// A native binary has no entrypoint to name: the bare name still
		// resolves through PATH the way the repo's own script does.
		{"a local bin with no JavaScript behind it falls back to the bare name", complete(func(o *initOpts) { o.installed = nil; o.bins = []string{"vitest", "eslint"} }), func(t *testing.T, dir string) {
			runInit(t, dir)
			w := readWritten(t, dir)
			if len(w.Verify.Test) == 0 || w.Verify.Test[0] != "vitest" || len(w.Verify.Lint) == 0 || w.Verify.Lint[0] != "eslint" {
				t.Fatalf("expected the bare names, got test %q lint %q", w.Verify.Test, w.Verify.Lint)
			}
		}},
		{"it finds the proof surface when tests live in their own directory", complete(nil), func(t *testing.T, dir string) {
			runInit(t, dir)
			if w := readWritten(t, dir); w.Trace.ProofDir != "test" || w.Trace.ProofSuffix != ".test.ts" {
				t.Fatalf("proof_dir %q, proof_suffix %q", w.Trace.ProofDir, w.Trace.ProofSuffix)
			}
		}},
		// `verify.lint` gets the changed files APPENDED: `eslint .` plus a file
		// lints the whole repo, which silently undoes lint scoping.
		{"a lint script's target is dropped, so appending a file cannot widen the scope", complete(nil), func(t *testing.T, dir string) {
			runInit(t, dir)
			w := readWritten(t, dir)
			if hasToken(w.Verify.Lint, ".") || hasToken(w.Verify.LintNoFix, ".") {
				t.Fatalf("a target survived: lint %q, lint_no_fix %q", w.Verify.Lint, w.Verify.LintNoFix)
			}
			if !hasToken(w.Verify.Lint, "--fix") {
				t.Fatalf("the autofix flag was dropped along with the target: %q", w.Verify.Lint)
			}
		}},
		{"dropping a target is reported, never silent", complete(nil), func(t *testing.T, dir string) {
			mustMatch(t, `(?s)REVIEW.*verify\.lint dropped`, runInit(t, dir).Stdout, "init changed the linter invocation without saying so")
		}},
		{"a flag's value that looks like a path is not mistaken for a target", complete(withScripts(map[string]string{"test": "vitest run", "lint": "eslint --ignore-path .gitignore --ext .ts"})), func(t *testing.T, dir string) {
			runInit(t, dir)
			w := readWritten(t, dir)
			for _, tok := range []string{"--ignore-path", ".gitignore", "--ext", ".ts"} {
				if !hasToken(w.Verify.LintNoFix, tok) {
					t.Fatalf("%q was stripped out of a flag pair: %q", tok, w.Verify.LintNoFix)
				}
			}
		}},
		// ---- an inference is offered for review, never as a reading
		{"colocated tests yield a REVIEW line, not a silent guess", complete(func(o *initOpts) {
			o.files = map[string]string{"eslint.config.js": "", "lib/a.ts": "export const a = 1;\n", "lib/b.ts": "export const b = 2;\n", "lib/c.ts": "export const c = 3;\n",
				"lib/a.test.ts": "it(\"a\", () => {});\n", "lib/b.test.ts": "it(\"b\", () => {});\n"}
		}), func(t *testing.T, dir string) {
			out := runInit(t, dir).Stdout
			mustMatch(t, `REVIEW`, out, "no segment identifies a test, yet init presented proof_dir as settled")
			mustMatch(t, `proof_dir`, out, "the REVIEW line does not name the field it is about")
		}},
		// A plausible wrong default runs; a missing one is reported.
		{"an undetectable runner is left empty and reported, never defaulted", complete(withScripts(map[string]string{"lint": "eslint ."})), func(t *testing.T, dir string) {
			res := runInit(t, dir)
			if w := readWritten(t, dir); len(w.Verify.Test) > 0 {
				t.Fatalf("init invented a test command for a repo that declares none: %q", w.Verify.Test)
			}
			mustMatch(t, `MISSING`, res.Stdout, "nothing told the human the runner is missing")
			if res.Status == 0 {
				t.Fatal("init exited 0 having written a contract that cannot validate")
			}
		}},
		{"a compound test script is left to the human rather than half-parsed", complete(withScripts(map[string]string{"test": "npm run build && vitest run", "lint": "eslint ."})), func(t *testing.T, dir string) {
			runInit(t, dir)
			if w := readWritten(t, dir); len(w.Verify.Test) > 0 {
				t.Fatalf("init took one half of a chained script as the whole test command: %q", w.Verify.Test)
			}
		}},
		// The engine spawns the argv with no shell: a quote kept is a literal
		// the runner matches no file with — a green gate over zero tests.
		{"a quoted argument reaches the argv as the shell would pass it, never with its quotes",
			complete(withScripts(map[string]string{"test": `mocha --spec "test/**/*.spec.js"`, "lint": "eslint --rulesdir './my rules' src"})), func(t *testing.T, dir string) {
				runInit(t, dir)
				w := readWritten(t, dir)
				for field, argv := range map[string][]string{"test": w.Verify.Test, "lint": w.Verify.Lint, "lint_no_fix": w.Verify.LintNoFix} {
					for _, tok := range argv {
						if strings.ContainsAny(tok, `"'`) {
							t.Fatalf("verify.%s carries shell quotes as literal text: %q", field, argv)
						}
					}
				}
				if !hasToken(w.Verify.Test, "test/**/*.spec.js") || !hasToken(w.Verify.LintNoFix, "./my rules") {
					t.Fatalf("a quoted word did not arrive as one: test %q lint_no_fix %q", w.Verify.Test, w.Verify.LintNoFix)
				}
			}},
		{"a quoted `|` is one argument, not a chain", complete(withScripts(map[string]string{"test": "vitest run -t 'login|logout'", "lint": "eslint ."})), func(t *testing.T, dir string) {
			runInit(t, dir)
			if w := readWritten(t, dir); !hasToken(w.Verify.Test, "login|logout") {
				t.Fatalf("verify.test: %q", w.Verify.Test)
			}
		}},
		// B67: a framework scaffold's own scripts.
		{"a scaffold's quoted lint script is read, and the report path is where jest-junit writes", complete(func(o *initOpts) {
			o.scripts = map[string]string{"build": "nest build", "format": `prettier --write "lib/**/*.ts" "test/**/*.ts"`, "lint": `eslint "{src,apps,libs,test}/**/*.ts" --fix`, "test": "jest"}
			o.installed = []bin{{"eslint", "eslint", "bin/eslint.js"}}
		}), func(t *testing.T, dir string) {
			res := runInit(t, dir)
			w := readWritten(t, dir)
			if strings.Join(w.Verify.LintNoFix, " ") != eslint || strings.Join(w.Verify.Lint, " ") != eslint+" --fix" {
				t.Fatalf("lint %q, lint_no_fix %q", w.Verify.Lint, w.Verify.LintNoFix)
			}
			mustNotMatch(t, `MISSING\s+verify\.lint\b`, res.Stdout, "the lint script was still refused")
			if w.Trace.Report == nil || w.Trace.Report.Path != "junit.xml" {
				t.Fatalf("trace.report is not where jest-junit writes by default: %+v", w.Trace.Report)
			}
			if strings.Contains(read(filepath.Join(dir, "package.json")), "jest-junit") {
				t.Fatal("init configured the repo's jest-junit")
			}
		}},
		{"a lint:fix script with no lint script is the linter, its fix flag set aside", complete(withScripts(map[string]string{"test": "vitest run", "lint:fix": "eslint . --fix"})), func(t *testing.T, dir string) {
			runInit(t, dir)
			if w := readWritten(t, dir); strings.Join(w.Verify.LintNoFix, " ") != eslint || strings.Join(w.Verify.Lint, " ") != eslint+" --fix" {
				t.Fatalf("lint %q, lint_no_fix %q", w.Verify.Lint, w.Verify.LintNoFix)
			}
		}},
		// `node` as test_name would deny every node invocation while implementing.
		{"an interpreter is never taken as the runner name", complete(withScripts(map[string]string{"test": "node run-my-tests.mjs", "lint": "eslint ."})), func(t *testing.T, dir string) {
			res := runInit(t, dir)
			w := readWritten(t, dir)
			if w.Verify.TestName == "node" || hasToken(w.Unscoped.Tools, "node") {
				t.Fatalf("node was taken as the runner: test_name %q, tools %q", w.Verify.TestName, w.Unscoped.Tools)
			}
			if strings.Join(w.Verify.Test, " ") != "node run-my-tests.mjs" {
				t.Fatalf("the argv itself should still be correct, got: %q", w.Verify.Test)
			}
			mustMatch(t, `(?s)MISSING.*test_name`, res.Stdout, "nothing reported test_name as needing a human")
		}},
		// Node's own runner is `node` plus the flag that makes it a test run.
		{"a node --test project finishes, named for the runner and never for node", complete(func(o *initOpts) {
			o.scripts = map[string]string{"test": "node --test", "lint": "eslint .", "lint:fix": "eslint . --fix"}
			o.installed = []bin{{"eslint", "eslint", "bin/eslint.js"}}
		}), func(t *testing.T, dir string) {
			res := runInit(t, dir)
			if res.Status != 0 || len(missingLines(res.Stdout)) > 0 {
				t.Fatalf("init did not finish a bare node --test project (exit %d): %s", res.Status, res.Stdout)
			}
			w := readWritten(t, dir)
			if w.Verify.TestName != "node --test" {
				t.Fatalf("test_name is %q", w.Verify.TestName)
			}
			for _, tool := range w.Unscoped.Tools {
				if regexp.MustCompile(`^node\b`).MatchString(tool) {
					t.Fatalf("a node name reached unscoped_denied.tools: %q", w.Unscoped.Tools)
				}
			}
			if !hasToken(w.Verify.Test, "--test-reporter=junit") {
				t.Fatalf("the JUnit flag was not appended: %q", w.Verify.Test)
			}
		}},
		{"a runtime that really is the runner keeps its name", complete(withScripts(map[string]string{"test": "bun test", "lint": "eslint ."})), func(t *testing.T, dir string) {
			runInit(t, dir)
			if w := readWritten(t, dir); w.Verify.TestName != "bun" {
				t.Fatalf("test_name is %q — here the runtime IS the runner", w.Verify.TestName)
			}
		}},
		// typescript declares its bin without an extension: the entry must still
		// name the file node runs, since a bare `tsc` spawned with no shell is never found.
		{"the repo's build and typecheck scripts become extra_checks entries", complete(func(o *initOpts) {
			o.scripts = merge(o.scripts, map[string]string{"build": "tsc -p tsconfig.build.json", "typecheck": "tsc --noEmit"})
			o.installed = append(o.installed, bin{"tsc", "typescript", "bin/tsc"})
		}), func(t *testing.T, dir string) {
			res := runInit(t, dir)
			if res.Status != 0 {
				t.Fatalf("init did not finish (exit %d): %s", res.Status, res.Stdout)
			}
			checks := readWritten(t, dir).ExtraChecks
			for name, args := range map[string][]string{"build": {"-p", "tsconfig.build.json"}, "typecheck": {"--noEmit"}} {
				found := false
				for _, e := range checks {
					if e.Name != name {
						continue
					}
					found = true
					want := append([]string{"node", "node_modules/typescript/bin/tsc"}, args...)
					if e.Field != name || strings.Join(e.Cmd, "\x00") != strings.Join(want, "\x00") {
						t.Fatalf("the %q entry: %+v, want cmd %q", name, e, want)
					}
				}
				if !found {
					t.Fatalf("no %q entry in extra_checks: %+v", name, checks)
				}
				mustMatch(t, `REVIEW\s+extra_checks — offered "`+name+`"`, res.Stdout, "a check at every gate was written with no REVIEW line")
			}
		}},
		{"a repo with neither script keeps extra_checks empty", complete(nil), func(t *testing.T, dir string) {
			runInit(t, dir)
			if checks := readWritten(t, dir).ExtraChecks; len(checks) != 0 {
				t.Fatalf("init wrote a check the repo never declared: %+v", checks)
			}
		}},
		// `extra_checks` is optional: an unreadable script must not hold the exit code, nor vanish unsaid.
		{"a build script only a shell can run is reported, not half-parsed, and init still finishes", complete(func(o *initOpts) { o.scripts = merge(o.scripts, map[string]string{"build": "tsc && node bundle.mjs"}) }), func(t *testing.T, dir string) {
			res := runInit(t, dir)
			if res.Status != 0 {
				t.Fatalf("an unreadable optional script held init's exit code (%d): %s", res.Status, res.Stdout)
			}
			if checks := readWritten(t, dir).ExtraChecks; len(checks) != 0 {
				t.Fatalf("init wrote part of a chained script as a check: %+v", checks)
			}
			mustMatch(t, `REVIEW\s+extra_checks — the "build" script .* was not offered: it chains`, res.Stdout, "nothing said the build script will not run during a run")
		}},
		// `build:lib` is a script name, and a package manager on Windows is a `.cmd` no shell-less spawn finds.
		{"a script that hands off to another package script is reported, not offered", complete(func(o *initOpts) {
			o.scripts = merge(o.scripts, map[string]string{"build": "npm run build:lib", "build:lib": "tsc -p .", "typecheck": "pnpm -r typecheck"})
		}), func(t *testing.T, dir string) {
			res := runInit(t, dir)
			if res.Status != 0 {
				t.Fatalf("an optional script init cannot run held its exit code (%d): %s", res.Status, res.Stdout)
			}
			if checks := readWritten(t, dir).ExtraChecks; len(checks) != 0 {
				t.Fatalf("init offered a command that cannot be spawned: %+v", checks)
			}
			for _, name := range []string{"build", "typecheck"} {
				mustMatch(t, `REVIEW\s+extra_checks — the "`+name+`" script .* was not offered: it runs a package script`, res.Stdout, "nothing said the script will not run during a run")
			}
		}},
		// The reader treats base_ref as optional; when resolution fails here it
		// fails at the first gate too, so "valid" would be a half-truth.
		{"an unresolvable base is reported and holds the exit code, though the reader allows it", complete(func(o *initOpts) { o.noCommit = true }), func(t *testing.T, dir string) {
			res := runInit(t, dir)
			mustMatch(t, `(?s)MISSING.*base_ref`, res.Stdout, "base_ref was not reported as missing")
			if res.Status == 0 {
				t.Fatal("init exited 0 over a base the first gate will refuse to resolve")
			}
		}},
		{"`spec-flow init` through the CLI actually writes the contract", complete(nil), func(t *testing.T, dir string) {
			res := runInit(t, dir)
			if !exists(filepath.Join(dir, ".spec-flow", "config.json")) {
				t.Fatalf("the CLI exited %d and wrote nothing: %s", res.Status, res.Stdout)
			}
		}},
		// ---- scaffolding
		{"it creates the directories and the gitignore line", complete(nil), func(t *testing.T, dir string) {
			runInit(t, dir)
			for _, p := range []string{"specs", filepath.Join("specflow", "archive")} {
				if !exists(filepath.Join(dir, p)) {
					t.Fatalf("%s was not created", p)
				}
			}
			mustMatch(t, `(?m)^\s*\.claude/state/\s*$`, read(filepath.Join(dir, ".gitignore")), ".claude/state/ is not gitignored, so the quiescence guard skips every run after the first")
		}},
		// Two agent contracts tell their reader that `specs/README.md` has the contract.
		{"it scaffolds the capability-spec contract the agents defer to", complete(nil), func(t *testing.T, dir string) {
			runInit(t, dir)
			text := read(filepath.Join(dir, "specs", "README.md"))
			if text == "" {
				t.Fatal("specs/README.md was not created, and two agent contracts point at it")
			}
			for what, re := range map[string]string{"the filename to id-prefix binding": `REQ-USER-`, "the three-digit id format": `(?i)three digits`, "the scope marker": `spec-scope`} {
				mustMatch(t, re, text, "the contract does not state "+what)
			}
		}},
		{"it never overwrites a specs contract the repo already wrote", complete(func(o *initOpts) { o.files = merge(o.files, map[string]string{"specs/README.md": "# ours\n"}) }), func(t *testing.T, dir string) {
			runInit(t, dir, "--force")
			if read(filepath.Join(dir, "specs", "README.md")) != "# ours\n" {
				t.Fatal("a repo's own spec conventions were overwritten")
			}
		}},
		// `scoped_alternative` is the only thing no-gate-cmds offers an implementer it denied.
		{"the scoped alternative init writes names a command the repo actually has", complete(nil), func(t *testing.T, dir string) {
			runInit(t, dir)
			alt := readWritten(t, dir).Unscoped.ScopedAlternative
			m := regexp.MustCompile(`^\S+\s+run\s+(\S+)`).FindStringSubmatch(alt)
			if m == nil {
				t.Fatalf("scoped_alternative is not a \"<pm> run <script>\" invocation: %q", alt)
			}
			var pkg struct{ Scripts map[string]string }
			json.Unmarshal([]byte(read(filepath.Join(dir, "package.json"))), &pkg)
			if pkg.Scripts[m[1]] == "" {
				t.Fatalf("scoped_alternative is %q and package.json declares no %q script: %v", alt, m[1], pkg.Scripts)
			}
		}},
		{"a check script the repo already wrote is never replaced", complete(func(o *initOpts) { o.scripts = merge(o.scripts, map[string]string{"check": "make verify"}) }), func(t *testing.T, dir string) {
			runInit(t, dir, "--force")
			var pkg struct{ Scripts map[string]string }
			json.Unmarshal([]byte(read(filepath.Join(dir, "package.json"))), &pkg)
			if pkg.Scripts["check"] != "make verify" {
				t.Fatalf("the repo's own check script was overwritten with %q", pkg.Scripts["check"])
			}
		}},
		// The suite writes trace.report.path at every gate: left untracked it
		// dirties the tree, and the quiescence guard stops judging.
		{"it gitignores the report it just told the suite to write", complete(nil), func(t *testing.T, dir string) {
			runInit(t, dir)
			w := readWritten(t, dir)
			if w.Trace.Report == nil || w.Trace.Report.Path == "" {
				t.Fatal("this repo got no trace.report, so the case is testing nothing — fix the fixture, not the engine")
			}
			declared := w.Trace.Report.Path
			first := strings.Split(declared, "/")[0] + "/"
			var lines []string
			for _, l := range strings.Split(read(filepath.Join(dir, ".gitignore")), "\n") {
				lines = append(lines, strings.TrimSpace(l))
			}
			if !hasToken(lines, first) && !hasToken(lines, declared) {
				t.Fatalf("neither %s nor %s is gitignored: %q", first, declared, lines)
			}
		}},
		{"it does not duplicate a gitignore line the repo already has", complete(func(o *initOpts) { o.gitignore = strp("node_modules/\n.claude/state/\n") }), func(t *testing.T, dir string) {
			runInit(t, dir)
			if n := len(regexp.MustCompile(`(?m)^\s*\.claude/state/\s*$`).FindAllString(read(filepath.Join(dir, ".gitignore")), -1)); n != 1 {
				t.Fatalf("expected exactly one .claude/state/ line, found %d", n)
			}
		}},
		// ---- never destroy a contract a human has already tuned
		{"an existing contract is never overwritten without --force", complete(func(o *initOpts) { o.existing = strp(`{"mine":true}`) }), func(t *testing.T, dir string) {
			res := runInit(t, dir)
			if !readWritten(t, dir).Mine {
				t.Fatal("init overwrote a contract that was already there")
			}
			if res.Status != 0 {
				t.Fatalf("init failed instead of declining politely: %s", res.Stdout)
			}
			mustMatch(t, `--force`, res.Stdout, "it did not say how to overwrite on purpose")
		}},
		{"--force overwrites it", complete(func(o *initOpts) { o.existing = strp(`{"mine":true}`) }), func(t *testing.T, dir string) {
			runInit(t, dir, "--force")
			if readWritten(t, dir).Mine {
				t.Fatal("--force left the old contract in place")
			}
		}},
		// ---- the contract is a file the team COMMITS: what it names must run
		// on a machine other than the one that wrote it.
		{"the contract names a runnable entrypoint, not the .bin shim", complete(nil), func(t *testing.T, dir string) {
			runInit(t, dir)
			w := readWritten(t, dir)
			for field, argv := range map[string][]string{"lint": w.Verify.Lint, "test": w.Verify.Test} {
				if regexp.MustCompile(`node_modules[\\/]\.bin`).MatchString(strings.Join(argv, " ")) {
					t.Fatalf("verify.%s points into node_modules/.bin (%q): a symlink on POSIX, a sh script on Windows", field, argv)
				}
				needNode(t)
				// The interpreter and its entrypoint only: the rest is the repo's own.
				if r := run(dir, nil, "", argv[0], argv[1]); r.Status != 0 {
					t.Fatalf("verify.%s does not execute as written (%s %s): %s", field, argv[0], argv[1], r.Out())
				}
			}
		}},
		// On POSIX a guard: only the platform with a second separator can fail it.
		{"the contract carries no host-OS path separator", complete(nil), func(t *testing.T, dir string) {
			runInit(t, dir)
			w := readWritten(t, dir)
			for field, argv := range map[string][]string{"lint": w.Verify.Lint, "lint_no_fix": w.Verify.LintNoFix, "test": w.Verify.Test} {
				for _, tok := range argv {
					if strings.Contains(tok, `\`) {
						t.Fatalf("verify.%s = %q: the generating machine's separator, in a file the whole team reads", field, argv)
					}
				}
			}
		}},
		// ADR-027: a contract inside one package is one no gate runs against.
		{"init refuses to write a contract inside a subdirectory of the repository", complete(nil), func(t *testing.T, dir string) {
			back := filepath.Join(dir, "back")
			write(t, filepath.Join(back, "package.json"), toJSON(map[string]any{"name": "back", "scripts": complete(nil).scripts}))
			res := runInit(t, back)
			if exists(filepath.Join(back, ".spec-flow", "config.json")) {
				t.Fatal("a contract was written inside back/")
			}
			if res.Status == 0 {
				t.Fatalf("init reported success from a subdirectory of the repository: %s", res.Stdout)
			}
			mustMatch(t, `repository root`, res.Out(), "the refusal does not name the root to run from")
		}},
		{"init refuses a directory that is in no repository, and writes nothing there", complete(func(o *initOpts) { o.noGit = true }), func(t *testing.T, dir string) {
			res := runInit(t, dir)
			if exists(filepath.Join(dir, ".spec-flow", "config.json")) {
				t.Fatal("a contract was written into a directory that is no repository")
			}
			if res.Status == 0 {
				t.Fatalf("init reported success outside any repository: %s", res.Stdout)
			}
			mustMatch(t, `not inside a git repository`, res.Out(), "the refusal does not name the missing repository")
		}},
		// ---- a repo with nothing to read still gets a starting point
		{"a repo with no package.json still gets a file and a full MISSING list", initOpts{noPkgJSON: true}, func(t *testing.T, dir string) {
			res := runInit(t, dir)
			if !exists(filepath.Join(dir, ".spec-flow", "config.json")) {
				t.Fatal("no contract was written at all")
			}
			if res.Status == 0 {
				t.Fatal("init reported success for a contract with every required field empty")
			}
			mustMatch(t, `MISSING`, res.Stdout, "nothing named the fields a human has to fill")
		}},
	} {
		c := c
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			c.run(t, initRepo2(t, c.opts))
		})
	}

	// B68: a lint script that writes its own fixes was taken as lint_no_fix,
	// so `spec-flow check --no-fix` rewrote a file and printed OK.
	for _, lint := range []string{"eslint --fix .", "eslint . --fix"} {
		lint := lint
		t.Run("a lint script that already fixes is never the report-only variant: "+lint, func(t *testing.T) {
			t.Parallel()
			dir := initRepo2(t, complete(withScripts(map[string]string{"test": "vitest run", "lint": lint})))
			res := runInit(t, dir)
			w := readWritten(t, dir)
			if hasToken(w.Verify.LintNoFix, "--fix") || !hasToken(w.Verify.Lint, "--fix") {
				t.Fatalf("lint %q, lint_no_fix %q", w.Verify.Lint, w.Verify.LintNoFix)
			}
			if hasToken(w.Verify.Lint, ".") || hasToken(w.Verify.LintNoFix, ".") {
				t.Fatalf("the target \".\" was kept after a flag that takes no value: lint %q, lint_no_fix %q", w.Verify.Lint, w.Verify.LintNoFix)
			}
			mustMatch(t, `REVIEW\s+verify\.lint_no_fix — the "lint" script carries --fix`, res.Stdout, "the dropped flag was not reported")
			mustNotMatch(t, `no autofix script was declared`, res.Stdout, "init says no autofix was declared over a script that carries one")
		})
	}
	const expands = "expands something only a shell can"
	for _, c := range []struct {
		scripts    map[string]string
		field, why string
	}{
		{map[string]string{"test": "vitest run", "lint": `eslint "$PWD/src"`}, "lint", expands},
		{map[string]string{"test": "jest $JEST_FLAGS", "lint": "eslint ."}, "test", expands},
		{map[string]string{"test": "jest `cat list.txt`", "lint": "eslint ."}, "test", expands},
		{map[string]string{"test": "vitest run", "lint": "eslint lib # the sources"}, "lint", expands},
		{map[string]string{"test": `NODE_OPTIONS="--experimental-vm-modules" jest`, "lint": "eslint ."}, "test", "sets an environment variable"},
		{map[string]string{"test": "NODE_ENV=test vitest run", "lint": "eslint ."}, "test", "sets an environment variable"},
		{map[string]string{"test": "npm run test:unit", "test:unit": "vitest run", "lint": "eslint ."}, "test", "runs a package script through the package manager"},
	} {
		c := c
		t.Run("a script only a shell can read is left to the human, with the reason: "+c.scripts[c.field], func(t *testing.T) {
			t.Parallel()
			dir := initRepo2(t, complete(withScripts(c.scripts)))
			res := runInit(t, dir)
			w := readWritten(t, dir)
			argv := w.Verify.Test
			if c.field == "lint" {
				argv = w.Verify.Lint
			}
			if len(argv) > 0 {
				t.Fatalf("init wrote verify.%s %q", c.field, argv)
			}
			mustMatch(t, `MISSING\s+verify\.`+c.field+`.*`+regexp.QuoteMeta(c.why), res.Stdout, "the refusal does not say why")
		})
	}
	for _, c := range []struct {
		key  map[string]string
		want string
	}{
		{map[string]string{"outputDirectory": "out"}, "out/junit.xml"},
		{map[string]string{"outputDirectory": "out", "outputName": "results.xml"}, "out/results.xml"},
		{map[string]string{"outputFile": "./test-results/jest.xml"}, "test-results/jest.xml"},
		{map[string]string{"outputDirectory": "<rootDir>/out"}, ""},
	} {
		c := c
		t.Run("the report path is read from the jest-junit key the repo wrote, never written over: "+toJSON(c.key), func(t *testing.T) {
			t.Parallel()
			scripts := map[string]string{"test": "jest", "lint": "eslint ."}
			dir := initRepo2(t, complete(func(o *initOpts) {
				o.scripts = scripts
				o.files = merge(o.files, map[string]string{"package.json": toJSON(map[string]any{"name": "fixture", "scripts": scripts, "jest-junit": c.key})})
			}))
			res := runInit(t, dir)
			var pkg struct {
				JestJunit map[string]string `json:"jest-junit"`
			}
			json.Unmarshal([]byte(read(filepath.Join(dir, "package.json"))), &pkg)
			if toJSON(pkg.JestJunit) != toJSON(c.key) {
				t.Fatalf("the repo's own key became %v", pkg.JestJunit)
			}
			if c.want == "" {
				mustMatch(t, `MISSING\s+trace\.report\.path — the "jest-junit" key`, res.Stdout, "a path only jest resolves was not reported")
				return
			}
			if w := readWritten(t, dir); w.Trace.Report == nil || w.Trace.Report.Path != c.want {
				t.Fatalf("trace.report is %+v, want path %s", w.Trace.Report, c.want)
			}
		})
	}
	// A fix script running another command than the lint script's was taken
	// as its autofix: the gate ran a formatter on every changed file.
	for _, c := range []struct {
		scripts map[string]string
		problem func(w written, out string) bool
	}{
		{map[string]string{"lint": "eslint lib", "format": "prettier --write lib"}, func(w written, out string) bool {
			return strings.Contains(strings.Join(w.Verify.Lint, " "), "prettier") || !regexp.MustCompile(`REVIEW\s+verify\.lint — the "format" script`).MatchString(out)
		}},
		{map[string]string{"lint": "biome lint ./lib", "format": "biome format --write ./lib"}, func(w written, out string) bool { return hasToken(w.Verify.Lint, "format") }},
		{map[string]string{"format": "prettier --write ."}, func(w written, out string) bool {
			return len(w.Verify.Lint) > 0 || !strings.Contains(out, `"format" is not read as one`)
		}},
		{map[string]string{"lint": "eslint . && prettier --check .", "format": "prettier --write ."}, func(w written, out string) bool { return len(w.Verify.Lint) > 0 }},
	} {
		c := c
		t.Run("a formatter is never taken as the linter, or as its autofix: "+toJSON(c.scripts), func(t *testing.T) {
			t.Parallel()
			dir := initRepo2(t, complete(withScripts(merge(map[string]string{"test": "vitest run"}, c.scripts))))
			res := runInit(t, dir)
			if w := readWritten(t, dir); c.problem(w, res.Stdout) {
				t.Fatalf("lint: %q\n%s", w.Verify.Lint, res.Stdout)
			}
		})
	}
}
