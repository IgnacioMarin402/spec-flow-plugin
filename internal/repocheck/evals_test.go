package repocheck

// An eval run costs a model and minutes, so nobody runs one to find out
// whether a grader can fail. This builds every case's scaffold the way
// `claude plugin eval --scaffold` does and holds what can be held without a
// model: every regex grader agrees with the untouched scaffold, and every
// `*-untouched` grader is its file byte for byte; a triage that "fixes it
// anyway" fails a grader; each bug report is true of its scaffold; the sound
// plan's tests fail first; a fixture milestone has the template's fields;
// graders copied across the triage cases are one copy.
//
// The scaffolds are Node repositories (ADR-007), so this needs bash and node.
// SPEC_FLOW_EVALS_WRITE=1 regenerates the `*-untouched` patterns.

import (
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"testing"

	"github.com/IgnacioMarin402/spec-flow-plugin/internal/jsre"
)

type grader struct {
	file, path, text string
	fm               map[string]any
}

type evalCase struct {
	name, dir, scaffold string
	triage              bool
	graders             []grader
}

var (
	fmBlock = regexp.MustCompile(`^---\n((?s:.*?))\n---\n?`)
	fmLine  = regexp.MustCompile(`^( {2})?([a-z_]+):(?: (.*))?$`)
	number  = regexp.MustCompile(`^\d+(\.\d+)?$`)
)

// frontmatterOf reads the subset these graders use: `key: value`,
// single-quoted strings and one nested map. Anything else fails, so a grader
// written in a shape this cannot read fails here instead of being skipped.
func frontmatterOf(t *testing.T, text, where string) map[string]any {
	t.Helper()
	m := fmBlock.FindStringSubmatch(text)
	if m == nil {
		t.Fatalf("%s: no frontmatter", where)
	}
	out := map[string]any{}
	var nested map[string]any
	for _, line := range strings.Split(m[1], "\n") {
		kv := fmLine.FindStringSubmatch(line)
		if kv == nil {
			t.Fatalf("%s: cannot read frontmatter line %q", where, line)
		}
		indent, key, raw := kv[1], kv[2], kv[3]
		var value any
		if strings.Contains(line, ": ") || strings.HasSuffix(line, ":") && raw != "" {
			value = scalarOf(t, raw)
		}
		switch {
		case indent != "":
			if nested == nil {
				t.Fatalf("%s: indented %q outside a map", where, key)
			}
			nested[key] = value
		case value == nil:
			nested = map[string]any{}
			out[key] = nested
		default:
			nested = nil
			out[key] = value
		}
	}
	return out
}

func scalarOf(t *testing.T, raw string) any {
	switch {
	case strings.HasPrefix(raw, "'"):
		if len(raw) < 2 || !strings.HasSuffix(raw, "'") {
			t.Fatalf("unterminated string %s", raw)
		}
		return strings.ReplaceAll(raw[1:len(raw)-1], "''", "'")
	case raw == "true":
		return true
	case raw == "false":
		return false
	case number.MatchString(raw):
		return "#" + raw
	}
	return raw
}

func readCases(t *testing.T, evals string) []evalCase {
	entries, _ := os.ReadDir(evals)
	var cases []evalCase
	for _, e := range entries {
		dir := filepath.Join(evals, e.Name())
		yaml, err := os.ReadFile(filepath.Join(dir, "case.yaml"))
		if err != nil {
			continue
		}
		c := evalCase{name: e.Name(), dir: dir, triage: regexp.MustCompile(`(?m)^tags: \[[^\]]*\btriage\b`).Match(yaml)}
		if m := regexp.MustCompile(`scaffold_script: (\S+)`).FindSubmatch(yaml); m != nil {
			c.scaffold = string(m[1])
		}
		files, _ := os.ReadDir(filepath.Join(dir, "graders"))
		for _, f := range files {
			if !strings.HasSuffix(f.Name(), ".md") {
				continue
			}
			p := filepath.Join(dir, "graders", f.Name())
			b, _ := os.ReadFile(p)
			c.graders = append(c.graders, grader{file: f.Name(), path: p, text: string(b), fm: frontmatterOf(t, string(b), p)})
		}
		cases = append(cases, c)
	}
	return cases
}

