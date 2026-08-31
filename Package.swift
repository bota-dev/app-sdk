// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "BotaAppleSDK",
    platforms: [
        .iOS(.v15),
        .macOS(.v13),
    ],
    products: [
        .library(name: "BotaAppleSDK", targets: ["BotaAppleSDK"]),
    ],
    targets: [
        .binaryTarget(
            name: "BotaDeviceSDKC",
            url: "https://github.com/bota-dev/app-sdk/releases/download/v1.0.2/BotaDeviceSDKCore.xcframework.zip",
            checksum: "3c7ba4376530590311792e9be1f090a3c7d8e9bbb75bf2d7c1571699ae169c09"
        ),
        .target(
            name: "BotaAppleSDK",
            dependencies: ["BotaDeviceSDKC"],
            path: "platforms/apple/Sources/BotaAppleSDK"
        ),
    ]
)
