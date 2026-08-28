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

**Open order:** B22, B14, B15. B22 is small and came out of B4's read. B15 is blocked on `claude plugin eval` early access — re-checked and still returning it.

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

### B4 — the runs were never what was missing, and the report was counting them twice — `PENDING`

Filed as "the telemetry has no data in it". A consuming project already had
14 archived runs, 6 carrying telemetry, plus one with a hand-written
post-mortem — past the 5–8 the item asked for. What was missing was only the
read.

Writing it found the reason nobody had noticed: `collectRuns()` returned
`(current)` — the live `.claude/state/` logs — **plus** every archived
snapshot, as independent runs. A snapshot is a *slice* of that same live log,
so every run taken on this machine was counted twice. Reported 105 gate
invocations and 10 failures; the truth is **53 and 5**. It also spliced runs
days apart into one pseudo-run and reported the seam as a stall: "a PASS
followed by 11509m of gate silence" was an 8-day gap between unrelated runs.
No symptom — it scaled every total uniformly, so the report stayed internally
consistent and only a hand count disagreed.

**What the gate caught that a review pass did not**, across the five real
failures: a `verify.test` ending in `--findRelatedTests`, which with no file
arguments is a hard Jest error rather than "run everything" — the contract had
been red on every gate since it was written, while the plan and the diff were
both fine; a base that made the changed-file scope empty by construction, so
the scoped linter would never have run for any milestone of that run, refused
twice rather than passing; and a port gaining a method that broke a *different*
module's test double, taking `spec-trace` red with it because a red suite means
the tagged test never ran. None is a bug in the code its milestone was writing.

**And the counter-case, kept because a read that counts only true positives
flatters the engine:** the earliest run's two failures caught nothing, having
photographed a half-written tree. That is what produced the dirty-tree skip —
now 15 of 53 invocations, the second most common outcome.

Coverage, checked rather than asserted: two of seven failure classes have ever
fired in real work. The rest live in `gate-fixture.mjs`, which is the better
place — but `fail:lint/trace` turned out to be covered through **one of its two
doors only** (a red lint), while the traceability door ran through a case
asserting `result=fail` and nothing more. The gate classified correctly; only
the coverage was missing. Now asserted, teeth checked by mutation.

Then provoked live, twice, because it had never fired in production. First
human-driven: real `gate.mjs`, orphan REQ id, `fail:lint/trace` → one-line fix
→ `attempt=1 result=pass`, no REPLAN in reach. That proved the gate and **not**
the agent, which the first write-up claimed and the second corrected. So again
with a real `spec-flow:implementer` subagent handed only what a `SendMessage`
recovery carries and never the diagnosis: it read its plan unprompted, wrote a
real two-case test, and its `NOTES` caught two things nobody pointed it at — a
`Mk.md` naming a test path the repo's contract does not use, and a REQ id in a
doc comment (planted by accident) that its contract says proves nothing, flagged
rather than silently fixed. 34.5k subagent tokens.

Left behind, and now **B22**: `fail:base` writes byte-identical history lines
from its two causes.

### B23 — the report this engine asks for was disarming the gate every other stop — `PENDING`

`init` declares `trace.report.path` and gitignored `.claude/state/` alone. The
suite writes that report on every armed gate, so the tree was dirty at the next
stop and the quiescence guard stopped judging. Measured on a repo built through
the documented route: the run alternated `pass`, `skip-dirty`, `pass`,
`skip-dirty` — every other milestone judged, and a skip is not a failure, so
nothing anywhere said so.

The wake ADR-012 added does fire, and it misdiagnoses: it says "commit what is
left", which tracks the report, after which the suite rewrites it and the
alternation continues with the file churning in history. Recovering needs
`git rm --cached`, which no document mentioned.

**Nothing could have caught it, and where the hole was is the finding.**
`gate-fixture`'s `verify.test` is a no-op that never writes a report and seeds
one at baseline, so the file was tracked and unchanged in every case;
`cold-start` is the only fixture that walks a real adoption and it never
invokes the gate hook. The defect lived precisely in the intersection.

