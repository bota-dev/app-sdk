# Contributing

## Before You Start

Read [AGENTS.md](AGENTS.md), [ARCHITECTURE.md](ARCHITECTURE.md), and the active
implementation plan. Protocol and security changes require maintainer review
against Bota's private normative specifications before merge; contributors do
not need access to those documents to open an issue or propose a change.

## Development Workflow

1. Write a focused failing test.
2. Run it and confirm the expected failure.
3. Implement the minimum behavior needed to pass.
4. Run formatting, linting, license, and affected test suites.
5. Update fixtures, compatibility data, and documentation.
6. Commit one coherent behavior change.

## Required Checks

```bash
npm ci
npm run check
cd frameworks/react-native && npm ci && npm run verify
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

React Native Apple changes also require macOS with Xcode 26 and CocoaPods 1.13
or newer. The repository verification environment is locked by the nested
Gemfile:

```bash
cd frameworks/react-native
bundle _2.6.9_ install
npm run test:apple:lifecycle
npm run test:apple:spm-workaround
bundle _2.6.9_ exec npm run test:apple:integration
bundle _2.6.9_ exec npm run test:apple:remote-resolution
```

Android changes require JDK 17, Android SDK 36, build-tools 35.0.0, NDK
28.2.13676358, and CMake 3.22.1. Run the unpublished package gate with signing
credentials absent:

```bash
JAVA_HOME=/path/to/jdk-17 ANDROID_HOME="$HOME/Library/Android/sdk" \
  npm run test:android:foundation
tools/android/package-release.sh --check
tools/android/install-release-repository.sh target/android-release target/android-m2
tools/android/test-emulator-lane.sh --api 26
tools/android/test-emulator-lane.sh --api 35
```

The stable compatibility gate uses an API 26 Google APIs `x86` image and an
API 35 Google APIs `x86_64` image. Those exact images require an x86_64 host;
Apple Silicon contributors may run source and package checks locally, but must
use the Ubuntu CI result for the two release emulator claims. Never substitute
an arm64 image and describe it as the stable release lane.

Dependencies with copyleft or source-available licenses are rejected by both
the root and React Native npm checkers and by `cargo-deny`. An exception must
identify the exact observed license and document a completed review; it is not
a general package bypass.
Published Android dependencies additionally require an exact entry in
`protocol/baseline/android-maven-license-policy.json`. Update that review and
the generated SPDX evidence in the same change as any Maven dependency.

Never commit local source links as production dependencies. In particular,
`BOTA_APPLE_SDK_PACKAGE_PATH` is only a source and CI override; the React Native
pod must resolve the exact matching immutable App SDK tag by default. All
released artifacts must match `sdk-version.toml` and the signed release
manifest.
