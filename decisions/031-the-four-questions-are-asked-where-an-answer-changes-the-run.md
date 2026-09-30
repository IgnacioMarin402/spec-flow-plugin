# ADR-031 — the four questions are asked where an answer changes the run

**Date:** 2026-09-30 · **Status:** accepted · **Governs:** `agents/spec-writer.md`, `agents/planner.md`, `agents/reviewer.md`, `modes/spec-writer-triage.md`, `commands/spec-flow.md` · **Extends:** ADR-021 · **Related:** ADR-009, ADR-020

**Question.** The flow's stance is four questions: what do I not know, what am
I taking for granted, what of what I was told does not add up, what would I
have to find to drop the whole idea. Read against the agents on `04f4851`: the
first and the third have mechanisms — the HITL rule, the escalations, the
contradiction check against `specs/`, the planner's one-question read of the
proposal, the reviewer's check on a `(wording)` that lies. The fourth has one
at the test (the fold asks whether a tagged test would fail with the
requirement unimplemented, ADR-020) and one at the milestone (`What this could
break`, ADR-021). The second had none: the spec-writer records what it asked
(`## Source`) and never what it decided not to ask, so an assumption surfaces
as a gate failure or a wrong milestone, after the plan has been paid for. And
nothing put the milestone a wrong plan would show up in first. Where is each
question asked, and in what shape?

**Decision.** Each question is a step where its answer changes what happens
next, in the shape ADR-021 requires — named with what would show it, or not
named.
- *What I do not know* — a question to the human (`NEEDS_INPUT`, `ESCALATE`,
  `NEEDS_ARCHITECT`), never a guess. Unchanged.
- *What I am taking for granted* — the proposal's `## Decision` gains one line,
  `**Assumed:** <what was taken as given rather than asked> — wrong if <what
  would show it>`, or `none`. It is read at sign-off, where the Decision is
  already shown, so a wrong assumption is caught before the planner is spent;
  an assumption whose failure drops the idea is the change's kill criterion,
  and this is where it is written.
- *What does not add up* — the contradiction check, the planner's one question
  of the proposal, the reviewer's `(wording)` check. Unchanged.
- *What would drop the idea* — `What this could break` stays reviewed and not
  gated; the fold's reading stays; and after dependencies, the planner orders
  milestones least-certain first, so a plan that is wrong is found at M1 and
  not at Mn, and the reviewer checks the order on that basis. A re-plan or a
  re-triage records the plan or case it replaced, so the archive shows what
  the run learned instead of a brief rewritten as if it had always said so.

**Refused.**
- An `## Assumptions` section in `spec.md`: it binds nothing (ADR-021's reason
  for keeping risk out of the spec), and a section is what `none` fills
  forever; one line inside a section a human already reads is the cheapest
  place it is seen.
- A kill-criterion field of its own: an assumption's `wrong if` is that
  criterion; a second field asks the same question twice.
- A critic or devil's-advocate agent: `BACKLOG.md` refuses more agents, and a
  verdict nobody acts on teaches skimming (ADR-021).
- A `Risks:` field: refused in ADR-021, still refused.

**Cost.** One more line at sign-off, and a planner told to put its least
certain milestone first where a cheaper order existed. Nothing checks that the
assumption named was the one that mattered.
