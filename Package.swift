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
            url: "https://github.com/bota-dev/app-sdk/releases/download/v1.2.0-beta.5/BotaDeviceSDKCore.xcframework.zip",
            checksum: "f5f68e09c86342ba72dd601c45e36e31903fe975fd73445551f3166997fc782c"
        ),
        .target(
            name: "BotaAppleSDK",
            dependencies: ["BotaDeviceSDKC"],
            path: "platforms/apple/Sources/BotaAppleSDK"
        ),
    ]
)
