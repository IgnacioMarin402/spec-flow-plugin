# Backlog

Open work only. Shipped work lives in `git log`, whose commit bodies carry the
reasoning. Each item says what "done" is: ideally a check that goes red before
the fix and green after.

## Open

### B35 — the contract is editable mid-run

`.spec-flow/config.json` decides what the gate runs, and nothing stops a
milestone from changing it: `verify.lint` pointed at a no-op, an `extra_checks`
entry removed. Dropping the reporter is now refused (`3c50f61`); the rest is
not. **Needs a decision first:** who approves a contract change on a run's
branch, and how the gate learns it was approved.

### B36 — test-first is not happening

In the adopting repo, 18 of 18 measured requirements had no red test run before
their code — but that trace could not see a red run at all: a test command that
exits non-zero arrives as `PostToolUseFailure`, which run-trace did not hear
until this item was restated. Two real runs since, counted by target: of 6
sources paired with a test, 1 had its test run red first, 1 had it run piped
and 4 had no run of it, which is what stats reads now that it credits a run
only to the tests its target names. A third milestone
wrote its test, then a source with another name, with no run, and stats lists
nothing: it pairs by basename. A test written after the code
mirrors it, which is the gap ADR-020 leaves to a model's reading.
**Candidate:** run each ADDED requirement's test against the base commit; one
that passes there proves nothing. Report, not gate — it runs the suite twice
and flaky tests exist.

### B39 — the model-routing surface is ahead of its use

Overrides, version pins and effort take about 1,200 lines with fixtures, next to
agent frontmatter that already names each tier. `max_opus_calls` is the part
with a demonstrated job (cost control). **Decide by use:** keep what a real
project has set.

### B40 — what the orchestrator costs a run

The orchestrator is the human's session (ADR-029), so its model is whatever
they run; stats reports its tokens apart from each role's. **Done:** those
tokens over at least three real runs on an engine at `80feaea` or later
(ADR-038 changed what it dispatches) — then decide whether the command pins a
model. So far, with the session on Opus: US$0.93 of US$2.44 (38%) on
`620901d`, and US$1.09 of US$2.07 (53%) before `80feaea`. All are floors:
output read where its final count was not written, a closing turn nothing
counted (ADR-043), and for the `620901d` run a
spec step the telemetry never saw (ADR-040). An archive never holds its run's
closing turn: stats charges it to the run from the live log, which a cloud
branch loses with its container.

### B41 — which hooks could be mods

A mod may only show (ADR-029), from `.claude/state/` and the session's own
events (ADR-037). **Done:** a list of the hooks and scripts that only observe,
each with what a mod would add, before any is moved.

### B48 — what needs a database or a running app is checked by nobody

The gate runs lint, the whole suite, spec-trace and `extra_checks`. An
`extra_checks` entry runs at every gate, at `done` and in `spec-flow check`, so
one that needs a database or a running app fails wherever none is up, and is
routed to the implementer as lint/trace. `spec-flow init` proposes no entry: it
reads only the `test`, `lint` and `lint:fix`/`format` scripts and writes
`extra_checks: []`, so not even a build or a typecheck, which need neither, runs
during a run. B35 leaves any entry removable mid-run. **Done:** init offers the
repo's `build` and `typecheck` scripts as `extra_checks` entries,
with an init-fixture case red on `620901d`. **Needs a decision first** for
end-to-end checks, migrations and booting the app: where they run, if not at
every gate.

### B52 — the spec-writer on the cheapest tier

ADR-030 shows the human what the spec-writer assumed, and ADR-031 holds its
return to its contract: the two risks each names for a cheaper tier. On one
real run the spec-writer cost US$0.18 of US$2.07 (US$0.09 for the spec,
US$0.08 for the fold), so the case is about the questions it asks, not the
price. Routing is per agent, not per mode: its fold, the one reading of whether
a test proves its requirement (ADR-020), moves with it. **Done:** the
spec-writer on `haiku` at `high` over three real runs, compared with `sonnet`
on question rounds, agent-gate blocks, fold `GAPS` and rejected sign-offs,
which nothing records yet. Needs B54: a project route keeps the declared
`medium`.

### B53 — a repository that states no anatomy

ADR-026 has the planner read how a repo builds a module from what the repo
states; one that states nothing sends it back to the source, and its `NOTES`
ask the human for the statement. Only the setup skill drafts one, and only
when someone runs it. **Candidate:** a cheap scout drafts the anatomy during
the run and the human approves it at sign-off. During a run ADR-034 lets the
session write only `.claude/state/` and `specflow/`, so `CLAUDE.md` or a skill
would be written by an agent, or after `done`. **Needs a decision first:**
whether a run writes the statement at all, and which agent does.

### B54 — a re-route keeps the effort its role declares

`model-route` rewrites a re-routed spawn's `model` and nothing else, so a
project routing the planner to `sonnet` keeps the frontmatter's `effort: high`.
ADR-014 and ADR-015 still say a hook's `effort` is stripped (2.1.241);
`f554b76` measured on 2.1.294 that it applies and that
`CLAUDE_CODE_EFFORT_LEVEL` beats it, and left routing effort to a decision of
its own. Neither real run re-routed an agent (B39). **Needs a decision
first:** an ADR superseding ADR-015's measurement, saying whether a project
routes effort and from what. **Done, if it does:** a hook-smoke case whose
re-routed spawn carries the effort, red on `620901d`, and `spec-flow models`
showing it.

### B55 — the implementer on the cheapest tier

On `sonnet`, the implementers of the one real run on `80feaea` or later cost
at least US$1.16 for two milestones; `haiku`'s prices are a twentieth of
`sonnet`'s. Decided by a paired experiment, not by price: the same milestones
on both tiers at the same session effort, on an engine at `80feaea` or later
(ADR-038), with the advisor off, plugin auto-update off, and `engine=`
naming a commit on every gate line. Compared on gate attempts per milestone,
architect calls, test-first and cost. **Done:** the result
recorded in `decisions/`, whichever way it goes.

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
