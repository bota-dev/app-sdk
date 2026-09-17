#!/usr/bin/env bash

set -euo pipefail

workspace_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
plugin_root="$workspace_root/frameworks/flutter/bota_flutter_sdk"
example_root="$plugin_root/example"
info_plist="$example_root/ios/Runner/Info.plist"
android_manifest="$example_root/android/app/src/main/AndroidManifest.xml"
android_root="$workspace_root/platforms/android"
android_repository="$workspace_root/target/android-m2"
apple_package="$workspace_root/platforms/apple"
apple_artifact="$apple_package/Artifacts/BotaDeviceSDKCore.xcframework"
sdk_version="$(sed -n 's/^version = "\([^"]*\)"$/\1/p' "$workspace_root/sdk-version.toml")"
flutter_version="$(node -p "require('$workspace_root/tools/flutter/flutter-version.json').version")"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) flutter_platform="darwin-arm64" ;;
  Darwin-x86_64) flutter_platform="darwin-x64" ;;
  *) echo "Flutter iOS and Android consumer gates require macOS" >&2; exit 1 ;;
esac

if [[ -z "${JAVA_HOME:-}" ]]; then
  export JAVA_HOME="$(/usr/libexec/java_home -v 17)"
fi

"$workspace_root/tools/flutter/run-flutter.sh" --version >/dev/null
flutter_home="${BOTA_FLUTTER_HOME:-$workspace_root/target/flutter-sdk/$flutter_version/$flutter_platform/flutter}"
export BOTA_FLUTTER_HOME="$flutter_home"

test_tmp_root="$(cd "${BOTA_TEST_TMPDIR:-/tmp}" && pwd -P)"
consumer_root="$(mktemp -d "$test_tmp_root/bota-flutter-consumers.XXXXXX")"
consumer="$consumer_root/example"
consumer_gradle_home="$consumer_root/gradle-home"
cleanup() {
  local status=$?
  trap - EXIT
  if [[ -x "$consumer/android/gradlew" && -d "$consumer_gradle_home" ]]; then
    GRADLE_USER_HOME="$consumer_gradle_home" \
      "$consumer/android/gradlew" -p "$consumer/android" --stop \
      >/dev/null 2>&1 || true
  fi
  if ! find "$consumer_root" -depth -delete; then
    status=1
  fi
  if [[ -e "$consumer_root" ]]; then
    echo "Flutter consumer temporary root remains: $consumer_root" >&2
    status=1
  else
    printf 'Flutter consumer temporary root removed: %s\n' "$consumer_root"
  fi
  exit "$status"
}
trap cleanup EXIT

require_file() {
  [[ -f "$1" ]] || {
    echo "Flutter consumer gate is missing ${1#"$workspace_root/"}" >&2
    return 1
  }
}

validate_permissions() {
  local plist="$1"
  local manifest="$2"
  local flattened

  for key in NSBluetoothAlwaysUsageDescription NSBluetoothPeripheralUsageDescription; do
    local value
    value="$(/usr/libexec/PlistBuddy -c "Print :$key" "$plist" 2>/dev/null)" || {
      echo "Flutter iOS example is missing $key" >&2
      return 1
    }
    [[ -n "$value" ]] || {
      echo "Flutter iOS example has an empty $key" >&2
      return 1
    }
  done

  flattened="$(tr '\n' ' ' <"$manifest")"
  for permission in \
    android.permission.BLUETOOTH \
    android.permission.BLUETOOTH_ADMIN \
    android.permission.ACCESS_FINE_LOCATION
  do
    printf '%s' "$flattened" | grep -Eq \
      "uses-permission[^>]*android:name=\"$permission\"[^>]*android:maxSdkVersion=\"30\"" || {
        echo "Flutter Android example must cap $permission at API 30" >&2
        return 1
      }
  done
  for permission in \
    android.permission.BLUETOOTH_SCAN \
    android.permission.BLUETOOTH_CONNECT
  do
    printf '%s' "$flattened" | grep -Eq \
      "uses-permission[^>]*android:name=\"$permission\"" || {
        echo "Flutter Android example is missing $permission" >&2
        return 1
      }
  done
  printf '%s' "$flattened" | grep -Eq \
    'uses-permission[^>]*android:name="android.permission.BLUETOOTH_SCAN"[^>]*android:usesPermissionFlags="neverForLocation"' || {
      echo "Flutter Android example must mark BLE scans neverForLocation" >&2
      return 1
    }
}

