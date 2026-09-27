# ADR-012 — a dirty tree wakes the run when nothing has judged the commit

**Date:** 2026-08-23 · **Status:** accepted · **Governs:** `hooks/gate.mjs` · **Supersedes:** the earlier rule that `skip-dirty` stays completely silent

**Question.** The gate skips a dirty tree (a background implementer may be
mid-write) and allows the stop silently; ten skips in a row wake the run once.
What if the tenth stop never comes?

**Measured.** A real run folded, committed and ended its turn: `pass`, then one
`skip-dirty` on the new commit, then twelve minutes of nothing until a human
asked. The skip allowed the stop, an idle session fires no further Stop, and
the counter waited for events that had stopped. The dirt was the fold's
SHIPPED stamp, left out because `git mv` stages the pre-edit blob; spec-trace
on that commit fails.

**Decision.** On a dirty tree, if no `gate-history.log` line names the current
short sha, block once and say which of the two situations this is. While an
implementer writes, HEAD is a commit a gate already judged; in the stall,
HEAD is one nothing ever judged. The `skip-dirty` line just written makes later
stops on that commit silent again. A sha of `-` (git failed) does not wake.

**Cost.** Replayed on 40 real history lines: once or twice per run, one of them
a false positive at run start, answered in one turn.

**Refused.** Lowering `MAX_DIRTY_SKIPS` (the streak was one; waking on every
skip is noise), deciding from which paths are dirty (a guess), and detecting
whether a subagent is still live (nothing in reach knows).
