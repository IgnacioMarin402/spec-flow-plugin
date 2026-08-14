# Working agreements for this repo

This engine exists to close one failure: a check that looks armed and is not.
The same standard applies to work done *on* it.

## Verify before you claim, and before you propose

**A claim without a run behind it is not a finding.** Reading the code is how
you form a hypothesis; running it is how you learn whether the hypothesis is
true. Every defect worth reporting here was found by executing something —
several of them contradicted what the source appeared to say.

**Before proposing that something be REMOVED, verify what it uniquely
provides — not merely that an alternative exists.** This is its own rule
because it has its own failure mode: finding one good argument for deletion
feels like finishing the investigation, and it is the point at which the
investigation has barely started. An alternative covering *part* of a job is
evidence about that part and says nothing about the rest.

The concrete case: `.spec-flow/skills.md` was proposed for deletion because
Claude Code already lists every skill's name and description to the model, so
the table was "redundant for discovery". That was true and irrelevant.
Discovery was one of three jobs the table does — it also maps a project
DECISION to a skill, records which skills a project preloads through an agent
override, and converts "Claude uses skills when relevant" into an instruction
the agent must follow. Two doc quotes supported deleting it; nobody checked
what would have contradicted that, which is the same shape of error the
engine's gate exists to prevent.

## Proving a fix

**Every fix that can have a regression test gets one, and the test must be run
against the commit BEFORE the fix.** A test that passes both ways is a guard
on new behaviour, not proof of a defect — both are worth having, and saying
which is which is not optional.

**Run that comparison in a throwaway clone** (`git clone . /tmp/x && git
checkout <sha>`), never by manipulating this working tree. A `git stash` plus
`git checkout` dance to swap versions mid-verification silently reverted five
files here once; the only reason it surfaced was a suite that passed when it
should have failed.

## Changing one coupled contract is not a local edit

Nothing here stands alone. The hooks agree about `.claude/state/phase`; the
agents agree about the shape of `Mk.md`; the commands describe both. Editing
one member of such a set changes what the others' assumptions mean, and the
break is silent because each file still reads correctly on its own.

It has happened twice, in both halves:

- `preflight` armed on every run phase, which turned `session-start`'s "the
  other phases are already harmless" from true into false and made an
  abandoned `plan` deny unrelated work forever.
- A `Skills:` field was added to the milestone template and the planner's
  contract, and the reviewer — the one agent whose job is checking the plan —
  was not told, so a missing field passed review unseen.

So: after changing a hook, re-read the other nine. After changing what an
artifact contains, re-read every agent and command that writes or reads it.
Testing the thing you changed is not the check that matters here.

## Docs are checked, not trusted

`scripts/no-repo-refs.mjs` scans every prose file in `SCAN_FILES` — add new
ones there, or the next doc becomes the path of least resistance for exactly
what the check keeps out. `scripts/plugin-paths.mjs` asserts that every
`${CLAUDE_PLUGIN_ROOT}/...` path an instruction names actually ships, and that
`hooks.json` and `hooks/` agree. Counts written as prose ("ten hooks") have
drifted before and will again; prefer a check over a sentence.
