package e2e

import (
	"fmt"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/IgnacioMarin402/spec-flow-plugin/internal/hooks"
)

var spawnSpecWriter = map[string]any{"tool_input": map[string]any{"subagent_type": "spec-writer"}}

// ---- preflight: the run refuses to start rather than dying at the gate ----

func TestPreflightAllowsAValidSetup(t *testing.T) {
	repo := makeRepo(t, repoOpts{})
	expectStatus(t, runHook(t, "preflight", spawnSpecWriter, repo), 0, "a valid setup was denied")
}

func TestPreflightDeniesAnUnusableContract(t *testing.T) {
	repo := makeRepo(t, repoOpts{noContract: true, phase: "spec"})
	r := runHook(t, "preflight", spawnSpecWriter, repo)
	expectStatus(t, r, 2, "expected the PreToolUse denial")
	mustMatch(t, `PREFLIGHT FAILED`, r.Stderr, "the denial does not say what happened")
}

func TestPreflightDeniesWithNoBase(t *testing.T) {
	repo := makeRepo(t, repoOpts{noCommit: true, phase: "spec"})
	r := runHook(t, "preflight", spawnSpecWriter, repo)
	expectStatus(t, r, 2, "a run with no resolvable base was allowed to start")
	mustMatch(t, `base branch`, r.Stderr, "the denial does not name the base as the problem")
}

// A workspace directory holding several repositories has no base either, and
// that is not what is wrong with it (ADR-027).
func TestPreflightDeniesOutsideAnyRepository(t *testing.T) {
	repo := makeRepo(t, repoOpts{noGit: true, phase: "spec"})
	r := runHook(t, "preflight", spawnSpecWriter, repo)
	expectStatus(t, r, 2, "a run outside any repository was allowed to start")
	mustMatch(t, `not inside a git repository`, r.Stderr, "the denial blames something other than the missing repository")
	mustMatch(t, `PREFLIGHT FAILED — this directory is in no git repository`, r.Stderr, "the heading names something else")
	mustNotMatch(t, "spec-flow init` regenerates", r.Stderr, "it sends a human to run init where init refuses for the same reason")
}

func TestPreflightDeniesASubdirectoryOfItsRepository(t *testing.T) {
	outer := t.TempDir()
	initRepo(t, outer, false, true)
	back := filepath.Join(outer, "back")
	writeRun(t, back, "spec", nil)
	r := runHook(t, "preflight", spawnSpecWriter, back)
	expectStatus(t, r, 2, "a run opened at back/ of a repository was allowed to start")
	mustMatch(t, `repository root`, r.Stderr, "the denial does not say where to open the repository")
}

// A guard on the rule's edge: a package that is its own repository IS a root.
func TestPreflightAllowsAPackageThatIsItsOwnRepository(t *testing.T) {
	outer := t.TempDir()
	initRepo(t, outer, false, true)
	back := filepath.Join(outer, "back")
	writeRun(t, back, "spec", nil)
	initRepo(t, back, false, true)
	expectStatus(t, runHook(t, "preflight", spawnSpecWriter, back), 0, "a package that is its own repository was refused")
}

func TestPreflightIsTransparentOutsideARun(t *testing.T) {
	repo := makeRepo(t, repoOpts{noContract: true, noGit: true, phase: "idle"})
	expectStatus(t, runHook(t, "preflight", map[string]any{"tool_input": map[string]any{"subagent_type": "anything"}}, repo), 0, "it denied a subagent spawned outside the flow")
}

func TestSessionStartResetsAStalePlanPhase(t *testing.T) {
	repo := makeRepo(t, repoOpts{phase: "plan"})
	age(t, statePath(repo, "phase"), 72*time.Hour)
	expectStatus(t, runHook(t, "session-start", map[string]any{}, repo), 0, "session-start")
	if p := phaseOf(repo); p != "idle" {
		t.Fatalf("a three-day-old 'plan' survived as %q", p)
	}
}

