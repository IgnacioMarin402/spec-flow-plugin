# Backlog

Open work only. Shipped work lives in `git log`, whose commit bodies carry the
reasoning. Each item says what "done" is: ideally a check that goes red before
the fix and green after.

## Open

### B36 — test-first is not happening

In the adopting repo, 18 of 18 measured requirements had no red test run before
their code — but that trace could not see a red run at all: a test command that
exits non-zero arrives as `PostToolUseFailure`, which run-trace did not hear
until this item was restated. Two real runs since, counted by target: of 6
sources paired with a test, 1 had its test run red first, 1 had it run piped
and 4 had no run of it, which is what stats reads now that it credits a run
only to the tests its target names. A third milestone wrote its test, then a
source with another name, with no run, and stats lists nothing: it pairs by
basename.

What a red-first check can claim, measured on 8 tests (`node --test`, JUnit):
that a test's result depends on the milestone's code, not that it asserts its
requirement. "Passes before the code" flagged a correct prohibition beside two
tests that assert nothing; "red before the code" passed a test with no
assertion, red only because its function did not exist yet. A test file that
does not load reports no id at all, and run-trace counts that load error as
red, so stats prints "red-first" for an empty test today. Whether a requirement
has a test at all is spec-trace's binding, not this item.

**Candidate:** red-first as a report in both flows, never a gate: record before
denying (ADR-035), a test's worth is read, not measured (ADR-020), and a run
against the base runs the suite twice, where flaky tests exist. It needs first:

- a verdict per test from the report — pass, fail, absent (did not load) or
  unknown; `test-report.mjs` reads names and skips only;
- absent never counted as red, run-trace's verdict included;
- a moment that blocks nothing: the implementer may not end a turn mid-red, and
  a worktree of the base has no installed dependencies;
- what passed before the code handed to the fold's `GAPS` question as
  candidates, worded "passed before the code".

A gate is refused for now in `/spec-fix` too: a case 2 raised from the fold's
`GAPS` strengthens a test over correct code, so it is green before the fix, and
the docs disagree on whether a case 3 changes the code. Gating `/spec-flow`
would need an `ADDED … (existing)` kind a person approves at sign-off.
**Done:** the report, with those four in place, read over three real runs
before any gate on it is proposed.

### B39 — model routing: decide by use, effort with it

Overrides, version pins and effort take about 1,200 lines with fixtures, next to
agent frontmatter that already names each tier, and neither real run re-routed
an agent. `max_opus_calls` is the part with a demonstrated job (cost control).
Decided together:

- **What stays.** Keep what a real project has set.
- **Effort.** `model-route` rewrites a re-routed spawn's `model` and nothing
  else, so a planner routed to `sonnet` keeps the frontmatter's `effort: high`.
  ADR-014 and ADR-015 still say a hook's `effort` is stripped (2.1.241);
  `f554b76` measured on 2.1.294 that it applies and that
  `CLAUDE_CODE_EFFORT_LEVEL` beats it. **Needs a decision first:** an ADR
  superseding ADR-015's measurement, saying whether a project routes effort and
  from what. **Done, if it does:** a hook-smoke case whose re-routed spawn
  carries the effort, red on `620901d`, and `spec-flow models` showing it.
- **The spec-writer on `haiku`.** ADR-030 and ADR-031 hold the two risks a
  cheaper tier brings. On one real run it cost US$0.18 of US$2.07 (US$0.09 for
  the spec, US$0.08 for the fold), so the case is the questions it asks, not
  the price. Routing is per agent, not per mode: its fold, the one reading of
  whether a test proves its requirement (ADR-020), moves with it. **Done:**
  `haiku` at `high` over three real runs, compared with `sonnet` on question
  rounds, agent-gate blocks, fold `GAPS` and rejected sign-offs, which nothing
  records yet. Needs the effort question answered: a route keeps the `medium`
  its frontmatter declares.

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

### B48 — what needs a database or a running app is checked by nobody

