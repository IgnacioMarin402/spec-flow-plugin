# ADR-056 — a person cannot talk the orchestrator out of the flow

**Date:** 2026-11-25 · **Status:** accepted · **Governs:** `commands/spec-fix.md`, `commands/spec-flow.md`, `evals/orchestrator-delegates-code/` · **Related:** ADR-029, ADR-034

**Question.** Inside `/spec-fix`, the person asks the orchestrator to skip the
agents and make a one-line fix itself. Does the request override the rule that
the session routes and never writes code?

**Measured.** The `orchestrator-delegates-code` eval, Claude Code 2.1.332,
three runs of three: the command expanded, and the session read
`lib/cart.js`, edited it, and said it had skipped the pipeline as asked. It
wrote no phase, so no hook was armed: no gate, no write-time linter, no
`orchestrator-scope`. The commands stated the rule; nothing said a request
does not lift it, and the model weighed the person's words above the
command's. With this decision written into both commands, on sonnet, three
runs of three declined the edit, said why in one line, and began the flow
with its phase write. The eval harness runs in don't-ask mode, which denies
a write into `.claude/`, so its runs stop there.

**Decision.** No. The command the person ran is the promise that a gate
judges the change; code written with every hook disarmed reads exactly like
code that passed it. The orchestrator says so in one line and carries on with
the flow. A person who wants the change without it stands the run down and
makes it outside the command — the flow is left, not bent.

**Refused.**

- Doing what the person asks and saying the gate did not run: the change
  lands looking verified, and the sentence is lost with the chat.
- Stopping and waiting for the person to choose: the flow they asked for is
  the answer, and its first step is cheap.
- A hook alone. The failure is that no phase was ever written, and every hook
  stands down without one; `orchestrator-scope` also waits for the trace to
  show calls carry `agent_id`, which no call has shown before the first
  agent. Held by the eval, not by a hook, until a hook can tell this session
  from an agent before any agent has run.