`init` now ignores the report's directory beside `.claude/state/`, and the gate
excludes the declared path from its own dirty check — same exclusion, same
reason as the state directory: both are dirt this engine caused, not evidence
of an implementer mid-write. Prefix rather than equality, because git collapses
an untracked directory into one entry and that is the shape the first gate
leaves behind. The new gate case runs two stops with a commit between them and
a suite that really writes a report; red on the commit before the fix.

### B24 — init wrote shell quotes into an argv that is spawned without one — `PENDING`

`parseScript` split a package script on whitespace and kept the quote
characters, so `"test": "mocha --spec \"test/**/*.spec.js\""` became a contract
whose runner receives `"test/**/*.spec.js"` as literal text and matches no
file. Reported as `detected` rather than `REVIEW`, and printed back without the
quotes, so nothing asked anyone to look.

The consequence range runs from a loud failure to a green gate over zero
executed tests — the case REFERENCE's own "do not add `--passWithNoTests`" rule
exists to prevent, arriving through a different door.

A quoted argument is the same kind of thing as a chained one: something only a
shell resolves. `parseScript` already refused `[&|;><]`, so quotes now go the
same way, with the two reported apart because the remedies differ. The `MISSING`
line names which it hit.

**It found a live instance in this repo.** `cold-start` and `skill-contract`
both declared `lint: node -e "process.exit(0)"`, and with the quotes surviving
into the argv node evaluates a string literal: measured, a body of
`process.exit(1)` exits **0**. Both fixtures had been running a linter that was
green by construction. `cold-start` now runs `node --check` over the files it is
handed — a real linter that installs nothing.

### B25 — the only escape hatch the deny hook offers did not exist — `PENDING`

`init` hardcoded `scoped_alternative: "<pm> run check"` without checking that
the script existed, and did not add it. On a repo built through the documented
route `npm run check` returns `Missing script: "check"`, and `no-gate-cmds`
prints that command three times to an implementer it has just denied — from a
hook whose own source says it is evadable. What a stuck agent learns there is
to route around the guard.

`npx spec-flow check` was the obvious fix and is the wrong one: npx in a repo
that has not installed the dependency reaches the registry, where that name
belongs to an unrelated package — the hazard the README already spells out.
`init` now writes the alias `bin/spec-flow.mjs` itself documents,
`"check": "spec-flow check"`, which resolves through `node_modules/.bin` and
fails plainly when the dependency is absent. A `check` the repo wrote itself is
never replaced, on the rule `specs/README.md` already had.

### B26 — an agent contract described a gated check as unconditional — `PENDING`

`agents/implementer.md` told the model that `spec-trace` fails a milestone with
no `Skills:` field. That stopped being true when the check became
`trace.require_skills_field`, off by default. `agents/reviewer.md` was updated
in that commit and the implementer was not — the same coupled-contract failure
`CLAUDE.md` documents, one file away from the check that looks for it, since
`agent-contracts.mjs` compares planner against reviewer and nothing compared an
agent's prose against the engine's behaviour.

Verified before the fix: default contract, milestone with no field, `spec-trace`
exits 0.

The new half of `agent-contracts.mjs` reads the gated fields out of
`spec-trace.mjs` itself rather than listing them, then requires that an agent
asserting a spec-trace failure about a gated subject names the gating field in
the same file. It cannot judge whether prose is true; it can insist the
condition is stated, which is the fact that goes stale when a check moves
between unconditional and opt-in. Red on the live defect and on nothing else.

### B27 — the front page promised behaviour; the machine binds names — `PENDING`

"A feature ships only when a test that actually ran proves every requirement in
its spec." What is enforced is that a test whose reported name carries the id
executed and did not fail. Measured: a requirement added to `specs/` and a test
carrying its id with an empty body reports `OK — proven by` and passes the gate,
with nothing implemented.

This is ADR-001 working rather than failing — the engine reads no source code,
which is what makes it stack-agnostic. The gap was the claim, in a repo whose
own rule is that a check whose reach is overestimated is the same liability as
one that is disarmed. The README now states what the machine binds and what the
reviewer and the sign-off are for.

**Both follow-ons are now resolved, and one of them by refusal.**

