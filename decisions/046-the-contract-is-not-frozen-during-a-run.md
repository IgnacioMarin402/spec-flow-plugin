# ADR-046 — the contract is not frozen during a run

**Date:** 2026-10-17 · **Status:** accepted · **Governs:** `REFERENCE.md`, `BACKLOG.md` · **Related:** ADR-008, ADR-034, ADR-035

**Question.** `.spec-flow/config.json` decides what the gate runs, and an agent
can change it during a run: `verify.lint` pointed at a no-op, an `extra_checks`
entry removed. Should a run freeze it, and roll back a change?

**Measured.**

- No real run has recorded an agent changing the contract.
- The orchestrator cannot: during a run it writes only `.claude/state/` and
  `specflow/` (ADR-034). The implementer can. Nothing guards `.spec-flow/`.
- The gate asks a person to edit the contract mid-run: when it does not load,
  when the base does not resolve (`base_ref`), when `scope_globs` matches
  nothing.
- The contract is the first of the files the gate runs through. `verify.test`
  is often a package script, and the linter and the test runner read configs of
  their own, which the implementer edits as part of its work.
- Two defenses hold for the suite whatever the contract says: the gate removes
  the previous report before each suite, so a suite that stops writing one is
  refused; and a requirement is proven only by a test that ran under its id.

**Decision.** A run does not freeze the contract. A change to `.spec-flow/`, or
to a file it runs through, made during a run changes what the gate judges with,
and only the diff a person reviews shows it. REFERENCE states the risk.

**Refused.**

- **A snapshot at run start, judged with, and a rollback on a change.** The gate
  cannot restore the file itself: it judges a clean tree only, so its own write
  would make the next gate skip. A frozen contract also refuses the mid-run fix
  the gate asks a person for, unless a command reopens it, and that command is
  one more thing an agent can run. All of it for one file of several, against a
  risk no run has shown.
- **Denying agents' writes to `.spec-flow/`.** One file of several, and a Bash
  spelling gets past it as it gets past the other consistency guards.
- **Recording the contract's hash on each gate line**, ADR-035's order of
  recording before denying. The diff already records a committed change, and
  the gate judges only committed work.

**Cost.** A milestone that weakens a check passes the gates that follow, and is
caught only by a person reading the diff or by the reviewer, who reads the plan,
not the code.
