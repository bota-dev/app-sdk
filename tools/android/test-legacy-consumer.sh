#!/usr/bin/env bash
set -euo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly GRADLEW="$ROOT/platforms/android/gradlew"
readonly FIXTURE="$ROOT/tests/conformance/android-legacy-consumer"
readonly ANDROID_SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Library/Android/sdk}}"
readonly ADB="$ANDROID_SDK/platform-tools/adb"

api=""
mode=""
legacy_path="${BOTA_LEGACY_ANDROID_PATH:-}"
while (($#)); do
  case "$1" in
    --api) api="${2:?--api requires a value}"; shift 2 ;;
    --mode) mode="${2:?--mode requires a value}"; shift 2 ;;
    --legacy-path) legacy_path="${2:?--legacy-path requires a value}"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [[ -z "$api" || ("$mode" != "source" && "$mode" != "binary") ]]; then
  echo "Usage: test-legacy-consumer.sh --api API --mode source|binary [--legacy-path PATH]" >&2
  exit 2
fi
if [[ "$mode" == "binary" && -z "$legacy_path" ]]; then
  echo "Binary mode requires --legacy-path or BOTA_LEGACY_ANDROID_PATH" >&2
  exit 2
fi

version="$(awk -F'"' '/^version = / { print $2 }' "$ROOT/sdk-version.toml")"
"$GRADLEW" -p "$ROOT/platforms/android" :sdk:publishMavenPublicationToLocalRepository >/dev/null

arguments=(-PbotaSdkVersion="$version" -PbotaLegacyMode="$mode")
if [[ "$mode" == "binary" ]]; then
  "$ROOT/tools/android/capture-legacy-api.sh" --legacy-path "$legacy_path" \
    --check "$ROOT/protocol/baseline/android-sdk-0f06d2a-public-api.txt" >/dev/null
  arguments+=("-PbotaLegacyAar=$legacy_path/sdk/build/outputs/aar/sdk-release.aar")
fi

"$GRADLEW" -p "$FIXTURE" --refresh-dependencies "${arguments[@]}" \
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

ANDROID_SERIAL="$device" "$GRADLEW" -p "$FIXTURE" "${arguments[@]}" \
  :app:connectedDebugAndroidTest
