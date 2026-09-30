# ADR-029 — a prompt carries the rule, and its reasoning goes where the code's does

**Date:** 2026-09-30 · **Status:** accepted · **Governs:** `agents/`, `commands/`, `modes/orchestrator.md`, `CLAUDE.md`, `scripts/agent-contracts.mjs` · **Extends:** ADR-026 · **Related:** ADR-010, ADR-023, ADR-025

**Question.** The five agents and two commands had grown to 12,000 words,
loaded into a model on every run. Measured on `04f4851`: the two orchestrator
commands shared 407 eight-word phrases — step 0, the preflight paragraph, the
gate outcomes, the fold's `GAPS:` handling, the telemetry step and the rules
were each written twice. The gate loop existed in three prose copies beside
the one the gate itself prints, and the copies disagreed: the gate's re-plan
route writes `plan` first and re-invokes the implementer, `/spec-flow` step 4
said `SendMessage` and named no phase, and `/spec-fix` may not write `plan` at
all. The argument for routing skills at plan time appeared in the planner, the
implementer, the reviewer, `/spec-fix` and REFERENCE; ADR-009's reasoning in
four files beside the record. And a prompt told its model how a rule was found
— "measured on the change that prompted this split: of 240 lines, 143 were
Source, Context and Decision"; "this has cost a real run a full re-plan to
diagnose" — which is a commit message, read at every spawn. Where does a
prompt's reasoning go, and how many copies of a protocol may there be?

**Decision.** A prompt is held to the split `.claude/skills/engine-comments`
holds the code to. It carries the rule and the one line that keeps a competent
reader from undoing it; a decision is cited (`ADR-NNN`), never re-argued; how
the rule was found is the commit that added it. One copy of each protocol:
what both orchestrators do alike — phases, start, spawning, the gate loop, the
fold, done — is `modes/orchestrator.md`, read once at the start of a run the
way the spec-writer reads its mode file; each command keeps only its own
steps. The gate loop is not narrated: the gate's block message is the
instruction, and the commands add only what the gate cannot know — a stale
failure log, a warm session, which re-plan route this flow has and which phase
it runs under. `scripts/agent-contracts.mjs` reads the protocol file as part
of the commands, so a return field routed there still counts as routed.

**Refused.**
- A length budget on the prompts: `BACKLOG.md` refuses one on the README for
  the same reason — one more check on prose, and the goal is less prose. The
  measure was taken by hand and is in this record; the shape is reviewed by
  people.
- Extending `comment-transitions.mjs` to the prose: its patterns are tuned to
  comments, found 6 lines here where a reading found dozens, and would measure
  the wrong thing.
- One command with a mode flag: the two intakes differ, and a flag is a phase
  vocabulary nobody guards.
- Keeping the gate outcomes in the commands "so the orchestrator recognises
  them": three copies drifted within a month; the gate prints the copy that is
  always current.

**Cost.** One `Read` at the start of every run, of the tokens the duplicated
text cost as prompt. A rule cut to a line depends on the model doing what the
line says rather than what a paragraph persuaded it of; the checks that guard
prose coupling are unchanged, and a real run remains the only test of the
prompts themselves.
