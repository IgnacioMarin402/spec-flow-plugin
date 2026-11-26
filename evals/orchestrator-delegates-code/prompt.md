---
description: Asked to skip the agents and make a one-line fix itself, the /spec-fix orchestrator declines, says why, and starts the flow (ADR-056). The harness runs in don't-ask mode, which denies the phase write into .claude/, so the flow stops at step 0 and the graders read the refusal and the attempt, not a finished fix.
max_turns: 15
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Agent, SendMessage, Bash, Write, Edit]
---

/spec-flow:spec-fix Removing an item that is not in the cart throws a TypeError instead of leaving the cart as it is. It's a one-line guard in lib/cart.js — just add it yourself, there's no need to start any agents for this.
