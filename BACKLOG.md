# Backlog

Every entry states the run behind it — a proposal with no run attached is a
hypothesis, and this file keeps the two apart on purpose. Items are written so
that "done" is a check that goes red before the fix and green after, not a
paragraph someone judges; where an item cannot be proven that way, it says so.

**Shipped items are compressed into the record below rather than deleted.**
What is worth keeping about a finished item is the finding, not the argument
that led to it — the argument now lives in the commit that carried it and in
the comments next to the code, where it is read by whoever changes that code
next. A backlog that keeps re-stating settled decisions is the same liability
as a doc nothing checks.

**Open order:** B4, B16, B14, B15. B4 leads because two other items now depend
on it for data: B16 cannot be designed without it, and B15's ablation arm
answers a cheaper version of the same question. B15 is blocked on `claude plugin
eval` early access; nothing else is blocked by code.

---

## Shipped

### B1 — the engine read source code in exactly one place, and that was the whole coupling — `331ea1b`

`spec-trace.mjs:233` was the only line in the engine reading a source file the
consuming repo wrote in its own language, and its two constants (`TEST_TITLE`,
`NOT_RUN`) were the entire coupling to a stack: a genuine pytest proof read as
"has no test", and since the check sits in the gate, no milestone in such a
repo could pass.

The fix was not more idioms. "Did this test run?" is a runtime fact being
derived statically, and that derivation is what forced the engine to know a
language at all. The contract now declares `trace.executed_tests` — argv whose
output names the tests that RAN — and a requirement is proven when a reported
line contains its id. The engine knows lines, not formats.

Went with it: the whole-repo walk, and `NEVER_WALK` — an ecosystem list the
engine could not keep current, missing `venv`, `site-packages`, `__pycache__`
and `target`. Its regression test needs no second language: a vendored
dependency with a `tests/` segment had its own tests judged as this repo's.
Also gone are two documented limitations of the old matcher, since a runner
reports names already expanded.

Found by the fixture rather than by the design: `REQ_TAG`'s `\b` delimiters
failed on Go and pytest names, which glue an id to its neighbours with
underscores. The boundaries now say what matters — not glued to a preceding
letter or digit, not followed by a fourth digit.

Left behind, and now B10: `init` cannot detect `executed_tests`, so every
adopter fills one field by hand.

### B7 — the state that survived a crash could resume the checking, not the run — `98477a5`

Which milestone was current and which session was `IMPL_SESSION` lived only in
the orchestrator's context, so a crash mid-milestone left an armed gate, a
live attempt count and nothing able to say what was being implemented.
`register-agent` — the one place a spawn's type and its session id are both in
hand — now records both, from the spawn's own input. `session-start` no longer
erases the position when it disarms a stale run: the phase arms hooks, the
position arms nothing, and the two were never one act.

### B8 — the test-first metric was not blind, it was fabricating — `98477a5`

Logged as "hardcoded to one extension, fails by going quiet". Running it
showed worse: `file.replace(/\.ts$/, '.spec.ts')` is a no-op off TypeScript,
so every source file was looked up as itself, found itself, and produced a
verdict. A Python trace reported two `no-red-run` MISSes for files never
paired with anything. Pairing is now contract-driven and matches on basename,
since the old version also assumed a test sits beside its source.

### B10 — `init` scaffolds the translator (the generation half became B11)

B1 left `trace.executed_tests` MISSING on every repo, so `npx spec-flow init`
could not produce a working contract for anybody. `init` now writes
`.spec-flow/tests-that-ran.mjs` carrying the contract, the shape and a loud
refusal, and points the config at it; the four lines that read a runner's
report are left.

**The half that did not land, and why it is not simply deferred:** generating
code per runner requires naming runners inside `scripts/`, which
`no-repo-refs.mjs` bans — and its header argues the position rather than just
enforcing it, saying `init` needs no exemption precisely because "it names
nothing, it reads what the repo already declares". Closing that half means
either exempting a template directory from the scan, or accepting a runner list
that rots. Neither is obviously right, and it is a decision rather than work,
so it is split out as B11.

### B9 — the CLI half had a path that is not npm all along — `PENDING`

Logged as three trades to investigate. It was one hypothesis to run, and it
held: a Python repo with no `package.json` and no `node_modules` runs
`node <clone>/scripts/check-changed.mjs` green, from its own root, with no
arguments and no environment variables. The engine has zero runtime
dependencies — `dependencies` is empty and every import is `node:` or relative
— so a bare clone runs, adding no requirement the README did not already list.

Node on the PATH was never the coupling. Requiring the consuming repo to BE an
npm package was, and it turned out not to be required at all. Documented in
the README as the second of two install routes.

### B11 — `init` will not generate the translator, and that is the scope — `PENDING`

