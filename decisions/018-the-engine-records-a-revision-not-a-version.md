# ADR-018 — the engine records a revision, not a version

**Date:** 2026-08-23 · **Status:** accepted · **Governs:** `scripts/engine-revision.mjs`, `hooks/gate.mjs`, `scripts/gate-fixture.mjs` · **Extends:** ADR-003, ADR-016

## The question

Every line of `state/gate-history.log` carries `engine=<value>`, read from
`package.json`'s `version`. What is that field for, and can it do it?

## What was measured

**The value has never moved.**

```
$ git log --oneline -S'"version"' -- package.json
0f291c5 feat: extract spec-flow into a standalone plugin
```

One commit — the extraction. Every gate run of every milestone since has
recorded `engine=0.1.0`, and would keep recording it through any amount of
change to the hooks the field is supposed to identify. That is precisely the
failure ADR-003 removed from `plugin.json`, surviving in the file the gate
actually reads.

**The original justification had already been withdrawn.** The comment beside
the field said it existed to expose drift between the plugin copy and the
devDependency, "the plugin follows a commit and the dependency follows a
version range". ADR-016 ended the version range — the dependency is a git spec
now — and explicitly refused a check comparing the two installs. So the reason
the field was added was no longer a reason, and the sentence stating it was
false.

**Only one copy ever writes a line.** `gate.mjs` is a `Stop` hook; it runs from
the plugin install, never from `node_modules`. Nothing else writes
`gate-history.log`.

**The npm copy has no revision to report anyway.** Installed from a git spec
into a throwaway consumer, on npm 11:

```
$ ls -a node_modules/spec-flow-plugin        # no .git
$ node -e "…require('./node_modules/spec-flow-plugin/package.json')"
{"version":"0.1.0"}                          # no gitHead either
$ grep resolved package-lock.json
git+file:///…/engine.git#e626f15a00a630a8a00df0eed998ea209a0e01f1
```

The commit survives in the **consuming repo's** lockfile — that repo's file,
not this one's.

## The decision

**`engine=` records the commit of the copy that ran.**
`scripts/engine-revision.mjs` resolves `git rev-parse --short=12 HEAD` against
the engine's own directory, which is what a plugin install is: a clone.

When no revision resolves, it falls back to the package version **prefixed with
`v`**. The prefix is the load-bearing part: a reader who cannot tell a revision
from a fallback is back where the frozen number left them.

The field stays **recorded, never checked** — the same standing `cc=` has under
ADR-004. Nothing here has an opinion about which revision should have run.

`gate-fixture.mjs` builds the engine copy as a git checkout, runs the gate,
adds a commit, and runs it again: two distinct engine commits producing the
same `engine=` fails. A check that only asserted "it looks like a sha" would
have passed against the frozen version the day someone reformatted it.

## What was refused

**A `prepare` script stamping the revision at install time.** It would give the
npm copy a revision of its own, and it buys that by adding a lifecycle script
that runs on every install of the engine and of this repo — new machinery in
service of a copy that writes no history line. If that copy ever needs to
report one, the consuming repo's lockfile already holds the answer.

**Bumping `version` per release instead.** ADR-003 measured that discipline and
found it unworkable here: the same number shipped through nine PRs of real
behaviour change. Repairing it by asking for more discipline is the option that
already failed.

**Recording both.** `engine=0.1.0+9a3f21c4b0d8` keeps a number that means
nothing next to one that means something, and invites a reader to compare the
halves. One axis is what ADR-016 left; the SHA is that axis.

## Consequences

`hooks/gate.mjs` imports one more module from `scripts/`, so
`gate-fixture.mjs`'s hand-maintained copy list grows by one — that list is the
engine's real dependency graph and has to be kept honest by hand, which is
stated in its own header.

Old history lines still read `engine=0.1.0`, indistinguishable from the new
fallback except for the missing `v`. They are the lines written while the field
recorded nothing, and there is no way to date them better than the timestamp
already on each line.
