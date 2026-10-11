# ADR-039 — the reviewer runs on Sonnet, at medium effort

**Date:** 2026-10-11 · **Status:** accepted · **Governs:** `agents/reviewer.md` · **Refines:** ADR-015 (its `reviewer: low`) · **Related:** ADR-013, ADR-014, ADR-026

**Question.** The reviewer is the one pass that reads a plan before an
implementer is spent on it, and it ran on the cheapest tier at `low` effort.
ADR-026 deferred re-routing it until a measurement said whether that `low`
reached the model at all. Should it stay the cheapest pass?

**Measured.** One real `/spec-flow` run in an adopting repository: the live
view's per-agent counts ("Copy exact counts", ADR-037), whose output is the
API's per-request count, not token-trace's floor. Priced at list rates,
subagent cache writes at the 5-minute rate and the session's at the 1-hour one
(ADR-025):

- the reviewer: 11 requests, about 53k tokens of prompt each. The copy names
  no model: ~US$0.02 if `haiku` resolved to Haiku 5.5, ~US$0.18 if to Haiku
  4.5. The same tokens on Sonnet 5.5 are ~US$0.36. That is a price swap, not a
  forecast: Sonnet at `medium` will not spend Haiku-at-`low`'s tokens;
- one implementer milestone on Sonnet: US$0.63–0.89. The run: US$2.5–2.7 by
  the orchestrator's tier, and more, since the copy lists agents in spawn order
  and holds neither the spec step's spec-writer nor the first planner.

A planner was spawned after the reviewer and before the first implementer, so
the Haiku reviewer did not wave the plan through; whether its doubt was sound
is not recorded. The run's close reported a requirement whose negative clause
("cannot be used as a filter") no test asserted; whether a stronger reviewer
would have asked for that test is not measured. ADR-026's measurement — the
`think` count on the reviewer's row — was not taken, and this does not need it:
its concern was that `effort` was unsupported on the reviewer's tier, which no
longer holds, since Haiku 5.5 and Sonnet 5.5 both take it, and `run-trace`
records the level an agent ran at on its return line. The move to Sonnet is a
judgement about the role, not a fix for that concern.

**Decision.** `reviewer: sonnet`, `effort: medium`. The fixtures that exercised
routing through the reviewer read its tier and effort from the frontmatter
under test, so a later move does not touch them.

**Refused.**

- Opus: twice Sonnet's price, and the tier of the planner whose plan it judges.
- Haiku at a higher effort: an order of magnitude cheaper and unmeasured for
  judgement; the pass whose miss costs a milestone gets the stronger model
  first.
- `high` effort: raised on evidence, not ahead of it.

**Cost.** About US$0.34 more per run at the measured run's tokens if the
reviewer was on Haiku 5.5 (~12% of the run), US$0.18 if on Haiku 4.5.
It is worth it if one implementer milestone in two or three runs is saved. The
reviewer's row in `specflow-stats` (APPROVED against CHANGES_REQUESTED and
ESCALATE) and the gate's first-pass count are what will show whether it is.