for required in \
  "$example_root/pubspec.yaml" \
  "$example_root/lib/main.dart" \
  "$info_plist" \
  "$android_manifest"
do
  require_file "$required"
done
validate_permissions "$info_plist" "$android_manifest"

bad_plist="$consumer_root/Info.plist"
cp "$info_plist" "$bad_plist"
/usr/libexec/PlistBuddy -c 'Delete :NSBluetoothAlwaysUsageDescription' "$bad_plist"
if validate_permissions "$bad_plist" "$android_manifest" >/dev/null 2>&1; then
  echo "Flutter iOS permission validation accepted a missing usage description" >&2
  exit 1
fi

bad_manifest="$consumer_root/AndroidManifest.xml"
sed '/android.permission.BLUETOOTH_CONNECT/d' "$android_manifest" >"$bad_manifest"
if validate_permissions "$info_plist" "$bad_manifest" >/dev/null 2>&1; then
  echo "Flutter Android permission validation accepted a missing permission" >&2
  exit 1
fi

if grep -En '(^|[^[:alnum:]_])(debugPrint|print|log)[[:space:]]*\(' \
  "$example_root/lib/main.dart" >/dev/null; then
  echo "Flutter example must not log callback material, grants, or credentials" >&2
  exit 1
fi

node "$workspace_root/tools/flutter/verify-package.mjs"
npm --prefix "$workspace_root" run flutter:generate:check
swift package dump-package \
  --package-path "$plugin_root/ios/bota_flutter_sdk" \
  >"$consumer_root/flutter-public-package.json"

"$workspace_root/tools/apple/build-xcframework.sh"
[[ -d "$apple_artifact" ]] || {
  echo "Fresh local BotaAppleSDK artifact is missing" >&2
  exit 1
}
if ! grep -Eq "spec.version = \"$sdk_version\"" \
  "$apple_package/BotaAppleSDK.podspec"; then
  echo "Local BotaAppleSDK pod does not match $sdk_version" >&2
  exit 1
fi
local_plugin_root="$consumer_root/local-plugin"
rsync -a \
  --exclude .dart_tool \
  --exclude build \
  --exclude pubspec.lock \
  --exclude example/.dart_tool \
  --exclude example/build \
  --exclude example/pubspec.lock \
  "$plugin_root/" "$local_plugin_root/"
SWIFT_MANIFEST="$local_plugin_root/ios/bota_flutter_sdk/Package.swift" \
  APPLE_PACKAGE="$apple_package" SDK_VERSION="$sdk_version" node -e '
    const fs = require("node:fs");
    const path = process.env.SWIFT_MANIFEST;
    const source = fs.readFileSync(path, "utf8");
    const marker = `.package(
      url: "https://github.com/bota-dev/app-sdk.git",
      exact: "${process.env.SDK_VERSION}"
    ),`;
    const replacement = `.package(name: "app-sdk", path: ${JSON.stringify(process.env.APPLE_PACKAGE)}),`;
    if (!source.includes(marker)) throw new Error("public BotaAppleSDK dependency marker changed");
    fs.writeFileSync(path, source.replace(marker, replacement));
  '
swift package dump-package \
  --package-path "$local_plugin_root/ios/bota_flutter_sdk" \
  >"$consumer_root/flutter-plugin-package.json"
if ! grep -Fq "$apple_package" "$consumer_root/flutter-plugin-package.json"; then
  echo "Flutter iOS plugin did not resolve the local BotaAppleSDK package" >&2
  exit 1
fi

android_candidate_dir="$android_repository/dev/bota/bota-android-sdk/$sdk_version"
if [[ -e "$android_candidate_dir" ]]; then
  find "$android_candidate_dir" -depth -delete
fi
"$android_root/gradlew" -p "$android_root" \
  :sdk:clean :sdk:publishMavenPublicationToLocalRepository
android_aar="$android_candidate_dir/bota-android-sdk-$sdk_version.aar"
android_pom="$android_candidate_dir/bota-android-sdk-$sdk_version.pom"
require_file "$android_aar"
require_file "$android_pom"
if ! grep -Eq "<version>$sdk_version</version>" "$android_pom"; then
  echo "Local Android candidate POM does not match $sdk_version" >&2
  exit 1
