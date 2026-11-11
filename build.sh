#!/bin/sh
# Builds program.wasm: compiles program/ for wasm32v1-none, then packs it into
# a module Ting accepts, and prints its size and CodeHash.
#
# Source paths are written relative to this directory, so the module holds no
# path of your machine and anyone with the same toolchain rebuilds the same
# bytes: the same CodeHash. Build with this script, not with cargo alone.
set -e
cd "$(dirname "$0")"
root="$(pwd -P)"
(cd program && cargo build --release --quiet \
  --config "target.wasm32v1-none.rustflags=[\"--remap-path-prefix=$root=.\"]")
cargo run --quiet --release -p ting-kit-tools --bin pack -- \
  program/target/wasm32v1-none/release/program.wasm program.wasm
