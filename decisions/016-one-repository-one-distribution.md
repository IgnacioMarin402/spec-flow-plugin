# ADR-016 — one repository, one distribution: nothing is published to npm

**Date:** 2026-08-23 · **Status:** accepted · **Governs:** `bin/spec-flow.mjs`, `scripts/package-fixture.mjs`, `README.md`, `REFERENCE.md` · **Extends:** ADR-003

**Question.** The engine reaches a repo through the plugin and through a
devDependency documented as `npm install --save-dev spec-flow-plugin`. Should
the second be published?

**Measured.** The two installs are two copies that execute separately (a hook
resolves `../scripts/` from the plugin root; the CLI from its own). Nothing in a
session touches the dependency: `cold-start.mjs` goes from nothing to green with
nothing installed. And it had never been published —
`registry.npmjs.org/spec-flow-plugin` returned "Not found", so the README's
step 2 had failed for every reader.

**Decision.** This repository is the only distribution unit. The CLI half
installs from it as a git spec (`github:<owner>/<repo>`, optionally
`#<commit-or-tag>`) or runs by path from a clone. A git spec covers the short
command, a pinned CI version and the `files` allowlist; the one loss is npm
discoverability, which never existed.

**Refused.**
- Publishing with a version bump per release: ADR-003 found that discipline
  unworkable, and a registry version is one more number free to disagree with
  the SHA.
- A check comparing the two installs: accepted instead that nothing detects a
  plugin and a dependency on different commits — they now move along one axis.
- Removing the plugin: hooks, agents, commands and skills cannot be registered
  by an npm package, and the gate is a Stop hook.
