# spec-flow

A spec-driven multi-agent pipeline for Claude Code. A free-text requirement
becomes a spec you sign off on, a milestone-by-milestone plan, a review pass,
and an implementation loop gated by lint, tests and requirement traceability
running **outside the model**.

Two commands — `/spec-flow` for a feature, `/spec-fix` for a defect — drive
five subagents, each pinned to the model its job needs. The engine has no
opinion about your language, framework or architecture: that lives in one file
your repo writes, `.spec-flow/config.json`.

Every field, table and flag is in **[REFERENCE.md](REFERENCE.md)**.

---

## Requirements

- Claude Code, and a git repo with a base branch you branch off of
- Node 20+
- A linter and a test runner you can invoke from the command line

## Install

**1. Install the plugin.**

```bash
claude marketplace add IgnacioMarin402/spec-flow-plugin
claude plugin install spec-flow@spec-flow-marketplace
```

An install does not stay current on its own. Run `/plugin marketplace update`
(or `claude plugin update spec-flow`) to pull whatever has landed on `main`
since — see [REFERENCE](REFERENCE.md#staying-current) for why that command
does nothing on some plugins and does not here.

**2. Install the CLI too.** The hooks reach the engine through
`${CLAUDE_PLUGIN_ROOT}`, which only exists inside a Claude Code session. Your
terminal and CI need the same checks:

```bash
npm install --save-dev github:IgnacioMarin402/spec-flow-plugin
```

```json
{
  "scripts": {
    "check": "spec-flow check",
    "spec:check": "spec-flow trace",
    "flow:stats": "spec-flow stats"
  }
}
```

The hook and these aliases run the **same file**, so "same files, same
commands, same result" is structural rather than two copies that agree today.

**3. Generate the contract.**

```bash
npx spec-flow init
```

It writes `.spec-flow/config.json` by reading what your repo already declares
— your `test` and `lint` scripts, where your tests live, which extensions you
use, your base branch — then creates `specs/` and `specflow/archive/` and adds
`.claude/state/` to `.gitignore`.

It never invents a value it could not determine. Every field lands in one of
three buckets, and it tells you which:

```
detected  verify.test — from the "test" script: node node_modules/.bin/vitest run
REVIEW    trace.proof_dir is "lib" — a guess. Your tests are not in a
          directory of their own, so no segment identifies one.
MISSING   verify.lint_config_hint — no config file for the linter was found.
```

`detected` is read from your repo. `REVIEW` is an inference worth confirming.
`MISSING` is left empty on purpose, so the contract does not validate until
you fill it — a plausible wrong value would run, and a missing one is
reported. Init exits non-zero while anything is missing.

Fill in what it asks for, then re-run with `--force` or edit the file
directly. Every field is documented in
[REFERENCE.md](REFERENCE.md#the-contract).

**4. Check it.**

```bash
npx spec-flow check
```

Lints the files this branch changed, runs your suite, and runs the
traceability check — the same commands the gate will run, through the same
file. If this is green, the gate will be too.

---

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
ends, and a `Stop` hook runs the checks outside the model and either allows
the stop or blocks with the instruction for what to do next.

- **The orchestrator never writes code.** It routes. Everything that produces
  an artifact is a subagent pinned to the model its job needs.
- **The gate is not a step in the pipeline** — it is what happens when the
  pipeline stops. Its block message *is* the next instruction.

### `/spec-flow` — a feature

```mermaid
flowchart TD
    A(["/spec-flow &lt;requirement&gt;"]) --> B["SPEC — spec-writer, Sonnet 5 <br/> writes spec.md and proposal.md"]
    B -->|"NEEDS_INPUT"| Q{{"HITL 1 — open questions, <br/> asked in the chat"}}
    Q -->|"answers"| B
    B -->|"SPEC_READY"| S{{"HITL 2 — sign-off on the <br/> deltas and the decision"}}
    S -->|"no"| REJ["stamp REJECTED, archive the folder, <br/> phase idle — the record is the deliverable"]
    S -->|"yes"| P["PLAN — planner, Opus 5 <br/> plan.md plus one file per milestone"]
    P --> R["REVIEW — reviewer, Haiku 4.5 <br/> reads the spec and every milestone file"]
    R -->|"ESCALATE"| CON["planner, MODE=CONSULT"]
    CON --> R
    R -->|"CHANGES_REQUESTED"| P
    R -->|"APPROVED"| I["IMPLEMENT Mk — implementer, Sonnet 5 <br/> one fresh session per milestone"]
    I -->|"NEEDS_ARCHITECT"| ARCH["architect, Opus 5"]
    ARCH --> I
    I -->|"BLOCKED"| RE["planner, MODE=REPLAN"]
    RE --> I
    I -->|"IMPLEMENTED"| CM["orchestrator commits and pushes, <br/> then ends its turn"]
    CM --> G{{"THE GATE — Stop hook, outside the model"}}
    G -->|"lint or trace, attempts 1-2 <br/> a red test, attempt 1"| I
    G -->|"whatever survives that"| RE
    G -->|"5 failures"| BLK["phase blocked — a human decides"]
    G -->|"green, and silent"| MORE{"another milestone?"}
    MORE -->|"yes, Mk+1"| I
    MORE -->|"no"| F["FOLD — spec-writer, Sonnet 5 <br/> verify the deltas landed, <br/> stamp SHIPPED, archive"]
    F --> G2{{"the gate again, on the fold commit"}}
    G2 -->|"gap in the specs' wording"| F
    G2 -->|"gap in code or tests"| RE
    G2 -->|"green"| D["DONE — phase done, <br/> archive the telemetry, print the stats"]
```

Each milestone gets a **fresh** implementer session, but every follow-up
within that milestone goes back to the *same* session — a new session re-reads
the plan and every touched file from a cold context, and that repeated
re-reading across retries is where most of a run's token cost goes.

### `/spec-fix` — a defect

A feature is an open question about what the system should do. A defect is a
closed question: the system already claims a behaviour and something disagrees
with the claim, so the job is finding **which side is wrong**. That is triage,
not planning — which is why this flow drops the planner and the reviewer.

```mermaid
flowchart TD
    A(["/spec-fix &lt;what is broken&gt;"]) --> T["TRIAGE — spec-writer, Sonnet 5 <br/> phase spec, gate disarmed"]
    T --> C1["case 1 — UNSPECIFIED <br/> nothing lied, there was no claim"]
    T --> C2["case 2 — WEAK-TEST <br/> the requirement is right, <br/> its test proved too little"]
    T --> C3["case 3 — WRONG-SPEC <br/> the code obeyed, the requirement was wrong"]
    T --> C4["case 4 — INFRA <br/> outside the contract's proof surface"]
    T --> C5["case 5 — NOT-A-FIX <br/> this changes behaviour: it is a feature"]
    C3 --> H{{"HITL — a human confirms the <br/> old requirement was actually wrong"}}
    C5 --> REJ["stamp REJECTED, archive, <br/> phase idle — it belongs to /spec-flow"]
    H -->|"confirmed"| W
    H -->|"it was right after all"| T
    C1 --> W
    C2 --> W
    C4 --> W
    W["WORK ORDER — the orchestrator writes it itself <br/> plan.md + milestones/M1.md, phase implement"]
    W --> I["FIX — implementer, Sonnet 5"]
    I --> CM["commit, push, end the turn"]
    CM --> G{{"the same GATE"}}
    G -->|"lint or trace, attempts 1-2 <br/> a red test, attempt 1"| I
    G -->|"whatever survives that"| T
    G -->|"5 failures"| BLK["phase blocked — a human decides"]
    G -->|"green"| F["FOLD — spec-writer <br/> stamp SHIPPED, archive"]
    F --> D["DONE"]
```

Only cases 3 and 5 stop for a human. Rewriting a requirement so it agrees with
the code is indistinguishable, from the diff alone, from rewriting it so it
agrees with the *bug*. A surviving failure goes back to **triage**, not to a
planner: a fix whose test will not go green is usually aimed at the wrong case.

### The gate

```mermaid
flowchart TD
    S(["Stop — the orchestrating turn ends"]) --> P{"phase is implement?"}
    P -->|"no"| ALLOW["allow the stop, record nothing"]
    P -->|"yes"| CFG{"contract readable?"}
    CFG -->|"no"| BLK1["BLOCK — a human fixes <br/> .spec-flow/config.json"]
    CFG -->|"yes"| DIRTY{"tree clean? <br/> ignoring .claude/state/"}
    DIRTY -->|"dirty"| SKIP["skip-dirty, allow the stop — <br/> an implementer may still be writing"]
    DIRTY -->|"clean"| BASE{"base branch <br/> resolvable?"}
    BASE -->|"no"| BLK2["BLOCK — a human adds <br/> verify.base_ref to the contract"]
    BASE -->|"resolves to HEAD"| BLK2
    BASE -->|"yes"| RUN["lint over the changed files <br/> the FULL test suite, always <br/> spec-trace, then every extra_check"]
    RUN -->|"all green"| PASS["allow the stop, silently. <br/> attempts reset to 0"]
    RUN -->|"red"| CLS{"which class, <br/> which attempt?"}
    CLS -->|"lint or trace, attempts 1-2"| FIX["back to the session whose edits <br/> are being judged: fix exactly these"]
    CLS -->|"a red test, attempt 1"| FIX
    CLS -->|"anything that survives that"| REPLAN["re-plan this milestone — <br/> in /spec-fix, re-triage instead"]
    CLS -->|"the 5th failure"| CAP["write phase blocked, <br/> hand it to a human"]
```

- **A dirty tree is not judged.** Implementers run in the background, so a
  `Stop` can fire mid-write; judging that snapshot manufactures failures.
- **Lint is scoped to the changed files, tests never are** — and an empty
  scope does not skip the suite either. `lint(file)` is a predicate about one
  file; a suite's outcome is a property of the system.
- **An unresolvable base is a refusal, not an empty scope.** "Nothing changed"
  and "I could not tell" must never produce the same outcome, because one of
  them is a pass. A base that resolves *to HEAD* is refused for the same
  reason: work committed straight onto the base branch has an empty diff by
  construction, so the scoped linter never runs for the whole run.
- **The failure class decides the route, not the severity.** A traceability
  gap is usually a test that proves the requirement and never named it — an
  edit, not a re-think.
- **It fails closed, alone among the hooks.** A `Stop` hook that exits without
  printing *allows the stop*, so an unhandled throw would report a clean
  milestone rather than skip the gate.

**A test that does not run is not proof.** A title tagged with a requirement
id under `it.skip`, `it.todo`, `xit` or `xtest` counts as unproven, exactly as
if it were absent — skipping is the cheapest way to silence a red suite.

---

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
```

All eight run in CI on every push and PR.

---

## License

MIT — see [LICENSE](LICENSE).
