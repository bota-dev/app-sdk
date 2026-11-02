#!/bin/bash
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "$0")/../.." && pwd)
LOG="$ROOT/target/apple-speech-ios-build.log"
mkdir -p "$ROOT/target"
cd "$ROOT/platforms/apple-speech-livekit"
# Preserve each dependency's declared Swift language/concurrency mode. Global
# strict-concurrency overrides also affect the vendor's generated UniFFI code.
xcodebuild -scheme BotaSpeechLiveKit -destination 'generic/platform=iOS' \
  -derivedDataPath "$ROOT/target/apple-speech-ios" CODE_SIGNING_ALLOWED=NO \
  SWIFT_SUPPRESS_WARNINGS=NO build 2>&1 | tee "$LOG"
# Our Swift 6 targets retain complete concurrency checking. Fail on their iOS
# warnings without rewriting or changing compiler settings for vendor sources.
python3 - "$ROOT" "$LOG" <<'PY'
import re
import sys
from pathlib import Path
root, log = map(Path, sys.argv[1:])
owned = [root / "platforms/apple-speech-livekit", root / "platforms/apple/Sources"]
warnings = []
for line in log.read_text().splitlines():
    match = re.match(r"^(.+\.swift):\d+:\d+: warning:", line)
    if match and any(Path(match[1]).resolve().is_relative_to(path) for path in owned):
        warnings.append(line)
if warnings:
    print("Owned Apple speech sources emitted iOS compiler warnings:", file=sys.stderr)
    print("\n".join(warnings), file=sys.stderr)
    raise SystemExit(1)
PY
