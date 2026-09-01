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
            url: "https://github.com/bota-dev/app-sdk/releases/download/v1.1.0/BotaDeviceSDKCore.xcframework.zip",
            checksum: "fae2a04a83acb82c358144477f3e50014dc08a6a93764b97d215716cd9262014"
        ),
        .target(
            name: "BotaAppleSDK",
            dependencies: ["BotaDeviceSDKC"],
            path: "platforms/apple/Sources/BotaAppleSDK"
        ),
    ]
)
