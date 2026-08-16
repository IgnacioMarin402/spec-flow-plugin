# ADR-006 — runner knowledge lives in the model, and support has two declared tiers

**Date:** 2026-08-16 · **Status:** accepted · **Extends:** ADR-002, ADR-005

## The question

`init` reads `package.json` and nothing else. That is ADR-002 being consistent
— a `scripts.test` field is a repo declaring its own commands, while reading
`[tool.ruff]` and concluding "the linter is ruff" is knowing a technology — but
it means the generator's reach and the checker's reach are not the same, and
nobody had written that down.

Asked plainly: the engine checks any language, and its onboarding only reads
one manifest. Is that a bug, a scope, or a gap with an owner?

## What was measured before deciding

Three repos, each taken through the documented install route, counting what
`init` leaves for a human:

| Repo | `MISSING` | What is left by hand |
|---|---|---|
| npm, conventional scripts | **0** | the reporter flag |
| npm, scripts running through an interpreter | 4 | two names, a hint, the globs, and the flag |
| not an npm package | **9 fields** | effectively the whole contract |

The first row is the one that reframes it. For a repo whose manifest declares
its commands, the contract is already valid when `init` exits — the entire
remaining cost is the reporter flag. The third row is not a worse version of
the same problem, it is a different one: nothing was read, so nothing was
proposed.

## The decision

**Two tiers, declared rather than emergent.**

1. **Detected** — a repo whose manifest declares its commands. `init` writes a
   valid contract; a human confirms the `REVIEW` lines.
2. **Assembled** — every other repo. `init` reports what it could not read, and
   a skill shipped with the plugin fills those fields and the reporter flag.

**The runner knowledge that tier 2 needs lives in the model, not in this
package.** No file here names a runner or a flag; the skill states the
procedure and what must be proven, and the model supplies what it knows about
the repo in front of it.

That is the distinction ADR-002 could not reach. It refused a `templates/`
directory of per-runner translators because "a runner list rots, and it is
precisely the artifact that looks maintained and quietly is not" — an argument
about a **file in the package**, which is why it survived ADR-005 and survives
this. A model's knowledge is not that file. It cannot go stale in this repo
because it is not in this repo, and it needs no exemption from the coupling
scan because there is nothing to exempt.

**Checked, not promised.** `skills/` was added to `no-repo-refs.mjs` at the
same time as the skill itself, so the claim "no runner is named in the package"
is a check that fails rather than a sentence in a decision record. A skill that
starts listing flags turns CI red on the first one. `plugin-paths.mjs` and
`decisions.mjs` got the same directory for the same reason: a shipped skill is
instruction a model acts on, and every property those two hold over a command
is a property it needs too.

## What was refused

- **Teaching `init` to read `pyproject.toml`, `go.mod`, `Cargo.toml`.** It sits
  on the generator side, so it *may* know technologies — ADR-002 says so. What
  stops it is that the list has no end and no owner: each manifest is a branch
  that only pays off for repos that have it, and the ones that do not are back
  to tier 2 anyway. The skill covers every manifest at once, including the ones
  written after this commit.
- **Narrowing the engine to Node-only.** The strongest argument for it is that
  `init` could then ship the reporter flag and tier 2 would not exist. It was
  refused because the contract an adopter fills does not lose a single field —
  a Node repo still declares a lint command, a test command, a report path and
  a format — so the trade buys one flag and costs ADR-001, ADR-005,
  `cold-start.mjs`, both report readers and half of `no-repo-refs.mjs`'s
  argument. The skill buys that same flag for every language without the list.
  ADR-001 records what Node-only looked like when it was accidental: a genuine,
  executed pytest proof read as "has no test", and no milestone in a non-JS
  repo could pass.
- **A `SessionStart` notice offering setup when no contract is present.** The
  plugin is installed once and sessions open in arbitrary repos, so the
  condition "this repo has no `.spec-flow/config.json`" is true of nearly every
  repo the user will ever open. That is an advertisement in all of them, and it
  is the shape of the `preflight` defect in `CLAUDE.md`: a hook armed on a
  condition broader than the thing it was written for.

## The cost, and what is not checked

A skill's judgement cannot be fixture-tested. CI runs Node with no model in it,
so nothing here proves the skill picks the right flag — and pretending
otherwise would be this engine's own failure mode, a check that looks armed and
is not.

What is checked instead, and what makes the gap survivable: the skill's last
step is `check-changed`, which runs the suite, confirms the report landed where
the contract says, and binds the requirements — outside the model, exit code as
the verdict. A wrong flag does not produce a repo that looks configured; it
produces a red check naming the missing report. The skill can be wrong. It
cannot be wrong quietly.
