# ADR-031 — an agent's return is checked before the orchestrator acts on it

**Date:** 2026-10-09 · **Status:** accepted · **Governs:** `hooks/agent-gate.mjs`, `hooks/lib/handback.mjs`, `hooks/run-trace.mjs`, `scripts/agent-blocks.mjs`, `scripts/specflow-stats.mjs` · **Related:** ADR-023, ADR-029, ADR-030

**Question.** The orchestrator acts on an agent's return block and nothing
else. A reply with no block, a status the contract never declares, or a path
to a file that was not written reaches it as something no step of the command
routes, and a cheaper tier on a role makes that likelier. Where is a return
held to its contract, and what happens when it fails?

**Measured.** On Claude Code 2.1.294 a `SubagentStop` command hook that
answers `decision: block` makes the agent continue with the reason; its next
stop carries `stop_hook_active: true` and the same `agent_id`, and the caller
receives the answer given after the block. run-trace records one return line
per agent, at its first stop (ADR-023). The hook takes 50–58 ms per stop on
the machine that wrote this.

**Decision.**

- `agent-gate`, a `SubagentStop` command hook beside run-trace, sends back a
  return that is empty, has no `STATUS:`, names a status its contract does not
  declare (`agents/<name>.md` and its `modes/<name>-*.md`), or has a `*_PATH`
  naming a file that is not there.
- It judges only `spec-flow:<name>` for an agent this plugin ships, and only
  in a run the calling session owns (ADR-017).
- At most two blocks per agent, counted from its own `agent-check` lines in
  `run-trace.log`. With no agent id, only a first stop is blocked. No state
  file.
- A spec-writer's return is also held to ADR-030. What it cannot judge — no
  contract, or reads with no agent id — goes through, with an `agent-check`
  line saying what was skipped.
- Anything it cannot read lets the return through, and so does a crash.
- run-trace stays the only recorder of returns, and both read the status
  through one function.

**Refused.**

- Recording the return after a block instead of at the first stop: it would
  amend ADR-023, and a run's stats would mix two meanings of a return line. A
  blocked return the agent then changes stays recorded as the first; the
  `agent-check` lines count how often, and this is revisited if they show it.
- Requiring return fields no command reads: each block costs the agent a turn.
- A mod: the CLI and CI could not run it (ADR-029).

**Cost.** One Node process per subagent stop, and a turn per block, at most
two per agent.