The gate runs lint, the whole suite, spec-trace and `extra_checks`. An
`extra_checks` entry runs at every gate, at `done` and in `spec-flow check`, so
one that needs a database or a running app fails wherever none is up, and is
routed to the implementer as lint/trace. `spec-flow init` now offers the
repo's `build` and `typecheck` scripts, which need neither; it offers nothing
that needs either. ADR-046 leaves any entry removable mid-run. **Needs a
decision first** for end-to-end checks, migrations and booting the app: where
they run, if not at every gate.

### B53 — a repository that states no anatomy

ADR-026 has the planner read how a repo builds a module from what the repo
states; one that states nothing sends it back to the source, and its `NOTES`
ask the human for the statement. Only the setup skill drafts one, and only
when someone runs it. **Candidate:** a cheap scout drafts the anatomy during
the run and the human approves it at sign-off. During a run ADR-034 lets the
session write only `.claude/state/` and `specflow/`, so `CLAUDE.md` or a skill
would be written by an agent, or after `done`. **Needs a decision first:**
whether a run writes the statement at all, and which agent does.

### B55 — the implementer on the cheapest tier

On `sonnet`, the implementers of the one real run on `80feaea` or later cost
at least US$1.16 for two milestones; `haiku`'s prices are a twentieth of
`sonnet`'s. Decided by a paired experiment, not by price: the same milestones
on both tiers at the same session effort, on an engine at `80feaea` or later
(ADR-038), with the advisor off, plugin auto-update off, and `engine=`
naming a commit on every gate line. Compared on gate attempts per milestone,
architect calls, test-first and cost. **Done:** the result
recorded in `decisions/`, whichever way it goes.

### B60 — milestones in parallel, each on a branch of its own (opt-in)

A run implements M1..Mn one after another on one branch, and the gate judges
one tree: the project directory's HEAD, at the orchestrator's stop
(`hooks/lib/io.mjs`). The planner already writes each milestone's `Depends on`,
so those that depend on nothing pending could each run in a worktree on its own
branch (`Agent` takes `isolation: "worktree"`). Opt-in, in
`.claude/spec-flow.config.json`, since every milestone leaves a branch behind
for `done` to delete. Kept local, the branches never reach the remote, and a
cloud container takes an unmerged one with it. What stands in the way:

- **Green apart is not green merged.** The merge is a commit no gate has
  judged, and `done` needs a pass on the current commit (ADR-022), so it is
  gated either way; a gate per branch is an earlier signal, not the verdict.
- **The specs conflict.** A milestone writes its requirements into
  `specs/<capability>.md` with its test; two branches that each append one to
  the same file conflict on merge (probed in a scratch repo). Resolving it is
  writing, which the orchestrator does not do (ADR-034): an implementer pass.
- **The run's state is single:** `phase`, `gate_attempts`, and
  `current-milestone`, which `resume` reads (ADR-024). Unmeasured: whether a
  hook fired in a worktree agent reads the worktree or the project directory,
  where `lint-on-write` and `no-gate-cmds` read the phase that arms them.
- **It saves time, not tokens.** Each implementer starts cold either way, and
  suites run side by side share ports, databases (B48) and the Stop hook's
  1800 s.

**Needs data first:** in real plans, how many milestones after M1 depend on
none before them; a chain gains nothing. **Then a decision:** a gate per branch
(the gate learns to judge a tree other than the project directory) or parallel
implementers and one gate on the merge (the gate unchanged, a failure routed
to the milestone whose files it names). **Done:** the ADR, and a gate-fixture
case in which two branches green apart are red merged and the run does not
reach `done`.

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
- **A database for parameters or state.** The contract is committed so that a
  change to it shows in a diff, the only record ADR-046 leaves of one made
  mid-run; the preferences file holds caps and routes; `.claude/state/` is one-word files
  every hook reads and a person resets with `printf`, and append-only logs whose
  archive is committed as text. `node:sqlite` is experimental on Node 22, a
  floor CI runs (ADR-019): flagged below 22.13, a release candidate only from
  24.15. A native package breaks "the plugin is the whole install". What weighs
  is how many keys there are, not where they live: B39.
