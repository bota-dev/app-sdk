// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "BotaWatchControl",
  platforms: [.watchOS(.v11), .macOS(.v13), .iOS(.v15)],
  products: [.library(name: "BotaWatchControl", targets: ["BotaWatchControl"])],
  targets: [
    .target(name: "BotaWatchControl"),
    .executableTarget(
      name: "WatchControlChecks", dependencies: ["BotaWatchControl"],
      path: "Tests/WatchControlChecks"),
  ]
)
