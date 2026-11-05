#!/bin/sh
# Builds the Rust engine for every platform the launcher names, from the crate
# at the repository root, into target/<triple>/release (ADR-054):
#
#   engine/build.sh
#   TARGETS=x86_64-unknown-linux-musl engine/build.sh
#
# Needs rustup (rust-toolchain.toml pins the release and the targets), zig and
# cargo-zigbuild. Each setting below is here because a build without it gave
# other bytes from another path, or from the same path on another link.
set -e
cd "$(dirname "$0")/.."
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
done
