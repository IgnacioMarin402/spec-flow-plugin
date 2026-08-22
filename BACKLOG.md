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

**Open order:** B4, B14, B17, B19, B15. B15 is blocked on `claude plugin eval` early access; the others are not blocked by code.

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

### B18 — the adopter was writing code because nobody had asked what a report format is

B11 and ADR-002 settled that an adopter must write `trace.executed_tests`, and
the reasoning held for a year: a checker may not know technologies, no runner is
safe to assume, and a per-runner template list is the artifact that looks
maintained and quietly is not. All still true. **What nobody asked is whether a
report FORMAT is a runner.**

Three measurements, all against real binaries, decided it:

- **Reading raw test output cannot work, in either direction.**
  `go test ./...` prints `ok example.com/auth 0.002s` — no test names at all, so
  every requirement reads unproven. `node --test` names them and reports a
  skipped test as `ok 2 - … # SKIP`, so a naive scan proves a requirement with a
  test that never ran.
- **Narrowing to one ecosystem buys nothing.** With default reporters, two of
  four runners in the *same* language print no test names at all, and the two
  that do mark a skip differently from each other — the same spread as Node
  versus Go. A Node-only engine would owe its adopters the identical field.
  (ADR-005 names which four; this file is scanned for stack vocabulary and a
  decision record is where the evidence belongs anyway.)
- **The format does collapse it.** `<skipped/>` is in the JUnit schema and
  `# SKIP` is in the TAP spec. vitest, mocha, `node --test` and pytest all emit
  JUnit behind a built-in flag, and reading it requires knowing none of them.

So the engine ships readers (`test-report.mjs`), the contract gains
`trace.report` — a format and a path, no code — and traceability became opt-in
so a fresh install is green in one command. ADR-005 records it and supersedes
ADR-002 in part; the refusal of a per-runner FLAG table is the part that
survives, and `init` still infers only a path, still marked `REVIEW`.

**What the work turned up that the design did not predict:**

- A report holding cases that were *all* skipped is not "the suite never ran",
  and the first draft reported it as such — sending someone to fix a reporter
  flag that was already correct. The readers now return `skipped` alongside the
  names, which a command-based source cannot express at all.
- Adding one module-scope import to `spec-flow-config.mjs` silenced **every**
  case in the gate fixture, because the fixture copies the engine file by file
  and a failed import throws above gate.mjs's own catch-all. It failed loudly,
  which is the fixture doing its job — but that copy list is the engine's real
  dependency graph maintained by hand, and it is one edit away from being wrong
  again.

Fixtures: `report:check` is new and runs captures from vitest 4.1.10, mocha
11.8.0 and node 22 verbatim — **the parser was mutation-tested against them**,
three mutations, each caught by the case meant to catch it. `cold-start` now
proves adoption through the report path and skips a test by writing `<skipped/>`
the way a runner would.

**These are guards, not proof of a defect.** Nothing here was broken; the cost
was.

### B16 — "a pass is silent" was two claims, and only one of them had to be true

The README apologised for this twice on one page and both commands carried a
paragraph about it: a green milestone printed nothing, so a run that had passed
looked exactly like a run that had hung, and the documented recovery was for
the human to guess and type "continue".

That was treated as inherent — the silence is what keeps a pass from waking the
orchestrator, and waking it is the thing worth avoiding. **The two are
separable, and nothing had ever checked whether they were.** A Stop hook that
prints `{"systemMessage": ...}` with **no `decision` field** is rendered to the
user as an informational notice and still allows the stop.

Verified against the real binary rather than the docs, because this engine does
not get to take a protocol claim on trust: a repo with the gate armed, driven
by `claude -p` (Claude Code 2.1.233), produced
`Stop says: spec-flow: gate PASSED — 6fdfb93 ...` with `num_turns: 1`,
`stop_reason: end_turn` and `result=pass` in the history. The human is told; the
model is never re-invoked; the notice never becomes an input token.

So the silence is now aimed at the party it was always for. `emitNotice` holds
the protocol, `passAndExit` is its only caller, and the fixture case asserts
**both halves as one** — a pass must carry a `systemMessage` and must carry no
`decision` — because satisfying either alone restores the failure the other
prevents. Red before the fix on exactly that assertion.

Two neighbouring cases were tightened while the contract was open, and they are
guards rather than proof: `skip-dirty` and a non-`implement` phase must stay
*completely* silent. Both already passed. They matter because the notice's value
is that it is rare — a Stop fires many times per milestone while implementers
write in the background, and in every repository the user opens.

What this does **not** close: B4's question. The notice is screen output, not
record, and a human who is away still misses it — `run-trace.mjs`'s header now
says so rather than claiming a pass leaves no trace at all.

### B20 — B16's verification held for one client and was read as holding for all of them — `PENDING`, supersedes half of B16 (ADR-010)

B16 verified `emitNotice`'s `systemMessage` against `claude -p` — headless,
2.1.233 — and that verification was real: the notice showed up, `num_turns`
stayed at 1, `stop_reason` was `end_turn`. What never got checked is whether
an *interactive* session renders the same field the same way, because nobody
had a reason to expect a difference.

