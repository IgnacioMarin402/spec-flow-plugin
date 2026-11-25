---
description: The unspecified report triaged with the run at `spec`, as /spec-fix runs it, so agent-gate judges the return and sends back one that breaks its contract. The spec-writer files case 1 UNSPECIFIED and writes the brief and work order under that judgement.
max_turns: 20
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Agent]
---

Bug report for this repo: Removing an item that is not in the cart throws a TypeError instead of leaving the cart as it is.

The /spec-fix run for it is already at `spec`. Triage it with the spec-flow spec-writer in MODE=TRIAGE, the first step of /spec-fix, and tell me which case it filed it as and why. Stop after the triage: fix nothing.
