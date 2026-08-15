# ADR-004 — Node is a floor and is enforced; Claude Code is recorded

**Date:** 2026-08-15 · **Status:** accepted · **Record:** `0676b37`

## The question

Two versions decide whether this engine runs correctly: the Node it executes
under, and the Claude Code hosting it. Should either be enforced?

## The decision

**Node: a floor, enforced.** `package.json`'s `engines.node` is the single
declaration, and `preflight` refuses a run below it before any agent is spent.
Major version only, and only when both parse — a floor the engine cannot
compare against confidently is not worth denying a run over. Inside a run
only: a subagent in a repo that never adopted this engine is never denied over
a floor only this engine declares.

**Claude Code: recorded, not checked.** `CLAUDE_CODE_VERSION` is written into
every gate-history line as `cc=`, or `cc=?` where the harness does not expose
it.

A check was possible — the variable exists. It was refused because declaring a
supported range means having evidence about versions outside it, and this
project has been run by someone who always uses the latest. Every claim about
an older Claude Code would be invented, and **an invented floor denies real
runs.** What the engine can honestly do is start collecting the fact, so the
first version-dependent failure arrives with the version already in the
record.

## What was refused

- **A compatibility table for Claude Code.** It would be fiction, and fiction
  that blocks work.
- **Re-adding a plugin version to express compatibility.** See ADR-003 for why
  that field cannot come back.
