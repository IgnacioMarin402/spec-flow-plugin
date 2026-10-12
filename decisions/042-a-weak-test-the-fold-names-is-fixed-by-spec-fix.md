# ADR-042 — a weak test the fold names is fixed by `/spec-fix`

**Date:** 2026-10-12 · **Status:** accepted; its refusal to deny the spawn revisited by [ADR-044](044-the-implementer-works-only-inside-a-run.md) · **Governs:** `commands/spec-flow.md`, `commands/spec-fix.md`, `scripts/agent-contracts.mjs` · **Extends:** ADR-020

**Question.** The fold reports a test that proves less than its requirement
through `GAPS:`, at the end of a run (ADR-020). Who fixes it, and under which
checks?

**Measured.** On a real run (engine `620901d`) the fold named a requirement
whose test asserted half of it, and the orchestrator offered what step 5 said:
a fresh implementer for that milestone, in the step 6 summary, after `done`.
On `done` the gate, `lint-on-write` and the command deny stand down and
`arm-gate` arms nothing; since ADR-040 `dispatch-guard` leaves a `why=no-run`
line, and nothing else.

**Decision.** Both commands offer the fix as `/spec-fix`, with the report to
run it with: the requirement's id, the test's path and what the fold said it
leaves unproven. Its triage reads that as case 2 (WEAK-TEST), and the fix is a
run of its own, gated and folded. Running it stays the human's call (ADR-020).
`agent-contracts` fails while either command's step 5 offers a fix for a weak
test without naming `/spec-fix`.

**Refused.**

- **Re-opening the run** for one more implementer after `done`. Its folder is
  archived and its telemetry snapshot taken, so the fix would have no plan, no
  fold and no place in the run's record.
- **Holding `done` until the gap is fixed.** That makes a model's reading stop
  a run, which ADR-020 refused.
- **Denying an implementer spawned on `done`.** Putting an agent to work
  outside a run can be a person's deliberate act (ADR-040).

**Cost.** When the human accepts, a triage, an implementer and a fold, where
the fresh implementer was one pass with nothing checking it.
