#!/bin/bash
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "$0")/../.." && pwd)
if ! command -v cargo >/dev/null 2>&1 && [[ -d /opt/homebrew/opt/rustup/bin ]]; then
  export PATH="/opt/homebrew/opt/rustup/bin:$PATH"
fi
cargo build --locked --manifest-path "$ROOT/Cargo.toml" -p bota-device-sdk-ffi
python3 "$ROOT/tools/speech/prepare-flutter-apple-host.py" "$ROOT"
exec swift run --package-path "$ROOT/target/flutter-speech-apple-host" \
  --scratch-path "$ROOT/target/flutter-speech-apple-build" -debug-info-format none \
  -Xswiftc -enable-testing -Xswiftc -strict-concurrency=complete \
  FlutterSpeechHostChecks
