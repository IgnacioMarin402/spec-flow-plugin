# ADR-035 — a dispatch is recorded before it is denied

**Date:** 2026-10-11 · **Status:** accepted · **Governs:** `hooks/dispatch-guard.mjs`, `hooks/arm-gate.mjs`, `hooks/lib/dispatch.mjs`, `hooks/lib/agent-name.mjs`, `scripts/spec-time.mjs`, `scripts/specflow-stats.mjs`, `hooks/hooks.json`, `REFERENCE.md` · **Supersedes:** ADR-030's exemption of `arm-gate` · **Related:** ADR-025, ADR-029, ADR-031, ADR-034

**Question.** The orchestrator decides which agent works in which phase, what
it is handed, and who gets a follow-up. ADR-034 holds what it reads and writes.
What holds what it dispatches?

**Measured.**

- `arm-gate` moves the phase to `implement` when the implementer is engaged
  without it, and that write never passed `phase-guard`. ADR-030 exempted it
  because the first gate repeats the checks. But the agent gate passes a brief
  only when its triage returns (ADR-031), and the session may still write
  `specflow/` afterwards (ADR-034). So a brief `phase-guard` would hold in
  `spec` went into `implement` through the backstop alone.
- `arm-gate` read who a `SendMessage` was for off name-ish fields. A message
  addresses an agent by the id its spawn returned, so resuming the implementer
  by id from `blocked` left the gate disarmed.
- Nothing else. The commands say which roles each phase dispatches, that the
  implementer gets `plan.md` and its milestone and nothing else, and that a
  message goes to an agent this run spawned. No hook read any of it, and no
  traced run has shown a departure yet.

**Decision.**

- Every way into `implement` passes the same check. From `spec`, `arm-gate`
  applies `leavingSpecProblems`, the copy `phase-guard` uses, and denies the
  spawn instead of arming over a spec that fails it.
- A `SendMessage` recipient resolves to its role through the session's record
  of the spawn: the `.meta.json` beside the subagent's transcript, which
  `stale-resume` already reads. `arm-gate` arms on it.
- `dispatch-guard` records, and lets through, each of the session's dispatches
  the commands do not describe:
  - a role outside its phase's set;
  - an agent that is not this flow's;
  - an implementer spawn missing `plan.md` or its milestone, or naming other
    repository files;
  - a message to an agent this session did not spawn.

  The implementer's phase is left to `arm-gate`, which records each time it
  arms or denies. Both write `dispatch` lines to `run-trace.log`, so the
  snapshot archives them with the run, and stats tallies them by agent and
  reason.
- A rule becomes a denial once traced runs show it records nothing the
  commands meant. The test is reading the lines, not reaching a count.

**Refused.**

- **Denying from the first run.** The phase table and the input rule come from
  prose. One real run already went back from `review` to `spec`. A guard that
  denies a step a run needed stalls it while the human waits; a wrong record
  costs one line.
- **Folding `arm-gate` into the guard.** Both run in parallel on the same call,
  and `arm-gate` writes the phase the guard would read. The guard leaves the
  implementer's phase to the hook that moves it.
- **Counting follow-ups per agent.** `stale-resume` and the Opus budget already
  bound the expensive ones (ADR-025), and stats shows the orchestrator's
  messages per run (ADR-033).

**Cost.** A hook process on each dispatch during a run. From `spec`, an
implementer engaged over a spec that is not ready costs a denial and a new
triage, where it used to cost a milestone and a failed gate.
