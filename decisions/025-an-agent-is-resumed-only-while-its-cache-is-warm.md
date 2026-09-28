# ADR-025 — an agent is resumed only while its cache is warm

**Date:** 2026-09-28 · **Status:** accepted · **Governs:** `hooks/stale-resume.mjs`, `hooks/lib/agent-cache.mjs`, `hooks/opus-budget.mjs`, `commands/` · **Refines:** the session-reuse rule in `commands/spec-flow.md` step 4

**Question.** The commands told the orchestrator to send every follow-up for a
milestone to the implementer it already had, because a fresh session writes a
cold cache. An orchestrator took that for a general rule: twelve hours after a
spec-writer finished, it resumed that same agent with the human's sign-off
feedback, to add one requirement.

**Measured.** Every subagent turn writes its cache as `ephemeral_5m`; the
session's own turns write `ephemeral_1h`. The resumed spec-writer's first turn
read nothing from the cache and wrote 205,969 tokens — its whole context, to
decide to load a skill — and its next nine turns re-read 206k to 252k each for
edits of a few lines: about 2.1M cache-read and 252k cache-write tokens for one
requirement. Replayed against the transcript as it stood before that message,
`stale-resume` denies it: last turn 768 minutes earlier, a 5-minute cache,
~205k to re-send.

**Decision.** A `SendMessage` to one of this plugin's agents is allowed while
its cache is warm and denied once it is cold, during a run, for every role.
The TTL is read off the agent's own last cache write, and its age off its
transcript's last write — later than the request that last touched the cache,
so a denial is never wrong about the cache being cold. `opus-budget` asks the
same function and does not charge a message that will be denied. The commands
send what waited on a human, or on a long gate, to a new agent of the same
role with its predecessor's inputs.

**Refused.**

- The sentence alone: the old one was a sentence, and was generalised past
  where it held.
- Always a fresh agent: a retry within minutes reads its context at cache
  price, which is what the reuse rule was right about.
- A threshold on context size: an invented number. The cache's lifetime is
  measured, per agent, on every turn.
- Denying without telling `opus-budget`: every cold resume of the planner or
  the architect would be billed twice, once refused and once respawned.

**Cost.** A new agent re-reads its inputs, and whatever its predecessor
reasoned but did not write down is gone. The denial costs the orchestrator one
more turn.
