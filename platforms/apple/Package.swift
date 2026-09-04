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
            path: "Artifacts/BotaDeviceSDKCore.xcframework"
        ),
        .target(
            name: "BotaAppleSDK",
            dependencies: ["BotaDeviceSDKC"]
        ),
        .testTarget(
            name: "BotaAppleSDKTests",
            dependencies: ["BotaAppleSDK", "BotaDeviceSDKC"],
            resources: [
                .copy("Resources/EncryptedUploadV2Vectors"),
                .copy("Resources/ProtocolFixtures"),
                .copy("Resources/WorkflowFixtures"),
            ]
        ),
        .testTarget(
            name: "BotaAppleSDKPhysicalTests",
            dependencies: ["BotaAppleSDK"]
        ),
    ]
)
