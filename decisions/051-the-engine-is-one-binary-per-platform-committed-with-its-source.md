# ADR-051 — the engine is one binary per platform, committed with its source

**Date:** 2026-10-31 · **Status:** accepted · **Governs:** `cmd/spec-flow`, `internal/`, `bin/`, `hooks/hooks.json`, `internal/build`, `.github/workflows/ci.yml` · **Replaces:** ADR-016 and ADR-019, deleted · **Withdraws:** the Node half of ADR-004

**Question.** Every hook, script and check ran on Node: a floor every machine
that adopted the engine had to meet (ADR-004), a process start on every hook
call, and two thousand lines of fixtures in a second language from the code
they test. Bash had been tried and left, because a hook that cannot parse
JSON fails open. What should the engine run on?

**Measured.**
- A `PreToolUse` hook call: about 83 ms under node 22, about 18 ms for the Go
  binary through the launcher (50 calls each, Linux).
- Four defects found while porting, each with a test that fails on the last
  Node engine and passes on this one: `scope_globs` read as a glob over an
  absolute path rather than as the gate's git pathspec; `phase-guard` reading
  a phase written by `printf` with escapes; `no-gate-cmds` passing a whole-repo
  script handed a path or an assigned variable; `stats` counting no failure,
  because the gate writes `fail:<class>`, never `fail`.
- The Go build is reproducible: the same source and Go release give the same
  bytes from another path with an empty build cache.

**Decision.**
- One Go program, `spec-flow`: every hook as `spec-flow hook <name>` and every
  command a terminal, CI or the orchestrator runs. `hooks.json` runs it in exec
  form — `${CLAUDE_PLUGIN_ROOT}/bin/spec-flow` with `["hook", "<name>"]`, no
  shell.
- The binaries are committed: `bin/<os>-<arch>/spec-flow` for Linux and macOS
  on x86-64 and arm64, behind the POSIX launcher `bin/spec-flow`, and
  `bin/spec-flow.exe` for Windows on x86-64, which a spawn of `bin/spec-flow`
  resolves to there. The plugin is a copy of a commit, so the copy runs with no
  toolchain and no network. `go run ./internal/build` writes them; a test
  rebuilds each and fails unless it is the committed file byte for byte.
  `.gitattributes` keeps the source LF, which the bytes depend on.
- One repository, one distribution, as ADR-016 decided: nothing is published to
  a registry. A terminal or CI without Claude Code runs a clone's
  `bin/spec-flow`. A test runs a fresh clone, so what ships is what is
  committed.
- No Node floor, and no Node: `preflight` checks no runtime. `cc=` stays
  recorded, not checked (ADR-004). `engine=` falls back to `v?` where a copy
  has no `.git` and is not named for a commit (ADR-018): there is no package
  version to fall back to.
- The live view is a mod and runs no binary's code, so it keeps its own
  TypeScript copy of the readers it shares with the hooks
  (`hooks/live-view-readers.ts`); `hooks/readers.golden.ts` holds both copies
  to the same answers. Past what one read takes, a log is streamed by
  `spec-flow lines` (ADR-047).
- CI, as ADR-019 found: Linux and Windows, `fail-fast: false`; one red leg is a
  portability fact. `go test ./...` is every check; the live view runs on the
  newest Claude Code, installed without Node.
- The adopter's side is unchanged: the supported scope is a Node repository
  (ADR-007), and the tests that model one use the machine's `node`.

**Where each file went.** A record names the file it governed when it was
written:

| was | is |
|---|---|
| `hooks/<name>.mjs` | `spec-flow hook <name>`, `internal/hooks` |
| `hooks/lib/io.mjs`, `hooks/lib/can-run.mjs`, `hooks/lib/human-turn.mjs` | `internal/hookio`, `internal/canrun`, `internal/humanturn`, `internal/shell` |
| `hooks/lib/routing.mjs`, `budgets.mjs`, `dispatch.mjs`, `agent-name.mjs`, `agent-cache.mjs`, `handback.mjs`, `milestone-ref.mjs`, `project-config.mjs` | `internal/agents` |
| `hooks/lib/log-lines.mjs` | `spec-flow lines`, and `hooks/live-view-readers.ts` |
| `scripts/spec-trace.mjs`, `spec-shape.mjs`, `spec-time.mjs`, `test-report.mjs`, `trace-lines.mjs` | `internal/spectrace` (`spec-flow trace`), `internal/specshape`, `internal/spectime`, `internal/testreport`, `internal/tracelines` |
| `scripts/agent-blocks.mjs`, `argv.mjs`, `changed-files.mjs`, `unscoped-checks.mjs`, `spec-flow-config.mjs`, `engine-revision.mjs` | `internal/agentblocks`, `internal/argv`, `internal/gitscope`, `internal/unscoped`, `internal/contract`, `internal/engine` |
| `scripts/init.mjs`, `check-changed.mjs`, `resume.mjs`, `status.mjs`, `specflow-stats.mjs`, `telemetry-snapshot.mjs`, `model-routing.mjs` | `spec-flow init`, `check`, `resume`, `status`, `stats`, `telemetry`, `models` (`internal/cli`) |
| `bin/spec-flow.mjs` | `cmd/spec-flow`, behind `bin/spec-flow` |
| `scripts/*-fixture.mjs`, `hook-smoke.mjs`, `cold-start.mjs`, `test/*.test.mjs` | `internal/e2e`, and each package's tests |
| `scripts/no-repo-refs.mjs`, `model-pins.mjs`, `decisions.mjs`, `comment-transitions.mjs`, `agent-contracts.mjs`, `plugin-paths.mjs`, and their fixtures | `internal/repocheck` |

**Refused.**
- **Bash.** A hook that parses JSON and XML in shell fails open where it
  cannot parse, and Windows is a supported platform.
- **Building at install or at session start.** It needs a Go toolchain on every
  machine, and every hook of the first session would wait on a build or fail
  without one.
- **Downloading a release binary.** Network at hook time, and a second
  distribution that can sit at a different commit from the plugin — the drift
  ADR-016 closed.
- **Keeping Node for the scripts alone.** The floor would stay, for half the
  engine.

**Cost.** About 18 MB of binaries per commit that changes the engine, in the
repository's history for good. And on Windows the hooks rely on a spawn of
`bin/spec-flow` resolving to `bin/spec-flow.exe`: Go's own spawn does, which
CI exercises on Windows; Claude Code's has not been run here.
