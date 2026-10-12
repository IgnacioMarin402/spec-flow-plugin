# ADR-041 — the Claude Code a gate line records is read from the transcript

**Date:** 2026-10-12 · **Status:** accepted · **Governs:** `hooks/gate.mjs`, `scripts/gate-fixture.mjs`, `REFERENCE.md` · **Refines:** ADR-004

**Question.** ADR-004 has every gate line record the Claude Code that ran it,
read from `CLAUDE_CODE_VERSION`. Does that variable name the build that ran?

**Measured.**

- Every gate line of two real runs, on engines `2edffe7` and `620901d`, says
  `cc=?`: the variable was not set.
- In a cloud session it said `2.1.42` while `claude --version` said `2.1.296`.
- That session's transcript stamps `version` on every user, assistant,
  attachment and system line, and its last one said `2.1.296`. Resumed across
  updates, it held `2.1.293` to `2.1.296`, in order.

**Decision.** `cc=` is the `version` of the last line of the Stop payload's
transcript that carries one; `?` when there is no transcript, it cannot be
read, or no line of it carries a version.

**Refused.**

- **The variable as a fallback.** Where it was set it named another build, and
  a wrong version reads as evidence where `?` does not.
- **`claude --version`.** One more process at every gate, answering for
  whichever `claude` is on `PATH` rather than for the process that fired the
  hook.

**Cost.** A read of the transcript's tail at every gate, widened only while no
whole line in it carries a version.
