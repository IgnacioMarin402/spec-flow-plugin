# ADR-017 — a repository does not get to arm this engine

**Date:** 2026-08-23 · **Status:** accepted · **Governs:** `hooks/lib/io.mjs`, `hooks/gate.mjs`, `hooks/phase-guard.mjs`, `hooks/session-start.mjs`, and every other hook that reads the phase · **Related:** ADR-010

## The question

Every enforcement hook here decides whether it is armed by reading one file,
`.claude/state/phase`. Until now the file answered a single question — *what
is this run doing?* — and two others were never asked: **who wrote it**, and
**did a run write it at all**.

The plugin installs globally and arms in whatever repository the user opens.
So the file that decides whether the gate spawns `verify.lint` and
`verify.test` is a file the repository can contain.

## What was measured

**A committed phase arms the gate on arrival.** A throwaway repo with
`.claude/state/phase` committed as `implement`, and a `.spec-flow/config.json`
whose two argv wrote marker files outside the repo:

```
$ node hooks/session-start.mjs      # silence — see below
$ cat .claude/state/phase
implement
$ node hooks/gate.mjs
"spec-flow: gate PASSED — 07ad6cc (l 0, t 0, spec=0)"
$ ls <outside the repo>
LINT-RAN.txt   TEST-RAN.txt
```

Both commands ran. Nothing was typed; the trigger was **ending a turn**.

**`session-start` does not rescue it.** It resets a phase older than six
hours, and a fresh checkout's `mtime` is seconds old, so the staleness reset
never fires on the case that needs it.

**And the state has no owner.** `phase`, `gate_attempts` and `opus_calls`
resolve from `CLAUDE_PROJECT_DIR` and nothing else — no lock, no session id.
Two Claude Code sessions in one repo, which is an ordinary way to work, share
all three: the second arms the first's gate, spends its Opus budget, and moves
the attempt counter that decides when a human is called.

## The decision

**Two questions are now asked of the phase, and they are asked by different
sets of hooks.** Both live in `hooks/lib/io.mjs`:

`readPhase(root)` — **is it tracked by git?** Nothing in this engine ever
commits that file, so one under version control did not come from a run. A
tracked phase reads as no phase at all, in **every** hook.

`readOwnedPhase(root, sessionId)` — **and did this session seal it?**
`phase-guard` already sees every readable phase write, and the hook payload
carries `session_id`; the pair goes to `.claude/state/phase.session`.

**Both comparisons fail CLOSED, and that is the property to preserve in any
edit.** No seal, no `session_id` in the payload, or a `git` that could not be
asked all leave the phase honoured. The only case that stands a hook down is a
seal naming a different, known session — because a disarm reached by
*uncertainty* is exactly the failure this engine exists to close, and it would
now have three new ways to happen.

**Only two hooks ask the second question**, and the restriction is the
load-bearing part of this record rather than caution about it. `gate.mjs` fires
on `Stop`, which is the orchestrating turn ending; `opus-budget.mjs` fires on a
subagent spawn, which only an orchestrator performs. Both are therefore certain
to run in the session that sealed the phase.

The rest fire inside subagents too — `lint-on-write` runs on the implementer's
every write — and whether a subagent's payload carries its parent's
`session_id` is the harness's business: undocumented, and free to change. If it
ever does not, an owner check there stands the write-time linter down on every
write of every milestone, silently. That is a worse failure than the one being
fixed and it would arrive through an assumption rather than a decision.

`phase-guard` is excluded for a second reason on top of that one: it is the
hook that *assigns* ownership, so reading a foreign phase as absent would stand
it down on precisely the write that transfers the phase to this session. The
tracked half still applies to it, because deciding whether `done` is earned
runs the repo's own unscoped checks.

## What was refused

**Treating this as a general security boundary.** It is not one, and saying so
matters more than the fix. Running the `test` command of a repository you just
cloned is a risk of category, shared with `npm test`, with CI, and with hooks
in general; nothing here makes an untrusted repo safe. What is specific — and
what this closes — is that spec-flow armed *by itself*, on a file the repo
supplied, with no run in progress and no command typed.

**Refusing to run in a repo whose phase is tracked.** Considered and rejected:
a denial is a decision about the repo, and the honest answer is that this
engine has nothing to do there. Transparency is what "not armed" already means
everywhere else in this file set.

**Sealing the owner check into every hook.** The obvious shape, and the one
this was written as first. It buys tidiness and costs a dependency on
undocumented harness behaviour, in the direction that disarms — see above.

**Sealing `gate_attempts` and `opus_calls` separately.** `gate_attempts` is
written only by the gate, and `opus_calls` only by the budget; both of those
already ask. A third file to keep in step would be state about state.

**A lock file.** It answers a different question — *may two sessions run at
once* — and answers it by refusing one of them. Ownership lets the second
session work normally, which is what it was doing.

## Consequences

`.claude/state/phase.session` joins the state directory a consuming repo is
asked to gitignore. Deleting it is safe: an unsealed phase is honoured by
whoever reads it, which is the behaviour that existed before this record.

`readPhase` spawns `git ls-files` — once per hook invocation, and only while
the phase is one of the five values that arm anything. `idle`, `done`, an empty
file and an unrecognised value are answered without it.

A second session in the same repo is still linted on write, still denied a
whole-repo `npm test`, and still traced into the first run's log. That is the
accepted residue of the restriction above: those hooks cost context and noise,
never a verdict, and the two that decide something — the gate and the budget —
are sealed.

`session-start` leaves a tracked phase alone rather than resetting it. There is
nothing to disarm, and writing `idle` over it would dirty a tracked file in
every repository the user opens.