fi

"$workspace_root/tools/flutter/run-flutter.sh" create \
  --no-pub \
  --platforms=ios,android \
  --org=dev.bota \
  --project-name=bota_flutter_sdk_example \
  "$consumer" </dev/null >/dev/null
cp "$example_root/pubspec.yaml" "$consumer/pubspec.yaml"
cp "$example_root/lib/main.dart" "$consumer/lib/main.dart"
cp "$info_plist" "$consumer/ios/Runner/Info.plist"
cp "$android_manifest" "$consumer/android/app/src/main/AndroidManifest.xml"

EXAMPLE_PUBSPEC="$consumer/pubspec.yaml" PLUGIN_ROOT="$local_plugin_root" node -e '
  const fs = require("node:fs");
  const path = process.env.EXAMPLE_PUBSPEC;
  const source = fs.readFileSync(path, "utf8");
  const marker = "    path: ..";
  if (!source.includes(marker)) {
    throw new Error("Flutter example dependency path marker is missing");
  }
  fs.writeFileSync(path, source.replace(marker, `    path: ${process.env.PLUGIN_ROOT}`));
'

ANDROID_BUILD="$consumer/android/build.gradle.kts" \
  ANDROID_REPOSITORY="$android_repository" node -e '
    const fs = require("node:fs");
    const path = process.env.ANDROID_BUILD;
    const source = fs.readFileSync(path, "utf8");
    const marker = `allprojects {
    repositories {
        google()
        mavenCentral()
    }
}`;
    if (!source.includes(marker)) {
      throw new Error("Flutter Android repository template changed");
    }
    const localRepository = `allprojects {
    repositories {
        exclusiveContent {
            forRepository {
                maven { url = uri(${JSON.stringify(process.env.ANDROID_REPOSITORY)}) }
            }
            filter { includeGroup("dev.bota") }
        }
        google()
        mavenCentral()
    }
}`;
    fs.writeFileSync(path, source.replace(marker, localRepository));
  '
perl -0pi -e 's/minSdk = flutter\.minSdkVersion/minSdk = 26/' \
  "$consumer/android/app/build.gradle.kts"
perl -0pi -e \
  's/IPHONEOS_DEPLOYMENT_TARGET = [0-9.]+;/IPHONEOS_DEPLOYMENT_TARGET = 15.0;/g' \
  "$consumer/ios/Runner.xcodeproj/project.pbxproj"

"$workspace_root/tools/flutter/run-flutter.sh" pub get --directory="$consumer"

(
  cd "$consumer"
  GRADLE_OPTS="${GRADLE_OPTS:-} -Dorg.gradle.daemon=false" \
    GRADLE_USER_HOME="$consumer_gradle_home" \
    "$workspace_root/tools/flutter/run-flutter.sh" build apk \
    --release --target lib/main.dart
)
android_output="$consumer/build/app/outputs/flutter-apk/app-release.apk"
require_file "$android_output"

GRADLE_USER_HOME="$consumer_gradle_home" \
  "$consumer/android/gradlew" -p "$consumer/android" \
  --no-daemon \
  :app:dependencyInsight \
  --configuration releaseRuntimeClasspath \
  --dependency dev.bota:bota-android-sdk \
  >"$consumer_root/android-dependency.txt"
if ! grep -Fq "dev.bota:bota-android-sdk:$sdk_version" \
  "$consumer_root/android-dependency.txt"; then
  echo "Flutter Android release did not resolve bota-android-sdk $sdk_version" >&2
  exit 1
fi

(
  cd "$consumer"
  "$workspace_root/tools/flutter/run-flutter.sh" build ios \
    --release --no-codesign --target lib/main.dart
)
ios_output="$consumer/build/ios/iphoneos/Runner.app"
[[ -d "$ios_output" ]] || {
  echo "Flutter iOS release application is missing" >&2
  exit 1
}

printf 'Flutter Android release consumer built: %s (native %s)\n' \
  "$android_output" "$sdk_version"
printf 'Flutter iOS release consumer built: %s (native %s)\n' \
  "$ios_output" "$sdk_version"
