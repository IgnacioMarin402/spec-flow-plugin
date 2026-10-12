# ADR-040 — this flow's agent put to work outside a run is recorded

**Date:** 2026-10-12 · **Status:** accepted · **Governs:** `hooks/dispatch-guard.mjs`, `scripts/specflow-stats.mjs`, `REFERENCE.md` · **Extends:** ADR-035

**Question.** Every hook that counts, records or holds a spawn reads the phase
first and stands down without a run phase. What sees one of this flow's agents
put to work when no run is in progress?

**Measured.**

- On `620901d`, a planner spawn with the phase at `done` writes nothing to
  `opus_calls` or `run-trace.log`: preflight, the Opus budget, dispatch-guard,
  run-trace, token-trace (it drops the slice) and the agent gate all stand
  down. With the phase at `spec` the same spawn leaves both.
- In a real run the spec step and the first plan left no line in the archived
  telemetry, and the snapshot also held the run before it: the step-0 `--mark`
  had not moved. Both fit a run that started without writing `spec`.

**Decision.**

- `dispatch-guard` records, and lets through, a spawn or a message that puts
  one of this flow's agents to work while the phase is empty, `idle` or
  `done`: a `dispatch` line with `why=no-run` and the phase it found (`-` for
  none). Other agents outside a run are still left alone.
- Only where `.claude/state/` exists: a repository the engine never ran in is
  left without one.
- Stats warns about these apart from ADR-035's records: they are not a rule to
  weigh, but a dispatch nothing counted, traced or held.

**Refused.**

- **Denying the spawn.** Outside a run, putting an agent to work can be a
  person's deliberate act — `arm-gate` already treats an implementer there
  that way — and a denial would stand between them and it. ADR-035's order
  holds: recorded first.
- **Counting it against the Opus budget.** The budget is a run's, reset at
  step 0; outside one there is nothing to charge.
- **Tracing its reads and tokens.** That is run-trace's and token-trace's,
  and both stand down outside a run on purpose; the `dispatch` line says it
  happened, which is what was missing.

**Cost.** One hook process per spawn outside a run, already paid: the hook
ran and returned. One line per such dispatch.
