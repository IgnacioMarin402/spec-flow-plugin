# ADR-040 — this flow's agent put to work outside a run is recorded

**Date:** 2026-10-12 · **Status:** accepted; its refusal to deny revisited for the implementer by [ADR-044](044-the-implementer-works-only-inside-a-run.md) · **Governs:** `hooks/dispatch-guard.mjs`, `hooks/lib/io.mjs`, `scripts/specflow-stats.mjs`, `REFERENCE.md` · **Extends:** ADR-035

**Question.** Every hook that counts, traces or holds a spawn stands down
without a run phase; `register-agent` still maps an id to its type, and that is
all. What sees one of this flow's agents put to work when no run is in
progress?

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
  none). This flow's agent is `spec-flow:<role>`, the name the harness
  reports; a bare `reviewer` there is a person's own, and is left alone like
  every other agent.
- Only where `.claude/state/` exists and git tracks nothing in it. A repository
  the engine never ran in is left without one, and one a clone brought is
  content: its phase file's text would land in the line, and its log may link
  out of the repository.
- Stats keeps these out of ADR-035's records. A spec-writer or planner with no
  run phase is warned about: step 0 writes the phase before either, so it is a
  run that skipped writing `spec` or had its phase reset under it. Any other
  is reported as use outside a run (a question to the architect, the fresh
  implementer step 6 offers after `done`), and a slice holding only these
  counts as no run.

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
ran and returned. One `git ls-files` per spawn of this flow's agent there, and
one line. A line written between runs lands before the next `--mark`, so no
snapshot takes it and it stays in stats' `(current)`: a spec-writer or planner
asked for between runs keeps its warning there.
