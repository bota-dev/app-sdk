#!/usr/bin/env bash

set -euo pipefail

workspace_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
plugin_root="$workspace_root/frameworks/flutter/bota_flutter_sdk"
required_cocoapods_version="1.16.2"
homebrew_pod=""
if [[ -x /opt/homebrew/opt/ruby/bin/ruby ]]; then
  export PATH="/opt/homebrew/opt/ruby/bin:$PATH"
  homebrew_pod="$(/opt/homebrew/opt/ruby/bin/ruby -e 'print Gem.bindir')/pod"
fi
test_tmp_root="$(cd "${BOTA_TEST_TMPDIR:-/tmp}" && pwd -P)"
consumer_root="$(mktemp -d "$test_tmp_root/bota-flutter-apple-tests.XXXXXX")"
cleanup() {
  find "$consumer_root" -depth -delete
}
trap cleanup EXIT

pod_binary=""
for candidate in \
  "${POD_BINARY:-}" \
  "$homebrew_pod" \
  "$(command -v pod || true)"
do
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
export PATH="$(dirname "$pod_binary"):$PATH"

"$workspace_root/tools/apple/build-xcframework.sh"

mkdir -p \
  "$consumer_root/Sources/BotaFlutterSdk" \
  "$consumer_root/Sources/FlutterMacOS" \
  "$consumer_root/Tests/BotaFlutterSdkTests"

find "$plugin_root/ios/bota_flutter_sdk/Sources/bota_flutter_sdk" -maxdepth 1 -name '*.swift' \
  -exec cp '{}' "$consumer_root/Sources/BotaFlutterSdk/" ';'
find "$plugin_root/ios/Tests" -maxdepth 1 -name '*.swift' \
  -exec cp '{}' "$consumer_root/Tests/BotaFlutterSdkTests/" ';'

cat >"$consumer_root/Package.swift" <<EOF
// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "BotaFlutterAppleAdapterTests",
    platforms: [.macOS(.v13)],
    products: [.library(name: "BotaFlutterSdk", targets: ["BotaFlutterSdk"])],
    dependencies: [.package(path: "$workspace_root/platforms/apple")],
    targets: [
        .target(name: "FlutterMacOS"),
        .target(
            name: "BotaFlutterSdk",
            dependencies: ["FlutterMacOS", .product(name: "BotaAppleSDK", package: "apple")],
            swiftSettings: [
                .unsafeFlags(["-strict-concurrency=complete"]),
            ]
        ),
        .testTarget(
            name: "BotaFlutterSdkTests",
            dependencies: ["BotaFlutterSdk", .product(name: "BotaAppleSDK", package: "apple")],
            swiftSettings: [
                .unsafeFlags(["-strict-concurrency=complete", "-warnings-as-errors"]),
            ]
        ),
    ],
    swiftLanguageModes: [.v5]
)
EOF

cat >"$consumer_root/Sources/FlutterMacOS/FlutterMacOS.swift" <<'EOF'
import Foundation

public protocol FlutterBinaryMessenger: AnyObject {}

open class FlutterStandardReader: NSObject {
    public init(data: Data) {}
    open func readValue(ofType type: UInt8) -> Any? { nil }
    public func readValue() -> Any? { nil }
}

open class FlutterStandardWriter: NSObject {
    public init(data: NSMutableData) {}
    open func writeValue(_ value: Any) {}
    public func writeByte(_ value: UInt8) {}
}

open class FlutterStandardReaderWriter: NSObject {
    public override init() {}
    open func reader(with data: Data) -> FlutterStandardReader {
        FlutterStandardReader(data: data)
    }
    open func writer(with data: NSMutableData) -> FlutterStandardWriter {
        FlutterStandardWriter(data: data)
    }
}

open class FlutterStandardMessageCodec: NSObject, @unchecked Sendable {
    public init(readerWriter: FlutterStandardReaderWriter) {}
}

public final class FlutterStandardTypedData: NSObject, @unchecked Sendable {
    public let data: Data
    public init(bytes: Data) { data = bytes }
}

public final class FlutterError: NSObject, Error, @unchecked Sendable {
    public let code: String
    public let message: String?
    public let details: Any?
    public init(code: String, message: String?, details: Any?) {
        self.code = code
        self.message = message
        self.details = details
    }
}

public final class FlutterBasicMessageChannel: NSObject, @unchecked Sendable {
    public init(
        name: String,
        binaryMessenger: FlutterBinaryMessenger,
        codec: FlutterStandardMessageCodec
    ) {}
    public func setMessageHandler(_ handler: ((Any?, @escaping (Any?) -> Void) -> Void)?) {}
    public func sendMessage(_ message: Any?, reply: ((Any?) -> Void)? = nil) {
        reply?([nil])
    }
}

public protocol FlutterPlugin: AnyObject {
    static func register(with registrar: FlutterPluginRegistrar)
}

public protocol FlutterPluginRegistrar: AnyObject {
    var messenger: FlutterBinaryMessenger { get }
    func publish(_ value: NSObject)
}
EOF

swift test \
  --package-path "$consumer_root" \
  --scratch-path "$workspace_root/target/flutter-apple-swiftpm"

create_flutter_consumer() {
  local destination="$1"
  local dependency_root="${2:-$plugin_root}"
  "$workspace_root/tools/flutter/run-flutter.sh" create \
    --platforms=ios \
    --org=dev.bota \
    --project-name=bota_flutter_consumer \
    "$destination" >/dev/null
  "$workspace_root/tools/flutter/run-flutter.sh" pub add \
    --directory="$destination" \
    "bota_flutter_sdk@{path: $dependency_root}" >/dev/null
}

cocoapods_consumer="$consumer_root/cocoapods-consumer"
create_flutter_consumer "$cocoapods_consumer"
ruby -0pi -e \
  'sub(/^flutter:\n/, "flutter:\n  config:\n    enable-swift-package-manager: false\n")' \
  "$cocoapods_consumer/pubspec.yaml"
cat >"$cocoapods_consumer/ios/Podfile" <<EOF
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
  pod 'BotaAppleSDK', :path => '$workspace_root/platforms/apple'
  flutter_install_all_ios_pods File.dirname(File.realpath(__FILE__))
end

post_install do |installer|
  installer.pods_project.targets.each do |target|
    flutter_additional_ios_build_settings(target)
  end
end
EOF
(
  cd "$cocoapods_consumer"
  "$workspace_root/tools/flutter/run-flutter.sh" build ios \
    --debug --simulator --no-codesign
)

swiftpm_consumer="$consumer_root/swiftpm-consumer"
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
  APPLE_PACKAGE="$workspace_root/platforms/apple" \
  SDK_VERSION="$(sed -n 's/^version = "\([^"]*\)"$/\1/p' "$workspace_root/sdk-version.toml")" \
  node -e '
    const fs = require("node:fs");
    const path = process.env.SWIFT_MANIFEST;
    const source = fs.readFileSync(path, "utf8");
    const marker = `.package(
      url: "https://github.com/bota-dev/app-sdk.git",
      exact: "${process.env.SDK_VERSION}"
    ),`;
    const replacement = `.package(name: "BotaAppleSDK", path: ${JSON.stringify(process.env.APPLE_PACKAGE)}),`;
    if (!source.includes(marker)) throw new Error("public BotaAppleSDK dependency marker changed");
    fs.writeFileSync(path, source.replace(marker, replacement));
  '
create_flutter_consumer "$swiftpm_consumer" "$local_plugin_root"
(
  cd "$swiftpm_consumer"
  "$workspace_root/tools/flutter/run-flutter.sh" build ios \
    --debug --simulator --no-codesign
)
