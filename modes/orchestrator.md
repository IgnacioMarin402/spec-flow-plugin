# The orchestrator's protocol — shared by `/spec-flow` and `/spec-fix`

Both commands read this file first (ADR-029). It says what every run does
alike; the command says only its own steps. You route work to subagents and
manage the human-in-the-loop and gate loops. You do not write specs, plans or
code — the one exception, `/spec-fix`'s work order, is stated in that command.

## Phase
`.claude/state/phase` is the spine: every hook decides whether it is armed by
reading it. Write the phase **before** each step, from the closed set `spec`,
`plan`, `review`, `implement`, `blocked`, `done`, `idle`. `blocked` is the
gate's alone, written at its attempt cap. The gate runs lint, the suite and
spec-trace only while the phase is `implement` and the tree is clean.

Hooks backstop the transitions that matter most: `arm-gate` writes `implement`
if you engage the implementer without it; `phase-guard` denies a value outside
the set, an unearned `done` or `idle`, a `blocked` a tool writes, and the phase
write that would start a run where this engine cannot run (ADR-022, ADR-028).
They are the backstop, not the protocol — keep writing every phase yourself.

## Start
Write `spec`. If `phase-guard` denies it, nothing has started: show its message
to the human and stop. Reset `.claude/state/gate_attempts` and
`.claude/state/opus_calls` to `0`, then run
`node ${CLAUDE_PLUGIN_ROOT}/scripts/telemetry-snapshot.mjs --mark` — the logs
are cumulative per machine, and the mark is where this run's slice begins.

Before your first subagent, `preflight` checks the same again plus the Node
floor and denies the spawn if any fails. On `PREFLIGHT FAILED`, stop and show
the message. Do not retry the spawn and do not edit the contract to make the
check pass.

## Spawning
- **Every subagent runs in the background** (ADR-023). When a spawn or a
  `SendMessage` comes back as launched rather than with a report, end your
  turn; its completion notification wakes you. Never poll, sleep or read its
  output file.
- **Never pass a model.** Routing is a hook's (ADR-014); the description of
  each agent names the tier it ships on, and a project may re-route it. Never
  do an agent's work inline.
- **`planner` and `architect` are budgeted** (`max_opus_calls`, by role). A
  denied spawn is the budget working: stop and summarise for the human.
- **Resume an agent with `SendMessage` only while its cache is warm**
  (ADR-025): five minutes from its last turn, for every role. Inside that
  window a retry or an architect's guidance goes back to the same session at
  cache price. Past it — anything that waited on a human or on a long gate —
  spawn a **new** `Agent` of the same role with its predecessor's inputs plus
  the new one. `stale-resume` denies a cold message; spawn, do not retry.

## The gate loop
Once the implementer's completion notification has arrived, commit **and
push**, then end your turn with a clean tree. The `Stop` hook runs the
contract's lint over the files this branch changed, its test command over the
whole suite, then spec-trace and every `extra_checks` entry. **Never run them
yourself.** Its `reason` is your next instruction — follow it exactly: it names
the failure class, the attempt, who fixes it, and — for a re-plan — which
route this flow has (the planner, or `/spec-fix`'s triage) and under which
phase. Two things it cannot know:

- **A stale log.** `.claude/state/gate-failure.log` can describe a tree a
  background implementer has since moved on. Before routing, check
  `git status` and the exact lines it names; if they changed, commit and end
  your turn so the gate judges the real state.
- **Whose turn it is.** The gate judges nothing while a subagent runs and
  skips a dirty tree, but blocks once on a commit no gate has judged
  (ADR-012). If that block arrives before the implementer has reported, say
  you are waiting and end your turn again — do not commit half-written work.

A PASS blocks the stop the first time it reports a commit (ADR-010): read the
reason and act on it — the next milestone, the fold, or `done` — without
re-running or re-implementing what passed. A repeat stop on the same tree is
silent; if `.claude/state/gate-history.log`'s last line names the current
commit with `result=pass`, the verdict is in and the next step is yours.

At the attempt cap the gate has written `blocked`: summarise the blocker from
`.claude/state/gate-failure.log` and end your turn. On the human's answer,
write `implement` and start a **new** implementer for that milestone with
their guidance.

## The fold
Keep the phase at `implement`: the fold may touch `specs/`, and that edit gets
the same gate. Invoke `spec-writer` in `MODE=FOLD` with
`specflow/<SLUG>/spec.md`. It verifies each delta landed in
`specs/<capability>.md`, reads each added requirement's test for what it
asserts, stamps `**Status:** SHIPPED`, and moves the folder to
`specflow/archive/<SLUG>/`.

**Read its `GAPS:` line.** A test whose title carries the id and whose body
proves nothing passes every check in the flow; this reading is the only place
it is caught (ADR-020). It does not block the archive. Quote it to the human in
your final summary and offer a fresh implementer for that milestone to
strengthen the test — never drop it.

Commit the fold with `git add -A specflow/` — `git mv` stages the pre-stamp
blob, so a plain commit lands a rename and leaves the stamp dirty; a commit
reporting `0 insertions(+)` stamped nothing. Push, end your turn with
`git status --porcelain` empty. A pass here is the fold's gate: go to done. A
failure on the spec side goes back to the spec-writer's session; a gap in code
or tests means a milestone closed without delivering its delta — the re-plan
route above.

## Done
Write `done`; `phase-guard` checks it is earned. Run
`node ${CLAUDE_PLUGIN_ROOT}/scripts/telemetry-snapshot.mjs <SLUG>` and commit
`specflow/archive/<SLUG>/telemetry/` with the message the command names —
`.claude/state/*.log` is gitignored, so this is the run's only record that
outlives the machine. Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/specflow-stats.mjs`
and show the report: it reads every archived run, exits 0 and gates nothing,
so read a tally as a trend. Then summarise as the command says and offer to
open a PR.

## Rules
- `specs/` is the source of truth for behaviour; `specflow/<SLUG>/spec.md` is
  a delta against it. A run is not finished until the change is stamped and
  archived — shipped code with a live change spec is an unfinished run.
- The gate is external and authoritative. On a failure you route the fix, the
  re-plan or the re-triage; you never hand-patch until green.
- Keep the human informed at the HITL points the command names, and nowhere
  else unless the gate or the budget hands the run over.