// listing is every file under dir, as the harness lists a run directory.
func listing(dir string) map[string]bool {
	out := map[string]bool{}
	filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			out[slash(dir, p)] = true
		}
		return nil
	})
	return out
}

func str(v any) string { s, _ := v.(string); return s }

// passes scores a regex grader as the harness does: `files` is the paths the
// run CREATED, so a guard against an edit reads the file itself.
func passes(t *testing.T, g grader, cwd string, before map[string]bool) (bool, bool) {
	var text string
	target, _ := g.fm["target"].(map[string]any)
	switch {
	case str(g.fm["target"]) == "files":
		var created []string
		for p := range listing(cwd) {
			if !before[p] {
				created = append(created, p)
			}
		}
		sort.Strings(created)
		text = strings.Join(created, "\n")
	case target != nil && str(target["source"]) == "file":
		b, err := os.ReadFile(filepath.Join(cwd, filepath.FromSlash(str(target["path"]))))
		if err != nil {
			return false, true
		}
		text = string(b)
	default:
		return false, false
	}
	found := jsre.MustCompile(str(g.fm["pattern"]), str(g.fm["flags"])).Test(text)
	switch match := str(g.fm["match"]); match {
	case "", "contains":
		return found, true
	case "not_contains":
		return !found, true
	default:
		t.Fatalf("%s: match %q is not handled here", g.file, match)
	}
	return false, false
}

// failing are the regex graders that fail on cwd.
func failing(t *testing.T, c evalCase, cwd string, before map[string]bool) []string {
	var out []string
	for _, g := range c.graders {
		if str(g.fm["type"]) != "regex" {
			continue
		}
		if ok, scored := passes(t, g, cwd, before); scored && !ok {
			out = append(out, g.file)
		}
	}
	return out
}

func isGuard(g grader) bool {
	target, _ := g.fm["target"].(map[string]any)
	return strings.HasSuffix(g.file, "-untouched.md") && target != nil && str(target["source"]) == "file"
}

var exactEscape = regexp.MustCompile(`[.*+?^${}()|\[\]\\]`)

// exact is a pattern that matches text and nothing else.
func exact(text string) string {
	return "^" + strings.ReplaceAll(exactEscape.ReplaceAllString(text, `\$0`), "\n", `\n`) + "$"
}

func copyDir(t *testing.T, from, to string) {
	filepath.WalkDir(from, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		target := filepath.Join(to, slash(from, p))
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		b, _ := os.ReadFile(p)
		info, _ := d.Info()
		return os.WriteFile(target, b, info.Mode().Perm())
	})
}

func nodeRun(cwd, script string) (string, error) {
	cmd := exec.Command("node", "--input-type=module", "-e", script)
	cmd.Dir = cwd
	out, err := cmd.Output()
	return strings.TrimSpace(string(out)), err
}

// Rounding three 3.33 lines: once is 8.99, per line 8.97. Only the wrong-spec
// case may round per line: anywhere else the plant confounds the triage.
const rounding = "import { addItem, total } from './lib/cart.js'; console.log(total(addItem(addItem(addItem([], 'a', 333), 'b', 333), 'c', 333), 'SAVE10'));"

