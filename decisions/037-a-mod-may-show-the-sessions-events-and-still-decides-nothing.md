# ADR-037 — a mod may show the session's own events, and still decides nothing

**Date:** 2026-10-11 · **Status:** accepted · **Governs:** `hooks/live-view.tsx`, `hooks/live-view-state.d.ts`, `hooks/hooks.json`, `.claude-plugin/plugin.json`, `.github/workflows/ci.yml`, `scripts/plugin-paths.mjs`, `REFERENCE.md`, `BACKLOG.md` · **Amends:** ADR-029 (what a mod may show) · **Related:** ADR-004, ADR-016, ADR-017, ADR-019, ADR-023, ADR-035, ADR-036

**Question.** A person watching a run wants to see each agent while it works:
its role, how long it has run, its tool calls, its tokens, and what it handed
back. ADR-029 lets a mod show only what is already under `.claude/state/`. Is
that enough? If not, what may a mod read, where does it ship, and against which
Claude Code is it tested?

**Measured.**

- `.claude/state/` does not hold it while it happens:
  - nothing records when an agent was spawned. `agent-registry` pairs an id
    with a role for the planner, architect and implementer only, and
    `dispatch` lines record only a departure from the commands (ADR-035);
  - an agent's reads, writes and test runs carry its `agent_id` but not its
    role, which arrives with its return line;
  - `token-trace` writes tokens at the session's `Stop`, so a subagent's appear
    only after the turn that waited on it has ended.
- Claude Code's function-hook API (the 2.1.295 declarations) carries all of
  it, joined by one id: `agent.spawn` resolves the role and the `agentId`;
  `tool.call` and `turn.step` carry that `agentId`; `turn.step` resolves the
  request's usage; `turn.complete` carries the report the agent handed back.
  No join is inferred.
- A prototype mod built on those events passes `claude plugin test` 8 of 8 on
  the terminal and desktop surfaces, on 2.1.283, 2.1.287, 2.1.293 and 2.1.295,
  with an empty config directory and no credentials. Three mutations each fail
  it: a call charged to the wrong agent, the status not read, a resumed agent
  left finished. On Windows the kit spelled `/repo/.claude/state/phase` as
  `C:\repo\.claude\state\phase`.
- One `hooks.json` can hold the engine's command hooks and the mod's module.
  A copy of the engine with both, plus a probe on each side, ran one headless
  session per version:

  | Claude Code | command hooks | module |
  |---|---|---|
  | 2.1.246 | fired | not loaded, nothing said |
  | 2.1.283, 2.1.287, 2.1.295 | fired | loaded, its hooks fired |

- The transcripts hold the same counts. Read for the 11 agents of one real
  run, they equalled `token-trace`'s lines exactly. ADR-036 refused reading
  them, because the format is internal and written asynchronously.
- One real run watched with the mod (five agents, Claude Code 2.1.287):
  - for every agent, its uncached input, cache reads, cache writes and
    requests equalled `token-trace`'s;
  - its output was higher for every agent, by 1,096 to 2,355 tokens, 22.7%
    across the five. `token-trace` documents its output as a floor, while the
    mod reads each request's final usage;
  - the orchestrator's 26 requests were one request off at each end of the
    run. The mod counted from when its poll saw the phase; `token-trace`
    charges whole turns at `Stop`.
- Not measured: whether the desktop app places a pane; any version between
  2.1.246 and 2.1.283.

**Decision.**

- A mod may show, besides `.claude/state/`, what Claude Code's events tell it
  about the session it runs in: spawns, tool calls, model requests and turn
  ends. The rest of ADR-029 stands. A mod writes nothing the engine reads,
  denies and blocks nothing, and no hook, script or command depends on it.
- It never reads a transcript (ADR-036).
- It shows tokens, never dollars per role. The API reports dollars for the
  whole session, and a share per role would be a guess: spawns run in the
  background (ADR-023), and the architect runs inside the implementer.
- It shows a phase only as the engine reads one. A phase owned by another
  session, or committed by the repository, is not this session's run
  (ADR-017).
- The record stays `token-trace`'s. `status`, `stats` and the telemetry
  snapshot report what the run wrote. A mod's numbers are a view of the same
  requests: for a finished agent, a difference between the two is a defect in
  one of them, not a second answer.
- It ships inside `spec-flow`: its module goes in the engine's `hooks.json`,
  beside the command hooks, so it is always at the engine's commit and reads
  the state formats of that commit (ADR-016). An option in the plugin's
  settings turns it off.
- No floor is declared, for the mod or the engine. A Claude Code without
  function hooks skips the module, and the engine runs as before (2.1.246
  measured). ADR-004 stands for both: the version is recorded, not checked.
- CI runs the mod's `claude plugin validate` and `claude plugin test` against
  the newest Claude Code release, on both operating systems ADR-019 runs, and
  prints the version it ran:
  - a new release of the early-access API is what breaks the mod, and the
    newest release is what an auto-updating session runs;
  - a test nobody runs looks armed and is not;
  - path spelling differs by platform;
  - the tests need no credentials.
- It charges the orchestrator per turn, as `token-trace` does: a turn that ends
  inside this session's run counts whole, and one that ends outside it counts
  nothing.
- It enters the repository after one real run shows, for every agent that
  finished, input and request counts equal to `token-trace`'s, and output no
  lower than `token-trace`'s floor.

**Refused.**

- **Keeping a mod to `.claude/state/` and writing more there.** No command
  hook fires per model request, so live tokens would still have to come from
  the transcript ADR-036 refused. A hook process per tool call would also be
  paid for a display alone.
- **A separate plugin for the mod.** Two installs update separately and can
  sit at different commits, and the mod reads formats the engine writes: the
  drift ADR-016 closed for the npm copy.
- **A Claude Code floor for the engine.** On 2.1.246 the engine's hooks fire
  with the module beside them, so a floor would deny runs that work.
- **Testing a pinned Claude Code, declared as the mod's floor.** It proves a
  version nobody runs, misses the release that breaks the mod, and is one more
  number to keep moving.
- **A `spec-flow watch` script.** It needs a second terminal beside the
  session, and it reads the transcripts to get tokens. The prototype worked
  and is not kept.
- **Enforcement in a mod.** Still refused, for ADR-029's reasons.
- **Dollars per role.** See the decision.

**Cost.**

- The function-hook API is early access and may change between releases
  without notice. A hook that throws is skipped: the pane goes blank or wrong
  and nothing in the run notices.
- CI tests the newest release only. A release that breaks the mod turns the
  next CI run red, whatever change it was for. An old commit cannot be re-run
  on the version it passed with, though each run's log names that version.
- Claude Code is installed in each CI job that tests the mod.
- Unless the option is off, a hook runs on each model request and each tool
  call in every session where `spec-flow` is installed, in a run or not.
