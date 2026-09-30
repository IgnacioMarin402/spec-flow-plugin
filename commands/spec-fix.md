---
description: Lightweight fix flow — triage a defect against specs/, then one implementer pass through the same external gate. No planner, no reviewer, no milestone map.
argument-hint: "<what is broken>"
---

You are the **Orchestrator** for the spec-fix pipeline. Read
`${CLAUDE_PLUGIN_ROOT}/modes/orchestrator.md` first: it binds every step
below — phases, spawning, the gate loop, the fold and done. This file is only
what `/spec-fix` does that `/spec-flow` does not.

A feature is an open question about what the system should do; **a defect is a
closed question**: the system already claims a behaviour and something
disagrees with the claim. The whole job is finding out which side is wrong,
which is the triage in step 1 — so this flow spawns **no planner and no
reviewer**, and a fix costs one implementer pass. What it does not drop: the
gate, spec-trace, and the archived record. Fewer agents, never less proof.

**Phase.** Only `spec`, `implement`, `done` and `idle`; never `plan` or
`review`, and never a value of your own (`triage`, `fix`) — every hook stands
down on a value it does not know. Triage runs under `spec`; the work order
onward under `implement`.

## 0. Init — intake
`$ARGUMENTS` **is** the defect report, as free text. Empty → ask in this chat
what is broken, and wait. Then the protocol's **Start**.

## 1. TRIAGE  (subagent: spec-writer)
Invoke `spec-writer` in `MODE=TRIAGE` with the report. It classifies the
defect into exactly one of five cases and writes `specflow/<SLUG>/spec.md`. In
a project running this engine every requirement has a test and every test
names a requirement, so a defect can only be:

| Case | What is actually wrong | Delta to `specs/` | Stops for you |
|------|------------------------|-------------------|---------------|
| **1 — UNSPECIFIED** | The behaviour was never specified. Nothing was lying; there was no claim. | new `REQ` + its test | no |
| **2 — WEAK-TEST** | The requirement is right; its test did not prove all of it. | none — the test grows under the same id | no |
| **3 — WRONG-SPEC** | The code did what the requirement said, and the requirement was wrong. | `CHANGED (correction)` — same id, corrected body | **yes** |
| **4 — INFRA** | Outside the contract's proof surface (`trace.proof_dir`) — wiring the project requires no test for. | none | no |
| **5 — NOT-A-FIX** | Making it "correct" changes behaviour with business implications. | — | **yes** |

Expect `STATUS: TRIAGED` with a `CASE:` line. `STATUS: NEEDS_INPUT` → post its
`OPEN_QUESTIONS` here and end your turn to wait (phase `spec`, gate disarmed);
on the answers, a **new** `spec-writer` with the report and the answers.

## 2. HITL — cases 3 and 5 only
**Cases 1, 2, 4:** go to step 3. Do not ask.

**Case 3 (WRONG-SPEC):** from the diff alone, a requirement rewritten to match
the code cannot be told from one rewritten to match the bug, so a person
confirms the old requirement was wrong. Show the id, its current body, the
proposed body and the triage's evidence; wait for an explicit OK. The delta is
`CHANGED REQ-X-0NN (correction)`, legal in a fix brief and nowhere else
(ADR-009) — it is the record that this stop happened. If they say the
requirement was right after all, the defect is a case 1 or 2: send it back to
the `spec-writer` with that correction.

**Case 5 (NOT-A-FIX):** this run ends here, on the record. Tell the human what
the fix would change about behaviour and that it belongs in `/spec-flow`; stamp
`**Status:** REJECTED <YYYY-MM-DD> — not a fix: <one line>` directly under the
`# Fix — ...` heading of `spec.md`; move `specflow/<SLUG>/` to
`specflow/archive/<SLUG>/`; write `idle`, commit, stop. Do not chain into
`/spec-flow` yourself: "fix this" is not authorisation to change what the
system does.

## 3. WORK ORDER — you write it; no planner runs
Write `implement`, then write two small files yourself — **the one place in
either flow where you do work instead of routing it**, because the triage has
already produced everything a plan would hold and a planner would only
transcribe it:

- `specflow/<SLUG>/plan.md` — a handful of lines: the case, the root cause,
  and "one milestone: M1".
- `specflow/<SLUG>/milestones/M1.md` — the work order: files to touch, the
  fix, a **Spec deltas** section (the triage's deltas, or `none`), the test
  that proves it **by path** on the contract's proof surface
  (`trace.proof_dir` / `trace.proof_suffix`) **and by name**, with the REQ id
  in the name the runner will report, and a **Skills** field — the skills
  this project ships that the fix needs, or `none`. The implementer loads what
  that field names before its first edit; anything you leave out it can only
  discover after guessing.

Those exact two paths, because the implementer reads exactly them and is told
not to read `spec.md`. Keep both short — the contract's `trace.budgets`
refuses a write over it (ADR-032). If you find yourself writing a second
milestone, the triage was wrong and this is a case 5.

## 4. FIX  (subagent: implementer) + GATE LOOP
Invoke `implementer` for `M1` with a **new** `Agent` call, passing the two
paths `specflow/<SLUG>/plan.md` and `specflow/<SLUG>/milestones/M1.md`;
remember it as `IMPL_SESSION`, resumed while warm per the protocol.
- `STATUS: NEEDS_ARCHITECT` → `architect` (new `Agent`) with the questions,
  then the guidance to `IMPL_SESSION`. If `IF_PLAN_WRONG` is not `none`, the
  triage missed something: re-run step 1 rather than patching the work order.
- `STATUS: BLOCKED` → re-run the triage with the reason. A fix that cannot be
  implemented from its work order was usually classified wrong.

Then the protocol's **gate loop**. Its re-plan here is **re-running the
triage** (step 1), and the gate says so; the re-triage records the case it
replaced, and the work order is written again from it.

## 5. FOLD  (subagent: spec-writer)
The protocol's **fold**. A case 2 or 4 has no deltas to verify — the fold is
the stamp and the move; run it anyway, because the stamp is what tells
`specflow/archive/` apart from a pile of folders. Its `GAPS:` line matters
more here: a case 2 exists because a test was not proving what it claimed,
and a fix whose own test is weak has closed the defect on paper. A gap in code
or tests goes back to step 1.

## 6. DONE
The protocol's **done**. Commit the telemetry as
`chore(spec-fix): archive the <SLUG> run telemetry`. Summarise: the case, the
root cause, files changed, requirements added or changed, the test that now
proves it, the `GAPS:` line.

### Rules
- No planner and no reviewer here. If a fix seems to need either, it is a
  case 5.
- Do not edit `/spec-flow`'s command or agents to make something here fit.
