# ADR-008 — the test suite is never scoped to the diff, and never skipped

**Date:** 2026-08-21 · **Status:** accepted · **Governs:** `hooks/gate.mjs`

## The question

The gate scopes LINT to the files changed on the branch, so a milestone is
never blocked by pre-existing lint debt in files it never touched. The obvious
symmetry is to scope the test run the same way — faster gates, and the same
argument appears to apply.

It does not, and the reason is worth a record because the symmetry is what
makes the mistake attractive.

## The decision

**`verify.test` runs in full on every armed gate**, unscoped, including when
the set of changed files is empty.

`lint(file)` is a total, local predicate over one file: file-scoping it is
exact. A suite's outcome is not a property of one file, it is a property of the
system. A scoped run can stay green while the change breaks a consumer outside
the diff — a silent pass through the import graph, which is the exact failure
this engine exists to close, reintroduced one level up in the test command's
argv.

The degenerate case falls out of the same argument. "No file in scope changed"
is a statement about the diff, not about the system, and an empty diff is not
always real: a mis-resolved base manufactures one. So an empty scope skips
lint, and changes nothing about the suite.

## What was refused

**Scoping tests to the changed files.** Above.

**Skipping the suite when the scope is empty.** The condition that would
trigger the skip is also a symptom of the gate being disarmed.

**Trusting the base branch to be inferable.** `resolveBase` refuses to guess
instead, because a wrong base disarms the gate entirely: it manufactures a
scope of zero changed files, which lints nothing.

## The cost, and where it lands

A repo with a slow suite pays it on every milestone, and the hook's declared
timeout (1800s in `hooks.json`) is a ceiling, not a promise — a `command` hook
that reaches it is CANCELED, and a Stop hook that renders no decision ALLOWS
the stop. So the answer for a slow suite is to declare a smoke subset as
`verify.test`, which is the adopter's decision about what "proven" means, not
something the gate can infer.

## Related

ADR-001 (proof comes from the runner) — the same principle one level down:
what proves a requirement is a test that RAN, not a derivation over source.