// Standing down must leave nothing on disk, in every repository the user opens.
func TestNoHookCreatesStateOutsideTheFlow(t *testing.T) {
	bare := t.TempDir()
	write(t, filepath.Join(bare, "package.json"), "{}")
	names := make([]string, 0, len(hooks.All))
	for n := range hooks.All {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		runHook(t, n, map[string]any{"tool_name": "Task", "tool_input": map[string]any{"subagent_type": "planner", "command": "ls"}}, bare)
	}
	if exists(filepath.Join(bare, ".claude")) {
		t.Fatal("the hooks created .claude/ in a repo with no phase file and no contract")
	}
}

func TestArmGateMatchesWhateverTheCasing(t *testing.T) {
	repo := makeRepo(t, repoOpts{phase: "plan"})
	expectStatus(t, runHook(t, "arm-gate", map[string]any{"tool_input": map[string]any{"subagent_type": "Implementer"}}, repo), 0, "arm-gate")
	if p := phaseOf(repo); p != "implement" {
		t.Fatalf("phase is %q — a capitalised agent type left every guard disarmed, silently", p)
	}
}

func TestWholeRepoDenialHandsNoDisarm(t *testing.T) {
	repo := makeRepo(t, repoOpts{})
	r := runHook(t, "no-gate-cmds", map[string]any{"tool_input": map[string]any{"command": "npm run test"}}, repo)
	expectStatus(t, r, 2, "expected a denial")
	mustNotMatch(t, `state[\\/]phase`, r.Stderr, "the denial quotes the phase file to an agent mid-milestone")
}

func TestArmGateFlipsPhaseOnAnImplementerSpawn(t *testing.T) {
	repo := makeRepo(t, repoOpts{phase: "plan"})
	expectStatus(t, runHook(t, "arm-gate", map[string]any{"tool_input": map[string]any{"subagent_type": "implementer"}}, repo), 0, "arm-gate")
	if p := phaseOf(repo); p != "implement" {
		t.Fatalf("phase is %q, expected implement", p)
	}
}

func TestArmGateIgnoresAnotherSpawn(t *testing.T) {
	repo := makeRepo(t, repoOpts{phase: "plan"})
	expectStatus(t, runHook(t, "arm-gate", map[string]any{"tool_input": map[string]any{"subagent_type": "reviewer"}}, repo), 0, "arm-gate")
	if p := phaseOf(repo); p != "plan" {
		t.Fatalf("phase changed to %q", p)
	}
}

func spawnOf(typ string) map[string]any {
	return map[string]any{"tool_name": "Task", "tool_input": map[string]any{"subagent_type": typ}}
}

