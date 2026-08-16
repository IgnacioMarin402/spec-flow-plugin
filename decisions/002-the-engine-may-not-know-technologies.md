# ADR-002 — the engine may not know technologies; `init` may, and still does not generate

**Date:** 2026-08-15 · **Status:** accepted · **Record:** `021b71d`

## The question

ADR-001 left `trace.executed_tests` as the one field nothing in a repo
declares, so `spec-flow init` could not produce a working contract for
anybody. The obvious fix is for `init` to detect the runner and generate a
translator for it. Should it?

## The decision

No. `init` scaffolds `.spec-flow/tests-that-ran.mjs` with the contract written
into it and one marked hole that refuses loudly until filled. It does not
generate runner-specific code.

**Configuring how a repo reports the tests it ran is the adopting project's
responsibility**, the same as declaring its linter or its base branch. The
engine's job ends at asking for it clearly.

The distinction that survives from the weaker version of this argument: a
*generator* may know technologies, because its job is reading what a repo
already declares about itself and a wrong guess is reported as `REVIEW`. A
*checker* may not, because it has to be right about repos nobody has seen.
`init` sits on the generator side — and still stops here, because the cost of
going further is not a generator's knowledge but a stack list shipped inside
the package.

## What was refused

- **A `templates/` directory outside the coupling scan**, holding one
  translator per runner, selected by matching the `test_name` `init` already
  reads. No runner name would appear in a scanned file. Refused because
  `no-repo-refs.mjs` argues that no exemption list exists, and this creates
  the thing that text says does not.
- **Relaxing the ban for `init` alone.** A runner list rots, and it is
  precisely the artifact that looks maintained and quietly is not.

The cost of refusing both: an adopter writes four lines, once, into a file
that already tells them what to write.
