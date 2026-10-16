# ADR-045 — a prohibition has an id of its own

**Date:** 2026-10-16 · **Status:** accepted · **Governs:** `scripts/spec-shape.mjs`, `agents/spec-writer.md`, `modes/spec-writer-triage.md`, `scripts/agent-contracts.mjs` · **Related:** ADR-009, ADR-020, ADR-030

**Question.** spec-trace binds an id to a test that ran under its name. One
test named for "filters by A and B, never by C" passes while it asserts only A
and B: the half that forbids is green and checked by nobody. Only the fold's
reading caught it (ADR-020). What makes a prohibition need a test of its own?

**Measured.** On `620901d` and on `b2d7887`, a live spec whose one `ADDED`
reads "filters by A and B, never by C" leaves `spec` past phase-guard, and
spec-trace passes it with one test named for the id.

**Decision.**

- What a requirement forbids is an `ADDED` of its own. `liveSpecProblems`
  refuses an `ADDED` that pairs a prohibition with another claim, so the rule
  holds wherever that is read: spec-trace at every gate, phase-guard and
  arm-gate leaving `spec`, agent-gate on the spec-writer's return, and resume
  before a sign-off.
- Fix briefs too: a case 1 adds a requirement as a feature does.
- A prohibition is a clause holding `cannot`, `must not`, `never` or `only`.
  The words are code (`PROHIBITION_WORDS`), and the spec-writer's contract must
  name the same words, as it does the question cap (ADR-030).
- Clauses are cut at `;`, a spaced dash, a comma before a conjunction, `but`,
  and a comma or `and` right before one of the words. A word after a
  subordinator ("when the user cannot be found", "an order that was never
  paid"), in a compound or identifier (`read-only`, `neverExpires`), in quoted
  or code text, or in `not only` and `the only` is not a prohibition.

**What it does not catch.** It reads words and punctuation, not grammar:
"does not", "refuses", a prohibition joined by a bare `and` to a clause with a
subject of its own ("admins can delete and guests cannot"), and a single clause
with "only", which allows as well as forbids, all pass. Nor does it check that
the test named for the prohibition asserts it; the fold reads that (ADR-020).

**Refused.**

- The planner's `Tests` field and the reviewer's checklist naming a test per
  clause: prose one agent writes and another reads, which no check holds.
- Refusing every "only": the commonest of the four, and a clause with it is one
  requirement as written.
- Cutting at every `and`: it joins the object of one prohibition ("only admins
  and owners may delete") as often as two claims.
- Holding it at spec time only, as the assumptions are (ADR-030): those judge a
  sign-off, which the gate never sees. This rule is about what spec-trace can
  prove, like a `CHANGED`'s kind (ADR-009), whose siblings hold at the gate.

**Cost.** A run planned before this, whose spec pairs a prohibition, goes red
at its next gate, and the fix is on the spec side: a new id, and a test named
for it. A requirement written as one sentence becomes two ids and two tests.
