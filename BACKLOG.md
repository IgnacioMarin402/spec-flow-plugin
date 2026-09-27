# Backlog

Open work only. Shipped work lives in `git log`, whose commit bodies carry the
reasoning. Each item says what "done" is: ideally a check that goes red before
the fix and green after.

## Open

### B34 — a run can end itself without a verdict

The gate arms on `.claude/state/phase`, which the model it judges writes.
Measured: after `GATE FAILED`, writing `idle` is allowed by `phase-guard` and
the next Stop passes silently, with no history line; `done` checks spec-trace
and the archive but not the last gate verdict, so it was allowed over
`result=fail:behaviour test=1`. **Done:** those two writes denied by a
hook-smoke case that fails today.

### B35 — the contract is editable mid-run

`.spec-flow/config.json` decides what the gate runs, and nothing stops a
milestone from changing it: `verify.lint` pointed at a no-op, an `extra_checks`
entry removed. Dropping the reporter is now refused (`3c50f61`); the rest is
not. **Needs a decision first:** who approves a contract change on a run's
branch, and how the gate learns it was approved.

### B36 — test-first is not happening

In the adopting repo, 18 of 18 measured requirements had no red test run before
their code. A test written after the code mirrors it, which is the gap ADR-020
leaves to a model's reading. **Candidate:** run each ADDED requirement's test
against the base commit; one that passes there proves nothing. Report, not
gate — it runs the suite twice and flaky tests exist.

### B37 — the telemetry has never seen a real run

In the adopting repo `specflow-stats` reports no token accounting and
"attribution: UNAVAILABLE". `token-trace` was added on 2026-08-31, after the
last real run (2026-08-26), so about 1,600 lines, fixtures included, have never
seen a real run end to end. **Done:** one real run's snapshot
read by `specflow-stats` with tokens and attribution populated — or the
subsystem cut back to `gate-history.log` and the snapshot.

### B38 — `init` exits 1 on the smallest Node project

A repo whose test script is `node --test` gets four `MISSING` fields: `node` is
read as an interpreter rather than a runner, although `init` appends node's
own reporter flag correctly. **Done:** an `init-fixture` case on a bare
`node --test` project that ends green.

### B39 — the model-routing surface is ahead of its use

Overrides, version pins and effort take about 1,200 lines with fixtures, next to
agent frontmatter that already names each tier. `max_opus_calls` is the part
with a demonstrated job (cost control). **Decide by use:** keep what a real
project has set.

### B15 — model-graded checks

`claude plugin eval` is in early access. On 2.1.246 `--help` prints the full
help and exits 0 while a run is still refused, so re-check by running
`claude plugin eval .`, never by reading `--help`. Highest-value cases once it
runs: the reviewer's `CHANGES_REQUESTED` path, the five `/spec-fix` triage
cases, the orchestrator refusing to write code.

### B33 — `Record:` shas in `decisions/` are unchecked

Two of four were wrong and were corrected by hand. Checking them needs
`fetch-depth: 0` in CI — slower on every job — to guard four frozen records;
records since ADR-005 use `Governs:` and carry no sha. Open as a cost call.

## Deliberately not doing

- **More agents or commands.** Five agents that provably close the loop is the
  harder claim and the better one.
- **A plugin version number.** See ADR-003 and ADR-018.
- **A synthetic with/without benchmark.** Real runs read honestly say more: the
  adopting repo's 53 gate invocations showed what the gate catches and what it
  skips.
- **A worked example contract in this repo.** A contract holds exactly the
  stack-specific values the engine refuses to know; `no-repo-refs.mjs` keeps
  them out, and `init` generates one from the adopting repo instead.
- **A skill for this repo's conventions.** `CLAUDE.md` now states them in a
  page, loaded every session; a skill would restate it.
- **A length budget on the README.** It would be one more check on prose, and
  the goal is less prose. Shape is reviewed by people.