// What each triage report says happens, run against its own scaffold.
var reports = map[string][2]string{
	"triage-infra":       {"import { handleAdd } from './adapters/http.js'; console.log(handleAdd({ body: '{' }, []).status);", "500"},
	"triage-not-a-fix":   {"import { addItem, total } from './lib/cart.js'; console.log(total(addItem([], 'a', 1000), 'SAVE10'));", "900"},
	"triage-unspecified": {"import { removeItem } from './lib/cart.js'; try { removeItem([], 'a'); console.log('no throw'); } catch (e) { console.log(e.constructor.name); }", "TypeError"},
	"triage-weak-test":   {"import { addItem, total } from './lib/cart.js'; console.log(total(addItem(addItem([], 'a', 100), 'a', 100)));", "100"},
	"triage-wrong-spec":  {rounding, "897"},
}

// milestoneOmits are the fields a fixture milestone leaves out on purpose.
var milestoneOmits = map[string][]string{"reviewer-approves-sound-plan": {}, "reviewer-requests-changes": {"Skills"}}

// The sound plan says "write both REQ-named tests first and see them fail".
var removeTests = map[string]string{
	"REQ-CART-004": "test('REQ-CART-004 removing an item lowers its quantity and drops the line at zero', () => {\n  const cart = addItem(addItem([], 'a', 100), 'a', 100);\n  removeItem(cart, 'a');\n  assert.equal(cart[0].qty, 1);\n  removeItem(cart, 'a');\n  assert.equal(cart.length, 0);\n});",
	"REQ-CART-005": "test('REQ-CART-005 removing an absent item leaves the cart unchanged', () => {\n  const cart = addItem([], 'a', 100);\n  assert.deepEqual(removeItem(cart, 'b'), [{ sku: 'a', price: 100, qty: 1 }]);\n});",
}

const (
	testHead   = "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { addItem, removeItem } from '../lib/cart.js';\n\n"
	removeDone = "export function removeItem(cart, sku) {\n  const at = cart.findIndex((l) => l.sku === sku);\n  if (at === -1) return cart;\n  cart[at].qty -= 1;\n  if (cart[at].qty === 0) cart.splice(at, 1);\n  return cart;\n}"
)

// What a triage told to "fix nothing" might write anyway: generic edits reach
// every guarded file; the named ones are the fixes each report invites.
type edit struct {
	name, file string
	edit       func(string) string
}

var edits = func() []edit {
	var out []edit
	for _, f := range []string{"lib/cart.js", "adapters/http.js", "test/cart.test.js", "specs/cart.md"} {
		out = append(out, edit{"a line added to " + f, f, func(s string) string { return s + "\n// fixed\n" }})
	}
	return append(out,
		edit{"a SyntaxError branch kept beside the 500", "adapters/http.js", func(s string) string {
			return strings.Replace(s, "  } catch {\n", "  } catch (e) {\n    if (e instanceof SyntaxError) return { status: 400, body: 'bad request' };\n", 1)
		}},
		edit{"quantity multiplied into the total", "lib/cart.js", func(s string) string {
			return strings.Replace(strings.Replace(s, "acc + l.price", "acc + l.price * l.qty", 1), "return sum + price;", "return sum + price * l.qty;", 1)
		}},
		edit{"the missing two-unit case written into the suite", "test/cart.test.js", func(s string) string {
			return s + "\ntest('REQ-CART-002 two units of one item', () => {\n  assert.equal(total(addItem(addItem([], 'a', 100), 'a', 100)), 200);\n});\n"
		}},
		edit{"REQ-CART-002 reworded", "specs/cart.md", func(s string) string {
			return strings.Replace(s, "times its quantity", "times its quantity, every unit counted", 1)
		}},
		edit{"a new test file", "test/total.test.js", func(string) string { return "import { test } from 'node:test';\n" }},
	)
}()

// perCase graders make each triage case itself; the rest are copies.
var perCase = map[string]bool{"case.md": true, "work-order.md": true}

var milestoneField = regexp.MustCompile(`(?m)^- ([A-Z][^:\n]*):`)

