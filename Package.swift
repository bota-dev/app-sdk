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
            url: "https://github.com/bota-dev/app-sdk/releases/download/v1.2.0-beta.3/BotaDeviceSDKCore.xcframework.zip",
            checksum: "7b152f1bfc228e987eb179e233cf11362dec7d34a2dc758fbb75587612619bb4"
        ),
        .target(
            name: "BotaAppleSDK",
            dependencies: ["BotaDeviceSDKC"],
            path: "platforms/apple/Sources/BotaAppleSDK"
        ),
    ]
)
