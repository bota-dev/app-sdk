#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)

"$ROOT/tools/apple/build-xcframework.sh"

swift test \
    --package-path "$ROOT/platforms/apple" \
    --scratch-path "$ROOT/target/apple-swiftpm" \
    "$@"
