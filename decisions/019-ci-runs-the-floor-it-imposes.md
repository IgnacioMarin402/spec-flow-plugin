# ADR-019 — CI runs the floor it imposes, on the platform it disclaims

**Date:** 2026-08-23 · **Status:** accepted; the floor moved to Node 22 in `ff1d075` (Node 20 reached end of life on 2026-04-30), so the matrix is `[22, 24]` — the rule is unchanged · **Governs:** `.github/workflows/ci.yml`, `package.json`, `README.md` · **Supersedes the CI half of:** ADR-011

**Question.** CI ran one job, Ubuntu on Node 22. `engines.node` declared `>=20`
and `preflight` denies a run below it, so the floor enforced on others had never
run here. The README hedged that Windows was "untested", and ADR-011 had refused
a Windows leg as unable to fail.

**Measured.** The Windows leg failed on first contact: `node --test
test/*.test.mjs` reaches node as a literal glob under `cmd.exe`, and it only
passed elsewhere because node itself expands globs after the declared floor.
The repo had also passed 20 of 20 checks on Windows 11 / Node 24 by hand — a
fact only prose carried.

**Decision.** Matrix `[20, 22, 24] × [ubuntu-latest, windows-latest]`,
`fail-fast: false` (one red cell is a portability fact; cancelling the rest
discards the comparison). `unit:check` becomes `node --test` with no path
argument. The README states what is exercised instead of hedging. The first
Node entry is the floor `engines.node` declares; nothing binds the two.

**Refused.** `macos-latest` (differs from Linux on none of the axes this engine
touches); forcing `shell: bash` (CI would pass where a Windows developer's
`npm run` fails); reading ADR-011 as wrong (it was right about the shim it
examined).
