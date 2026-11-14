# Working agreements for this repo

This engine closes one failure: a check that looks armed and is not. Work on
the engine is held to the same bar.

## Evidence

- **A claim needs a run behind it.** Reading code forms a hypothesis; running
  it tests one.
- **Every fix gets a regression test, run against the commit before the fix**,
  in a throwaway clone (`git clone . <tmp> && git checkout <sha>`) — never by
  stashing or checking out in this tree. Say which tests prove the defect (fail
  before) and which only guard new behaviour (pass both ways).
- **Before removing something, list every job it does and who else does each.**
  Before enforcing something, check what its siblings get.

## Coupled contracts

The hooks share `.claude/state/phase`; the agents share the shape of `Mk.md`;
the commands describe both; the hooks and the live view read with two copies of
one set of readers, held together by `hooks/readers.golden.ts`. After changing one member, re-read every file that
reads or writes the same thing — each still reads correctly on its own, which
is why the break is silent.

## Merging

- **A branch is tested on the `main` it merges into.** Bring `main` in before
  opening the PR, and again whenever `main` moves. Two PRs can each pass on
  their own and break each other with no textual conflict.
- **Merge only on green CI.** With plugin auto-update on, a change on `main`
  reaches every session that runs the engine.

## Where reasoning goes

- **Invariant** (why this line must be so) → a short comment beside it.
- **Transition** (what it used to be, and why it changed) → the commit body.
  Recover one with `git log -S '<code>' -- <file>`, `git log -L <a>,<b>:<file>`
  or `git blame -L <n>,<n> <file>`.
- **Decision** (why the system has this shape, and what was refused) →
  `decisions/`, cited from the code as `ADR-NNN`.

Details: `.claude/skills/engine-comments`.

## Docs

**Less is the goal.** Delete prose that restates the code, the git history or a
check. Prefer a check over a sentence — counts written as prose drift.

New prose files or directories go in `NO_REPO_FILES` / `NO_REPO_DIRS` in
`engine/tests/repocheck/norepo.rs`, and in the written-out list in
`engine/tests/repocheck/fixtures.rs`. `PluginPaths` checks that every
`${CLAUDE_PLUGIN_ROOT}/...` path an instruction names actually ships.

## Running it

- `cargo test` is every check: the engine's readers, its behaviour through the
  binary `bin/` commits for this platform (`engine/tests/e2e`, ADR-055), and
  this repository's checks on itself (`engine/tests/repocheck`).
  `SPEC_FLOW_BINARY=<binary> cargo test --test e2e` runs the behaviour cases
  against another build, before `bin/` is rebuilt.
- The binaries in `bin/` are built from the source in the same commit by
  `engine/build.sh` (ADR-054); `cargo test --test binaries -- --ignored`
  rebuilds them and fails when they are not.
- Evals run a model, so CI runs none:
  `claude plugin eval . --scaffold --no-publish --allow-tools Write Edit --judge-model sonnet`.
  The `evals` repocheck holds each grader to its case's scaffold.
