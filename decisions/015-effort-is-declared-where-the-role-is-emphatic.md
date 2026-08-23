# ADR-015 — effort is declared where the role is emphatic, and inherited on purpose everywhere else

**Date:** 2026-08-23 · **Status:** accepted · **Governs:** `agents/`, `scripts/model-pins.mjs`, `scripts/model-routing.mjs` · **Extends:** ADR-014

## The question

ADR-013 and ADR-014 made the MODEL each agent runs on deliberate: a tier in the
frontmatter, an optional project override, a hook that applies it. The second
axis was never decided at all. No agent declared `effort`, so every one of them
inherited whatever the human's session was set to.

That is not a neutral default. The reviewer's own prompt says it is the
cheapest pass in the flow, a checklist with an escape hatch — and it was
running at `max` whenever someone's session was, thinking hard about a task
whose whole design is that it should not. In the other direction a session at
`low` planned milestones at `low`. The tier said one thing and the effort said
whatever was lying around.

## What was measured

**Effort cannot be routed.** A `PreToolUse` hook was handed a spawn patched
with `effort`, `effortLevel`, `thinking`, `maxTurns` and `isolation`, every one
of them holding a deliberately invalid value. The schema rejected exactly one —
`isolation`, the only key on that list it knows. The other four were discarded
without a word. That is the positive control ADR-014's `effort` finding was
missing: the schema is a real allowlist that complains about bad values for
keys it has, so silence about `effort` means the key is not there.

**The frontmatter field is weaker evidence, and that is worth saying.** Running
the same agent, same model, same prompt at `effort: low` and `effort: max`
roughly doubled session cost ($0.046 → $0.091). Consistent with the field
working, and not proof: the subagent's own token usage is not exposed
separately in the stream, so the main session's variance is inside that number.
Everything below rests on a documented field plus a suggestive measurement,
which is a weaker footing than the model routing has, and no check here can
close the gap.

## The decision

**Declared where the role is emphatic about its own cost, inherited where it
is not.**

| agent | effort | why |
|---|---|---|
| `reviewer` | `low` | its prompt already says it is the cheapest pass, with escalation as the escape hatch rather than thinking harder |
| `planner` | `high` | consulted to produce the artifact every later pass is judged against |
| `architect` | `high` | reached only when a cheaper agent already failed to decide safely |
| `implementer` | inherits | the milestone decides the work, and its difficulty is the plan's claim rather than the frontmatter's |
| `spec-writer` | inherits | it asks a human when unsure instead of thinking harder alone |

**The asymmetry is enforced as a decision.** `model-pins.mjs` fails when an
agent declares no effort and is not listed in its `INHERITS_EFFORT` map with a
reason, and fails when an agent is in both. Same shape as
`agent-contracts.mjs`'s `NOT_REVIEWED`, and for the same reason this repo keeps
writing that shape: two of five agents having no effort is either a decision or
the thing nobody got to, and from the frontmatter alone those look identical.

**A misspelled level fails here or nowhere.** A spawn discards an effort it
cannot read, so `effort: hihg` is a setting that reads as applied and is not —
this engine's signature failure, in a field the engine cannot otherwise reach.
`model-pins` validates it against the level list, which lives in
`hooks/lib/routing.mjs` beside `ALIASES` with a warning that nothing applies it.

**`spec-flow models` reports it**, marking each row `(agent)` or `(session)`,
because an effort nobody can see is how this started.

## What was refused

- **Declaring effort on all five.** Two of them have no opinion worth
  overriding a human's with. A value invented to fill a column is exactly the
  "plausible guess is worse than the honest gap" rule this repo applies to
  contract fields, and a preference is not exempt from it.
- **Leaving all five inheriting.** That was the state, and it was not a choice
  anyone made.
- **An `effort` key in the project contract.** Measured impossible above. It
  would have validated, written, transmitted and done nothing.
- **Shipping effort variants of each agent** — `planner-low.md`,
  `planner-high.md` — with the routing hook rewriting `subagent_type` instead
  of `model`. This WOULD give a project per-agent effort, and it is the reason
  the option was taken seriously: `updatedInput` can rewrite any key the schema
  knows, and `subagent_type` is one. It was refused because an agent file is
  its prompt: five bodies times each level, duplicated, drifting apart the
  first time one of them is edited. The prompts are the product here, and
  nothing is worth forking them for.

## The cost

A project cannot set effort per agent. Its only lever is `effortLevel` in its
own settings, which moves every agent that inherits and none that declare. That
is a real limitation of the harness rather than a gap in this engine, and the
report says so on every run rather than leaving someone to discover it by
writing a key that does nothing.
