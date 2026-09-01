#!/usr/bin/env bash
set -euo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly GRADLEW="$ROOT/platforms/android/gradlew"
readonly FIXTURE="$ROOT/tests/conformance/android-legacy-consumer"
readonly ANDROID_SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Library/Android/sdk}}"
readonly ADB="$ANDROID_SDK/platform-tools/adb"

api=""
mode=""
repository=""
compile_only=false
while (($#)); do
  case "$1" in
    --api) api="${2:?--api requires a value}"; shift 2 ;;
    --mode) mode="${2:?--mode requires a value}"; shift 2 ;;
    --repository) repository="${2:?--repository requires a value}"; shift 2 ;;
    --compile-only) compile_only=true; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [[ ("$mode" != "source" && "$mode" != "binary") || ("$compile_only" == false && -z "$api") ]]; then
  echo "Usage: test-legacy-consumer.sh --mode source|binary [--api API | --compile-only] [--repository PATH]" >&2
  exit 2
fi
version="$(awk -F'"' '/^version = / { print $2 }' "$ROOT/sdk-version.toml")"
if [[ -z "$repository" ]]; then
  repository="$ROOT/target/android-m2"
  "$GRADLEW" -p "$ROOT/platforms/android" :sdk:publishMavenPublicationToLocalRepository >/dev/null
fi
repository="$(cd "$repository" && pwd)"
test -s "$repository/dev/bota/bota-android-sdk/$version/bota-android-sdk-$version.aar"

arguments=(-PbotaSdkVersion="$version" -PbotaLegacyMode="$mode" "-PbotaSdkRepository=$repository")
if [[ "$mode" == "binary" ]]; then
  fixture="$ROOT/protocol/baseline/android-legacy-consumer-0f06d2a.jar"
  "$ROOT/tools/android/verify-legacy-consumer-fixture.sh" "$fixture"
  arguments+=("-PbotaLegacyConsumerJar=$fixture")
fi

"$GRADLEW" -p "$FIXTURE" --refresh-dependencies "${arguments[@]}" \
  :app:assembleDebug :app:assembleDebugAndroidTest >/dev/null
if [[ "$compile_only" == true ]]; then
  echo "Legacy Android $mode consumer compiled against Bota Android SDK $version"
  exit 0
fi

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
