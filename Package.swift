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
            url: "https://github.com/bota-dev/app-sdk/releases/download/v2.0.0-beta.10/BotaDeviceSDKCore.xcframework.zip",
            checksum: "169cc4bc27270447bd159c64b715a278e9877ab656172859e1bf6ecb58d1e425"
        ),
        .target(
            name: "BotaAppSDK",
            dependencies: ["BotaDeviceSDKC"],
            path: "platforms/apple/Sources/BotaAppSDK"
        ),
    ]
)
