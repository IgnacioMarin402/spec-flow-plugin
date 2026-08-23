# ADR-019 — CI runs the floor it imposes, on the platform it disclaims

**Date:** 2026-08-23 · **Status:** accepted · **Governs:** `.github/workflows/ci.yml`, `package.json`, `README.md` · **Supersedes the CI half of:** ADR-011

## The question

CI ran one job: `ubuntu-latest`, `node-version: 22`. Two claims this repo makes
were never executed by it.

`package.json` declares `engines.node: ">=20"` and `preflight` **denies a run**
below that floor. Twenty is the number the engine enforces against other
people, and it was the one version nothing here had ever run.

`README.md` asks for "a POSIX machine — macOS or Linux", adding that Windows is
untested rather than unsupported. ADR-011 refused a `windows-latest` leg on a
specific argument: it "would be green today… A leg that cannot fail is not a
guard."

## What was measured

**The Windows leg can fail.** Adding it surfaced a defect in the first check it
would run. `unit:check` was `node --test test/*.test.mjs`, and nothing in that
line expands the glob on Windows — npm's `script-shell` is unset, so npm uses
its platform default, `cmd.exe`, which passes the pattern through untouched:

```
> cmd /c "node -p ""JSON.stringify(process.argv.slice(1))"" test/*.test.mjs"
["test/*.test.mjs"]
```

The suite passes on this machine because **node** expands it — glob support in
`--test` arrived after the declared floor, not because the command is portable.
So the alias worked on exactly the cells the old matrix contained, and the two
it did not contain are where it stops.

That is the counter-evidence ADR-011's refusal asked for and could not have
had: its subject was the `node_modules/.bin` shim, which `cold-start` genuinely
cannot reach. The leg is not blind — it was pointed at one thing.

**And the same repo passed 20 of 20 checks on Windows 11 / Node 24** before any
of this, which is what makes the README's hedge the wrong shape: the fact
existed and only prose carried it.

## The decision

**`[20, 22, 24] × [ubuntu-latest, windows-latest]`, `fail-fast: false`.** Six
cells. The floor gets executed, and the platform the README hedges about
becomes a measurement instead of a sentence.

`fail-fast` off because the interesting failures here are per-cell: one red
cell out of six is a portability fact, and cancelling the other five discards
exactly the comparison that identifies it.

**`unit:check` becomes `node --test`, with no path argument.** Discovery has no
shell seam, so it means one thing on all six cells. Every other spelling
depends on something the matrix now varies.

**The README stops apologising.** "A POSIX machine — macOS or Linux… not what
CI exercises" is replaced by what is true after this: Linux and Windows are
both exercised on three Node versions, macOS is not, and the engine has no
platform check.

## What was refused

**`macos-latest`.** Nothing here is macOS-specific that Linux does not already
cover — the two differ from Windows on the axes this engine touches (path
separators, the `.bin` shim, `spawnSync` resolution) and not from each other.
It is a third of the matrix again for a difference nobody has produced a defect
from. The README says so rather than implying macOS is covered.

**Keeping the glob and forcing `shell: bash` in the workflow.** One line, and
it works — by making CI use a shell a Windows developer's `npm run` does not.
The alias would stay broken for them while the leg meant to catch it reports
green, which is this engine's signature failure wearing a workflow default.

**Reading ADR-011's refusal as wrong.** It was right about what it examined and
was never a claim that Windows could not break — the sentence it wrote is "a
leg that cannot fail is not a guard", and this one failed on first contact.

## Consequences

Six cells instead of one, on every push and pull request. Every step in the
workflow already spawns `node` and `git` directly, without a shell, so the
matrix costs runner minutes and no rewriting.

A Windows cell going red is now a real signal about the engine, not about the
runner. `pack:check` is the step most likely to be first: it has the only
platform branch in the repo, invoking npm through `npm_execpath` because
neither `npm` nor `npm.cmd` spawns unshelled on Windows.
