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

## CI build time

CI and the dependency license gate run on pull requests and main-branch pushes.
Superseded pull-request CI runs are cancelled, while every main-branch release
candidate run finishes. Tag-triggered release automation remains enabled.

Rust jobs cache dependencies using the pinned toolchain and save the cache even
when a later check fails. Caches remain scoped by job. Android's npm cache key
includes both the repository and React Native lockfiles. Apple XCFramework
packaging still compiles in an isolated temporary directory; the Rust cache does
not reuse those temporary build outputs. The maintenance React Native workflow
baseline is checked out under `.ci/`, outside Cargo's `target/`, so Rust cache
cleanup cannot remove it before the tooling checks run. Compare completed Actions
job timings and cache hits after rollout before claiming a measured speedup.
PR and main CI generate commit-specific Apple evidence with
`tools/apple/package-release.sh --evidence-only`; protected release tags retain
the exact root Swift package checksum gate.

## Required Checks

```bash
npm ci
npm run check
cd frameworks/react-native && npm ci && npm run verify
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Web facade changes use Node.js 22+, npm 12.0.2 for packing, and Playwright
1.63.0 with only Chromium installed under `target/playwright-browsers`. Run the
single complete local gate rather than testing a source-linked consumer:

```bash
PLAYWRIGHT_BROWSERS_PATH="$PWD/target/playwright-browsers" \
  npm run web:verify
```

That command builds the WASM package, runs the Web unit/type/package suites,
packs one tarball, installs only that artifact into the Vite consumer, and runs
automated Chromium with deterministic fake Bluetooth. It does not prove a real
device. Release acceptance separately follows
[`docs/testing/web-physical-device.md`](docs/testing/web-physical-device.md);
never mark a physical row passed from Playwright output, and never run its
state-changing provisioning, settings, WiFi, recording-control, transfer, OTA,
or deprovision cases without the supervised prerequisites in that runbook.

Flutter changes use the repository-local Flutter `3.47.2` and Dart `3.13.2`
toolchain. The wrapper downloads and verifies the official archive under
`target/flutter-sdk`; `BOTA_FLUTTER_HOME` is accepted only when it reports the
same pinned versions. A successful bootstrap removes the downloaded archive
after extraction and verification. Use `tools/flutter/run-dart.sh` for direct
Dart commands and Node `22.23.2` for the package verifier:

```bash
source "$HOME/.nvm/nvm.sh" && nvm use 22.23.2 >/dev/null
tools/flutter/run-flutter.sh pub get --directory frameworks/flutter/bota_flutter_sdk
npm run flutter:verify
tools/flutter/package-release.sh --check
```

The package-release command performs dry-run and local consumer checks only. It
preserves deterministic evidence under `target/flutter-release/` and never
publishes, tags, or creates a release.

The Flutter bridge uses exactly Pigeon `28.0.0`. Regenerate its checked-in
Dart, Swift, and Kotlin outputs only through the pinned toolchain, then run the
drift gate:

```bash
tools/flutter/generate-pigeon.sh
npm run flutter:generate:check
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
tools/react-native/test-android-adapter.sh --repository target/android-m2
tools/android/test-emulator-lane.sh --api 26
tools/android/test-emulator-lane.sh --api 35
```

The React Native Android consumer also requires `npm ci` in
`frameworks/react-native`. It checks that the repository AAR is byte-identical
to the packaged release before running Codegen, Kotlin tests, lint, and release
assembly.

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
manifest. Flutter's public Swift package contains no override; its local tests
patch a disposable copy only.
