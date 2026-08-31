# Releasing The Bota App SDK

The first public platform artifact is the Apple `BotaAppleSDK` Swift package
for iOS 15+ and macOS 13+. Consumers add
`https://github.com/bota-dev/app-sdk.git` in Xcode. The root `Package.swift`
compiles the Swift facade source and downloads a checksummed
`BotaDeviceSDKCore.xcframework.zip` from the matching GitHub Release.

The nested `platforms/apple/Package.swift` remains the local-development
package. It points at the generated XCFramework on disk so facade tests do not
depend on a published release.

The Android package uses Maven coordinate `dev.bota:bota-android-sdk`. The
synchronized `1.1.0` release publishes it through the protected Central Portal
workflow after deterministic packaging and native acceptance gates pass.

All artifacts use the exact version in `sdk-version.toml`. Release tags use
`vVERSION`; the tag, package metadata, public Swift version, compatibility
matrix, release example, GitHub Release URL, and XCFramework checksum must
agree. The Apple workflow does not publish the Rust core or FFI crates to
crates.io.

## Repository Setup

Create a GitHub environment named `release` for `bota-dev/app-sdk`:

1. Require a reviewer before deployment.
2. Restrict deployment branches and tags to protected release tags.
3. Add only `MAVEN_CENTRAL_USERNAME`, `MAVEN_CENTRAL_PASSWORD`,
   `SIGNING_IN_MEMORY_KEY`, and `SIGNING_IN_MEMORY_KEY_PASSWORD` as environment
   secrets. Do not add a crates.io token.

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

## Android Package Gate

Android release checks require JDK 17, Android SDK 36, NDK 28.2.13676358,
Node.js 22+, OpenSSL, and GnuPG. The check-only package command requires a clean
HEAD and writes only below `target/`:

```bash
tools/android/test-publication-graphs.sh
tools/android/package-release.sh --check
tools/android/verify-publication.sh target/android-release
cargo xtask release validate target/android-release/release-manifest.json
tools/android/install-release-repository.sh target/android-release target/android-m2
```

`package-release.sh --check` performs two clean builds and rejects any AAR or
per-ABI native-library digest drift. It invokes only the unsigned local Maven
publication, proves that no signing task or `.asc` file is present, and emits
the AAR, POM, Gradle module metadata, sources, Dokka Javadoc, four checksum
formats for every Maven primary, copied MIT license, SPDX 2.3 SBOM, and native
manifest version 2.

The published runtime dependency set is reviewed in
`protocol/baseline/android-maven-license-policy.json`. The package command and
license workflow require every Gradle module dependency to have an exact
coordinate, version, approved license, and reviewer in that policy, and require
the SPDX declaration to match. Unreviewed Maven dependencies fail closed.

The API compatibility lanes consume the reconstructed repository rather than
republishing from source:

```bash
tools/android/test-emulator-lane.sh --api 26
tools/android/test-emulator-lane.sh --api 35
```

The exact x86/x86_64 images run on Ubuntu release CI. Apple Silicon cannot run
the required API 26 x86 image, so a local arm64 emulator is not equivalent
release evidence.

The separate publication-graph test creates a password-protected ephemeral PGP
key in a mode-0700 temporary keyring. It proves that protected staging cannot
start without both in-memory key properties, then verifies all five detached
signatures. Gradle's exact 55-file raw repository is normalized to the 30-file
Central Portal tree. The generated ZIP contains only the path-sorted Portal
inventory, with mode 0644 and the fixed 1980 DOS timestamp; the inventory stays
beside the ZIP rather than inside it.

Protected automation sets only these environment-backed Gradle properties:

```text
ORG_GRADLE_PROJECT_signingInMemoryKey
ORG_GRADLE_PROJECT_signingInMemoryKeyPassword
ORG_GRADLE_PROJECT_signingInMemoryKeyId  # optional
```

The protected command must include the exact opt-in
`-PbotaProtectedSigning=true`. Any other value fails configuration. Never put
the key, password, or key ID in command arguments, tracked files, build scans,
logs, or uploaded artifacts.

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
3. Packages Android once, runs API 26 and API 35 consumers against that exact
   AAR, and uploads the unsigned Maven publication inputs.
4. Rebuilds the deterministic XCFramework and rejects root-package checksum
   drift.
5. Waits for approval in the protected `release` environment.
6. Creates the GitHub Release and uploads every public Apple release file. The
   Android payload remains an immutable workflow artifact downloaded inside the
   protected job; its flat filenames intentionally are not mixed with Apple's
   colliding `LICENSE` and manifest assets.
7. Creates an unrelated macOS package that resolves the public Git tag and
   compiles an executable importing only `BotaAppleSDK`. The smoke deliberately
   does not launch a Bluetooth-capable process on the headless runner. It uses
   one non-batched Swift compiler job to keep memory bounded.

Main CI must not resolve the candidate version through the public root package:
its binary URL is created by this workflow. React Native lifecycle tests use
`platforms/apple` and its locally built XCFramework; step 7 is the authoritative
post-publication remote-resolution gate.

The protected workflow stages the signed raw Maven repository with in-memory
PGP material, normalizes it to the exact 30-file Portal tree, and persists the
bundle, inventory, and `central-portal-state.json` on a draft GitHub Release
before upload. The initial HTTP 201 deployment UUID is fsynced before polling.
An uncertain upload outcome stops automatic retries; use the protected
`workflow_dispatch` recovery with exact `refs/tags/v1.1.0` and the Portal UUID.
Recovery downloads the preserved bytes and never rebuilds, re-signs, or
re-uploads them.

Central states resume as follows: `PENDING` and `VALIDATING` poll,
`VALIDATED` publishes once, `PUBLISHING` polls, `PUBLISHED` verifies the public
repository, and `FAILED` stops with sanitized errors. A missing public POM is
not evidence that another upload is safe. After `PUBLISHED`, every public
Maven file must match the signed inventory before the API 26 and API 35 public
consumer lanes run.

Do not move or recreate a published tag. If a released artifact or manifest is
wrong, fix the source and publish a new patch version with a new checksum.

## Consumer Requirements

iOS applications must include `NSBluetoothAlwaysUsageDescription`. Sandboxed
macOS applications must enable **App Sandbox > Hardware > Bluetooth**, which
sets `com.apple.security.device.bluetooth`; macOS applications should also
provide the Bluetooth usage description displayed to users.

The package contains no Bota backend API client. Host applications remain
responsible for backend grants, device tokens, and presigned upload targets.
