# ADR-015 — effort is declared where the role is emphatic, and inherited on purpose everywhere else

**Date:** 2026-08-23 · **Status:** accepted · **Governs:** `agents/`, `scripts/model-pins.mjs`, `scripts/model-routing.mjs` · **Extends:** ADR-014

**Question.** No agent declared `effort`, so each inherited the human's session
setting: the reviewer — the cheapest pass by design — ran at `max` whenever the
session did, and a `low` session planned at `low`.

**Measured.** Effort cannot be routed: a hook patching `effort`, `effortLevel`,
`thinking`, `maxTurns` and `isolation` with invalid values got exactly one
rejection, `isolation` — the only key the schema knows — so the rest are
dropped silently. The frontmatter field is weaker evidence: `low` vs `max` on
the same agent roughly doubled session cost ($0.046 → $0.091), consistent with
it working, not proof.

**Decision.** `reviewer: low`; `planner: high`; `architect: high`;
`implementer` and `spec-writer` inherit (the milestone decides the work; the
spec-writer asks a human rather than thinking harder). `model-pins.mjs` fails an
agent that neither declares effort nor is listed in `INHERITS_EFFORT` with a
reason, and fails a misspelled level, which a spawn would otherwise discard.
`spec-flow models` shows each row's source.

**Refused.** Declaring all five (an invented value is worse than an honest
gap); leaving all five inheriting (nobody chose that); an `effort` key in the
contract (measured impossible); effort variants of each agent file (forks the
prompts, which are the product).

**Cost.** A project cannot set effort per agent; its only lever is
`effortLevel` in its own settings, and the report says so.
