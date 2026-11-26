# ADR-057 — the orchestrator runs on the person's model

**Date:** 2026-11-26 · **Status:** accepted · **Governs:** `commands/spec-flow.md`, `commands/spec-fix.md` · **Related:** ADR-029, ADR-038

**Question.** The orchestrator is the person's own session (ADR-029), so it
runs on whatever model they chose, while every agent runs on the tier its
frontmatter names. Should the commands pin the orchestrator's model too?

**Measured.** Six headless `/spec-flow` runs on `27c3b65`, one requirement
(removing an item) on the eval cart repo, the sign-off answered with a canned
approval: three with the session on Opus, three on Sonnet. All six reached
`done`, archived `SHIPPED` and left `spec-flow check` green. Run totals as
Claude Code counts them: US$1.89, 1.22 and 1.19 on Opus; US$0.93, 0.78 and
0.82 on Sonnet. The orchestrator's share, estimated from its tokens: 63–68%
on Opus, 49–50% on Sonnet.

**Decision.** No pin. The commands leave the orchestrator on the person's
model; chosen by the maintainer with these runs in hand.

**Refused.**

- Pinning Sonnet in each command's frontmatter: about 40% off a run of this
  size, with the same outcome in these six.
- Measuring a harder run first (several milestones, a re-plan from review)
  before deciding.
