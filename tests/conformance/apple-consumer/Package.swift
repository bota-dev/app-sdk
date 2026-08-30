// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "AppleConsumer",
    platforms: [
        .macOS(.v13),
    ],
    dependencies: [
        .package(path: "../../../platforms/apple"),
    ],
    targets: [
        .executableTarget(
            name: "AppleConsumer",
            dependencies: [
                .product(name: "BotaAppleSDK", package: "apple"),
            ]
        ),
    ]
)
