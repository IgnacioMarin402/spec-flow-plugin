# ADR-013 — an agent names a tier, not a version

**Date:** 2026-08-23 · **Status:** accepted · **Governs:** `agents/`, `scripts/model-pins.mjs`

**Question.** Every shipped agent named an exact, dated model id. Is a pinned
id what these files should carry?

**Decision.** The frontmatter names a tier — `opus`, `sonnet`, `haiku` — which
Claude Code resolves to the current model of that tier, so the routing decision
stays true as the tiers move. The prose names the tier too, never a number.
`scripts/model-pins.mjs` asserts the positive fact (every agent declares a
`model:` and it is one of the aliases), since a ban alone passes over a
directory it never reached. `decisions/` is exempt: a record names what
changed.

**Refused.**
- Pinned ids for reproducibility: they reproduce nothing and freeze an agent on
  a model that stopped being the best for its job (the sibling of ADR-004).
- Dropping the tier from prose: the description's tier is what tells the
  orchestrator what a spawn costs.
- Per-project version pins: a `PreToolUse` hook rewriting `model` accepts only
  the aliases; a full id is a schema error. Version pinning stays session-wide
  (`ANTHROPIC_DEFAULT_*_MODEL`).
