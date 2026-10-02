#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BUILD="$(mktemp -d "${TMPDIR:-/tmp}/bota-upload-apple.XXXXXX")"
trap 'rm -rf "$BUILD"' EXIT
swiftc -swift-version 6 -warnings-as-errors -parse-as-library \
  "$ROOT"/frameworks/react-native/ios/UploadBackend/Upload*.swift \
  "$ROOT/tools/react-native/tests/upload-backend-apple.swift" -o "$BUILD/tests"
"$BUILD/tests"
