#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/bota-speech-host.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT HUP INT TERM
cargo build --locked --manifest-path "$ROOT/Cargo.toml" -p bota-device-sdk-ffi
swiftc -swift-version 6 -warnings-as-errors -strict-concurrency=complete \
    -parse-as-library -D BOTA_SPEECH_HOST_CHECKS -I "$ROOT/bindings/device-sdk-ffi/include" \
    "$ROOT/platforms/apple/Sources/BotaAppSDK/Core/CoreError.swift" \
    "$ROOT/platforms/apple/Sources/BotaAppSDK/Core/NativeSpeechPolicy.swift" \
    "$ROOT"/platforms/apple/Sources/BotaAppSDK/Speech/*.swift \
    "$ROOT/platforms/apple/Tests/BotaAppSDKTests/SpeechSessionChecks.swift" \
    "$ROOT/tools/speech/apple-host-checks.swift" "$ROOT/target/debug/libbota_device_sdk_ffi.a" \
    -o "$STAGE/speech-host-checks"
"$STAGE/speech-host-checks" "$ROOT/protocol/speech-session/client-v1.json"
