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
| **One reporter flag**, so your suite writes a report saying which tests RAN | Parsing that report — JUnit XML or TAP — binding each requirement to a test that executed, in both directions, and refusing when it cannot tell |
| **Writing the specs' words** — at sign-off, you approve what the system will claim to do | Refusing to let a requirement stay unproven, or a test prove something no spec declares |
| **The judgement calls** — the sign-off, a `WRONG-SPEC` confirmation, and any run the gate hands back after five failures | Everything between those: planning, review, implementation, and the checks that run outside the model |
| **Keeping Node and Claude Code current** | Refusing to start on a Node it does not support, and recording the Claude Code that ran each gate |

Nothing else is asked of you mid-run. If the engine stops and waits, it is one
of the rows above, and it says which.

## Install

All of it, in the route that works on any repo in any language. Run it from
your repo's root, on a branch off your base branch:

```bash
claude plugin marketplace add IgnacioMarin402/spec-flow-plugin
claude plugin install spec-flow@spec-flow-marketplace

git clone --depth 1 https://github.com/IgnacioMarin402/spec-flow-plugin /tmp/spec-flow
node /tmp/spec-flow/scripts/init.mjs             # writes .spec-flow/config.json
node /tmp/spec-flow/scripts/check-changed.mjs    # green here means green at the gate
```

**No code is yours to write.** `init` reads your test and lint commands off the
repo and writes a contract the engine can run; the last line proves it. Below is
what each step is for, to be read when one does not do what you expected.

**1. The plugin** brings the commands, the agents and the hooks. Nothing else
in this list is Claude-Code-specific.

**2. The engine on disk**, because the same checks have to run outside a
session. The hooks reach the engine through `${CLAUDE_PLUGIN_ROOT}`, which
exists only inside Claude Code, and your terminal and CI need the same file —
not a second copy free to drift from it. The clone above needs nothing
installed: the engine has **no runtime dependencies**, so every command runs
from your repo's root with no arguments and no environment variables. If your
repo is already an npm package there is a tidier route with the same effect:

```bash
npm install --save-dev github:IgnacioMarin402/spec-flow-plugin
```

which gives you `npx spec-flow init` and `npx spec-flow check` in place of the
two `node /tmp/spec-flow/...` lines.
[Both routes, and what each command maps to](REFERENCE.md#cli).

**3. The contract.** `init` reads what your repo already declares — your `test`
and `lint` scripts, where your tests live, your base branch — writes
`.spec-flow/config.json`, and scaffolds `specs/`. **It never invents a value it
could not determine**, so it sorts every field into `detected`, `REVIEW` or
`MISSING` and exits non-zero until nothing is missing.

**The one thing it cannot do for you is make your suite emit a report.** To
bind a requirement to a test, the engine has to know which tests *ran* — and a
test that was skipped must not count, or skipping becomes the cheapest way to
silence a red suite. It reads that from a report your runner already knows how
to write, so `init` points the contract at a path and asks you to confirm it:

```json
"report": { "format": "junit", "path": "reports/junit.xml" }
```

Add your runner's reporter flag to the test command so the file lands there.
That is one flag, not a script: the engine parses JUnit XML and TAP itself,
because `<skipped/>` and `# SKIP` are defined by those formats rather than by
any runner. **Until it lands, traceability is simply off** — the gate still
lints and tests — and it turns itself back on the moment you declare a
requirement, refusing rather than passing quietly.
[Both proof sources, and the escape hatch for runners with no standard report](REFERENCE.md#what-makes-a-requirement-proven).

**4. Check it.** `check-changed` lints what this branch changed, runs your
suite, and runs the traceability check — the same commands the gate will run,
through the same file.

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

**A pass is silent to the model and not to you.** The gate renders no decision,
so the stop is allowed and nothing wakes the orchestrator back up — and it
prints one line for you as it goes:

```
Stop says: spec-flow: gate PASSED — 6fdfb93 (eslint 0, npm test 0, spec=0).
A pass does not wake the run, so nothing more will happen on its own:
say "continue" to advance to the next milestone.
```

Both commands also schedule a self check-in when the session provides a
scheduling tool; where it does not, a green milestone waits for your next
message.

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
- **A pass renders no decision**, so nothing wakes the orchestrator back up and
  a green milestone costs no tokens at all. You still see it: the gate prints a
  notice naming the commit it judged and what to say next.

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
npm run hooks:check   # the other nine hooks
npm run agents:check  # the planner and the reviewer agree about the milestone
npm run cold:check    # a repo that is not an npm package, from zero to green
```

All of these run in CI on every push and PR. The last one is the only check
that fails when *adoption* breaks rather than a piece of the engine: it takes
a repo with no `package.json`, in a language this engine has no code for,
through the install route above and asserts a green check at the end.

---

## License

MIT — see [LICENSE](LICENSE).
