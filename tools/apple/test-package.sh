#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)

node "$ROOT/tools/apple/sync-protocol-fixtures.mjs" --check
node "$ROOT/tools/apple/sync-workflow-fixtures.mjs" --check
node "$ROOT/tools/speech/sync-host.mjs"
"$ROOT/tools/apple/build-xcframework.sh"

swift test \
    --package-path "$ROOT/platforms/apple" \
    --scratch-path "$ROOT/target/apple-swiftpm" \
    "$@"
