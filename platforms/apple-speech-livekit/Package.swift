// swift-tools-version: 6.1
import PackageDescription

// Source preview only. Release coordinates and artifact inventory remain separate gates.
let package = Package(
    name: "BotaSpeechLiveKit",
    platforms: [.iOS(.v15), .macOS(.v13)],
    products: [.library(name: "BotaSpeechLiveKit", targets: ["BotaSpeechLiveKit"])],
    dependencies: [
        .package(path: "../apple"),
        .package(url: "https://github.com/livekit/client-sdk-swift.git", exact: "2.18.0"),
    ],
    targets: [
        .target(name: "BotaSpeechLiveKit", dependencies: [
            .product(name: "BotaAppSDK", package: "apple"),
            .product(name: "LiveKit", package: "client-sdk-swift"),
        ]),
        .testTarget(name: "BotaSpeechLiveKitTests", dependencies: ["BotaSpeechLiveKit"]),
    ],
    swiftLanguageModes: [.v6]
)
