# Backlog

Ordered by what each item changes, not by size. Every entry states the run
behind it — a proposal with no run attached is a hypothesis, and this file
keeps the two apart on purpose.

Items are written so that "done" is a check that goes red before the fix and
green after, not a paragraph someone judges. Where an item cannot be proven
that way, it says so.

**Order:** B1, B7, B8, B9, B3, B4, B5, B6. B2 is not an item any more — it is
the acceptance test for B1 and B9, and is kept in place for that.

---

## B1 — the engine reads source code in exactly one place, and that is the whole coupling

**Priority: first.** The only item here that makes a documented capability
fail closed on a new adopter's first run.

The README's second paragraph says the engine "has no opinion about your
language, framework or architecture". Today that is false, and the useful
finding is not *that* it is false but **how narrowly**.

**The run that showed the symptom.** Two throwaway repos, identical in every
respect except the test idiom — same capability spec, same requirement id,
same scope marker, a real test naming the requirement and not skipped:

```
repo A   tests/auth.test.ts    it('REQ-AUTH-001 — a bad password is rejected', ...)
         -> spec-trace: OK — 1 requirement(s), every one proven by a test.  exit 0

repo B   tests/auth_test.py    def test_REQ_AUTH_001_a_bad_password_is_rejected():
         -> REQ-AUTH-001 (specs/auth.md) has no test.                       exit 1
```

pytest, Go, JUnit, Rust and RSpec all land in repo B's column. RSpec is the
one worth noticing: `it "..." do` is the same *word* and still misses, because
the matcher requires the parenthesis — so this is narrower than "JS-family",
it is one call shape.

Downstream that costs the whole run, not one check. spec-trace is in the gate,
so every milestone fails, survives the retry ladder, and the fifth failure
writes `phase blocked`. A repo on any other stack cannot finish one milestone.

**The run that found the cause.** Every reader of consuming-repo file contents,
audited across `hooks/` and `scripts/`. Everything outside spec-trace reads one
of three things: the engine's own `.claude/state/*`, the contract, or Markdown
this flow itself writes (`specs/`, `specflow/**`, milestone files).

**`scripts/spec-trace.mjs:233` is the only line in the engine that reads a
source file the consuming repo wrote in its own language.** The two constants
that fail — `TEST_TITLE` (:69) and `NOT_RUN` (:71) — hang off it and nothing
else.

So the question was never "how do we support more languages". The engine runs
`verify.lint` and `verify.test` as argv from the contract and never learns what
they are; none of the ten hooks holds a language opinion; the state machine,
the retry ladder, the attempt cap and the phase file are all neutral. **Reading
source is what forces the engine to know a language, and it happens once.**

Two things follow, and they are why this entry replaces a version that
proposed teaching the matcher more idioms.

**One: "does this test run?" is a runtime fact being derived statically.**
`NOT_RUN` works only because JS puts the skip marker in the same expression as
the declaration (`it.skip('…')`). pytest puts it on the line above, JUnit and
Rust likewise, Go puts it *inside the body* and possibly behind a runtime
condition that no expression decides. A contract field for the title alone
delivers proofs and silently loses skip detection — which turns today's loud
failure (nothing proven, gate red) into a quiet one (a skipped test counts as
proof, gate green). That is precisely the failure this engine exists to close,
so it is not an acceptable intermediate step.

