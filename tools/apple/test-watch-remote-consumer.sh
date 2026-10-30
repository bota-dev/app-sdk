#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
version="${1:-}"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "usage: $0 VERSION" >&2
  exit 1
fi
mkdir -p "$repo_root/target"
consumer="$(mktemp -d "$repo_root/target/watch-remote-consumer.XXXXXX")"
trap 'rm -rf "$consumer"' EXIT
cp -R "$repo_root/tests/consumers/watch-control/Sources" "$consumer/Sources"
cat > "$consumer/Package.swift" <<EOF
// swift-tools-version: 6.0
import PackageDescription
let package = Package(
  name: "WatchRemoteConsumer",
  platforms: [.watchOS(.v11), .macOS(.v13)],
  products: [.library(name: "WatchControlIntegration", targets: ["WatchControlIntegration"])],
  dependencies: [.package(url: "https://github.com/bota-dev/app-sdk.git", exact: "$version")],
  targets: [
    .target(name: "WatchControlIntegration", dependencies: [
      .product(name: "BotaWatchControl", package: "app-sdk")
    ]),
    .executableTarget(name: "WatchControlConsumer", dependencies: ["WatchControlIntegration"])
  ]
)
EOF
swift run --package-path "$consumer" --scratch-path "$consumer/mac-build" \
  -Xswiftc -warnings-as-errors WatchControlConsumer
for destination in 'generic/platform=watchOS' 'generic/platform=watchOS Simulator'; do
  (
    cd "$consumer"
    xcodebuild -scheme WatchControlIntegration -destination "$destination" \
      -derivedDataPath "$consumer/$(echo "$destination" | tr ' /=' '-')" \
      CODE_SIGNING_ALLOWED=NO build
  )
done
