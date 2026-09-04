#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VERSION="${1:-}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || [[ $# -ne 1 ]]; then
  echo "usage: $0 <version>" >&2
  exit 2
fi
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "The public CocoaPods consumer gate requires macOS" >&2
  exit 1
fi

unset BOTA_APPLE_SDK_PACKAGE_PATH
required_cocoapods_version="1.16.2"
homebrew_pod=""
if [[ -x /opt/homebrew/opt/ruby/bin/ruby ]]; then
  export PATH="/opt/homebrew/opt/ruby/bin:$PATH"
  homebrew_pod="$(/opt/homebrew/opt/ruby/bin/ruby -e 'print Gem.bindir')/pod"
fi
pod_binary=""
for candidate in "${POD_BINARY:-}" "$homebrew_pod" "$(command -v pod || true)"; do
  if [[ -n "$candidate" && -x "$candidate" ]] \
    && [[ "$($candidate --version 2>/dev/null)" == "$required_cocoapods_version" ]]; then
    pod_binary="$candidate"
    break
  fi
done
if [[ -z "$pod_binary" ]]; then
  echo "CocoaPods $required_cocoapods_version is required" >&2
  exit 1
fi

temporary="$(mktemp -d "${BOTA_TEST_TMPDIR:-/tmp}/bota-public-pod.XXXXXX")"
cleanup() { rm -rf "$temporary"; }
trap cleanup EXIT
mkdir -p "$temporary/PublicPodConsumer"

cat >"$temporary/PublicPodConsumer/main.swift" <<'SWIFT'
import BotaAppleSDK
import Foundation

precondition(!BotaAppleSDKVersion.current.isEmpty)
SWIFT

ruby -rxcodeproj - "$temporary" <<'RUBY'
root = ARGV.fetch(0)
project = Xcodeproj::Project.new(File.join(root, "PublicPodConsumer.xcodeproj"))
target = project.new_target(:application, "PublicPodConsumer", :ios, "15.0")
source = project.main_group.new_file("PublicPodConsumer/main.swift")
target.source_build_phase.add_file_reference(source)
target.build_configurations.each do |configuration|
  configuration.build_settings["CODE_SIGNING_ALLOWED"] = "NO"
  configuration.build_settings["GENERATE_INFOPLIST_FILE"] = "YES"
  configuration.build_settings["PRODUCT_BUNDLE_IDENTIFIER"] = "dev.bota.public-pod-consumer"
  configuration.build_settings["SWIFT_VERSION"] = "6.0"
end
project.save
scheme = Xcodeproj::XCScheme.new
scheme.add_build_target(target)
scheme.save_as(project.path, target.name, true)
RUBY

cat >"$temporary/Podfile" <<EOF
source 'https://cdn.cocoapods.org/'
platform :ios, '15.0'
use_frameworks!

target 'PublicPodConsumer' do
  pod 'BotaAppleSDK', '$VERSION'
end
EOF

(
  cd "$temporary"
  "$pod_binary" install --repo-update
)
if rg -q '^EXTERNAL SOURCES:' "$temporary/Podfile.lock"; then
  echo "Public CocoaPods consumer resolved a local source" >&2
  exit 1
fi
rg -q "BotaAppleSDK \($VERSION\)" "$temporary/Podfile.lock"
xcodebuild \
  -workspace "$temporary/PublicPodConsumer.xcworkspace" \
  -scheme PublicPodConsumer \
  -configuration Release \
  -sdk iphoneos \
  -derivedDataPath "$temporary/DerivedData" \
  CODE_SIGNING_ALLOWED=NO \
  build
echo "Public CocoaPods consumer resolved BotaAppleSDK $VERSION without overrides"
