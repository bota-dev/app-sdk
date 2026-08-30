# Apple SwiftPM Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish `BotaDeviceSDK` `1.0.0` so native iOS and macOS applications can add `https://github.com/bota-dev/app-sdk.git` directly in Xcode.

**Architecture:** Keep the existing local Apple package for facade development and add a root Swift package for remote consumers. The root package compiles the Swift facade source and downloads the Rust C ABI as a checksummed XCFramework from the matching GitHub Release. A protected tag workflow builds the artifact, verifies the checked-in manifest checksum, publishes release assets, and then resolves the package through its public Git URL.

**Tech Stack:** Swift 6, Swift Package Manager, XCFramework, Rust 1.98, Node.js 22, GitHub Actions

**Spec:** `docs/superpowers/specs/2026-08-30-native-facades-design.md`

## Global Constraints

- Public package, product, and module name: `BotaDeviceSDK`.
- Public entry point: `BotaDeviceClient`.
- Minimum platforms: iOS 15 and macOS 13.
- Repository dependency URL: `https://github.com/bota-dev/app-sdk.git`.
- Release tags use `vVERSION`; all package metadata uses the same version from `sdk-version.toml`.
- The Swift facade remains source; only `BotaDeviceSDKCore.xcframework.zip` is a remote binary target.
- Release assets are immutable and checked with `swift package compute-checksum`.
- The Rust core is an implementation detail of this Apple release and does not require crates.io publication.
- Release CI does not write device state or claim physical-device evidence.

---

### Task 1: Promote The Synchronized SDK Version

**Files:**
- Modify: `sdk-version.toml`
- Modify: `package.json`
- Modify: `Cargo.toml` workspace member manifests and `Cargo.lock`
- Modify: `platforms/apple/Sources/BotaDeviceSDK/BotaDeviceSDK.swift`
- Modify: `protocol/compatibility/firmware-compatibility.json`
- Create: `release/examples/1.0.0.json`
- Modify: version-sensitive tests and public documentation

**Interfaces:**
- Consumes: the existing synchronized `1.0.0-alpha.1` authorities.
- Produces: one stable `1.0.0` authority accepted only by tag `v1.0.0`.

- [x] **Step 1: Change release-readiness expectations to stable `1.0.0`**

Update the release tests so `verify_release(root, "v1.0.0")` succeeds and the
old prerelease or an unprefixed version is rejected.

- [x] **Step 2: Run the focused release tests and verify RED**

Run:

```bash
cargo test -p xtask --test release_readiness --test release_manifest
```

Expected: FAIL because repository version authorities still contain
`1.0.0-alpha.1` and `release/examples/1.0.0.json` does not exist.

- [x] **Step 3: Synchronize version authorities and the stable release example**

Set package authorities and current compatibility metadata to `1.0.0`, retain
the prerelease evidence as historical records, and make the stable release
example describe `BotaDeviceSDKCore.xcframework.zip` in ecosystem `swiftpm`.

- [x] **Step 4: Run focused release and Apple version tests**

Run:

```bash
cargo test -p xtask --test release_readiness --test release_manifest
tools/apple/test-package.sh --filter PackageSmokeTests
```

Expected: PASS with `BotaDeviceSDKVersion.current == "1.0.0"`.

### Task 2: Generate And Validate The Public Swift Package

**Files:**
- Create: `tools/release/generate-public-swift-package.mjs`
- Create: `tools/release/generate-public-swift-package.test.mjs`
- Create: `Package.swift`
- Modify: `tools/apple/package-release.sh`
- Modify: `package.json`

**Interfaces:**
- Consumes: SDK version and SHA-256/SwiftPM checksum of the deterministic Apple archive.
- Produces: a root `Package.swift` with a remote `BotaDeviceSDKC` binary target and source `BotaDeviceSDK` facade target.

- [x] **Step 1: Write failing package-generation tests**

Test that the renderer emits iOS 15, macOS 13, the exact versioned GitHub
Release URL, the supplied checksum, and the facade source path. Test rejection
of malformed versions, zero checksums, and uppercase checksums.

- [x] **Step 2: Run the generator tests and verify RED**

Run:

```bash
node --test tools/release/generate-public-swift-package.test.mjs
```

Expected: FAIL because the generator module does not exist.

- [x] **Step 3: Implement generation and check modes**

Expose `renderPublicSwiftPackage({ sdkVersion, artifactChecksum })`. The CLI
accepts `--sdk-version`, `--artifact-checksum`, and `--output`; `--check`
compares generated content with the checked-in file instead of writing it.
Append the check to `package-release.sh` after the deterministic archive and
metadata have been generated.

- [x] **Step 4: Generate and validate the root package**

Run:

```bash
node tools/release/generate-public-swift-package.mjs \
  --sdk-version 1.0.0 \
  --artifact-checksum "$(cat target/apple-release/BotaDeviceSDKCore.xcframework.swiftpm-checksum)" \
  --output Package.swift
swift package dump-package
```

Expected: `dump-package` reports product `BotaDeviceSDK`, iOS 15, macOS 13,
and the matching remote binary target without downloading it.

### Task 3: Publish And Verify The Apple Release

**Files:**
- Create: `tools/apple/test-remote-consumer.sh`
- Modify: `.github/workflows/release.yml`
- Modify: `tools/xtask/tests/release_readiness.rs`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `AGENTS.md`
- Modify: `docs/releasing.md`

**Interfaces:**
- Consumes: tag `vVERSION`, the root Swift package, deterministic Apple archive, checksum, SBOM, license, and release manifest.
- Produces: a GitHub Release that SwiftPM can resolve by repository URL and semantic version.

- [x] **Step 1: Extend workflow assertions before editing the workflow**

Require the release workflow to use a macOS Apple verification job, run
`tools/apple/package-release.sh`, upload all Apple release outputs, avoid a
crates.io credential, and run the public remote-consumer smoke after release.

- [x] **Step 2: Run release-readiness tests and verify RED**

Run:

```bash
cargo test -p xtask --test release_readiness
```

Expected: FAIL because the existing workflow publishes only the Rust crate.

- [x] **Step 3: Implement protected tag publication**

Use one Ubuntu verification job and one `macos-15` Apple job. After both pass,
download the Apple output under a release job with `contents: write` and the
protected `release` environment, then create or update the GitHub Release. A
final `macos-15` job runs the remote consumer against the released tag.

- [ ] **Step 4: Verify local release behavior and documentation**

Run:

```bash
cargo xtask release verify-tag v1.0.0
node --test tools/release/generate-apple-*.test.mjs tools/release/generate-public-swift-package.test.mjs
tools/apple/package-release.sh
swift package dump-package
cargo test -p xtask --test release_readiness --test release_manifest
```

Expected: all checks pass and the checked-in package checksum equals the
generated archive checksum.

- [ ] **Step 5: Commit and push focused changes**

Create one version/public-package commit and one workflow/documentation commit,
each with `Co-Authored-By: OpenAI Codex <noreply@openai.com>`, then push `main`.

## Exit Criteria

- Xcode can add `https://github.com/bota-dev/app-sdk.git` at version `1.0.0`.
- The same product builds for iOS 15+ and macOS 13+.
- The release workflow cannot publish an Apple asset whose checksum differs from root `Package.swift`.
- Release publication does not depend on crates.io credentials.
- A post-publication macOS consumer imports only `BotaDeviceSDK` from the public tag.
- Public documentation lists installation, Bluetooth permission, and macOS sandbox requirements.