**Two: the whole-repo walk is the same defect wearing different clothes.**
`NEVER_WALK` (:108) lists `node_modules, dist, build, coverage, out, vendor` —
an ecosystem opinion held by the engine, missing `venv`, `site-packages`,
`__pycache__` and `target`. Verified: a Python repo with an ordinary
`venv/` has 202 vendored `_test.py` files walked, down into `site-packages`.
It cannot manufacture a false proof today (a third-party package will not
contain this repo's own `REQ-` ids) so it is cost rather than incorrectness —
but note the shape: the contract already overrides the list in one direction
(`proof_dir` is never skipped) and the repo cannot add to it in the other.

**The decision: proofs come from what the runner reports as executed.**

The contract declares a command whose output names the tests that actually
ran. The engine parses no source and knows no format beyond "lines naming a
test". The runner becomes the authority on what executed, which is the same
move the engine already makes one level up — the gate does not ask the model
whether the tests passed, and spec-trace should not ask a regex whether a test
ran.

What that deletes: `TEST_TITLE`, `NOT_RUN`, the whole-repo walk (:224), and
`NEVER_WALK`'s role in finding proof. It also closes two limitations the file
already documents — `it.each([foo(1)])('…')` and nested parentheses — because
the runner reports expanded names. `trace.proof_dir` survives in its *other*
job, telling agents where new tests go, which was always separate from
detection.

What it costs, and none of it is hidden:

- **A missing or stale report must be a refusal, never a pass.** Same rule the
  engine already applies to an unresolvable base: "nothing changed" and "I
  could not tell" must not produce the same outcome.
- **The gate reorders.** spec-trace runs at `gate.mjs:280`, ahead of lint
  (:286) and the suite (:310); it has to move after the suite. Nothing
  short-circuits — all three run on every armed gate regardless — so the
  reorder costs nothing.
- **`spec-flow trace` alone stops being self-sufficient.** Checked, and the
  blast radius is smaller than it sounds: `phase-guard` only runs the unscoped
  checks on a `done` write (:122 returns before that on every other value), and
  `check-changed` already runs the suite at :93 before the checks at :101. So
  `spec-flow check`, the everyday command, is unaffected; only the bare `trace`
  alias gains "run the suite first".

**This is a coupled-contract change, not a local edit.** It touches
`unscoped-checks`, `gate`, `phase-guard`, `check-changed`, and the prose in the
agents and REFERENCE. The instruction to name the requirement in the test title
survives unchanged — the report carries names. The skip rule changes and gets
*stronger*: "a test under `it.skip`/`it.todo`/`xit` is unproven" becomes "a test
the runner reports as skipped is unproven", which no change of language evades.

**Done looks like:** `spec-trace-fixture` cases for pytest, Go and JS passing
through one path, red against `HEAD` today; and a venv case asserting the walk
no longer descends into it.

**Not planned as a `/spec-flow` run on this repo.** Modifying spec-trace while
spec-trace gates the run is circular, and a failure would not say which half
broke.

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

## B6 — the coupling check does not scan `.yml`, and CI already proves why

`no-repo-refs.mjs` scans `SCAN_DIRS` plus an explicit `SCAN_FILES` list, and
its own header argues that every prose doc must be in that list or the
unscanned file becomes the path of least resistance. Workflow files are
outside both.

The demonstration is sitting in the repo: `ci.yml:4` points at `conformance/`
and `docs/spec-flow-as-a-plugin.md`, and neither exists here — the same class
of dangling cross-reference the check was written to catch, in the one file
type it cannot see.

Small, and it belongs in the same commit as whichever item lands first.

**Done looks like:** the dangling reference resolved or removed, and `.yml`
either scanned or excluded for a stated reason.

---

## B7 — the state that survives a crash can resume the checking, not the run

**Priority: second, behind B1.** This entry replaces an earlier and weaker
version of itself, which called the gap "context exhaustion mid-milestone" and
filed it as low priority on the grounds that no run had hit it. That framing
was wrong about which part is missing, and the correction is worth keeping
visible: the problem is not a rare failure mode, it is that resumption is
impossible by construction.

Most of what "robust recovery" usually means is genuinely here. `phase` and
`gate_attempts` are files on disk, so they outlive the session that wrote
them. A fifth failure writes `blocked` instead of looping. `preflight` refuses
to start a run the engine could not finish. `session-start` resets a phase
nobody has touched for six hours, so an abandoned run cannot arm the gate
forever. `gate-failure.log` is what a human reads.

What is **not** on disk is the pair of facts a resume would need:

- **which milestone is current.** Every gate block message routes work to "the
  implementer of the CURRENT milestone", and nothing anywhere records which
  one that is.
- **which session is `IMPL_SESSION`.** The command's own wording is "Remember
  the id/name it returns" — an instruction to hold it in context. The
  `agent-registry` file maps a session id to an agent type, but it exists for
  the Opus budget and marks no session as the current milestone's.

The whole state directory is `phase`, `gate_attempts`, `opus_calls`,
`agent-registry` and logs. Neither fact is among them.

**The run.** A repo with `phase=implement` and `gate_attempts=3`, the way an
orchestrating session that died mid-milestone leaves it:

```
back after 10 minutes   session-start: no output. phase=implement, attempts=3
                        gate still armed; on disk: phase, gate_attempts.
                        Which milestone? Which implementer? Nowhere.

back after 7 hours      "...treated as an abandoned run and reset to 'idle'.
                         If you meant to resume that run, re-run /spec-flow."
                        phase=idle, attempts=0
```

Those are the only two outcomes, and neither is a resume. The six-hour window
is the worse of the two: an armed gate, a live attempt count, and a session
with no idea what it is implementing. After it, the documented recovery is to
start the run again from the top.

Note what is *not* being proposed: keeping an implementer session alive across
a crash, which is not this engine's to do. Persisting the milestone id and the
implementer's session id costs two lines in a directory that already holds
five files, and turns "re-run from the top" into "pick up at Mk".

**Done looks like:** a fixture case that kills an orchestrator mid-milestone
and asserts a new session can name the milestone it is resuming — red against
`HEAD` today, because nothing writes it.

---

## B8 — the test-first metric is hardcoded to one extension, and fails by going quiet

**Priority: third.** Small, and it is the same class of defect as B1 with the
severity turned down — which is the reason it is worth naming rather than
folding into the cleanup of whatever lands first.

`specflow-stats.mjs` derives the test-first verdict from an observable
signature: the spec file appears, a scoped run goes red, then the source. Its
pairing of a source file to its spec is written as:

```js
if (file.endsWith('.spec.ts')) continue;
const specIdx = firstWrite.get(file.replace(/\.ts$/, '.spec.ts'));
```

Two hardcoded extensions, in the only part of the engine whose whole purpose is
to tell you whether the protocol in the implementer's prose is actually being
followed. On any repo that is not TypeScript, the pairing never matches and the
report says `no source file was written alongside its own spec in this trace` —
which reads as "nothing to report" and means "this metric cannot see your
repo".

That is milder than B1 only because `specflow-stats` gates nothing and always
exits 0, by an explicit decision its own header defends. It is *not* milder in
kind: a measurement that reports absence when it means blindness is the same
failure as a check that looks armed and is not.

The suffix is already in the contract as `trace.proof_suffix`, and the source
extension is derivable from `verify.scope_globs`. Nothing new needs declaring.

**Done looks like:** the pairing driven by the contract, and a stats case over
a non-TypeScript trace that distinguishes "no pairing found" from "this trace
has no pairs to find".

---

## B9 — the CLI half of the install has no path that is not npm

**Priority: fourth, and independent of B1 — it survives that fix untouched.**

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

No recommendation yet, and that is deliberate — publishing to a registry, a
standalone launcher, and documenting a minimal manifest are three different
trades and none has been investigated. Logged with the question stated rather
than a guess dressed as a plan.

**Done looks like:** the Python cold-start job in B2 reaching a green
`spec-flow check` without the repo having acquired a `package.json`.

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

---

## Reproducing B1

```bash
mkdir -p /tmp/b1/{specs,tests,.spec-flow} && cd /tmp/b1 && git init -q .
# .spec-flow/config.json with trace.proof_dir="tests", trace.proof_suffix="_test.py"
printf '<!-- spec-scope: modules/auth -->\n\n# Auth\n\n### REQ-AUTH-001 — a bad password is rejected\n' > specs/auth.md
printf 'def test_REQ_AUTH_001_a_bad_password_is_rejected():\n    assert True\n' > tests/auth_test.py
CLAUDE_PROJECT_DIR=/tmp/b1 node <plugin>/scripts/spec-trace.mjs   # exit 1: "has no test"
```

Swap the test for `it('REQ-AUTH-001 ...', ...)` in `tests/auth.test.ts`, set
`proof_suffix` to `.test.ts`, and the same repo exits 0.
