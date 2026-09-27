# ADR-002 — the engine may not know technologies; `init` may, and still does not generate

**Date:** 2026-08-15 · **Status:** superseded by [ADR-005](005-a-report-format-is-not-a-runner.md) · **Record:** `508c7bf`

> Superseded in part. The refusal of a per-runner list stands (ADR-005 keeps
> it for formats, ADR-007 lifts it for Node flags). What was wrong is the
> conclusion that an adopter must therefore write code: a report FORMAT is not
> a runner.

**Question.** ADR-001 left `trace.executed_tests` as a field no repo declares,
so `init` could not produce a working contract. Should `init` detect the
runner and generate a translator for it?

**Decision.** No. `init` scaffolds `.spec-flow/tests-that-ran.mjs` with one
marked hole that refuses loudly until filled. Reporting which tests ran is the
adopting project's job, like declaring its linter. A *generator* may know
technologies, since a wrong guess is reported as `REVIEW`; a *checker* may not,
since it must be right about repos nobody has seen. `init` stops short anyway,
because going further means shipping a stack list inside the package.

**Refused.**
- A `templates/` directory of per-runner translators outside the coupling
  scan: it creates the exemption list `no-repo-refs.mjs` says does not exist.
- Relaxing the ban for `init` alone: a runner list rots, and it is precisely
  the artifact that looks maintained and quietly is not.
