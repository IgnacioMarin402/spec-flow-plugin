# ADR-017 — a repository does not get to arm this engine

**Date:** 2026-08-23 · **Status:** accepted · **Governs:** `hooks/lib/io.mjs`, `hooks/gate.mjs`, `hooks/phase-guard.mjs`, `hooks/session-start.mjs`, and every other hook that reads the phase · **Related:** ADR-010

**Question.** Every enforcement hook arms by reading `.claude/state/phase`. The
plugin is installed globally, so that file is one a cloned repository can
contain. Who wrote it, and did a run write it at all?

**Measured.** A repo with the phase committed as `implement` and a contract
whose commands wrote marker files outside it: ending a turn ran both commands.
`session-start` does not rescue it (a fresh checkout's mtime is seconds old).
And two sessions in one repo share the phase, the Opus budget and the attempt
counter.

**Decision.** Two questions, in `hooks/lib/io.mjs`:
- `readPhase` — **is it tracked by git?** Nothing in the engine commits the
  file, so a tracked phase reads as no phase, in every hook.
- `readOwnedPhase` — **did this session seal it?** `phase-guard` records the
  writer's `session_id` in `.claude/state/phase.session`. Only `gate.mjs` (Stop)
  and `opus-budget.mjs` (spawn) ask, because only they are certain to run in
  the orchestrating session; others fire inside subagents, whose payload is not
  guaranteed to carry the parent's id.

Both fail **closed**: no seal, no id, or no git leaves the phase honoured. Only a
seal naming a different, known session stands a hook down.

**Refused.** Calling this a security boundary (running a cloned repo's tests is
a risk of category); refusing to run in such a repo (not armed is already
transparent); sealing every hook (depends on undocumented harness behaviour, in
the direction that disarms); sealing the counters separately (their writers
already ask); a lock file (answers "may two sessions run", by refusing one).
