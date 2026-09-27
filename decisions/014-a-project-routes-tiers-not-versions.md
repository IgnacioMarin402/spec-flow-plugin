# ADR-014 — a project routes tiers, and the budget counts roles

**Date:** 2026-08-23 · **Status:** accepted · **Governs:** `hooks/model-route.mjs`, `hooks/lib/routing.mjs`, `hooks/opus-budget.mjs` · **Extends:** ADR-013

**Question.** The shipped tiers are this plugin's opinion for a generic repo.
Can a project re-route an agent, and where does that live?

**Measured** (Claude Code 2.1.241, three distinct models read back from
`stream-json`): a `PreToolUse` hook's `updatedInput.model` **applies**; a full
model id is a **schema error**; an `effort` value is **silently stripped**; two
hooks on one matcher run in **parallel**, each seeing the original input; a
`deny` beats an `allow`.

**Decision.**
- A project routes in `.claude/spec-flow.config.json`, beside `max_opus_calls`
  (`{"agents": {"reviewer": "sonnet"}}`) — not in `.spec-flow/config.json`,
  which holds facts about the repo and is versioned.
- `hooks/model-route.mjs` applies it through `updatedInput`, so routing does
  not depend on the model remembering a `model` argument.
- Tiers only, the aliases single-sourced in `hooks/lib/routing.mjs`.
- A wrong routing block denies the spawn — only of this plugin's agents.
- `opus-budget` keeps charging `planner` and `architect` by role, whatever tier
  they run on: what runs away is the escalation loop, not a model.

**Refused.** `effort` in the contract (stripped without a word); full model
ids (schema error far from the file that caused it); the orchestrator passing
`model:` (the first thing to stop happening); a budget by resolved tier (the
budget would have to re-derive another hook's answer); renaming
`max_opus_calls` (nothing validates that file, so a rename silently resets a
human's cap); shadowing agents in `.claude/agents/` (duplicates the prompt).

**Cost.** Agent bodies and commands no longer name a tier, since under routing
they cannot know one; only the `description` does, held to the frontmatter by
`model-pins.mjs`.
