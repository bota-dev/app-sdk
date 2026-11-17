#!/bin/bash
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "$0")/../.." && pwd)
if ! command -v cargo >/dev/null 2>&1 && [[ -d /opt/homebrew/opt/rustup/bin ]]; then
  export PATH="/opt/homebrew/opt/rustup/bin:$PATH"
fi
if [[ "${1:-}" != "--host" ]]; then
  exec swift test --package-path "$ROOT/platforms/apple-speech-livekit" \
    --scratch-path "$ROOT/target/apple-speech-livekit" "$@"
fi
shift
# Compile the shipping speech facade and actual Rust ABI on a macOS host without Xcode.
# This host package is not a replacement for the complete XCFramework/package checks.
cargo build --locked --manifest-path "$ROOT/Cargo.toml" -p bota-device-sdk-ffi
python3 "$ROOT/tools/speech/prepare-apple-livekit-host.py" "$ROOT"
exec swift run --package-path "$ROOT/target/apple-speech-livekit-host" \
  --scratch-path "$ROOT/target/apple-speech-livekit-host-build" -debug-info-format none -Xswiftc -enable-testing \
  "$@" BotaSpeechLiveKitHostChecks
