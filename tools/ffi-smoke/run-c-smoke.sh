#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
target_dir="$root/target/debug"
output="$target_dir/bota-device-sdk-c-smoke"
cc=${CC:-cc}

cargo build --manifest-path "$root/Cargo.toml" \
  -p bota-device-sdk-ffi-smoke --no-default-features

case "$(uname -s)" in
  Darwin)
    rpath='@loader_path'
    ;;
  Linux)
    rpath='$ORIGIN'
    ;;
  *)
    echo "unsupported C smoke host: $(uname -s)" >&2
    exit 1
    ;;
esac

"$cc" -std=c11 -Wall -Wextra -Werror \
  -I "$root/core/device-sdk-core/include" \
  "$root/tools/ffi-smoke/tests/c_abi_smoke.c" \
  -L "$target_dir" -lbota_device_sdk_ffi_smoke \
  "-Wl,-rpath,$rpath" -o "$output"

"$output"
