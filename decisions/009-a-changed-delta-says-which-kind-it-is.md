# ADR-009 — a CHANGED delta says which kind it is, or it is not a CHANGED

**Date:** 2026-08-21 · **Status:** accepted · **Governs:** `scripts/spec-trace.mjs`

**Question.** `ADDED` and `REMOVED` deltas are proven in both directions.
Measured: a requirement rewritten into its opposite under `CHANGED`, test
untouched, passes. The suite catches most of that (changed behaviour turns an
old test red), and `/spec-fix` case 3 stops for a human on the rest — except a
CHANGED that **widens**: "A and B" becomes "A, B and C", nothing breaks, and C
is claimed by the spec and proven by nobody. So what proves a `CHANGED`?

**Decision.** A behaviour claim that appears, disappears or changes is
`REMOVED` on the old id plus `ADDED` on a new one; ids are permanent, which is
what makes retiring one safe. `CHANGED` keeps only edits that move no proof and
must name which: `(wording)` (same meaning, clearer text) or `(correction)`
(`/spec-fix` case 3 only — the marker records that a human was asked).
`spec-trace` fails a bare, unknown or misplaced kind, unconditionally, because
this delta's siblings are already enforced at the gate.

**What it does not catch.** A marker that lies: `(wording)` over a requirement
that grew three clauses passes. The machine checks the claim was declared; the
reviewer and the sign-off check it is true.

**Refused.**
- A git co-change check: misses the author who edited the test to match, is
  diff-scoped (ADR-008), and fails legitimate wording edits from `MODE=FOLD`.
- Banning `CHANGED`: a run that only clarifies wording would have no vocabulary.
- A `/spec-refactor` command: `/spec-fix` and `/spec-flow` already cover it.
