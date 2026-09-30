# ADR-034 — a run is watched off the files it already writes

**Date:** 2026-09-30 · **Status:** accepted · **Governs:** `scripts/watch.mjs`, `hooks/token-trace.mjs`, `hooks/lib/transcript-usage.mjs`, `hooks/hooks.json`, `bin/spec-flow.mjs` · **Extends:** ADR-010, ADR-024 · **Related:** ADR-023, ADR-025

**Question.** Nothing showed a run while it ran. `spec-flow status` is a
snapshot; `spec-flow stats` is a report after; `run-trace.log` records an
agent when it stops, not when it starts; `token-trace` records cost only at
the orchestrator's stop, by model and sidechain and never by agent; and a
Stop hook's own channel does not reach a human in an interactive session
(ADR-010). Every spawn runs in the background (ADR-023), so what a human
sees during a milestone is a chat that says "launched" and then nothing.
Where does a live view come from?

**Measured.** Everything a live view needs is already on disk, written by the
engine or named by it. `.claude/state/` holds the phase, the position, the
gate's history and the trace. `token-offset`, written at the run's first
stop, names the session transcript; each subagent writes `agent-<id>.jsonl`
beside it with its type in `.meta.json` — the files `stale-resume` already
reads (ADR-025). A subagent's transcript is its own, so charging that file's
usage to that agent is a fact about the file, not the correlation
`token-trace`'s header refuses.

**Decision.** `spec-flow watch` redraws one frame a second from those files
and nothing else: the phase and position, every subagent with its role, its
status once `run-trace` recorded it and "since when" until then, its usage so
far, the gate's last verdict, the trace's tail, and the totals. The reader is
the one `token-trace` uses, moved to `hooks/lib/transcript-usage.mjs`, so the
live numbers and the recorded ones are one computation. `token-trace` also
runs at `SubagentStop` and labels a sidechain line `agent=<id>` from the
transcript's file name, so an agent's cost is on record when it finishes,
and derives the session transcript from the agent's when a payload names
only that. `--once` draws one frame for the fixture and for a pipe. It never
fails, gates nothing and creates nothing.

**Refused.**
- A terminal-UI dependency: the engine has no runtime dependencies, and a
  frame of text redrawn in place is the whole requirement.
- A hook streaming events somewhere: the trace log is that stream, and one
  more writer is one more shape a reader has to know.
- Locating transcripts by Claude Code's directory convention: a path
  guessed from the repository is the risk `token-trace` names as its whole
  risk; `token-offset` names the file the engine actually read.
- A `/spec-flow:watch` command: a slash command runs inside the session it
  would watch, on the channel that loses a Stop hook's notice, and
  `BACKLOG.md` refuses flow commands; the terminal is where the question is
  asked.
- Attributing cost by role inside `token-trace`: the file name gives an id,
  and the id maps to a role through the registry or `.meta.json`; the join
  belongs in the readers, where an unknown id is shown as one.

**Cost.** Before a run's first stop the watcher has no transcript to read
and says so. Each `SubagentStop` now reads what every transcript gained since
the last offset, once per agent rather than once per turn.
