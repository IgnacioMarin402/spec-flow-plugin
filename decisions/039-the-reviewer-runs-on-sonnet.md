# ADR-039 — the reviewer runs on Sonnet, at medium effort

**Date:** 2026-10-11 · **Status:** accepted · **Governs:** `agents/reviewer.md` · **Refines:** ADR-015 (its `reviewer: low`) · **Related:** ADR-013, ADR-014, ADR-026

**Question.** The reviewer is the one pass that reads a plan before an
implementer is spent on it, and it ran on the cheapest tier at `low` effort.
ADR-026 deferred re-routing it until a measurement said whether that `low`
reached the model at all. Should it stay the cheapest pass?

**Measured.** Two real `/spec-flow` runs in one adopting repository, from
their `run-trace.log` token lines (model per line, output a floor — BACKLOG
B43) and the live view's exact copy of the second. Priced at list rates,
subagent cache writes at the 5-minute rate and the session's at the 1-hour one
(ADR-025):

- the second run, on this engine's `620901d`: the reviewer ran on
  `claude-haiku-5-5` at `low`, 11 requests of about 53k tokens of prompt,
  US$0.02. It returned `CHANGES_REQUESTED`, and the planner revised the plan.
  The same tokens on Sonnet 5.5 are ~US$0.36 — a price swap, not a forecast:
  Sonnet at `medium` will not spend Haiku-at-`low`'s tokens. One implementer
  milestone there cost US$0.42–0.74, and the run at least US$2.44;
- the first run, three hours earlier on `2edffe7`: `haiku` resolved to
  `claude-haiku-4-5`. The reviewer's return line carried no effort, and it
  thought 10,706 tokens over 6 requests, against 3,793 over 11 at `low` on
  Haiku 5.5. It approved. That is the measurement ADR-026 waited for: on the
  older model nothing shows `low` reaching the reviewer, and it thought about
  five times as much per request; on the current one the return line records
  it.

The second run's close reported a requirement whose negative clause ("cannot
be used as a filter") no test asserted; whether a stronger reviewer would have
asked for that test is not measured. Effort is supported on Sonnet 5.5 too, and
`run-trace` records the level an agent ran at on its return line, so the move
to Sonnet is a judgement about the role, not a fix for ADR-026's concern.

**Decision.** `reviewer: sonnet`, `effort: medium`. The fixtures that exercised
routing through the reviewer read its tier and effort from the frontmatter
under test, so a later move does not touch them.

**Refused.**

- Opus: twice Sonnet's price, and the tier of the planner whose plan it judges.
- Haiku at a higher effort: an order of magnitude cheaper and unmeasured for
  judgement; the pass whose miss costs a milestone gets the stronger model
  first.
- `high` effort: raised on evidence, not ahead of it.

**Cost.** About US$0.34 more per run at the second run's tokens, ~14% of it.
It is worth it if one implementer milestone in two or three runs is saved. The
reviewer's row in `specflow-stats` (APPROVED against CHANGES_REQUESTED and
ESCALATE) and the gate's first-pass count are what will show whether it is.