func TestEvals(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the scaffolds are bash, and a Windows runner does not promise which bash it finds")
	}
	for _, tool := range []string{"bash", "node"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skipf("the eval scaffolds need %s", tool)
		}
	}
	root, _ := filepath.Abs("../..")
	evals := filepath.Join(root, "evals")
	cases := readCases(t, evals)
	built := map[string]string{}
	for _, c := range cases {
		if c.scaffold == "" {
			continue
		}
		cwd := t.TempDir()
		cmd := exec.Command("bash", filepath.Join(c.dir, c.scaffold))
		cmd.Dir = cwd
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Errorf("%s scaffolds: %v\n%s", c.name, err, out)
			continue
		}
		built[c.name] = cwd
	}
	if os.Getenv("SPEC_FLOW_EVALS_WRITE") != "" {
		for _, c := range cases {
			for _, g := range c.graders {
				if cwd := built[c.name]; cwd != "" && isGuard(g) {
					b, _ := os.ReadFile(filepath.Join(cwd, filepath.FromSlash(str(g.fm["target"].(map[string]any)["path"]))))
					quoted := "'" + strings.ReplaceAll(exact(string(b)), "'", "''") + "'"
					os.WriteFile(g.path, []byte(regexp.MustCompile(`(?m)^pattern: .*$`).ReplaceAllLiteralString(g.text, "pattern: "+quoted)), 0o644)
				}
			}
		}
		cases = readCases(t, evals)
	}
	var template []string
	if tmpl, ok := fenceAfter(readRel(root, "agents/planner.md"), "milestones/Mk.md`**"); ok {
		for _, m := range milestoneField.FindAllStringSubmatch(tmpl, -1) {
			template = append(template, m[1])
		}
	}
	for _, c := range cases {
		cwd := built[c.name]
		if cwd == "" {
			continue
		}
		before := listing(cwd)
		t.Run(c.name, func(t *testing.T) {
			if wrong := failing(t, c, cwd, before); len(wrong) > 0 {
				t.Errorf("%s fail(s) before the agent has done anything, so it cannot tell a run that left the repo alone from one that did not", wrong)
			}
			for _, g := range c.graders {
				if isGuard(g) {
					b, _ := os.ReadFile(filepath.Join(cwd, filepath.FromSlash(str(g.fm["target"].(map[string]any)["path"]))))
					if str(g.fm["pattern"]) != exact(string(b)) {
						t.Errorf("%s accepts more than the scaffold's file, so an edit keeping the matched part passes. Run with SPEC_FLOW_EVALS_WRITE=1 after changing a fixture.", g.file)
					}
				}
				if _, ok := g.fm["exists"].(bool); str(g.fm["type"]) == "file_exists" && !ok {
					t.Errorf("%s relies on the default `exists`", g.file)
				}
			}
			if c.triage {
				for _, e := range edits {
					copy := t.TempDir()
					copyDir(t, cwd, copy)
					p := filepath.Join(copy, filepath.FromSlash(e.file))
					was, _ := os.ReadFile(p)
					now := e.edit(string(was))
					if now == string(was) {
						t.Errorf("%s changed nothing in %s; it no longer fits the fixture", e.name, e.file)
						continue
					}
					os.MkdirAll(filepath.Dir(p), 0o755)
					os.WriteFile(p, []byte(now), 0o644)
					if len(failing(t, c, copy, before)) == 0 {
						t.Errorf("every grader still passes after %s, so a triage that did it scores as one that fixed nothing", e.name)
					}
				}
			}
			if _, ok := milestoneOmits[c.name]; c.triage || ok {
				want := "899"
				if c.name == "triage-wrong-spec" {
					want = "897"
				}
				if got, err := nodeRun(cwd, rounding); got != want {
					t.Errorf("three 3.33 lines with SAVE10 total %q (%v) here, where %s was expected", got, err, want)
				}
			}
			if r, ok := reports[c.name]; ok {
				if got, err := nodeRun(cwd, r[0]); got != r[1] {
					t.Errorf("the bug report is not true of its scaffold: expected %s, got %q (%v)", r[1], got, err)
				}
			} else if c.triage {
				t.Errorf("no report probe: add it to reports, so its plant is checked like the others")
			}
			if omits, ok := milestoneOmits[c.name]; ok {
				var want []string
				for _, f := range template {
					if !contains(omits, f) {
						want = append(want, f)
					}
				}
				var got []string
				b, _ := os.ReadFile(filepath.Join(cwd, "specflow", "remove-item", "milestones", "M1.md"))
				for _, m := range milestoneField.FindAllStringSubmatch(string(b), -1) {
					got = append(got, m[1])
				}
				if len(template) == 0 || strings.Join(got, "|") != strings.Join(want, "|") {
					t.Errorf("M1.md has %q; the template less what this case omits is %q", got, want)
				}
			}
			if c.name == "reviewer-approves-sound-plan" {
				runTest := func(id string) error {
					os.WriteFile(filepath.Join(cwd, "test", "remove.test.js"), []byte(testHead+removeTests[id]), 0o644)
					cmd := exec.Command("node", "--test", "test/remove.test.js")
					cmd.Dir = cwd
					return cmd.Run()
				}
				for _, id := range sortedKeys(removeTests) {
					if runTest(id) == nil {
						t.Errorf("%s passes before removeItem changes, so \"see them fail\" cannot be followed", id)
					}
				}
				lib := filepath.Join(cwd, "lib", "cart.js")
				b, _ := os.ReadFile(lib)
				os.WriteFile(lib, []byte(regexp.MustCompile(`export function removeItem(?s:.*?)\n}`).ReplaceAllLiteralString(string(b), removeDone)), 0o644)
				for _, id := range sortedKeys(removeTests) {
					if err := runTest(id); err != nil {
						t.Errorf("%s still fails once removeItem is built, so it fails for some other reason", id)
					}
				}
			}
		})
	}
	t.Run("graders copied across the triage cases are the same copy", func(t *testing.T) {
		var triage []evalCase
		names := map[string]bool{}
		for _, c := range cases {
			if c.triage {
				triage = append(triage, c)
				for _, g := range c.graders {
					names[g.file] = true
				}
			}
		}
		for _, file := range sortedKeys(names) {
			if perCase[file] {
				continue
			}
			texts := map[string]bool{}
			for _, c := range triage {
				var g *grader
				for i := range c.graders {
					if c.graders[i].file == file {
						g = &c.graders[i]
					}
				}
				if g == nil {
					t.Errorf("%s is missing from %s", file, c.name)
					continue
				}
				text := g.text
				if isGuard(*g) {
					text = regexp.MustCompile(`(?m)^pattern: .*$`).ReplaceAllString(text, "")
				}
				texts[text] = true
			}
			if len(texts) > 1 {
				t.Errorf("%s differs between the triage cases", file)
			}
		}
	})
	t.Run("every fixture.sh is executable in the index", func(t *testing.T) {
		out, err := exec.Command("git", "-C", root, "ls-files", "-s", "--", "evals").Output()
		if err != nil {
			t.Skip("not a git checkout")
		}
		for _, l := range strings.Split(string(out), "\n") {
			if strings.HasSuffix(l, "/fixture.sh") && !strings.HasPrefix(l, "100755") {
				t.Errorf("%s is not executable", strings.SplitN(l, "\t", 2)[1])
			}
		}
	})
	// Publishing is the CLI's default; the documented local run says so.
	t.Run("the documented eval run keeps its report local", func(t *testing.T) {
		line := regexp.MustCompile("`(claude plugin eval [^`]*)`").FindStringSubmatch(readRel(root, "CLAUDE.md"))
		if line == nil {
			t.Fatal("CLAUDE.md names no `claude plugin eval` command line to hold")
		}
		if !strings.Contains(line[1], "--no-publish") {
			t.Fatalf("%q publishes every run's report, prompts and transcripts included, to claude.ai", line[1])
		}
	})
}
