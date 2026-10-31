// Package contract is the only reader of `.spec-flow/config.json`, so its
// defaults, its validation and its version check exist once.
//
// A missing file is not silent: no runner, linter or layer is safe to assume
// for a repository this engine has never seen, so every field naming one is
// required, and validation runs on every load, the missing file included.
//
// Every caller lets Load's error stand — never falls back to defaults. A
// fallback would make a version this engine cannot read indistinguishable
// from a missing file, and hand that repository someone else's values.
package contract

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/IgnacioMarin402/spec-flow-plugin/internal/testreport"
)

// SupportedVersion is the contract this reader understands.
const SupportedVersion = 1

// Only fields with no stack-specific content get a value; whatever would
// have to guess a tool or a layer is empty, and validation requires it.
func defaults() map[string]any {
	return map[string]any{
		"contract_version": float64(SupportedVersion),
		"verify": map[string]any{
			"scope_globs": []any{}, "lint": []any{}, "lint_no_fix": []any{}, "test": []any{},
			"test_name": "", "lint_name": "", "lint_config_hint": "",
			// Empty resolves the base automatically; failing to resolve one is loud.
			"base_ref": "",
		},
		"trace": map[string]any{
			"specs_dir": "specs", "proof_dir": "", "proof_suffix": "",
			// Which tests RAN: a report the runner writes (the default, ADR-005),
			// or argv printing their names. Neither opts out of traceability, and
			// spec-trace refuses that the moment a requirement exists.
			"report": nil, "executed_tests": []any{},
			"not_a_capability": []any{"README.md", "glossary.md"},
			// Off: nothing this engine reads says whether a repository routes
			// skills, and it is never inferred from a milestone that names one —
			// that arms the check from an absence.
			"require_skills_field": false,
		},
		"extra_checks": []any{},
		"unscoped_denied": map[string]any{
			"scripts": []any{}, "tools": []any{}, "scoped_allowed": []any{},
			"scoped_alternative": "", "scoped_examples": []any{},
		},
	}
}

// Report is `trace.report`.
type Report struct{ Format, Path string }

// Check is one of `extra_checks`, or spec-trace.
type Check struct {
	Name, Field, Green, Hint, Class string
	Cmd                             []string
}

// Config is a loaded, validated contract.
type Config struct {
	Version any
	Verify  struct {
		ScopeGlobs, Lint, LintNoFix, Test           []string
		TestName, LintName, LintConfigHint, BaseRef string
	}
	Trace struct {
		SpecsDir, ProofDir, ProofSuffix string
		Report                          *Report
		ExecutedTests, NotACapability   []string
		RequireSkillsField              bool
	}
	ExtraChecks    []Check
	UnscopedDenied struct {
		Scripts, Tools, ScopedAllowed, ScopedExamples []string
		ScopedAlternative                             string
	}
	Source string // "file" or "defaults"
}

// Shallow-merge one level down: overriding `verify.test` keeps the other verify defaults.
func merge(base, override map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range base {
		out[k] = v
	}
	for k, v := range override {
		if m, ok := v.(map[string]any); ok {
			b, _ := base[k].(map[string]any)
			out[k] = merge(b, m)
		} else {
			out[k] = v
		}
	}
	return out
}

func obj(v any) map[string]any {
	m, _ := v.(map[string]any)
	if m == nil {
		return map[string]any{}
	}
	return m
}

// JSON is JSON.stringify(v): `undefined` for a missing value.
func JSON(v any, present bool) string {
	if !present {
		return "undefined"
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
	return strings.TrimSuffix(buf.String(), "\n")
}

func nonEmptyArray(v any) bool  { a, ok := v.([]any); return ok && len(a) > 0 }
func nonEmptyString(v any) bool { s, ok := v.(string); return ok && s != "" }

func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case float64:
		return x != 0
	}
	return true
}