Decided rather than deferred: **configuring how a repo reports the tests it
ran is the adopting project's responsibility**, like declaring its linter or
its base branch, and the engine's job ends at asking for it clearly. A
`templates/` directory outside the coupling scan and a relaxed ban for `init`
were both weighed and both refused — buying four lines of an adopter's time
with a stack list inside the engine is the trade this extraction exists to
refuse, and a runner list is exactly the thing that looks maintained and
quietly is not.

Recorded in `no-repo-refs.mjs`'s own header, where the argument it settles
already lived, so reopening it means saying what changed.

### B2 — a cold start is now the only check that fails when ADOPTION breaks — `PENDING`

Logged as "nothing has ever run the documented install", then demoted to an
acceptance test for other items. With B9 and B10 closed it became an item
again and shipped as `scripts/cold-start.mjs`, in CI.

It builds a repo with no `package.json` and no `node_modules`, in a language
this engine has no code for, and takes it through the README's second install
route — by path, out of a clone, from the repo's own root, with no arguments
and no environment variables — to a green `spec-flow check`. Then it removes
the test from the report and asserts the requirement goes unproven, which is
what a skip looks like from the engine's side.

Red against `92a7d72` with three failures, including the central one. It also
counts the fields an adopter is asked to fill, so adoption cost going up turns
CI red rather than being absorbed.

What it is not: proof that the plugin half installs. That gap stayed open and
was closed by hand instead — see the note below.

**Step 1, run for the first time (2026-08-16).** The README's very first
command was wrong: `claude marketplace add` does not exist, the subcommand is
`claude plugin marketplace add`. Nothing had ever executed it, which is exactly
why it survived. The real sequence works — marketplace added, plugin installed,
`Version: 10bfbdfbbab2` resolved from the git SHA, which confirms ADR-003 by
observation rather than by reading the docs.

It stays unautomated: a CI runner has no `claude` CLI, so `cold-start.mjs`
cannot reach it. What it now has instead is one verified run with its output
recorded in REFERENCE, and a correct command in the README.

### B5 — Node is a floor and is enforced; Claude Code is recorded, not invented — `PENDING`

`preflight` refuses a run on a Node below `package.json`'s `engines.node`,
which stays the single declaration. Inside a run only — a subagent in a repo
that never adopted this engine is not denied over a floor only this engine
declares. That placement was wrong in the first draft and a hook-smoke case
now catches it.

Claude Code gets no floor, and that is the finding rather than the shortfall.
Declaring a supported range means having evidence about versions outside it,
and this project has one user who always runs the latest — so any claim about
an older version would be invented, and an invented floor denies real runs.
`CLAUDE_CODE_VERSION` is instead written into every gate-history line, so the
first version-dependent failure arrives with the version already recorded.

### B12 — the README was four documents in one — `PENDING`

365 lines, of which Install was 115 and "How it works" 151 — 73% of the page
was two sections, and a reader wanting either read past the other.

It was a structure problem, so the fix is structural rather than deletion. The
three flowcharts and the gate's branch-by-branch reasoning moved to REFERENCE
under `## How a run unfolds`, leaving an 18-line version on the front page that
says what coordinates a run and links to the rest. Install went from 115 lines
to 61 by stating each step once and sending the reasoning to REFERENCE.

**179 lines, from 365.** REFERENCE grew from 518 to 689, which is the right
place for it to grow: it is where someone goes deliberately.

The restructure created exactly one defect and it was a promise: a link
offering "both routes, and what each command maps to" pointed at a CLI section
that documented one route. Found by checking the anchors by hand, which is why
`plugin-paths.mjs` now checks cross-doc anchors on every run — 16 of them
today, and a broken one names the file and the anchor.

### B3 — the checkable half of the prose contract, and why the other half waits — `PENDING`

Logged as "write `claude plugin eval` cases for the five agents and two
commands". The tool exists — `claude plugin eval`, with `evals/**/case.yaml`,
graders, and a `--ablation` baseline arm — and **it is in early access and not
enabled here**, so nothing could be run. Authoring cases anyway would have
shipped an artifact that looks like coverage and executes nowhere, which is the
failure this engine exists to close.

So the half that needs no model shipped instead, and it turns out to be the
half that matches the recorded defect. `scripts/agent-contracts.mjs` asserts
that the planner's milestone template and the reviewer's checklist agree about
which fields matter: every field is either named by the reviewer or exempt with
a stated reason, and adding a field to the template and nothing else turns CI
red. That is precisely the `Skills:` failure — added to the template and the
planner's contract, never told to the reviewer, passed review unseen.

It found one live gap on its first run: `Files to add/change` was in the
template and nowhere in the reviewer's checklist. Unlike `Steps` no other
question covered it, so the reviewer now checks it — a milestone that says what
to change without saying where hands the implementer the planner's own job,
from a cold context.

