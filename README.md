# spec-flow

**A feature ships only when a test that actually ran proves every requirement
in its spec.** It closes the quiet failure: a requirement everyone believes is
covered, with no test that proves it.

spec-flow is a spec-driven, multi-agent pipeline for Claude Code, for Node
projects. A free-text requirement becomes a spec you sign off, a plan in
milestones, a review, and an implementation loop gated by lint, tests and
requirement traceability — checks that run **outside the model**, in a hook,
on the commands your repo declares.

**What the machine enforces:** a test whose reported name carries the
requirement's id executed — checked in both directions, from the report your
runner writes, so a skipped or todo test does not count. **What it cannot
check** is whether that test asserts anything: the engine reads no source code
([ADR-001](decisions/001-proof-comes-from-the-runner.md)). A model reads each
new test once per change and reports weak ones; the sign-off and your code
review do the rest ([ADR-020](decisions/020-a-tagged-test-is-judged-not-measured.md)).

## What it looks like

A requirement lives in `specs/`, with a permanent id:

```markdown
### REQ-USER-001 — the user can reset their password by email
The system sends a single-use link, valid for one hour.
```

A test carries that id in its name:

```js
it('REQ-USER-001 — sends a single-use link valid for one hour', ...)
```

Green is the two agreeing, read from the report your suite wrote:

```
spec-trace: OK — 12 requirement(s) across 3 capability spec(s), every one
proven by a test; 4 archived change(s), every one with a status.
OK — lint, tests and the unscoped checks pass.
```

Skip that test — `it.skip`, `it.todo`, a runtime skip — and it disappears from
the report:

```
spec-trace: the spec layer and the code disagree.

  - REQ-USER-001 (specs/user.md) has no test that RAN. Add a test whose name
    contains REQ-USER-001, or delete the requirement — an unproven requirement
    is a wish, not a spec.
```

A test naming an id no spec declares fails the same way.

## Requirements

- Claude Code, and a git repo where you work on a branch off your base branch
- A Node project with test and lint commands. Other stacks are not supported
  ([ADR-007](decisions/007-the-supported-scope-is-node.md))
- Node 20+ — a run refuses to start below it
- Linux or Windows; CI runs both on every supported Node
  ([ADR-019](decisions/019-ci-runs-the-floor-it-imposes.md))

## Install

```bash
claude plugin marketplace add IgnacioMarin402/spec-flow-plugin
claude plugin install spec-flow@spec-flow-marketplace
```

Then, from your repo's root:

```bash
node <the plugin's path>/scripts/init.mjs   # writes .spec-flow/config.json
node <the plugin's path>/scripts/check-changed.mjs
```

`init` reads your test and lint commands from `package.json`, adds your
runner's reporter flag so the suite writes a report of what ran, and marks
anything it inferred `REVIEW` and anything it could not read `MISSING`. If it
leaves `MISSING` lines, ask Claude Code to set up spec-flow: the plugin's setup
skill fills them and proves the result with `check-changed`. Green there means
green at the gate. Every field is in
[REFERENCE](REFERENCE.md#what-makes-a-requirement-proven).

The plugin is the whole install. For a terminal without Claude Code, or CI, the
same engine installs as a pinned devDependency straight from this repository —
nothing is published to npm, and `spec-flow` on npm is someone else's package
([REFERENCE → CLI](REFERENCE.md#cli)). To stay current:
`/plugin marketplace update` ([REFERENCE](REFERENCE.md#staying-current)).

## Your first run

```
/spec-flow users can reset their password by email
```

1. The run refuses to start if the contract does not load or the base branch
   does not resolve.
2. The spec-writer asks you questions if the requirement is ambiguous.
3. **You sign off** on the requirement deltas and the decision. A "no" is
   archived with its reason.
4. Plan, review, then one milestone at a time, each in a fresh implementer
   session that is told to write each requirement's test first.
5. **The gate runs when the turn ends.** Red tells the orchestrator what to
   fix; green tells it to advance — so a run moves on its own.
6. Fold: the change is verified against `specs/`, stamped SHIPPED and archived
   with the run's telemetry.

Beyond answering its questions, it stops for you only at the sign-off, a
`/spec-fix` defect that turns out to be a wrong spec or a feature, an exhausted
escalation budget, or five gate failures — then read
`.claude/state/gate-failure.log`.

For a defect, `/spec-fix <what is broken>` triages it against `specs/` and runs
one implementer pass through the same gate.

## The agents

| agent | does | ships on |
|---|---|---|
| `spec-writer` | Writes the spec, triages defects, folds shipped changes into `specs/` | Sonnet |
| `planner` | Turns the spec into milestones; escalation consultant | Opus |
| `reviewer` | Reads the plan against the spec before an implementer is spent | Haiku |
| `implementer` | Implements one milestone | Sonnet |
| `architect` | Consulted when the implementer hits a design decision | Opus |

Those are tiers, not versions. A project can re-route any agent and cap
escalations ([REFERENCE](REFERENCE.md#the-second-config-file));
`/spec-flow:models` shows what each will run on and who decided.

## How it works

Nothing coordinates a run but one file, `.claude/state/phase`. The orchestrator
routes and never writes code; each subagent does one job; when the
orchestrator's turn ends, a `Stop` hook runs your lint, your whole suite and the
traceability check, and either allows the stop or blocks with the next
instruction. The three flowcharts are in
[REFERENCE](REFERENCE.md#how-a-run-unfolds).

## Developing the engine

```bash
npm install
npm run lint && npm run typecheck
```

Every other check is a `*:check` script in `package.json`, none needs the
network, and CI runs all of them on Linux and Windows. `cold:check` is the one
that fails when *adoption* breaks: it takes a Node repo from nothing to a green
`check` through the route above.

## License

MIT — see [LICENSE](LICENSE).
