# ADR-008 — the test suite is never scoped to the diff, and never skipped

**Date:** 2026-08-21 · **Status:** accepted · **Governs:** `hooks/gate.mjs`

**Question.** Lint is scoped to the changed files so a milestone is not blocked
by old debt. Should the suite be scoped the same way?

**Decision.** No: `verify.test` runs in full on every armed gate, including when
nothing in scope changed. Linting a file is a local property of that file; a
suite's outcome is a property of the system, and a scoped run stays green while
a consumer outside the diff breaks. An empty scope is a fact about the diff, and
not always a real one — a mis-resolved base manufactures it — so it skips lint
and changes nothing about the suite.

**Refused.** Scoping tests to changed files; skipping the suite on an empty
scope (the trigger is also a symptom of a disarmed gate); guessing the base
(`resolveBase` refuses, since a wrong base lints nothing).

**Cost.** A slow suite is paid every milestone, and the Stop hook's 1800s
timeout is a ceiling: a cancelled Stop hook ALLOWS the stop. The answer is a
smoke subset declared as `verify.test` — the adopter's call about what
"proven" means.
