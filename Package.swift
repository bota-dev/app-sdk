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
            url: "https://github.com/bota-dev/app-sdk/releases/download/v1.2.0-beta.4/BotaDeviceSDKCore.xcframework.zip",
            checksum: "e8396d75136000259ea5057f3cf9b2643b7444f6dffaca11f7d642602b47b7a6"
        ),
        .target(
            name: "BotaAppleSDK",
            dependencies: ["BotaDeviceSDKC"],
            path: "platforms/apple/Sources/BotaAppleSDK"
        ),
    ]
)
