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

**Open order:** B14, B15. B15 is blocked on `claude plugin eval` early access — re-checked and still returning it. B4's read is written: it was never blocked on more runs, and the one gap it found — `fail:lint/trace` has never fired outside the fixture — is a run to provoke, not a sample to grow.

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

### B19 — a whole directory of prose was outside the coupling scan, and the reason it stayed there had expired — `PENDING`

`decisions/` was in neither `SCAN_DIRS` nor `SCAN_FILES`, so twelve records
were never scanned. It surfaced from the other side: a banned token in
BACKLOG.md failed, and the same paragraph in `decisions/005-*.md` passed.

**The item deferred itself on an argument that no longer held, and running it
is what showed that.** It reasoned that adding `decisions/` to the scan would
turn ADR-005 red, since that record names four runners on purpose, and that
closing it therefore required encoding a distinction between *record* prose
that may name what it measured and *instruction* prose that may not. Adding
the directory in a throwaway clone reported `OK — 62 file(s)`, exit 0. No
runner name has been in `BANNED` since ADR-007 made Node the scope and drew
the line at one repo's vocabulary rather than one ecosystem's, so the tension
the item was built around had already been settled elsewhere. The distinction
was not encoded, and the header now says why it is not needed.

**What the fix is actually for is one directory wide; what was missing was the
class.** The check reports a count and exits 0 when it finds nothing, so a scan
reaching the wrong set of surfaces produces the same output as a clean repo —
this engine's own failure mode, in the check whose job is being armed. Nothing
had ever verified the scan's reach, which is why the gap was found by accident
rather than by a check.

`scripts/coupling-fixture.mjs` now asserts each claimed surface is reached, one
case per surface, from a list **written out rather than imported** — a fixture
reading `SCAN_DIRS` would agree with a directory dropped from it and would have
passed for as long as this gap was open.

**Red before, green after, and not only on the reported defect.** Against
`df9388e` the fixture failed exactly two cases — `decisions/` unscanned, and
the file count 12 where 13 surfaces exist — while the other eleven passed, so
the red was the defect and not the scaffolding. Mutating the fixed check to
drop an unrelated directory (`agents`) reproduces the identical two failures,
which is the evidence that the guard covers the class rather than the instance.

Went with it: `decisions.mjs`'s `CITE_DIRS` described itself as "the same
surfaces the coupling check scans", which this change made false. The two now
differ on `decisions/` deliberately and the comment says why — a record citing
another record is a cross-reference, not the code reaching for the decision
that governs it, so including it there would let a record keep itself alive.

### B17 — the fixtures were exempt from the comment rule, and the exemption was hiding less than it looked — `PENDING`

The item opened on `gate-fixture.mjs` carrying 28 lines under a literal
`---- the fixture's own history ----` heading. **That evidence was already
stale when this was picked up:** `e9e57af` removed exactly that section five
days after the item was written, and nobody updated the entry. Re-measuring
first is what surfaced it, and it is the second item in a row whose stated
premise had expired before anyone acted on it.

**The exclusion was hiding less than the item assumed.** B13 reported the
engine at 37% "(hooks and scripts, fixtures excluded)" and never argued the
parenthetical. Counted the same way, the fixtures sit at **22%** — well under
the engine — so the exempt half was never the bloated one. What the exemption
did hide was transition text in specific files, which is a different problem
with a different fix.

Eight blocks in `spec-trace-fixture.mjs` and one each in `init-fixture.mjs`,
`gate-fixture.mjs`, `hook-smoke.mjs` and `cold-start.mjs` narrated what the
code used to be — the old matcher's call shapes, a curried-paren parser bug,
four skip spellings, a build-directory skip list, a dispatcher leaving argv[1]
pointing at itself. Each is now the invariant it established, in the present
tense, with the trap named where someone could reintroduce it (a location
check, a skip list, an early exit on the grace path) and three ADR citations
where the argument already had a record.

**The measurement after the pass is the finding worth keeping: 22% → 22%.**
Twenty-two comment lines left about a thousand. Ratio and transition text are
close to independent here — the files carrying history were not the files
scoring high — so a percentage is a poor way to decide where to look and a
worse way to decide when to stop. `.claude/skills/engine-comments` now says
that, states no file in `hooks/` or `scripts/` is exempt, and replaces B13's
unargued parenthetical.

No regression test, and none is possible: this changes no behaviour. What it
is held to instead is the full suite staying green across a diff that touches
five fixture files, which it did.

### B21 — the gate's one silent outcome was the one that meant nothing had been judged — `PENDING` (ADR-012)

A `/spec-flow` run on a consuming repo shipped four milestones, folded the
change, committed and ended its turn expecting the gate. Nothing happened for
twelve minutes, until a human asked why. `gate-history.log` holds the whole
incident in three lines:

