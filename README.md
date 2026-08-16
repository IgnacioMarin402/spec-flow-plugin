# spec-flow

A spec-driven multi-agent pipeline for Claude Code. A free-text requirement
becomes a spec you sign off on, a milestone-by-milestone plan, a review pass,
and an implementation loop gated by lint, tests and requirement traceability
running **outside the model**.

Two commands — `/spec-flow` for a feature, `/spec-fix` for a defect — drive
five subagents, each pinned to the model its job needs. The engine has no
opinion about your language, framework or architecture, and that is structural
rather than aspirational: **it reads no source code.** It runs the commands
your repo declares in one file it writes, `.spec-flow/config.json`, and reads
their output.

Every field, table and flag is in **[REFERENCE.md](REFERENCE.md)**.

---

## Requirements

- Claude Code, and a git repo with a base branch you branch off of
- Node 20+ — enforced: a run refuses to start below it
- A linter and a test runner you can invoke from the command line

## What is yours and what is the engine's

The engine knows nothing about your project that you have not told it. That is
the design, and it means the list of things only you can supply is short,
finite, and worth seeing before you start.

| Yours | The engine's |
|---|---|
| **The contract** — which commands lint and test, what is in scope, where specs live. `init` reads most of it off your repo and reports what it could not | Running those commands, scoping lint to the changed files, never scoping the suite |
| **`trace.executed_tests`** — a small script saying which tests RAN. Only you can write it: every runner reports differently | Binding each requirement to a reported test, in both directions, and refusing when it cannot tell |
| **Writing the specs' words** — at sign-off, you approve what the system will claim to do | Refusing to let a requirement stay unproven, or a test prove something no spec declares |
| **The judgement calls** — the sign-off, a `WRONG-SPEC` confirmation, and any run the gate hands back after five failures | Everything between those: planning, review, implementation, and the checks that run outside the model |
| **Keeping Node and Claude Code current** | Refusing to start on a Node it does not support, and recording the Claude Code that ran each gate |

Nothing else is asked of you mid-run. If the engine stops and waits, it is one
of the rows above, and it says which.

## Install

**1. The plugin**, which brings the commands, the agents and the hooks:

```bash
claude marketplace add IgnacioMarin402/spec-flow-plugin
claude plugin install spec-flow@spec-flow-marketplace
```

**2. The same checks outside a session.** The hooks reach the engine through
`${CLAUDE_PLUGIN_ROOT}`, which exists only inside Claude Code, and your terminal
and CI need the same file — not a second copy free to drift from it.

```bash
# your repo is already an npm package:
npm install --save-dev github:IgnacioMarin402/spec-flow-plugin

# it is not — a Python, Go, Java or Rust repo has no reason to grow a
# package.json to hold a checker:
git clone --depth 1 https://github.com/IgnacioMarin402/spec-flow-plugin /tmp/spec-flow
```

The clone route needs nothing installed: the engine has **no runtime
dependencies**, so `node /tmp/spec-flow/scripts/check-changed.mjs`, run from
your repo's root, works with no arguments and no environment variables.
[Both routes, and what each command maps to](REFERENCE.md#cli).

**3. The contract.**

```bash
npx spec-flow init                       # or: node /tmp/spec-flow/scripts/init.mjs
```

It reads what your repo already declares — your `test` and `lint` scripts,
where your tests live, your base branch — writes `.spec-flow/config.json`, and
scaffolds `specs/`. **It never invents a value it could not determine**, so it
sorts every field into `detected`, `REVIEW` or `MISSING` and exits non-zero
until nothing is missing.

**One field is always yours: `trace.executed_tests`** — argv whose output names
the tests that actually ran. Nothing in a repo declares it, because every runner
reports differently. `init` writes `.spec-flow/tests-that-ran.mjs` with the
contract inside it and points the config there; you fill in the four lines that
read your runner's report. It refuses loudly until you do, and `init` never
overwrites it afterwards — not even with `--force`.
[What that file has to emit](REFERENCE.md#executed_tests--the-only-thing-that-makes-a-requirement-proven).

**4. Check it.**

```bash
npx spec-flow check                      # or: node /tmp/spec-flow/scripts/check-changed.mjs
```

Lints what this branch changed, runs your suite, runs the traceability check —
the same commands the gate will run, through the same file. Green here means
green at the gate.

Staying current is something you do, not something that happens: run
`/plugin marketplace update`. [Why that command works here and does nothing on
some plugins](REFERENCE.md#staying-current).

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
4. **The gate runs when the turn ends.** Green allows the stop; red blocks and
   tells the orchestrator what to fix.
5. **Fold and done.** The change spec is verified against `specs/`, stamped
   SHIPPED, archived with the run's telemetry.

**A pass is silent.** The gate allows the stop and prints nothing, so nothing
wakes the orchestrator back up. Both commands schedule a self check-in when
the session provides a scheduling tool; where it does not, a green milestone
waits for your next message. **A run that looks stalled after a milestone is
usually a run that passed** — say "continue".

If it stops and asks for a human, read `.claude/state/gate-failure.log`.

---

## How it works

Nothing coordinates a run but `.claude/state/phase` — no queue, no daemon, no
shared memory between agents. A subagent finishes, the orchestrator's turn
ends, and a `Stop` hook runs the checks outside the model and either allows the
stop or blocks with the instruction for what to do next.

- **The orchestrator never writes code.** It routes. Everything that produces an
  artifact is a subagent pinned to the model its job needs.
- **The gate is not a step in the pipeline** — it is what happens when the
  pipeline stops. Its block message *is* the next instruction.
- **A pass is silent**, so nothing wakes the orchestrator back up. A run that
  looks stalled after a milestone is usually a run that passed: say "continue".

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
npm run hooks:check   # the other nine hooks
npm run cold:check    # a repo that is not an npm package, from zero to green
```

All of these run in CI on every push and PR. The last one is the only check
that fails when *adoption* breaks rather than a piece of the engine: it takes
a repo with no `package.json`, in a language this engine has no code for,
through the install route above and asserts a green check at the end.

---

## License

MIT — see [LICENSE](LICENSE).
