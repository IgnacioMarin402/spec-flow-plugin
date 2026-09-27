# ADR-024 — a run resumes from what is on disk

**Date:** 2026-09-27 · **Status:** accepted · **Governs:** `scripts/resume.mjs`, `commands/resume.md`, `hooks/session-start.mjs` · **Related:** ADR-017, ADR-023

**Question.** A session that stops mid-run leaves no way back but starting over.
`/spec-flow` always enters at step 0: it resets the counters, sets a new
telemetry mark and re-invokes the spec-writer. On the run that prompted this,
the spec had cost two spec-writer runs and 205k of context, and the session
was only waiting for a sign-off. `session-start` knew how to say where an
abandoned run stood for one phase, `implement`, and told every other phase to
re-run `/spec-flow`.

**Measured.** What a run leaves on disk is enough to name its next step:
`specflow/<SLUG>/` holds the spec, the proposal, the plan and one file per
milestone; `current-milestone` names the milestone whose implementer was last
spawned, and is written at that spawn; `gate-history.log` stamps every verdict
with its commit and time. A pass on HEAD stamped after the position file
belongs to that milestone, and one stamped before it belongs to the one
before. On the real run, `resume.mjs` answers `SIGN-OFF`.

**Decision.** `scripts/resume.mjs` reads those files and prints the evidence
and one `NEXT:` step. `/spec-flow:resume` runs it and re-enters the right
command's state machine at that step, skipping step 0 — the counters and the
telemetry mark belong to the run, not to the session. Writing the phase is how
the new session takes the run over (ADR-017). `session-start` points every
abandoned phase at the command.

**Refused.**

- Reading the dead session's transcript: it is another program's file, it may
  be gone, and it records what was said, not what was committed.
- A file recording the current step: a second source of truth that drifts from
  the artifacts, which are the state.
- A resume branch inside `/spec-flow`'s intake: its argument is free text, and
  a requirement that happens to name a slug would resume a run nobody meant to.
- Deciding what to do with a dirty tree: it is the dead session's half-written
  work, and keeping it or discarding it is the human's call.

**Cost.** Two steps leave no file, so they are asked for or run again: the
sign-off (a run that died between the OK and the planner asks for it again),
and the review (a plan approved just before the session died is reviewed
again).
