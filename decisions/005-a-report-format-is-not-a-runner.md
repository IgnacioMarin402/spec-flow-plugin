# ADR-005 — a report format is not a runner, and traceability is opt-in

**Date:** 2026-08-16 · **Status:** accepted · **Supersedes:** ADR-002

## The question

ADR-002 concluded that because the engine may not know technologies, an
adopting repo must write `trace.executed_tests` — four lines translating its
runner's output into "which tests RAN". The cost was accepted as the price of
staying language-neutral.

Asked again from the adopter's side: why must anyone write code at all, when
the runner already printed what it ran?

## What was measured before deciding

Two claims were tested rather than argued, both against real runners.

**Reading a test command's raw output cannot work.** `go test ./...` prints
`ok example.com/auth 0.002s` — no test names at all, so every requirement would
read as unproven. `node --test` prints them but reports a skipped test as
`ok 2 - … # SKIP`, so a naive scan proves a requirement with a test that never
executed. The first failure blocks every milestone; the second is the exact
failure this engine exists to close.

**Narrowing to one ecosystem does not collapse the problem.** With default
reporters, vitest and jest print no test names, mocha marks skips with `-`, and
`node --test` marks them with a TAP directive. Four runners in one language,
four dialects. A Node-only engine would owe its adopters the same field, so the
adoption cost was never about the number of languages.

**What does collapse it is the report FORMAT.** `<skipped/>` is an element in
the JUnit XML schema and `# SKIP` is a directive in the TAP specification — in
both, "did this test run?" is answered by the format, not by whatever produced
it. vitest, mocha and `node --test` emit JUnit behind a built-in flag, as does
pytest; nothing about reading it requires knowing which of them wrote the file.

## The decision

The engine ships readers for **JUnit XML and TAP 13** (`scripts/test-report.mjs`)
and the contract gains `trace.report` — a format and a path, no code. `init`
writes it by default, so an adopter configures rather than programs.

**Traceability becomes opt-in.** A contract may declare neither source, and the
gate then runs lint and tests only. That is what makes a first install work in
one command: a repo with no requirements yet has nothing to prove, and paying
for the strong claim before making one is what pushed people away from making
it at all.

## What is still refused, and why ADR-002 was only half wrong

**A table of reporter flags per runner.** `init` never guesses which flag emits
a report; it infers the PATH from the repo's own test command when that command
names an `.xml` file, and otherwise proposes a conventional path as `REVIEW`.
ADR-002's reason holds exactly as written — a flag list is the artifact that
looks maintained and quietly is not — and it applies to flags, not to formats.
This is the line: **a format is a data shape (ADR-001 permits it); a flag is a
technology.**

**One runner's own format**, such as `go test -json`, for the same reason.
A repo whose runner has no standard report passes it through a converter or
uses `trace.executed_tests`, which stays as the escape hatch.

**Opting out silently.** `spec-trace` refuses the moment `specs_dir` declares a
requirement with no source configured. An opt-out that survived its own
precondition would be a disarmed gate, which is the shape everything here
exists to refuse.

## The cost

`init` cannot make the report APPEAR — someone still has to get the reporter
flag into `verify.test`. Adoption goes from "write four lines of JavaScript" to
"add one flag and confirm a path", and it is reported as `REVIEW` rather than
claimed as detected.
