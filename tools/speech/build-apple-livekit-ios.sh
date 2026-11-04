#!/bin/bash
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "$0")/../.." && pwd)
LOG="$ROOT/target/apple-speech-ios-build.log"
mkdir -p "$ROOT/target"
# Preserve each dependency's declared Swift language/concurrency mode. Global
# strict-concurrency overrides also affect the vendor's generated UniFFI code.
xcodebuild -project "$ROOT/platforms/apple-speech-livekit/Examples/Companion.xcodeproj" \
  -scheme SpeechCompanionApp -destination 'generic/platform=iOS' \
  -derivedDataPath "$ROOT/target/apple-speech-ios" CODE_SIGNING_ALLOWED=NO \
  SWIFT_SUPPRESS_WARNINGS=NO build 2>&1 | tee "$LOG"
xcodebuild -project "$ROOT/platforms/apple-speech-livekit/Examples/Companion.xcodeproj" \
  -scheme SpeechCompanionApp -destination 'platform=macOS' \
  -derivedDataPath "$ROOT/target/apple-speech-macos" CODE_SIGNING_ALLOWED=NO \
  SWIFT_SUPPRESS_WARNINGS=NO build 2>&1 | tee -a "$LOG"
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

# Internal source-preview Apps only; no notarization, distribution signing or publication.
MAC_APP="$ROOT/target/apple-speech-macos/Build/Products/Debug/SpeechCompanionApp.app"
codesign --force --deep --sign - "$MAC_APP"
codesign --verify --deep --strict "$MAC_APP"
python3 - "$MAC_APP" "$ROOT/target/apple-speech-ios/Build/Products/Debug-iphoneos/SpeechCompanionApp.app" <<'PY'
import plistlib
import re
import subprocess
import sys
from pathlib import Path

for path in map(Path, sys.argv[1:]):
    contents = path / "Contents" if (path / "Contents").is_dir() else path
    metadata = plistlib.loads((contents / "Info.plist").read_bytes())
    binary = (contents / "MacOS" if contents != path else contents) / metadata["CFBundleExecutable"]
    def rpaths(image):
        commands = subprocess.check_output(["otool", "-l", str(image)], text=True)
        paths = re.findall(r"cmd LC_RPATH\s+cmdsize \d+\s+path (.*?) \(offset", commands)
        return [Path(item.replace("@executable_path", str(binary.parent), 1)
                         .replace("@loader_path", str(image.parent), 1)).resolve() for item in paths]

    # Xcode's debug companion dylib can live beside the executable. Resolve
    # declared loader paths instead of assuming every dependency is a framework.
    inherited = rpaths(binary)
    pending, seen = [binary], set()
    while pending:
        current = pending.pop().resolve()
        if current in seen:
            continue
        seen.add(current)
        links = subprocess.check_output(["otool", "-L", str(current)], text=True)
        for line in links.splitlines()[1:]:
            dependency = line.strip().split(" ", 1)[0]
            if dependency.startswith("@rpath/") and not dependency.startswith("@rpath/libswift"):
                candidates = [directory / dependency.removeprefix("@rpath/")
                              for directory in [*rpaths(current), *inherited]]
                embedded = next((candidate for candidate in candidates
                                 if candidate.is_file() and candidate.resolve().is_relative_to(path.resolve())), None)
                if embedded is None:
                    raise SystemExit(f"Missing embedded App dependency: {dependency}")
                pending.append(embedded)
    print(f"Verified embedded App dependencies: {path.name}, {len(seen)} native binaries")
PY
mkdir -p "$ROOT/target/apple-speech-companion"
ditto -c -k --keepParent "$MAC_APP" "$ROOT/target/apple-speech-companion/SpeechCompanion-macOS.zip"
ditto -c -k --keepParent "$ROOT/target/apple-speech-ios/Build/Products/Debug-iphoneos/SpeechCompanionApp.app" \
  "$ROOT/target/apple-speech-companion/SpeechCompanion-iOS-unsigned.zip"
