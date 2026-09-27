# ADR-010 — a green gate wakes the run, once per commit

**Date:** 2026-08-21 · **Status:** accepted · **Governs:** `hooks/gate.mjs`, `hooks/lib/io.mjs` · **Supersedes:** the earlier rule that a pass is silent to the model

**Question.** A pass rendered `{"systemMessage": ...}`: the stop was allowed and
the model not re-invoked, on the belief that the human still sees the notice.
That was verified only under `claude -p`. In a real interactive run, three
milestones passed and the human saw nothing; the run stalled three times.

**Measured.** Session transcripts, not screen output (Claude Code 2.1.233 and
2.1.238): a Stop hook's `systemMessage` is recorded under `claude -p` and **not**
in an interactive session (3/3 lost, `hasOutput:false`); `decision: block` is
recorded in both. Across 120 session files, no real run ever recorded a Stop
`systemMessage`.

**Decision.** The first pass for a commit blocks the stop with a reason that
says PASSED and what to do next. A repeat stop on a sha that already has a
`result=pass` line gets the old notice instead, so the run is not asked twice.
The self-check-in clause in both commands, which named no tool and never fired,
was removed rather than repaired.

**Cost.** One orchestrator turn per green milestone — against a run that stalls
on every milestone until a human notices, which is what the silent pass
actually produced.

**Refused.** A `wake_on_pass` knob (the shipped default would stay broken for
everyone who does not flip it), and waking on every pass (thrash on repeated
stops over the same tree).
