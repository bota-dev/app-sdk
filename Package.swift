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
            url: "https://github.com/bota-dev/app-sdk/releases/download/v2.0.0-beta.24/BotaDeviceSDKCore.xcframework.zip",
            checksum: "a1a6e700fdb676d22e15ef952199723d49199513189bd125f4acbaed299f6a35"
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
