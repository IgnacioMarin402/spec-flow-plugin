# ADR-023 — every spawn runs in the background

**Date:** 2026-09-27 · **Status:** accepted · **Governs:** `hooks/model-route.mjs`, `hooks/gate.mjs`, `hooks/run-trace.mjs`, `commands/` · **Extends:** ADR-010

**Question.** A foreground spawn shows the human nothing until it returns. A
spec-writer inheriting a `max` session spent 3.5 minutes on one silent turn;
the human read it as hung and interrupted it at six minutes, and the relaunch
started from zero — 8 turns, 379k cache-read and 77k cache-write tokens, gone.
The commands already allowed the background ("subagents may run in the
background") and the orchestrator still launched in the foreground.

**Measured** on Claude Code 2.1.283, with a probe hook and a `claude -p` run:

- A PreToolUse `updatedInput` carrying `run_in_background: true` is honoured:
  the spawn returns `{isAsync: true, status: "async_launched", …}`.
- The orchestrator's turn ends right after the launch. That Stop's payload
  lists the agent in `background_tasks` as `{type: "subagent", status:
  "running"}`; the Stop after the agent finishes lists nothing.
- `SubagentStop` fires in both modes, with `agent_type`, `agent_id`,
  `last_assistant_message` and `agent_transcript_path`. On the desktop build
  (2.1.281) the report travels through `SubagentHandback` and the agent's last
  message is "Report delivered…", so the report is in the handback call.
- A spawn's tool response echoes the prompt AHEAD of the report, in both modes.
- `claude -p` terminates background agents still running 600 s after its turn
  ends ("Background tasks still running after 600s; terminating"), and runs its
  hooks with `CLAUDE_CODE_SESSION_ATTENDED=0`; an interactive desktop session
  has `1`.

**Decision.** `model-route` sets `run_in_background: true` on every spawn of
this plugin's agents in an attended session, in the hook that already rewrites
the spawn. An unattended one (`claude -p`) keeps the orchestrator's choice:
nobody watches its chat, and its harness kills a long background agent. The
rule is only safe with three changes beside it:

- the gate judges nothing while `background_tasks` lists a running subagent.
  Otherwise the stop right after a spawn judges the previous commit: a pass
  tells the orchestrator to advance past work still being written, and after a
  failure the same commit fails again and spends an attempt;
- `run-trace` records an agent's return at its first `SubagentStop`, not off
  the spawn's response, which is a launch receipt here and echoes the prompt
  everywhere;
- the commands tell the orchestrator to end its turn after a launch and wait
  for the completion notification.

**Refused.**

- The sentence alone: it was already there, and did not hold.
- A second PreToolUse hook for the flag: each sibling is handed the original
  input, so two rewrites of one spawn would each drop the other's field.
- Waiting on background shells too: a dev server may never finish, and would
  hold the gate open for good.
- Forcing it under `claude -p` too, with `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`
  documented: a headless run that missed the sentence dies at ten minutes.

**Cost.** One more orchestrator turn per spawn — launch, end the turn, wake on
the notification. A spawn outside a run, a one-off question to the architect,
also answers through a notification instead of in the same turn. The
unattended exception rests on an undocumented variable: if it goes, a headless
run is sent to the background and dies loudly at 600 s, with the harness naming
the variable that lifts the ceiling.
