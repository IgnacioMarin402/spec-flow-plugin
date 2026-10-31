package cli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/IgnacioMarin402/spec-flow-plugin/internal/argv"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/contract"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/gitscope"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/jsre"
)

// `spec-flow init` generates the repository's `.spec-flow/config.json`, its
// directories and its `.gitignore` lines. Nothing here guesses a value it
// cannot support: every field lands in one of three buckets — detected (read
// from what the repository declares), REVIEW (a heuristic, confirm it), and
// MISSING (left empty, so the contract does not validate until a human fills
// it). The runner comes from the repository's own `test` script (ADR-002).

var skipDirs = map[string]bool{"node_modules": true, ".git": true, "dist": true, "build": true, "coverage": true, ".next": true, "out": true, "vendor": true, ".claude": true}
var sourceExtensions = map[string]bool{".ts": true, ".tsx": true, ".js": true, ".jsx": true, ".mjs": true, ".cjs": true}

// Package managers precede the real binary as `<pm> run|exec <bin>`; only
// that exact shape is stripped, since a bare `<pm> <word>` may be a script.
var packageManagers = map[string]bool{"npm": true, "pnpm": true, "yarn": true, "bun": true}

func sourceFiles(root, dir string, found []string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return found
	}
	for _, e := range entries {
		if skipDirs[e.Name()] {
			continue
		}
		full := filepath.Join(dir, e.Name())
		st, err := os.Stat(full)
		if err != nil {
			continue // a dangling symlink is not a source file
		}
		if st.IsDir() {
			found = sourceFiles(root, full, found)
		} else if sourceExtensions[filepath.Ext(e.Name())] {
			found = append(found, full[len(root)+1:])
		}
	}
	return found
}

