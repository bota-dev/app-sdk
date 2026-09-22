#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
OUTPUT_DIR="$ROOT_DIR/frameworks/web/src/generated"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

EXPECTED_WASM_BINDGEN_VERSION="wasm-bindgen 0.2.128"
ACTUAL_WASM_BINDGEN_VERSION="$(wasm-bindgen --version)"
if [[ "$ACTUAL_WASM_BINDGEN_VERSION" != "$EXPECTED_WASM_BINDGEN_VERSION" ]]; then
  echo "expected $EXPECTED_WASM_BINDGEN_VERSION, found $ACTUAL_WASM_BINDGEN_VERSION" >&2
  exit 1
fi

cd "$ROOT_DIR"
RUSTFLAGS="${RUSTFLAGS:+$RUSTFLAGS }--remap-path-prefix=$ROOT_DIR=bota-app-sdk --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=cargo-home --remap-path-prefix=${RUSTUP_HOME:-$HOME/.rustup}=rustup-home" \
  cargo build \
  --locked \
  --package bota-device-sdk-wasm \
  --release \
  --target wasm32-unknown-unknown

wasm-bindgen \
  --target web \
  --typescript \
  --out-dir "$TEMP_DIR" \
  --out-name bota_device_sdk_core \
  "$ROOT_DIR/target/wasm32-unknown-unknown/release/bota_device_sdk_wasm.wasm"

WASM_COUNT="$(find "$TEMP_DIR" -maxdepth 1 -type f -name '*.wasm' | wc -l | tr -d ' ')"
if [[ "$WASM_COUNT" != "1" ]]; then
  echo "expected exactly one generated WebAssembly file, found $WASM_COUNT" >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"
find "$OUTPUT_DIR" -mindepth 1 -maxdepth 1 -type f -delete
cp "$TEMP_DIR"/* "$OUTPUT_DIR"/
