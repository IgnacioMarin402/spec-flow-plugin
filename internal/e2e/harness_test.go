// Package e2e drives the engine the way Claude Code, a terminal and CI do:
// the built binary, a hook payload on stdin, a throwaway repository on disk.
//
// SPEC_FLOW_ORACLE=<a checkout of the JavaScript engine> runs the same cases
// against `node <checkout>/hooks/<name>.mjs` instead: how a case ported from
// the JavaScript suite is shown to hold there too, and how a regression test
// is shown to fail on the code before its fix.
package e2e

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

var (
	oracle    = os.Getenv("SPEC_FLOW_ORACLE")
	repoRoot  string // this checkout
	engineDir string // the engine every case runs, installed apart from any repository
	tool      string // the stand-in for a repository's own commands
)

func TestMain(m *testing.M) {
	code, err := setup()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if code == 0 {
		code = m.Run()
	}
	os.RemoveAll(filepath.Dir(tool))
	if oracle == "" {
		os.RemoveAll(engineDir)
	}
	os.Exit(code)
}

func exe(name string) string {
	if runtime.GOOS == "windows" {
		return name + ".exe"
	}
	return name
}

func setup() (int, error) {
	wd, _ := os.Getwd()
	repoRoot = filepath.Clean(filepath.Join(wd, "..", ".."))
	toolDir, err := os.MkdirTemp("", "spec-flow-tool-")
	if err != nil {
		return 1, err
	}
	tool = filepath.Join(toolDir, exe("tool"))
	if out, err := exec.Command("go", "build", "-o", tool, "./tool").CombinedOutput(); err != nil {
		return 1, fmt.Errorf("building the test tool: %v\n%s", err, out)
	}
	if oracle != "" {
		engineDir = oracle
		return 0, nil
	}
	if engineDir, err = os.MkdirTemp("", "spec-flow-engine-"); err != nil {
		return 1, err
	}
	for _, d := range []string{"agents", "modes", ".claude-plugin", "commands", "skills"} {
		if err := copyTree(filepath.Join(repoRoot, d), filepath.Join(engineDir, d)); err != nil {
			return 1, err
		}
	}
	launcher := filepath.Join(engineDir, "bin", "spec-flow")
	_ = os.MkdirAll(filepath.Dir(launcher), 0o755)
	if b, err := os.ReadFile(filepath.Join(repoRoot, "bin", "spec-flow")); err == nil {
		_ = os.WriteFile(launcher, b, 0o755)
	}
	cmd := exec.Command("go", "build", "-o", binary(engineDir), "./cmd/spec-flow")
	cmd.Dir = repoRoot
	if out, err := cmd.CombinedOutput(); err != nil {
		return 1, fmt.Errorf("building spec-flow: %v\n%s", err, out)
	}
	return 0, nil
}

func copyTree(from, to string) error {
	return filepath.WalkDir(from, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(from, p)
		target := filepath.Join(to, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		info, _ := d.Info()
		return os.WriteFile(target, b, info.Mode().Perm())
	})
}

// copyEngine is a throwaway copy of the engine, for a case that breaks one.
func copyEngine(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	dirs := []string{"agents", "modes", ".claude-plugin", "bin"}
	if oracle != "" {
		dirs = []string{"hooks", "scripts", "agents", "modes", "bin"}
	}
	for _, d := range dirs {
		if _, err := os.Stat(filepath.Join(engineDir, d)); err != nil {
			continue
		}
		if err := copyTree(filepath.Join(engineDir, d), filepath.Join(dir, d)); err != nil {
			t.Fatal(err)
		}
	}
	if oracle != "" {
		b, _ := os.ReadFile(filepath.Join(engineDir, "package.json"))
		os.WriteFile(filepath.Join(dir, "package.json"), b, 0o644)
	}
	return dir
}

// Result is a finished hook or command.
type Result struct {
	Status         int
	Stdout, Stderr string
}

// Out is everything it said.
func (r Result) Out() string { return r.Stdout + r.Stderr }

// Blocked says whether a Stop or SubagentStop hook rendered a block.
func (r Result) Blocked() bool {
	var v struct{ Decision string }
	return json.Unmarshal([]byte(r.Stdout), &v) == nil && v.Decision == "block"
}

