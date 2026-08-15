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

**Open order:** B9, B11, B3, B4, B5. B9 is now documentation — its hypothesis
was verified — and B11 is the half of B10 that is a decision rather than work.
B2 is not an item: it is the acceptance test for B9.

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

### B6 — the coupling check could not see the file that proved it was needed — `98477a5`

`ci.yml` pointed at a `conformance/` directory and a design document, neither
of which exists here. Reference removed, and the workflow added to
`SCAN_FILES`.

---

## B9 — the CLI half of the install has no path that is not npm

**Priority: first among what is open, and now documentation rather than
design — the hypothesis below was executed and held.**

**The run.** A Python repo with no `package.json` and no `node_modules`, and a
clone of the engine with neither:

```
git clone <engine> && node <engine>/scripts/check-changed.mjs
  --- ruff --- --- pytest --- --- spec-trace ---
  spec-trace: OK — 1 requirement(s), every one proven by a test.   exit 0
```

It works because the engine has **zero runtime dependencies**: `dependencies`
is empty and every import is `node:` or relative — the linter and type-checker
are development-only. `git` and Node are already in the README's requirements,
so this path adds none.

So what remains is a README section, not an investigation.

The README's step 2 is `npm install --save-dev github:...` plus three npm
scripts, and it exists for a real structural reason: hooks reach the engine
through `${CLAUDE_PLUGIN_ROOT}`, which exists only inside a session, so a
terminal and CI need their own route to the same file. That "same file, same
commands, same result" property is one of the strongest things this project
claims.

A repo with no `package.json` has no documented way to get it. It would have
to add one solely to host this CLI — which is the engine asking the consuming
repo to adopt a stack, the exact direction the whole extraction reverses.

Worth stating precisely, because the neighbouring claim is false: **the engine
being written in Node is not the coupling.** `hooks.json` invokes
`node ${CLAUDE_PLUGIN_ROOT}/...`, the gate runs the contract's argv and never
learns what it is running, and a checker written in one language checking a
repo written in another is ordinary. Requiring Node *on the PATH* is an install
requirement. Requiring the consuming repo to be an npm package is a coupling.
Only the second is this item.

**Done looks like:** the Python cold-start job in B2 reaching a green
`spec-flow check` without the repo having acquired a `package.json`.

---

## B11 — should `init` generate the translator for a runner it detects?

**A decision, not work, which is why it is its own item.** B10 stopped at a
stub because going further requires naming test runners inside `scripts/`, and
`no-repo-refs.mjs` bans exactly that. The ban is not an obstacle that grew
around this feature — its header argues the position, and names `init` as
needing no exemption *because* "it names nothing, it reads what the repo
already declares".

Two ways past it, and they are not equivalent:

1. **A `templates/` directory outside the scan**, holding one worked
   translator per runner, which `init` selects by matching the `test_name` it
   already read from the repo. No runner name appears in any scanned file —
   the knowledge is data, keyed on what the repo declared. Against it: the
   check's header explicitly says there is no exemption list and no
   `examples/` directory, so this creates the thing that text says does not
   exist.
2. **Accept a runner list in `init`** and relax the ban for that file, on the
   ground that a generator may know technologies while the checker may not.
   Against it: a list rots, and the ban currently needs no per-file reasoning
   to apply.

Worth noting what the cost of doing neither actually is: an adopter writes
four lines into a file that already tells them what to write, once. That is a
real cost and a small one, which is why this is not urgent.

**Done looks like:** a stated decision in `no-repo-refs.mjs`'s own header,
whichever way it goes, so the next person to meet this reads the reasoning
rather than re-deriving it.

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

## B5 — declare compatibility, check it at preflight — do not re-add a plugin version

The half worth doing: nothing states which Claude Code and Node versions this
engine is known to work against, and `preflight` — which already refuses a run
whose contract does not load — is where a mismatch should surface, before any
agent has run.

**The half to refuse: semantic versioning on the plugin.** Commit `8fe3b8a`
removed `version` from both `.claude-plugin/plugin.json` and the marketplace
entry, on a verified reading of how Claude Code resolves a plugin's version:
`plugin.json` → marketplace entry → git SHA, first one set wins. Both were
pinned at `0.1.0` and unchanged across nine PRs of real behaviour change, so
`/plugin marketplace update` compared `0.1.0` to `0.1.0`, found them equal,
and told every install there was nothing new. Falling through to the SHA fixes
it without depending on anyone remembering to bump a number.

Re-adding a version string restores that bug the first time someone forgets.
A compatibility table is a different artifact from a version field, and only
the table is wanted here.

**Done looks like:** a supported-versions statement in REFERENCE, and a
preflight refusal with a fixture case for a Node version below the floor.

---

## B2 — nothing has ever run the documented install

**Not an item on its own any more: this is the acceptance test for B1 and B9.**
A CI job that takes an empty **Python** repo through the README verbatim and
ends on a green `spec-flow check` fails today for exactly two reasons — the
source reader (B1) and the absence of any non-Node path to the CLI (B9) — and
for no others. That makes it the check that says when both are actually done,
rather than a third pile of work.

`gate-fixture` and `init-fixture` build throwaway repos and cover steps 3 and
4 of the README (`init`, `check`), including installing the engine at a
separate path the way it actually ships. Steps **1 and 2 are unexercised**:
no run of `claude marketplace add`, `claude plugin install`, or
`npm install --save-dev github:...` exists anywhere in CI or in a fixture.

That is also the gap `.github/workflows/ci.yml:4` already names — it points
readers at a `conformance/` directory and a `docs/spec-flow-as-a-plugin.md`,
**neither of which exists in this repo** (see B6).

The reframe worth making: the goal is not *fewer* install commands. The two
installs are structural — hooks reach the engine through
`${CLAUDE_PLUGIN_ROOT}`, which exists only inside a session, while a terminal
and CI need the same file. Collapsing them would trade away the "same file,
same result" property that makes the local check and the gate agree by
construction. The gap is that the path is undocumented in the directions that
have no happy case: **updating and uninstalling**, and what a partial install
looks like from the adopter's side.

**Done looks like:** a CI job that takes an empty repo through the README
verbatim and asserts a green `spec-flow check` at the end, plus documented
update and uninstall paths.

---

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