// Shape, not taste: a wrong command fails loudly the first time the gate runs
// it. `scope_globs` is the one field whose CONTENT is judged, because a scope
// that matches nothing fails silently every time, by disarming lint.
func validate(c map[string]any, source string) []string {
	var problems []string
	verify, trace := obj(c["verify"]), obj(c["trace"])

	if !nonEmptyArray(verify["lint"]) {
		problems = append(problems, `verify.lint must be a non-empty array of argv parts, e.g. ["node", "node_modules/.bin/eslint", "--fix"].`)
	}
	if !nonEmptyArray(verify["test"]) {
		problems = append(problems, `verify.test must be a non-empty array of argv parts, e.g. ["node", "node_modules/.bin/vitest", "run"].`)
	}
	if !nonEmptyArray(verify["scope_globs"]) {
		problems = append(problems, `verify.scope_globs must be a non-empty array, e.g. ["*.ts", "*.tsx"].`)
	} else {
		// Git pathspecs, where `*` already crosses `/`: `**/*.ts` demands a
		// directory and drops the root, and the empty scope that leaves reads
		// exactly like a milestone that touched nothing in scope.
		for i, g := range verify["scope_globs"].([]any) {
			glob, ok := g.(string)
			if !ok || glob == "" {
				problems = append(problems, fmt.Sprintf("verify.scope_globs[%d] must be a non-empty string — got %s.", i, JSON(g, true)))
				continue
			}
			if strings.Contains(glob, "**") {
				fixed := strings.ReplaceAll(strings.ReplaceAll(glob, "**/", ""), "**", "*")
				problems = append(problems, fmt.Sprintf("verify.scope_globs[%d] is %s, and `**` does not mean here what it means in npm, in a bundler config or in .gitignore. ", i, JSON(glob, true))+
					fmt.Sprintf("These are git PATHSPECS, where `*` already crosses `/`: write %s and it matches at every depth. ", JSON(fixed, true))+
					"Left as written it matches only files at least one directory deep, so every file in the repo root falls out of scope — and an empty scope is not a failure anywhere: the linter is simply never invoked, and the gate records `lint=-`, which reads exactly like a milestone that honestly changed nothing in scope.")
			}
		}
	}
	if !nonEmptyString(verify["test_name"]) {
		problems = append(problems, `verify.test_name must name the test runner, e.g. "vitest" — it labels the gate's log sections.`)
	}
	if !nonEmptyString(verify["lint_name"]) {
		problems = append(problems, `verify.lint_name must name the linter, e.g. "eslint" — it labels the gate's log sections.`)
	}
	// `"base_ref": ""` would silently mean "auto-resolve"; declared, it means something.
	if br, ok := verify["base_ref"]; !(ok && br == "") && !nonEmptyString(br) {
		problems = append(problems, `verify.base_ref, when present, must be a non-empty string naming the ref this branch is judged against, e.g. "origin/trunk". Omit it entirely to let the engine resolve the base branch automatically.`)
	}
	// Where a new test goes and what it is called; not what counts as proof (ADR-001).
	if !nonEmptyString(trace["proof_dir"]) {
		problems = append(problems, `trace.proof_dir must name the directory a new test goes in (e.g. "tests"). It is what an implementer is told when a requirement needs proof; it no longer decides what counts as proof, which is trace.executed_tests' job.`)
	}
	if !nonEmptyString(trace["proof_suffix"]) {
		problems = append(problems, `trace.proof_suffix must name what a test file is called in this repo, e.g. ".spec.ts", ".test.ts" or "_test.py" — it tells an implementer what to name a new one.`)
	}
	// At most one source: two answers to "which tests ran" means one is not read.
	report, hasReport := trace["report"]
	hasReport = hasReport && report != nil
	if hasReport && nonEmptyArray(trace["executed_tests"]) {
		problems = append(problems, `trace.report and trace.executed_tests are both declared, and only one can be read. Keep trace.report (the engine parses the file your runner writes) and delete trace.executed_tests, or the reverse — but say which.`)
	}
	if hasReport {
		r := obj(report)
		format, present := r["format"]
		if f, ok := format.(string); !ok || !contains(testreport.Formats, f) {
			problems = append(problems, fmt.Sprintf("trace.report.format must be one of %s — got %s. ", strings.Join(testreport.Formats, ", "), JSON(format, present))+
				"These are report formats, not runners: most runners can emit one behind a flag, and the format is what defines how a skipped test is marked.")
		}
		if !nonEmptyString(r["path"]) {
			problems = append(problems, `trace.report.path must name the file your test command writes, relative to the repo root, e.g. "reports/junit.xml". The engine does not run your tests a second time — it reads what the gate's own run produced.`)
		}
	}
	// A string would arm the check by truthiness, or `"false"` disarm nothing.
	if _, ok := trace["require_skills_field"].(bool); !ok {
		problems = append(problems, "trace.require_skills_field, when present, must be true or false (a JSON boolean, not a quoted string). Omit it to leave the check off: the planner still fills the milestone's `Skills:` field and the reviewer still checks it — this only decides whether spec-trace fails a live milestone that lacks one.")
	}
	if len(problems) > 0 && source == "defaults" {
		problems = append(problems, "No .spec-flow/config.json was found at all, so none of the above has a value — this project has not written a contract for this engine yet. Run `spec-flow init` from the repo root to generate one (see the plugin README).")
	}

	checks, ok := c["extra_checks"].([]any)
	if !ok && c["extra_checks"] != nil {
		problems = append(problems, "extra_checks must be an array.")
	}
	for i, raw := range checks {
		check := obj(raw)
		where := fmt.Sprintf("extra_checks[%d]", i)
		if !truthy(check["name"]) {
			problems = append(problems, where+".name is required.")
		}
		if !nonEmptyArray(check["cmd"]) {
			problems = append(problems, where+".cmd must be a non-empty array.")
		}
		if !truthy(check["field"]) {
			problems = append(problems, where+".field is required: it is the key this check writes in gate-history.log, and specflow-stats reads that log by key.")
		}
		if cl := check["class"]; truthy(cl) && cl != "lint/trace" && cl != "behaviour" {
			problems = append(problems, where+`.class must be "lint/trace" (route the failure back as an edit) or "behaviour" (route it as a re-plan).`)
		}
	}
	return problems
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

func text(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case bool:
		return fmt.Sprint(x)
	}
	return JSON(v, true)
}

