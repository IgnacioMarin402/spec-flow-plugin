# spec-flow

**A feature ships only when a test that actually ran proves every requirement
in its spec.** The failure this closes is the quiet one: a requirement everyone
believes is covered, and no test that proves it.

spec-flow is a spec-driven multi-agent pipeline for Claude Code. A free-text
requirement becomes a spec you sign off on, a milestone-by-milestone plan, a
review pass, and an implementation loop gated by lint, tests and requirement
traceability running **outside the model**.

Two commands — `/spec-flow` for a feature, `/spec-fix` for a defect — drive
five subagents, each on the model tier its job needs. **It supports Node
projects.** Inside that scope it has no opinion about your framework or your
architecture, because **it reads no source code**: it runs the commands your
repo declares in one file, `.spec-flow/config.json`, and reads their output.

Every field, table and flag is in **[REFERENCE.md](REFERENCE.md)**.

---

## Requirements

- Claude Code, and a git repo with a base branch you branch off of
- **A Node project** — a `package.json` declaring how you test and lint.
  Nothing refuses to run on another stack, and a contract filled in by hand may
  well work there; it is simply not tested or supported.
  [Why the scope is Node, and what was refused](decisions/007-the-supported-scope-is-node.md)
- Node 20+ — enforced: a run refuses to start below it, and every check here
  runs on 20, 22 and 24
- **Linux or Windows** — both exercised by CI, on each of those Node versions.
  macOS is not, and nothing refuses to run there: the contract `init` writes is
  the same file on every platform, and this engine has no platform check at
  all.
  [Why the contract is platform-neutral](decisions/011-the-contract-is-platform-neutral.md) ·
  [ADR-019 — why the matrix covers the floor and the platform](decisions/019-ci-runs-the-floor-it-imposes.md)
- A linter and a test runner you can invoke from the command line

## What is yours and what is the engine's

The engine knows nothing about your project that you have not told it. That is
the design, and it means the list of things only you can supply is short,
finite, and worth seeing before you start.

| Yours | The engine's |
|---|---|
| **The contract** — which commands lint and test, what is in scope, where specs live. `init` reads most of it off your repo and reports what it could not | Running those commands, scoping lint to the changed files, never scoping the suite |
| **Confirming the reporter flag** `init` added, so your suite writes a report saying which tests RAN — and supplying it yourself if your runner is not one it knows | Proposing that flag, parsing the report — JUnit XML or TAP — binding each requirement to a test that executed, in both directions, and refusing when it cannot tell |
| **Writing the specs' words** — at sign-off, you approve what the system will claim to do | Refusing to let a requirement stay unproven, or a test prove something no spec declares |
| **The judgement calls** — the sign-off, a `WRONG-SPEC` confirmation, and any run the gate hands back after five failures | Everything between those: planning, review, implementation, and the checks that run outside the model |
| **Keeping Node and Claude Code current** | Refusing to start on a Node it does not support, and recording the Claude Code that ran each gate |

Nothing else is asked of you mid-run. If the engine stops and waits, it is one
of the rows above, and it says which.

## Install

Run it from your repo's root, on a branch off your base branch:

```bash
claude plugin marketplace add IgnacioMarin402/spec-flow-plugin
claude plugin install spec-flow@spec-flow-marketplace

npm install --save-dev github:IgnacioMarin402/spec-flow-plugin
npx spec-flow init      # writes .spec-flow/config.json
npx spec-flow check     # green here means green at the gate
npx spec-flow models    # which model tier each agent will run on, and who decided
```

**The command is `spec-flow` and this engine is not on npm at all** — that name
belongs to an unrelated package there, and `spec-flow-plugin` is published
nowhere. Install first, from the line above: `npx spec-flow` in a repo that has
not installed it reaches the registry and runs a stranger's code.

**No code is yours to write, and on a conventional project no configuration
either.** `init` reads your test and lint commands off `package.json`, adds
your runner's reporter flag to the test command, and writes a contract the
engine can run; the last line proves it. Below is what each step is for, to be
read when one does not do what you expected.

**1. The plugin** brings the commands, the agents and the hooks. Nothing else
in this list is Claude-Code-specific.

