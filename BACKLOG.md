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

**Open order:** B3, B4, B14. None is blocked by code.

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

What it is not: proof that `claude marketplace add` works. Steps 1 and 2 of
the plugin half still have no automated run, and that gap is smaller than it
was but real.

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

### B6 — the coupling check could not see the file that proved it was needed — `98477a5`

`ci.yml` pointed at a `conformance/` directory and a design document, neither
of which exists here. Reference removed, and the workflow added to
`SCAN_FILES`.

---

## B3 — the fixtures cover the deterministic half; the contract also has a prose half

Roughly 2,350 of this repo's ~8,000 lines are fixtures — the gate, spec-trace,
init and the other nine hooks — all in CI on every push. That half is in good
shape, and any plan that starts with "add tests" should say which half it
means.

The uncovered half is the five agents and two commands: ~700 lines of Markdown
that are not documentation *about* the contract, they **are** the contract.
The failure mode is already recorded in `CLAUDE.md`: a `Skills:` field was
added to the milestone template and the planner's instructions, the reviewer
was never told, and a missing field passed review unseen. No fixture could
have caught it, because nothing executes those files.

`claude plugin eval` is the tool built for this surface. Highest-value cases,
in order: the reviewer's `CHANGES_REQUESTED` path (never yet observed to fire
— see B4), the triage classifier's five cases in `/spec-fix`, and the
orchestrator's refusal to write code itself.

**Done looks like:** an eval suite in CI covering at minimum the reviewer's
reject path and all five triage cases.

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