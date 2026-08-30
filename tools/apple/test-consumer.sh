#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)

"$ROOT/tools/apple/build-xcframework.sh"

swift run \
    --package-path "$ROOT/tests/conformance/apple-consumer" \
    --scratch-path "$ROOT/target/apple-consumer" \
    AppleConsumer
