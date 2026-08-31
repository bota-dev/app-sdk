#!/usr/bin/env bash

set -euo pipefail

workspace_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
package_root="$workspace_root/frameworks/react-native"
test_tmp_root="$(cd "${BOTA_TEST_TMPDIR:-/tmp}" && pwd -P)"
consumer_root="$(mktemp -d "$test_tmp_root/bota-rn-apple-consumer.XXXXXX")"
minimum_cocoapods_version="1.13.0"
source_mode="${1:-local}"

if [[ "$source_mode" != "local" && "$source_mode" != "remote" ]]; then
  echo "source mode must be local or remote" >&2
  exit 1
fi

cleanup() {
  find "$consumer_root" -depth -delete
}
trap cleanup EXIT

pod_command=()
if [[ -n "${BUNDLE_GEMFILE:-}" ]]; then
  pod_command=(bundle exec pod)
elif [[ -n "${POD_BINARY:-}" ]]; then
  pod_command=("$POD_BINARY")
else
  for candidate in "$(command -v pod || true)" /opt/homebrew/bin/pod; do
    if [[ -x "$candidate" ]] && ruby -e \
      'exit(Gem::Version.new(ARGV[0]) >= Gem::Version.new(ARGV[1]) ? 0 : 1)' \
      "$($candidate --version)" "$minimum_cocoapods_version"; then
      pod_command=("$candidate")
      break
    fi
  done
fi

if [[ "${#pod_command[@]}" -eq 0 ]]; then
  echo "CocoaPods $minimum_cocoapods_version or newer is required" >&2
  exit 1
fi

if ! ruby -e \
  'exit(Gem::Version.new(ARGV[0]) >= Gem::Version.new(ARGV[1]) ? 0 : 1)' \
  "$("${pod_command[@]}" --version)" "$minimum_cocoapods_version"; then
  echo "CocoaPods $minimum_cocoapods_version or newer is required" >&2
  exit 1
fi

ruby "$workspace_root/tools/react-native/create-apple-adapter-consumer.rb" \
  "$consumer_root" \
  "$workspace_root" \
  "$package_root" \
  "$source_mode"

"${pod_command[@]}" install --project-directory="$consumer_root"

if [[ "$source_mode" == "remote" ]]; then
  xcodebuild \
    -workspace "$consumer_root/AdapterConsumer.xcworkspace" \
    -scheme AdapterConsumer \
    -derivedDataPath "$consumer_root/DerivedData" \
    -resolvePackageDependencies

  resolved_file="$(find "$consumer_root" -name Package.resolved -print -quit)"
  if [[ -z "$resolved_file" ]]; then
    echo "remote Apple package resolution did not write Package.resolved" >&2
    exit 1
  fi

  ruby -rjson -e '
    package = JSON.parse(File.read(ARGV.fetch(0)))
    resolved = JSON.parse(File.read(ARGV.fetch(1)))
    expected_url = package.fetch("bota").fetch("apple").fetch("packageUrl")
    expected_version = package.fetch("version")
    pin = resolved.fetch("pins").find { |candidate| candidate["location"] == expected_url }
    abort "BotaAppleSDK package URL was not resolved" if pin.nil?
    actual_version = pin.fetch("state").fetch("version")
    abort "expected #{expected_version}, resolved #{actual_version}" unless actual_version == expected_version
  ' "$package_root/package.json" "$resolved_file"

  exit 0
fi

xcodebuild \
  -quiet \
  -workspace "$consumer_root/AdapterConsumer.xcworkspace" \
  -scheme AdapterConsumer \
  -destination "generic/platform=iOS Simulator" \
  -derivedDataPath "$consumer_root/DerivedData" \
  CODE_SIGNING_ALLOWED=NO \
  build
