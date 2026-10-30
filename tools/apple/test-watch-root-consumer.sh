#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
artifact="$repo_root/platforms/apple/Artifacts/BotaDeviceSDKCore.xcframework"
if [[ ! -f "$artifact/Info.plist" ]]; then
  echo "Build the existing Apple XCFramework before testing the root-package consumer." >&2
  exit 1
fi

# Pre-release CI cannot download an asset from the not-yet-published tag.
# Preserve the root product/target graph, substituting only the binary location
# with the native artifact built earlier in this same CI checkout.
mkdir -p "$repo_root/target"
fixture="$(mktemp -d "$repo_root/target/watch-root-consumer.XXXXXX")"
trap 'rm -rf "$fixture"' EXIT
python3 - "$repo_root" "$fixture" <<'PY'
from pathlib import Path
import re
import shutil
import sys

root, fixture = map(Path, sys.argv[1:])
manifest = (root / 'Package.swift').read_text()
manifest, count = re.subn(
    r'url: "https://github.com/bota-dev/app-sdk/releases/download/[^"\n]+/BotaDeviceSDKCore\.xcframework\.zip",\s*checksum: "[a-f0-9]{64}"',
    'path: "Artifacts/BotaDeviceSDKCore.xcframework"', manifest)
if count != 1:
    raise SystemExit('Expected exactly one pinned native artifact in the root manifest')
(fixture / 'Package.swift').write_text(manifest)
for relative in ['platforms/apple/Sources', 'platforms/watch/Sources']:
    shutil.copytree(root / relative, fixture / relative)
shutil.copytree(root / 'platforms/apple/Artifacts', fixture / 'Artifacts')
PY

export BOTA_WATCH_SDK_PATH="$fixture"
consumer="$repo_root/tests/consumers/watch-control"
swift run --package-path "$consumer" --scratch-path "$fixture/mac-build" \
  -Xswiftc -warnings-as-errors WatchControlConsumer
for destination in 'generic/platform=watchOS' 'generic/platform=watchOS Simulator'; do
  (
    cd "$consumer"
    xcodebuild -scheme WatchControlIntegration -destination "$destination" \
      -derivedDataPath "$fixture/$(echo "$destination" | tr ' /=' '-')" \
      CODE_SIGNING_ALLOWED=NO build
  )
done