```
05:17:31  68110ee  result=pass
05:18:17  4a437c9  result=skip-dirty  files=1
05:30:39  8de111d  result=pass          <- after the human asked
```

Two defects, and the second is why nobody learned about the first.

**The fold produces a half-staged tree by construction.** `MODE=FOLD` stamps
`**Status:** SHIPPED` on the change spec and then moves the folder. `git mv`
moves the file's INDEX entry, which still holds the pre-stamp blob, so the
staged rename carries the unstamped file and the stamp stays in the working
tree — `RM` in `git status`. The orchestrator's `git commit` landed `7 files
changed, 0 insertions(+), 0 deletions(-)` under a message reading "Stamps
SHIPPED and archives"; the evidence was on screen at commit time and nothing
was looking at it. Reproduced from an empty repo in six commands. No file in
`agents/` or `commands/` contained the string `git add` or `git commit` at
all — how to commit a fold had never been said. Both now say it, and the
spec-writer stages after both edits rather than before one of them.

**`skip-dirty` is the only gate outcome silent to both parties, and it is the
one that means nothing was judged.** The streak guard counts stops and needs
ten. This produced one: the skip ALLOWS the stop, the session went idle, and
an idle session fires no further `Stop` — the counter was waiting on events
that had stopped happening. What the silence covered was real. `spec-trace.mjs`
against `4a437c9` in a clone exits 1 on `specflow/archive/trainer-module/
spec.md: no status`, which is the missing stamp, which is the dirt.

The discriminator was already in the log. A skip is legitimate while an
implementer writes, and there HEAD is a commit the gate has already passed —
the flow judges a milestone before the next one starts. In the stall the
orchestrator had just committed, so the tree was dirty on a commit nothing had
ever judged: the streak message's own words, "a milestone NOTHING ever judged",
reached in one stop instead of ten. The gate now blocks once per such commit,
guarded the same way ADR-010 guards the green pass and needing no new state.

Done: `a dirty tree on a commit nothing has judged wakes the run` in
`gate-fixture.mjs` — red against the pre-fix engine, green after, and **the
only case that moved**, which is what says the re-specified silence case and
both streak cases still test what they always tested. Those three now seed
history on the fixture's own HEAD: seeded with a literal sha they describe some
other tree, which the gate now reads as a commit nothing has judged, and all
three would have quietly changed meaning.

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

### The read

Taken on a consuming project with 14 archived runs, 6 of them carrying
telemetry, plus one earlier run that has a hand-written post-mortem instead.
**53 gate invocations: 33 pass, 15 skip-dirty, 3 fail:behaviour, 2 fail:base.**

Read those numbers only from a build that has the tier-dedup fix. Before it,
the same data reported 105 invocations and 10 failures, because a snapshot is
a slice of the live log and both tiers were counted as separate runs.

**Five real failures, across two runs. Each one is a story, and none of them
is a bug in the code the milestone was writing.**

- **A contract that was red on every gate, in every milestone.**
  `verify.test` ended in `--findRelatedTests`. The gate runs the suite
  unscoped on every armed gate by design (ADR-008), so it appends no file
  arguments — and `--findRelatedTests` with no files is a hard Jest CLI
  error, not "run everything". Two `fail:behaviour` in a row at one sha,
  `test=1` both times. The repo's contract had been failing every gate since
  it was written, and the milestone under it was fine. A review pass reads
  the plan and the diff; neither is wrong here. Only running it says so.

- **A run whose linter was never going to be invoked.** Two `fail:base` at
  one sha, 44 seconds apart, `lint=-` and `files=-`. The gate refused twice
  rather than reporting the pass that everything else would have supported.
  This is the case the engine exists for: had it proceeded, the history would
  have recorded `lint=-` for every milestone of the run, which reads exactly
  like a milestone that honestly touched nothing in scope. Eight minutes
  later the next gate linted 28 files, so whatever a human did in between
  worked.

  **Which of the two `fail:base` doors fired cannot be recovered, and that is
  this read's own finding rather than a gap in it.** `resolveBase` throwing —
  a base this engine cannot name — and a base that resolves to HEAD itself
  are different refusals needing different human fixes, and
  `hooks/gate.mjs` writes them with byte-identical history lines
  (`hist('fail:base', '-', '-', histDashes(config), '-')` at both call
  sites). The fixture tells them apart because it constructs each and can
  read the message; telemetry cannot, and telemetry is what survives. An
  earlier draft of this read asserted the HEAD door from the log, which the
  log does not support.

- **A port change that broke a different module's test double.** A milestone
  added `catchPokemon` to a repository port; the fake repository in *another*
  module's suite stopped satisfying the port's shape. `test=1` — and
  `spec=1` with it, because a red suite means the tagged test never ran, so
  the milestone's own new requirement ids had nothing proving them. One
  failure, two checks, one cause. The reviewer had read the plan for the
  module being changed, which is the one place this does not appear.

**And the counter-case, which belongs in the read as much as the rest.** The
earliest run's two gate failures caught nothing at all: subagents run in the
background, so the gate photographed a half-written tree and spent an Opus
REPLAN concluding the files were already correct. That is what produced the
dirty-tree skip — and `skip-dirty` is now 15 of 53 invocations, the second
most common outcome. A read that only counted the true positives would make
this engine look better than it is and would hide where a fifth of the gate's
work goes.

**What this does not answer.** Two of seven failure classes have ever fired
in real work. `fail:lint/trace`, `fail:contract`, `fail:scope`, `fail:killed`
and `fail:hook-error` have not — all five appear in
`scripts/gate-fixture.mjs`, deterministically and in CI, which is the better
place for them.

Checking that claim rather than asserting it moved it. `fail:lint/trace` is
one class with **two doors**, and only the lint door was actually asserted: a
red lint with everything else green. The traceability door — lint green,
suite green, `spec-trace` red, a test that proves its requirement but never
named its id — ran through a case that asserted `result=fail` and stopped
there, so the same failure classifying as `behaviour` and buying an Opus
REPLAN would have passed it. The gate turned out to classify correctly; what
was missing was anything that would notice if it stopped. Now asserted, with
its teeth checked by mutation.

That leaves the honest gap smaller and sharper. The branch is proven to fire
and to route; what had never happened is a real implementer receiving that
message and fixing the tag without escalating. The nearest real run missed it
by a hair — the trainer port failure had `spec=1`, but `test=1` alongside it,
so it was `behaviour` by rule and took the expensive route.

**Provoked directly, on 2026-08-27, against the same consuming project —**
not the fixture: `hooks/gate.mjs` invoked for real on a discardable branch, an
orphan `REQ-POKEMON-015` declared with no test naming it, everything else
untouched. First invocation: `attempt=1 result=fail:lint/trace lint=- test=0
spec=1 domain=0`, with `gate-failure.log` naming the exact id and saying the
plan was not in question. Adding one `it('REQ-POKEMON-015 ...')` closed it:
`attempt=1 result=pass` on the very next gate, no second `attempt=` line ever
written, so no REPLAN was ever in reach. The branch is discarded; those two
history lines are the record.

**What that probe did NOT establish, stated plainly because the sentence
above reads like it did.** The gap named earlier was a real implementer
receiving the block message and fixing the tag without escalating. A human
drove this probe, already knowing what the message would say and what the fix
was — which tests the gate, not the agent.

**Closed separately, on the same date, against a real `spec-flow:implementer`
subagent.** A second discardable branch carried a genuine (if small) delta —
`Pokemon.isLegendary()`, one real method, committed — with its
`specflow/<SLUG>/plan.md` and `milestones/M1.md` written the way a real
milestone reads, and the same real gate fired to produce a fresh
`gate-failure.log`. A fresh `spec-flow:implementer` `Agent` call was then
handed only what a `SendMessage` recovery actually carries: which milestone,
where its plan and gate-failure log live, and its own contract — never the
diagnosis. It read both files unprompted, wrote a real two-case test — not
the `expect(true).toBe(true)` the human-driven probe used, which is the
minimal edit that flips `spec-trace` and nothing more — and its `NOTES`
caught two things nobody told it to look for: `Mk.md` named a test path the repo's own contract does not use, so
it wrote the test where the contract's `proof_dir` actually points instead,
citing an existing file as precedent; and the `isLegendary()` doc comment (my
own fabricated "prior pass") put the REQ id in a comment, which its own
contract calls out as never proving anything — it named this in `NOTES`
rather than silently fixing it, correctly reading its own instruction as
"fix exactly those violations" and nothing more.

The fix closed the gate in one attempt (`attempt=1 result=pass`, same as the
human-driven probe) once committed — with the process producing one honest
false failure of its own along the way: a first gate re-run was killed by
this session's own tool timeout mid-suite, and the NEXT gate invocation
correctly read the stranded `running` line and reported `fail:killed` rather
than silently treating the tree as passing — the mechanism `hooks/gate.mjs`
documents for exactly this case, observed firing for real rather than only
in the fixture. 34.5k subagent tokens, 18 tool calls, ~73s of agent time —
the cost of the one thing the first probe could not buy.

Both branches are deleted; the target repo's `.claude/state` was restored
both times to what it held before.

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