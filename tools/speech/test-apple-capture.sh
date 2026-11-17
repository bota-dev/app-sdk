#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/bota-speech-capture.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT HUP INT TERM
cargo build --locked --manifest-path "$ROOT/Cargo.toml" -p bota-device-sdk-ffi
swiftc -swift-version 6 -warnings-as-errors -strict-concurrency=complete \
    -parse-as-library -I "$ROOT/bindings/device-sdk-ffi/include" \
    "$ROOT/platforms/apple/Sources/BotaAppSDK/Core/CoreError.swift" \
    "$ROOT/platforms/apple/Sources/BotaAppSDK/Core/NativeSpeechPolicy.swift" \
    "$ROOT"/platforms/apple/Sources/BotaAppSDK/Speech/*.swift \
    "$ROOT/tools/speech/apple-capture-checks.swift" "$ROOT/target/debug/libbota_device_sdk_ffi.a" \
    -o "$STAGE/capture-checks"
"$STAGE/capture-checks" "$STAGE" "$ROOT/protocol/speech-session/capture-v1.json"
