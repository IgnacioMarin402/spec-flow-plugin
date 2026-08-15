# ADR-001 — proof comes from what the runner reported, not from parsing source

**Date:** 2026-08-15 · **Status:** accepted · **Record:** `331ea1b`

## The question

`spec-trace` bound a requirement to its test by reading test files and
matching `it(...)` / `test(...)` call shapes. That made a genuine, executed
pytest proof read as "has no test", and since the check sits in the gate, no
milestone in a non-JS repo could ever pass.

How should a requirement be bound to the test that proves it?

## The decision

The contract declares `trace.executed_tests`: argv whose output names the
tests that RAN, one per line. A requirement is proven when a reported line
contains its id. The engine parses no source and knows no report format —
only lines.

The reasoning that decided it: **"did this test run?" is a runtime fact that
was being derived statically**, and that derivation is what forced the engine
to know a language at all. JS puts the skip marker in the same expression as
the declaration; pytest and JUnit put it on the line above; Go puts it inside
the body behind a condition no expression decides. Asking the runner is the
same move the gate already makes one level up — it does not ask the model
whether the tests passed.

## What was refused

- **Teaching the matcher more idioms.** Covers the spellings someone thought
  of, and no others.
- **A contract field for the title pattern alone.** Delivers proofs and
  silently drops skip detection, turning a loud failure into a quiet one —
  the failure this engine exists to close.

## What followed

The whole-repo walk and `NEVER_WALK` went with it: with nothing searching for
test files, an ecosystem list of directories to avoid had no job. Two
documented limitations of the old matcher disappeared, since a runner reports
names already expanded.