func strs(v any) []string {
	a, _ := v.([]any)
	out := make([]string, 0, len(a))
	for _, e := range a {
		out = append(out, text(e))
	}
	return out
}

func build(c map[string]any, source string) *Config {
	cfg := &Config{Version: c["contract_version"], Source: source}
	v, t, u := obj(c["verify"]), obj(c["trace"]), obj(c["unscoped_denied"])
	cfg.Verify.ScopeGlobs, cfg.Verify.Lint, cfg.Verify.LintNoFix, cfg.Verify.Test = strs(v["scope_globs"]), strs(v["lint"]), strs(v["lint_no_fix"]), strs(v["test"])
	cfg.Verify.TestName, cfg.Verify.LintName, cfg.Verify.LintConfigHint, cfg.Verify.BaseRef = text(v["test_name"]), text(v["lint_name"]), text(v["lint_config_hint"]), text(v["base_ref"])
	cfg.Trace.SpecsDir, cfg.Trace.ProofDir, cfg.Trace.ProofSuffix = text(t["specs_dir"]), text(t["proof_dir"]), text(t["proof_suffix"])
	if r, ok := t["report"].(map[string]any); ok {
		cfg.Trace.Report = &Report{Format: text(r["format"]), Path: text(r["path"])}
	}
	cfg.Trace.ExecutedTests, cfg.Trace.NotACapability = strs(t["executed_tests"]), strs(t["not_a_capability"])
	cfg.Trace.RequireSkillsField, _ = t["require_skills_field"].(bool)
	checks, _ := c["extra_checks"].([]any)
	for _, raw := range checks {
		ch := obj(raw)
		check := Check{Name: text(ch["name"]), Field: text(ch["field"]), Cmd: strs(ch["cmd"]), Hint: text(ch["hint"]), Class: text(ch["class"]), Green: "(ok)"}
		if g, ok := ch["green"]; ok && g != nil {
			check.Green = text(g)
		}
		if check.Class == "" {
			check.Class = "lint/trace"
		}
		cfg.ExtraChecks = append(cfg.ExtraChecks, check)
	}
	cfg.UnscopedDenied.Scripts, cfg.UnscopedDenied.Tools, cfg.UnscopedDenied.ScopedAllowed = strs(u["scripts"]), strs(u["tools"]), strs(u["scoped_allowed"])
	cfg.UnscopedDenied.ScopedAlternative, cfg.UnscopedDenied.ScopedExamples = text(u["scoped_alternative"]), strs(u["scoped_examples"])
	return cfg
}

// Load reads root's contract. root is the consuming repository, explicit,
// never where this engine sits.
func Load(root string) (*Config, error) {
	if root == "" {
		return nil, errors.New("contract.Load(root) requires the consuming repo's path")
	}
	parsed := map[string]any{}
	source := "defaults"
	if raw, err := os.ReadFile(filepath.Join(root, ".spec-flow", "config.json")); err == nil {
		source = "file"
		var v any
		if err := json.Unmarshal(raw, &v); err != nil {
			return nil, fmt.Errorf(".spec-flow/config.json is not valid JSON: %v", err)
		}
		m, isObj := v.(map[string]any)
		if isObj {
			parsed = m
		}
		declared, present := m["contract_version"]
		if !isObj {
			present = false
		}
		if n, ok := declared.(float64); !ok || n != SupportedVersion {
			return nil, fmt.Errorf(".spec-flow/config.json declares contract_version %s, and this engine understands %d. "+
				"Refusing to run: continuing would silently ignore whatever that version changed, which is a gate that looks armed and is not.", JSON(declared, present), SupportedVersion)
		}
	}
	merged := merge(defaults(), parsed)
	if problems := validate(merged, source); len(problems) > 0 {
		return nil, errors.New(".spec-flow/config.json is not usable:\n  - " + strings.Join(problems, "\n  - "))
	}
	return build(merged, source), nil
}

// PrepareReport readies `trace.report.path` for the suite about to write it:
// the directory exists, and no report from an earlier run is left. Every
// caller that runs `verify.test` calls it first. Only a file that READS as a
// report naming a test case is removed: the path is the adopter's to write.
func PrepareReport(root string, cfg *Config) {
	r := cfg.Trace.Report
	if r == nil || r.Path == "" {
		return
	}
	file := r.Path
	if !filepath.IsAbs(file) {
		file = filepath.Join(root, file)
	}
	_ = os.MkdirAll(filepath.Dir(file), 0o755)
	previous := testreport.Read(r.Format, r.Path, root)
	if previous.Error != "" || len(previous.Names)+previous.Skipped == 0 {
		return
	}
	_ = os.Remove(file)
}

// Checklist is spec-trace, then whatever the contract declared, in that order.
func (c *Config) Checklist() []Check { return append([]Check{SpecTraceCheck}, c.ExtraChecks...) }

// SpecTraceCheck is engine core: always present and first, never opted into.
var SpecTraceCheck = Check{
	Name:  "spec-trace",
	Field: "spec",
	Green: "(specs and tests agree)",
	Hint:  "Name the requirement id in the test that proves it, or correct the requirement in the capability spec.",
	Class: "lint/trace",
}
