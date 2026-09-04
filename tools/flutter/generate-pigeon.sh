#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PACKAGE_PATH="frameworks/flutter/bota_flutter_sdk"
PACKAGE_ROOT="$ROOT/$PACKAGE_PATH"
CONFIG="$PACKAGE_ROOT/pigeon_options.yaml"
OUTPUT_ROOT="${BOTA_PIGEON_OUTPUT_ROOT:-$ROOT}"

config_value() {
  node -e '
    const config = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const value = config[process.argv[2]];
    if (typeof value !== "string" || value.length === 0) process.exit(1);
    process.stdout.write(value);
  ' "$CONFIG" "$1"
}

INPUT="$(config_value input)"
DART_OUT="$(config_value dart_out)"
SWIFT_OUT="$(config_value swift_out)"
KOTLIN_OUT="$(config_value kotlin_out)"
KOTLIN_PACKAGE="$(config_value kotlin_package)"
DART_PACKAGE="$(config_value dart_package_name)"

mkdir -p \
  "$OUTPUT_ROOT/$PACKAGE_PATH/$(dirname "$DART_OUT")" \
  "$OUTPUT_ROOT/$PACKAGE_PATH/$(dirname "$SWIFT_OUT")" \
  "$OUTPUT_ROOT/$PACKAGE_PATH/$(dirname "$KOTLIN_OUT")"

cd "$PACKAGE_ROOT"
"$ROOT/tools/flutter/run-dart.sh" run pigeon \
  --input "$INPUT" \
  --dart_out "$OUTPUT_ROOT/$PACKAGE_PATH/$DART_OUT" \
  --swift_out "$OUTPUT_ROOT/$PACKAGE_PATH/$SWIFT_OUT" \
  --kotlin_out "$OUTPUT_ROOT/$PACKAGE_PATH/$KOTLIN_OUT" \
  --kotlin_package "$KOTLIN_PACKAGE" \
  --package_name "$DART_PACKAGE"
