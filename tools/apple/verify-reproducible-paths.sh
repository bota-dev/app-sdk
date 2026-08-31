#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
ARTIFACT="$ROOT/platforms/apple/Artifacts/BotaDeviceSDKCore.xcframework"
CARGO_HOME=${CARGO_HOME:-$HOME/.cargo}

for archive in "$ARTIFACT"/*/libbota_device_sdk_ffi.a; do
    for path in "$ROOT" "$CARGO_HOME"; do
        if LC_ALL=C grep -a -F -q "$path" "$archive"; then
            printf '%s contains machine-specific path %s\n' "$archive" "$path" >&2
            exit 1
        fi
    done
done

printf 'Apple binary paths are reproducible\n'
