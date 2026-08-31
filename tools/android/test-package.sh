#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ANDROID_ROOT="$ROOT/platforms/android"
ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Library/Android/sdk}}"
ADB="$ANDROID_SDK_ROOT/platform-tools/adb"
API=35
INSTRUMENTATION_CLASS=""
SKIP_BUILD=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --api)
      API="$2"
      shift 2
      ;;
    --instrumentation-class)
      INSTRUMENTATION_CLASS="$2"
      shift 2
      ;;
    --skip-build)
      SKIP_BUILD=true
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$INSTRUMENTATION_CLASS" ]]; then
  echo "--instrumentation-class is required" >&2
  exit 2
fi
if [[ ! -x "$ADB" ]]; then
  echo "adb was not found under $ANDROID_SDK_ROOT" >&2
  exit 1
fi

if [[ "$SKIP_BUILD" == false ]]; then
  "$ROOT/tools/android/build-native.sh"
  "$ANDROID_ROOT/gradlew" -p "$ANDROID_ROOT" \
    :sdk:assembleDebug \
    :sdk:assembleDebugAndroidTest
fi

device="$($ADB devices | awk 'NR > 1 && $2 == "device" { print $1; exit }')"
if [[ -z "$device" ]]; then
  echo "No running Android target. Start an API-$API emulator before running package tests." >&2
  exit 1
fi

actual_api="$($ADB -s "$device" shell getprop ro.build.version.sdk | tr -d '\r')"
if [[ "$actual_api" != "$API" ]]; then
  echo "Expected API $API but $device runs API $actual_api" >&2
  exit 1
fi

ANDROID_SERIAL="$device" "$ANDROID_ROOT/gradlew" -p "$ANDROID_ROOT" \
  :sdk:connectedDebugAndroidTest \
  "-Pandroid.testInstrumentationRunnerArguments.class=$INSTRUMENTATION_CLASS"
