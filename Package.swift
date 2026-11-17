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
            checksum: "a5795433475e300fc0b450e5d1e40d6237860f99959deb888fe1d28b9d5aaa0a"
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
