# Decisions

One file per decision that spans more than one file — the question it
answered, what was chosen, and what was refused and why.

**These record a moment, not a present state**, and that distinction is why
this directory is allowed to exist in a repo that deleted its last standalone
document. `.spec-flow/skills.md` claimed "these are the skills", which the
present falsified silently and nothing checked. "On this date, for these
reasons, we chose X" stays true even after X is reversed — a reversal writes a
new record superseding the old one rather than editing it.

**Every record is cited from the code it governs** (`see ADR-004`), and
`scripts/decisions.mjs` fails when a citation does not resolve or a record is
cited by nothing. A decision nobody can reach from the code will not be found
at the moment someone is about to undo it.

Prose describing how the code works today does not belong here. That is what
the code and the invariants beside it are for — see
`.claude/skills/engine-comments`.
