# ADR-004 — Node is a floor and is enforced; Claude Code is recorded

**Date:** 2026-08-15 · **Status:** accepted · **Record:** `e7b6afa`

**Question.** The Node running the engine and the Claude Code hosting it both
decide whether it works. Should either be enforced?

**Decision.**
- **Node: a floor, enforced.** `package.json`'s `engines.node` is the single
  declaration, and `preflight` refuses a run below it before any agent is
  spent. Major version only, only when both parse, and only inside a run — a
  repo that never adopted the engine is never denied over it.
- **Claude Code: recorded, not checked.** Every gate-history line carries
  `cc=<CLAUDE_CODE_VERSION>`, or `cc=?`. A supported range needs evidence about
  versions outside it, and the only user runs the latest: any floor would be
  invented, and an invented floor denies real runs. Recording it means the first
  version-dependent failure arrives with the version attached.

**Refused.** A Claude Code compatibility table (fiction that blocks work), and
re-adding a plugin version to carry compatibility (ADR-003).
