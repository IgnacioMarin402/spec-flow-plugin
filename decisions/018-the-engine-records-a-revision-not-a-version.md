# ADR-018 — the engine records a revision, not a version

**Date:** 2026-08-23 · **Status:** accepted · **Governs:** `scripts/engine-revision.mjs`, `hooks/gate.mjs`, `scripts/gate-fixture.mjs` · **Extends:** ADR-003, ADR-016

**Question.** Every gate-history line carries `engine=`, read from
`package.json`'s `version`. What is it for, and can it do it?

**Measured.** The version moved once, at extraction, so every gate since
recorded `engine=0.1.0`. Its stated reason — exposing drift between the plugin
and a version-ranged dependency — ended with ADR-016. Only the plugin copy
writes history lines, and the npm copy has no `.git` (its commit survives only
in the consuming repo's lockfile).

**Decision.** `engine=` records the commit of the copy that ran:
`git rev-parse --short=12 HEAD` in the engine's own directory, falling back to
the package version prefixed with `v` so a fallback is never mistaken for a
revision. Recorded, never checked, like `cc=` (ADR-004). `gate-fixture.mjs`
asserts two engine commits produce two different values.

**Refused.** A `prepare` script stamping a revision at install (machinery for a
copy that writes no history); bumping `version` per release (ADR-003); recording
both (a meaningless number next to a meaningful one).
