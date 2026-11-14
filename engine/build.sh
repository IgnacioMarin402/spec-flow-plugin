#!/bin/sh
# Builds the engine for every platform the launcher (bin/spec-flow) names,
# from the crate at the repository root, and writes each binary where the
# launcher picks it, under bin/ (ADR-054):
#
#   engine/build.sh                                      every platform
#   TARGETS=x86_64-unknown-linux-musl engine/build.sh    one
#   OUT=/tmp/x engine/build.sh                           into /tmp/x/bin/
#
# The binaries are committed: the plugin is installed as a copy of this
# repository and runs with no toolchain on the machine (ADR-051). A test
# rebuilds them and holds the committed files to these bytes.
#
# Needs rustup (rust-toolchain.toml pins the release and the targets), zig and
# cargo-zigbuild. Each setting below is here because a build without it gave
# other bytes from another path, or from the same path on another link.
set -e
cd "$(dirname "$0")/.."
out=${OUT:-.}
# The PE header records the link time; the linker writes this one instead.
export SOURCE_DATE_EPOCH=0
# Panic messages name the registry's path and the checkout's.
home=${CARGO_HOME:-$HOME/.cargo}
remap="--remap-path-prefix=$home=/cargo --remap-path-prefix=$PWD=/build"
for t in ${TARGETS:-x86_64-unknown-linux-musl aarch64-unknown-linux-musl x86_64-apple-darwin aarch64-apple-darwin x86_64-pc-windows-gnu}; do
  case $t in
    # rustc strips after the link, and the linker hashed the binary it wrote,
    # rustc's random temporary paths in it, into LC_UUID: strip at the link.
    *apple*) flags="$remap -C strip=none -C link-arg=-Wl,-S -C link-arg=-Wl,-x" ;;
    *) flags=$remap ;;
  esac
  RUSTFLAGS=$flags cargo zigbuild --release --locked --target "$t"
  case $t in
    x86_64-unknown-linux-musl) dest=linux-amd64/spec-flow ;;
    aarch64-unknown-linux-musl) dest=linux-arm64/spec-flow ;;
    x86_64-apple-darwin) dest=darwin-amd64/spec-flow ;;
    aarch64-apple-darwin) dest=darwin-arm64/spec-flow ;;
    x86_64-pc-windows-gnu) dest=windows-amd64/spec-flow.exe ;;
  esac
  mkdir -p "$out/bin/$(dirname "$dest")"
  cp "${CARGO_TARGET_DIR:-target}/$t/release/$(basename "$dest")" "$out/bin/$dest"
done
