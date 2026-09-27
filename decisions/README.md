# Decisions

One record per decision that spans files: the question, what was chosen, and
what was refused.

A record claims a moment — "on this date, for these reasons, we chose X" — so
it stays true after X is reversed; a reversal writes a new record. Every record
is cited from the code it governs (`see ADR-004`), and `scripts/decisions.mjs`
fails when a citation does not resolve or a record is cited by nothing.

How the code works today does not go here; that is what the code and the
invariants beside it are for (`.claude/skills/engine-comments`).
