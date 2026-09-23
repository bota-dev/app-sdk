// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "bota_flutter_sdk",
  platforms: [.iOS(.v15)],
  products: [
    .library(name: "bota-flutter-sdk", targets: ["bota_flutter_sdk"]),
  ],
  dependencies: [
    .package(name: "FlutterFramework", path: "../FlutterFramework"),
    .package(
      url: "https://github.com/bota-dev/app-sdk.git",
      exact: "1.2.0-beta.9"
    ),
  ],
  targets: [
    .target(
      name: "bota_flutter_sdk",
      dependencies: [
        .product(name: "FlutterFramework", package: "FlutterFramework"),
        .product(name: "BotaAppleSDK", package: "app-sdk"),
      ],
      swiftSettings: [
        .unsafeFlags(["-strict-concurrency=complete"]),
      ]
    ),
  ],
  swiftLanguageModes: [.v5]
)
