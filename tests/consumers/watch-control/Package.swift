// swift-tools-version: 6.0

import Foundation
import PackageDescription

let sdkPath = ProcessInfo.processInfo.environment["BOTA_WATCH_SDK_PATH"] ?? "../../.."

let package = Package(
  name: "WatchControlConsumer",
  platforms: [.watchOS(.v11), .macOS(.v13), .iOS(.v15)],
  products: [.library(name: "WatchControlIntegration", targets: ["WatchControlIntegration"])],
  dependencies: [.package(name: "BotaAppSDK", path: sdkPath)],
  targets: [
    .target(
      name: "WatchControlIntegration",
      dependencies: [
        .product(name: "BotaWatchControl", package: "BotaAppSDK")
      ]),
    .executableTarget(name: "WatchControlConsumer", dependencies: ["WatchControlIntegration"]),
  ]
)
