# ADR-010 — a green gate wakes the run, once per commit

**Date:** 2026-08-21 · **Status:** accepted · **Governs:** `hooks/gate.mjs`, `hooks/lib/io.mjs` · **Supersedes:** the "silent to the model" half of B16 (`BACKLOG.md`)

## The question

A pass used to render `{"systemMessage": ...}` with no `decision` — the Stop
is allowed, the model is never re-invoked, and B16 verified the human still
sees a `Stop says: ...` line. That verification ran against `claude -p`
(headless, Claude Code 2.1.233). Nothing had run it against an interactive
session, because nobody had a reason to think the two would differ.

A real run surfaced the difference: three milestones in a row passed the
gate, and the human never saw a line for any of them. The run stalled three
times waiting for a "continue" that only existed because the notice never
arrived.

## What was checked before touching anything

Two Stop hooks were installed in a real Claude Code session (2.1.233 and
2.1.238, both `claude -p` and interactive) — one printing only
`{"systemMessage": "..."}`, one printing only `{"decision":"block", ...}`.
Session transcripts (`~/.claude/projects/**/*.jsonl`) were read directly,
not the terminal's rendering, so what follows is what the session RECORDED,
not what a screenshot might have shown:

| session type | `systemMessage` from a Stop hook | `decision: block` from a Stop hook |
| --- | --- | --- |
| `claude -p` (headless), 2.1.233 and 2.1.238 | recorded (`hook_system_message`) | recorded (`hookErrors`) |
| interactive (`entrypoint: cli`), the real failing run, 2.1.233 | **not recorded** — 3/3 passes, `hasOutput:false` | recorded — the run's own `GATE FAILED` blocks, same session |

Across every transcript on the machine (120 session files), the only
`hook_system_message` entries of type `Stop` are the two generated for this
check. No real spec-flow run — not this one, not any earlier one — ever
recorded one. The same session that lost three `Stop` notices rendered a
`PostToolUse` notice fine, so the loss is specific to `systemMessage` off a
`Stop` hook, not to notices in general, and not to the CLI build.

## The decision

`passAndExit` in `hooks/gate.mjs` calls `emitBlock`, not `emitNotice`, the
first time a given commit passes. The reason string states PASSED and what
to do next — start the next milestone, FOLD, or write `done` — the same shape
every failure message in that file already uses. `emitBlock` is the channel
this investigation confirmed reaches an interactive session; nothing here
claims it reaches every possible client, only that it reached the one that
lost the other channel.

**Guarded to once per commit**, or a Stop that fires twice on the same clean
tree — an implementer that reported early, a human who said nothing in
between — would block, get answered, stop again, and block again with
nothing new to report. Before deciding, `passAndExit` checks whether an
earlier line in `gate-history.log` already recorded `result=pass` for the
CURRENT commit's short sha. If so, it calls `emitNotice` instead — the old
behavior, now reserved for the repeat case, where losing it costs nothing
because the orchestrator was already told once.

## What this costs, and why it is not the whole story anymore

B16's own argument was correct on its own terms: waking the model on every
pass turns "the cheapest outcome in the flow" into another turn, on every
milestone, in every run. That cost is real and this record does not dispute
it — a green milestone now spends one orchestrator turn it did not spend
before.

What changed is not the cost, it is what it was being weighed against. B16
compared "wake the model" to "the human sees a notice, for free." That
alternative does not exist on the surface this actually runs on — the
notice was never free, it was silently absent. The honest comparison is one
extra turn per milestone against a run that stalls on every milestone until
a human happens to notice and intervenes, which is what was actually
observed. Weighed against the real alternative, not the assumed one, the
extra turn is the cheaper failure mode.

## What this does not fix, and is not the same investigation

**The auto check-in that was supposed to cover this.** `commands/spec-flow.md`
and `commands/spec-fix.md` already told the orchestrator to schedule a
`send_later`-style self-check-in before a gate-triggering stop, specifically
so a silent pass would not strand the run. It never fired: the phrase named
no tool, and the candidates that exist (`ScheduleWakeup`,
`mcp__scheduled-tasks__create_scheduled_task`) are deferred — invisible until
searched for — so an orchestrator reading its own visible tool list
correctly concludes none is available. That clause is removed from both
commands by this same change, not repaired, because a deterministic wake at
the gate covers the identical failure without depending on which tools a
given client happens to expose.

**Whether `emitNotice` reaches ANY interactive client, in general.** What was
verified is one client, one version pair, one machine. The header on
`emitNotice` (`hooks/lib/io.mjs`) says exactly that and no more.

## What was refused

**A `wake_on_pass` contract knob.** Leaves the shipped default silently
broken for every repo that does not know to flip it, and doubles the cases
`gate-fixture.mjs` has to hold — one for each setting — for a behavior that
should simply be correct. If a repo genuinely wants the old silence, an ADR
superseding this one is the right size for that argument, not a config flag
nobody is told to set.

**Waking on every pass, no guard.** Rejected above — it is the thrash a
milestone-scoped flow does not need, not a smaller version of the fix.

## Related

B16 (`BACKLOG.md`) — the record this supersedes in part. Its silent-to-model
argument stands as prose describing what was believed at the time; this ADR
is the record of it being checked against the client that actually runs the
flow and found wanting on the "and the human WILL see it" half.
