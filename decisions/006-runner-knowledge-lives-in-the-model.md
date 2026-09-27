# ADR-006 — runner knowledge lives in the model, and support has two declared tiers

**Date:** 2026-08-16 · **Status:** accepted · **Extends:** ADR-002, ADR-005

**Question.** `init` reads `package.json` and nothing else, so the checker
reaches further than the onboarding. Bug, scope, or a gap with an owner?

**Measured.** Three repos through the documented install: npm with conventional
scripts leaves **0** `MISSING` (only the reporter flag); npm with scripts run
through an interpreter leaves 4; a repo that is not an npm package leaves 9 —
effectively the whole contract.

**Decision.** Two declared tiers. **Detected**: the manifest declares the
commands, `init` writes a valid contract, a human confirms the `REVIEW` lines.
**Assembled**: everything else; `init` reports what it could not read and a
skill shipped with the plugin fills the rest. The runner knowledge that tier
needs lives in the model, not in this package: ADR-002's objection was to a
*file* that rots, and a model's knowledge is not a file here. Checked, not
promised: `skills/` is in `no-repo-refs.mjs`, so a skill that starts listing
flags turns CI red.

**Refused.**
- Teaching `init` to read `pyproject.toml`, `go.mod`, `Cargo.toml`: a list with
  no end and no owner; the skill covers every manifest at once.
- Narrowing the engine to Node-only: the adopter's contract would not lose a
  field, and it would cost ADR-001, ADR-005 and the report readers.
  (Reversed by ADR-007.)
- A `SessionStart` notice offering setup when no contract exists: true in nearly
  every repo the user opens, so it is an advertisement everywhere.

**Cost.** A skill's judgement cannot be fixture-tested. Its last step is
`check-changed`, which fails when the report does not land, so it can be wrong
but not quietly.
