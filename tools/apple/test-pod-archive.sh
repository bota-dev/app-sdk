#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUTPUT="$ROOT/target/apple-release"
SPEC="$ROOT/platforms/apple/BotaAppSDK.podspec"
VERSION="$(sed -n 's/^version = "\([^"]*\)"$/\1/p' "$ROOT/sdk-version.toml")"
MODE="${1:-check}"
case "$MODE" in
  check|--evidence-only) ;;
  *) printf 'usage: %s [--evidence-only]\n' "$0" >&2; exit 1 ;;
esac

mkdir -p "$ROOT/target"
TEMP="$(mktemp -d "$ROOT/target/apple-pod-test.XXXXXX")"
trap 'rm -rf "$TEMP"' EXIT

(
  cd "$OUTPUT"
  shasum -a 256 -c BotaAppSDK.cocoapods.zip.sha256
)
if [ "$MODE" = --evidence-only ]; then
  SPEC="$TEMP/BotaAppSDK.podspec"
  node "$ROOT/tools/release/generate-public-podspec.mjs" \
    --sdk-version "$VERSION" \
    --artifact-checksum "$(shasum -a 256 "$OUTPUT/BotaAppSDK.cocoapods.zip" | awk '{print $1}')" \
    --output "$SPEC"
else
  cp "$SPEC" "$TEMP/BotaAppSDK.podspec"
fi
test "$(pod ipc spec "$SPEC" | jq -r .version)" = "$VERSION"
test "$(pod ipc spec "$SPEC" | jq -r .source.sha256)" = \
  "$(shasum -a 256 "$OUTPUT/BotaAppSDK.cocoapods.zip" | awk '{print $1}')"
test "$(pod ipc spec "$SPEC" | jq -r .prepare_command)" = null

unzip -q "$OUTPUT/BotaAppSDK.cocoapods.zip" -d "$TEMP"
pod lib lint "$TEMP/BotaAppSDK.podspec" --allow-warnings --skip-tests