A real run in a consuming repo supplied the reason. Three milestones passed
the gate in a row, and the human never saw a single `Stop says:` line — the
run stalled three times waiting for a "continue" the notice never produced,
because it never arrived.

**Verified before touching anything**, against the real transcripts, not a
screenshot: two Stop hooks (one printing only `systemMessage`, one printing
only `decision:'block'`) were run through Claude Code 2.1.233 and 2.1.238,
both `claude -p` and interactive. `claude -p` recorded the `systemMessage`
every time. The interactive session recorded `decision:'block'` every time
and the `systemMessage` **zero out of three** — `hasOutput:false` on all
three passes of the run that stalled, while a `PostToolUse` notice in that
same session rendered fine, so the loss is specific to a `systemMessage` off
a `Stop` hook. Across all 120 session transcripts on the machine, the only
`Stop`-hook `systemMessage` ever recorded are the two generated to run this
check — no real spec-flow run, ever, produced one.

**The decision:** `passAndExit` now calls `emitBlock`, the channel this
investigation found DOES reach the session that lost the other one — the
same channel every `GATE FAILED` message already uses — the first time a
commit passes. Guarded to once per commit (checked against `gate-history.log`,
not a new file) so a second `Stop` over the same clean tree, which fires
routinely while a background implementer writes, does not re-block with
nothing new to report; that repeat stop keeps using `emitNotice`, unaffected.
Full argument, including what B16's cost argument still gets right and why
the comparison it was weighed against does not exist on the surface this
engine runs on: **ADR-010**.

**A second, previously undiscovered failure surfaced in the same run and is
closed by the same change, not patched separately.** Both commands told the
orchestrator to schedule a `send_later`-style self-check-in specifically so a
silent pass would not strand the run — and it never fired, in this run or (as
far as any transcript shows) any other. The candidate tools
(`ScheduleWakeup`, `mcp__scheduled-tasks__create_scheduled_task`) are
*deferred*: invisible until searched for, so an orchestrator reading its own
visible tool list correctly concludes none exists. That clause was written in
one prose-only commit (`1b9d2b5`, pre-plugin) and never run against a real
orchestrator before now. It is removed from both commands rather than
repaired — a deterministic wake at the gate closes the identical failure
without depending on which tools a given client happens to expose.

**Guards written alongside the fix, not proof of it:** every rewritten
fixture case that merely asserts the new contract shape (a green tree is
never *rejected*, extra_checks still surface in history, lint stays scoped)
would have failed against the pre-fix commit too, for the same root cause —
they don't distinguish this fix from a cruder one. The one case that does is
isolated separately: run against this same fix with the once-per-commit guard
deliberately disabled, exactly that case goes red (a second stop re-blocks)
and nothing else does — proof the guard is pulling its own weight, not
riding along on the wake-on-pass change.

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

## B17 — the comment rule was never applied to the files that test the rule's subject

B13 reports the engine at 37% comment "(hooks and scripts, fixtures excluded)".
The exclusion was never argued, and measuring it now shows what it bought:
`gate-fixture.mjs` carries 28 lines under a literal `---- the fixture's own
history ----` heading, and `spec-trace-fixture.mjs` and `init-fixture.mjs` sit
at 26% and 21% on the same pattern.

That heading is the exact shape `.claude/skills/engine-comments` sends to a
commit message. The skill grants one narrow exception — a trap someone is
likely to reintroduce earns *a single line* naming it — and the trap here is
real and worth naming: every case in that fixture once ran with
`files.length === 0` and never invoked `verify.lint` or `verify.test` at all.
Three paragraphs on how that was discovered is what the exception does not
cover.

**Not done here, deliberately.** It surfaced while the pass-notice contract was
open, and folding a comment pass into a behaviour change is how a diff stops
being reviewable. It is also genuinely a judgement call about the exception's
width, which is the kind of thing this repo decides on purpose rather than in
passing.

**Done looks like:** the history sections moved to commit messages, one line of
trap left behind in each, and B13's parenthetical either extended to the
fixtures or replaced by a stated reason they are exempt.

## B19 — `decisions/` is prose that no coupling check reads

Found by tripping the check from the other side: writing B18 named a banned
runner in BACKLOG.md, `no-repo-refs` correctly refused it, and the same
paragraph in `decisions/005-*.md` passed unexamined — because `decisions/` is
in neither `SCAN_DIRS` nor `SCAN_FILES`. It has never been scanned. CLAUDE.md
names this exact failure mode: *"add new ones there, or the next doc becomes
the path of least resistance for exactly what the check keeps out."*

**It is not obviously a bug, which is why it is an item and not a fix.** ADR-005
names four runners on purpose: a decision record's job is to say what was
measured, and "two of four runners" is a claim nobody can check. That is
evidence, not coupling — no code branches on those names. So the question is
whether the scan needs a notion of *record* prose that may name a technology it
measured, versus *instruction* prose that may not.

Answering it by simply adding `decisions/` to `SCAN_DIRS` would turn ADR-005 red
and delete the evidence to make a check pass, which is backwards.

**Done looks like:** either the distinction above encoded — a record may name
what it measured, an instruction may not — or a stated reason `decisions/` is
exempt, sitting in `no-repo-refs.mjs` where the argument it settles already
lives.

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