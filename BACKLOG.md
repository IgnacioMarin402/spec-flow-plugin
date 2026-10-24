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
branch loses with its container. With the session on Sonnet, on `a64bd7a`
(headless, one milestone, one re-plan from review): 33 orchestrator messages
at ~67k prompt each, 2.2M of the run's 2.6M cache-read tokens, no repository
file read outside `specflow/`; US$1.39 in all as Claude Code totals it, US$0.54
of it the planner on Opus.

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

### B60 — `init` copies the repo's `--fix` into `lint_no_fix`

A `lint` script that carries its own autofix (`eslint --fix .`) becomes
`verify.lint_no_fix` as is, reported as detected, while the REVIEW line says no
autofix was declared. On `a64bd7a`, `spec-flow check --no-fix` rewrote a `let`
to `const` in a changed file and printed OK: a report-only check that fixes and
passes, which in CI is a check that looks armed and is not. **Done:** an
`init-fixture` case whose lint script carries `--fix`, red on `a64bd7a`, where
`lint_no_fix` does not carry it or the field is REVIEW and names the flag.

### B61 — `orchestrator-scope` reads a quoted `>` as a redirect

`bashWrites` keeps quoted text when it matches redirects, so a `>` inside a
quoted argument followed by more text becomes a write target. Denied mid-run on
`a64bd7a`: `git commit -m "map A -> B"`, and a message whose
`Co-Authored-By: … <mail>` trailer is followed by another line. A real run hit
the second at its milestone commit and got past it with `git commit -F` from a
scratch file. **Done:** both as `hook-smoke` cases, red on `a64bd7a`, with a real
redirect outside the writable paths still denied.

### B62 — a command that does not expand starts no run, and nothing says so

Under `claude -p` on 2.1.310, with the plugin loaded by `--plugin-dir`, the
command registers as `spec-flow:spec-flow`; a prompt typed
`/spec-flow <requirement>` reached the model as text. The session implemented
the requirement itself: no phase, so no hook armed, no spec and no gate, and it
widened an existing requirement in place — the `CHANGED` ADR-009 refuses. How
the interactive prompt resolves the short name is not measured. **Candidate:**
`human-turn` already hears `UserPromptSubmit`; an unexpanded `/spec-flow` or
`/spec-fix` is answered with the name that runs. **Needs first:** what that
payload carries for an expanded command and for an unknown one. **Done:** a
`hook-smoke` case for the unexpanded prompt, and the README naming the form a
headless run needs.

### B63 — a subagent's return is read before it is written

On 2.1.310 (headless, `a64bd7a`) the `SubagentStop` payload carries no
`last_assistant_message` — `run-trace-unmatched.log` lists its keys — so
`handedBack` reads the `SubagentHandback` call from the agent's transcript, and
at that moment the line is not always there; every transcript held it
afterwards. On one run of 8 agents, `run-trace` recorded 5 returns (the
reviewer's `CHANGES_REQUESTED`, the planner's revision and the fold's `FOLDED`
are missing) and `agent-gate` logged `skip why=empty` for 4. `specflow-stats`
then printed `reviewer: 1 APPROVED`, the row ADR-039 says will show whether the
reviewer earns its tier. **Done:** a fixture whose handback line lands after the
hook's first read, red on `a64bd7a`; on a real run, every spawned agent's
return recorded.

### B64 — the harness behaviour the engine rests on is re-measured by nobody

Each fixture pins a payload shape measured once on one build: `background_tasks`
on `Stop` (ADR-023), `agent_id` on tool calls (ADR-034), cache lifetimes read
off transcripts (ADR-025), `CLAUDE_CODE_SESSION_ATTENDED` (ADR-023), the
handback (B63), how a command name resolves (B62). B63 is one that moved, and
every fixture stayed green. **Candidate:** a scheduled job, off the push
workflow whose checks need no network (ADR-019), that runs one real
`/spec-flow` under `claude -p` on a frozen throwaway repo with a canned
requirement and canned answers, and asserts the telemetry: every phase
reached, every spawn's return recorded, no `*-unmatched.log` line. It needs a
key in CI and costs a run. **Done:** the job, red on a build where B63
reproduces.

### B65 — a spec defect found after sign-off reaches no person before code

On one real run the planner's `NOTES` named two spec bugs: an Assumption on
timestamp ties that a requirement contradicts, and a requirement no test can
falsify with the repo's event types. `NOTES` stop nothing. The reviewer then
asked for a plan that honours the Assumption or a re-signed Assumption; the
orchestrator chose the first on its own, and the code gained a tie-break rule
no requirement asks for. The unfalsifiable requirement shipped and came back
as the fold's `GAPS`. Both were found while no code existed, the cheapest
moment to ask. **Candidate:** a planner and reviewer status that routes the
finding to the sign-off (phase back to `spec`), and Assumptions that say
whether they bind or leave a behaviour unspecified on purpose. **Needs a
decision first:** whether a finding after sign-off may stop a run, and who
calls it a spec bug rather than a plan note.

### B66 — the fold reads a test with no evidence beside it

ADR-020 measured that a report cannot say whether a test asserts. A mutation
run can say which changes to the code no test noticed, and the engine would
still read a report, not source (ADR-005). On the run behind B65, Stryker over
the changed file took 9 s, and its one surviving mutant on the requirement's
line (`sorted.at(-1)` -> `sorted.at(+1)`) was the gap the fold named. On a
requirement whose test was weakened to `toBeTruthy()`, `spec-flow check` stayed
green while the share of mutants killed fell from 73% to 47%. A kill is not
exactly attributable to a requirement: a mutant records the first test that
killed it. **Candidate:** a report, never a gate (ADR-020) — the surviving
mutants on the change's files, handed to `MODE=FOLD` as what its `GAPS`
reading starts from. **Done:** that report read over three real runs before
anything leans on it.

### B67 — a framework scaffold's own scripts do not survive `init`

A common scaffold's defaults: `lint` quotes its glob, so `verify.lint` is
MISSING; `test` is jest, whose report needs `jest-junit` installed and
configured; `build` is offered as an extra check. Each is reported correctly,
and the adopter still finishes the contract by hand or runs the setup skill
before the first run. **Candidate:** the setup skill covers all three from the
scaffold's own `package.json`, with no per-framework table in the engine
(ADR-002). **Done:** a `cold-start` case from that `package.json` to a green
check through the documented route.

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
