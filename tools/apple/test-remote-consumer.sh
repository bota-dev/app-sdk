#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
VERSION=${1:-}

if ! printf '%s\n' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
    printf 'usage: %s VERSION\n' "$0" >&2
    exit 1
fi

APPLE_PACKAGE="$(node "$ROOT/tools/release/package-identities.mjs" apple "$VERSION")"

mkdir -p "$ROOT/target"
CONSUMER=$(mktemp -d "$ROOT/target/apple-remote-consumer.XXXXXX")
cleanup() { rm -rf "$CONSUMER"; }
trap cleanup EXIT HUP INT TERM
mkdir -p "$CONSUMER/Sources/AppleRemoteConsumer"

cat > "$CONSUMER/Package.swift" <<EOF
// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "AppleRemoteConsumer",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(
            url: "https://github.com/bota-dev/app-sdk.git",
            exact: "$VERSION"
        ),
    ],
    targets: [
        .executableTarget(
            name: "AppleRemoteConsumer",
            dependencies: [
                .product(name: "${APPLE_PACKAGE}", package: "app-sdk"),
            ]
        ),
    ]
)
EOF

cat > "$CONSUMER/Sources/AppleRemoteConsumer/main.swift" <<EOF
import ${APPLE_PACKAGE}

@main
enum AppleRemoteConsumer {
    static func main() {
        precondition(BotaAppleSDKVersion.current == "$VERSION")
        _ = BotaConfiguration()
        _ = BotaDeviceClient()
        print("Resolved ${APPLE_PACKAGE} $VERSION")
    }
}
EOF

swift build \
    --package-path "$CONSUMER" \
    --scratch-path "$ROOT/target/apple-remote-consumer-build" \
    --jobs 1 \
    -Xswiftc -disable-batch-mode \
    --product AppleRemoteConsumer

printf '%s %s public consumer compiled successfully\n' "$APPLE_PACKAGE" "$VERSION"
