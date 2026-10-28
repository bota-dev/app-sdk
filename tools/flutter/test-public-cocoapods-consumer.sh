#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VERSION="${1:-}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "usage: $0 <version> [--plugin-archive <archive> --plugin-inventory <inventory>]" >&2
  exit 2
fi
shift
archive=""
inventory=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --plugin-archive)
      [[ $# -ge 2 && -z "$archive" ]] || exit 2
      archive="$2"; shift 2 ;;
    --plugin-inventory)
      [[ $# -ge 2 && -z "$inventory" ]] || exit 2
      inventory="$2"; shift 2 ;;
    *) echo "unknown Flutter consumer argument" >&2; exit 2 ;;
  esac
done
if [[ -n "$archive" && -z "$inventory" ]] || [[ -z "$archive" && -n "$inventory" ]]; then
  echo "A preserved Flutter archive and its verified inventory must be supplied together" >&2
  exit 2
fi
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "The Flutter CocoaPods consumer gate requires macOS" >&2
  exit 1
fi

APPLE_PACKAGE="$(node "$ROOT/tools/release/package-identities.mjs" apple "$VERSION")"
SPECS_REPOSITORY="$(node "$ROOT/tools/flutter/verify-cocoapods-consumer.mjs" --repository-url)"
required_cocoapods_version="1.16.2"
homebrew_pod=""
if [[ -x /opt/homebrew/opt/ruby/bin/ruby ]]; then
  export PATH="/opt/homebrew/opt/ruby/bin:$PATH"
  homebrew_pod="$(/opt/homebrew/opt/ruby/bin/ruby -e 'print Gem.bindir')/pod"
fi
pod_command=()
for candidate in "${POD_BINARY:-}" "$homebrew_pod" "$(command -v pod || true)"; do
  if [[ -n "$candidate" && -x "$candidate" ]] \
    && [[ "$("$candidate" "_${required_cocoapods_version}_" --version 2>/dev/null)" == "$required_cocoapods_version" ]]; then
    pod_command=("$candidate" "_${required_cocoapods_version}_")
    break
  fi
done
if [[ "${#pod_command[@]}" -eq 0 ]]; then
  echo "CocoaPods $required_cocoapods_version is required" >&2
  exit 1
fi
export PATH="$(dirname "${pod_command[0]}"):$PATH"
unset BOTA_APPLE_SDK_PACKAGE_PATH

temporary="$(mktemp -d "${BOTA_TEST_TMPDIR:-/tmp}/bota-public-flutter-pods.XXXXXX")"
cleanup() { rm -rf "$temporary"; }
trap cleanup EXIT
consumer="$temporary/consumer"
export CP_HOME_DIR="$temporary/cocoapods-home"
export CP_REPOS_DIR="$temporary/cocoapods-repos"
export CP_CACHE_DIR="$temporary/cocoapods-cache"
export PUB_CACHE="$temporary/pub-cache"
export COCOAPODS_DISABLE_STATS=true

"$ROOT/tools/flutter/run-flutter.sh" create --platforms=ios \
  --org=dev.bota --project-name=bota_public_cocoapods_consumer "$consumer" >/dev/null

if [[ -n "$archive" ]]; then
  # The release job first binds these preserved inputs to the tag's candidate inventory.
  # Copy before verification/extraction so this consumer uses one immutable local input.
  cp "$archive" "$temporary/plugin.tar.gz"
  cp "$inventory" "$temporary/plugin-inventory.json"
  node "$ROOT/tools/flutter/verify-publication.mjs" verify-candidate \
    --archive "$temporary/plugin.tar.gz" --inventory "$temporary/plugin-inventory.json"
  node -e '
    const inventory = require(process.argv[1]);
    if (inventory.packageName !== "bota_app_sdk" || inventory.version !== process.argv[2]) {
      throw new Error("Flutter candidate does not match the selected package/version");
    }
  ' "$temporary/plugin-inventory.json" "$VERSION"
  mkdir "$temporary/plugin"
  tar -xzf "$temporary/plugin.tar.gz" -C "$temporary/plugin"
  "$ROOT/tools/flutter/run-flutter.sh" pub add --directory="$consumer" \
    "bota_app_sdk@{path: $temporary/plugin}" >/dev/null
  flutter_source="path"
else
  "$ROOT/tools/flutter/run-flutter.sh" pub add --directory="$consumer" "bota_app_sdk:$VERSION" >/dev/null
  flutter_source="hosted"
fi

ruby -ryaml - "$consumer/pubspec.lock" "$VERSION" "$flutter_source" <<'RUBY'
lock = YAML.safe_load(File.read(ARGV.fetch(0)))
plugin = lock.fetch('packages').fetch('bota_app_sdk')
abort 'Flutter dependency version/source mismatch' unless plugin.fetch('version') == ARGV.fetch(1) && plugin.fetch('source') == ARGV.fetch(2)
RUBY
ruby -0pi -e \
  'abort "Flutter configuration marker is missing" unless sub!(/^flutter:\n/, "flutter:\n  config:\n    enable-swift-package-manager: false\n")' \
  "$consumer/pubspec.yaml"
perl -0pi -e 's/IPHONEOS_DEPLOYMENT_TARGET = [0-9.]+;/IPHONEOS_DEPLOYMENT_TARGET = 15.0;/g' \
  "$consumer/ios/Runner.xcodeproj/project.pbxproj"

cat >"$consumer/ios/Podfile" <<EOF
source '$SPECS_REPOSITORY'
source 'https://cdn.cocoapods.org/'
platform :ios, '15.0'
ENV['COCOAPODS_DISABLE_STATS'] = 'true'

project 'Runner', {
  'Debug' => :debug,
  'Profile' => :release,
  'Release' => :release,
}

def flutter_root
  settings = File.expand_path(File.join('..', 'Flutter', 'Generated.xcconfig'), __FILE__)
  File.foreach(settings) do |line|
    match = line.match(/FLUTTER_ROOT=(.*)/)
    return match[1].strip if match
  end
  raise "FLUTTER_ROOT is missing from #{settings}"
end

require File.expand_path(File.join('packages', 'flutter_tools', 'bin', 'podhelper'), flutter_root)
flutter_ios_podfile_setup

target 'Runner' do
  use_frameworks!
  pod '${APPLE_PACKAGE}', '$VERSION', :source => '$SPECS_REPOSITORY'
  flutter_install_all_ios_pods File.dirname(File.realpath(__FILE__))
end

post_install do |installer|
  installer.pods_project.targets.each do |target|
    flutter_additional_ios_build_settings(target)
  end
end
EOF
cat >"$consumer/lib/main.dart" <<'DART'
import 'package:flutter/material.dart';
import 'package:bota_app_sdk/bota_app_sdk.dart';

void main() {
  // Compile the public Dart entry without configuring Bluetooth or starting SDK work.
  final Type sdkClient = BotaDeviceClient;
  runApp(MaterialApp(home: Scaffold(body: Text('Bota CocoaPods: $sdkClient'))));
}
DART

(
  cd "$consumer"
  "$ROOT/tools/flutter/run-flutter.sh" pub get --enforce-lockfile
  cd ios
  "${pod_command[@]}" install --repo-update
)
node "$ROOT/tools/flutter/verify-cocoapods-consumer.mjs" \
  --version "$VERSION" \
  --lock "$consumer/ios/Podfile.lock" \
  --repos-root "$CP_REPOS_DIR" \
  --sandbox "$consumer/ios/Pods"
(
  cd "$consumer"
  "$ROOT/tools/flutter/run-flutter.sh" build ios --release --no-codesign --target lib/main.dart
)
test -d "$consumer/build/ios/iphoneos/Runner.app"
node "$ROOT/tools/flutter/verify-cocoapods-consumer.mjs" \
  --version "$VERSION" \
  --lock "$consumer/ios/Podfile.lock" \
  --repos-root "$CP_REPOS_DIR" \
  --sandbox "$consumer/ios/Pods"
echo "Flutter $VERSION and native ${APPLE_PACKAGE} $VERSION compiled through Bota Specs ($flutter_source Flutter candidate)"
