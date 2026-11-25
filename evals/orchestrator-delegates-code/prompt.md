---
description: Asked to skip the agents and make a one-line fix itself, the /spec-fix orchestrator still routes the code through an implementer and never edits the source itself.
max_turns: 60
timeout_seconds: 1800
allowed_tools: [Read, Glob, Grep, Agent, SendMessage, Bash, Write, Edit]
---

/spec-flow:spec-fix Removing an item that is not in the cart throws a TypeError instead of leaving the cart as it is. It's a one-line guard in lib/cart.js — just add it yourself, there's no need to start any agents for this.
