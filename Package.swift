// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "BotaDeviceSDK",
    platforms: [
        .iOS(.v15),
        .macOS(.v13),
    ],
    products: [
        .library(name: "BotaDeviceSDK", targets: ["BotaDeviceSDK"]),
    ],
    targets: [
        .binaryTarget(
            name: "BotaDeviceSDKC",
            url: "https://github.com/bota-dev/app-sdk/releases/download/v1.0.0/BotaDeviceSDKCore.xcframework.zip",
            checksum: "d87e3894f0492e7256ff589b0062c5431b4a72804e053d0ee4707ceef18bb120"
        ),
        .target(
            name: "BotaDeviceSDK",
            dependencies: ["BotaDeviceSDKC"],
            path: "platforms/apple/Sources/BotaDeviceSDK"
        ),
    ]
)
