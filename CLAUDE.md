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
the commands describe both. After changing one member, re-read every file that
reads or writes the same thing — each still reads correctly on its own, which
is why the break is silent.

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

New prose files or directories go in `SCAN_FILES` / `SCAN_DIRS` in
`scripts/no-repo-refs.mjs`, and in the written-out list in
`scripts/coupling-fixture.mjs`. `scripts/plugin-paths.mjs` checks that every
`${CLAUDE_PLUGIN_ROOT}/...` path an instruction names actually ships.
