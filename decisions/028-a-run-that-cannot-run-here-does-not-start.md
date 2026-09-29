# ADR-028 — a run that cannot run here does not start

**Date:** 2026-09-29 · **Status:** accepted · **Governs:** `hooks/phase-guard.mjs`, `hooks/lib/can-run.mjs`, `hooks/preflight.mjs`, `commands/spec-flow.md`, `commands/spec-fix.md`, `commands/resume.md`, `REFERENCE.md` · **Related:** ADR-006, ADR-017, ADR-022, ADR-027

**Question.** `/spec-flow` in a repository with no contract wrote `spec` into
the phase, reset the counters, set the telemetry mark, and was refused at its
first spawn by `preflight`. What did that leave behind?

**Measured.** A phase of `spec` that nothing resets for six hours
(`session-start`), arming `preflight`, the Opus budget, `phase-guard` and
`arm-gate`: every subagent spawn in that repository — this plugin's or any
other's — is refused as `PREFLIGHT FAILED` until then, over a run the human
never got to start. At a workspace directory that is no repository, the same,
after `init` had written a contract there.

**Decision.** The write that starts a run is refused where the engine cannot
run, by `phase-guard`, before anything else is written: a run phase written
while no run is in progress is allowed only where the directory is a
repository root (ADR-027), the contract loads and the base resolves — the
checks `preflight` makes at the first spawn, made at the first write. Nothing
is armed, nothing is left for `session-start` to reset, and the message names
the fix. `preflight` stays: hooks fail open, a phase can be written in a form
`phase-guard` cannot read, and the Node floor is its alone.

**Refused.**

- A `SessionStart` notice that the repository has no contract: true in nearly
  every repository the user opens (ADR-006).
- The commands checking first: a step the model has to remember is not a
  check, which is why `preflight` is a hook.
- Retiring `preflight` in favour of this: a hook that fails open backstops
  another and never replaces it.
- Refusing the start when the base resolves to HEAD: a fresh branch sits at
  its base until its first commit, so that would refuse every properly set up
  run — the reason the gate, not `preflight`, judges it.

**Cost.** One `git` call, one contract read and one base resolution on the
first phase write of a run — what `preflight` performs on its first spawn.
