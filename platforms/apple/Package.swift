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
            path: "Artifacts/BotaDeviceSDKCore.xcframework"
        ),
        .target(
            name: "BotaDeviceSDK",
            dependencies: ["BotaDeviceSDKC"]
        ),
        .testTarget(
            name: "BotaDeviceSDKTests",
            dependencies: ["BotaDeviceSDK", "BotaDeviceSDKC"],
            resources: [
                .copy("Resources/ProtocolFixtures"),
                .copy("Resources/WorkflowFixtures"),
            ]
        ),
        .testTarget(
            name: "BotaDeviceSDKPhysicalTests",
            dependencies: ["BotaDeviceSDK"]
        ),
    ]
)
