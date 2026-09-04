#!/usr/bin/env bash

set -euo pipefail

workspace_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
plugin_root="$workspace_root/frameworks/flutter/bota_flutter_sdk"
test_tmp_root="$(cd "${BOTA_TEST_TMPDIR:-/tmp}" && pwd -P)"
consumer_root="$(mktemp -d "$test_tmp_root/bota-flutter-apple-tests.XXXXXX")"
swift_language_mode="${BOTA_FLUTTER_SWIFT_LANGUAGE_MODE:-v5}"

case "$swift_language_mode" in
  v5|v6) ;;
  *)
    printf 'Unsupported BOTA_FLUTTER_SWIFT_LANGUAGE_MODE: %s\n' "$swift_language_mode" >&2
    exit 2
    ;;
esac

cleanup() {
  find "$consumer_root" -depth -delete
}
trap cleanup EXIT

"$workspace_root/tools/apple/build-xcframework.sh"

mkdir -p \
  "$consumer_root/Sources/BotaFlutterSdk" \
  "$consumer_root/Sources/FlutterMacOS" \
  "$consumer_root/Tests/BotaFlutterSdkTests"

find "$plugin_root/ios/Classes" -maxdepth 1 -name '*.swift' \
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
            dependencies: ["FlutterMacOS", .product(name: "BotaAppleSDK", package: "apple")]
        ),
        .testTarget(
            name: "BotaFlutterSdkTests",
            dependencies: ["BotaFlutterSdk", .product(name: "BotaAppleSDK", package: "apple")]
        ),
    ],
    swiftLanguageModes: [.$swift_language_mode]
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
