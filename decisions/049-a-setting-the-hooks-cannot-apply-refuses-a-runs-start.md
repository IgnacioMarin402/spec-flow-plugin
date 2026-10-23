# ADR-049 — a setting the hooks cannot apply refuses a run's start, not its spawns

**Date:** 2026-10-19 · **Status:** accepted · **Governs:** `hooks/lib/can-run.mjs`, `hooks/phase-guard.mjs`, `hooks/preflight.mjs`, `hooks/live-view.tsx`, `hooks/lib/project-config.mjs`, `hooks/lib/budgets.mjs`, `hooks/lib/routing.mjs`, `scripts/model-routing.mjs`, `commands/spec-flow.md`, `commands/spec-fix.md`, `commands/resume.md`, `REFERENCE.md`, `README.md` · **Related:** ADR-014, ADR-028, ADR-038, ADR-047

**Question.** `.claude/spec-flow.config.json` holds the escalation caps and the
routing. When a setting in it cannot be applied, who refuses, and when?

**Measured.**

- A cap that is no whole number of calls was first denied at its role's first
  call: the architect's comes mid-implement. A wrong route was denied at the
  first spawn, after the phase write had armed the run.
- A file that does not parse was read as the defaults by every reader, with
  nothing said: a cap a person set was silently not the one applied.
- The readers disagreed: behind a byte-order mark the live view and
  `model-route` read no settings while `opus-budget` read the file's.
- Checked at every spawn by `preflight`, a file broken mid-run — a trailing
  comma after raising `max_opus_calls`, as `opus-budget`'s own message asks —
  refused every spawn in the repository, any agent, any session, saying
  nothing had run yet. ADR-028 measured that outcome as the cost of refusing at
  the first spawn.

**Decision.**

- One reading of the file (`hooks/lib/project-config.mjs`) for the caps, the
  routing, the run-start check, `spec-flow models` and the live view.
- `phase-guard` refuses the write that starts a run over a file that does not
  parse or is not an object, a cap that is not a whole number of calls (`null`
  included), or a route `model-route` would deny. `spec-flow models` reports
  the same problems and exits non-zero.
- Mid-run each hook applies what it can: a file that does not parse gives the
  defaults, which the live view says; a bad cap denies its role's calls; a
  wrong route denies this plugin's spawns.

**Refused.**

- **`preflight` refusing over the settings at every spawn.** It stops every
  agent in the repository over one file, and its message, written for a run
  that has not started, sends the human to start again.
- **Denying every spawn mid-run over a file that does not parse.** One hook
  would deny over a file the others tolerate; the defaults hold until the next
  start refuses it.
- **Reading `null` as the default.** A person writing it means no cap, and
  would get one without a word.

**Cost.** A file broken mid-run is not refused until the next run starts: until
then the defaults apply, and only the live view says so. The refusal is
phase-guard's, so a run started by a write it cannot read — `node -e`, a `cp`
— meets each setting only where a hook applies it, as a file broken mid-run
does; the orchestrator writes the phase with `Write` or `printf`, which it
reads. An update reaches a run in flight: a cap main read as the default, as
a number of calls or as no limit at all — `null`, `"0x10"`, `"six"` — denies
that role's calls from then on, and a file main never read for its byte-order
mark is read: a route in it naming no agent denies every plugin spawn.
