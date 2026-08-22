# ADR-011 — the contract is platform-neutral, the engine is POSIX

**Date:** 2026-08-22 · **Status:** accepted · **Governs:** `scripts/argv.mjs`, `scripts/init.mjs` · **Narrows:** ADR-007

## The question

An external review claimed Windows was broken because `spawnSync` runs
`npm`/`npx` without `shell: true`, which cannot resolve `npm.cmd`. The ENOENT
is real. The claim was still wrong about this engine: `init` never writes
`npm`, it prefers the local binary, so that path is not the one taken.

Running it found a different defect underneath, and a worse one.
`toArgv` wrote `['node', join('node_modules', '.bin', bin)]`. On POSIX
`node_modules/.bin/eslint` is a **symlink to the package's JavaScript**, so
`node` runs it. On Windows npm cannot rely on symlinks, so it writes three
files — `eslint`, `eslint.cmd`, `eslint.ps1` — and the extensionless one is a
`#!/bin/sh` script. `init` named the one file of the three that `node` cannot
parse:

```
status = 1
SyntaxError: missing ) after argument list
```

The gate reads that as `lintRc = 1` and blocks, so the failure is closed
rather than silent — unusable, not falsely green. But `path.join` also wrote
the generating machine's separator into `.spec-flow/config.json`, which is a
**committed** file: a contract generated on Windows names
`node_modules\.bin\eslint`, a path nobody on macOS or Linux has.

So the question is two questions, and they have different answers.

## The decision

**The contract is platform-neutral.** `resolveLocalBin` resolves past the
shim to the package's real entrypoint — `realpath` on a symlink, the
`$basedir/../<pkg>/<file>` target of the `sh` shim otherwise — and returns a
repo-relative path with `/`. Both platforms therefore produce the identical
string, `node_modules/eslint/bin/eslint.js`, and a contract written on one
machine runs on every other.

This is a correctness fix independent of which platforms are supported.
Naming `node_modules/.bin/x` was never right: it means two different things
depending on where it is read, in a file whose whole job is to mean one.

**The engine's supported platform is POSIX — declared, not enforced.** Same
shape as ADR-007, and for the same reason: it is what CI exercises and what
the fixtures were written against. A repo on Windows may well work — the
contract it generates is now portable, and every check in this repo passes
there today — but that carries no promise, gets no CI leg, and wins no
argument.

**The argv SHAPE is unchanged**, `['node', <path>, ...]`, so the five sites
that spawn it are untouched and `contract_version` does not move. `binaryOf`
already returns the second token for a runtime, and `resolvableOnDisk`
already accepts a relative path with `/`.

## What was refused

- **`shell: true` at the spawn sites**, the review's own suggestion. It would
  make `npm.cmd` resolve, and it puts every argv through a shell that quotes
  differently on each platform — while the gate appends *changed file paths*
  to `verify.lint`, so a path with a space becomes a quoting bug in the one
  command that must not misfire. Resolving the entrypoint needs no shell.
- **A `windows-latest` CI leg.** It would be green today: every check passes
  there, because `cold-start` builds its throwaway repo with `node --test`
  and `node -e` — the one binary with no shim — so the suite could not see
  this class of defect at all. A leg that cannot fail is not a guard, and the
  fixture that CAN fail (`init-fixture`, the two portability cases) goes red
  on POSIX too, which is where CI already runs.
- **Guessing when the shim cannot be read.** A bin with no JavaScript behind
  it — a native binary — has no entrypoint to name, so `resolveLocalBin`
  returns null and the bare command name is kept, which resolves through PATH
  the way the repo's own script already does.

## The cost

`init-fixture`'s `bins` helper wrote an empty placeholder, which was enough
while nothing read the shim and is not a shape npm ever writes. Cases about
what the local binary resolves TO now need `installedBins`, which fabricates
the real layout for the host platform. The placeholder is kept for the one
case it is now exactly right for: a local bin that resolves to nothing.
