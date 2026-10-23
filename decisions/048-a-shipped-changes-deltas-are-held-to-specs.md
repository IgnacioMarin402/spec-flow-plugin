# ADR-048 — a SHIPPED change's deltas are held to specs/, for the changes this branch ships

**Date:** 2026-10-17 · **Status:** accepted · **Governs:** `scripts/spec-trace.mjs`, `scripts/changed-files.mjs`, `scripts/spec-shape.mjs`, `scripts/spec-time.mjs`, `hooks/agent-gate.mjs`, `agents/spec-writer.md`, `modes/spec-writer-triage.md`, `REFERENCE.md` · **Related:** ADR-009, ADR-020, ADR-022, ADR-030, ADR-032

**Question.** spec-trace binds a requirement to a test only once the
requirement is in `specs/`. What holds an `ADDED` delta to reaching it?

**Measured.** On `4cfe324`, a branch whose archived change is stamped SHIPPED
with `ADDED REQ-USER-002`, never written into `specs/` and with no test:
spec-trace exits 0, "every one proven by a test", and phase-guard allows
`done`. The same id written into `specs/` is denied. A `REMOVED` id left in
`specs/` with its test passes too. Only the fold's reading and the reviewer
stood between them, while REFERENCE said an `ADDED` with no test fails. The
same exit 0 held for a delta spelled any way the parser did not read: under
`## Requirement Deltas`, in a table, with a bracketed verb, as a range.

**Decision.**

- For each archived change stamped SHIPPED that is this branch's, spec-trace
  fails an `ADDED` id no capability spec declares, unless a shipped or live
  change `REMOVED` it, and a `REMOVED` id one still declares. The binding then
  requires a test that ran for every `ADDED`.
- A change is inherited when the base holds its spec and the branch never
  wrote it. Written since, even a typo fix, it is the branch's.
- During a run, a change the branch archived before one of its live changes
  was created is an earlier run's: said, and not failed. A live change is a
  spec on disk the base lacks; the branch's commit history orders the two. A
  run's fold archives its change after each live one was created, and `done`
  allows none live, so from the fold's gate on every change of the branch is
  held. Outside a run, always.
- Each archived change has a folder of its own. A change spec inside another
  change's folder — a fold onto a name the archive had — and two folders a case
  apart, one folder on macOS and Windows, are reported, scoped as above.
- A delta is one line of `## Requirement deltas`: `- VERB REQ-id`, its verb
  `ADDED`, `CHANGED` or `REMOVED` in capitals, one id, then its text; code, and
  an HTML comment that starts a line, are not read. Every other line of the
  section names only ids a delta line reads; a delta's own text, and a `none`
  line's, may name any id, but not after a verb in capitals. A line naming
  another id, an id spelled another way, a line a delta verb leads in capitals
  that is no delta, a second id or number before a delta's text, deltas under
  another heading or outside the section, and a section with neither a delta
  nor a `none` line are refused at
  spec time — leaving `spec`, the spec-writer's return, resume's sign-off — and
  in a SHIPPED change of this branch that names an id. Outside the section only
  OpenSpec's `## ADDED Requirements`, or a delta verb in capitals leading a
  line into an id, counts.
- A live change named like an archived one, in any case, is refused at spec
  time: from the spec-writer only in `spec`, from a case 5 brief, which the
  orchestrator archives at once, always.
- What needs the base to tell this branch's changes from the inherited fails,
  naming each, when none resolves.

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
- **Failing a heading in `specs/` shaped like a requirement that the base
  already has.** Renumbering it is a spec call, and every gate of a run would
  send it to an implementer whose milestone did not write it. It is said; the
  branch that rewrites the line answers for it.
- **Telling the run's own change by `.claude/state/current-milestone`.** A hook
  writes it at a spawn and nothing clears it: a stale one, measured, exempted
  the run's own change at its fold and at `done`.
- **Telling it by any folder left under `specflow/`.** An empty folder a fold
  left, or a plan parked on the base, made the fold's gate call the run's own
  drift an earlier run's.
- **Saying an earlier run's drift at the fold instead of failing on it.** The
  gate and `done` report nothing of a check that passed, so it reached no one.
- **Holding a live spec's spelling at every gate.** A run signed off before a
  spelling was refused would fail its milestones over it, sent to an
  implementer told not to read the spec; its fold is held instead.
- **Renaming a live folder over a name the archive gained mid-run.** The run's
  milestone, resume and the snapshot name it; the fold's gate reports the
  folder it nests.
- **Reading other spellings of a delta line instead of refusing them.** Every
  reader would have to learn them together, and a second id before the text
  has no reading that is surely the author's.
- **Telling a delta from a note by its verbs.** Each pass over such a grammar
  found a spelling read as neither — a table cell in title case, a `·` bullet —
  or a correct line refused — `DELETE /users/:id` beside an id, `### Update`.
  An id is what a check binds, so an id no delta reads is what is refused. A
  delta verb in capitals leading a line is no guess, and is kept: it alone
  sees `- ADDED REQ-USER-10`, whose id no reader parses.
- **Reading `REQ-X-002-004` as a range.** It is also an id of a capability
  named `X-002`.
- **Refusing any line outside the section that leads with a verb in capitals.**
  A constraint on `REMOVED` items or a quoted audit log failed a correct spec
  at spec time and at its fold.
- **Saying, with no base, that the deltas went unchecked.** `check` and the gate
  fail with no base; a pass beside them looked armed.
- **`CHANGED` ids.** The id exists before and after the edit (ADR-009).

**Cost.** spec-trace asks git for the base, the change specs it holds and the
branch's writes since, whenever an archived change needs them. A drift a
branch inherits stays until someone fixes it on a branch of its own; touching
the inherited spec makes it this branch's. A drift an earlier run of the
branch left fails the next run's fold, routed to the spec-writer and then the
human, not to the milestone that met it. A fold and the next run's spec in
one commit — a squash, an amend — or a fold merged in from another branch after
the next run began have no order between them, so that drift fails the next
run's milestone gates instead; the flow commits a fold before `done`. An id an
archive retired in another spelling, `REMOVED` in capitals, now counts as
retired at every gate, where reuse was always checked; a note retires nothing.
An update reaches a run in flight: a spelling refused since, a note naming an
id its deltas do not read, or an earlier run's drift fails its fold; a
malformed heading this branch wrote in `specs/` fails its next gate.
