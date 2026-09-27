# ADR-003 — the plugin declares no `version`

**Date:** 2026-08-14 · **Status:** accepted · **Record:** `8fe3b8a`

**Question.** `plugin.json` and the marketplace entry both declared `0.1.0`,
unchanged through nine PRs of behaviour change.

**Decision.** Omit `version` from both. Claude Code decides whether an update
exists from `plugin.json`'s `version`, then the marketplace entry's, then the
git SHA. With both pinned, every push was invisible to `/plugin marketplace
update`. The SHA changes on every commit and needs nobody to remember anything.
Confirmed on a real install (2026-08-16): `claude plugin list` reported the
merge commit, not a number.

**Refused.** Bumping the number: the fix is removing the field that needs the
discipline, not more of a discipline that already failed. `marketplace.json`'s
top-level `version` (the catalog's own) is untouched.
