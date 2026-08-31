#!/usr/bin/env bash
set -euo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly GRADLEW="$ROOT/platforms/android/gradlew"
readonly FIXTURE="$ROOT/tests/conformance/android-consumer"
readonly ANDROID_SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Library/Android/sdk}}"
readonly ADB="$ANDROID_SDK/platform-tools/adb"

api=""
while (($#)); do
  case "$1" in
    --api) api="${2:?--api requires a value}"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [[ -z "$api" ]]; then
  echo "--api is required" >&2
  exit 2
fi

version="$(awk -F'"' '/^version = / { print $2 }' "$ROOT/sdk-version.toml")"
"$GRADLEW" -p "$ROOT/platforms/android" :sdk:publishMavenPublicationToLocalRepository >/dev/null
"$GRADLEW" -p "$FIXTURE" --refresh-dependencies \
  -PbotaSdkVersion="$version" \
  :app:assembleDebug :app:assembleDebugAndroidTest >/dev/null

device="$($ADB devices | awk 'NR > 1 && $2 == "device" { print $1; exit }')"
if [[ -z "$device" ]]; then
  echo "No running Android target. Start an API-$api emulator." >&2
  exit 1
fi
actual_api="$($ADB -s "$device" shell getprop ro.build.version.sdk | tr -d '\r')"
if [[ "$actual_api" != "$api" ]]; then
  echo "Expected API $api but $device runs API $actual_api" >&2
  exit 1
fi

ANDROID_SERIAL="$device" "$GRADLEW" -p "$FIXTURE" \
  -PbotaSdkVersion="$version" \
  :app:connectedDebugAndroidTest
