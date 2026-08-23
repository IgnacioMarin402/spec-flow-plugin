# ADR-012 — an agent names a tier, not a version

**Date:** 2026-08-23 · **Status:** accepted · **Governs:** `agents/`, `scripts/model-pins.mjs`

## The question

Every agent this plugin ships named an exact model: `claude-opus-5`,
`claude-sonnet-5`, and — the one that gives the game away —
`claude-haiku-4-5-20251001`. A dated id in a file nothing reads.

Is a pinned id what these files should carry?

## The decision

**The frontmatter names a tier**: `opus`, `sonnet`, `haiku`. Claude Code
resolves an alias to the current model of that tier, so the routing decision
these files actually make — deepest / cheap-and-fast / cheapest — is what they
now state, and it stays stated as the tiers move underneath.

**The prose names the tier too, and never the number.** The routing was also
written out longhand across the agents, the commands and `REFERENCE.md`, as
"Opus 5", "Sonnet 5", "Haiku 4.5". The frontmatter is what Claude Code
obeys, but the prose is what the model reads, so a de-versioned frontmatter
under versioned prose is half a fix that reads like a whole one.

**`scripts/model-pins.mjs` holds both halves**, and it is deliberately not
only a ban. It asserts the positive fact — every agent declares a `model:` and
it is one of the four aliases — because a scanner that only forbids something
passes identically over a directory it never reached, which is this repo's own
failure mode. Finding no agents at all is a failure there.

**`decisions/` is exempt from the ban.** A record claims a moment, not a
present state (see `decisions/README.md`), and this very paragraph names
`claude-haiku-4-5-20251001` in order to say what changed. The exemption is the
same one that lets ADR-005 name four test runners.

## What was refused

- **Keeping the pinned ids for reproducibility.** ADR-004 answered the sibling
  question — Claude Code's version is recorded, not checked — because this
  project is run by someone who always uses the latest, so every claim about
  an older one would be invented. A pinned agent id is that same invented
  claim pointed the other way: it does not reproduce anything, it silently
  freezes an agent on a model that stopped being the best one for its job.
- **Dropping the tier from the prose too, leaving only the role.** Tempting,
  and it costs the `description` its most useful word: the tier is what tells
  the orchestrator what a spawn costs. It is also the exact string the
  frontmatter now carries, so prose and frontmatter agree by construction —
  a property worth more than the churn it saves.
- **Letting the contract pin a version per project.** Measured, not assumed:
  a `PreToolUse` hook rewriting a spawn's `model` accepts **only** the four
  aliases, and a full id fails schema validation as a loud tool error. Pinning
  a concrete version is therefore session-wide (`ANTHROPIC_DEFAULT_*_MODEL`)
  and not something this engine can offer per agent.

## What this leaves open

The check binds an agent's frontmatter to its own `description`, and to
nothing else. Two other places state the same routing and are bound to it by
nobody:

- an agent's BODY says its tier in the first person ("You are the **Reviewer**
  (Haiku)");
- each command restates the whole table — `commands/spec-flow.md`'s "Respect
  model routing" line and `commands/spec-fix.md`'s "Model routing holds".

The `description` was chosen because it is the one copy Claude Code shows at
the moment a spawn is chosen, and because it is a single line an exact rule
can hold. The other two are prose whose shape a check would have to guess at,
and guessing produces the check this repo dislikes most: one that looks armed.

None of it matters while the routing is fixed here. Under per-project routing
all three can go false while the frontmatter stays right, and the claim beside
the parenthetical — "you are the cheapest model in the flow" — survives any
re-routing that keeps the ordering, which is why nothing was rewritten
pre-emptively. Whoever adds routing decides all three with the routing in
front of them.
