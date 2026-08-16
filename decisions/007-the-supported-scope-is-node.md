# ADR-007 — the supported scope is Node, declared rather than enforced

**Date:** 2026-08-16 · **Status:** accepted · **Narrows:** ADR-002, ADR-006

## The question

The engine was built language-neutral on purpose, and stayed that way through
four records: ADR-001 removed source parsing, ADR-002 refused to ship runner
knowledge, ADR-005 replaced the adopter's translator with a report format, and
ADR-006 moved the remaining runner knowledge into the model. Every one of those
was decided to keep repos this engine has never seen working.

Then a real one was tried. A repo with real ruff and real pytest, a test that
ran and passed, named as closely as the language permits — reported as `has no
test that RAN`, because a Python identifier cannot hold a hyphen and the tag
pattern required one. The check whose entire job is failing when adoption
breaks was green over it, because its report was hand-written with a spelling
no runner on that side can emit.

So the question stopped being architectural: what is this engine actually
tested against, and what is it merely believed to work on?

## The decision

**Node is the supported scope.** It is what the documentation describes, what
CI exercises, what the fixtures are written in, and what `init` is optimised
for. Repos on other stacks are no longer a target: not tested, not documented,
not considered when weighing a trade.

**Declared, not enforced.** Nothing refuses to run on a repo without a
`package.json`. The engine still reads no source code — ADR-001 stands — so a
contract filled in by hand on another stack may well work, and breaking that on
purpose would cost new code to buy nothing. What changed is that it carries no
promise, gets no fixture, and wins no argument.

The honest reading of the last three records is that they were paying for a
population nobody had. What each of them bought that survives:

- **ADR-001** stands entirely. "Did this test run" is a runtime fact, and
  deriving it statically is wrong on Node too — `it.skip` and a runtime
  `t.skip()` are as invisible to a parser here as anywhere.
- **ADR-005** stands. The report FORMAT is what tells an executed test from a
  skipped one, and Node runners disagree with each other about reporters
  exactly as much as ecosystems do.
- **ADR-002's refusal is lifted, narrowly.** It refused a per-runner table
  because "a runner list rots, and it is precisely the artifact that looks
  maintained and quietly is not." True — and a list of four Node runners in a
  Node-only engine is a maintenance cost that is now proportionate, where a
  list spanning every ecosystem was not. `init` proposes the reporter flag.
- **ADR-006's tiers collapse to one and a half.** Tier 1 (detected) is now
  nearly the whole population. The setup skill stays for what `init` still
  cannot read — scripts running through an interpreter, and repairing a
  contract that broke — and it stays free of runner names, because `init` is
  where that knowledge now lives and two copies would drift.

## What was refused

- **Enforcing it** — `init` or the preflight rejecting a repo with no
  `package.json`. It buys an unambiguous boundary and costs a new refusal path
  plus a regression for anyone already running on another stack. Declared scope
  gives the same clarity to every reader who consults the docs, which is where
  a scope belongs.
- **Deleting the format readers.** TAP is not a foreign-ecosystem concession:
  Node's own test runner emits it natively, and JUnit XML is what every Node
  reporter with a CI story writes. Both stay because Node needs both.
- **Reverting the identifier-spelling fix.** A JS test title is a string
  literal and can hold hyphens, so the defect that motivated it cannot bite the
  same way here. The fix is three lines, it is correct, and a repo naming a
  test `test_REQ_USER_001_...` is legal Node. Removing it would be tidying that
  costs coverage.

## The cost

The engine's front page claimed to have no opinion about your language, and
that claim is now gone. It was true of the checking and false of the support,
and saying it out loud is worth more than a property nobody was holding us to.

`cold-start.mjs` loses its premise — a repo that is not an npm package — and
keeps its job. It is the only check that fails when ADOPTION breaks rather than
when a piece of the engine does, and that job is not language-specific; it is
now a Node repo going from nothing to green through the documented route.
