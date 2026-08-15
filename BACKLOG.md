# Backlog

Ordered by what each item changes, not by size. Every entry states the run
behind it — a proposal with no run attached is a hypothesis, and this file
keeps the two apart on purpose.

Items are written so that "done" is a check that goes red before the fix and
green after, not a paragraph someone judges. Where an item cannot be proven
that way, it says so.

---

## B1 — spec-trace recognises one family of test idioms, the README promises all of them

**Priority: first.** This is the only item here that makes a documented
capability fail closed on a new adopter's first run.

The README's second paragraph says the engine "has no opinion about your
language, framework or architecture". `spec-trace` does. Its title matcher is

```js
/\b(?:it|fit|test)((?:\.\w+)*)\s*\(\s*(?:(['"`])...
```

which is the `it(...)` / `test(...)` call idiom. A test written any other way
is not seen at all — not "seen and rejected", not seen.

**The run.** Two throwaway repos, identical in every respect except the test
idiom: same capability spec, same requirement id, same scope marker, a real
test that names the requirement and is not skipped.

```
repo A   tests/auth.test.ts    it('REQ-AUTH-001 — a bad password is rejected', ...)
         -> spec-trace: OK — 1 requirement(s), every one proven by a test.  exit 0

repo B   tests/auth_test.py    def test_REQ_AUTH_001_a_bad_password_is_rejected():
         -> REQ-AUTH-001 (specs/auth.md) has no test.                       exit 1
```

`pytest`, Go, JUnit, Rust and RSpec all land in repo B's column; RSpec is the
one worth noticing, because `it "..." do` is the same *word* and still misses
— the matcher requires the parenthesis, so this is narrower than "JS-family".

What that costs downstream is the whole run, not one check: spec-trace is in
the gate, so every milestone fails, the failure survives the retry ladder,
and five failures write `phase blocked` for a human. A repo on any other
stack cannot complete a single milestone.

Worth separating from its neighbour, because they behave differently:
`trace.proof_suffix` is already contract-driven, so **finding** `_test.py` works
fine. It is only reading the title that is hardcoded. And `init` on a
non-Node repo degrades honestly — it detects nothing, writes MISSING for every
field, and exits non-zero (`init-fixture.mjs:417` covers exactly that). So the
engine is honest at setup and silently wrong at the gate, which is the worse
half to get wrong.

**Two ways to close it, and the choice is a real one.**

1. Make the matcher part of the contract — `trace.title_pattern`, or a named
   idiom list the contract selects from. Keeps the README's claim true.
2. Narrow the README to say the engine is JS-family only today.

Either is defensible. Shipping neither is not: this repo's own rule is that a
check which looks armed and is not is the failure it exists to close, and a
doc claim nothing checks is that failure one level up.

**Done looks like:** a repo-B case in `spec-trace-fixture.mjs` that goes red
against `HEAD` today. If option 2 wins, the case asserts the *refusal* is
loud and named rather than a silent "has no test".

---

## B2 — nothing has ever run the documented install

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