var (
	shellToken    = jsre.MustCompile(`[^\S\n]+|'([^']*)'|"([^"]*)"|[^\s'"]+|[\s\S]`, "")
	blank         = regexp.MustCompile(`^[^\S\n]+$`)
	chainChar     = regexp.MustCompile(`[&|;<>()\n]`)
	expandChar    = regexp.MustCompile("[$`\\\\]")
	quoteOnly     = regexp.MustCompile(`^["']$`)
	leadingAssign = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*=`)
)

// shellWords are the words a shell would hand the runner, quotes removed, or
// why only a shell can say. Keeping the quote characters reads as working:
// `--spec "test/**/*.spec.js"` reaches the runner literally and matches no file.
func shellWords(script string) (words []string, why string) {
	var word *string
	for _, m := range shellToken.ExecAll(script) {
		token := m.Text()
		quoted := m.Has(1) || m.Has(2)
		if !quoted && blank.MatchString(token) {
			if word != nil {
				words = append(words, *word)
			}
			word = nil
			continue
		}
		if !quoted && chainChar.MatchString(token) {
			return nil, "it chains or redirects commands, so it is not one runner invocation"
		}
		inside := token
		if quoted {
			inside = m.Group(2)
		}
		if quoteOnly.MatchString(token) || expandChar.MatchString(inside) || (!quoted && word == nil && strings.HasPrefix(token, "#")) {
			return nil, "it expands something only a shell can: a $, a backquote, a backslash, a comment or a quote that does not close"
		}
		part := token
		switch {
		case m.Has(1):
			part = m.Group(1)
		case m.Has(2):
			part = m.Group(2)
		}
		w := part
		if word != nil {
			w = *word + part
		}
		word = &w
	}
	if word != nil {
		words = append(words, *word)
	}
	if len(words) > 0 && leadingAssign.MatchString(words[0]) {
		return nil, "it sets an environment variable ahead of the command, which takes a shell"
	}
	return words, ""
}

type script struct {
	bin   string
	args  []string
	named bool // the bin is the runner's name, not an interpreter's
}

func parseScript(words []string) *script {
	t := append([]string{}, words...)
	if len(t) > 0 && t[0] == "npx" {
		t = t[1:]
	}
	if len(t) > 1 && packageManagers[t[0]] && (t[1] == "run" || t[1] == "exec") {
		t = t[2:]
	}
	for len(t) > 0 && t[0] == "--" {
		t = t[1:]
	}
	if len(t) == 0 {
		return nil
	}
	// `bun test`: the runtime IS the runner, and the name is real.
	return &script{t[0], t[1:], !argv.Runtimes[t[0]] || (len(t) > 1 && t[1] == "test")}
}

type pkgJSON map[string]any

func (p pkgJSON) scripts() map[string]string {
	out := map[string]string{}
	if m, ok := p["scripts"].(map[string]any); ok {
		for k, v := range m {
			if s, ok := v.(string); ok {
				out[k] = s
			} else if v != nil {
				out[k] = fmt.Sprint(v)
			}
		}
	}
	return out
}

// readScript is the script name, parsed for the contract, or why it cannot be.
// A package manager or another script's name, spawned with no shell, fails at
// every gate.
func readScript(scripts map[string]string, name string) (*script, string) {
	s := scripts[name]
	if s == "" {
		return nil, ""
	}
	words, why := shellWords(s)
	if why != "" {
		return nil, why
	}
	parsed := parseScript(words)
	if parsed == nil {
		return nil, "it names no command"
	}
	if _, isScript := scripts[parsed.bin]; (packageManagers[parsed.bin] && !argv.Runtimes[parsed.bin]) || isScript {
		return nil, "it runs a package script through the package manager, and this engine spawns one command with no shell"
	}
	return parsed, ""
}

type argvResult struct{ argv, stripped, remaining []string }

// toArgv prefers the local binary, past the `.bin` shim (ADR-011). Targets
// are stripped for the two argvs the engine APPENDS changed paths to: `eslint
// . <changed-file>` lints the whole repository, a disarmed scope.
func toArgv(root string, s *script, strip bool) argvResult {
	args := argvResult{argv: s.args}
	if strip {
		args.argv, args.stripped, args.remaining = argv.StripTargets(s.args, root)
	}
	if entry := argv.ResolveLocalBin(root, s.bin); entry != "" {
		args.argv = append([]string{"node", entry}, args.argv...)
	} else {
		args.argv = append([]string{s.bin}, args.argv...)
	}
	return args
}

// The flags with which a Node linter writes its fixes; each takes no value.
var autofixFlags = map[string]bool{"--fix": true, "--write": true}

func withoutAutofix(s *script) *script {
	c := *s
	c.args = nil
	for _, a := range s.args {
		if !autofixFlags[a] {
			c.args = append(c.args, a)
		}
	}
	return &c
}

func autofixOf(s *script) []string {
	var out []string
	for _, a := range s.args {
		if autofixFlags[a] {
			out = append(out, a)
		}
	}
	return out
}

func findConfigFile(root, bin string) string {
	if bin == "" {
		return ""
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return ""
	}
	for _, e := range entries {
		l := strings.ToLower(e.Name())
		if strings.HasPrefix(l, bin+".config.") || strings.HasPrefix(l, "."+bin+"rc") || l == bin+".json" {
			return e.Name()
		}
	}
	return ""
}

// rank is the keys of counts, most first, ties in first-seen order.
func rank(order []string, counts map[string]int) []string {
	out := append([]string{}, order...)
	sort.SliceStable(out, func(i, j int) bool { return counts[out[i]] > counts[out[j]] })
	return out
}

// detectScopeGlobs: the source extensions carrying real weight, capped.
func detectScopeGlobs(files []string) []string {
	var order []string
	counts := map[string]int{}
	for _, f := range files {
		e := filepath.Ext(f)
		if _, ok := counts[e]; !ok {
			order = append(order, e)
		}
		counts[e]++
	}
	var out []string
	for _, e := range rank(order, counts) {
		if counts[e] >= 3 && len(out) < 4 {
			out = append(out, "*"+e)
		}
	}
	return out
}

var testSuffixRe = regexp.MustCompile(`(?i)(\.(?:test|spec)\.[a-z]+)$`)

func testSuffix(f string) string {
	if m := testSuffixRe.FindStringSubmatch(f); m != nil {
		return strings.ToLower(m[1])
	}
	return ""
}

// detectProof is where tests live, as a directory SEGMENT and a suffix. A
// segment in test paths and no other identifies a test by itself; with none
// exclusive, the most common is offered for REVIEW.
func detectProof(files []string) (suffix, dir string, confident bool) {
	var tests, others []string
	for _, f := range files {
		if testSuffix(f) != "" {
			tests = append(tests, f)
		} else {
			others = append(others, f)
		}
	}
	if len(tests) == 0 {
		return "", "", false
	}
	var sOrder []string
	sCounts := map[string]int{}
	for _, f := range tests {
		s := testSuffix(f)
		if _, ok := sCounts[s]; !ok {
			sOrder = append(sOrder, s)
		}
		sCounts[s]++
	}
	suffix = rank(sOrder, sCounts)[0]
	segments := func(f string) []string {
		parts := strings.Split(f, string(filepath.Separator))
		return parts[:len(parts)-1]
	}
	var order []string
	inTests := map[string]int{}
	for _, f := range tests {
		seen := map[string]bool{}
		for _, s := range segments(f) {
			if seen[s] {
				continue
			}
			seen[s] = true
			if _, ok := inTests[s]; !ok {
				order = append(order, s)
			}
			inTests[s]++
		}
	}
	inOthers := map[string]bool{}
	for _, f := range others {
		for _, s := range segments(f) {
			inOthers[s] = true
		}
	}
	ranked := rank(order, inTests)
	for _, s := range ranked {
		if !inOthers[s] {
			return suffix, s, true
		}
	}
	if len(ranked) > 0 {
		return suffix, ranked[0], false
	}
	return suffix, "", false
}

func detectPackageManager(root string) string {
	for _, l := range [][2]string{{"pnpm-lock.yaml", "pnpm"}, {"yarn.lock", "yarn"}, {"bun.lockb", "bun"}} {
		if _, err := os.Stat(filepath.Join(root, l[0])); err == nil {
			return l[1]
		}
	}
	return "npm"
}

// jestJunitPath is where jest-junit writes when the gate runs it from the
// root: its "jest-junit" key in package.json, else junit.xml. `""` when the
// key names a path only jest resolves.
func jestJunitPath(pkg pkgJSON) (string, bool) {
	opts, _ := pkg["jest-junit"].(map[string]any)
	str := func(k, def string) string {
		if v, ok := opts[k]; ok && v != nil {
			return fmt.Sprint(v)
		}
		return def
	}
	if str("uniqueOutputName", "") == "true" {
		return "", false
	}
	p := str("outputFile", path.Join(str("outputDirectory", "."), str("outputName", "junit.xml")))
	if strings.Contains(p, "<rootDir>") {
		return "", false
	}
	return path.Clean(strings.ReplaceAll(p, `\`, "/")), true
}

// reporter is how a supported runner is told to write a report. This table
// is what ADR-002 refused and ADR-007 allows back, small on purpose: every
// entry was verified by running the runner and reading the file it wrote.
type reporter struct {
	argv       func(path string) []string
	path       func(pkgJSON) (string, bool)
	unreadable string
	note       func(path string) string
}

var reporterFlags = map[string]reporter{
	"vitest": {argv: func(p string) []string { return []string{"--reporter=junit", "--outputFile=" + p} }},
	"mocha":  {argv: func(p string) []string { return []string{"--reporter", "xunit", "--reporter-option", "output=" + p} }},
	"node":   {argv: func(p string) []string { return []string{"--test-reporter=junit", "--test-reporter-destination=" + p} }},
	"jest": {
		argv:       func(string) []string { return []string{"--reporters=default", "--reporters=jest-junit"} },
		path:       jestJunitPath,
		unreadable: `the "jest-junit" key in package.json names a path only jest resolves (<rootDir>, or a unique name)`,
		note: func(p string) string {
			return fmt.Sprintf(`jest reports through a separate package: install jest-junit as a devDependency. "%s" is where it writes as this repo sets it — its "jest-junit" key in package.json, or junit.xml where jest runs — so the repo's own runs report where they did. `, p) +
				"The flag alone will not write the file, which is why this is the one entry that cannot be finished from argv."
		},
	},
}

// reporterKey: `"test": "node --test"` names its runner only by the flag.
func reporterKey(test []string, testName string) string {
	if _, ok := reporterFlags[testName]; testName != "" && ok {
		return testName
	}
	if len(test) > 0 && argv.Basename(test[0]) == "node" && contains(test, "--test") {
		return "node"
	}
	return ""
}

var xmlPath = regexp.MustCompile(`(?i)\.xml$`)

// detectReportPath is a report PATH the test command already names — a fact
// about this repository, not one runner's flag spelling.
func detectReportPath(test []string) string {
	for _, t := range test {
		v := t
		if i := strings.Index(t, "="); i >= 0 {
			v = t[i+1:]
		}
		if xmlPath.MatchString(v) && !strings.HasPrefix(v, "-") {
			return strings.ReplaceAll(v, `\`, "/")
		}
	}
	return ""
}

func quoteEach(list []string) string {
	q := make([]string, len(list))
	for i, s := range list {
		q[i] = `"` + s + `"`
	}
	return strings.Join(q, ", ")
}

func uniqueOf(lists ...[]string) []string {
	var out []string
	for _, l := range lists {
		for _, s := range l {
			if !contains(out, s) {
				out = append(out, s)
			}
		}
	}
	return out
}

type extraCheck struct {
	Name  string   `json:"name"`
	Field string   `json:"field"`
	Cmd   []string `json:"cmd"`
	Green string   `json:"green"`
	Hint  string   `json:"hint"`
}

// The contract as written, field order as a reader expects it.
type contractFile struct {
	ContractVersion int `json:"contract_version"`
	Verify          struct {
		ScopeGlobs     []string `json:"scope_globs"`
		Lint           []string `json:"lint"`
		LintNoFix      []string `json:"lint_no_fix"`
		Test           []string `json:"test"`
		TestName       string   `json:"test_name"`
		LintName       string   `json:"lint_name"`
		LintConfigHint string   `json:"lint_config_hint"`
	} `json:"verify"`
	Trace struct {
		SpecsDir    string `json:"specs_dir"`
		ProofDir    string `json:"proof_dir"`
		ProofSuffix string `json:"proof_suffix"`
		// The engine parses this file itself; `executed_tests` is absent,
		// not empty: the contract rejects declaring both.
		Report struct {
			Format string `json:"format"`
			Path   string `json:"path"`
		} `json:"report"`
		NotACapability []string `json:"not_a_capability"`
		// Written at its default so the choice is visible in the file.
		RequireSkillsField bool `json:"require_skills_field"`
	} `json:"trace"`
	ExtraChecks    []extraCheck `json:"extra_checks"`
	UnscopedDenied struct {
		Scripts           []string `json:"scripts"`
		Tools             []string `json:"tools"`
		ScopedAllowed     []string `json:"scoped_allowed"`
		ScopedAlternative string   `json:"scoped_alternative"`
		ScopedExamples    []string `json:"scoped_examples"`
	} `json:"unscoped_denied"`
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

// BuildContract is the contract for root and what each field came from.
func BuildContract(root string) (c *contractFile, detected, review, missing []string) {
	var pkg pkgJSON
	if b, err := os.ReadFile(filepath.Join(root, "package.json")); err == nil {
		_ = json.Unmarshal(b, &pkg)
	}
	if pkg == nil {
		pkg = pkgJSON{}
	}
	scripts := pkg.scripts()
	files := sourceFiles(root, root, nil)
	pm := detectPackageManager(root)

	// --- test runner
	var test []string
	testName := ""
	testScript, testWhy := readScript(scripts, "test")
	if testScript != nil {
		test = toArgv(root, testScript, false).argv
		detected = append(detected, "verify.test — from the \"test\" script: "+strings.Join(test, " "))
		switch {
		case testScript.named:
			testName = testScript.bin
		case reporterKey(test, "") == "node":
			// The pair is its name: run-trace spots `node --test …`, not `node script.mjs`.
			testName = "node --test"
			detected = append(detected, "verify.test_name — node --test: node's own test runner, named with the flag that makes it one")
		default:
			missing = append(missing, fmt.Sprintf(`verify.test_name — the test script runs through "%s", an interpreter rather than a runner, so nothing here can name what actually runs your tests. It labels the gate's log sections and is matched against Bash commands to spot a test run, so a wrong value is worse than an empty one.`, testScript.bin))
		}
	} else if testWhy != "" {
		missing = append(missing, fmt.Sprintf(`verify.test and verify.test_name — the "test" script (%s) could not be read: %s. Write the argv by hand, one token per array element and no quotes around any of them.`, scripts["test"], testWhy))
	} else {
		missing = append(missing, `verify.test and verify.test_name — no single-command "test" script to read them from.`)
	}

	// --- linter. An autofix variant only when the repository declares one,
	// and only when it runs the lint script's own command: a formatter in
	// "format" would run at every gate in the linter's place.
	lintScript, lintWhy := readScript(scripts, "lint")
	fixName := ""
	if scripts["lint:fix"] != "" {
		fixName = "lint:fix"
	} else if scripts["format"] != "" {
		fixName = "format"
	}
	var declaredFix *script
	fixWhy := ""
	if fixName != "" {
		declaredFix, fixWhy = readScript(scripts, fixName)
	}
	command := func(s *script) string {
		kept, _, _ := argv.StripTargets(withoutAutofix(s).args, root)
		return strings.Join(append([]string{s.bin}, kept...), "\x00")
	}
	var fixScript *script
	if declaredFix != nil && ((lintScript != nil && command(declaredFix) == command(lintScript)) || (lintScript == nil && fixName == "lint:fix")) {
		fixScript = declaredFix
	}
	base, baseName := lintScript, "lint"
	if base == nil {
		base, baseName = fixScript, fixName
	}
	var lint, lintNoFix []string
	lintName := ""
	if base != nil {
		if base.named {
			lintName = base.bin
		} else {
			missing = append(missing, fmt.Sprintf(`verify.lint_name — the lint script runs through "%s", an interpreter rather than a linter, so nothing here can name it.`, base.bin))
		}
		// A script that already writes fixes cannot be the report-only variant:
		// `spec-flow check --no-fix` would rewrite files and pass.
		carried := autofixOf(base)
		noFix := toArgv(root, withoutAutofix(base), true)
		withFix := noFix
		if fixScript != nil {
			withFix = toArgv(root, withoutAutofix(fixScript), true)
			withFix.argv = append(withFix.argv, autofixOf(fixScript)...)
		}
		lintNoFix = noFix.argv
		lint = append(append([]string{}, noFix.argv...), carried...)
		if fixScript != nil {
			lint = withFix.argv
		}
		if stripped := uniqueOf(noFix.stripped, withFix.stripped); len(stripped) > 0 {
			review = append(review, fmt.Sprintf("verify.lint dropped the target(s) %s from your lint script. The engine appends the changed files itself, and leaving a target in would lint the whole repo on every gate — which silently undoes the scoping that keeps a milestone from being blocked by debt it never touched. Confirm this is still the linter invocation you want.", quoteEach(stripped)))
		}
		// After a flag a path cannot be told from that flag's value: left, and said.
		if remaining := uniqueOf(noFix.remaining, withFix.remaining); len(remaining) > 0 {
			review = append(review, fmt.Sprintf("verify.lint still contains %s, which follows a flag — so it may be that flag's value, or it may be a target. If it is a target, remove it: the engine appends the changed files itself, and a target left in makes every gate lint the whole repo instead of the branch's changes.", quoteEach(remaining)))
		}
		if len(carried) > 0 {
			review = append(review, fmt.Sprintf(`verify.lint_no_fix — the "%s" script carries %s, so it writes fixes; that flag was left out of the report-only variant spec-flow check --no-fix runs: %s. Confirm it reports without writing.`, baseName, strings.Join(carried, ", "), strings.Join(lintNoFix, " ")))
		} else {
			detected = append(detected, fmt.Sprintf(`verify.lint_no_fix — from the "%s" script: %s`, baseName, strings.Join(lintNoFix, " ")))
		}
		switch {
		case fixName == "lint:fix" && fixWhy != "":
			review = append(review, fmt.Sprintf(`verify.lint — the "lint:fix" script (%s) could not be read as the autofix: %s. Add the flag to verify.lint by hand if it is one.`, scripts["lint:fix"], fixWhy))
		case declaredFix != nil && fixScript == nil:
			review = append(review, fmt.Sprintf(`verify.lint — the "%s" script (%s) is not the "lint" script with an autofix flag, so it was not taken as the linter's autofix: %s.`, fixName, scripts[fixName], strings.Join(lint, " ")))
		case fixScript != nil && fixScript != base:
			detected = append(detected, "verify.lint — from the autofix script: "+strings.Join(lint, " "))
		case len(carried) > 0:
			detected = append(detected, fmt.Sprintf(`verify.lint — from the "%s" script, which already fixes: %s`, baseName, strings.Join(lint, " ")))
		default:
			review = append(review, "verify.lint is identical to verify.lint_no_fix — no autofix script was declared. If your linter supports one (commonly --fix), add it to verify.lint so the gate stops reporting violations it could have fixed.")
		}
	} else {
		why := lintWhy
		if why == "" && fixName == "lint:fix" {
			why = fixWhy
		}
		if why != "" {
			missing = append(missing, fmt.Sprintf("verify.lint, verify.lint_no_fix and verify.lint_name — the lint script could not be read: %s. Write the argv by hand, one token per array element and no quotes around any of them.", why))
		} else {
			tail := ""
			if fixName == "format" {
				tail = ` ("format" is not read as one: it may run a formatter)`
			}
			missing = append(missing, `verify.lint, verify.lint_no_fix and verify.lint_name — no single-command "lint" script to read them from`+tail+".")
		}
	}
	hint := findConfigFile(root, lintName)
	switch {
	case hint != "":
		detected = append(detected, "verify.lint_config_hint — found "+hint)
	case lintName != "":
		missing = append(missing, "verify.lint_config_hint — no config file for the linter was found in the repo root.")
	default:
		missing = append(missing, "verify.lint_config_hint — depends on the linter, which was not detected.")
	}

	// --- build and typecheck: REVIEW either way — optional, and whether one
	// belongs at every gate is the adopter's call.
	var extras []extraCheck
	for _, name := range []string{"build", "typecheck"} {
		if scripts[name] == "" {
			continue
		}
		parsed, why := readScript(scripts, name)
		if parsed == nil {
			review = append(review, fmt.Sprintf(`extra_checks — the "%s" script (%s) was not offered: %s. Nothing runs it during a run; to have one, add an entry by hand, one argv token per array element and no quotes around any of them.`, name, scripts[name], why))
			continue
		}
		cmd := toArgv(root, parsed, false).argv
		extras = append(extras, extraCheck{name, name, cmd, fmt.Sprintf(`(the "%s" script passes)`, name), fmt.Sprintf(`The repo's "%s" script fails: fix what it reports.`, name)})
		msg := fmt.Sprintf(`extra_checks — offered "%s" from the "%s" script: %s. It runs at every gate, at done and in spec-flow check, inside the same Stop-hook time budget as the suite. Remove it if it needs a database, a network or a running app.`, name, name, strings.Join(cmd, " "))
		if name == "build" {
			msg += " What it writes must be gitignored: any output git sees reads as an unfinished write at the next stop, and that gate is skipped."
		}
		review = append(review, msg)
	}

	scope := detectScopeGlobs(files)
	if len(scope) > 0 {
		detected = append(detected, "verify.scope_globs — "+strings.Join(scope, ", ")+", from the files in this repo")
	} else {
		missing = append(missing, "verify.scope_globs — no source extension had enough files to infer one.")
	}
	if _, err := gitscope.ResolveBase(root, nil); err == nil {
		detected = append(detected, "verify.base_ref — omitted: the base branch resolves automatically here")
	} else {
		missing = append(missing, `verify.base_ref — no base branch could be resolved. Set it to the ref this work is judged against, e.g. "origin/trunk".`)
	}
	suffix, dir, confident := detectProof(files)
	switch {
	case suffix != "" && confident:
		detected = append(detected, fmt.Sprintf(`trace.proof_dir and trace.proof_suffix — "%s" + "%s"`, dir, suffix))
	case suffix != "":
		review = append(review, fmt.Sprintf(`trace.proof_dir is "%s" — a guess. Your tests are not in a directory of their own, so no segment identifies one. This is also where agents are told to PUT new tests, so confirm it.`, dir))
	default:
		missing = append(missing, "trace.proof_dir and trace.proof_suffix — no test files were found. These say what a proof file looks like AND where agents put new ones.")
	}

	// --- how this repository reports what RAN: REVIEW, never MISSING — a
	// repository with no requirement yet owes nothing (ADR-005). The flag is
	// APPENDED, not described: a flag a human still has to type is the step
	// the table exists to remove.
	named := detectReportPath(test)
	runner := ""
	if named == "" {
		runner = reporterKey(test, testName)
	}
	flag, hasFlag := reporterFlags[runner]
	reportPath := named
	runnerUnreadable := false
	if reportPath == "" && hasFlag && flag.path != nil {
		if p, ok := flag.path(pkg); ok {
			reportPath = p
		} else {
			runnerUnreadable = true
		}
	}
	if reportPath == "" {
		reportPath = "reports/junit.xml"
	}
	if runnerUnreadable {
		missing = append(missing, fmt.Sprintf("trace.report.path — %s, so nothing here can read where the report lands. Set it to the file %s writes.", flag.unreadable, runner))
	}
	switch {
	case named != "":
		review = append(review, fmt.Sprintf(`trace.report — your test command already names "%s", so the contract points at it and assumes JUnit XML. Confirm that is what lands there; if it is TAP, change the format to "tap".`, named))
	case hasFlag:
		added := flag.argv(reportPath)
		test = append(test, added...)
		note := ""
		if flag.note != nil {
			note = " " + flag.note(reportPath)
		}
		review = append(review, fmt.Sprintf("verify.test — appended `%s` so %s writes the report the traceability check reads. ", strings.Join(added, " "), runner)+
			fmt.Sprintf(`Run your suite once and confirm "%s" appears.%s`, reportPath, note))
	default:
		because := ""
		if testName != "" {
			because = fmt.Sprintf(`, because "%s" is not a runner this version knows the reporter flag for`, testName)
		}
		review = append(review, fmt.Sprintf(`trace.report — set to "%s", a convention rather than a reading%s. `, reportPath, because)+
			"Add your runner's flag to verify.test so a JUnit XML (or TAP) report lands there — the format is what tells a skipped test from an executed one. "+
			"Until it lands, traceability is off — the gate still lints and tests, and spec-trace refuses the moment specs/ declares a requirement it cannot prove. "+
			"A runner with no standard report uses trace.executed_tests instead: see REFERENCE.md.")
	}

	c = &contractFile{ContractVersion: 1}
	c.Verify.ScopeGlobs, c.Verify.Lint, c.Verify.LintNoFix, c.Verify.Test = nonNil(scope), nonNil(lint), nonNil(lintNoFix), nonNil(test)
	c.Verify.TestName, c.Verify.LintName, c.Verify.LintConfigHint = testName, lintName, hint
	c.Trace.SpecsDir, c.Trace.ProofDir, c.Trace.ProofSuffix = "specs", dir, suffix
	c.Trace.Report.Format, c.Trace.Report.Path = "junit", reportPath
	c.Trace.NotACapability = []string{"README.md", "glossary.md"}
	c.ExtraChecks = extras
	if c.ExtraChecks == nil {
		c.ExtraChecks = []extraCheck{}
	}
	var deny []string
	for _, s := range []string{"test", "lint"} {
		if scripts[s] != "" {
			deny = append(deny, s)
		}
	}
	// no-gate-cmds compares one token at a time: `node --test` could never
	// match, and `node` alone would deny every node command.
	var tools []string
	for _, n := range []string{testName, lintName} {
		if n != "" && !strings.ContainsAny(n, " \t") {
			tools = append(tools, n)
		}
	}
	c.UnscopedDenied.Scripts, c.UnscopedDenied.Tools = nonNil(deny), nonNil(tools)
	c.UnscopedDenied.ScopedAllowed = []string{"check"}
	c.UnscopedDenied.ScopedAlternative = pm + " run check"
	c.UnscopedDenied.ScopedExamples = []string{pm + " run check", pm + " run check --no-fix"}
	return c, detected, review, missing
}

const specsReadme = "# Capability specs\n\n" +
	"One file per capability, describing what the system does **today** as numbered\n" +
	"requirements. `specs/` is the source of truth for behaviour; a change under\n" +
	"`specflow/` is a delta against it.\n\n" +
	"`spec-trace` enforces the rules below at every gate, in both directions: a\n" +
	"requirement with no test fails, and a test naming an id no spec declares fails\n" +
	"too.\n\n" +
	"## The file\n\n" +
	"Each spec starts with a scope marker naming the code it is about:\n\n" +
	"```markdown\n<!-- spec-scope: modules/user -->\n\n# User\n\n### REQ-USER-001 — the user can reset their password by email\n\nThe system sends a single-use link, valid for one hour.\n```\n\n" +
	"## The rules\n\n" +
	"- **The id prefix comes from the filename.** `specs/user.md` declares\n  `REQ-USER-` ids; `specs/user-profile.md` declares `REQ-USER-PROFILE-`.\n  A mismatch fails.\n" +
	"- **The number is exactly three digits.** `REQ-USER-001`, not `REQ-USER-1`.\n" +
	"- **Requirements are headings**, at `###`, with the id first. The separator\n  after it may be an em dash, a hyphen or a colon.\n" +
	"- **Ids are permanent.** Never renumber, never reuse a removed one. New ids\n  continue that capability's sequence.\n" +
	"- **Every requirement needs a test whose TITLE contains its id**, on the proof\n  surface `.spec-flow/config.json` declares (`trace.proof_dir` +\n  `trace.proof_suffix`). A test under `it.skip`, `it.todo`, `xit` or\n  `xtest` does not count — a test that never executes proves nothing.\n" +
	"- **Write in the present tense**: what the system does, not what a change did.\n\n" +
	"This file is excluded from the check by `trace.not_a_capability`, so it is\ndocumentation rather than a spec.\n"

// translatorStub is the `trace.executed_tests` translator, scaffolded into
// the adopting repository for a runner with no standard report. Not silent
// when unfinished: a stub reporting nothing would make every requirement
// unproven at the first gate.
func translatorStub(testName string) string {
	runner := "your test runner"
	if testName != "" {
		runner = "`" + testName + "`"
	}
	return `#!/usr/bin/env node
// Tells spec-flow which tests actually RAN.
//
// The contract is one line per executed test, on stdout, each line containing
// that test's name. A requirement counts as proven when a reported line
// contains its id (REQ-USER-001). Nothing else is read: not the exit code, not
// the format, not where the test file lives.
//
// TWO RULES, and the second is the one that matters:
//
//   1. Lines must carry test NAMES, since ids are matched inside them. An id
//      may sit against underscores — REQ-USER-001_rejects binds fine.
//   2. A test that was SKIPPED must not appear. That absence is what makes
//      skipping useless as a way to silence a red suite, and it is why the
//      rule holds in any language.
//
// This runs AFTER the suite, in the same gate invocation, so it should read
// what that run produced rather than run the tests again.
//
// ---------------------------------------------------------------------------
// TODO — this is the part only you can write. It was left empty on purpose:
// every runner can report what it executed and no two agree on how, so a
// guess here would produce a command that runs and reports nothing.
//
// For ` + runner + `: find the reporter flag that writes a machine-readable report
// (most runners have one — JUnit XML, JSON, TAP), have your test command emit
// it, then read that file here and print one line per test that RAN.
// ---------------------------------------------------------------------------

function testsThatRan() {
  // Return an array of strings, one per executed test, e.g.
  //   ['tests/auth_test::REQ-USER-001 rejects a bad password']
  return null; // <- replace this
}

const names = testsThatRan();

if (names === null) {
  console.error(
    'spec-flow: .spec-flow/tests-that-ran.mjs has not been written yet.\n' +
      'Until it reports the tests that ran, no requirement can be proven — and this\n' +
      'fails loudly rather than reporting your specs as unproven, which would be the\n' +
      'same mistake this check exists to catch. See REFERENCE.md, "executed_tests".',
  );
  process.exit(1);
}

for (const name of names) console.log(name);
`
}

var indentRe = regexp.MustCompile(`\n([ \t]+)"`)

// ensureCheckScript adds the `check` alias the deny hook points an
// implementer at, when the repository has none. Never replaces one the
// repository wrote. It runs `spec-flow` from PATH, never `npx`: npx in a
// repository without it reaches the registry, where the name is unrelated.
func ensureCheckScript(root string) string {
	p := filepath.Join(root, "package.json")
	raw, err := os.ReadFile(p)
	if err != nil {
		return ""
	}
	var probe map[string]any
	if json.Unmarshal(raw, &probe) != nil || probe == nil {
		return ""
	}
	if s, ok := probe["scripts"].(map[string]any); ok && s["check"] != nil && s["check"] != "" {
		return ""
	}
	indent := "  "
	if m := indentRe.FindSubmatch(raw); m != nil {
		indent = string(m[1])
	}
	out, ok := addScript(raw, "check", "spec-flow check", indent)
	if !ok || os.WriteFile(p, out, 0o644) != nil {
		return ""
	}
	// Writing the alias is not the alias working: it needs the engine on PATH,
	// which an adopter running it by path does not have. Said here, not at
	// the first denial, where the reader is an implementer that cannot install.
	if _, err := exec.LookPath("spec-flow"); err == nil {
		return `added a "check" script to package.json — it runs the gate's own commands, scoped to this branch, and is what the deny hook points an implementer at`
	}
	return `added a "check" script to package.json — it runs spec-flow from your PATH, which does not carry it yet, so it exits "spec-flow: not found" until you put the engine's bin/spec-flow there (README). Nothing is broken meanwhile: the deny hook also names the plugin's own copy, which needs no install`
}

// addScript inserts scripts[name] = value into a package.json, keeping its
// key order and indentation as JSON.stringify(pkg, null, indent) would.
func addScript(raw []byte, name, value, indent string) ([]byte, bool) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	root, err := decodeOrdered(dec)
	if err != nil {
		return nil, false
	}
	obj, ok := root.(*ordered)
	if !ok {
		return nil, false
	}
	scripts, ok := obj.get("scripts").(*ordered)
	if !ok {
		scripts = &ordered{}
		obj.set("scripts", scripts)
	}
	scripts.set(name, value)
	var buf bytes.Buffer
	writeOrdered(&buf, obj, indent, "")
	buf.WriteString("\n")
	return buf.Bytes(), true
}

type ordered struct {
	keys []string
	vals map[string]any
}

func (o *ordered) get(k string) any { return o.vals[k] }

func (o *ordered) set(k string, v any) {
	if o.vals == nil {
		o.vals = map[string]any{}
	}
	if _, ok := o.vals[k]; !ok {
		o.keys = append(o.keys, k)
	}
	o.vals[k] = v
}

func decodeOrdered(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch t := tok.(type) {
	case json.Delim:
		if t == '{' {
			o := &ordered{}
			for dec.More() {
				kt, err := dec.Token()
				if err != nil {
					return nil, err
				}
				v, err := decodeOrdered(dec)
				if err != nil {
					return nil, err
				}
				o.set(kt.(string), v)
			}
			_, err := dec.Token()
			return o, err
		}
		var arr []any
		for dec.More() {
			v, err := decodeOrdered(dec)
			if err != nil {
				return nil, err
			}
			arr = append(arr, v)
		}
		_, err := dec.Token()
		return arr, err
	}
	return tok, nil
}

func writeOrdered(buf *bytes.Buffer, v any, indent, at string) {
	in := at + indent
	switch x := v.(type) {
	case *ordered:
		if len(x.keys) == 0 {
			buf.WriteString("{}")
			return
		}
		buf.WriteString("{\n")
		for i, k := range x.keys {
			buf.WriteString(in)
			writeScalar(buf, k)
			buf.WriteString(": ")
			writeOrdered(buf, x.vals[k], indent, in)
			if i < len(x.keys)-1 {
				buf.WriteString(",")
			}
			buf.WriteString("\n")
		}
		buf.WriteString(at + "}")
	case []any:
		if len(x) == 0 {
			buf.WriteString("[]")
			return
		}
		buf.WriteString("[\n")
		for i, e := range x {
			buf.WriteString(in)
			writeOrdered(buf, e, indent, in)
			if i < len(x)-1 {
				buf.WriteString(",")
			}
			buf.WriteString("\n")
		}
		buf.WriteString(at + "]")
	default:
		writeScalar(buf, x)
	}
}

func writeScalar(buf *bytes.Buffer, v any) {
	enc := json.NewEncoder(buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
	buf.Truncate(buf.Len() - 1)
}

// scaffold creates the directories, the specs contract, the gitignore lines
// and the `check` alias. `.claude/state/` and the report path must both be
// ignored, or the gate reads its own output as an unfinished write and skips
// every other milestone — and a skip is not a failure, so nothing says so.
func scaffold(root, reportPath string) []string {
	var done []string
	for _, d := range []string{"specs", filepath.Join("specflow", "archive")} {
		if _, err := os.Stat(filepath.Join(root, d)); err != nil {
			_ = os.MkdirAll(filepath.Join(root, d), 0o755)
			done = append(done, "created "+filepath.ToSlash(d)+"/")
		}
	}
	readme := filepath.Join(root, "specs", "README.md")
	if _, err := os.Stat(readme); err != nil {
		_ = os.WriteFile(readme, []byte(specsReadme), 0o644)
		done = append(done, "created specs/README.md — the capability-spec contract")
	}
	lines := []string{".claude/state/"}
	if reportPath != "" {
		// By its DIRECTORY where it has one: what a runner fills, and what git
		// reports while it is untracked.
		dir := strings.Split(strings.ReplaceAll(reportPath, `\`, "/"), "/")[0]
		if dir != "" && dir != reportPath {
			lines = append(lines, dir+"/")
		} else {
			lines = append(lines, reportPath)
		}
	}
	gitignore := filepath.Join(root, ".gitignore")
	b, _ := os.ReadFile(gitignore)
	current := string(b)
	for _, line := range lines {
		present := false
		for _, l := range strings.Split(current, "\n") {
			if strings.TrimSpace(l) == line {
				present = true
			}
		}
		if present {
			continue
		}
		prefix := ""
		if current != "" && !strings.HasSuffix(current, "\n") {
			prefix = "\n"
		}
		if f, err := os.OpenFile(gitignore, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644); err == nil {
			_, _ = f.WriteString(prefix + line + "\n")
			f.Close()
		}
		current += prefix + line + "\n"
		done = append(done, "added "+line+" to .gitignore")
	}
	if s := ensureCheckScript(root); s != "" {
		done = append(done, s)
	}
	return done
}

// Init is `spec-flow init [--force] [--translator]`.
func Init(args []string) int {
	root := projectRoot()
	force, wantsTranslator := contains(args, "--force"), contains(args, "--translator")
	configPath := filepath.Join(root, ".spec-flow", "config.json")
	// A contract inside a package is one no gate runs against (ADR-027).
	if err := gitscope.AssertRepoRoot(root); err != nil {
		fmt.Printf("spec-flow init: %v\n", err)
		return 1
	}
	if _, err := os.Stat(configPath); err == nil && !force {
		fmt.Println("spec-flow init: .spec-flow/config.json already exists. Nothing written.")
		fmt.Println("  Pass --force to overwrite it, or edit it directly — every field is in REFERENCE.md.")
		return 0
	}
	c, detected, review, missing := BuildContract(root)
	_ = os.MkdirAll(filepath.Join(root, ".spec-flow"), 0o755)
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	_ = enc.Encode(c)
	_ = os.WriteFile(configPath, buf.Bytes(), 0o644)
	fmt.Print("spec-flow init: wrote .spec-flow/config.json\n\n")
	// Opt-in, and never overwritten — `--force` does not reach it: the README
	// sends an adopter back with `--force`, and that would destroy their work.
	translator := filepath.Join(root, ".spec-flow", "tests-that-ran.mjs")
	if _, err := os.Stat(translator); wantsTranslator && err != nil {
		_ = os.WriteFile(translator, []byte(translatorStub(c.Verify.TestName)), 0o644)
		fmt.Print("  wrote     .spec-flow/tests-that-ran.mjs — point \"trace\" at it with \"executed_tests\": [\"node\", \".spec-flow/tests-that-ran.mjs\"] and delete \"report\".\n\n")
	}
	for _, l := range scaffold(root, c.Trace.Report.Path) {
		fmt.Printf("  %s\n", l)
	}
	if len(detected) > 0 {
		fmt.Println()
	}
	for _, l := range detected {
		fmt.Printf("  detected  %s\n", l)
	}
	for _, l := range review {
		fmt.Printf("  REVIEW    %s\n", l)
	}
	for _, l := range missing {
		fmt.Printf("  MISSING   %s\n", l)
	}
	// Through the reader every hook uses, so this cannot disagree with the
	// first gate.
	fmt.Println()
	if _, err := contract.Load(root); err != nil {
		fmt.Printf("The contract is NOT usable yet:\n%v\n", err)
		fmt.Println("\nFill the fields above and re-run this command with --force, or edit the file directly.")
		return 1
	}
	// A MISSING line is unfinished business even when the reader accepts it:
	// a base that does not resolve here does not resolve at the first gate.
	if len(missing) > 0 {
		fmt.Printf("The contract validates, but %d field(s) above still need you. Fill them in and re-run with --force, or edit the file directly.\n", len(missing))
		return 1
	}
	if len(review) > 0 {
		fmt.Println("The contract is valid and the engine will run. Confirm the REVIEW line(s) above first — they are inferences, not readings.")
	} else {
		fmt.Println("The contract is valid. Run your checks with `spec-flow check`, then start with /spec-flow.")
	}
	return 0
}
