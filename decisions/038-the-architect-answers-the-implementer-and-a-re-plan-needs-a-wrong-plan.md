# ADR-038 — the architect answers the implementer, and a re-plan needs a wrong plan

**Date:** 2026-10-11 · **Status:** accepted · **Governs:** `agents/architect.md`, `agents/implementer.md`, `agents/planner.md`, `commands/spec-flow.md`, `commands/spec-fix.md`, `commands/resume.md`, `hooks/opus-budget.mjs`, `scripts/agent-contracts.mjs`, `REFERENCE.md`, `BACKLOG.md` · **Related:** ADR-014, ADR-015, ADR-023, ADR-025, ADR-029, ADR-037

**Question.** Who answers the implementer's technical doubts, and who answers
the planner's? When is a plan revised, and what bounds each escalation?
Claude Code's advisor tool puts a second model inside a request: should it
replace the architect?

**Measured.**

- The architect route had never run. Seven archived runs hold no architect
  return. The three `NEEDS_ARCHITECT` lines of 2026-08-26 were read off the
  spawn's echo of the orchestrator's prompt, a `run-trace` defect fixed in
  `7737a2e`. Each was logged as an implementer was launched, and every one of
  those milestones passed its gate.
- A forced escalation in a throwaway copy of an adopting repository (Claude
  Code 2.1.296, auto permission mode, the advisor off):
  - the implementer returned `NEEDS_ARCHITECT` in 9 s;
  - the architect (Opus, effort high) answered in 2m39s, about US$0.56 at API
    prices. Its `IF_PLAN_WRONG` began "Not a blocker, but the spec should be
    revised", and the command re-plans on any value but "none";
  - the planner re-planned in 1m55s, about US$0.48;
  - the `SendMessage` resumed the implementer 4m44s after its last turn, 16 s
    inside its cache's 5 minutes, and its context came from cache.
- The advisor (2.1.296):
  - once enabled, it reaches the main loop and every subagent, the implementer
    included. Enabling it is the human's: `advisorModel`, `/advisor` or
    `--advisor`;
  - a consultation sends no question: the advisor reads the whole
    conversation. At a 20k-token context, one took 8 s and read 20,139
    uncached input tokens plus 658 output on Opus. Opus and Fable return the
    advice encrypted;
  - its tokens are in `usage.iterations` as `advisor_message`, outside the
    usage `token-trace` and the live view read;
  - Claude Code documents no setting to cap advisor calls, and as a server
    tool it passes no command hook.
- Routing already takes `fable`: `agents.architect: "fable"` rewrites the
  spawn.
- Without a terminal the run did not start until auto mode. `.claude/` is a
  protected path: allow rules do not pre-approve a write there, and `default`
  and `acceptEdits` ask a human who is not there.

**Decision.**

- An implementer's technical or design doubt goes to the architect, the
  architect advisor. Its id stays `architect`. It runs on Opus unless a
  project routes it to another tier, such as Fable, as it routes any agent.
  Its guidance goes back to the same implementer, with no planner in between.
- A re-plan needs a plan that cannot work. Either the implementer returns
  `BLOCKED`, or the architect sets `IF_PLAN_WRONG` because following the plan
  cannot meet the spec. A decision the plan left open is answered in
  `DECISIONS`. A suggestion that blocks nothing goes in `NOTES`, which the
  human sees and nothing routes on. `agent-contracts` now holds the
  architect's return to the commands.
- The planner's own doubt goes to the advisor, where the human enabled one.
  spec-flow does not enable it. The implementer does not settle a design doubt
  with it.
- Each escalation role has its own budget. `max_architect_calls` (default 3,
  counter `architect_calls`) caps the architect. `max_opus_calls` keeps its
  name and now caps the planner alone.
- REFERENCE states that a run without a terminal needs `--permission-mode
  auto` or `bypassPermissions`.

**Refused.**

- **Replacing the architect with the advisor.** No budget could be enforced:
  there is no cap and no hook sees a consultation. The advice is encrypted, so
  it leaves no record and no `IF_PLAN_WRONG`. Each consultation re-reads the
  whole conversation uncached, so a long implementer pays more for it than the
  architect pays to start fresh.
- **Renaming the agent.** The id is in commands, hooks, the registry, the
  budget, and the routing files repositories have already written.
- **Resuming the implementer before a re-plan to stay inside its cache.**
  Without the reflexive re-plan, the resume lands near 3 minutes. A colder one
  is denied by `stale-resume` and costs a fresh implementer, which at the
  start of a milestone is about 22k tokens of Sonnet.
- **Counting the advisor's tokens in this change.** BACKLOG B44.

**Cost.**

- A project that set `max_opus_calls` to cap both roles now allows that many
  planner calls plus three architect calls.
- An implementer's design doubt costs a deep agent's run, measured at minutes
  and about half a dollar, where an advisor would answer in seconds. That is
  the price of a budget and a record.
- The planner's advisor calls are neither budgeted nor counted until B44.
