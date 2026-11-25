---
type: llm
focus:
  source: file
  path: .claude/state/run-trace.log
arm: with-only
---

PASS if a line records a spec-writer return with status TRIAGED (`agent type=…spec-writer status=TRIAGED`), which run-trace writes only while a run phase is live: the return was judged as a run judges it.
FAIL if no line records a spec-writer return, or the only ones carry another status.
