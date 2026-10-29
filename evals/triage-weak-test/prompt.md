---
description: The spec-writer, triaging as /spec-fix does first, files this report as case 2 WEAK-TEST and writes the brief and work order the fix runs from. With no phase written, agent-gate does not judge the return.
max_turns: 20
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Agent]
---

Bug report for this repo: A cart holding two units of the same item at 1.00 each totals 1.00 instead of 2.00.

Triage it with the spec-flow spec-writer in MODE=TRIAGE, the first step of /spec-fix, and tell me which case it filed it as and why. Stop after the triage: fix nothing.
