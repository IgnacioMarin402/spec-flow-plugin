---
description: Resume a /spec-flow or /spec-fix run that a previous session left unfinished, at the step the disk says it reached — without starting over.
argument-hint: "[<SLUG>]"
---

You are resuming a spec-flow run that another session left unfinished. You do not restart it and you do not re-derive where it was: a script reads that off disk (ADR-024).

## 1. Where the run stands
Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/resume.mjs $ARGUMENTS` and show the human its output as it came out. Its last two lines, `NEXT:` and `WHY:`, are the step you resume at. Do not second-guess it from memory or from the chat: if the human says the run is somewhere else, the disk is what the gate and every hook will read, so fix the disk or ask — do not act on a position the files contradict.

## 2. The state machine you re-enter
Read `${CLAUDE_PLUGIN_ROOT}/commands/spec-flow.md` for a `/spec-flow` change, or `${CLAUDE_PLUGIN_ROOT}/commands/spec-fix.md` for a `/spec-fix` brief — the script says which. From here on you are that command's Orchestrator, bound by every rule it states, with two differences:

- **Skip its step 0.** Do not reset `gate_attempts` or `opus_calls` and do not set a telemetry mark: they belong to the run, not to this session, and the budget already spent was spent. If `.claude/state/run-offset` does not exist, set the mark now, so the archived telemetry at least covers what happens from here.
- **Write the phase for the step you enter before anything else.** That write is what moves the run to this session (ADR-017): the gate and the Opus budget answer only to the session that last wrote the phase, and the previous one is gone. After a stale reset the phase is `idle`, so that write starts a run, and `phase-guard` **denies it** when this engine cannot run here — the directory is not a repository root, the contract does not load, the base does not resolve (ADR-028). Then nothing has resumed: show its message to the human and stop.

## 3. Enter at NEXT

- `SIGN-OFF` — write `spec`. Show the Requirement deltas from `spec.md` and the Decision from `proposal.md`, and wait for an explicit OK, exactly as step 1 of `/spec-flow` says, rejection path included. The human may have approved it before the session died; nothing on disk says so, so ask.
- `SPEC` — the spec step never finished and the requirement was only in the lost chat. Ask the human for it, then run `/spec-flow`'s step 1 with it, into the same `<SLUG>`.
- `WORK-ORDER` — write `spec`, then `/spec-fix` steps 2 and 3.
- `REVIEW` — `/spec-flow` step 3.
- `IMPLEMENT Mk` — write `implement`, then `/spec-flow` step 4 (or `/spec-fix` step 4) for `Mk`, with a **new** implementer: the previous one's session died with its orchestrator. Before spawning it:
  - a dirty tree is the dead session's half-written work. Show `git status` to the human and ask whether the new implementer continues from it or it is discarded; do not decide that yourself.
  - if `WHY` says the gate failed on HEAD, read `.claude/state/gate-failure.log` and route it by class, as step 4 says.
- `FOLD` — write `implement` (the fold runs armed), then step 5 of the command you re-entered.
- `DONE` — step 6: the change is archived and only `done`, the telemetry snapshot and the summary are left.
- `ARCHIVE-REJECTED` — finish the rejection as step 1 of `/spec-flow` describes: move the folder to `specflow/archive/`, then write `idle`.
- `BLOCKED` — the gate's attempt cap. Summarize `.claude/state/gate-failure.log` for the human and wait; on their answer, write `implement` and continue step 4.
- `CHOOSE` — more than one change is live. Ask the human which, then run this command again with that `<SLUG>`.
- `NONE` or `UNKNOWN` — tell the human there is nothing this can resume, and why. Do not start a new run on your own.
