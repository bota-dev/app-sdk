// swift-tools-version: 6.0

import Foundation
import PackageDescription

let appleSDKDependency: Package.Dependency
if let localPath = ProcessInfo.processInfo.environment["BOTA_APPLE_SDK_PACKAGE_PATH"],
  !localPath.isEmpty
{
  appleSDKDependency = .package(name: "BotaAppleSDK", path: localPath)
} else {
  appleSDKDependency = .package(
    url: "https://github.com/bota-dev/app-sdk.git",
    exact: "1.1.0"
  )
}

let package = Package(
  name: "bota_flutter_sdk",
  platforms: [.iOS(.v15)],
  products: [
    .library(name: "bota-flutter-sdk", targets: ["bota_flutter_sdk"]),
  ],
  dependencies: [
    .package(name: "FlutterFramework", path: "../FlutterFramework"),
    appleSDKDependency,
  ],
  targets: [
    .target(
      name: "bota_flutter_sdk",
      dependencies: [
        .product(name: "FlutterFramework", package: "FlutterFramework"),
        .product(name: "BotaAppleSDK", package: "BotaAppleSDK"),
      ],
      swiftSettings: [
        .unsafeFlags(["-strict-concurrency=complete"]),
      ]
    ),
  ],
  swiftLanguageModes: [.v5]
)