func TestOpusBudget(t *testing.T) {
	cases := []struct {
		name   string
		config string
		counts map[string]string
		spawn  string
		check  func(t *testing.T, repo string, r Result)
	}{
		{"counts a planner spawn", `{"max_opus_calls":6}`, nil, "planner", func(t *testing.T, repo string, r Result) {
			expectStatus(t, r, 0, "opus-budget")
			if n := read(statePath(repo, "opus_calls")); n != "1" {
				t.Fatalf("opus_calls is %q, expected 1", n)
			}
		}},
		{"denies past the cap", `{"max_opus_calls":2}`, map[string]string{"opus_calls": "2"}, "planner", func(t *testing.T, repo string, r Result) {
			expectStatus(t, r, 2, "past the cap")
			mustMatch(t, `budget exhausted`, r.Stderr, "no budget message")
		}},
		{"does not count a non-escalation spawn", `{"max_opus_calls":6}`, nil, "implementer", func(t *testing.T, repo string, r Result) {
			expectStatus(t, r, 0, "opus-budget")
			if n := counterOf(repo, "opus_calls"); n != "0" {
				t.Fatalf("opus_calls became %q for a spawn that is not an escalation", n)
			}
		}},
		{"charges the architect to its own counter", "", nil, "spec-flow:architect", func(t *testing.T, repo string, r Result) {
			expectStatus(t, r, 0, "opus-budget")
			if counterOf(repo, "architect_calls") != "1" || counterOf(repo, "opus_calls") != "0" {
				t.Fatalf("architect_calls %s, opus_calls %s", counterOf(repo, "architect_calls"), counterOf(repo, "opus_calls"))
			}
		}},
		{"reads max_architect_calls from the config", `{"max_architect_calls":1}`, map[string]string{"architect_calls": "1"}, "architect", func(t *testing.T, repo string, r Result) {
			expectStatus(t, r, 2, "max_architect_calls 1 let a second call through")
		}},
		{"denies while its cap is not a number of calls", `{"max_opus_calls":"six"}`, nil, "planner", func(t *testing.T, repo string, r Result) {
			expectStatus(t, r, 2, "a planner spawn went through under a cap no count can reach")
			mustMatch(t, `max_opus_calls`, r.Stderr, "the denial does not name the key to fix")
		}},
		{"denies an architect under a cap that is no number, and charges nothing", `{"max_architect_calls":"three"}`, nil, "spec-flow:architect", func(t *testing.T, repo string, r Result) {
			expectStatus(t, r, 2, "an architect spawn went through under a cap no count can reach")
			if exists(statePath(repo, "architect_calls")) {
				t.Fatal("a denied spawn was charged")
			}
			mustMatch(t, `max_architect_calls`, r.Stderr, "the denial does not name the key to fix")
		}},
		{"reads a cap written as a numeric string", `{"max_architect_calls":"1"}`, map[string]string{"architect_calls": "1"}, "architect", func(t *testing.T, repo string, r Result) {
			expectStatus(t, r, 2, `a cap of "1" did not stop a second call`)
			mustMatch(t, `budget exhausted`, r.Stderr, "no budget message")
		}},
		// Some editors open a JSON file with a byte-order mark; every reader drops it.
		{"reads a cap written after a byte-order mark", "\xef\xbb\xbf" + `{"max_architect_calls":1}`, map[string]string{"architect_calls": "1"}, "architect", func(t *testing.T, repo string, r Result) {
			expectStatus(t, r, 2, "a cap of 1 behind a byte-order mark let a second call through")
			mustMatch(t, `budget exhausted`, r.Stderr, "no budget message")
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			repo := makeRepo(t, repoOpts{})
			if c.config != "" {
				write(t, filepath.Join(repo, ".claude", "spec-flow.config.json"), c.config)
			}
			for k, v := range c.counts {
				write(t, statePath(repo, k), v)
			}
			c.check(t, repo, runHook(t, "opus-budget", spawnOf(c.spawn), repo))
		})
	}
	t.Run("stops the architect at 3 by default while the planner still has budget", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		write(t, statePath(repo, "architect_calls"), "3")
		a := runHook(t, "opus-budget", spawnOf("architect"), repo)
		expectStatus(t, a, 2, "a fourth architect call went through")
		mustMatch(t, `max_architect_calls`, a.Stderr, "the denial does not name max_architect_calls")
		expectStatus(t, runHook(t, "opus-budget", spawnOf("planner"), repo), 0, "the planner was denied by the architect's budget")
	})
}

func TestRegisterAgentRecordsAnOpusSessionID(t *testing.T) {
	repo := makeRepo(t, repoOpts{})
	r := runHook(t, "register-agent", map[string]any{"tool_input": map[string]any{"subagent_type": "planner"}, "tool_response": map[string]any{"agent_id": "a1b2c3d4e5f6a7b8"}}, repo)
	expectStatus(t, r, 0, "register-agent")
	if reg := read(statePath(repo, "agent-registry")); !strings.Contains(reg, "a1b2c3d4e5f6a7b8 planner") {
		t.Fatalf("registry has: %q", reg)
	}
}

func bash(cmd string) map[string]any {
	return map[string]any{"tool_name": "Bash", "tool_input": map[string]any{"command": cmd}}
}

