---
description: The spec-writer, triaging as /spec-fix does first, files this report as case 3 WRONG-SPEC and writes the brief and work order the fix runs from. With no phase written, agent-gate does not judge the return.
max_turns: 20
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Agent]
---

Bug report for this repo: Three different items at 3.33 each with the code SAVE10 total 8.97. Finance says it must be 8.99.

Triage it with the spec-flow spec-writer in MODE=TRIAGE, the first step of /spec-fix, and tell me which case it filed it as and why. Stop after the triage: fix nothing.
