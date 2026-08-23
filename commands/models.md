---
description: Show which model tier each spec-flow agent will run on in this repo, and which layer decided it. Optionally set or clear one agent's tier.
argument-hint: "[<agent> <tier> | <agent> default]"
---

Run:

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/model-routing.mjs
```

Show its output to the human as it came out. **Do not re-derive any of it.** The
whole point of that script is that three layers decide an agent's model and no
single file shows more than one of them — the tier its frontmatter ships, the
project's override in `.claude/spec-flow.config.json`, and what
`ANTHROPIC_DEFAULT_<TIER>_MODEL` pins that tier to. Reading one and concluding
is how you get a confident wrong answer, which is the thing the report exists
to prevent. If it exits non-zero the routing block is unusable and every
spec-flow spawn is being denied; relay what it says and stop.

## With arguments

**$ARGUMENTS** is empty for the report above. Otherwise it is `<agent> <tier>`
or `<agent> default`, and you edit `.claude/spec-flow.config.json` in the
consuming repo:

- `<agent> <tier>` — set `agents.<agent>` to that tier. Create the file, or the
  `agents` object, if either is missing; leave every other key alone,
  `max_opus_calls` included.
- `<agent> default` — delete that agent's entry, falling back to what the
  plugin ships. Delete the `agents` object too if it ends up empty, rather than
  leaving `{}` behind.

Then run the script again and show the new report. That second run is the
confirmation — it reads the file back through the same code the spawn hook
uses, so "I wrote it" and "it applies" are the same statement rather than two.

Expect the edit to ask the human for approval: `.claude/` is a protected
directory, and a write there prompts even when file edits are otherwise
accepted. That is the harness, not a misconfiguration — say so rather than
looking for a way around it, and never reach for a permission bypass to
land a preference. In a non-interactive session where no one can approve,
report the exact change you would have made and stop.

Do not guess an agent name or a tier. The report lists every valid agent, and a
tier is one of `opus`, `sonnet`, `haiku`, `fable`. A **model id is never valid
here** — a spawn accepts only a tier, and pinning a concrete version is Claude
Code's own `ANTHROPIC_DEFAULT_<TIER>_MODEL` setting, per session rather than
per agent. If the human asks for a version, say that and offer the settings
entry instead of writing something this contract will refuse.
