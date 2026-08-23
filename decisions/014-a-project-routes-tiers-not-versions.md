# ADR-014 — a project routes tiers, and the budget counts roles

**Date:** 2026-08-23 · **Status:** accepted · **Governs:** `hooks/model-route.mjs`, `hooks/lib/routing.mjs`, `hooks/opus-budget.mjs` · **Extends:** ADR-013

## The question

ADR-013 made every agent name a tier instead of a version. The tiers it names
are still this plugin's opinion, chosen for a generic repo: the reviewer is
cheapest because a checklist pass usually is, the planner is deepest because a
milestone map usually earns it. A project with a different cost ceiling, or a
harder domain, has no way to say so.

Can a consuming project re-route an agent, and where does that live?

## What was measured first

The design turns on what a `PreToolUse` hook can actually change about a
spawn, so it was run before it was designed — Claude Code 2.1.241, a throwaway
fixture with three distinct models (session `haiku`, agent frontmatter
`sonnet`, hook override `opus`) read back from `--output-format stream-json`:

| | |
|---|---|
| `hookSpecificOutput.updatedInput` with a `model` | **applies** — the subagent ran on the rewritten tier |
| a full model id in that field | **schema error**, loud, on the tool call |
| an `effort` value | **silently stripped**, exactly like an invented key |
| two hooks on one matcher | run in **parallel**, each handed the ORIGINAL input |
| `deny` from one, `allow` + `updatedInput` from another | **deny wins** |

The third row decided more than the others. `effort` is a real frontmatter
field, and a contract offering it would have validated, written, transmitted
and done nothing — a knob that reads as armed and is not, which is the one
failure this engine exists to close. It is refused below on evidence rather
than on taste.

## The decision

**A project routes in `.claude/spec-flow.config.json`**, beside
`max_opus_calls`:

```json
{ "max_opus_calls": 6, "agents": { "reviewer": "sonnet" } }
```

Not `.spec-flow/config.json`: that file holds architectural facts about the
repo — its linter, its test command, its layers — and a preference about what
a pass should cost is not one. It is also versioned, so a cost knob there
would move `contract_version` for every adopter.

**A hook applies it, not the orchestrator.** `hooks/model-route.mjs` rewrites
the spawn through `updatedInput`, so routing does not depend on the model
remembering to pass a `model` argument on a turn where it is busy. It emits no
`permissionDecision`: `updatedInput` is honoured on its own, and a hook that
exists to pick a model has no business answering the permission question.

**Tier only.** The four aliases, single-sourced in `hooks/lib/routing.mjs` and
imported by `scripts/model-pins.mjs` so the contract cannot be accepted in one
place and refused in the other. Pinning a concrete version stays session-wide
through `ANTHROPIC_DEFAULT_*_MODEL`, which is the harness's mechanism and not
this engine's to wrap.

**A wrong routing block denies the spawn**, naming what is wrong and the
agents that exist. A typo'd agent name is the miniature of this repo's whole
subject: the config reads as though it routes something and routes nothing,
forever. The denial only ever reaches a spawn of THIS plugin's agents, so a
broken block cannot block unrelated work in a repo that merely has the plugin
installed — the same line ADR-004 draws for the Node floor.

**The budget keeps counting roles.** `opus-budget` charges `planner` and
`architect` by name, whatever tier they are routed to.

## What was refused

- **`effort` in the contract.** Measured above: dropped without a word.
  Per-agent effort is settable only in the shipped frontmatter; a project's
  ceiling is `effortLevel` in its own settings, which is session-wide.
- **A full model id per agent.** Measured above: a schema error at the spawn,
  which would put the failure a long way from the file that caused it.
- **The orchestrator passing `model:` on each spawn.** It is the cheapest
  thing to build and the first thing to stop happening.
- **A budget that charges the RESOLVED tier.** It was the obvious reading of
  "the Opus budget should follow the Opus model", and running the question
  down moved it. What runs away in this flow is the escalation LOOP —
  implementer stuck, architect consulted, plan revised, round again — and that
  loop is bounded by how often the deep roles are consulted, at any tier. An
  implementer a project deliberately routes to `opus` runs once per milestone,
  bounded by the plan, and is not the thing the cap was ever protecting
  against. Charging by tier would also have made the budget read the routing,
  which the parallel-hooks result says it cannot do from the payload: it would
  have to re-derive it, and a budget that re-derives a value another hook
  applies is two answers waiting to disagree.
- **Renaming `max_opus_calls`.** The name now describes a proxy, and nothing
  validates that file — so a rename would read a repo's configured cap as
  absent and hand it the default instead. A silent change to the one number a
  human set deliberately is worse than an inaccurate key. The messages the cap
  prints were de-coupled from the model name instead, because those a human
  reads.
- **Shadowing the agent in the project's own `.claude/agents/`.** It works for
  a top-level agent and duplicates the entire prompt body to change one line,
  which then rots against the shipped one. A plugin agent also registers under
  a scoped name, so the shadowing is not the clean override it looks like.

## The cost

The routing is now stated in four places that no single check binds together:
the frontmatter, the agent's `description`, the agent's body, and the line
each command restates. ADR-013 left the last two open for whoever added
routing. They were resolved by DELETING the claim rather than checking it —
the bodies and the command steps no longer name a tier at all, because under
routing they cannot know one, and the role words they already used ("the
cheapest model in the flow", "the architect") say what the prompt actually
needs. Only the `description` still names a tier, it names the shipped default,
and `model-pins.mjs` holds it to the frontmatter.