*The report-side check does not exist and cannot.* The JUnit schema has an
`assertions` attribute, which made it look available; captured from real runs,
no runner in scope populates it. `time` is the only quantity present and it
does not separate the cases — the real assertion and the empty body measured
1.45ms and 0.28ms, a gap under the noise of a loaded runner, and **mocha
reports `time="0"` for tests that genuinely ran and passed**. Any "zero time is
suspicious" rule flags real proofs on one of the three runners this engine
supports. Refused, with the measurement, in ADR-020.

*The reading is placed in `MODE=FOLD`.* Whether a test asserts its requirement
is a judgement, not a parse, so it belongs to a model — the question was which
and when. FOLD already reads the deltas, already verifies each landed in
`specs/`, already reports through `GAPS:`, and is already forbidden from
touching tests. It costs **no new agent invocation**: one pass per change
rather than the per-milestone reviewer pass the plan floated, which would also
have reversed a decision already taken and recorded. It reports; it does not
gate.

Left behind and closed with it: `GAPS:` was a field no command named, so the
one finding nothing else in this engine can produce reached the orchestrator
and stopped. `agent-contracts.mjs` now binds every spec-writer return field to
a command that reads it or to a stated exemption — red on `80a2a56`, where
`GAPS` was among the unrouted.

### B28 — the cheapest outcome in the flow was paying the highest price — `PENDING`

A repeat stop on a commit already reported green ran lint, the whole suite and
every unscoped check, and then discovered from the history that it had nothing
to say. The sha guard was inside `passAndExit`, after the work. Measured with a
3-second suite: three stops on one clean tree, 3.3s each, two of them to print
"already reported". On a five-minute suite that is five minutes of frozen
session per repeat stop, and Stop fires on every turn end.

The check now runs before anything is spawned. The tree is clean and the sha
unchanged, so no verdict this gate is entitled to reach can have moved; ADR-008
requires the suite never be scoped to the diff, not that it be re-run against a
tree byte for byte identical to one it just passed. What is given up is catching
a suite that goes red with nothing committed — and a flaky suite doing that
would today drive a milestone already reported green into a REPLAN.

The stop is still recorded, with every field `-`: reprinting `lint=0 test=0` for
commands that did not run is the lie `lintField` exists to refuse. The
now-unreachable branch in `passAndExit` was removed rather than left looking
armed, and REFERENCE's routing flowchart moved the decision to where it now
happens.

Two cases. The measuring one — a `verify.test` that appends a line, asserting
the suite ran once across two stops — is red on the commit before. Its companion
(a new commit is judged however recently the previous one passed) passes both
ways: a guard on the new behaviour, not proof of the defect.

### B29 — one half of the distribution could not say which revision it was — `PENDING`

The gate stamps `engine=` into every `gate-history.log` line. `spec-flow check`
is the other install (ADR-016) and said nothing, so a CI log and a gate line
could not be compared and a drift between the two copies was invisible from
both sides. It now prints the revision it resolved — reported, never checked,
for the reason ADR-004 gives about `cc=`. A git-spec install has no `.git`, so
the answer is usually the `v`-prefixed version, which is the honest one and why
ADR-018 gave that prefix a meaning.

The README's install line is pinned too. A bare git spec follows `main`, so CI
re-resolved the engine on every install and two builds of one commit could be
judged by two engines; `#main` is written out as the unpinned form so that
choosing it is a choice.

Asserted in `package-fixture`, the only check that runs the CLI the way a
consumer installs it — from a tarball with no `.git`, which is exactly the case
whose answer is the fallback.

### B30 — B13 shipped a rule and no instrument, and has drifted since — `PENDING`

B13 closed on "the engine settled around 37%". This file's own header says an
item is done when a check goes red before the fix and green after, **not when a
paragraph says so**, and that number is a paragraph: measured with one
consistent method at `34c4fc2` — the commit that declared the pass finished —
the engine reads 42.0% and `spec-trace` 46%, not 37% and 40%. No counting method
tried reproduces the recorded figures.

Measured across three commits in a throwaway clone, same script each time:

| commit | date | engine | spec-trace | config | gate |
|---|---|---|---|---|---|
| `34c4fc2` | 08-16 | 42.0% | 46% | 37% | 50% |
| `11b431c` | 08-22 | 42.9% | 50% | 41% | 51% |
| `80a2a56` | 08-27 | 44.2% | 50% | 43% | 53% |

Three identical files, all rising: not a composition effect. And the rise is of
the kind B13 existed to remove, not only of ratio — transition text went
**15 → 20 → 23** over the same commits, counted with a pattern narrowed until it
stopped matching ordinary English. (A first, wider one reported 48 against a
real 23, by matching "before this" and "it was" inside invariants. Reporting
that number would have been the overclaim this repo refuses.)

**What this is not is a request to trim comments.** B13 is right that the 50%
figure was never uniform bloat, and the skill says a file at 45% whose comments
are all invariants is finished. The skill goes further and supplies this item's
own argument: ratio and transition text are near-independent here, "which is why
a percentage is a poor way to decide where to look and a worse way to decide
when to stop". The rule had already identified the right signal and shipped
nothing that measured it.

`scripts/comment-transitions.mjs` counts transition text over `hooks/`,
`scripts/` and `bin/` — no fixture exemption, since the skill says outright that
none is exempt and the one time they were, the exclusion was hiding history in
four files. The count is asserted **equal** to a recorded number rather than
capped: a ceiling only notices the direction that gets worse, and a count
drifting below it is the same stale figure this replaces. Zero is not the
target — the skill names the case where an old shape is a trap and one line
naming it is an invariant.

Baseline 29, and the check states in its own header that a minority of those are
a domain sense rather than a file's past. It is a tripwire, not a census: its
job is to move.

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

## B22 — two different refusals write the same line, and only one record survives

`hooks/gate.mjs` refuses an empty changed-file scope for two different
reasons, and writes both with byte-identical arguments — `hist('fail:base',
'-', '-', histDashes(config), '-')` at both call sites. One is a base this
engine cannot NAME; the other is a base that resolves to HEAD, meaning the
work is being done on the base branch itself. They need different fixes from
a human: declare `verify.base_ref`, or move the run onto its own branch.

**The peers were checked, and this is the only class with the problem.**
`fail:lint/trace` and `fail:behaviour` also have two doors each, but both come
from the single call site that writes real field values, so their doors are
told apart by `lint=1` vs `spec=1` and by `test=1` vs a check's own field.
Every other class has exactly one cause. `fail:base` is alone in being
indistinguishable from its own record.

The block message does distinguish them, which is why this has never hurt
anyone standing in front of it. The message is not kept; the history line is.

**The run behind it:** B4's read asserted the HEAD door for a real archived
failure and could not have known — the claim was corrected in the same pass
that made it (`69c6a7e`). That is the exact reader this matters for: someone
reading a run's telemetry after the fact, which is the only thing B4 has.

Sharper because `REFERENCE.md` already states the principle this violates —
*"'Nothing changed' and 'I could not tell' must never produce the same
outcome, because one of them is a pass."* It is applied to the decision, where
both refuse, and not to the record, where both look the same.

**Done looks like:** the two call sites write distinguishable lines, a
`gate-fixture.mjs` case per door asserting which one it got (both doors are
already constructed there — `baseRef: 'origin/does-not-exist'` and
`stayOnBase: true` — and today both can only assert the class), and
`REFERENCE.md`'s empty-scope paragraph naming the field that tells them apart.
Small: it is a token in one line, not a redesign.

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

**Correction, from B30.** The percentages in this entry are not reproducible.
Measured with one consistent method at `34c4fc2` — the commit that declared
this pass finished — the engine reads 42.0% and `spec-trace` 46%, against the
37% and 40% recorded above; no counting method tried produces the recorded
figures. The conclusion the entry draws is unaffected and still right: the
reduction was uneven because the ratio was never the signal. What the entry
lacked was an instrument, so nothing noticed the figures rising afterwards.
`scripts/comment-transitions.mjs` is that instrument, and it measures
transition text rather than density, for the reason this entry itself
discovered. See **B30**.

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