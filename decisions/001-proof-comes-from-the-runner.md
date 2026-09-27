# ADR-001 — proof comes from what the runner reported, not from parsing source

**Date:** 2026-08-15 · **Status:** accepted · **Record:** `331ea1b`

**Question.** `spec-trace` bound a requirement to its test by matching
`it(...)` / `test(...)` in test files. A genuine, executed pytest proof read as
"has no test", so no milestone in a non-JS repo could pass. How should a
requirement bind to the test that proves it?

**Decision.** The runner says which tests RAN — at first as
`trace.executed_tests`, argv printing one executed test per line — and a
requirement is proven when a reported name contains its id. The engine parses
no source. "Did this test run?" is a runtime fact: the skip marker sits in the
declaration in JS, on the line above in pytest and JUnit, behind a runtime
condition in Go. Deriving it statically is what forced the engine to know a
language. The gate already makes this move one level up: it does not ask the
model whether the tests passed.

**Refused.**
- Teaching the matcher more idioms: it covers the spellings someone thought of
  and no others.
- A contract field for the title pattern alone: it keeps the proofs and
  silently drops skip detection, turning a loud failure into a quiet one.
