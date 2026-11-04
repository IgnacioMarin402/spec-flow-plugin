# ADR-053 — a red run is a test the runner reports failed

**Date:** 2026-11-04 · **Status:** accepted · **Governs:** `internal/hooks/trace.go`, `internal/cli/stats.go`, `internal/testreport`, `agents/implementer.md` · **Related:** ADR-005, ADR-020

**Question.** run-trace called a scoped test run red when the runner, run on a
path, exited non-zero, and stats credits a red run before the code as
red-first. A test file whose import does not resolve yet exits non-zero having
run none of its tests. Is that a red run?

**Measured.**
- On 95e4222, a test with an empty body whose import did not resolve, run with
  `node --test` 24.22.2 and then given its module, was traced `red` and
  reported `OK … (red-first)`.
- The four runners `init` knows each print such a file without a test of its
  own: jest 30.5.2 counts `Tests: 0 total` under a failed suite, vitest 5.1.0
  `Tests  no tests` under a failed file, mocha 12.0.3 abandons the run before
  counting, node 24.22.2 and 22.23.4 fail one case named by the file's path.
  Their reports agree: no case carries the test's id. node and vitest name one
  failed case after the file, jest-junit lists nothing, mocha writes no report.
- A test that loads and fails is counted by each: `Tests: … failed` in jest and
  vitest, `N failing` in mocha, a failed case under the test's own name in node.

**Decision.**
- A run is red only when the runner reports a test that failed. A file that did
  not load is `absent`: none of its tests ran. A failure that shows neither is
  `?` with `why=no-summary`; its exit status alone makes it nothing.
- stats credits red-first to a red run only. A test whose one run before its
  code did not load is `did-not-load`, a miss of its own.
- A report gives each test a verdict — pass, fail, absent, unknown — and a test
  in a file that did not load is absent.

**Refused.**
- **A load failure as red**, a test that does not compile being red in TDD: it
  shows the file needs the code, not that any test in it can fail, and a test
  that asserts nothing passes it.
- **The exit status as red, less the load failures recognised:** one printed in
  a shape not recognised would stay red.
- **Reading `trace.report` after a scoped run:** the implementer runs the test
  without the reporter flag, so the file there is the gate's last one.

**Cost.** A runner outside the four `init` knows has no red run at all: its
failures are `?`, unmeasured. A test whose file imports a new module cannot run
red before that module is first written (BACKLOG B36).
