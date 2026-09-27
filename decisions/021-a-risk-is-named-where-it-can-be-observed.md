# ADR-021 — a risk is named where it can be observed, or it is not named

**Date:** 2026-09-08 · **Status:** accepted · **Governs:** `agents/planner.md`, `agents/reviewer.md` · **Related:** ADR-006, ADR-008, ADR-020

**Question.** The flow proves every declared requirement. Where does a run
record what a change could break that no requirement covers, and who reads it
before the code is written?

**Measured.** "Risk" appeared only inside three free-text placeholders (the
plan's `## Approach`, a clause of the reviewer's checklist, the proposal's
`## Context`), with no field and no checker; rollback appeared nowhere. The
unscoped suite (ADR-008) already catches regressions of tested behaviour, so
the gap is what could break that nothing tests yet.

**Decision.** The milestone template gains one field:

```
- What this could break: <what this milestone endangers that no requirement
  covers, AND what would show it — or "nothing outside the deltas", with why>
```

Requiring the observation is what lets the answer come up empty out loud: an
observable risk becomes a delta or a test; an unobservable one is a sentence a
human reads before the code exists. Reviewed, not gated — the reviewer names
it like its peers, and `scripts/agent-contracts.mjs` already fails when a
template field is unknown to the reviewer.

**Refused.**
- A `Risks:` field: "Low — standard change" satisfies it forever.
- A gate check: no script can tell whether the stated risk is the one that
  mattered, and gating one milestone field alone is the asymmetry
  `require_skills_field` had to be walked back from
  (`git log -S require_skills_field`).
- A model judging risk in a non-blocking pass: a verdict nobody acts on teaches
  skimming (ADR-006 accepts model judgement only with a deterministic check
  after it).
- Putting it in `spec.md` (it binds nothing) or only in `plan.md` (it never
  reaches the milestone whose implementer would act on it).

**Cost.** Nothing proves the milestone named the risk that mattered.
