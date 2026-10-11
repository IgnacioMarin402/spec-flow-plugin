# ADR-033 — a fix's work order is written by its triage

**Date:** 2026-10-11 · **Status:** accepted · **Governs:** `modes/spec-writer-triage.md`, `commands/spec-fix.md`, `commands/resume.md`, `hooks/agent-gate.mjs`, `hooks/phase-guard.mjs`, `scripts/resume.mjs`, `REFERENCE.md` · **Related:** ADR-025, ADR-029, ADR-030, ADR-031

**Question.** `/spec-fix` has no planner, so the orchestrator wrote the fix's
work order (`plan.md`, `milestones/M1.md`) itself. What does that cost?

**Measured.** On a real one-requirement fix the orchestrator sent 30 messages,
and each re-read its whole context: 66k tokens at the first, 154k at the last,
≈3.45M in all. Writing the work order took 11 of them, ≈1.17M. To write it the
orchestrator read 11 files the triage had just read; what it reads stays in
its context and is paid again on every later message, while a subagent's
context ends with the subagent.

**Decision.** For cases 1 to 4 the triage writes the work order and returns
`PLAN_PATH` and `WORK_ORDER_PATH`; the agent gate sends back a return that
names neither, and the existing `*_PATH` check one naming a file that is not
there. The orchestrator verifies nothing in the code, writes `implement` and
spawns the implementer. Because the work order now exists inside `spec`, a
fix brief is held to its spec-time checks on leaving `spec` whether or not
its plan exists, and a resume re-enters a fix at the HITL step until an
implementer has started. A case 3 still stops for the human before any
implementer starts; a "no" goes to a new triage, which rewrites the work
order.

**Refused.**

- The orchestrator writing it from the triage's return alone: still two
  messages of the orchestrator's, and a return terse enough to transcribe
  would carry the work order anyway.
- The planner: the flow's most expensive call spent on transcribing a root
  cause into one milestone.
- The implementer writing its own: it reads exactly `plan.md` and `Mk.md` and
  not `spec.md`, and that contract is what lets one implementer serve both
  flows.

**Cost.** The triage's return gains two lines and its run gains two short
files. A case 3 that the human rejects writes a work order that is discarded.
