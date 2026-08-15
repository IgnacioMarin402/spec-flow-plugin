# Reference

Look-up material. For what spec-flow is and how a run unfolds, see the
[README](README.md).

- [The contract](#the-contract) — every field of `.spec-flow/config.json`
- [Four rules the contract cannot express](#four-rules-the-contract-cannot-express)
- [The base branch](#the-base-branch)
- [The second config file](#the-second-config-file)
- [Staying current](#staying-current)
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
| `executed_tests` | yes | Argv whose output names the tests that RAN, one per line |
| `proof_dir` | yes | Directory a new test goes in, e.g. `test` |
| `proof_suffix` | yes | What a test file is called here, e.g. `.test.ts` |
| `not_a_capability` | no | Filenames under `specs_dir` that are not specs. Default `["README.md", "glossary.md"]` |
| `require_skills_field` | no | Fail a live milestone with no `Skills:` field. Default `false` |

#### `executed_tests` — the only thing that makes a requirement proven

A requirement is proven when a line of this command's output contains its id.
That is the whole binding. The engine parses no source and knows no report
format — not JUnit XML, not TAP, not any runner's native output. It knows
"lines naming a test that executed".

The small script that turns your runner's output into those lines belongs in
your repo, and that placement is the design rather than an omission: when your
runner changes how it reports, your script changes and this engine does not.
Most runners emit something usable behind a reporter flag.

`spec-flow init` scaffolds it at `.spec-flow/tests-that-ran.mjs` and points the
contract there:

```json
"executed_tests": ["node", ".spec-flow/tests-that-ran.mjs"]
```

The stub carries the contract and one marked hole, and exits non-zero until you
fill it — an unfinished translator that reported nothing would turn every
requirement unproven, which is the failure this check exists to catch arriving
through the file meant to prevent it. `init` will not overwrite it once written,
`--force` included.

It is **not** generated for your runner, and that is a limit rather than an
oversight: naming runners here would put a stack list inside the engine, which
`no-repo-refs.mjs` bans by design and which would rot. Holding stack-specific
values is the contract's job, not the engine's.

Two properties it must have, and the second is the one worth checking:

- **Lines carry test NAMES**, since the id is matched inside them. An id may
  sit against underscores — `TestAuth/REQ-USER-001_rejects` and
  `test_REQ-USER-001_rejects` both bind — but a fourth digit does not, so
  `REQ-USER-0011` is never read as `REQ-USER-001`.
- **A skipped test must not appear.** That absence is what makes skipping
  useless as a way to silence this check, and it is why the rule survives a
  change of language: `it.skip`, `@pytest.mark.skip`, `@Disabled`, `#[ignore]`
  and a runtime skip all end in the same place.

`spec-trace` runs this command itself, after the suite, and refuses loudly if
it fails or reports nothing while `specs_dir` declares requirements — "nothing
is proven" and "I could not find out" must not produce the same outcome. Run
`spec-flow check` rather than `spec-flow trace` alone: the first runs your
suite before the checks, the second reads whatever the last run left.

`proof_dir` and `proof_suffix` no longer decide what counts as proof. They kept
their other job — telling the planner and implementer where a new test goes and
what it is called — so set them to where your tests actually live. A test the
runner reports proves its requirement wherever it sits; getting these wrong now
costs consistency, not a blocked gate.

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

### Writing a capability spec

`spec-trace` enforces three rules a spec must follow, and `spec-flow init`
writes them into `specs/README.md` so the file the agents defer to actually
exists. In short:

```markdown
<!-- spec-scope: modules/user -->

# User

### REQ-USER-001 — the user can reset their password by email

The system sends a single-use link, valid for one hour.
```

- **The id prefix comes from the filename.** `specs/user.md` declares
  `REQ-USER-` ids, `specs/user-profile.md` declares `REQ-USER-PROFILE-`. A
  mismatch fails.
- **Exactly three digits**: `REQ-USER-001`, not `REQ-USER-1`.
- **The scope marker is required**, naming the code the spec is about.

Requirements are `###` headings with the id first; the separator after it may
be an em dash, a hyphen or a colon. Ids are permanent — never renumbered,
never reused. Every requirement needs a test that **runs** and whose reported
**name** contains its id — where that test's file lives is a convention your
repo sets, not something this check decides.

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

**The engine assumes a feature-branch workflow, and now checks the
assumption.** Scope is the merge-base diff with your base branch, so work
committed directly onto the base branch resolves a base equal to HEAD: the
diff is empty by construction, and `verify.lint` — the one scoped check — has
nothing to run on, for that milestone and every one after it. The suite,
spec-trace and the extra checks are unscoped and do run, so this was never a
disarmed gate; it was one check quietly sitting out a whole run while
`lint=-` in the history said so in a way nothing read.

The gate now **blocks** on it instead, naming both repairs: do the run's work
on its own branch, or declare `base_ref`. This is the same argument the
section below makes for refusing to fall back to `HEAD` — that comparing HEAD
against itself is indistinguishable from "this milestone touched nothing" —
applied to the case where the fallback is not a fallback but the honest
answer.

---

## The base branch

Resolved in this order: `verify.base_ref`, then `refs/remotes/origin/HEAD`,
then `origin/main`, `main`, `origin/master`, `master`, `origin/develop`,
`develop`, `origin/trunk`, `trunk`.

If none resolves, `preflight` **refuses to start the run** at the first
subagent, and the gate **blocks** if a run is somehow already underway. Both
name the field to add. `spec-flow init` reports it too, at setup.

If one resolves but resolves to **HEAD itself**, only the gate blocks —
`preflight` deliberately does not. At run start the two situations are the
same commit: a correctly created feature branch sits at its base's tip until
its first commit, so refusing there would refuse every properly set up run.
By the time the gate judges a milestone the tree is clean, and nothing
committed above the base means either the base is the branch you are on or
the milestone produced nothing.

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

## Staying current

Neither `plugin.json` nor the marketplace's entry for `spec-flow` declares a
`version`, and that is deliberate. Claude Code resolves a plugin's version, to
decide whether an update exists, from the first of these that is set:
`plugin.json`'s `version` → the marketplace entry's `version` → the git commit
SHA of the source. Leaving both fields out lets it fall to the SHA, so every
push to `main` is a real version change — `/plugin marketplace update` (or
`claude plugin update spec-flow`) picks it up.

The alternative was a hand-maintained `version` field, bumped on every
release. It shipped that way for the plugin's first nine PRs and nobody bumped
it once: every install stayed pinned to `0.1.0` regardless of what landed on
`main`, and `/plugin marketplace update` would have compared `0.1.0` against
`0.1.0` and reported nothing to do — silently, the same way a hook that fails
open reports nothing to do. A manual step nobody has a reason to remember is
not a versioning strategy here; the SHA needs nobody to remember anything.

No install is ever updated FOR you, either way — `/plugin marketplace update`
is something you run, on whatever cadence you want the changes on this page
to reach your repo.

---

## Project skills

Your skills live where Claude Code puts them — `.claude/skills/` — and this
plugin adds no file of its own to index them. It does not need one: Claude
Code lists every skill's name and description to the model automatically, so
the agents can see what your project ships without being told.

The agents ship with **no** `skills:` frontmatter, by choice rather than by
limitation: preloading has to name specific skills, and a skill encodes how
one codebase is built — which is exactly what this engine has no business
knowing. `implementer` and `planner` carry the `Skill` tool instead, and load
what they need.

**The routing happens at plan time, not mid-work.** Each `milestones/Mk.md`
carries a `Skills:` field, and the planner fills it while reading the whole
milestone with nothing written yet. The implementer loads what that field
names **before its first edit**. `/spec-fix` does the same in the work order
it writes itself. `none` is the answer when nothing applies, and the only one
a project shipping no skills will ever write.

**Nothing is required of a project that does not use skills.** The reviewer
checks the field the same way it checks `Spec deltas`, `Tests` and every other
milestone field — that is where plan completeness is judged. `spec-trace` will
*fail* a live milestone whose field is missing or empty only where the
contract sets `trace.require_skills_field: true`; a bare `Skills:` is treated
as the absent field it is, since it answers none of the questions the field
exists to answer.

That switch is off by default, and cannot be inferred. Skills reach a session
from the project's `.claude/skills/`, from installed plugins, and from the
user's own `~/.claude/skills/`, so no file this engine reads says whether a
project routes them — and a default that guesses wrong does not degrade, it
fails a gate over a field the project was never going to use. Inferring it
from whether some milestone already names a skill was rejected for a sharper
reason: that arms the check from an absence, so the first milestone that
should have routed one and did not is exactly the milestone that arms
nothing.

That ordering is the point, and it is worth being exact about what on-demand
loading actually costs, because it is not blindness. Claude Code lists every
skill's **name and description** to the model automatically, so an agent
always knows what is available and roughly when each applies. Two things it
does not have: the skill's *body*, which is where the actual procedure lives,
and any statement that a given milestone **requires** a given skill.
Descriptions drive invocation when the model judges it relevant; the `Skills:`
field turns that "when relevant" into an instruction, decided by the planner
and checked by `spec-trace`.

So the weakness is timing rather than ignorance. The implementer decides
whether a skill applies after it has already framed the problem its own way,
which is the point at which a wrong frame is cheapest to form and dearest to
undo. Moving the decision to the planner does not restore preloading; it moves
the judgement to the one agent reading the whole milestone with nothing
written yet, and records the answer where the implementer cannot skip it.

The implementer keeps the on-demand path as a fallback, for a milestone
written by hand or one whose routing missed something, and reports the miss in
its `NOTES:` so the gap is visible rather than absorbed.

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
