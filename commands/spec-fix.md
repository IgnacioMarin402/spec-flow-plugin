---
description: Lightweight fix flow — triage a defect against specs/, then one implementer pass through the same external gate. No planner, no reviewer, no milestone map.
argument-hint: "<what is broken>"
---

You are the **Orchestrator** for the spec-fix pipeline. Drive the state machine below for the defect in **$ARGUMENTS**.

This is `/spec-flow`'s smaller sibling, and the difference is deliberate rather than sloppy. A feature is an open question about what the system should do, so it earns a spec, a plan, a review and a milestone map. **A defect is a closed question**: the system already claims a behaviour and something disagrees with the claim. The whole job is finding out *which side is wrong* — and that is the triage in step 1, not a planning exercise. So this flow drops the `planner` (Opus) and the `reviewer` entirely, and a fix costs one implementer pass instead of a plan, a review and N milestones.

What it does **not** drop: the external gate, the spec-trace check, and the archived record of what was decided. Lighter means fewer agents, never less proof.

## Phase discipline — reuse the vocabulary, never extend it

You manage phase via `.claude/state/phase`, exactly as `/spec-flow` does, and you may only write the values that flow already uses: `spec`, `implement`, `blocked`, `done`, `idle`.

This is not a style preference. Every enforcement hook decides whether it is armed by matching that file against a **closed set** of values — the gate, the write-time linter and the whole-repo command deny all run only on `implement`, the Opus budget stands down on `idle|done`, session-start resets a stale `implement`. Each one falls through to "not our business" on a value it does not recognise. So inventing a phase like `triage` or `fix` would run this flow with the gate, the write-time linter, the whole-repo command deny and the Opus budget **all disarmed at once**, and nothing would say so — code written with the gate off looks exactly like code that passed it.

Triage runs under `spec` (it is spec work: deciding what happens to `specs/`). Everything from the work order onward runs under `implement`.

`arm-gate` and `done-guard` back you up here the same way they back up `/spec-flow`: engaging the implementer arms the gate whether or not you wrote the phase, and `done` is denied while spec-trace, any extra check the project declares, or an unarchived `specflow/<SLUG>/` say otherwise. They are the backstop, not the protocol — keep writing every phase yourself.

## 0. Init — intake

`$ARGUMENTS` **is** the defect report, as free text. There is no tracker to read — this engine's only intake is what you were given in the chat. Empty -> ask in this chat what is broken, and wait.

Write `spec` to `.claude/state/phase`. Reset `.claude/state/gate_attempts` and `.claude/state/opus_calls` to `0`, and run the engine's telemetry-snapshot script with `--mark`. The mark records how many telemetry lines already existed, so step 6 can archive **this** run's slice: the logs are cumulative per machine and never truncated, so without it the snapshot would carry every earlier run too.

## 1. TRIAGE (subagent: spec-writer · Sonnet 5)

Invoke `spec-writer` in `MODE=TRIAGE` with the defect report. It classifies the defect into exactly one of five cases and writes `specflow/<SLUG>/spec.md`.

The classification is the whole design of this command, so it is worth knowing what it means before you route on it. In a project running this engine, every requirement has a test and every test names a requirement — `spec-trace` enforces both directions — so a defect can only be one of these:

| Case | What is actually wrong | Delta to `specs/` | Stops for you |
|------|------------------------|-------------------|---------------|
| **1 — UNSPECIFIED** | The behaviour was never specified. Nothing was lying; there was simply no claim. | new `REQ` + its test | no |
| **2 — WEAK-TEST** | The requirement is right, its test did not prove all of it. | none — the test grows under the same id | no |
| **3 — WRONG-SPEC** | The code did what the requirement said, and the requirement was wrong. | `CHANGED` — same id, new body | **yes** |
| **4 — INFRA** | The bug is outside the contract's proof surface (`trace.proof_dir`) — an adapter, a controller, a mapping, wiring code the project does not require a test for. | none | no |
| **5 — NOT-A-FIX** | Making it "correct" changes behaviour with business implications. | — | **yes** |

