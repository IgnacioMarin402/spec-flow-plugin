# ADR-027 — the unit of a run is the repository, and the contract sits at its root

**Date:** 2026-09-29 · **Status:** accepted · **Governs:** `scripts/changed-files.mjs`, `hooks/gate.mjs`, `hooks/preflight.mjs`, `scripts/check-changed.mjs`, `scripts/init.mjs`, `README.md`, `REFERENCE.md` · **Related:** ADR-008, ADR-017, ADR-026

**Question.** A workspace holds a `CLAUDE.md` at its root and two packages,
`front/` and `back/`, each with its own runner and linter. Where does the
engine run, where does it test, and what happens when Claude Code is opened
inside one package?

**Measured.** Opened at `back/` of a two-package repository, on a branch whose
one commit changes `back/b.ts`: `git diff --name-only` spells the change
`back/b.ts` from the root and from `back/` alike, `changedFiles` joins it onto
`back/`, finds no such file, and the change falls out of scope. `git ls-files`
answers relative to `back/`, so the scope is not empty and `fail:scope` cannot
fire. The gate then skips lint over a red linter, runs the suite, passes, and
records `lint=-` — the line an honest milestone that touched nothing records.
A porcelain `git status` is root-relative too, so the dirty check compares a
root-relative path against a directory-relative report path.

**Decision.** The unit of a run is the git repository, and every path the
engine reads hangs off its root: the contract, `.claude/state/`, `specs/`,
`specflow/`. `init`, `preflight`, the gate and `spec-flow check` refuse a
project directory that sits inside a repository without being its root —
`git rev-parse --show-toplevel` is the arbiter, so a package that is its own
repository (a submodule included) is a root — and they refuse before reading
the contract, because "no contract here" would send a human to write a second
one where no gate can run it. The gate records it as `fail:root`.

A workspace of packages is therefore one repository and one contract:

- one `verify.test` argv that runs every suite and writes one report — a
  script the repo owns, since two runners write two files and the reader takes
  one; the JUnit reader scans `<testcase>` wherever it sits, so concatenating
  is enough;
- one `verify.lint` argv that accepts any in-scope path, which for a linter
  that resolves its configuration per directory means one configuration at
  the root;
- one `scope_globs` — `*.ts` already spans every package;
- one `specs/`, whose capability names are unique across the repository
  because the filename is the id prefix, and whose `spec-scope` markers name
  the package path. The anatomy statement (ADR-026) is stated per package,
  and a spec's scope says which one a milestone reads;
- one phase, so one run at a time per repository (ADR-017).

**Refused.**

- A contract per package under one root. The gate is one Stop hook reading one
  phase, and two suites with two reports need a merge nothing in this package
  owns (ADR-002).
- Relativising git's answers (`git diff --relative`) so a subdirectory can be
  the unit. A suite run from `back/` is a property of `back/`, not of the
  system (ADR-008), and the other package's dirt would still stop this
  package's gate.
- `trace.report` as a list of paths. A contract change that bumps
  `contract_version` for every adopter, to save one wrapper script.
- Reading the root's contract from a subdirectory silently. Claude Code
  resolves `CLAUDE.md`, skills and settings from where it was opened; the run
  would obey one directory's rules and another's contract.

**Cost.** The workspace adopter writes the wrapper that runs both suites into
one report, and pays both suites at every gate — ADR-008's cost, once per
package.
