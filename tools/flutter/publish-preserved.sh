#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MODE="${1:-}"
if [[ $# -ne 1 || ( "$MODE" != "--dry-run" && "$MODE" != "--publish" ) ]]; then
  echo "usage: $0 <--dry-run|--publish>" >&2
  exit 2
fi

VERSION="$(sed -n 's/^version = "\([^"]*\)"$/\1/p' "$ROOT/sdk-version.toml")"
CANDIDATE="$ROOT/target/flutter-release"
node "$ROOT/tools/flutter/verify-publication.mjs" verify-candidate \
  --archive "$CANDIDATE/bota_app_sdk-$VERSION.tar.gz" \
  --inventory "$CANDIDATE/package-inventory.json"

PUBLISH_ROOT="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/flutter-publish.XXXXXX")"
trap 'rm -rf "$PUBLISH_ROOT"' EXIT
tar -xzf "$CANDIDATE/bota_app_sdk-$VERSION.tar.gz" --directory "$PUBLISH_ROOT"
cp "$CANDIDATE/pubspec.lock" "$PUBLISH_ROOT/pubspec.lock"
cd "$PUBLISH_ROOT"
# Package archives intentionally omit example/pubspec.lock. Enforce the preserved
# library lock without resolving the independently tested example a second time.
"$ROOT/tools/flutter/run-flutter.sh" pub get --enforce-lockfile --no-example
if [[ "$MODE" == "--dry-run" ]]; then
  "$ROOT/tools/flutter/run-flutter.sh" pub publish --dry-run
else
  "$ROOT/tools/flutter/run-flutter.sh" pub publish --force
fi
