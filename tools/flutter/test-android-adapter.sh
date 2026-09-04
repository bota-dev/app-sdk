#!/usr/bin/env bash

set -euo pipefail

workspace_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
plugin_android="$workspace_root/frameworks/flutter/bota_flutter_sdk/android"
android_root="$workspace_root/platforms/android"
local_repository="$workspace_root/target/android-m2"
flutter_version="$(node -p "require('$workspace_root/tools/flutter/flutter-version.json').version")"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) flutter_platform="darwin-arm64" ;;
  Darwin-x86_64) flutter_platform="darwin-x64" ;;
  Linux-x86_64) flutter_platform="linux-x64" ;;
  *) echo "unsupported Flutter host" >&2; exit 1 ;;
esac

flutter_home="${BOTA_FLUTTER_HOME:-$workspace_root/target/flutter-sdk/$flutter_version/$flutter_platform/flutter}"
"$workspace_root/tools/flutter/run-flutter.sh" --version >/dev/null

[[ -f "$plugin_android/build.gradle.kts" ]] || {
  echo "Flutter Android adapter Gradle build is missing" >&2
  exit 1
}

"$android_root/gradlew" -p "$android_root" :sdk:publishMavenPublicationToLocalRepository
"$android_root/gradlew" -p "$plugin_android" testDebugUnitTest \
  -PbotaAndroidSdkRepository="$local_repository" \
  -PflutterSdkPath="$flutter_home"
