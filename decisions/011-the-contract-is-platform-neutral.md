# ADR-011 — the contract is platform-neutral, the engine is POSIX

**Date:** 2026-08-22 · **Status:** accepted (CI half superseded by ADR-019) · **Governs:** `scripts/argv.mjs`, `scripts/init.mjs` · **Narrows:** ADR-007

**Question.** A review said Windows was broken because `spawnSync` runs `npm`
without a shell. `init` never writes `npm`, but running it found worse:
`['node', 'node_modules/.bin/eslint']` is a symlink to JavaScript on POSIX and a
`#!/bin/sh` shim on Windows (`SyntaxError`), and `path.join` wrote the
machine's separator into a committed contract.

**Decision.** The contract is platform-neutral: `resolveLocalBin` resolves past
the shim to the package's real entrypoint and returns a repo-relative `/` path,
so both platforms write `node_modules/eslint/bin/eslint.js`. The argv shape is
unchanged. The engine's supported platform is POSIX, declared and not enforced.

**Refused.**
- `shell: true` at the spawn sites: quoting differs per platform, and the gate
  appends changed file paths to `verify.lint`.
- A `windows-latest` CI leg: argued blind to this defect class. (Reversed by
  ADR-019, where a leg failed on first contact.)
- Guessing when a bin has no JavaScript behind it: keep the bare command name.
