# ADR-043 — the turn that writes `done` is the run's last

**Date:** 2026-10-12 · **Status:** accepted · **Governs:** `hooks/run-trace.mjs`, `hooks/token-trace.mjs`, `hooks/live-view.tsx`, `scripts/specflow-stats.mjs`, `REFERENCE.md` · **Refines:** ADR-037 · **Related:** ADR-040

**Question.** Writing `done` stood down every hook that writes the trace, the
turn that wrote it included. What records that turn, and where does it land?

**Measured.**

- A run's closing PASS was followed by nothing until the next run. In a real
  log holding two finished runs, stats read the gap as "a PASS was followed by
  167m with nothing running".
- `token-trace` dropped the closing turn, because its Stop already read
  `done`, and the live view, charging as `token-trace` does (ADR-037), dropped
  it too. That turn writes `done`, archives the telemetry, runs stats and
  summarises the run for the human.

**Decision.**

- `run-trace` records the call that wrote `done` as `closed tool=<tool>`, and
  nothing else on `done`.
- `token-trace` charges the Stop whose session's latest line is its own
  `closed` line, stamped `phase=done`; later turns are dropped as before. The
  live view charges the turn that moves the phase from a run phase to `done`.
- Step 6 takes the snapshot inside that turn, so its tokens land after it.
  Stats gives each back to the archived run whose `closed` line names the
  same session; with no such line, it stays in `(current)` and counts as no
  run of its own.
- None of this where git tracks `.claude/state/` (ADR-040).

**Refused.**

- **Moving the snapshot after the closing Stop**, to the next run's step 0.
  The archive would then wait on a run that may never come, and on a cloud
  branch the container goes first.
- **Writing the line from `phase-guard` or into `gate-history.log`.** The
  guard judges a write before it happens, and the gate's log records verdicts;
  neither knows the write landed.
- **Having stats ignore the quiet after a run's last PASS.** It would hide a
  run stalled on its fold's PASS, which is what the warning is for.

**Cost.** One line per run, a tail read of the trace at each Stop on `done`,
and a closing turn whose late-landing messages go uncounted: the next Stop is
outside the run.
