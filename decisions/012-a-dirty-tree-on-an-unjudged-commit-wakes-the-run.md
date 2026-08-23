# ADR-012 — a dirty tree wakes the run when nothing has judged the commit

**Date:** 2026-08-23 · **Status:** accepted · **Governs:** `hooks/gate.mjs` · **Supersedes:** one of the two cases B16 (`BACKLOG.md`) closed as "`skip-dirty` must stay *completely* silent"

## The question

The gate does not judge a dirty tree. Implementers run in the background, a
`Stop` fires whenever the orchestrator's turn ends, and judging a snapshot
mid-write manufactures failures — so the skip is recorded and the stop is
allowed. It says nothing to the model and nothing to the human, and B16 made
that silence a guarded property on the argument that a notice which fires many
times per milestone stops being read.

The guard against the skip lasting forever counted stops: ten in a row wakes
the run once. The question this record answers is what happens when the tenth
stop never arrives.

## What the run actually recorded

A `/spec-flow` run on a consuming repo shipped four milestones, folded the
change, committed, and ended its turn expecting the gate. `gate-history.log`:

```
05:17:31  68110ee  result=pass
05:18:17  4a437c9  result=skip-dirty  files=1
05:30:39  8de111d  result=pass          <- twelve minutes later, after a human asked
```

One skip, not ten. The skip ALLOWS the stop, so the session went idle, and an
idle session produces no further `Stop` — the counter was waiting for events
that had stopped happening. The orchestrator believed it had handed the
milestone to the gate; the gate had decided nothing; nobody was told.

The one uncommitted path was the fold's `**Status:** SHIPPED` stamp, left
behind because `git mv` stages a rename carrying the file's pre-edit blob. So
the silence was not covering an empty tree: `spec-trace.mjs` run against
`4a437c9` in a clone exits 1 on `specflow/archive/trainer-module/spec.md: no
status`. The gate would have caught it in seconds.

## The decision

The dirty branch of `hooks/gate.mjs` asks whether any line in
`gate-history.log` names the CURRENT commit's short sha. If none does, it
blocks — once — and says which of the two situations this is and what to do
about each.

The discriminator is not a new fact. A skip is legitimate while an implementer
writes, and there HEAD is a commit the gate has already judged: the flow
passes a milestone before the next one starts, so the dirt sits on top of a
verdict. In the stall the orchestrator had just committed, so the dirty tree
sat on a commit nothing had ever judged — which is the streak message's own
words, "a milestone NOTHING ever judged", reachable in one stop instead of ten.

Guarded to once per commit by the same mechanism ADR-010 used for the green
pass, and needing no state of its own: `previous` is read before this
invocation appends anything, and the `skip-dirty` line it writes is what makes
every later stop on the same commit silent again.

A sha of `-` — git itself failed — does not wake. Unknown reads as "cannot
tell", and a rule that cannot tell would block on every stop; the streak guard
still covers that tree.

## What this costs

Replayed against the 40 real history lines of the repo above, this fires once
or twice per run. One of those is a false positive: at the very start of a run
the first implementer writes on a commit no gate has judged yet, and the
orchestrator is woken to answer "an implementer is running". That answer costs
one turn and the message asks for it in one sentence.

Weighed against the alternative it replaces — a run that stops, silently,
having verified nothing, until a human notices the absence of something that
was never going to appear — one turn per run is the cheaper failure.

## What was refused

**Lowering `MAX_DIRTY_SKIPS`.** It does not reach this failure at any value
above one, because the streak was one. Lowering it to one would wake on every
mid-write stop, which is the noise B16 was right about.

**Waking on the first skip unconditionally.** Same objection, stated without
the counter.

**Deciding from what is dirty** — treating `specflow/` paths as bookkeeping an
implementer would never write. It happens to be true of the observed incident
and is a guess about every other one; the sha answers the actual question.

**Detecting whether a subagent is live.** Nothing in this engine's reach knows
that. `register-agent.mjs` records which session id belongs to which agent at
spawn; it does not, and cannot from a `PostToolUse` payload, know whether that
session is still writing.

## Related

ADR-010 — the once-per-commit guard this reuses, and the record of why a Stop
hook's `systemMessage` is not a channel this engine can wake anyone through.

B16 (`BACKLOG.md`) — its "a pass is silent" argument stands. What it also
asserted, as a neighbouring guard tightened while the contract was open, is
that `skip-dirty` must stay completely silent. That remains true on a commit
something has judged, and is now false on a commit nothing has.
