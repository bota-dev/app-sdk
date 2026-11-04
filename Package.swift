// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "BotaAppSDK",
    platforms: [
        .iOS(.v15),
        .macOS(.v13),
        .watchOS(.v11),
    ],
    products: [
        .library(name: "BotaAppSDK", targets: ["BotaAppSDK"]),
        .library(name: "BotaWatchControl", targets: ["BotaWatchControl"]),
    ],
    targets: [
        .binaryTarget(
            name: "BotaDeviceSDKC",
            url: "https://github.com/bota-dev/app-sdk/releases/download/v2.0.0-beta.23/BotaDeviceSDKCore.xcframework.zip",
            checksum: "7492a334fc2d645aab313d8ac434f289c8c89757503d4d8ffa10d24fe7d9b218"
        ),
        .target(
            name: "BotaAppSDK",
            dependencies: ["BotaDeviceSDKC"],
            path: "platforms/apple/Sources/BotaAppSDK"
        ),
        .target(
            name: "BotaWatchControl",
            path: "platforms/watch/Sources/BotaWatchControl"
        ),
    ]
)
