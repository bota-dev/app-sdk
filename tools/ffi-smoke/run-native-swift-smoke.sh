#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
TMPDIR_PATH=$(mktemp -d "${TMPDIR:-/tmp}/bota-device-sdk-swift.XXXXXX")
trap 'rm -rf "$TMPDIR_PATH"' EXIT HUP INT TERM

cargo build --manifest-path "$ROOT/Cargo.toml" -p bota-device-sdk-ffi

swiftc \
  -warnings-as-errors \
  -I "$ROOT/bindings/device-sdk-ffi/include" \
  "$ROOT/platforms/apple/Sources/BotaAppSDK/Core/CoreError.swift" \
  "$ROOT/platforms/apple/Sources/BotaAppSDK/Core/NativeSpeechPolicy.swift" \
  "$ROOT/tests/conformance/native/swift/main.swift" \
  "$ROOT/target/debug/libbota_device_sdk_ffi.a" \
  -o "$TMPDIR_PATH/native-swift-smoke"

"$TMPDIR_PATH/native-swift-smoke" "$ROOT/protocol/speech-session/client-v1.json"
