#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ANDROID_ROOT="$ROOT/platforms/android"
GRADLE="$ANDROID_ROOT/gradlew"
OUTPUT="$ROOT/target/android-release"
LOCAL_REPOSITORY="$ROOT/target/android-m2"
SDK_VERSION="$(sed -n 's/^version = "\([^"]*\)"$/\1/p' "$ROOT/sdk-version.toml")"
SOURCE_REVISION="$(git -C "$ROOT" rev-parse HEAD)"
CREATED_AT="$(git -C "$ROOT" show -s --format=%cI HEAD)"
NODE="${NODE:-node}"

if [[ "${1:-}" != "--check" || $# -ne 1 ]]; then
  echo "usage: $0 --check" >&2
  exit 2
fi
if [[ -z "$SDK_VERSION" ]]; then
  echo "sdk-version.toml does not contain a version" >&2
  exit 1
fi
if [[ -n "$(git -C "$ROOT" status --porcelain --untracked-files=normal)" ]]; then
  echo "Android release packaging requires a clean source tree" >&2
  exit 1
fi

unset ORG_GRADLE_PROJECT_signingInMemoryKey
unset ORG_GRADLE_PROJECT_signingInMemoryKeyPassword
unset ORG_GRADLE_PROJECT_signingInMemoryKeyId
unset ORG_GRADLE_PROJECT_botaProtectedSigning

mkdir -p "$ROOT/target"
TEMP="$(mktemp -d "$ROOT/target/android-package.XXXXXX")"
cleanup() { rm -rf "$TEMP"; }
trap cleanup EXIT HUP INT TERM

build_once() {
  local name="$1"
  "$GRADLE" -p "$ANDROID_ROOT" :sdk:clean :sdk:assembleRelease \
    --no-daemon --no-parallel --no-configuration-cache
  cp "$ANDROID_ROOT/sdk/build/outputs/aar/sdk-release.aar" "$TEMP/$name.aar"
  mkdir "$TEMP/$name-native"
  unzip -q "$TEMP/$name.aar" 'jni/*/*.so' -d "$TEMP/$name-native"
  find "$TEMP/$name-native/jni" -type f -name '*.so' -print0 \
    | LC_ALL=C sort -z \
    | xargs -0 shasum -a 256 \
    | sed "s#$TEMP/$name-native/##" > "$TEMP/$name-native.sha256"
}

build_once first
build_once second
cmp "$TEMP/first.aar" "$TEMP/second.aar"
cmp "$TEMP/first-native.sha256" "$TEMP/second-native.sha256"
"$ROOT/tools/android/inspect-aar.sh" "$TEMP/second.aar"

TASKS="$TEMP/tasks.txt"
"$GRADLE" -p "$ANDROID_ROOT" :sdk:tasks --all \
  --no-daemon --no-parallel --no-configuration-cache > "$TASKS"
if grep -Eq '^signMavenPublication - |^publishMavenPublicationToCentralRawRepository - ' "$TASKS"; then
  echo "unsigned package graph exposes protected signing tasks" >&2
  exit 1
fi

rm -rf "$LOCAL_REPOSITORY"
"$GRADLE" -p "$ANDROID_ROOT" :sdk:publishMavenPublicationToLocalRepository \
  --no-daemon --no-parallel --no-configuration-cache
if find "$LOCAL_REPOSITORY" -type f -name '*.asc' -print -quit | grep . >/dev/null; then
  echo "unsigned local Maven repository contains a signature" >&2
  exit 1
fi

MAVEN_VERSION_DIRECTORY="$LOCAL_REPOSITORY/dev/bota/bota-android-sdk/$SDK_VERSION"
rm -rf "$OUTPUT"
mkdir -p "$OUTPUT"
for name in \
  "bota-android-sdk-$SDK_VERSION.aar" \
  "bota-android-sdk-$SDK_VERSION.pom" \
  "bota-android-sdk-$SDK_VERSION.module" \
  "bota-android-sdk-$SDK_VERSION-sources.jar" \
  "bota-android-sdk-$SDK_VERSION-javadoc.jar"
do
  cp "$MAVEN_VERSION_DIRECTORY/$name" "$OUTPUT/$name"
  for algorithm in md5 sha1 sha256 sha512; do
    openssl dgst "-$algorithm" -r "$OUTPUT/$name" | awk '{print $1}' > "$OUTPUT/$name.$algorithm"
  done
done
cmp "$TEMP/second.aar" "$OUTPUT/bota-android-sdk-$SDK_VERSION.aar"
cp "$ROOT/LICENSE" "$OUTPUT/LICENSE"

cargo metadata --manifest-path "$ROOT/Cargo.toml" --locked --format-version 1 > "$TEMP/cargo-metadata.json"
AAR_CHECKSUM="$(shasum -a 256 "$OUTPUT/bota-android-sdk-$SDK_VERSION.aar" | awk '{print $1}')"
"$NODE" "$ROOT/tools/release/generate-android-sbom.mjs" \
  --sdk-version "$SDK_VERSION" \
  --source-revision "$SOURCE_REVISION" \
  --artifact-checksum "$AAR_CHECKSUM" \
  --created-at "$CREATED_AT" \
  --aar "$OUTPUT/bota-android-sdk-$SDK_VERSION.aar" \
  --cargo-metadata "$TEMP/cargo-metadata.json" \
  --gradle-module "$OUTPUT/bota-android-sdk-$SDK_VERSION.module" \
  --maven-license-policy "$ROOT/protocol/baseline/android-maven-license-policy.json" \
  --output "$OUTPUT/BotaAndroidSDK.spdx.json"
"$NODE" "$ROOT/tools/release/generate-native-manifest.mjs" \
  --sdk-version "$SDK_VERSION" \
  --source-revision "$SOURCE_REVISION" \
  --artifact-checksum "$AAR_CHECKSUM" \
  --android-artifact "bota-android-sdk-$SDK_VERSION.aar" \
  --android-evidence "$ROOT/release/evidence/1.1.0-android-facade.md" \
  --baseline "$ROOT/protocol/baseline/react-native-sdk-0.0.65.json" \
  --compatibility "$ROOT/protocol/compatibility/firmware-compatibility.json" \
  --output "$OUTPUT/release-manifest.json"

"$ROOT/tools/android/verify-publication.sh" "$OUTPUT"
"$NODE" "$ROOT/tools/android/check-maven-license-policy.mjs" \
  "$OUTPUT/bota-android-sdk-$SDK_VERSION.module" \
  "$OUTPUT/BotaAndroidSDK.spdx.json" \
  "$ROOT/protocol/baseline/android-maven-license-policy.json"
if [[ -n "$(git -C "$ROOT" status --porcelain --untracked-files=normal)" ]]; then
  echo "Android release packaging changed tracked source" >&2
  exit 1
fi
echo "Packaged deterministic unsigned Android SDK $SDK_VERSION at $OUTPUT"
