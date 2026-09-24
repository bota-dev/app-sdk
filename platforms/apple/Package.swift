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
            path: "Artifacts/BotaDeviceSDKCore.xcframework"
        ),
        .target(
            name: "BotaAppSDK",
            dependencies: ["BotaDeviceSDKC"]
        ),
        .testTarget(
            name: "BotaAppSDKTests",
            dependencies: ["BotaAppSDK", "BotaDeviceSDKC"],
            resources: [
                .copy("Resources/EncryptedUploadV2Vectors"),
                .copy("Resources/ProtocolFixtures"),
                .copy("Resources/WorkflowFixtures"),
            ]
        ),
        .testTarget(
            name: "BotaAppSDKPhysicalTests",
            dependencies: ["BotaAppSDK"]
        ),
    ]
)
