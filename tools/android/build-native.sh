#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HEADER="$ROOT/bindings/device-sdk-ffi/include/bota_device_sdk.h"
EVIDENCE="$ROOT/release/evidence/1.0.0-alpha.1-native-abi.md"
OUTPUT="$ROOT/platforms/android/sdk/build/generated/bota/jniLibs"
ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Library/Android/sdk}}"
NDK_VERSION="28.2.13676358"
NDK_ROOT="${ANDROID_NDK_HOME:-$ANDROID_SDK_ROOT/ndk/$NDK_VERSION}"

if [[ ! -d "$NDK_ROOT" ]]; then
  echo "Android NDK $NDK_VERSION was not found at $NDK_ROOT" >&2
  exit 1
fi

TOOLCHAIN="$(find "$NDK_ROOT/toolchains/llvm/prebuilt" -mindepth 1 -maxdepth 1 -type d -print -quit)"
if [[ -z "$TOOLCHAIN" ]]; then
  echo "Android NDK LLVM toolchain was not found" >&2
  exit 1
fi

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

expected_header_hash="$(awk -F'`' '/Header SHA-256/ { print $2; exit }' "$EVIDENCE")"
actual_header_hash="$(sha256 "$HEADER")"
if [[ -z "$expected_header_hash" || "$actual_header_hash" != "$expected_header_hash" ]]; then
  echo "Frozen ABI header digest mismatch" >&2
  echo "expected: $expected_header_hash" >&2
  echo "actual:   $actual_header_hash" >&2
  exit 1
fi

declare -a rows=(
  "arm64-v8a|aarch64-linux-android|aarch64-linux-android26-clang"
  "armeabi-v7a|armv7-linux-androideabi|armv7a-linux-androideabi26-clang"
  "x86_64|x86_64-linux-android|x86_64-linux-android26-clang"
  "x86|i686-linux-android|i686-linux-android26-clang"
)

rustup target add \
  aarch64-linux-android \
  armv7-linux-androideabi \
  x86_64-linux-android \
  i686-linux-android >/dev/null

rm -rf "$OUTPUT"
mkdir -p "$OUTPUT"

expected_symbols="$(mktemp)"
actual_symbols="$(mktemp)"
trap 'rm -f "$expected_symbols" "$actual_symbols"' EXIT
grep -Eo 'bota_device_sdk_v1_[a-z_]+' "$HEADER" | sort -u > "$expected_symbols"

for row in "${rows[@]}"; do
  IFS='|' read -r abi target linker <<< "$row"
  linker_path="$TOOLCHAIN/bin/$linker"
  if [[ ! -x "$linker_path" ]]; then
    echo "Pinned API-26 linker is missing: $linker_path" >&2
    exit 1
  fi

  target_env="$(printf '%s' "$target" | tr '[:lower:]-' '[:upper:]_')"
  env \
    "CARGO_TARGET_${target_env}_LINKER=$linker_path" \
    RUSTFLAGS="--remap-path-prefix=$ROOT=/usr/src/bota-app-sdk --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}/registry=/usr/src/cargo/registry" \
    cargo build \
      --manifest-path "$ROOT/Cargo.toml" \
      --locked \
      --release \
      --package bota-device-sdk-ffi \
      --target "$target"

  source_library="$ROOT/target/$target/release/libbota_device_sdk_ffi.so"
  destination="$OUTPUT/$abi/libbota_device_sdk_ffi.so"
  mkdir -p "$(dirname "$destination")"
  cp "$source_library" "$destination"

  library_strings="$(strings "$destination")"
  if grep -Fq "$ROOT" <<< "$library_strings"; then
    echo "$abi Rust library contains the checkout path" >&2
    exit 1
  fi
  if grep -Fq "${CARGO_HOME:-$HOME/.cargo}/registry" <<< "$library_strings"; then
    echo "$abi Rust library contains the Cargo registry path" >&2
    exit 1
  fi

  "$TOOLCHAIN/bin/llvm-nm" --dynamic --defined-only "$destination" \
    | awk '{print $NF}' \
    | grep '^bota_device_sdk_' \
    | sort -u > "$actual_symbols"
  if ! diff -u "$expected_symbols" "$actual_symbols"; then
    echo "$abi exports do not match the frozen ABI header" >&2
    exit 1
  fi
  undefined_symbols="$("$TOOLCHAIN/bin/llvm-nm" --dynamic --undefined-only "$destination")"
  if grep -q 'bota_device_sdk_' <<< "$undefined_symbols"; then
    echo "$abi Rust library has undefined Bota ABI symbols" >&2
    exit 1
  fi
done

echo "Built frozen Rust ABI for arm64-v8a, armeabi-v7a, x86_64, and x86"
