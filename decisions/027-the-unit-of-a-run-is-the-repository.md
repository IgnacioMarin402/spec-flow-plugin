# ADR-027 — the unit of a run is one repository, opened at its root

**Date:** 2026-09-29 · **Status:** accepted · **Governs:** `scripts/changed-files.mjs`, `hooks/gate.mjs`, `hooks/preflight.mjs`, `scripts/check-changed.mjs`, `scripts/init.mjs`, `README.md`, `REFERENCE.md` · **Related:** ADR-008, ADR-017, ADR-026

**Question.** A workspace directory holds a `CLAUDE.md` and two repositories,
`front/` and `back/`, each with its own suite, its own linter and a pipeline
that runs on a push to it alone. Where does the engine run, and what happens
when Claude Code is opened at the workspace, or inside a repository below its
root?

**Measured.** Two directories, two silent answers.

- Inside `back/`'s repository, below its root: `git diff --name-only` spells
  the branch's change from the root, `changedFiles` joins it onto the
  directory, finds nothing there, and the change falls out of scope. `git
  ls-files` answers relative to the directory, so the scope is not empty and
  `fail:scope` cannot fire. The gate skipped a red linter and recorded
  `lint=-`, the line of a milestone that touched nothing.
- At the workspace, which is no repository: `init` wrote a contract there with
  every field MISSING; `preflight` then refused it as a contract that could
  not be read, sending a human to fill in a contract for a directory the
  engine can never run against.

**Decision.** The unit of a run is one git repository, opened at its root. The
contract, `specs/`, `specflow/`, `.claude/state/` and the suite are that
repository's, so what its pipeline runs on a push is what the gate judged. A
workspace of repositories is opened one repository at a time: Claude Code
loads `CLAUDE.md` from every directory above the one it was opened in, so
what the workspace states reaches every agent either way. `init`,
`preflight`, the gate and `spec-flow check` refuse two directories before
reading the contract — one inside a repository below its root (`fail:root`),
one in no repository at all — and name what to open. `git rev-parse
--show-toplevel` is the arbiter, so a repository nested in another (a
submodule) is a root of its own.

A workspace that is itself one repository is one unit and one contract at its
root; a package inside it that needs its own gate and its own pipeline becomes
its own repository.

**Refused.**

- One suite for the workspace, run from its root. The pipeline that runs on a
  push to `back/` runs back's tests; a gate that judged more than that push
  carries proves nothing about it, and a requirement proven by the other
  repository's test is proven by nothing that travels with the change.
- A workspace contract naming its repositories, and a run that targets one.
  Every hook reads the directory Claude Code was opened at; a second root
  would live in state the model writes, and opening the repository is the
  same declaration made where the harness already reads it.
- Guessing the repository from the requirement's text. It does not say where
  it lands, and a wrong guess arms one repository's gate over another's edits.
- Relativising git's answers (`git diff --relative`) so a subdirectory can be
  the unit. A suite run from `back/` of one repository is a property of
  `back/`, not of the system (ADR-008).

**Cost.** A change that spans two repositories is two runs, and nothing in the
engine binds them; the workspace's `CLAUDE.md` is the one thing both read.
