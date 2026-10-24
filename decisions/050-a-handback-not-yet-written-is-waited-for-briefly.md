# ADR-050 — a handback not yet written is waited for, briefly

**Date:** 2026-10-24 · **Status:** accepted · **Governs:** `hooks/lib/handback.mjs`, `hooks/run-trace.mjs`, `hooks/agent-gate.mjs`, `scripts/hook-smoke.mjs` · **Related:** ADR-023, ADR-031

**Question.** `run-trace` and `agent-gate` read an agent's return at
`SubagentStop`, from the `SubagentHandback` call in its transcript or else the
payload's `last_assistant_message`. On a real run the return was sometimes
neither. What does the stop carry, and when does the handback land?

**Measured.**

- A real `/spec-flow` run on `a64bd7a`, Claude Code 2.1.310, `claude -p`:
  of 8 agents, `run-trace` recorded 5 returns, and `agent-gate` logged
  `skip why=empty` for 4. `specflow-stats` read the reviewer as one
  `APPROVED` where it had answered `CHANGES_REQUESTED` and then `APPROVED`.
  Every agent's transcript held its handback afterwards.
- A probe `SubagentStop` hook on the same build, polling the transcript every
  10 ms from the moment it started, over 6 agents and 10 stops. Two shapes:
  - one stop, no `last_assistant_message`, the handback already written;
  - a first stop carrying `last_assistant_message` and no handback, then a
    second with `stop_hook_active: true`, no last message, and a handback that
    was written 23, 48 and 80 ms after the hook started in three of four. At
    the first stop it never appeared while the hook ran: the agent goes on to
    hand back only once the hook has finished.

**Decision.** The handback wins when it is written, then the last message. A
stop that carries neither, with a transcript to read, polls it every 25 ms for
up to 2 s. One function serves both hooks, so they still read the same return
(ADR-031).

**Refused.**

- Waiting at a stop that carries a last message: its report is in hand, and
  the handback it would wait for is written only after this hook returns.
- Recording the return at a later event, such as the orchestrator's next tool
  call: after a background spawn its turn has already ended (ADR-023), and the
  agent gate has to judge at the stop to send a return back.
- Reading the report off the orchestrator's transcript: it reaches the caller
  after the stop, so the same race, on a larger file.
- An unbounded wait.

**Cost.** A stop with neither a message nor a written handback holds the agent
for as long as the line takes to land, up to 2 s, in each of the two hooks,
which run in parallel. On a build that never writes either,
every stop pays it once and is read as empty, as before.
