# ADR-022 — a run does not end itself without a verdict

**Date:** 2026-09-27 · **Status:** accepted · **Governs:** `hooks/phase-guard.mjs`, `commands/spec-flow.md`, `commands/spec-fix.md` · **Extends:** ADR-017

**Question.** The gate arms only on `implement`, and `.claude/state/phase` is
written by the model the gate judges. Measured on a real `node --test` repo:
after `GATE FAILED (test rc=1)`, a tool write of `idle` was allowed and the
next Stop passed silently with no history line; `done` was allowed with the
last verdict for HEAD reading `result=fail:behaviour test=1`, because its
check read spec-trace — which counts a failed test as executed — and not the
gate. A tool could also write `blocked`, the gate's own hand-off to a human.
Which writes that end a run should be trusted?

**Decision.** None on their value; each is decided from evidence on disk.
- `done`: the existing checks, plus a gate pass on the current commit — the
  same short sha and `result=pass` test the gate uses to decide a commit was
  already judged.
- `idle`: denied from `implement`, where no protocol step writes it. From
  `spec`, `plan` or `review` it needs no live `specflow/<SLUG>/`, because both
  protocol paths to it — a rejected spec, a `/spec-fix` case 5 — stamp and
  archive the change first. From `blocked` it is allowed: only the gate's cap
  reaches `blocked`, so a human is already in the loop.
- `blocked`: denied to every tool; the gate writes it with no tool call.

**Refused.**
- Deriving the whole phase from artifacts instead of a file. It is the
  stronger design and would retire most of the arming hooks, but it rewrites
  the spine every hook shares; this closes the exits that end a run first.
- Guarding `plan` and `spec` from `implement`: both are protocol steps after
  a red gate (REPLAN, re-triage), and neither ends a run — a run left there
  stalls visibly.

**Residue.** `implement` → `spec` → a change stamped REJECTED and archived →
`idle` still ends a run, but only by writing a visible rejection with a reason.
A write in a form `phase-guard` cannot read (`tee`, `sh -c`) is allowed and
logged to `phase-guard-unmatched.log`: a consistency guard, not a boundary.
