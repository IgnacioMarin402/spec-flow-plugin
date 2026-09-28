# ADR-026 — how a repo builds a module is read from what it states, not learned from its source

**Date:** 2026-09-28 · **Status:** accepted · **Governs:** `agents/planner.md`, `agents/spec-writer.md`, `scripts/specflow-stats.mjs`, `skills/spec-flow-setup/SKILL.md`, `REFERENCE.md` · **Refines:** ADR-015 · **Related:** ADR-002, ADR-006

**Question.** A planner on a two-module change read 46 files: 18 of the module
the repo's `CLAUDE.md` names as its reference, 7 of a sibling module, two whole
tests, the lint configuration and several migrations — 25 of them in modules
the change did not touch — over 29 serial turns, one per read, to write a plan
of 50k characters. Its contract asked for that in three places: "the
conventions are fair game and you should read them: the reference module, the
project's own lint rules"; "where it already has proofs, mirror their layout";
and a `Lint/type notes` field in every milestone. The sentence asking it to
read little sat between them. Where does a planner learn how this repo builds a
module, and why does every run learn it again?

**Measured.** Every one of the reads follows an instruction in the planner's
contract. What they teach — the kinds of file a module has, the layer each goes
in, how each is named — is stable across runs and fits in forty lines; the
spec-writer and the implementer learn parts of it again in the same run, each
in a cold context, and nothing carries it to the next run. The output, not the
reading, is most of an Opus planner's cost (`git log -1 19a09f3`); the reading
is most of its turns and its time.

**Decision.** The repo states its anatomy once and the agents read the
statement: a `CLAUDE.md` section when it fits, a skill when it needs room,
routed and loaded by the planner like every other skill, before any code is
opened, and named in each milestone's `Skills:` so the implementer reads the
same statement. The planner opens a reference module only when the repo states
nothing, one file of each kind, and says in `NOTES` that the statement is
missing. Three instructions to learn from source go: the lint rules
(`lint-on-write` catches a violation at the write, so the `Lint/type notes`
field goes with them), the layout of existing proofs (`proof_dir` and
`proof_suffix` are the layout), and the archive's failure lore (what
generalised is in the contracts). `Definition of done` goes too: it restated
the gate in every milestone the implementer re-reads. The setup skill drafts
the anatomy from the reference module and hands it to the human to correct.
`specflow-stats` splits each phase's reads against the change's scope — the
modules its deltas name through `spec-scope`, the directories its milestones
touch — so "why did it read that" has a per-run answer, and reports UNKNOWN
when the scope cannot be derived. The spec-writer declares `effort: medium`:
its escape hatch is a question to a human, and under an inherited `high` it was
the most expensive agent of the run above.

**Refused.**

- A hook counting reads per phase: it bounds the symptom and leaves the planner
  to guess what it can no longer read. Deferred, not rejected: a run with the
  statement in place that still reads outside the scope is the failing run
  that would justify it.
- A hook denying reads outside the derived scope: the same, and a new
  capability has no scope until its spec exists.
- A code graph or repo map shipped by the engine: stack-specific (ADR-002), and
  the run above did not fail to find files.
- Re-routing the reviewer: the API lists `effort` as unsupported on the tier it
  runs on, and one review turn reasoned 43k characters, so its declared `low`
  may reach nothing. Unmeasured here; the `think` count on that tier's row of
  the stats report is the measurement, and a re-route waits for it.

**Cost.** The statement is the repo's to keep true, and a stale one misleads a
plan with more confidence than source, which is always current. The stats
section is what shows it: a planner reading outside the scope with the
statement loaded is the statement being incomplete.
