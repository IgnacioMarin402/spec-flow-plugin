# ADR-007 — the supported scope is Node, declared rather than enforced

**Date:** 2026-08-16 · **Status:** accepted · **Narrows:** ADR-002, ADR-006

**Question.** Four records kept the engine language-neutral for repos nobody
had tried. Then one was tried: real ruff and pytest, a test that ran and
passed, reported as `has no test that RAN` because a Python identifier cannot
hold a hyphen — while the adoption check was green over a hand-written report.
What is the engine actually tested against?

**Decision.** Node is the supported scope: what the docs describe, CI exercises,
the fixtures use and `init` optimises for. Declared, not enforced — the engine
still reads no source, so a hand-filled contract elsewhere may work; it carries
no promise. What survives: ADR-001 and ADR-005 entirely (skips are as invisible
to a parser in Node, and Node runners disagree about reporters as much as
ecosystems do). ADR-002's refusal is lifted narrowly: `init` proposes the
reporter flag for the Node runners it knows. ADR-006's setup skill stays for
what `init` still cannot read.

**Refused.**
- Enforcing the scope: a new refusal path and a regression for anyone already
  running elsewhere, for clarity the docs already give.
- Deleting the format readers: Node's own runner emits TAP, and JUnit is what
  Node reporters write for CI.
- Reverting the `_`-as-`-` id spelling fix: three correct lines, and
  `test_REQ_USER_001_...` is legal Node.
