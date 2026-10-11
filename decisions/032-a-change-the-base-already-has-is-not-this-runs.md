# ADR-032 — a change the base branch already has is not this run's

**Date:** 2026-10-11 · **Status:** accepted · **Governs:** `hooks/lib/can-run.mjs`, `hooks/phase-guard.mjs`, `hooks/preflight.mjs`, `scripts/changed-files.mjs`, `scripts/resume.mjs`, `commands/spec-flow.md`, `commands/spec-fix.md`, `commands/resume.md`, `REFERENCE.md` · **Related:** ADR-022, ADR-024, ADR-028

**Question.** A plan committed on the base branch and never run sits in
`specflow/<slug>/`. What happens to a run on a branch off it?

**Measured.** A real run specified, planned, implemented two milestones and
folded. Then `phase-guard` refused `done`, because `done` needs every change
folder archived, and routed the unarchived folder to a FOLD of a plan nobody
had built. The orchestrator moved the human's plan to `docs/backlog/` on its
own to close the run. `resume.mjs` would have offered that plan as the
unfinished run to resume. From the disk alone, a parked plan and an abandoned
run look the same.

**Decision.** A change folder live under `specflow/` that the merge-base with
the base branch already has is no run of this branch: a run creates its
folder on its own branch, after that commit. `assertCanRun` refuses it, so
`phase-guard` declines the write that starts a run and `preflight` the spawn,
with nothing armed (ADR-028); moving the plan out of `specflow/` or archiving
the change is the human's call. `resume.mjs` names such a folder and never
offers it. `done`'s refusal marks it as not this run's, so it is not folded.
A folder this branch created still starts a run: it is the one a resume
re-enters.

**Refused.**

- Refusing the start over any live folder: `/spec-flow:resume` starts a run
  over its own live folder after a stale reset.
- `done` judging only this run's folder: the run ends and the folder stays in
  `specflow/`, where the next run, `resume.mjs` and spec-trace still read it
  as a change in flight. The problem moves to the next branch instead of
  being said.
- A parked-plans directory beside `archive/`: a second exception in every
  reader of `specflow/`, for a place the engine has no use for.

**Limits.** A plan parked on this branch before the run starts is not caught
at the start; `done` still refuses it. A run on the base branch itself, not a
supported shape, finds its own folder at the base once that folder is pushed.

**Cost.** One `git ls-tree` on each check `assertCanRun` makes (the start
write and every spawn), and one on a `done` write.
