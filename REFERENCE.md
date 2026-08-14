# Reference

Look-up material. For what spec-flow is and how a run unfolds, see the
[README](README.md).

- [The contract](#the-contract) — every field of `.spec-flow/config.json`
- [Four rules the contract cannot express](#four-rules-the-contract-cannot-express)
- [The base branch](#the-base-branch)
- [The second config file](#the-second-config-file)
- [Project skills](#project-skills)
- [Commands and agents](#commands-and-agents)
- [CLI](#cli)
- [Hooks](#hooks)
- [Phases](#phases)
- [`.claude/state/`](#claudestate)

---

## The contract

Everything the engine needs to know about your repo, at
`.spec-flow/config.json`. Missing or malformed stops the run with a message
naming what to add — there is no fallback that guesses a test runner or a
proof directory for a repo it has never seen.

`spec-flow init` generates this file from your repo and reports what it could
not determine. Use the tables below to fill those in, or to change what it
wrote. To re-read the contract as the engine sees it at any time:

```bash
node node_modules/spec-flow-plugin/scripts/spec-flow-config.mjs
```

### `verify`

| key | required | what it is |
|---|---|---|
| `scope_globs` | yes | Which files count as in-scope, e.g. `["*.ts"]` |
| `lint` | yes | argv that lints, autofix on. Receives changed file paths appended |
| `lint_no_fix` | yes | Same, report only. Used by `spec-flow check --no-fix` |
| `test` | yes | argv that runs the suite. Invoked with **no** extra arguments |
| `test_name` | yes | Names the runner in log sections, e.g. `"vitest"` |
| `lint_name` | yes | Names the linter in log sections |
| `lint_config_hint` | yes | Where your lint rules live, quoted back when a rule fires |
| `base_ref` | no | The ref this branch is judged against. Omit to auto-resolve |

### `trace`

| key | required | what it is |
|---|---|---|
| `specs_dir` | no | Where capability specs live. Default `specs` |
| `proof_dir` | yes | Directory segment that marks a test as proof, e.g. `test` |
| `proof_suffix` | yes | Test filename suffix, e.g. `.test.ts` |
| `not_a_capability` | no | Filenames under `specs_dir` that are not specs. Default `["README.md", "glossary.md"]` |

`proof_dir` and `proof_suffix` do two jobs: they are what `spec-trace`
searches, **and** where the planner and implementer are told to put a new
test. An agent that writes its test elsewhere produces a requirement that
reads as unproven and a gate that blocks on a test which exists and passes.
Set them to where your tests actually live.

**An empty `specs_dir` passes, but only until your first ship.** With no
capability specs there are no requirements, so "every requirement is proven"
is true of the empty set. That is correct while adopting — capability specs
are written *by* the flow, as milestones fold their deltas in, so requiring
them before the first run completes would block adoption on an artifact the
run produces.

The grace ends at the first change stamped `**Status:** SHIPPED`. That stamp
is the fold asserting its deltas landed in `specs_dir`, so SHIPPED with an
empty spec layer is two records contradicting each other and `spec-trace`
fails. If you hit that and your specs do exist, check `trace.specs_dir` —
they are somewhere this contract does not look. `REJECTED` and `SUPERSEDED`
assert nothing landed, so they keep the grace.

### `extra_checks`

Your own project checks, run at every gate and again at `done`. Each entry:

| key | required | what it is |
|---|---|---|
| `name` | yes | Shown in gate output |
| `cmd` | yes | argv, e.g. `["node", "scripts/my-check.mjs"]` |
| `field` | yes | The key it writes in `gate-history.log` |
| `green` | no | Line printed when it passes |
| `hint` | no | Appended to the block message when it fails |
| `class` | no | `"lint/trace"` (route as an edit, default) or `"behaviour"` (route as a re-plan) |

A check whose `cmd` names a repo-local script you have not written yet is
skipped, not failed — a repo mid-adoption is not blocked by its own pending
check. A check that names a binary or inline code is always run.

### `unscoped_denied`

What the engine redirects when an agent tries to run the whole suite
mid-milestone instead of the scoped form.

| key | what it is |
|---|---|
| `scripts` | Package scripts denied while implementing, e.g. `["test", "lint"]` |
| `tools` | Binaries denied directly, e.g. `["vitest", "eslint"]` |
| `scoped_allowed` | Scripts that stay allowed, e.g. `["check"]` |
| `scoped_alternative` | What to run instead, quoted in the denial |
| `scoped_examples` | Concrete allowed invocations, shown in the denial |

This is a consistency guard, not a security boundary — it is evadable and says
so in its own source. It exists to keep whole-suite output out of an agent's
context, not to stop a determined agent.

---

## Four rules the contract cannot express

**`.claude/state/` must be gitignored.** The gate writes there on every run.
Tracked, the tree is never clean again and the gate's quiescence guard skips
every run after the first — forever, silently. The gate filters that path out
of its own dirty check as a second line of defense; gitignoring it is what
keeps `git status` legible.

**Do not add `--passWithNoTests`** (or any equivalent) to `verify.test`. A
flag that makes an empty run exit 0 makes *every* run that matches nothing
exit 0 — a green gate over zero executed tests.

**`verify.test` must finish inside 1800s.** The gate is a `command` hook on
`Stop`; a hook that hits its timeout is canceled, renders no decision, and a
Stop hook with no decision **allows the stop**. That happens a layer above the
gate's own process, so nothing inside it can block or report at the time. If
your suite can approach thirty minutes, declare a smoke subset here and leave
the exhaustive run to CI.

It is at least no longer silent. The gate writes a `result=running` line to
`gate-history.log` before it spawns anything, and every outcome replaces that
line — so a `running` line that survives is proof the invocation which wrote
it was killed. The next armed gate finds it, records `fail:killed`, and blocks
once with what to do about it. The stop it happened on was still allowed and
that milestone was still unverified; what changed is that you find out.

**The engine assumes a feature-branch workflow.** Scope is the merge-base diff
with your base branch, so work committed directly onto the base branch has an
empty scope and `verify.lint` has nothing to run on. The suite and the
unscoped checks still run.

---

## The base branch

Resolved in this order: `verify.base_ref`, then `refs/remotes/origin/HEAD`,
then `origin/main`, `main`, `origin/master`, `master`, `origin/develop`,
`develop`, `origin/trunk`, `trunk`.

If none resolves, `preflight` **refuses to start the run** at the first
subagent, and the gate **blocks** if a run is somehow already underway. Both
name the field to add. `spec-flow init` reports it too, at setup.

It does not fall back, because the only available fallback — comparing HEAD
against itself — yields an empty changed-file list, which is indistinguishable
from "this milestone touched nothing". Declare `base_ref` for a release
branch, a fork's upstream, or a shallow CI checkout that fetched no other ref.

---

## The second config file

One setting lives outside the contract, at `.claude/spec-flow.config.json`:

```json
{ "max_opus_calls": 6 }
```

It caps planner + architect calls per run and defaults to 6. When it runs out
the spawn is denied and the orchestrator is told to summarize for a human —
which is what the budget is for. The counter is `.claude/state/opus_calls`.

---

## Project skills

The agents ship with **no** `skills:` frontmatter, by choice rather than by
limitation: preloading has to name specific skills, and a skill encodes how
one codebase is built — which is exactly what this engine has no business
knowing. Instead, `implementer` and `planner` carry the `Skill` tool and read
`.spec-flow/skills.md` — a decision→skill table your repo writes — loading
what it routes them to on demand.

Write that file if your repo ships skills; skip it if not.

**On-demand loading is weaker than a preload, and the difference is real.** It
fires only once the agent already suspects it needs the skill, which is
precisely the moment a preload was there to protect.

To get preloading back, add your own `.claude/agents/implementer.md` with a
`skills:` line. That override works, and is documented: when several subagents
share a name, Claude Code uses the higher-priority location, and the order is
managed settings (1) → `--agents` CLI flag (2) → `.claude/agents/` (3) →
`~/.claude/agents/` (4) → **a plugin's `agents/` directory (5, lowest)**. A
project-level definition therefore wins over anything this plugin ships,
cleanly and by design.

Two constraints if you write one. A plugin subagent silently ignores the
`hooks`, `mcpServers` and `permissionMode` frontmatter fields — none of the
agents here use them, but a copy of one is not bound by that limit once it
lives in your project. And if another installed plugin also ships an agent
named `implementer`, the bare name is ambiguous; the scoped `plugin:agent`
form disambiguates.

---

## Commands and agents

| | |
|---|---|
| `/spec-flow <requirement>` | Full pipeline: spec, plan, review, implement, fold |
| `/spec-fix <what's broken>` | Defect flow: triage, one implementer pass, same gate |
| agents | `spec-writer` (Sonnet), `planner` (Opus), `reviewer` (Haiku), `implementer` (Sonnet), `architect` (Opus) |

---

## CLI

| command | what it does |
|---|---|
| `spec-flow init` | Generate `.spec-flow/config.json` and scaffold. `--force` to overwrite |
| `spec-flow check` | Lint changed files + full suite + unscoped checks. `--no-fix` to report only |
| `spec-flow trace` | `spec-trace` alone: the requirement/proof binding |
| `spec-flow stats` | Report over live and archived telemetry. `--raw` dumps the timeline |
| `spec-flow telemetry --mark` | Record the telemetry offset at the start of a run |
| `spec-flow telemetry <SLUG>` | Archive this run's slice into the change folder |

The orchestrator runs `telemetry` itself at intake and at DONE. Without it the
logs stay in gitignored state and `stats` has nothing to read.

---

## Hooks

| hook | event | fires on | what it does |
|---|---|---|---|
| `session-start` | `SessionStart` | — | Resets a phase left at `implement`/`blocked` for 6h+ to `idle` |
| `preflight` | `PreToolUse` | `Task`, `Agent`, `SendMessage` | Refuses to start a run whose contract does not load or whose base branch does not resolve |
| `no-gate-cmds` | `PreToolUse` | `Bash` | Denies whole-repo lint/test runs while implementing |
| `phase-guard` | `PreToolUse` | `Bash`, `Write`, `Edit` | Denies a phase outside the closed set, and an unearned `done` |
| `opus-budget` | `PreToolUse` | `Task`, `Agent`, `SendMessage` | Counts planner/architect calls, denies past the cap |
| `arm-gate` | `PreToolUse` | `Task`, `Agent`, `SendMessage` | Writes `implement` when the implementer is engaged without it |
| `lint-on-write` | `PostToolUse` | `Write`, `Edit` | Lints the file just written, while it is still in context |
| `register-agent` | `PostToolUse` | `Task`, `Agent` | Maps session ids to agent types so `opus-budget` can charge a `SendMessage` |
| `run-trace` | `PostToolUse` | `Write`, `Edit`, `Read`, `Bash`, `Task`, `Agent` | The run's observable timeline. Enforces nothing |
| `gate` | `Stop` | — | The external gate |

Only `gate`, `lint-on-write` and `no-gate-cmds` are armed exclusively by the
`implement` phase. `preflight`, `opus-budget`, `arm-gate` and `phase-guard`
stand down only outside a run. `register-agent`, `run-trace` and
`session-start` never enforce anything.

`preflight` runs first among the spawn hooks on purpose: it is the earliest
point at which a run can be refused, and refusing there costs nothing. It is
also the only place the contract is checked *before* the expensive calls — the
gate is the next one, and by then a planner and an implementer have already
run. It fails open on its own crash, like every hook but the gate; only a
check that genuinely failed denies.

---

## Phases

The spine of a run is `.claude/state/phase`. Every hook reads it to decide
whether it is armed.

| phase | written by | what it arms |
|---|---|---|
| `spec` | orchestrator, at intake | `preflight`, Opus budget, `phase-guard`, `arm-gate` |
| `plan` | orchestrator | `preflight`, Opus budget, `phase-guard`, `arm-gate` |
| `review` | orchestrator | `preflight`, Opus budget, `phase-guard`, `arm-gate` |
| `implement` | orchestrator — or `arm-gate`, if it forgot | **the gate**, **lint-on-write**, **the command deny**, `preflight`, Opus budget, `phase-guard` |
| `blocked` | **the gate itself**, at the attempt cap | `preflight`, Opus budget, `phase-guard`, `arm-gate` |
| `done` | orchestrator, if `phase-guard` allows | nothing |
| `idle` | orchestrator on rejection; `session-start` on an abandoned run | nothing |

**Standing the flow down.** Writing `idle` into `.claude/state/phase` disarms
every hook at once — the gate, the write-time linter, the whole-repo command
deny, `preflight` and the Opus budget:

```bash
printf 'idle' > .claude/state/phase
```

That is a human's call, and it is deliberately not offered to the agents: no
denial message quotes it, and nothing else guards the write the way `phase-guard`
guards `done` — `idle` is in the vocabulary, so it passes. Use it to take the repo back mid-run; re-run `/spec-flow` to
resume.

**This vocabulary is a closed set, and `phase-guard` enforces it.** Every
hook falls through to "not my business" on a value it does not recognise, so
inventing a phase like `triage` would run the flow with the gate, the
write-time linter, the command deny, `preflight` and the Opus budget **all
disarmed at once**. A write of any other value is denied, naming the
vocabulary — the rule used to live in four documents and nothing checked it.

The guard reads the value it is denying, and only that: a `Write`/`Edit` of
the phase file, or a `printf`/`echo` redirected into it. A command that merely
mentions the file is allowed, because a guard that denies on a guess blocks
real work to enforce a rule about a value nobody wrote.

---

## `.claude/state/`

Gitignored working files. Delete any of them to reset that piece of state.

| file | what it holds |
|---|---|
| `phase` | The current phase. The spine of the run |
| `gate_attempts` | Consecutive gate failures. Reset on pass, capped at 5 |
| `opus_calls` | Planner + architect calls this run |
| `agent-registry` | Session id → agent type |
| `run-offset` | Telemetry line counts at intake, set by `telemetry --mark` |
| `gate-history.log` | One line per gate invocation. `running` while it judges, replaced by the outcome; a surviving `running` means that invocation was killed |
| `run-trace.log` | Reads, writes, test verdicts, subagent outcomes |
| `gate-failure.log` | Last failure, truncated — what the planner reads |
| `gate-failure.full.log` | Same, untruncated — what a human reads |
| `lint-on-write-unmatched.log` | Linter invocations that failed to spawn |
| `run-trace-unmatched.log` | Subagent returns with no `STATUS:` line |
| `opus-budget-unmatched.log` | Payloads the budget could not attribute |
| `register-agent-unmatched.log` | Spawns whose session id was not found |

The four `*-unmatched.log` files are how each hook reports its own blind
spots. A hook that fails open silently is indistinguishable from one that had
nothing to do; these are what make the difference readable.
