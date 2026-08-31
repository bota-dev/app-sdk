#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
PACKAGE_ROOT="$ROOT/platforms/apple"
ARTIFACTS="$PACKAGE_ROOT/Artifacts"
OUTPUT="$ARTIFACTS/BotaDeviceSDKCore.xcframework"
HEADER_DIR="$ROOT/bindings/device-sdk-ffi/include"
HEADER="$HEADER_DIR/bota_device_sdk.h"
EVIDENCE="$ROOT/release/evidence/1.0.0-alpha.1-native-abi.md"
SWIFT_SOURCE="$PACKAGE_ROOT/Sources/BotaAppleSDK/BotaAppleSDK.swift"
mkdir -p "$ROOT/target"
BUILD_ROOT=$(mktemp -d "$ROOT/target/apple-xcframework.XXXXXX")
TEMP_OUTPUT="$ARTIFACTS/.BotaDeviceSDKCore.$$.xcframework"
BACKUP_OUTPUT="$ARTIFACTS/.BotaDeviceSDKCore.previous.$$.xcframework"

cleanup() {
    rm -rf "$BUILD_ROOT" "$TEMP_OUTPUT"
    if [ -e "$BACKUP_OUTPUT" ]; then
        if [ ! -e "$OUTPUT" ]; then
            mv "$BACKUP_OUTPUT" "$OUTPUT"
        else
            rm -rf "$BACKUP_OUTPUT"
        fi
    fi
}
trap cleanup EXIT HUP INT TERM

SDK_VERSION=$(sed -n 's/^version = "\([^"]*\)"$/\1/p' "$ROOT/sdk-version.toml")
SWIFT_VERSION=$(sed -n 's/.*current = "\([^"]*\)".*/\1/p' "$SWIFT_SOURCE")
EXPECTED_HEADER_SHA=$(sed -n 's/^| Header SHA-256 | `\([0-9a-f]*\)` |$/\1/p' "$EVIDENCE")
ACTUAL_HEADER_SHA=$(shasum -a 256 "$HEADER" | awk '{print $1}')

if [ -z "$SDK_VERSION" ] || [ "$SDK_VERSION" != "$SWIFT_VERSION" ]; then
    printf 'Apple SDK version %s does not match sdk-version.toml %s\n' \
        "${SWIFT_VERSION:-missing}" "${SDK_VERSION:-missing}" >&2
    exit 1
fi

if [ -z "$EXPECTED_HEADER_SHA" ] || [ "$ACTUAL_HEADER_SHA" != "$EXPECTED_HEADER_SHA" ]; then
    printf 'Native ABI header digest %s does not match frozen evidence %s\n' \
        "$ACTUAL_HEADER_SHA" "${EXPECTED_HEADER_SHA:-missing}" >&2
    exit 1
fi

rustup target add \
    aarch64-apple-ios \
    aarch64-apple-ios-sim \
    x86_64-apple-ios \
    aarch64-apple-darwin \
    x86_64-apple-darwin >/dev/null

CARGO_TARGET_DIR="$BUILD_ROOT/cargo"
export CARGO_TARGET_DIR
CARGO_HOME=${CARGO_HOME:-$HOME/.cargo}
RUSTFLAGS="${RUSTFLAGS:+$RUSTFLAGS }--remap-path-prefix=$ROOT=/bota-app-sdk --remap-path-prefix=$CARGO_HOME=/bota-cargo"
export RUSTFLAGS

IPHONEOS_DEPLOYMENT_TARGET=15.0 cargo build \
    --manifest-path "$ROOT/Cargo.toml" \
    --locked \
    --release \
    --package bota-device-sdk-ffi \
    --target aarch64-apple-ios

IPHONEOS_DEPLOYMENT_TARGET=15.0 cargo build \
    --manifest-path "$ROOT/Cargo.toml" \
    --locked \
    --release \
    --package bota-device-sdk-ffi \
    --target aarch64-apple-ios-sim

IPHONEOS_DEPLOYMENT_TARGET=15.0 cargo build \
    --manifest-path "$ROOT/Cargo.toml" \
    --locked \
    --release \
    --package bota-device-sdk-ffi \
    --target x86_64-apple-ios

MACOSX_DEPLOYMENT_TARGET=13.0 cargo build \
    --manifest-path "$ROOT/Cargo.toml" \
    --locked \
    --release \
    --package bota-device-sdk-ffi \
    --target aarch64-apple-darwin

MACOSX_DEPLOYMENT_TARGET=13.0 cargo build \
    --manifest-path "$ROOT/Cargo.toml" \
    --locked \
    --release \
    --package bota-device-sdk-ffi \
    --target x86_64-apple-darwin

mkdir -p "$BUILD_ROOT/libraries/ios-simulator" "$BUILD_ROOT/libraries/macos" "$ARTIFACTS"

xcrun lipo -create \
    "$BUILD_ROOT/cargo/aarch64-apple-ios-sim/release/libbota_device_sdk_ffi.a" \
    "$BUILD_ROOT/cargo/x86_64-apple-ios/release/libbota_device_sdk_ffi.a" \
    -output "$BUILD_ROOT/libraries/ios-simulator/libbota_device_sdk_ffi.a"

xcrun lipo -create \
    "$BUILD_ROOT/cargo/aarch64-apple-darwin/release/libbota_device_sdk_ffi.a" \
    "$BUILD_ROOT/cargo/x86_64-apple-darwin/release/libbota_device_sdk_ffi.a" \
    -output "$BUILD_ROOT/libraries/macos/libbota_device_sdk_ffi.a"

xcodebuild -create-xcframework \
    -library "$BUILD_ROOT/cargo/aarch64-apple-ios/release/libbota_device_sdk_ffi.a" \
    -headers "$HEADER_DIR" \
    -library "$BUILD_ROOT/libraries/ios-simulator/libbota_device_sdk_ffi.a" \
    -headers "$HEADER_DIR" \
    -library "$BUILD_ROOT/libraries/macos/libbota_device_sdk_ffi.a" \
    -headers "$HEADER_DIR" \
    -output "$TEMP_OUTPUT"

if [ -e "$OUTPUT" ]; then
    mv "$OUTPUT" "$BACKUP_OUTPUT"
fi
mv "$TEMP_OUTPUT" "$OUTPUT"
rm -rf "$BACKUP_OUTPUT"

"$ROOT/tools/apple/verify-reproducible-paths.sh"

printf 'Built BotaDeviceSDKCore.xcframework for SDK %s\n' "$SDK_VERSION"