func TestNoGateCmds(t *testing.T) {
	cases := []struct {
		name, cmd string
		want      int
	}{
		{"denies a whole-repo run", "npm run test", 2},
		{"allows the declared scoped command", "npm run check", 0},
		{"allows a path-scoped tool run", "eslint example/thing.ts", 0},
		{"denies a bare unscoped tool run", "eslint", 2},
		// `run` was read as a scope, so `ftest run` put the whole suite in context.
		{"denies a runner subcommand with no path", "npx ftest run", 2},
		{"denies a flag value posing as a scope", "eslint --max-warnings 0", 2},
		{"allows a subcommand plus a test path, the red run test-first asks for", "npx ftest run tests/a.spec.ts", 0},
		{"reads quoted text as data, not as a command", `git commit -m "fix; ftest covers it"`, 0},
		{"still reads a quoted test path as a scope", `ftest "tests/a.spec.ts"`, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			repo := makeRepo(t, repoOpts{})
			expectStatus(t, runHook(t, "no-gate-cmds", bash(c.cmd), repo), c.want, c.cmd)
		})
	}
	t.Run("does not tell the implementer to skip its red run", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{})
		r := runHook(t, "no-gate-cmds", bash("npm run test"), repo)
		mustNotMatch(t, `do not need to run anything`, r.Stderr, "it tells the implementer to run nothing")
		mustMatch(t, `test file's path`, r.Stderr, "the denial never names the scoped form a red run takes")
	})
	t.Run("a runtime that is also the runner is denied only for its test subcommand", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{contractEdit: func(c map[string]any) { sub(c, "unscoped_denied")["tools"] = []any{"bun"} }})
		expectStatus(t, runHook(t, "no-gate-cmds", bash("bun add zod"), repo), 0, "`bun add` was denied as a whole-suite run")
		expectStatus(t, runHook(t, "no-gate-cmds", bash("bun test"), repo), 2, "an unscoped `bun test` was allowed")
	})
	t.Run("is transparent outside implement", func(t *testing.T) {
		repo := makeRepo(t, repoOpts{phase: "idle"})
		expectStatus(t, runHook(t, "no-gate-cmds", bash("npm run test"), repo), 0, "outside a run")
	})
}

// The denial redirects an implementer that cannot install anything, so the
// install-free route it names must be a file this engine ships.
func TestNoGateCmdsNamesAnInstallFreeCheckThatExists(t *testing.T) {
	changedInPort(t, "the route is the engine's own bin/spec-flow, not a script under node")
	repo := makeRepo(t, repoOpts{})
	r := runHook(t, "no-gate-cmds", bash("npm run test"), repo)
	m := regexp.MustCompile(`(?m)^\s*(\S+/bin/spec-flow) check\s*$`).FindStringSubmatch(r.Stderr)
	if m == nil {
		t.Fatalf("the denial names no install-free route:\n%s", r.Stderr)
	}
	if !exists(m[1]) {
		t.Fatalf("it names %s, which does not exist", m[1])
	}
}

// Fix (c): a whole-repo script handed a path is scoped, as the tool run on a
// path is, and a leading assignment does not hide the program. Fails on the
// JavaScript engine: it denied `npm test -- <path>` and let
// `NODE_ENV=test ftest run` through.
func TestNoGateCmdsReadsAScriptHandedAPathAndAnAssignedEnvironment(t *testing.T) {
	for _, c := range []struct {
		cmd  string
		want int
	}{
		{"npm test -- tests/a.spec.ts", 0},
		{"npm run test -- tests/a.spec.ts", 0},
		{"npm test -- --watch", 2},
		{"NODE_ENV=test ftest run", 2},
		{"NODE_ENV=test ftest run tests/a.spec.ts", 0},
	} {
		t.Run(c.cmd, func(t *testing.T) {
			repo := makeRepo(t, repoOpts{})
			expectStatus(t, runHook(t, "no-gate-cmds", bash(c.cmd), repo), c.want, c.cmd)
		})
	}
}

func TestRunTraceLogsASourceWrite(t *testing.T) {
	repo := makeRepo(t, repoOpts{})
	expectStatus(t, runHook(t, "run-trace", map[string]any{"tool_name": "Write", "tool_input": map[string]any{"file_path": "example/thing.ts"}}, repo), 0, "run-trace")
	if !strings.Contains(traceText(repo), "write file=example/thing.ts") {
		t.Fatalf("log: %s", traceText(repo))
	}
}

// changedInPort skips, on the JavaScript engine, a case whose subject the
// port changed on purpose.
func changedInPort(t *testing.T, why string) {
	t.Helper()
	if oracle != "" {
		t.Skip("changed in the port: " + why)
	}
}

var _ = fmt.Sprint