**2. The engine as a devDependency, from this same repository**, because the
same checks have to run outside a session — your terminal and CI have no
`${CLAUDE_PLUGIN_ROOT}` and no Claude Code. The dependency is a git spec rather
than a registry name on purpose: **nothing here is published to npm**, so the
plugin and the dependency are one repository and cannot drift into two
versions ([ADR-016](decisions/016-one-repository-one-distribution.md)). Append
`#<commit-or-tag>` to pin CI to a commit rather than following `main`. It has
**no runtime dependencies** of its own, and every command runs from your repo's
root with no arguments and no environment variables.
[The commands, and the by-path route for a repo that cannot take the dependency](REFERENCE.md#cli).

**3. The contract.** `init` reads what your repo already declares — your `test`
and `lint` scripts, where your tests live, your base branch — writes
`.spec-flow/config.json`, and scaffolds `specs/`. **It never invents a value it
could not determine**, so it sorts every field into `detected`, `REVIEW` or
`MISSING` and exits non-zero until nothing is missing.

**Your suite has to say which tests RAN**, because a test that was skipped must
not count as proof — otherwise skipping is the cheapest way to silence a red
suite. That comes from a report your runner already knows how to write:

```json
"report": { "format": "junit", "path": "reports/junit.xml" }
```

`init` appends the flag that produces it to your test command, for the runners
this engine supports, and marks it `REVIEW` so you see the edit. It is a flag
and never a script: the engine parses JUnit XML and TAP itself, because
`<skipped/>` and `# SKIP` are defined by those formats rather than by any
runner. If your runner is one it does not know, it says so and leaves the flag
to you. **Until the report lands, traceability is simply off** — the gate still
lints and tests — and it turns itself back on the moment you declare a
requirement, refusing rather than passing quietly.
[Both proof sources, and the escape hatch for runners with no standard report](REFERENCE.md#what-makes-a-requirement-proven).

**If `init` left `MISSING` lines, a Claude Code session can finish the job.**
Ask it to set up spec-flow in this repo: the plugin ships a setup skill that
fills what `init` could not read — most often a `test` script that runs through
an interpreter rather than a named runner — and then *proves* the result by
running your suite and the check below. It cannot be wrong quietly: the last
thing it does is run step 4, and step 4 goes red when the report does not land.

**4. Check it.** `check-changed` lints what this branch changed, runs your
suite, and runs the traceability check — the same commands the gate will run,
through the same file.

Staying current is one command — `/plugin marketplace update` — or none, if you
turn on Claude Code's background auto-update for this marketplace. Step 2 does
not follow on its own: it is a git spec, so it moves when you move it, and
nothing warns you that the two halves are on different commits. [Both routes,
and why the update lands here and does nothing on some
plugins](REFERENCE.md#staying-current).

## The five subagents, and what they run on

| agent | what it does | ships on |
|---|---|---|
| `spec-writer` | Turns the requirement into a spec, triages a defect, folds a shipped change back into `specs/` | Sonnet |
| `planner` | Turns the approved spec into milestones, and is the escalation consultant | Opus |
| `reviewer` | Reads the plan against the spec once, before an implementer is spent | Haiku |
| `implementer` | Implements exactly one milestone | Sonnet |
| `architect` | Consulted on demand when the implementer hits something design-sensitive | Opus |

**Those are tiers, not versions.** Each agent's frontmatter names `opus`,
`sonnet` or `haiku`, and Claude Code resolves that to the current model of the
tier — so an agent follows its tier forward instead of freezing on the model
that was best the day it was written ([ADR-013](decisions/013-an-agent-names-a-tier-not-a-version.md)).

### Changing one

```json
{
  "max_opus_calls": 6,
  "agents": { "reviewer": "sonnet", "architect": "sonnet" }
}
```

That is `.claude/spec-flow.config.json` in **your** repo — not the engine's
contract, which holds architectural facts rather than preferences. A
`PreToolUse` hook applies it when the spawn happens, so the orchestrator is
never asked to pass a model and cannot forget to. An entry naming an agent that
does not exist, or anything that is not a tier, **denies the spawn** and says
which entry is wrong: a routing block that reads as though it works and routes
nothing is the failure this engine exists to close.

```bash
npx spec-flow models
```

prints what each agent will actually run on and **which layer decided it** —
the plugin's default, your override, or a version pin. Three layers decide it
and no single file shows more than one, so this is the only honest answer.

### Pinning an actual version

A tier is per agent; a version is per session, and it is Claude Code's setting
rather than this engine's. In your repo's `.claude/settings.json`:

```json
{ "env": { "ANTHROPIC_DEFAULT_OPUS_MODEL": "<a full model id>" } }
```

The id is whatever `/model` lists. It is deliberately not spelled out here:
an example naming one would be stale within a release, which is the rot this
repo's own check refuses — and that check caught this very line while it was
being written.

That changes what `opus` means everywhere in the session, including for your
own turns. `spec-flow models` reports the pin and names the file it came from.

### Effort

Effort is the second axis, and it does **not** work like the tier. Three of the
agents declare their own; the other two follow your session:

| agent | effort |
|---|---|
| `reviewer` | `low` — its prompt already says it is the cheapest pass, and escalating is its escape hatch rather than thinking harder |
| `planner` | `high` — it writes the artifact every later pass is judged against |
| `architect` | `high` — it is reached only once a cheaper agent failed to decide safely |
| `implementer` | your session's — the milestone decides the work, and its difficulty is the plan's claim |
| `spec-writer` | your session's — it asks you when unsure instead of thinking harder alone |

So the two that follow your session are the lever you have, in
`.claude/settings.json`:

```json
{ "effortLevel": "high" }
```

**A project cannot set effort per agent, and that is measured rather than
assumed.** A spawn silently discards an `effort` key: sent one alongside four
other keys with deliberately invalid values, the schema complained about
`isolation` — the one it knows — and dropped the rest without a word. An
`effort` entry in the routing block would validate, write, transmit and do
nothing, which is the single failure this engine exists to refuse, so it is
not offered ([ADR-015](decisions/015-effort-is-declared-where-the-role-is-emphatic.md)).

Changing the three declared values is a change to the engine's defaults rather
than to your config — open an issue. `spec-flow models` marks every row
`(agent)` or `(session)` so you can always see which of the two you are
looking at.

### None of it resets

Every value above lives in a file the engine reads fresh: the routing on each
spawn, the settings at session start. Opening a new conversation does not
restore defaults. What *does* reset is anything you set only for the current
session — `/model` switched with `s` in the picker, or an `/effort` level that
applies to the session only. Put it in a file and it survives.

## Your first run

```
/spec-flow users can reset their password by email
```

What happens:

0. **The run refuses to start** if the contract does not load or the base
   branch does not resolve. That check costs nothing — no agent has run yet —
   and it is why step 3 of the install matters.
1. **The spec-writer asks you questions** if the requirement is ambiguous.
   Answer in the chat.
2. **You sign off.** It shows the requirement deltas and the decision, and
   waits. This is the last moment "no" costs nothing. A rejection is stamped
   and archived, not deleted.
3. **Plan, review, then implementation** — one milestone at a time, each in a
   fresh implementer session, test-first per requirement.
4. **The gate runs when the turn ends.** Green blocks the stop and tells the
   orchestrator to advance; red blocks it and tells the orchestrator what to
   fix.
5. **Fold and done.** The change spec is verified against `specs/`, stamped
   SHIPPED, archived with the run's telemetry.

**A pass wakes the orchestrator, once per commit** (ADR-010). The first time
the gate reports a given commit as green, it blocks the stop the same way a
failure does, so both you and the orchestrator see it — a milestone advances
on its own, with nothing to type:

```
Stop says: spec-flow: gate PASSED — 6fdfb93 (eslint 0, npm test 0, spec=0).
Advance the run now: start the NEXT milestone with a fresh implementer
Agent call, or if none remain, invoke spec-writer in MODE=FOLD; if this
was the fold's own gate re-run, write 'done' into .claude/state/phase.
```

A second stop over the same commit — nothing new committed — stays silent to
the model instead, so the run is not asked to act on the same pass twice.

If it stops and asks for a human, read `.claude/state/gate-failure.log`.

---

## How it works

Nothing coordinates a run but `.claude/state/phase` — no queue, no daemon, no
shared memory between agents. A subagent finishes, the orchestrator's turn
ends, and a `Stop` hook runs the checks outside the model and either allows the
stop or blocks with the instruction for what to do next.

- **The orchestrator never writes code.** It routes. Everything that produces an
  artifact is a subagent on the model tier its job needs.
- **The gate is not a step in the pipeline** — it is what happens when the
  pipeline stops. Its block message *is* the next instruction.
- **The first pass on a commit blocks too**, on the same channel a failure
  uses (ADR-010) — a green milestone advances the run on its own, and you see
  it happen. A repeat stop on that same commit is where the free ride is: it
  renders no decision, so it costs nothing and wakes nobody.

The three flowcharts — a feature, a defect, and the gate's own routing — are in
[REFERENCE](REFERENCE.md#how-a-run-unfolds), along with the reasoning behind
each branch.

## Developing the engine

```bash
npm install
npm run lint          # eslint over hooks/ and scripts/
npm run typecheck     # tsc --noEmit
npm run check         # no coupling to any one consuming repo
npm run paths:check   # every ${CLAUDE_PLUGIN_ROOT} path resolves
npm run init:check    # what `init` generates actually validates
npm run gate:check    # the gate holds under its own failure modes
npm run trace:check   # the requirement/proof binding holds
npm run report:check  # the report readers, against real emitters' output
npm run stats:check   # the telemetry report's session-reuse numbers
npm run hooks:check   # the other nine hooks
npm run agents:check  # the planner and the reviewer agree about the milestone
npm run skill:check   # the setup skill and the engine agree about the contract
npm run pack:check    # a git spec installs and works from node_modules
npm run cold:check    # a Node repo, from zero to green, installing nothing
```

All of these run in CI on every push and PR, and none of them needs the
network. The last one is the only check that fails when *adoption* breaks
rather than a piece of the engine: it takes a Node repo from nothing to a green
`spec-flow check` through the route documented above, running the scripts by
path so that the claim it proves is `init`'s and not an install's.

---

## License

MIT — see [LICENSE](LICENSE).
