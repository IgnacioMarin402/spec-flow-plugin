# ADR-016 — one repository, one distribution: nothing is published to npm

**Date:** 2026-08-23 · **Status:** accepted · **Governs:** `bin/spec-flow.mjs`, `scripts/package-fixture.mjs`, `README.md`, `REFERENCE.md` · **Extends:** ADR-003

## The question

This engine reaches a repo through two installs: the plugin, from the
marketplace, and a devDependency named `spec-flow-plugin`, documented as
`npm install --save-dev spec-flow-plugin`. Should the second one be published?

The question arrived from the other end — whether an update to the plugin could
reach other people automatically — and only became this one after looking at
what "the plugin" actually is.

## What was measured

**The two installs are two copies, and they execute separately.** Built one
tree as `pluginA` and another as `npmB`, marked each, and ran both routes:

```
ruta comando (${CLAUDE_PLUGIN_ROOT}) -> RUNNING FROM: pluginA
ruta CLI (bin de npm)                -> RUNNING FROM: npmB
```

The gate hook imports `../scripts/…` relative to the plugin root;
`bin/spec-flow.mjs` resolves relative to its own. So the header on that file —
"the hook and these aliases resolve to and run the SAME file… structural
instead of a promise kept by two copies that happen to agree today" — described
a configuration nobody ships. It was the promise it claimed to have replaced.

**Nothing in a session touches the dependency.** Every `${CLAUDE_PLUGIN_ROOT}`
path in `commands/`, `agents/` and `skills/` reaches the plugin's own copy;
`skills/spec-flow-setup/SKILL.md` had the one exception, an `npx spec-flow
models`, now spelled like its neighbours. `node scripts/cold-start.mjs` takes a
Node repo from nothing to a green check with **nothing installed**.

**And it was never published.** `registry.npmjs.org/spec-flow-plugin` returned
`{"error":"Not found"}`, so step 2 of the README's install had been failing for
every reader since it was written.

## The decision

**This repository is the only distribution unit.** The plugin is installed from
the marketplace; the CLI half is installed *from the same repository* as a git
spec — `npm install --save-dev github:<owner>/<repo>`, optionally
`#<commit-or-tag>` — or run by path out of a clone. Nothing is published to a
registry.

The two copies remain two copies on disk. What changes is that they cannot
acquire independent version axes: the plugin resolves to a commit SHA (ADR-003)
and the dependency resolves to a commit of the same repository.

Verified before choosing it, because the case for removal is only as good as
what the alternative actually covers:

| what npm publishing provided | covered by a git spec? |
|---|---|
| a short `spec-flow x` command | **yes** — `npx github:<owner>/<repo> models` ran the real CLI |
| a pinned, reproducible version in CI | **yes** — `npx "github:<owner>/<repo>#b4bf3a4"` resolves, and the spec pins in a lockfile as a devDependency |
| the `files` allowlist, evaluated at pack time | **yes** — a git install packs the clone; `node_modules/spec-flow-plugin` came out with `test/` and this repo's lint config absent |
| discoverability on npmjs.com | **no** — the one real loss, of something that did not exist |

## What was refused

**Publishing, and bumping a version on every release.** ADR-003 already found
that discipline unworkable here: the same number shipped through nine PRs of
real behaviour change. Adding a second place to bump would not have gone
better, and a registry version would have been the one number free to disagree
with the SHA.

**A check that compares the two installs.** It closes the drift by adding
machinery to tolerate a second copy, when the second copy is the thing that did
not need to exist. Note what is therefore true: **nothing detects a plugin and
a dependency sitting on different commits.** That is accepted, not overlooked —
they now move along one axis, and a check would be defending against a
divergence no supported route produces.

**Removing the plugin instead.** The inverse was considered and is not
available. Hooks, agents, commands and skills are Claude Code integration
surfaces that no npm package can register, and the gate is a `Stop` hook — the
enforcement premise itself. Without the plugin an adopter hand-writes eleven
hook entries and copies five agents, which is a manual port, not a
distribution.

## Consequences

`scripts/package-fixture.mjs` now clones this repo and installs the clone
through a git spec instead of packing a tarball for a registry. It keeps its
original job — `files` is still evaluated, because npm packs the clone — and
loses its network dependency: it passes with `npm_config_registry` pointed at a
dead port, which no check here now needs.