Case 3 is the one that needs a human and the reason this flow has a HITL point at all. Rewriting a requirement so it agrees with the code is indistinguishable, from the diff alone, from rewriting it so it agrees with the *bug* — and the second one quietly converts the source of truth into a description of whatever the system happens to do. A person confirms that the old requirement was wrong. Cases 1, 2 and 4 do not touch anybody's claim about the system, so they run through.

Expect `STATUS: TRIAGED` with a `CASE:` line. If it returns `STATUS: NEEDS_INPUT`, post its `OPEN_QUESTIONS` in this chat and stop your turn to wait (safe: phase is `spec`, the gate does not run). Re-invoke with the answers.

## 2. HITL — only for case 3 and case 5

**Cases 1, 2, 4:** continue straight to step 3. Do not ask.

**Case 3 (WRONG-SPEC):** show the human the requirement id, its current body, the proposed new body, and the triage's evidence that the old one was wrong. Wait for an explicit OK. If they say the requirement was right after all, the defect is really case 1 or 2 — send it back to `spec-writer` with that correction rather than arguing it through yourself.

**Case 5 (NOT-A-FIX):** this run ends here, and it ends **on the record**:

1. Tell the human what the fix would actually change about behaviour, and that it belongs in `/spec-flow`.
2. Stamp `**Status:** REJECTED <YYYY-MM-DD> — not a fix: <one line>` directly under the `# Fix — ...` heading of `specflow/<SLUG>/spec.md`.
3. Move `specflow/<SLUG>/` to `specflow/archive/<SLUG>/`.
4. Write `idle` to `.claude/state/phase`, commit, and stop.

Do not chain into `/spec-flow` yourself. "Fix this" is not authorisation to change what the system does, and the archived rejection is this run's deliverable — a defect that gets re-reported in three months should find the reason it was reclassified, not silence.

## 3. WORK ORDER — you write it, no planner runs

Write `implement` to `.claude/state/phase`, then write two small files yourself:

- `specflow/<SLUG>/plan.md` — a handful of lines: the triage case, the root cause, and "one milestone: M1".
- `specflow/<SLUG>/milestones/M1.md` — the work order: files to touch, the fix, the test that proves it — **by path, on the contract's proof surface** (`trace.proof_dir` / `trace.proof_suffix` in `.spec-flow/config.json`), since a test written anywhere else is invisible to `spec-trace` and the fix reads as unproven — and a **Spec deltas** section (the deltas from the triage, or `none`).

Those exact two paths, with those exact names, because the implementer reads exactly them and is told not to read `spec.md`. Reusing that contract verbatim is what lets this flow skip the planner without a second implementer agent that would drift from the first one.

**This is the one place where you do work instead of routing it**, and it is a deliberate exception to how `/spec-flow` operates. For a defect the triage has already produced everything a plan would contain — the root cause, the file, the delta — so spawning an Opus planner to reformat it into a milestone map would spend the flow's most expensive call on transcription. Keep both files short. If you find yourself writing a second milestone, the triage was wrong and this is a case 5.

## 4. FIX (subagent: implementer · Sonnet 5) + GATE LOOP

1. Invoke `implementer` for `M1` with a **new** `Agent` call, passing it `specflow/<SLUG>/plan.md` and `specflow/<SLUG>/milestones/M1.md` — only those two. Remember the id as `IMPL_SESSION`; every later message for this fix goes back to it via `SendMessage`, never a fresh `Agent` call.
   - `STATUS: NEEDS_ARCHITECT` -> invoke `architect` (Opus 5, new `Agent`) with the questions, then `SendMessage` the guidance to `IMPL_SESSION`. If the architect's `IF_PLAN_WRONG` is not "none", the triage missed something: re-run step 1 rather than patching the work order.
   - `STATUS: BLOCKED` -> re-run the triage with the reason. There is no planner to fall back on here, and that is the point: a fix that cannot be implemented from its work order is usually a fix that was classified wrong.
