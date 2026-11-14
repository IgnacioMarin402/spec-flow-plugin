# ADR-055 — the behaviour suite and the repository checks are cargo tests

**Date:** 2026-11-14 · **Status:** accepted · **Governs:** `engine/tests/`, `Cargo.toml`, `.github/workflows/ci.yml`, `CLAUDE.md` · **Completes:** [ADR-054](054-the-engine-is-ported-to-rust-one-hook-at-a-time.md) · **Related:** ADR-051, ADR-052

**Question.** With the engine in Rust and `bin/` built from it, the only Go
left was the behaviour suite (`internal/e2e`, about 11,000 lines driving the
built binary) and `internal/repocheck` (this repository's checks on itself).
Keep Go as a black-box harness beside a Rust engine, or move both to `cargo
test`?

**Measured.** Every Go e2e case passed on the Rust binary before the switch
(B70–B75), and none needed the engine's code in-process once the four that
read it were rewritten to go through the binary or the plugin's files. The Go
suite was already a black box: a payload on stdin, a throwaway repository, the
binary's exit, streams and files.

**Decision.**

- Both move to `cargo test`, and Go leaves the repository: no `go.mod`, no Go
  job in CI. A contributor needs one toolchain, the one `rust-toolchain.toml`
  pins.
- The behaviour suite stays a black box. Its cases are integration tests under
  `engine/tests/` that run a built binary — by default the one `bin/` commits
  for the platform, so what a session runs is what is tested; with
  `SPEC_FLOW_BINARY`, another — and never call the engine's functions. A case
  that calls one tests a function, not the hook a session runs.
- The repository checks are a cargo test too, reading the Rust source where
  they read the Go source before.
- Each case keeps its assertion: a port of a test that changes what it
  asserts is a new test with an old name. A Go table of cases becomes one
  test, or one test per case, and a failure names the case.

**Refused.**

- **Go as the harness.** Two toolchains for one engine, and a second language
  in which every reader of the contract (hook names, the payload shapes, the
  golden table) is restated.
- **Unit tests in place of the e2e cases.** The engine's own `#[cfg(test)]`
  modules test its readers; the cases test what a session sees, and only a
  built binary shows that.

**Cost.** The suite is rewritten once, and a case's history before the
rewrite is in the Go file's `git log`, not the Rust one's. `SPEC_FLOW_ORACLE`,
which ran the cases against the JavaScript engine, does not survive: that
engine was retired by ADR-051.
