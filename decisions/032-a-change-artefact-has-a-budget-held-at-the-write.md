# ADR-032 — a change artefact has a budget, held at the write

**Date:** 2026-09-30 · **Status:** accepted · **Governs:** `hooks/size-on-write.mjs`, `scripts/spec-flow-config.mjs`, `agents/spec-writer.md`, `agents/planner.md`, `commands/spec-fix.md`, `REFERENCE.md` · **Extends:** ADR-026, ADR-030 · **Related:** ADR-006, ADR-029

**Question.** Nothing bounded the size of a change's artefacts. A real planner
wrote a plan of 50k characters and a milestone of 11.9k dictating fields; a
spec ran to 240 lines of which 86 bound anything (ADR-026, ADR-030). The
prompts say "light", "short", "a handful of lines", which a model honours
until it does not, and every agent downstream pays for the excess on a fresh
context. Is there a standard, and where is a limit held?

**Measured.** No standard names a maximum; the published guidance is in pages.
A product spec: one to two pages for a feature, three to six for a substantial
piece. A decision record: one or two pages. A design doc: one to three for a
small change. Amazon's narrative: six as a ceiling. At about 3,000 characters
to a page, a two-page spec is 6,000 characters, and the 86 binding lines of
the spec above were about that; the milestone that read as bloated was
three times a page.

**Decision.** `trace.budgets` in the contract names characters per artefact —
`spec` 6,000, `proposal` 8,000, `plan` 3,000, `milestone` 4,000 by default,
`0` switching one off — and `size-on-write`, a `PostToolUse` sibling of
`lint-on-write`, refuses a live artefact written over its budget, in every
run phase, on the writer, with a message that names the field and says where
the excess goes: the argument to the proposal, per-milestone detail to the
milestone, implementation out of `Steps`. The fold's status stamp is not
counted. The archive is never checked. The defaults are a page count in
disguise, not an invented number: they are the guidance above converted at a
stated rate and they bracket what real runs produced; a repository that needs
more raises them in its contract on purpose, where the change is visible.

**Refused.**
- A number in the prompts: a count written as prose drifts and nothing
  applies it (`CLAUDE.md`, ADR-029).
- Failing at the gate: it fires after the Opus spend and routes the failure
  to the implementer, who did not write the spec.
- No default, contract-only (ADR-006's rule for setup): a plausible guess is
  worse than an absent value where nothing was measured; here the value is
  published guidance plus two measured runs, and an absent budget is the
  50k plan again.
- Tokens instead of characters: the engine reads files and tokenises
  nothing; a character is what a file has.
- A hook denying reads (deferred in ADR-026): bounding what a planner may
  read leaves it guessing; bounding what it writes leaves it editing.

**Cost.** A change that genuinely needs more than its budget is either two
changes or a contract edit. A writer refused mid-edit spends one more turn
cutting, on a file still in its context.
