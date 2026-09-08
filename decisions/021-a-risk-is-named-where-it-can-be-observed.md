# ADR-021 — a risk is named where it can be observed, or it is not named

**Date:** 2026-09-08 · **Status:** accepted · **Governs:** `agents/planner.md`, `agents/reviewer.md` · **Related:** ADR-006, ADR-008, ADR-020

## The question

The flow is exhaustive about one question — is every declared requirement
proven by a test that ran — and the gate answers it outside the model. Asked
from the other side: where does a run record what a change could break that no
requirement covers, and who reads it before the code is written?

## What was measured before deciding

The word, across every surface this plugin ships:

| Where | What it is | Who reads it for that |
|---|---|---|
| `agents/planner.md` — the `plan.md` template | `risks` inside the free-text placeholder of `## Approach`, plan-wide | nobody |
| `agents/reviewer.md` — the checklist | *"risky assumptions … that will bite"*, the last clause of a run-on question | no output field asks for it |
| `agents/spec-writer.md` — the `proposal.md` template | `blast radius`, inside the placeholder of `## Context` | the planner reads the proposal once, with a different question in mind |

Three placeholders, no field, no checker. `rollback` and reversibility appear
**nowhere in the repo**.

**Two things already cover part of the job, and the decision is only about what
they leave.** The suite is never scoped to the diff (ADR-008), so regression of
behaviour that already has a test is caught mechanically — the gap is not "did
I break something tested", it is *what could this break that nothing tests
yet*. And `proposal.md`'s `## Decision` records each rejected alternative and
what it lost on, which is genuine risk reasoning; it is written before the
codebase has been read for this change, and it is what the human signs off on.

**The mechanism for holding a milestone field already exists.**
`scripts/agent-contracts.mjs` asserts every field of the milestone template is
either named in the reviewer's checklist or listed in `NOT_REVIEWED` with the
reason. Adding a field and nothing else turns CI red. So "who checks it" is not
an open question here — it is answered the moment the field exists.

## The decision

The milestone template gains one field, and its shape is the whole decision:

```
- What this could break: <what this milestone endangers that no requirement
  covers, AND what would show it — or "nothing outside the deltas", with why>
```

**Requiring the observation is what makes the field able to come up empty out
loud.** A risk that can be observed has somewhere to go in a flow that already
knows what to do with observations: if the thing that would show it is
testable, it stops being a risk and becomes a delta or a test. If it is not
testable, it is a sentence the human reads while the code does not exist yet,
which is the only moment it is cheap.

**Reviewed, not gated.** The reviewer names the field, like its four
checked peers, and a milestone that answers it with nothing observable is a
`CHANGES_REQUESTED`.

## What was refused

- **A `Risks:` field.** It cannot fail. "Low — standard change" satisfies it
  literally, in every milestone, forever, and the field then looks armed and is
  not. That is the failure this engine exists to close, installed on purpose.
  The pair — what breaks, what shows it — is refusable by a reviewer because
  half of it is a claim about the world.

- **A gate check.** `Skills:` is the only milestone field that can fail a gate
  alone, that asymmetry accumulated over two commits rather than being decided,
  and it ended as a contract opt-in (`CLAUDE.md` records the whole story). This
  would repeat it with less justification: a script can tell whether `Skills:`
  has text after the colon, and nothing outside a model can tell whether a
  stated risk is the one that mattered.

- **A model judging risk in a pass whose verdict blocks nothing.** ADR-006
  accepts model judgement on exactly one condition — a deterministic check runs
  after it, so *"it can be wrong; it cannot be wrong quietly."* A verdict that
  lands only in a report has the opposite property, and a green line a human
  learns to skim is worse than no line, because the skimming is what it teaches.

- **Putting it in `spec.md`.** That file holds what BINDS the implementation,
  and the human signs it. A risk binds nothing, and the risks worth a
  milestone's attention are the ones found with the codebase open — which is
  after sign-off, in the planner's hands.

- **Naming it in `plan.md` only.** Plan-wide is where it already is, and a
  plan-wide sentence never lands on the milestone whose implementer would act
  on it. The implementer reads `plan.md` plus its own `Mk.md`; the second is
  the one written about the work in front of it.

## The cost, and what this does not buy

**Nothing proves the milestone named the risk that mattered.** A planner that
names an easy one satisfies this exactly as well as one that names the real
one, and no check here can tell them apart — the same limit `CLAUDE.md` states
about the implementer's red run. What is bought is narrower and real: the
question is asked where the codebase is in view, and its answer either becomes
a test or becomes visible.

`agent-contracts.mjs` matches the field name as a substring of the reviewer's
text, so it forces the coupling to be *noticed*, not the review to be good. It
closes the `Skills:` failure — a field added on one side and unknown on the
other — and claims nothing beyond it.

Assertion strength — a test that runs, carries its id and asserts nothing — is
a different gap, already decided rather than left open: `MODE=FOLD` reads each
newly tagged test once per change and reports a gap through `GAPS:` rather than
gating on it, for the same reason this record refuses a gate here — a model's
reading is not the kind of claim that should stop a run on its own. See
[ADR-020](020-a-tagged-test-is-judged-not-measured.md). It is not folded into
this record, because a record that decides two things is cited for one and
read for neither.

## What follows

The field, the reviewer's paragraph and this record are a coupled set:
`agents/planner.md` (template), `agents/reviewer.md` (checklist),
`scripts/agent-contracts.mjs` (which already asserts the two agree, and needed
no change of its own). Verified in a throwaway clone before landing here: the
template edit alone turned `agent-contracts.mjs` red, naming the field; adding
the reviewer's paragraph turned it green again.