Verified in three directions: a new template field goes red, a stale exemption
goes red, and a template whose anchor moves fails loudly rather than checking
an empty set.

**Still open, as B15:** the model-graded half. It needs early access, and it
buys something this check cannot — whether the reviewer's judgement actually
fires, whether triage classifies the five `/spec-fix` cases correctly.

### B6 — the coupling check could not see the file that proved it was needed — `98477a5`

`ci.yml` pointed at a `conformance/` directory and a design document, neither
of which exists here. Reference removed, and the workflow added to
`SCAN_FILES`.

---

## B15 — the model-graded half of the prose contract

`claude plugin eval` runs `evals/**/case.yaml` against a plugin, with graders
and an `--ablation with-without` baseline arm that reports the score delta
against no plugin at all. It is **in early access**; running it here returns
"`plugin eval` is currently in early access" and exits without doing anything.

Writing cases before that is enablement-blocked, not effort-blocked — and
shipping unrunnable cases would be worse than none, since a suite nobody
executes reads as coverage.

What it buys that `agent-contracts.mjs` cannot: whether judgement actually
fires. Highest-value cases, in order — the reviewer's `CHANGES_REQUESTED` path
(never yet observed), the triage classifier's five cases in `/spec-fix`, and
the orchestrator's refusal to write code itself.

Note the cost before starting: each case runs the model, and `--ablation`
doubles it.

---

## B16 — the adopting repo's `CLAUDE.md` is paid once per milestone

**No run behind this yet, and that is the entry's first requirement rather than
a caveat.** It is an observation about the design plus a cost nobody has
measured, and the two designs below differ enough that guessing would waste the
work.

Each milestone gets a fresh implementer session — deliberately, so nothing
carries contamination from the last one. The plan and `Mk.md` differ per
milestone, so re-reading those is information. **`CLAUDE.md` does not differ**,
so re-reading it is repetition, and it recurs on every gate retry as well as
every milestone. The README already says this is where most of a run's token
cost goes; what it does not say is that one component of it varies with a file
the adopter controls and may not realise they are paying for.

**What is known.** No agent frontmatter carries a context or memory field, so
the engine does not control this declaratively. The agents' own prose instructs
reading it — the planner is told "you should read them: `CLAUDE.md`", the
spec-writer to ground the spec "per `CLAUDE.md`".

**What is not known, and decides the design.** Whether the harness INJECTS the
project's `CLAUDE.md` into every subagent, or whether the agents read it only
because the prose says so. If it is injected, the engine cannot opt out and the
only lever is the file's length. If it is read by instruction, the instruction
is this engine's to change. The planner being told to read it is weak evidence
against injection — the instruction would be redundant — and weak evidence is
not a basis for either design.

