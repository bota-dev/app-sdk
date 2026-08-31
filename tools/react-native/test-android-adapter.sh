#!/usr/bin/env bash

set -euo pipefail

workspace_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture_root="$workspace_root/tests/conformance/react-native-android-adapter"
release_directory="$workspace_root/target/android-release"
repository=""

usage() {
  echo "usage: $0 --repository PATH [--release-directory PATH]" >&2
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repository)
      [[ $# -ge 2 ]] || usage
      repository="$2"
      shift 2
      ;;
    --release-directory)
      [[ $# -ge 2 ]] || usage
      release_directory="$2"
      shift 2
      ;;
    *)
      usage
      ;;
  esac
done

[[ -n "$repository" ]] || usage
[[ -d "$repository" ]] || { echo "Android Maven repository not found: $repository" >&2; exit 1; }
[[ -d "$release_directory" ]] || { echo "Android release directory not found: $release_directory" >&2; exit 1; }

repository="$(cd "$repository" && pwd -P)"
release_directory="$(cd "$release_directory" && pwd -P)"

java_version="$(java -version 2>&1 | sed -n '1s/.*version "\([^"]*\)".*/\1/p')"
java_major="${java_version%%.*}"
if [[ "$java_major" == "1" ]]; then
  java_major="$(printf '%s' "$java_version" | cut -d. -f2)"
fi
[[ "$java_major" == "17" ]] || { echo "JDK 17 is required, found $java_version" >&2; exit 1; }

android_sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
[[ -n "$android_sdk" && -d "$android_sdk" ]] || { echo "ANDROID_HOME or ANDROID_SDK_ROOT must name an installed Android SDK" >&2; exit 1; }
[[ "$(node -p "Number(process.versions.node.split('.')[0]) >= 22")" == "true" ]] || { echo "Node.js 22 or newer is required" >&2; exit 1; }
[[ -d "$workspace_root/frameworks/react-native/node_modules/react-native" ]] || { echo "run npm ci in frameworks/react-native first" >&2; exit 1; }

version="$(sed -n 's/^version = "\([^"]*\)"$/\1/p' "$workspace_root/sdk-version.toml")"
[[ -n "$version" ]] || { echo "sdk-version.toml does not contain a version" >&2; exit 1; }
release_aar="$release_directory/bota-android-sdk-$version.aar"
repository_aar="$repository/dev/bota/bota-android-sdk/$version/bota-android-sdk-$version.aar"
[[ -s "$release_aar" ]] || { echo "packaged Android AAR not found: $release_aar" >&2; exit 1; }
[[ -s "$repository_aar" ]] || { echo "repository Android AAR not found: $repository_aar" >&2; exit 1; }

release_sha="$(shasum -a 256 "$release_aar" | awk '{print $1}')"
repository_sha="$(shasum -a 256 "$repository_aar" | awk '{print $1}')"
[[ "$release_sha" == "$repository_sha" ]] || { echo "repository AAR does not match packaged release AAR" >&2; exit 1; }

"$workspace_root/platforms/android/gradlew" \
  -p "$fixture_root" \
  -PbotaSdkRepository="$repository" \
  :adapter:generateCodegenArtifactsFromSchema \
  :adapter:testDebugUnitTest \
  :adapter:lintRelease \
  :adapter:assembleRelease \
  --refresh-dependencies \
  --no-daemon \
  --no-parallel \
  --no-configuration-cache

echo "React Native Android adapter consumed packaged Bota Android SDK $version ($release_sha)"
