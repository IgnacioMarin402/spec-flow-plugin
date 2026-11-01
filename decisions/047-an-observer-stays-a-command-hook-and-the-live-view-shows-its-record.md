# ADR-047 — an observer stays a command hook, and the live view shows its record

**Date:** 2026-10-17 · **Status:** accepted; a log past one read streamed by `spec-flow lines`, not node, and the view's readers a TypeScript copy held to the hooks' by a golden table, per [ADR-051](051-the-engine-is-one-binary-per-platform-committed-with-its-source.md) · **Governs:** `hooks/live-view.tsx`, `hooks/live-view-state.d.ts`, `hooks/lib/budgets.mjs`, `hooks/lib/project-config.mjs`, `hooks/lib/log-lines.mjs`, `hooks/lib/milestone-ref.mjs`, `hooks/opus-budget.mjs`, `hooks/agent-gate.mjs`, `hooks/gate.mjs`, `scripts/agent-blocks.mjs`, `REFERENCE.md`, `BACKLOG.md` · **Amends:** ADR-037 (what a mod may read) · **Related:** ADR-029, ADR-031, ADR-034, ADR-036, ADR-038

**Question.** A mod may only show (ADR-029, ADR-037). Five hooks only observe:
`human-turn`, `register-agent`, `run-trace`, `dispatch-guard` and `token-trace`;
so do five scripts. Could any of them be a mod, and what would a mod add?

**Measured.** What each writes, and who decides with it:

| hook | writes | decided on by |
|---|---|---|
| `human-turn` | `human-turn.log` | `phase-guard` and `arm-gate`, the case 3 check (ADR-036) |
| `register-agent` | `agent-registry`, `current-milestone` | `opus-budget`, charging a `SendMessage`; `resume` |
| `run-trace` | `run-trace.log` | `agent-gate`, whether a return is owed and its blocks so far; `orchestrator-scope`, which arms once the trace attributes a tool call; `token-trace`, the turn that closed the run |
| `dispatch-guard` | `dispatch` lines | `stats`, and the evidence ADR-035 asks for before a rule denies |
| `token-trace` | `tokens` lines | `status`, `stats` and the snapshot; no hook |

What each script reads, and what a mod would add:

| script | reads | a mod would add |
|---|---|---|
| `status` | `.claude/state/` | nothing the live view lacks; it answers from a terminal, outside any session |
| `resume` | `.claude/state/` and `specflow/` | nothing: `/spec-flow:resume` acts on its `NEXT:`, and a mod does not read `specflow/` |
| `stats` | each archived run's telemetry | nothing: it compares runs, not one session |
| `telemetry` | `run-trace.log`, `gate-history.log` | nothing: its job is the snapshot the fold commits, and a mod writes nothing |
| `models` | the agents, the second config file, the environment | nothing: the view names the model each box ran on |

On 2.1.246 a module is not loaded, and nothing says so (ADR-037).

**Decision.**

- No observer moves to a mod. Four write what a hook decides on, and a mod
  writes nothing the engine reads. `token-trace` is the record (ADR-037), and
  Claude Code's events do not carry the advisor's tokens.
- The live view shows what those records already hold:
  - the checks whose own log says they stood down during this run:
    `orchestrator-scope` with no attributed tool call, and the case 3 check
    with no answer ever recorded;
  - the checks a failing gate line names with a non-zero code;
  - each agent the agent gate sent back, how often against its cap, and why;
  - the planner and architect calls against their caps.
- It reads the caps from `.claude/spec-flow.config.json`, through the function
  `opus-budget` denies with. That file is the one it reads outside
  `.claude/state/`: a cap it showed by any other reading could differ from the
  one that denies.
- A record it cannot read is said, never shown as empty.

**Refused.**

- **Moving `token-trace` to a mod for its exact output count.** A mod cannot
  write the record, and it would lose the advisor's tokens.
- **Showing a case 3 waiting for its answer.** The brief is in `specflow/`,
  which a mod does not read.
- **The other `*-unmatched.log` files.** They keep one line per shape, with no
  time, so a line cannot be placed in this run.

**Cost.** The view reads a log again whenever it changes, and `run-trace.log`
and `gate-history.log` are never truncated. Past what one read takes (4 MiB),
node streams the whole log at each change and hands back how many lines count
and the last 10000 of them (`hooks/lib/log-lines.mjs`): the count stays exact,
a send-back more than 10000 back goes unshown, and the time grows with the log,
about half a second at 46 MiB. Where node cannot run, the log is said unread.
The agent gate's line and the two logs' timestamps are read by the view as well
as by the engine.
