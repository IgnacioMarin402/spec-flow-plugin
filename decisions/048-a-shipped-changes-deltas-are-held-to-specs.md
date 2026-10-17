# ADR-048 — a SHIPPED change's deltas are held to specs/, for the changes this branch ships

**Date:** 2026-10-17 · **Status:** accepted · **Governs:** `scripts/spec-trace.mjs`, `scripts/changed-files.mjs`, `REFERENCE.md` · **Related:** ADR-009, ADR-020, ADR-022, ADR-032

**Question.** spec-trace binds a requirement to a test only once the
requirement is in `specs/`. What holds an `ADDED` delta to reaching it?

**Measured.** On `4cfe324`, a branch whose archived change is stamped SHIPPED
with `ADDED REQ-USER-002`, never written into `specs/` and with no test:
spec-trace exits 0, "every one proven by a test", and phase-guard allows
`done`. The same id written into `specs/` is denied. A `REMOVED` id left in
`specs/` with its test passes too. Only the fold's reading and the reviewer
stood between them, while REFERENCE said an `ADDED` with no test fails.

**Decision.**

- For each archived change stamped SHIPPED that the base branch does not hold,
  spec-trace fails an `ADDED` id no capability spec declares, unless a change
  of this branch `REMOVED` it, and a `REMOVED` id one still declares. The
  binding then requires a test that ran for every `ADDED`.
- During a run, until its fold, a change the branch shipped earlier is printed
  and does not fail: the run's own change is live until then, so a SHIPPED one
  is an earlier run's. From the fold's gate on, and at `done`, which allows no
  live change, every change of the branch is held. Outside a run, always.
- A delta line `deltas` does not read whole is refused in a live spec and in a
  SHIPPED change of this branch: another spelling of the line, or a second id
  before its text. Every check that binds a delta reads `deltas`.
- A live change is not held: a milestone writes its delta when it delivers it.
- Where no base resolves, spec-trace says the deltas were not checked, and why,
  and does not print that every requirement is proven.

**Refused.**

- **Every SHIPPED change in the archive.** History a run inherited is not its
  to answer for (ADR-032). A repository with an old drift would go red mid-run,
  routed to an implementer whose milestone did not cause it.
- **A red-first check instead** (BACKLOG B36). It measures whether a test can
  fail, not whether a requirement has one, and as a gate it blocks correct
  milestones.
- **Holding a live change's `ADDED` ids from its first gate.** A milestone early
  in the plan would be blocked over a later milestone's requirement.
- **Failing a milestone gate over an earlier change of the branch.** It routes
  a lint/trace failure to the current implementer, whose work order does not
  name the id.
- **Telling the run's own change by `.claude/state/current-milestone`.** A hook
  writes it at a spawn when it can and nothing clears it: a stale one, measured,
  exempted the run's own change at its fold and at `done`.
- **Saying an earlier run's drift at the fold instead of failing on it.** The
  gate and `done` report nothing of a check that passed, so it reached no one.
- **Reading more spellings of a delta line.** Each of the parsers that read the
  section would have to learn them together, and a second id before the text
  has no reading that is surely the author's.
- **`CHANGED` ids.** The id exists before and after the edit (ADR-009).

**Cost.** spec-trace asks git which archived changes the base holds, so it
needs the base the gate already needs. A drift a branch inherits stays until
someone fixes it on a branch of its own. A drift an earlier run of the branch
left fails the next run's fold, routed to the spec-writer and then the human,
not to the milestone that met it.
