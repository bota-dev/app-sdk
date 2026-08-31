// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "BotaDeviceSDKAppleAdapter",
    platforms: [
        .iOS(.v15),
        .macOS(.v13),
    ],
    products: [
        .library(name: "BotaDeviceSDKAppleAdapter", targets: ["BotaDeviceSDKAppleAdapter"]),
    ],
    dependencies: [
        .package(name: "BotaAppSDK", path: "../.."),
    ],
    targets: [
        .target(
            name: "BotaDeviceSDKAppleAdapter",
            dependencies: [
                .product(name: "BotaAppleSDK", package: "BotaAppSDK"),
            ],
            path: "ios",
            exclude: ["BotaDeviceSDK.mm"]
        ),
        .testTarget(
            name: "BotaDeviceSDKAppleLifecycleTests",
            dependencies: ["BotaDeviceSDKAppleAdapter"]
        ),
    ]
)
