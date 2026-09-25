// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "bota_app_sdk",
  platforms: [.iOS(.v15)],
  products: [
    .library(name: "bota-app-sdk", targets: ["bota_app_sdk"]),
  ],
  dependencies: [
    .package(name: "FlutterFramework", path: "../FlutterFramework"),
    .package(
      url: "https://github.com/bota-dev/app-sdk.git",
      exact: "2.0.0-beta.2"
    ),
  ],
  targets: [
    .target(
      name: "bota_app_sdk",
      dependencies: [
        .product(name: "FlutterFramework", package: "FlutterFramework"),
        .product(name: "BotaAppSDK", package: "app-sdk"),
      ],
      swiftSettings: [
        .unsafeFlags(["-strict-concurrency=complete"]),
      ]
    ),
  ],
  swiftLanguageModes: [.v5]
)
