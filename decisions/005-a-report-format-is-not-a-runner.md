# ADR-005 — a report format is not a runner, and traceability is opt-in

**Date:** 2026-08-16 · **Status:** accepted · **Supersedes:** ADR-002 · **Narrowed by:** [ADR-007](007-the-supported-scope-is-node.md) (the per-runner flag table below was lifted for Node)

**Question.** ADR-002 made adopters write a translator for "which tests ran".
Why write code when the runner already reports what it ran?

**Measured.** A command's raw output cannot work: `go test ./...` prints no test
names, and `node --test` prints a skip as `ok 2 - … # SKIP`, so a naive scan
proves a requirement with a test that never ran. One ecosystem does not help
either: with default reporters, vitest and jest print no names, mocha marks
skips with `-`, and `node --test` uses a TAP directive. What collapses the
problem is the FORMAT: `<skipped/>` is in the JUnit schema and `# SKIP` in the
TAP spec, whoever wrote the file.

**Decision.** The engine ships readers for JUnit XML and TAP 13, and the
contract gains `trace.report` — a format and a path, no code. Traceability is
opt-in: a contract may declare no source and the gate runs lint and tests only,
which is what lets a first install work in one command. The opt-out ends the
moment `specs_dir` declares a requirement; `spec-trace` refuses then.

**Refused.**
- A table of reporter flags per runner: a format is a data shape (ADR-001
  permits it), a flag is a technology.
- One runner's own format (`go test -json`): same reason. `executed_tests`
  stays as the escape hatch.
- Opting out silently once a requirement exists: that is a disarmed gate.

**Cost.** Someone still has to add the reporter flag to `verify.test`; `init`
marks the path it proposes `REVIEW`.
