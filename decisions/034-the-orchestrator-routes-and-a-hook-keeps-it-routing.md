# ADR-034 — the orchestrator routes, and a hook keeps it routing

**Date:** 2026-10-11 · **Status:** accepted · **Governs:** `hooks/orchestrator-scope.mjs`, `hooks/hooks.json`, `commands/spec-flow.md`, `commands/spec-fix.md`, `REFERENCE.md` · **Related:** ADR-017, ADR-029, ADR-031, ADR-033

**Question.** The orchestrator is the session running the command (ADR-029),
and both commands say it routes and never writes code. What holds it to that?

**Measured.** Nothing. Every guard on it decides by phase, by spawn or by a
subagent's return (ADR-031); none told the session from a subagent on a read
or a write. On real runs it moved a human's parked plan out of `specflow/` to
get past a refusal, and read eleven source files a triage had just read —
which stayed in its context for the rest of the run, paid again on every
message (ADR-033).

**Decision.** During a run the session — a tool call that carries no
`agent_id` — reads, inside the repository, only `specflow/`, `specs/`,
`.spec-flow/`, `.claude/` and the root's `*.md`, and writes, moves or deletes
only under `.claude/state/` and `specflow/`. `orchestrator-scope`, a command
hook (ADR-029), denies the rest with the role that does the work instead.
Paths outside the repository are not its business, and a subagent is judged
by its own role, not by this. It arms once the run's trace shows this build
attributing tool calls to agents; before that it stands down and records it,
so a build without `agent_id` cannot have it deny an implementer's writes.

**Refused.**

- A mod: a command hook already sees every tool call and its `agent_id`, and
  its fixtures run without Claude Code. A mod would add a place to show state,
  which this check does not need.
- A warning instead of denying a read: the warning is more context in the
  same session, and the reads were the cost.
- Parsing every Bash form that reads or writes a file: `cat`, `awk`, a
  subshell. Like `no-gate-cmds` this is a consistency guard, not a security
  boundary; the plain forms a model reaches for are covered, and the gate
  still judges whatever lands in a commit.

**Cost.** A hook process on each of the session's file and Bash calls during a
run. Mid-run, a human cannot have the session edit code: the milestone's
implementer does it, or it waits until the run ends.
