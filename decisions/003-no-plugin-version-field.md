# ADR-003 — the plugin declares no `version`

**Date:** 2026-08-14 · **Status:** accepted · **Record:** `8fe3b8a`

## The question

`plugin.json` and the marketplace entry both declared `"version": "0.1.0"`,
unchanged since the first commit through nine PRs of real behaviour change.

## The decision

Omit `version` from both files.

Claude Code resolves a plugin's version — to decide whether an update exists —
from the first of `plugin.json`'s `version`, the marketplace entry's
`version`, or the git commit SHA. With both pinned, `0.1.0` compared against
`0.1.0` is always equal, so every push was invisible to `/plugin marketplace
update`: an install would run the command and be told there was nothing new.

Falling through to the SHA changes on every commit by construction and needs
nobody to remember anything.

## What was refused

**Bumping the number.** The fix is not a discipline that has already failed
once; it is removing the field that requires it.

`marketplace.json`'s own top-level `version` — the catalog's, not the
plugin's — is untouched. A different field in the same resolution chain has no
claim on it.

## Related

ADR-004 records where a compatibility statement lives instead, now that no
version field exists to carry one.
