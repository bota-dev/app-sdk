#!/usr/bin/env bash

set -euo pipefail

workspace_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
package_root="$workspace_root/frameworks/react-native"
test_tmp_root="$(cd "${BOTA_TEST_TMPDIR:-/tmp}" && pwd -P)"
consumer_root="$(mktemp -d "$test_tmp_root/bota-rn-apple-consumer.XXXXXX")"
minimum_cocoapods_version="1.13.0"

cleanup() {
  find "$consumer_root" -depth -delete
}
trap cleanup EXIT

pod_binary="${POD_BINARY:-}"
if [[ -z "$pod_binary" ]]; then
  for candidate in /opt/homebrew/bin/pod "$(command -v pod || true)"; do
    if [[ -x "$candidate" ]] && ruby -e \
      'exit(Gem::Version.new(ARGV[0]) >= Gem::Version.new(ARGV[1]) ? 0 : 1)' \
      "$($candidate --version)" "$minimum_cocoapods_version"; then
      pod_binary="$candidate"
      break
    fi
  done
fi

if [[ -z "$pod_binary" ]]; then
  echo "CocoaPods $minimum_cocoapods_version or newer is required" >&2
  exit 1
fi

ruby "$workspace_root/tools/react-native/create-apple-adapter-consumer.rb" \
  "$consumer_root" \
  "$workspace_root" \
  "$package_root"

"$pod_binary" install --project-directory="$consumer_root"

xcodebuild \
  -quiet \
  -workspace "$consumer_root/AdapterConsumer.xcworkspace" \
  -scheme AdapterConsumer \
  -destination "generic/platform=iOS Simulator" \
  -derivedDataPath "$consumer_root/DerivedData" \
  CODE_SIGNING_ALLOWED=NO \
  build
