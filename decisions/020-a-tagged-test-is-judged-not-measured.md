# ADR-020 — a tagged test that asserts nothing is judged, not measured

**Date:** 2026-08-28 · **Status:** accepted · **Governs:** `agents/spec-writer.md`, `scripts/test-report.mjs`, `README.md` · **Extends:** ADR-001, ADR-005

## The question

`spec-trace` binds a requirement to a test through the name the runner
reported. A test carrying the id and asserting nothing therefore passes, and
the gate has no way to know: the engine reads no source code (ADR-001), so the
body of that test is not something it can look at.

Measured before anything was decided — a requirement added to `specs/` and a
test carrying its id with an empty body reports `OK — proven by` and takes the
gate to green with nothing implemented.

So: can the engine detect it without reading source?

## What was measured

**The report carries no evidence of an assertion.** The JUnit schema has an
`assertions` attribute, which made a report-side check look available. No
emitter this engine supports populates it. Captured from real runs:

```
node --test  <testcase name="REQ-A-001 real assertion"       time="0.001454" classname="test"/>
node --test  <testcase name="REQ-A-002 empty body"           time="0.000277" classname="test"/>
vitest       <testcase name="REQ-AUTH-001 rejects a bad …"   time="0.001053755" …>
mocha        <testcase name="REQ-AUTH-001 rejects a bad …"   time="0"/>
```

`time` is the only quantity present, and it does not separate the two cases.
The real assertion and the empty body are 1.45ms and 0.28ms — a gap smaller
than the noise on a loaded runner — and **mocha reports `time="0"` for a test
that genuinely ran and passed**, so any "zero time is suspicious" rule flags
real proofs on one of the three runners in scope. TAP carries neither quantity
at all.

## The decision

**Nothing in the engine tries to measure it.** The claim the machine makes
stays exactly what it can support — a test whose reported name carries the id
executed and did not fail — and the README says so in those words rather than
implying more.

**The judgement is placed in `MODE=FOLD`.** Whether a test asserts its
requirement is a reading, not a parse, so it belongs to a model; the question
is which one and when. FOLD already reads the change's `Requirement deltas`,
already verifies each landed in `specs/`, already reports through `GAPS:` for a
delta missing "from specs/ or tests", and is already forbidden from touching
code or tests. It runs **once per change**, at the one point where every tagged
test exists, and the gate re-runs on the fold's own commit — so a gap reported
there routes back through the protocol that already exists.

## What was refused

**A time or assertion threshold in the gate.** The measurement above is the
whole argument: it would fail mocha's real tests and pass node's empty one.
Shipping it would have been a check that looks armed and is not, which is the
single failure this engine exists to close.

**Reading the test's source.** It is the direct answer and it is ADR-001 in
reverse: the moment the engine parses a test body it must know a language, and
the coupling that removed is the reason it works on any Node project.

**A per-milestone reviewer pass over the test diff.** The narrower placement,
and it costs a model call per milestone against one per change. It also
reverses a decision already taken and recorded — the second review pass was
cut for re-reading spec, plan and diff on every milestone for little marginal
signal — so re-adding a cheaper version of it needs evidence that FOLD misses
things, which does not exist yet. Detection is later this way, and that is the
accepted cost: later than the milestone, still before the run closes.

**Making it a gate failure.** FOLD reports it; the human reads it. A model's
reading of whether an assertion is meaningful is not the kind of claim that
should stop a run on its own, and `spec-trace`'s own refusals are all facts
about ids rather than judgements about bodies.
