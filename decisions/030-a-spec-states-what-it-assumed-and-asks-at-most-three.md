# ADR-030 — a spec states what it assumed, and a round asks at most three

**Date:** 2026-10-09 · **Status:** accepted · **Governs:** `agents/spec-writer.md`, `scripts/spec-shape.mjs`, `scripts/spec-time.mjs`, `hooks/phase-guard.mjs`, `scripts/resume.mjs`, `scripts/agent-blocks.mjs`, `scripts/agent-contracts.mjs`, `commands/` · **Related:** ADR-015, ADR-026

**Question.** The spec-writer is told to stop and ask when anything material
is ambiguous. It decides what counts as material, and whatever it decides
without asking leaves no trace in what the human signs: the sign-off shows the
deltas and the Decision, and a guess reads there as a requirement. A cheaper
tier on the role would guess more, unseen. What makes an unasked decision
visible before anything is planned against it?

**Measured.** Nothing on the spec-writer's misses: the telemetry has not seen a
real run (BACKLOG B37). The contract had no cap on questions per round, and
every question reaches the human's chat whole. A re-invoked spec-writer is a
fresh spawn with the answers in its prompt, so a second round costs one spawn.

**Decision.**

- `spec.md` carries `## Assumptions`: each thing decided without asking and
  what changes if it is wrong, or `- none`. A missing or empty section is a
  problem — neither tells a writer that looked from one that did not. A fix
  brief (`## Case`) is exempt: it is triaged against `specs/`, not signed off
  as a new claim.
- The sign-off shows the Assumptions with the deltas. The planner and the
  reviewer treat them as binding.
- A `NEEDS_INPUT` round asks at most three questions, the ones that would
  change the deltas most. The rest become assumptions or a later round.
- Both are held at spec time only, never by the gate: a run planned before the
  section existed must not fail its milestones over it. `phase-guard` denies
  leaving `spec` while a live spec lacks its assumptions, or fails what
  spec-trace will check of it at the first gate; `resume` names the same problems before it
  asks for a sign-off.
- The number is code (`MAX_OPEN_QUESTIONS`); the contract's prose must state
  the same number, and its template must pass the same check.

**Refused.**

- No cap: a long list hands the ranking to the human, and a cheap tier asks
  wide rather than deep.
- Inferring assumptions from the proposal: it records what was asked, not what
  was not.
- Checking the section at the gate: it judges sign-off, which the gate never
  sees.

**Cost.** Every change spec gains a section, `- none` at least. Three is a
judgement; the rounds a spec takes show once runs are traced.
