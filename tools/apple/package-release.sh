#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
OUTPUT="$ROOT/target/apple-release"
ARTIFACT="$ROOT/platforms/apple/Artifacts/BotaDeviceSDKCore.xcframework"
ARCHIVE="$OUTPUT/BotaDeviceSDKCore.xcframework.zip"
NODE=${NODE:-node}
PACKAGE_MANIFEST_MODE=check

case ${1:-} in
    "") ;;
    --write-package-manifest) PACKAGE_MANIFEST_MODE=write ;;
    *)
        printf 'usage: %s [--write-package-manifest]\n' "$0" >&2
        exit 1
        ;;
esac

if [ -n "$(git -C "$ROOT" status --porcelain --untracked-files=normal)" ]; then
    printf 'Apple release packaging requires a clean source tree\n' >&2
    exit 1
fi

NODE_MAJOR=$($NODE -p 'Number(process.versions.node.split(".")[0])')
if [ "$NODE_MAJOR" -lt 22 ]; then
    printf 'Apple release packaging requires Node.js 22 or newer (found %s)\n' \
        "$($NODE --version)" >&2
    exit 1
fi

SDK_VERSION=$(sed -n 's/^version = "\([^"]*\)"$/\1/p' "$ROOT/sdk-version.toml")
SOURCE_REVISION=$(git -C "$ROOT" rev-parse HEAD)
CREATED_AT=$(git -C "$ROOT" show -s --format=%cI HEAD)
if [ -z "$SDK_VERSION" ]; then
    printf 'sdk-version.toml does not contain a version\n' >&2
    exit 1
fi

mkdir -p "$ROOT/target"
TEMP=$(mktemp -d "$ROOT/target/apple-release.XXXXXX")
cleanup() { rm -rf "$TEMP"; }
trap cleanup EXIT HUP INT TERM

"$ROOT/tools/apple/build-xcframework.sh"

rm -rf "$OUTPUT"
mkdir -p "$OUTPUT" "$TEMP/archive"
cp -R "$ARTIFACT" "$TEMP/archive/"
PLIST="$TEMP/archive/BotaDeviceSDKCore.xcframework/Info.plist"
plutil -convert json "$PLIST"
$NODE "$ROOT/tools/release/normalize-apple-xcframework.mjs" "$PLIST" "$PLIST"
plutil -lint "$PLIST" >/dev/null

export COPYFILE_DISABLE=1
export LC_ALL=C
export TZ=UTC
find "$TEMP/archive" -exec touch -h -t 198001010000 {} +
printf 'Apple archive input digests:\n'
find "$TEMP/archive/BotaDeviceSDKCore.xcframework" -type f -print0 \
    | LC_ALL=C sort -z \
    | xargs -0 shasum -a 256
(
    cd "$TEMP/archive"
    find BotaDeviceSDKCore.xcframework -print \
        | LC_ALL=C sort \
        | zip -X -q "$ARCHIVE" -@
)

ARTIFACT_CHECKSUM=$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')
SWIFTPM_CHECKSUM=$(swift package compute-checksum "$ARCHIVE")
printf 'Apple archive checksum: %s\n' "$ARTIFACT_CHECKSUM"
if [ "$ARTIFACT_CHECKSUM" != "$SWIFTPM_CHECKSUM" ] || [ "$ARTIFACT_CHECKSUM" = "$(printf '%064d' 0)" ]; then
    printf 'Apple artifact checksum validation failed\n' >&2
    exit 1
fi

printf '%s  %s\n' "$ARTIFACT_CHECKSUM" "$(basename "$ARCHIVE")" \
    > "$OUTPUT/BotaDeviceSDKCore.xcframework.zip.sha256"
printf '%s\n' "$SWIFTPM_CHECKSUM" \
    > "$OUTPUT/BotaDeviceSDKCore.xcframework.swiftpm-checksum"
cp "$ROOT/LICENSE" "$OUTPUT/LICENSE"

cargo metadata --manifest-path "$ROOT/Cargo.toml" --locked --format-version 1 \
    > "$TEMP/cargo-metadata.json"
swift package \
    --package-path "$ROOT/platforms/apple" \
    --scratch-path "$TEMP/swiftpm" \
    show-dependencies --format json \
    > "$TEMP/swift-dependencies.json"

$NODE "$ROOT/tools/release/generate-apple-sbom.mjs" \
    --sdk-version "$SDK_VERSION" \
    --source-revision "$SOURCE_REVISION" \
    --artifact-checksum "$ARTIFACT_CHECKSUM" \
    --created-at "$CREATED_AT" \
    --cargo-metadata "$TEMP/cargo-metadata.json" \
    --swift-dependencies "$TEMP/swift-dependencies.json" \
    --output "$OUTPUT/BotaAppleSDK.spdx.json"

$NODE "$ROOT/tools/release/generate-apple-manifest.mjs" \
    --sdk-version "$SDK_VERSION" \
    --source-revision "$SOURCE_REVISION" \
    --artifact-checksum "$ARTIFACT_CHECKSUM" \
    --baseline "$ROOT/protocol/baseline/react-native-sdk-0.0.65.json" \
    --compatibility "$ROOT/protocol/compatibility/firmware-compatibility.json" \
    --output "$OUTPUT/release-manifest.json"

if grep -F "$ROOT" "$OUTPUT/BotaAppleSDK.spdx.json" >/dev/null; then
    printf 'SPDX output contains the local checkout path\n' >&2
    exit 1
fi
cmp "$ROOT/LICENSE" "$OUTPUT/LICENSE"
cargo xtask release validate "$OUTPUT/release-manifest.json"
if [ "$PACKAGE_MANIFEST_MODE" = write ]; then
    $NODE "$ROOT/tools/release/generate-public-swift-package.mjs" \
        --sdk-version "$SDK_VERSION" \
        --artifact-checksum "$SWIFTPM_CHECKSUM" \
        --output "$ROOT/Package.swift"
else
    $NODE "$ROOT/tools/release/generate-public-swift-package.mjs" \
        --sdk-version "$SDK_VERSION" \
        --artifact-checksum "$SWIFTPM_CHECKSUM" \
        --output "$ROOT/Package.swift" \
        --check
fi
swift package --package-path "$ROOT" dump-package >/dev/null

printf 'Packaged Apple SDK %s (%s) at %s\n' \
    "$SDK_VERSION" "$ARTIFACT_CHECKSUM" "$OUTPUT"
