#!/usr/bin/env bash

set -euo pipefail

workspace_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
plugin_android="$workspace_root/frameworks/flutter/bota_flutter_sdk/android"
android_root="$workspace_root/platforms/android"
local_repository="$workspace_root/target/android-m2"
flutter_version="$(node -p "require('$workspace_root/tools/flutter/flutter-version.json').version")"
sdk_version="$(sed -n 's/^version = "\([^"]*\)"$/\1/p' "$workspace_root/sdk-version.toml")"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
test_tmp_root="$(cd "${BOTA_TEST_TMPDIR:-/tmp}" && pwd -P)"
consumer_root="$(mktemp -d "$test_tmp_root/bota-flutter-android-consumer.XXXXXX")"
cleanup() {
  find "$consumer_root" -depth -delete
}
trap cleanup EXIT

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

cat >"$consumer_root/settings.gradle.kts" <<EOF
pluginManagement {
    plugins {
        id("com.android.library") version "8.13.2"
        id("org.jetbrains.kotlin.android") version "2.1.20"
    }
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        maven { url = uri("$local_repository") }
        google()
        mavenCentral()
    }
}

rootProject.name = "bota-flutter-android-consumer"
include(":bota_flutter_sdk")
project(":bota_flutter_sdk").projectDir = file("$plugin_android")
EOF

"$android_root/gradlew" -p "$consumer_root" :bota_flutter_sdk:tasks --quiet \
  -PflutterSdkPath="$flutter_home" >/dev/null

mismatch_log="$consumer_root/mismatched-version.log"
if "$android_root/gradlew" -p "$consumer_root" :bota_flutter_sdk:tasks --quiet \
  -PflutterSdkPath="$flutter_home" \
  -PbotaAndroidSdkVersion=0.0.0 >"$mismatch_log" 2>&1; then
  echo "mismatched botaAndroidSdkVersion unexpectedly succeeded" >&2
  exit 1
fi
if ! rg -F -q "botaAndroidSdkVersion must match sdk-version.toml ($sdk_version)" "$mismatch_log"; then
  cat "$mismatch_log" >&2
  exit 1
fi

"$android_root/gradlew" -p "$plugin_android" testDebugUnitTest \
  -PbotaAndroidSdkRepository="$local_repository" \
  -PflutterSdkPath="$flutter_home"
