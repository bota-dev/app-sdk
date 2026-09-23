#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUTPUT="$ROOT/target/apple-release"
SPEC="$ROOT/platforms/apple/BotaAppleSDK.podspec"
VERSION="$(sed -n 's/^version = "\([^"]*\)"$/\1/p' "$ROOT/sdk-version.toml")"

(
  cd "$OUTPUT"
  shasum -a 256 -c BotaAppleSDK.cocoapods.zip.sha256
)
test "$(pod ipc spec "$SPEC" | jq -r .version)" = "$VERSION"
test "$(pod ipc spec "$SPEC" | jq -r .source.sha256)" = \
  "$(shasum -a 256 "$OUTPUT/BotaAppleSDK.cocoapods.zip" | awk '{print $1}')"
test "$(pod ipc spec "$SPEC" | jq -r .prepare_command)" = null

mkdir -p "$ROOT/target"
TEMP="$(mktemp -d "$ROOT/target/apple-pod-test.XXXXXX")"
trap 'rm -rf "$TEMP"' EXIT
unzip -q "$OUTPUT/BotaAppleSDK.cocoapods.zip" -d "$TEMP"
cp "$SPEC" "$TEMP/BotaAppleSDK.podspec"
pod lib lint "$TEMP/BotaAppleSDK.podspec" --allow-warnings --skip-tests
