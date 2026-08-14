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

The concrete case is worth the whole story, because it ends somewhere
surprising.

`.spec-flow/skills.md` was proposed for deletion because Claude Code already
lists every skill's name and description to the model, so the table was
"redundant for discovery". That was true and irrelevant: discovery was one of
three jobs the table did. Two doc quotes supported removal; nothing was
checked that could have contradicted them. The proposal was withdrawn.

**And the file was deleted anyway, two days later, for reasons the first
proposal never touched.** Nothing read it — no script parsed it, and the one
check that mentioned it only tested that the file existed — so it could name
skills that had been renamed or deleted and nobody would learn. Its three jobs
each turned out to have an owner elsewhere: a skill's own `description` maps
the decision, the project's agent frontmatter records what it preloads, and
the milestone's `Skills:` field is the instruction. None of that was known
when removal was first proposed.

So the lesson is not "do not remove things". It is that **being right about
the conclusion is not the same as having verified it**, and the first version
of this argument would have been indistinguishable from the second to anyone
reading only the outcome. What separated them was whether anyone had gone
looking for the half that disagreed.

**Before proposing that something be ENFORCED, check what its peers get.**
The twin of the rule above, with the same failure mode reversed: a sound
argument for hardening one check feels like the end of the investigation, and
it never asks whether the thing being hardened is one of a set.

`Skills:` was made a hard `spec-trace` failure on an argument that held up —
`none` is a real assertion, an absent field cannot be told apart from a
planner that never looked, and review alone had already missed one. What
nobody asked is what the field's siblings get. `Spec deltas`, `Tests`,
`Objective` and `Files to add/change` sit in the same template and are
checked by the reviewer and nothing else. So `Skills:` became the only
milestone field that could fail a gate on its own, and that asymmetry was
never a decision — it accumulated over two commits, the second of which
tightened it further without noticing.

Asking the second question also moved the first one. The check had been
justified by where the field lives: in an artifact this flow writes, so
nothing needs declaring first. True, and beside the point — what a repo has
to declare is whether it routes skills at all, which no file here can detect,
since skills also arrive from installed plugins and from the user's own
directory. It is now a contract opt-in, off by default. Once again the two
versions of the argument are indistinguishable from the enforcement alone.

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
