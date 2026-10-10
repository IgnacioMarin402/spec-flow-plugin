# ADR-029 — the session orchestrates, checks run where a terminal and CI can, and a mod only shows

**Date:** 2026-10-08 · **Status:** accepted · **Governs:** `commands/spec-flow.md`, `BACKLOG.md` · **Related:** ADR-010, ADR-016, ADR-019, ADR-023

**Question.** Two shapes came up once cheaper models made more agents
affordable: a dedicated orchestrator agent, and enforcement written as a mod
(a plugin of function hooks that runs inside Claude Code, can block a
subagent's stop and can draw a pane). Where does orchestration live, and where
may a check that denies or blocks live?

**Measured.** The gate and the wake-up after a green gate ride the main
session's `Stop` (ADR-010); the phase is owned by the session that wrote it;
a background spawn's completion notice reaches the main session (ADR-023);
the sign-off needs the human's chat. On Claude Code 2.1.294 a `SubagentStop`
command hook that blocks makes the agent continue, so blocking needs no mod.
A mod runs only inside Claude Code, with no Node, while the engine also runs
from a terminal without Claude Code and from CI (ADR-016) on Node 22 and 24,
Linux and Windows (ADR-019).

**Decision.**

- The orchestrator is the session running the command, never a subagent.
- A check that denies or blocks is a command hook or a script: it runs from
  Claude Code, the CLI and CI, and its fixtures run without network.
- A mod may only show state already written under `.claude/state/`. It is
  optional and gates nothing.

**Refused.**

- An orchestrator agent: it would take the gate, its wake-up, phase ownership,
  the notices and the sign-off away from the one session that receives them.
- Pinning the command's model before the orchestrator's cost is measured
  (BACKLOG B40): whether a pin holds across the turns a gate or a notice wakes
  is unmeasured, and a prompt cache is per model, so switching costs both.
- Enforcement in a mod: the CLI and CI could not run it, and its tests would
  need Claude Code in CI.

**Cost.** The orchestrator runs on whatever model the human's session uses,
and what that costs a run is unknown until the telemetry reports it per run.
