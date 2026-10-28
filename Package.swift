// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "BotaAppSDK",
    platforms: [
        .iOS(.v15),
        .macOS(.v13),
    ],
    products: [
        .library(name: "BotaAppSDK", targets: ["BotaAppSDK"]),
    ],
    targets: [
        .binaryTarget(
            name: "BotaDeviceSDKC",
            url: "https://github.com/bota-dev/app-sdk/releases/download/v2.0.0-beta.23/BotaDeviceSDKCore.xcframework.zip",
            checksum: "75f04a7ff607ff8c5a76684792b0d7ca5bd782c19b5b4db0b43223db62919d48"
        ),
        .target(
            name: "BotaAppSDK",
            dependencies: ["BotaDeviceSDKC"],
            path: "platforms/apple/Sources/BotaAppSDK"
        ),
    ]
)
