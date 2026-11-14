# ADR-054 — the engine is ported to Rust, one hook at a time, held to the Go engine's cases

**Date:** 2026-11-05 · **Status:** accepted; complete — every hook is the Rust engine's, `bin/` is built from it, and the Go engine is gone (ADR-055) · **Governs:** `engine/`, `Cargo.toml`, `rust-toolchain.toml`, `engine/build.sh`, `.github/workflows/ci.yml` · **Amends:** [ADR-051](051-the-engine-is-one-binary-per-platform-committed-with-its-source.md) (the language, once the port completes) · **Keeps:** [ADR-052](052-every-hook-runs-the-launcher-in-a-shell.md)

**Question.** The Go engine is a file-for-file port of the Node scripts
(ADR-051's table): twenty packages, shaped by the `.mjs` files they came
from. Every hook reads its payload as a map, where a missing or misnamed
field reads as `""` and the check stands down without a word, which is the
failure this engine exists to close. Should the engine move to Rust, and on
what terms?

**Measured.** A spike: `no-gate-cmds` and everything it reads (the shell
scanner's word reader, the contract, the phase, the engine root), about 1500
lines of Rust in `engine/`.

- Behaviour: the Go suite's 49 `no-gate-cmds` cases pass against the Rust
  binary, through `SPEC_FLOW_BINARY` (`TestNoGateCmds*`,
  `TestWholeRepoDenialHandsNoDisarm`, the committed-phase case). The suite is
  armed: dropping what `cat <<EOF | sh` feeds a shell fails
  `TestNoGateCmdsReadsQuotingAsTheShellDoes`, and a hook not yet ported fails
  with `no hook named`.
- One difference, deliberate: a `command` that is not a JSON string. Go read
  `["npm run test"]` as JavaScript's `String()` would and denied it; Rust reads
  no Bash command there and lets it through. A number, an empty input and text
  that is not JSON pass on both.
- Builds: all five targets from one Linux host, Rust 1.97.0, zig 0.14.1 through
  cargo-zigbuild 0.24.1. Byte-identical from two source paths, two
  `CARGO_HOME`s and empty target directories, after three fixes:
  - registry paths inside panic locations: `--remap-path-prefix` on the
    cargo home and the source root (Cargo's `trim-paths` is unstable on 1.97);
  - the Mach-O `LC_UUID` changed on every link, with zig 0.13 and 0.14 alike:
    rustc strips after the link, so the linker hashed a binary holding
    rustc's random temporary paths. Stripping at the link (`-C strip=none -C
    link-arg=-Wl,-S -C link-arg=-Wl,-x`) gives one UUID; the arm64 binary
    keeps its ad-hoc signature;
  - the PE header's link time: `SOURCE_DATE_EPOCH=0`. zig's `cc` refuses
    `--no-insert-timestamp`.
- Linux binaries are static (`*-linux-musl`), as Go's `CGO_ENABLED=0` ones are.
- A `no-gate-cmds` call, 200 each, the binary run directly on Linux x86-64,
  `git ls-files` included: Go median 6.5–6.9 ms, Rust 3.5–3.7 ms.
- Size: 1.6–1.9 MB a target for one hook, against Go's 3.8 MB for the whole
  engine. Not comparable until the port completes.
- Not run: the macOS, Windows and Linux arm64 binaries (no such host here), and
  a build on a Windows or macOS host.

**Decision.**

- The engine is ported to Rust. The crate is at the repository root, its
  source in `engine/`, since the usual source directory's name is adopter
  vocabulary `NoRepoRefs` bans from this engine's text.
- Not file for file: modules by job — `payload`, `state`, `repo`, `shell`,
  `spec`, `agents`, `hooks/guards` (those that deny or block), `hooks/record`
  (those that only record), `cli`.
- A hook names the payload shape it reads and gets it or an `Unreadable`. What
  it does with one it cannot read is written in the hook.
- One hook or command at a time, each held to the Go e2e cases through
  `SPEC_FLOW_BINARY`. The Go engine keeps shipping until every case passes on
  the Rust binary; then `bin/` switches and the Go source goes, in one change.
- The same five targets, Windows included: ADR-052 stands, and a Claude Code
  Desktop session inside WSL loads no plugins, so WSL cannot replace the
  `.exe`.
- The build is `engine/build.sh`: `cargo zigbuild --release --locked` per
  target, the toolchain pinned by `rust-toolchain.toml`, the settings above.
  CI's `rust` job builds the Linux binary and runs the ported hooks' cases
  against it. The freshness test that replaces `TestBinariesAreThisSource`
  runs on Linux.
- This repository's checks read `engine/*.rs` as they read the Go source:
  `Decisions`, `NoRepoRefs`, `ModelPins`, `Transitions`. `LineEnds` and the
  state names `PluginPaths` collects read Go source alone, and need a Rust
  reading before the Go source goes.

**Refused.**

- **A file-for-file port.** It would carry the Node scripts' shape into a third
  language.
- **WSL instead of a Windows binary.** Desktop WSL sessions load no plugins.
- **Installing the binary apart** (`cargo install`): a toolchain on every
  machine, and a reinstall on every update of a plugin that updates itself.
- **The `*-linux-gnu` targets.** A binary tied to the builder's glibc does not
  start on an older one, or on Alpine.
- **Patching the UUID and the timestamp after the link.** Both are fixed where
  the linker writes them.

**Cost.** Building the binaries needs rustup, zig and cargo-zigbuild, where Go
needed Go alone. Byte-identical builds are measured from Linux only; a Windows
host is expected to build other bytes, since a path inside a panic message
keeps its `\`, so the Windows CI leg cannot run the freshness test Go's could.
Until the port completes, the tree holds two engines, and the behaviour suite
stays in Go.