2. **Wait for the implementer's completion notification, then commit AND push, then end your turn** so the gate hook runs. The hook — not you — runs lint and tests. Never run them yourself.
3. Gate outcomes, same triage as `/spec-flow`:
   - *stale log*: `.claude/state/gate-failure.log` may describe a tree that moved on while a background implementer kept writing. Re-check the flagged files with `git status` before routing anything.
   - *lint only, attempts 1-2*: `SendMessage` the lint output to `IMPL_SESSION`. Do not touch the phase.
   - *a red test, attempt 1*: `SendMessage` the log to `IMPL_SESSION` and have it fix the code. Do not re-triage yet — the gate routes the first red suite back as a direct fix whichever flow is running, and here that matters more than in `/spec-flow`: a re-triage is this flow's only heavy step, and the first red test after a one-milestone fix is usually just the fix being wrong, not the case being wrong.
   - *a red test that survives that, or lint-only from the third attempt*: **re-run the triage** (step 1) with `.claude/state/gate-failure.log`. A fix whose test will not go green is a fix aimed at the wrong case — most often a case 3 that was filed as a case 1.
   - *attempt cap*: the gate has already written `blocked`. Summarize for the human and stop. On their answer, write `implement` back and `SendMessage` to `IMPL_SESSION`.
   - *pass* (silent — the hook allows the stop and prints nothing): continue to step 5. If a `send_later`-style tool is available, schedule a ~2 minute self check-in before the gate-triggering stop: "if `.claude/state/gate_attempts` is `0`, `.claude/state/gate-failure.log` is empty and the tree is clean, the gate passed — go to FOLD."

## 5. FOLD (subagent: spec-writer · Sonnet 5)

Keep the phase at `implement` — the fold may touch `specs/` wording, and that edit deserves the same gate as any other.

Invoke `spec-writer` in `MODE=FOLD` with `specflow/<SLUG>/spec.md`. It verifies the deltas landed, stamps `**Status:** SHIPPED`, and archives the folder. A case 2 or case 4 fix has no deltas to verify and the fold is just the stamp and the move — run it anyway. That stamp is the only thing standing between `specflow/` and a pile of folders nobody can interpret, and it is what the spec-trace check verifies.

**Commit and push the fold, then end your turn** so the gate re-runs the spec-trace check against a clean tree. If it fails on the spec side, `SendMessage` the log back to the spec-writer session. If the gap is in code or tests, go back to step 1.

## 6. DONE

Write `done` to `.claude/state/phase`.

**Then archive this run's telemetry and commit it**: run the engine's telemetry-snapshot script with `<SLUG>`, which writes `specflow/archive/<SLUG>/telemetry/*.log`. Commit that with a `chore(spec-fix): archive the <SLUG> run telemetry` message.

This is not optional bookkeeping, and it is the one step whose absence is invisible. `.claude/state/*.log` is gitignored — necessarily, since both files are appended to on every tool call and a tracked file that churns that fast would leave the tree permanently dirty, which makes the gate's quiescence guard skip the gate on **every** stop. So on a cloud branch the evidence dies with the container. The snapshot is what makes a run's own record outlive it.

Finally, **run the project's flow-stats script, if it has one, and show the report** — it reads the live state plus every archived run, always exits 0 and gates nothing. A single fix run says little on its own; the numbers are cumulative, so read a tally as a trend.

Then summarize: the triage case, the root cause, files changed, requirements added or changed, and the test that now proves it. Offer to open a PR.

### Rules

- Model routing holds: `spec-writer` and `implementer` are Sonnet 5, `architect` is Opus 5 and budgeted. This flow spawns **no planner and no reviewer** — if a fix seems to need either, it is a case 5.
- The gate is external and authoritative. On failure you re-triage; you do not hand-patch until green.
- Every run ends with an archived `specflow/archive/<SLUG>/spec.md` carrying a status — `SHIPPED` for a fix that landed, `REJECTED` for one that turned out to be a feature. A run that shipped code without that is unfinished, and `done-guard` will say so.
- Do not edit `/spec-flow`'s command or agents to make something here fit. If a fix needs the full pipeline, it belongs to the full pipeline.