// Reason is a block's reason, or a notice's message.
func (r Result) Reason() string {
	var v struct {
		Reason        string `json:"reason"`
		SystemMessage string `json:"systemMessage"`
	}
	_ = json.Unmarshal([]byte(r.Stdout), &v)
	return v.Reason + v.SystemMessage
}

func run(dir string, env []string, stdin string, argv ...string) Result {
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), env...)
	cmd.Stdin = strings.NewReader(stdin)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	err := cmd.Run()
	status := 0
	if err != nil {
		status = -1
		if x, ok := err.(*exec.ExitError); ok {
			status = x.ExitCode()
		}
	}
	return Result{status, out.String(), errb.String()}
}

// binary is where an engine keeps the binary for this platform: Windows runs
// bin/spec-flow.exe, found for bin/spec-flow; elsewhere the launcher picks one.
func binary(engine string) string {
	if runtime.GOOS == "windows" {
		return filepath.Join(engine, "bin", "spec-flow.exe")
	}
	return filepath.Join(engine, "bin", runtime.GOOS+"-"+runtime.GOARCH, "spec-flow")
}

// hookArgv is how engine runs hook name.
func hookArgv(engine, name string) []string {
	if oracle != "" {
		return []string{"node", filepath.Join(engine, "hooks", name+".mjs")}
	}
	return []string{binary(engine), "hook", name}
}

// cliArgv is how engine runs `spec-flow <args>`.
func cliArgv(engine string, args ...string) []string {
	if oracle != "" {
		return append([]string{"node", filepath.Join(engine, "bin", "spec-flow.mjs")}, args...)
	}
	return append([]string{binary(engine)}, args...)
}

// Hook runs hook name against repo with payload on stdin, from a directory
// that is not the repository: Claude Code's working directory is its own.
type Hook struct {
	Engine string
	Env    []string
}

func (h Hook) run(t *testing.T, name string, payload any, repo string) Result {
	t.Helper()
	engine := h.Engine
	if engine == "" {
		engine = engineDir
	}
	var stdin string
	if s, ok := payload.(string); ok {
		stdin = s
	} else {
		b, _ := json.Marshal(payload)
		stdin = string(b)
	}
	return run(os.TempDir(), append([]string{"CLAUDE_PROJECT_DIR=" + repo}, h.Env...), stdin, hookArgv(engine, name)...)
}

func runHook(t *testing.T, name string, payload any, repo string) Result {
	t.Helper()
	return Hook{}.run(t, name, payload, repo)
}

// cli runs `spec-flow <args>` in dir, as a terminal would.
func cli(t *testing.T, dir string, env []string, args ...string) Result {
	t.Helper()
	return run(dir, append([]string{"CLAUDE_PROJECT_DIR="}, env...), "", cliArgv(engineDir, args...)...)
}

// git runs git in dir, failing the case when it fails.
func git(t *testing.T, dir string, args ...string) string {
	t.Helper()
	r := run(dir, []string{"GIT_AUTHOR_NAME=fixture", "GIT_AUTHOR_EMAIL=f@example.com", "GIT_COMMITTER_NAME=fixture", "GIT_COMMITTER_EMAIL=f@example.com"}, "", append([]string{"git"}, args...)...)
	if r.Status != 0 {
		t.Fatalf("git %s: %s", strings.Join(args, " "), r.Out())
	}
	return strings.TrimSpace(r.Stdout)
}

func gitQuiet(dir string, args ...string) {
	run(dir, []string{"GIT_AUTHOR_NAME=fixture", "GIT_AUTHOR_EMAIL=f@example.com", "GIT_COMMITTER_NAME=fixture", "GIT_COMMITTER_EMAIL=f@example.com"}, "", append([]string{"git"}, args...)...)
}

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func appendTo(t *testing.T, path, content string) {
	t.Helper()
	_ = os.MkdirAll(filepath.Dir(path), 0o755)
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	f.WriteString(content)
}

func read(path string) string {
	b, _ := os.ReadFile(path)
	return string(b)
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// age sets path's modification time to ago before now.
func age(t *testing.T, path string, ago time.Duration) {
	t.Helper()
	at := time.Now().Add(-ago)
	if err := os.Chtimes(path, at, at); err != nil {
		t.Fatal(err)
	}
}

func toJSON(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

// toolCmd is the stand-in command doing ops, as a contract's argv.
func toolCmd(ops ...string) []string { return append([]string{tool}, ops...) }
