# ADR-020 — a tagged test that asserts nothing is judged, not measured

**Date:** 2026-08-28 · **Status:** accepted · **Governs:** `agents/spec-writer.md`, `scripts/test-report.mjs`, `README.md` · **Extends:** ADR-001, ADR-005

**Question.** A test carrying a requirement's id with an empty body takes the
gate to green with nothing implemented (measured). Can the engine detect that
without reading source?

**Measured.** Not from the report. JUnit's `assertions` attribute is populated
by no supported emitter. `time` does not separate the cases: a real assertion
and an empty body took 1.45 ms and 0.28 ms under `node --test`, and mocha
reports `time="0"` for tests that genuinely ran. TAP carries neither.

**Decision.** The engine claims only what it can support — a test whose
reported name carries the id executed and did not fail — and the README says so
in those words. Whether the test asserts its requirement is a reading, placed in
`MODE=FOLD`: once per change, when every tagged test exists, reported through
`GAPS:` and relayed to the human, not gated.

**Refused.** A time or assertion threshold (fails mocha's real tests, passes
node's empty one); reading the test's source (ADR-001 in reverse); a
per-milestone reviewer pass over the test diff (a model call per milestone, with
no evidence yet that FOLD misses things); making it a gate failure (a model's
reading should not stop a run on its own).
