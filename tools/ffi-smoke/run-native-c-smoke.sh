#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
TMPDIR_PATH=$(mktemp -d "${TMPDIR:-/tmp}/bota-device-sdk-c.XXXXXX")
trap 'rm -rf "$TMPDIR_PATH"' EXIT HUP INT TERM

cargo build --manifest-path "$ROOT/Cargo.toml" -p bota-device-sdk-ffi

cc -std=c17 -Wall -Wextra -Werror \
  -I "$ROOT/bindings/device-sdk-ffi/include" \
  "$ROOT/tests/conformance/native/c/main.c" \
  "$ROOT/target/debug/libbota_device_sdk_ffi.a" \
  -o "$TMPDIR_PATH/native-c-smoke"

"$TMPDIR_PATH/native-c-smoke"
