#!/bin/sh
set -eu

if [ "$(uname -s)" != "Darwin" ]; then
  echo "the UniFFI Swift smoke test requires macOS" >&2
  exit 1
fi

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
target_dir="$root/target/debug"
generated="$root/target/ffi-swift-smoke"
output="$target_dir/bota-device-sdk-uniffi-swift-smoke"

mkdir -p "$generated"
cargo build --manifest-path "$root/Cargo.toml" \
  -p bota-device-sdk-ffi-smoke --features uniffi-spike
cargo run --manifest-path "$root/Cargo.toml" \
  -p bota-device-sdk-uniffi-bindgen -- generate --no-format --library \
  --language swift --out-dir "$generated" \
  "$target_dir/libbota_device_sdk_ffi_smoke.dylib"

swiftc \
  -Xcc "-fmodule-map-file=$generated/bota_device_sdk_ffi_smokeFFI.modulemap" \
  -I "$generated" -L "$target_dir" -lbota_device_sdk_ffi_smoke \
  -Xlinker -rpath -Xlinker '@loader_path' \
  "$generated/bota_device_sdk_ffi_smoke.swift" \
  "$root/tools/ffi-smoke/tests/swift/main.swift" \
  -o "$output"

"$output"
