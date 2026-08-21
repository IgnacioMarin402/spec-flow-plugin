# ADR-009 — a CHANGED delta says which kind it is, or it is not a CHANGED

**Date:** 2026-08-21 · **Status:** accepted · **Governs:** `scripts/spec-trace.mjs`

## The question

A change spec declares deltas against `specs/` in three shapes, and the
template presents them as peers:

```
- ADDED   REQ-<CAP>-0NN — ...
- CHANGED REQ-<CAP>-0NN — ...
- REMOVED REQ-<CAP>-0NN — ...
```

Two of the three are proven. Run against a fixture repo, `ADDED` fails the
gate when the new id has no test that ran, and `REMOVED` fails it when a test
still reports an id no spec declares. `CHANGED` was run the same way: a
requirement was rewritten into its literal opposite — "a single-use link,
valid for one hour" became "a reusable SMS code, valid for 30 days" — with the
test untouched. Exit 0. Rewriting the title as well: exit 0.

So what, if anything, proves a `CHANGED`?

## What the suite already covers, and the case it does not

Most of the gap needs nothing. If behaviour genuinely changed, the code
changed, and a test asserting the old behaviour goes red — the suite catches
it without help from this check. And the case where the spec is rewritten to
agree with existing code is the one `/spec-fix` case 3 already stops for a
human on, deliberately, because a diff cannot tell it from rewriting the spec
to agree with the bug.

One case survives both, and it is the reason for this record: **a `CHANGED`
that widens.** "A and B" becomes "A, B and C". Nothing breaks, because nothing
that used to pass stopped passing. `spec-trace` sees an id that exists with a
test that ran. The suite is green. C is claimed by the spec layer and proven by
nobody. Written as `ADDED`, that same clause fails on sight.

Verified: three new clauses — account locking after three failures, a security
notification, a daily rate limit — added under an existing id, gate green.

## The decision

A behaviour claim that appears, disappears or changes is `REMOVED` on the old
id plus `ADDED` on a new one. Ids are permanent, which is exactly what makes
retiring one safe, and both halves are already checked in both directions. The
rule routes the unprovable delta back into the two provable ones rather than
building a third check.

`CHANGED` keeps only the edits that move no proof, and must name which:

- `(wording)` — the requirement means what it meant; the text is clearer. What
  `MODE=FOLD` does when it fixes tense.
- `(correction)` — the requirement was wrong and is corrected to match
  behaviour that already exists and is already proven. `/spec-fix` case 3, and
  fix briefs only. The marker records that the human was asked; it does not
  stand in for them.

`spec-trace` fails a `CHANGED` with no kind, an unrecognised kind, or
`(correction)` outside a fix brief. Live change specs only — archived ones
predate the rule, as they do the spec/proposal split.

**Unconditional, not a contract opt-in.** The peer test that `require_skills_field`
turned on gives the opposite answer here. That field's siblings — `Spec deltas`,
`Tests`, `Objective` — are checked by the reviewer alone, so enforcing one of
them at the gate was an asymmetry, and it became opt-in. This delta's siblings
are enforced at the gate already, on every run. Leaving `CHANGED` out is the
asymmetry; closing it is what removes one.

## What this does NOT catch, stated because the record would otherwise overstate it

**A marker that lies.** The check verifies that a kind is present and
recognised, never that it is true. `CHANGED REQ-USER-001 (wording)` written
over a requirement that just grew three clauses passes, exactly as the bare
`CHANGED` did. Verified by running it.

That is a deliberate division and not an oversight, but it is only defensible
said out loud: **the machine checks that the claim was declared; the reviewer
and the sign-off check that it is true.** The reviewer's contract now names the
false-`(wording)` case specifically, because it reads the delta and the
milestone's `Tests` field side by side and is the only pass that does.

What changed is the default, not the door. Widening used to be the path of
least resistance — write `CHANGED` and nothing anywhere disagrees. It now costs
an explicit false assertion, against a contract that says in three places that
widening is not a `CHANGED`. Whoever revisits this should weigh it as that and
not as detection.

The alternative that would actually detect it — diffing the requirement's body
against the base branch — is the co-change check refused below, for the reasons
recorded there.

## What was refused

**A git co-change check** — for each `CHANGED`, assert the requirement's
section and at least one proving file both differ from the base branch. It
catches only the author who forgot the test, never the one who edited it to
match; it is diff-scoped, which ADR-008 refuses to trust because a mis-resolved
base manufactures an empty diff; and it fails the legitimate wording edit that
`MODE=FOLD` produces by design.

**Banning `CHANGED` outright.** A run whose whole purpose is clarifying an
ambiguous requirement is real, and would have no vocabulary left.

**A `/spec-refactor` command.** This began as one — a flow for specs that
mutate. `/spec-fix` covers the small correction and `/spec-flow` covers
re-specification, including `CHANGED` deltas, so a third command's unique
contribution was transcription. What did not survive the investigation was the
premise; what came out of it was this asymmetry, which is not about flows at
all.

## Related

ADR-001 (proof comes from the runner) — this check reads a document the flow
itself writes, and derives nothing about tests from source.

ADR-008 (the suite is never scoped to the diff) — refused the diff-scoped
alternative above, for the reason recorded there.
