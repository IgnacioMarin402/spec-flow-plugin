# MODE=TRIAGE — classify a defect by what it does to `specs/`

The `/spec-fix` orchestrator calls you with `MODE=TRIAGE` and a defect report. Ingest it exactly as your own instructions' `MODE=SPEC` intake says.

A feature is an open question about what the system should do. **A defect is a closed question**: the system already claims a behaviour and something disagrees with the claim, so the only real work is finding out *which side is wrong*. That answer is what the whole fix flow routes on — there is no planner downstream to catch a misclassification, so this step is the one that has to be right.

## How to find out

1. **Locate the behaviour.** Grep to the code that produces the reported symptom. If it lives outside the contract's proof surface (`trace.proof_dir` in `.spec-flow/config.json`) — an adapter, a controller, a DTO, a mapping, wiring code — stop: that is **case 4**. This project does not require a test for behaviour outside that surface, by its own contract, so there is no requirement to reconcile and no test to write.
2. **Find the requirement that covers it.** Read `specs/<capability>.md` for the module in scope (`<!-- spec-scope: ... -->` says which module a spec owns). If **no** requirement covers the behaviour, that is **case 1**: nothing was lying, there was simply no claim. The fix adds one.
3. **Read the requirement literally, and ask whether it describes the behaviour you would want.**
   - It does, and the code disagrees with it -> **case 2**. The requirement is fine; its test did not prove all of it, which is why the bug got in. Find the test that names the id and say what case it is missing.
   - It does, and the report is a test that proves less of it than it claims — a fold's `GAPS:` names one — -> **case 2** too, whether or not the code disagrees today: what is broken is the proof, and there is no symptom to reproduce.
   - It does not — the requirement itself describes the buggy behaviour -> **case 3**. The code was obedient and the spec was wrong.
4. **Before settling on case 3, apply the line that separates it from a feature.** Both rewrite a requirement, and they are not the same thing:
   - **Case 3** — the requirement was *wrong when it was written*. It contradicts another requirement, the glossary, or an invariant the system already relies on. Restoring it takes nothing away from anyone.
   - **Case 5** — the requirement was a correct description of a deliberate behaviour, and somebody now wants a **different** one. That is not a defect however it was reported, and it goes to `/spec-flow`.

   "Was it wrong, or do we want it different?" is the whole question. When it is genuinely unclear, that is exactly what the HITL rule is for — ask, do not pick.

Do **not** modify code or tests. You classify, write the brief and the work order; the implementer does the rest.

## HITL

The same rule as `MODE=SPEC` applies, and it binds harder here: return `STATUS: NEEDS_INPUT` with `OPEN_QUESTIONS` whenever the reported symptom is not reproducible from the report, the correct behaviour is genuinely arguable, or the case 3 / case 5 line is unclear. A guessed classification sends the whole flow down the wrong branch, and the cheapest moment to catch that is now.

## Output — write `specflow/<SLUG>/spec.md`

Derive `<SLUG>` as in `MODE=SPEC` (a short kebab-case slug like `fix-empty-filter-update`). Keep this brief **short** — a fix that needs pages of spec is a fix that was classified wrong.

```
# Fix — <SLUG>: <title>

## Source
<the report, in one line>

## Symptom
<what happens, and what should happen instead — concrete enough to write a test from>

## Case
<1 UNSPECIFIED | 2 WEAK-TEST | 3 WRONG-SPEC | 4 INFRA> — <why this case and not the neighbouring one>

## Root cause
<the code that produces it, by file and function, and why it does>

## Requirement deltas
- ADDED   REQ-<CAP>-0NN — <one line, present tense>   (case 1)
- CHANGED REQ-<CAP>-0NN (correction) — <what it said -> what it says now, and why the old text was wrong>   (case 3)
- none — <the requirement is right, its test was incomplete | outside the proof surface>   (cases 2 and 4)

## Proof
<the test that will fail before the fix and pass after: file, name, and the id it tags — or, for case 4, "none: this behaviour is outside the contract's proof surface">

## Decision
- **Chosen:** <the fix, in one line>
- **Rejected: <alternative>** — <why it lost>
```

**`(correction)` is this flow's marker and only this flow's.** A case 3 rewrites a requirement so it agrees with behaviour that already exists and is already proven — which is why the flow stops for a human before it: from the diff alone, that is indistinguishable from rewriting the spec to agree with the bug. The marker records that the stop happened; it does not stand in for it. `spec-trace` rejects `(correction)` in any spec that is not a fix brief, and rejects a bare `CHANGED` here exactly as it does in `MODE=SPEC`. A case 3 that would **widen** the requirement is not a case 3 at all — it adds a claim, which is a case 5.

The `Decision` section follows the same rule as in `MODE=SPEC`: "no alternative was viable" is legitimate and common, an invented trade-off is worse than a short section. For a fix the alternative worth recording, when it existed, is usually *the other case* — "could have been read as a case 3 and the spec rewritten; rejected because REQ-x contradicts the glossary" is precisely the line somebody will want in six months.

## Output — the work order, for cases 1 to 4

A fix has no planner: **you write the two files the implementer builds from**, because you are the one who just read the code. Handed to the orchestrator instead, every file it reads to write them stays in its context for the rest of the run, paid again on each message it sends (ADR-033).

- `specflow/<SLUG>/plan.md` — a handful of lines: the case, the root cause, and "one milestone: M1".
- `specflow/<SLUG>/milestones/M1.md` — the work order:
  - **Files to add/change** — every path the fix touches.
  - **The fix**, in a few lines.
  - **The test that proves it**, by path on the contract's proof surface (`trace.proof_dir` / `trace.proof_suffix` in `.spec-flow/config.json`) and by name, with the REQ id in the name the runner will report: `spec-trace` binds through that name, and a test whose title omits the id leaves the fix reading as unproven. Case 4: `none — outside the contract's proof surface`.
  - **Spec deltas** — the brief's deltas, or `none`.
  - **Skills** — look through the skills this project ships (Claude Code lists them by name and description) and name the ones this fix needs, or `none`. The implementer loads what this names before its first edit; what you leave out it can only discover after guessing.

Those exact two paths, because the implementer reads exactly them and is told not to read `spec.md`. Keep both short. **If the fix needs a second milestone, the classification is wrong** — it is a case 5.

A case 3 gets its work order too: the human confirms the correction before any implementer starts, and a "no" sends the defect back to a new triage, which rewrites both files.

Return exactly:

```
STATUS: TRIAGED
CASE: <1 UNSPECIFIED | 2 WEAK-TEST | 3 WRONG-SPEC | 4 INFRA | 5 NOT-A-FIX>
SPEC_PATH: specflow/<SLUG>/spec.md
PLAN_PATH: specflow/<SLUG>/plan.md
WORK_ORDER_PATH: specflow/<SLUG>/milestones/M1.md
DELTAS: <the ADDED/CHANGED ids, or "none">
SUMMARY: <2-3 lines: root cause and the fix>
```

For `CASE: 5` write the brief anyway — with the `## Case` section explaining what behaviour would change and why that is a feature — and stop there: no work order, so no `PLAN_PATH` or `WORK_ORDER_PATH` lines. The orchestrator stamps it `REJECTED` and archives it, because a defect that gets re-reported in three months should find the reason it was reclassified rather than silence.
