# ADR-044 — the implementer works only inside a run

**Date:** 2026-10-12 · **Status:** accepted · **Governs:** `hooks/arm-gate.mjs`, `hooks/dispatch-guard.mjs`, `REFERENCE.md` · **Revisits:** the refusals to deny in ADR-040 and ADR-042

**Question.** ADR-040 recorded this flow's agents put to work outside a run and
refused to deny them, because doing so "can be a person's deliberate act";
ADR-042 refused, for the same reason, to deny an implementer spawned on
`done`. Is there a case where the implementer should work outside a run?

**Measured.** Every path the commands give the implementer is inside a run:
each milestone under `implement`, a `blocked` run that the human answers
(`implement` is written back first), `/spec-flow:resume` (the phase is written
before anything is spawned), and `/spec-fix`, which is a run of its own. The
one path outside a run was the step 6 offer ADR-042 removed. The implementer's
contract is a run's `plan.md` and its milestone; after `done` it has neither,
and the gate, `lint-on-write` and the command deny stand down.

**Decision.** `arm-gate` denies a spawn of, or a message to, `spec-flow:implementer`
while the phase is `done` or `idle`, records the denial as `why=no-run`, and
names what to run instead: `/spec-fix`, or `/spec-flow` for new behaviour.
`dispatch-guard` leaves that implementer to it. Unchanged: a person's own
agent named `implementer`, the architect (a question outside a run is
legitimate), a repository with no phase, and one that committed its
`.claude/state/` (ADR-017, ADR-040).

**Refused.**

- **Recording first, as ADR-035 orders.** That order exists because a rule read
  off prose may deny a step a real run needed. No command describes this step,
  so the denial cannot stall a run the flow drives; what it stops is a change
  that bypasses every check the flow has.
- **Denying every flow agent outside a run.** The architect answers questions
  that change no code, and a spec-writer or planner with no run phase is what
  a skipped step 0 looks like: stats warns about it (ADR-040), and denying it
  would stop the run that forgot rather than tell it.

**Cost.** A person who wanted an unchecked implementer pass after `done` is
told to run `/spec-fix`: a triage, an implementer and a fold, under the gate.
