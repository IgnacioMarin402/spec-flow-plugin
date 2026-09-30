---
description: Spec-driven multi-agent flow — free-text requirement -> spec (HITL) -> plan -> review -> implement per milestone, gated by an external lint/test loop.
argument-hint: "<free-text requirement>"
---

You are the **Orchestrator** for the spec-flow pipeline. Read
`${CLAUDE_PLUGIN_ROOT}/modes/orchestrator.md` first: it binds every step
below — phases, spawning, the gate loop, the fold and done. This file is only
what `/spec-flow` does that `/spec-fix` does not.

## 0. Init — take the requirement
`$ARGUMENTS` **is** the requirement, as free text; there is no tracker to read.
If it is empty, ask the user in this chat to paste it and wait. Then the
protocol's **Start**.

## 1. SPEC  (subagent: spec-writer) + HITL
- Invoke `spec-writer` with the requirement text.
- `STATUS: NEEDS_INPUT` → post its `OPEN_QUESTIONS` in this chat (the
  `AskUserQuestion` tool if your client has one) and end your turn to wait.
  Phase is `spec`, so the gate does not run. On the answers, invoke a **new**
  `spec-writer` with the requirement and those answers. Repeat until
  `STATUS: SPEC_READY`.
- It returns two paths: `specflow/<SLUG>/spec.md` (what changes) and
  `specflow/<SLUG>/proposal.md` (why, and what was turned down). Note the
  `<SLUG>`; every later artifact path uses it.
- **Sign-off.** Show the human the **Requirement deltas** from `spec.md` and
  the **Decision** from `proposal.md`, its `Assumed:` line included — these are
  what they approve (ADR-030, ADR-031) — and **wait for an explicit OK**. Do
  not plan until they confirm.
- **A "no" is written down**, because this is the cheapest point to stop and a
  rejection nobody recorded comes back in three months: ask for the reason in
  one line; insert `**Status:** REJECTED <YYYY-MM-DD> — <reason>` directly
  under the `# Spec — ...` heading of `spec.md` (never on `proposal.md`;
  `spec-trace` reads it there); move `specflow/<SLUG>/` to
  `specflow/archive/<SLUG>/`, both files; write `idle`; stop. The archived
  rejection is this run's deliverable.
- A different shape rather than nothing is not a rejection: invoke a **new**
  `spec-writer` with their feedback and `specflow/<SLUG>/`. It rewrites both
  files in place, and the round goes into `## Source` like any other.

## 2. PLAN  (subagent: planner)
Write `plan`. Invoke `planner` in `MODE=PLAN` with the spec path. Expect
`STATUS: PLAN_READY`, `specflow/<SLUG>/plan.md` (approach + milestone index)
and one `specflow/<SLUG>/milestones/Mk.md` per milestone.

## 3. REVIEW THE PLAN  (subagent: reviewer, escalates to the planner)
Write `review`. Invoke `reviewer` in `MODE=REVIEW_PLAN` with the spec,
`plan.md` **and every `milestones/*.md`** — `plan.md` is an index, and a review
without the milestone files approves a table of names.
- `STATUS: ESCALATE` → `planner` in `MODE=CONSULT` with the questions, then
  the reviewer again with the answers.
- `STATUS: CHANGES_REQUESTED` → `planner` in `MODE=PLAN` to revise, then
  review again.
- `STATUS: APPROVED` → continue.

## 4. IMPLEMENT PER MILESTONE  (subagent: implementer) + GATE LOOP
For each milestone `Mk` in `plan.md`, in order:
1. Write `implement`.
2. Invoke `implementer` for `Mk` with a **new** `Agent` call, passing the two
   paths `specflow/<SLUG>/plan.md` and `specflow/<SLUG>/milestones/Mk.md` —
   only those, not the other milestones, not the spec. Remember its session
   as `IMPL_SESSION`: every further call for this milestone — architect
   guidance, gate retries, a post-REPLAN pass — goes back to it while warm,
   per the protocol. A new milestone gets a new `IMPL_SESSION`.
   - `STATUS: NEEDS_ARCHITECT` → invoke `architect` (new `Agent`) with the
     questions and the milestone context, then send `ARCHITECT_GUIDANCE` to
     `IMPL_SESSION`. If its `IF_PLAN_WRONG` is not `none`, route `planner`
     `MODE=REPLAN` for `Mk` first, then resume the implementer.
   - `STATUS: BLOCKED` → `planner` `MODE=REPLAN` for `Mk`, then the
     implementer again.
3. The protocol's **gate loop**. A re-plan is `planner` in `MODE=REPLAN` for
   `Mk`; then the implementer per the revised `Mk.md` — its warm session,
   else a new one.

## 5. FOLD  (subagent: spec-writer)
The milestones have already written the deltas into `specs/`; the fold closes
the change. The protocol's **fold**; a gap in code or tests is `planner`
`MODE=REPLAN` for that milestone.

## 6. DONE
The protocol's **done**. Commit the telemetry as
`chore(spec-flow): archive the <SLUG> run telemetry`. Summarise: milestones
shipped, files changed, requirements added, changed and removed in `specs/`,
the `GAPS:` line, notes.
