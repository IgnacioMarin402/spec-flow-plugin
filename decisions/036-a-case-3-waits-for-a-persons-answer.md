# ADR-036 — a case 3 waits for a person's answer

**Date:** 2026-10-11 · **Status:** accepted · **Governs:** `hooks/human-turn.mjs`, `hooks/lib/human-turn.mjs`, `hooks/phase-guard.mjs`, `hooks/arm-gate.mjs`, `hooks/orchestrator-scope.mjs`, `hooks/hooks.json`, `scripts/specflow-stats.mjs`, `commands/spec-fix.md`, `REFERENCE.md` · **Related:** ADR-009, ADR-033, ADR-034, ADR-035

**Question.** `/spec-fix` stops for a person before a case 3 corrects a
requirement to agree with the code: from the diff, that is indistinguishable
from rewriting the spec to agree with the bug (ADR-009). What holds the
orchestrator to that stop?

**Measured.** Nothing did. The `(correction)` marker is the triage's, written
before anyone is asked. No hook knew whether a person had spoken since. And a
re-triage inside `implement`, which the command names as where a case 3 usually
surfaces, writes no phase at all.

Claude Code fires `UserPromptSubmit` for a typed prompt and also for a
background agent reporting back, a scheduled task and a message from another
session, with no field naming the source (its hooks reference). The triage's
own report-back arrives after the brief, so "a prompt after the brief" would
have counted it as the answer.

**Decision.**

- `human-turn` records three events in `.claude/state/human-turn.log`, never
  their content:
  - each end of the session's turn (`Stop`);
  - each prompt, by source: one opening with a tag, such as
    `<task-notification>`, is recorded under the tag, and anything else as a
    person, pasted text included;
  - each answered `AskUserQuestion`.

  It records in any repository that adopted the engine, in or out of a run,
  because the prompt that starts a run comes before its phase.
- A fix brief with a `CHANGED … (correction)` delta counts as answered once,
  after its last write, the turn ended and then a person typed, or a question
  was answered. The turn end is what shuts out a report-back the source
  classification would miss: the session ended its turn when it spawned the
  triage, which is before the brief exists.
- `phase-guard` denies leaving `spec`, and `arm-gate` denies engaging the
  implementer in any run phase, while such a brief is unanswered. Only
  `arm-gate` may deny that engagement, because it moves the phase and hooks on
  one call run in parallel (ADR-035).
- The check stands down, and logs it, while the log holds no answer at all. A
  build that never fires the hook must not hold every case 3 forever.
- The session may not write the logs under `.claude/state/`
  (`orchestrator-scope`). They are what the hooks decide on, and a line the
  session wrote would be evidence nothing produced.

**Refused.**

- **Reading the transcript instead.** Its format is internal and changes
  between versions, and it is written asynchronously, so a hook may read it
  before the line lands (Claude Code's sessions and hooks docs).
- **Judging what the person said.** The record proves a person answered after
  the session stopped. It does not prove the answer was yes, or which question
  it answered. A "no" still goes back to triage by the command's own rule, and
  the denial says so.
- **A marker the orchestrator writes when told OK.** The session would be
  attesting its own stop.

**Cost.**

- A hook process on each prompt and each stop in an adopted repository, and a
  short line in a log that grows with them.
- A person who answered before the session stopped answers again.
- A scheduled prompt arriving after a stop reads as a person: nothing in the
  payload says otherwise.
