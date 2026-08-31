# Releasing The Bota App SDK

The first public platform artifact is the Apple `BotaAppleSDK` Swift package
for iOS 15+ and macOS 13+. Consumers add
`https://github.com/bota-dev/app-sdk.git` in Xcode. The root `Package.swift`
compiles the Swift facade source and downloads a checksummed
`BotaDeviceSDKCore.xcframework.zip` from the matching GitHub Release.

The nested `platforms/apple/Package.swift` remains the local-development
package. It points at the generated XCFramework on disk so facade tests do not
depend on a published release.

All artifacts use the exact version in `sdk-version.toml`. Release tags use
`vVERSION`; the tag, package metadata, public Swift version, compatibility
matrix, release example, GitHub Release URL, and XCFramework checksum must
agree. The Apple workflow does not publish the Rust core or FFI crates to
crates.io.

## Repository Setup

Create a GitHub environment named `release` for `bota-dev/app-sdk`:

1. Require a reviewer before deployment.
2. Restrict deployment branches and tags to protected release tags.
3. Do not add a crates.io token; Apple publication uses the repository's
   short-lived `GITHUB_TOKEN` with job-scoped `contents: write` permission.

The environment approval is the human boundary for release authorization and
external hardware acceptance. Automated tests never claim a physical-device
result. Keep supervised device evidence separate and follow
[`docs/testing/apple-physical-device.md`](testing/apple-physical-device.md) when
new hardware or firmware requires another lab run.

## Prepare A Version

Start from a clean `main` branch. Update every synchronized version authority
and commit that version bump before calculating the Apple checksum.

Generate the deterministic archive and write the matching root Swift package:

```bash
tools/apple/package-release.sh --write-package-manifest
swift package dump-package
git diff -- Package.swift
```

The preparation mode still requires a clean tree at startup. It builds the
archive first, computes its SwiftPM checksum, and changes only `Package.swift`.
Review and commit that manifest. Then rerun the normal check-only mode from the
new clean commit:

```bash
tools/apple/package-release.sh
```

Normal mode fails if rebuilding the XCFramework produces a checksum different
from the committed root package. Never hand-edit the release URL or checksum.

## Local Release Gate

Use Node.js 22 or newer and the Rust toolchain pinned by the repository:

```bash
npm ci
npm run check
npm run test:tooling
npm run test:release
npm run sync:apple-fixtures
npm run test:workflows -- --sdk-path ../react-native-sdk
cargo xtask release verify-tag "v$(sed -n 's/^version = "\([^"]*\)"$/\1/p' sdk-version.toml)"
cargo xtask protocol generate --check
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace
tools/ffi-smoke/run-native-c-smoke.sh
tools/ffi-smoke/run-native-swift-smoke.sh
tools/apple/test-package.sh
tools/apple/test-consumer.sh
tools/apple/package-release.sh
cargo deny check
```

`tools/apple/package-release.sh` writes the release payload to
`target/apple-release/`:

- `BotaDeviceSDKCore.xcframework.zip`
- `BotaDeviceSDKCore.xcframework.zip.sha256`
- `BotaDeviceSDKCore.xcframework.swiftpm-checksum`
- `BotaAppleSDK.spdx.json`
- `LICENSE`
- `release-manifest.json`

Future Apple packaging emits release manifest version 2 with
`sdkFamily: "bota-app-sdk"` and artifact fields `platform: "apple"` and
`packageIdentifier: "BotaAppleSDK"`. The public JSON Schema and Rust validator
require every version 2 platform/package identifier to be one exact pair from
the public package matrix; independently valid platform and package values
cannot be mixed.

The public `v1.0.0` manifest is an immutable version 1 document. Historical
evidence uses `validate_manifest_format_and_semantics`, which validates its own
SDK/artifact version consistency, checksums, firmware range, capabilities, and
v1/v2 rules without consulting the current checkout version. Normal
`validate_manifest` calls and `cargo xtask release validate` additionally
require `sdkVersion` to equal the current `sdk-version.toml`; release candidate
validation must always use that strict path.

The packaging log includes SHA-256 digests for every normalized XCFramework
input and for the final archive. Use those values to identify toolchain-specific
output before changing the checksum pinned in `Package.swift`.
Rust compilation remaps the checkout and Cargo registry paths, and packaging
fails if either original machine-specific prefix remains in a static library.

The XCFramework contains arm64 iOS, arm64/x86_64 iOS Simulator, and
arm64/x86_64 macOS slices.

## Publish

After the release commit is on `main`, create and push the exact annotated tag:

```bash
VERSION=$(sed -n 's/^version = "\([^"]*\)"$/\1/p' sdk-version.toml)
git tag -a "v$VERSION" -m "Bota App SDK $VERSION"
git push origin "v$VERSION"
```

The tag workflow:

The `verify` and `apple` jobs use independent clean checkouts. Each job must
install its own Node.js dependencies before running repository tooling.

1. Verifies synchronized metadata and that the tagged commit belongs to
   `origin/main`.
2. Runs the Rust, tooling, ABI, license, Apple package, and local-consumer gates.
3. Rebuilds the deterministic XCFramework and rejects root-package checksum
   drift.
4. Waits for approval in the protected `release` environment.
5. Creates the GitHub Release and uploads every Apple release file.
6. Creates an unrelated macOS package that resolves the public Git tag and runs
   while importing only `BotaAppleSDK`. The smoke uses one non-batched Swift
   compiler job so it fits on the hosted macOS runner.

Do not move or recreate a published tag. If a released artifact or manifest is
wrong, fix the source and publish a new patch version with a new checksum.

## Consumer Requirements

iOS applications must include `NSBluetoothAlwaysUsageDescription`. Sandboxed
macOS applications must enable **App Sandbox > Hardware > Bluetooth**, which
sets `com.apple.security.device.bluetooth`; macOS applications should also
provide the Bluetooth usage description displayed to users.

The package contains no Bota backend API client. Host applications remain
responsible for backend grants, device tokens, and presigned upload targets.
