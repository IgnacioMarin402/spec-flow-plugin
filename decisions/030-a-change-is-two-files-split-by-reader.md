# ADR-030 — a change is two files, split by reader

**Date:** 2026-09-30 · **Status:** accepted · **Record:** the split shipped in `0f291c5`; this record replaces the argument the spec-writer's prompt carried for it · **Governs:** `agents/spec-writer.md`, `agents/planner.md`, `agents/reviewer.md`, `scripts/spec-trace.mjs`, `commands/spec-flow.md` · **Related:** ADR-026, ADR-029

**Question.** A change spec written as one file was 240 lines, and 143 of them
— Source, Context, Decision — bound nothing an implementation had to obey. The
planner re-read all of it on every fresh context, and a human signing off read
none of it to the end. What does a change spec hold, and for whom?

**Decision.** Two files under `specflow/<SLUG>/`. `spec.md` answers *what does
this change do*: user stories, requirement deltas, the constraints that bind
the plan, what is out of scope. `proposal.md` answers *why this shape, and what
was turned down*: the source and every HITL round, the context, the decision
with its rejected alternatives and its assumptions (ADR-031). The line that
decides where a sentence goes is whether it binds the plan. `spec.md` is what
the planner and the reviewer work from and the default read for anyone asking
what happened; `proposal.md` is read by a human at sign-off, by the planner
once in `MODE=PLAN` with one question — is anything binding filed here and not
in `spec.md` — and by whoever opens the archive later. The `**Status:**` stamp
goes on `spec.md`. `spec-trace` fails a live `spec.md` carrying `## Source`,
`## Context` or `## Decision`, and a change with no `proposal.md`; a `/spec-fix`
brief is one file, because its five-case triage is the decision.

**Refused.**
- One file with the reasoning at the bottom: the planner pays for it on every
  fresh context, and a sign-off nobody finishes reading is a sign-off nobody
  gave.
- A milestone map in the spec: slicing is the planner's, done once with the
  code in front of it; the human signs off on behaviour, not on a roadmap a
  second agent redoes.
- Letting the planner skip the proposal entirely: a binding clause buried in
  a Decision paragraph is the one failure the split can cause, and reading it
  with that question is cheap.

**Cost.** A constraint stated in the spec and argued in the proposal is two
sentences in two files, deliberately. The spec-writer's last step before
`SPEC_READY` is the pass that keeps a binding sentence from staying in the
proposal.