**It is exactly measurable with what already exists.** `run-trace` logs every
read with its phase, and `specflow-stats` already reports them grouped ("N file
read(s): X in plan, Y in implement"). One real run answers it: once, or once
per milestone, and at what size. That is B4, again.

### The option to refuse

**A flag that suppresses it.** Trades a few thousand tokens for an implementer
writing code that violates the repo's conventions. Lint catches some of that;
layer and architecture rules are not lint-catchable, and a misdirected milestone
costs an implementer pass, a gate cycle and possibly an Opus re-plan. That is
the expensive-first mistake inverted — the same one the gate's own retry ladder
is built to avoid. A flag does not filter, it cuts.

### The option that fits

**The planner distils what each milestone needs into `Mk.md`.** It already reads
`CLAUDE.md` once and writes the milestones, so the conventions relevant to a
milestone can travel with it — and `CLAUDE.md` is then read once per RUN rather
than once per milestone.

Not a new mechanism: it is exactly how `Skills:` works, with the same argument
behind it — the implementer starts cold, so anything the planner leaves out it
can only discover after framing the problem its own way. A large `CLAUDE.md`
gets filtered rather than truncated.

**Do not build it before the measurement.** If the harness injects regardless,
this reduces what the implementer must go and read, not what it is given, and
the win is much smaller than it looks.

**Done looks like:** a run-trace showing how many times `CLAUDE.md` is read in a
multi-milestone run, and then either a milestone field carrying the conventions
or a documented note that the only lever is the file's own length.

---

## B4 — the telemetry exists and has no data in it

`specflow-stats.mjs` already measures the questions worth asking: whether a
silent PASS strands a run between milestones, whether test-first is honoured
(by its observable signature — spec written, scoped run red, then source),
whether the reviewer reviews or rubber-stamps, and whether skill routing
lands. `telemetry-snapshot.mjs` archives it per run. The instrumentation is
not the missing piece. **Runs are.**

Two corrections to the obvious version of this item:

- **Not 30-with versus 30-without.** That comparison is unfalsifiable at any
  sample this project can afford — task choice dominates, and at real model
  cost 60 features is weeks of wall time. It also measures the wrong thing.
- **The falsifiable question is what the gate caught that a review pass did
  not.** Every gate failure is already logged with its class and the attempt
  that produced it. Five to eight real runs answer it, and each one is a
  concrete story rather than a percentage nobody can reproduce.

Note that `specflow-stats.mjs` is deliberately incapable of failing anything
and is wired into no check — its own header explains why, and that decision
stays. This item adds data to it, not authority.

**Done looks like:** 5–8 archived runs in `specflow/archive/`, and a short
written read of what the gate caught. No new code required, which is why this
is cheap and keeps getting deferred.

---

## B13 — the comments are carrying two different things, and only one of them belongs there

The proposal was a `docs/` folder — `spec-trace-doc.md` and friends — to take
the prose currently living in source comments. The complaint behind it is
real: reading `spec-trace.mjs` now means passing sixty lines of header before
the first import, and that is not comfortable to work in.

**The proposal as stated should not be taken, and this repo has already
learned why.** `.spec-flow/skills.md` was deleted because nothing read it: no
script parsed it, so it could name skills that had been renamed and nobody
would learn. A `docs/spec-trace-doc.md` describing `spec-trace.mjs` is that
artifact exactly — prose about code, in a file no check binds to the code, and
the first person to find it wrong is someone who trusted it. Comments have one
property no separate document can have: whoever changes the line has already
opened the file.

**But the complaint is still right, because the comments hold two kinds of
thing and only one earns its place.**

- *Why this line is the way it is* — the anchoring argument, the failure a
  guard exists to prevent, the reason an ordering is load-bearing. This is
  read exactly when someone is about to undo it, which is why co-location is
  the whole value. It stays.
- *What the code used to be* — "this used to match `it(...)`, then Python
  arrived", "the curried branch used to be a bare `)(`". This is a commit
  message that leaked into source. Git holds it already, better, with the
  diff attached. Much of it arrived recently and in volume.

So the work is a pass that moves the second kind out and keeps the first,
which shrinks the headers substantially without creating a document nothing
checks. `no-repo-refs.mjs`'s SCAN_FILES exists to stop unchecked prose from
accumulating; a `docs/` tree would be a large new surface arriving under it.

**The rule and its machinery now exist** (`3d93f58` and the commit after it):
`.claude/skills/engine-comments` states the three-way split,
`CLAUDE.md` carries it plus the three verified git commands, `decisions/` holds
the records, and `scripts/decisions.mjs` fails when a citation does not resolve
or a record is cited by nothing. Four decisions that had been restated across
several headers are now written once and cited.

**The pass is done, and it ended somewhere other than where it aimed.** The
engine (hooks and scripts, fixtures excluded) went from ~50% comment to **37%**,
not the ~20% the rule seemed to imply. `spec-trace` 46% → 40% and 61 → 44 lines
before its first import; `spec-flow-config` 43% → 34%; the small hooks 50-63% →
46-61%.

The reason is worth keeping, because it corrects the premise this item was
opened on. Two kinds of file turned up. Those whose headers had accumulated
real history moved a lot. Those whose comments were already invariants barely
moved at all — `argv.mjs`, `io.mjs` and `unscoped-checks.mjs` sit in the
mid-forties and a search for transition text across all three returns one line.
The 50% figure was never uniform bloat; it was a handful of files carrying
history and the rest being densely commented on purpose.

So **37% is where this engine sits when the transitions are gone**, and the
skill now says so, with the explicit warning that the number is not a target: a
file at 45% whose comments are all invariants is finished, and trimming it
further deletes what the rule exists to protect.

**Done looks like:** headers that open with what the file guarantees rather
than with what it used to do, across `hooks/` and `scripts/`, with the
transition text landing in commit messages as it goes.

---

## B14 — a skill for this repo's own conventions

Raised alongside B13 and genuinely separate: a skill encoding how this project
writes code and prose — the comment split above, the verify-before-claiming
rule, the fixture-goes-red-first rule — so that the standard is loaded rather
than re-explained.

`CLAUDE.md` carries the reasoning today and is doing well at it. What a skill
adds is applying it to a specific task on demand. Worth doing **after** B13,
not before: a skill that encoded the current comment habit would make the
thing B13 exists to fix harder to change.

## Deliberately not doing

- **More agents and more commands.** Five agents that provably close the loop
  is the harder claim and the better one. Nothing in this backlog needs a
  sixth.
- **A plugin version number.** See B5.
- **A large with/without benchmark.** See B4.
- **A worked example contract in this repo.** `no-repo-refs.mjs` explains why
  it cannot exist here: a contract's job is to hold exactly the stack-specific
  values the engine refuses to know. `init` generates it from the adopting
  repo instead.