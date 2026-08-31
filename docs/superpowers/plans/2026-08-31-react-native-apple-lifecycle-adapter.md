# React Native Apple Lifecycle Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the private React Native package's lifecycle TurboModule executable on iOS by adapting it to the public `BotaAppleSDK` facade and proving the CocoaPods-to-Swift-Package integration builds.

**Architecture:** A Swift actor serializes `configure` and `destroy` against `BotaDeviceClient.shared`, owns the React Native lifecycle state, and exposes an Objective-C-compatible completion bridge. A narrow Objective-C++ module implements the generated `NativeBotaDeviceSDKSpec` and converts React Native promises only; it does not call the Rust ABI or move recording or firmware bytes. The pod attaches the exact matching `BotaAppleSDK` product from the App SDK release tag, with a local package-path override used by source and CI verification.

**Tech Stack:** Swift 6, Objective-C++20, React Native 0.86.3 Codegen, CocoaPods 1.16.2 with a 1.13 consumer floor, xcodeproj 1.27.0, Bundler 2.6.9, Swift Package Manager, Node.js 22, Node test runner, XCTest, Xcode 26.

**Spec:** `docs/superpowers/plans/2026-08-28-app-sdk-implementation.md` Milestone 4, `docs/superpowers/plans/2026-08-31-react-native-package-foundation.md`, and `ARCHITECTURE.md` React Native boundary.

## Global Constraints

- Keep `@bota.dev/react-native-sdk` private until both native adapters, semantic compatibility, app acceptance, and publication gates pass.
- Keep package, pod, and Apple Swift-package versions synchronized with `sdk-version.toml` (`1.0.2` for this slice).
- Keep the Codegen names `BotaDeviceSDKSpec` and `BotaDeviceSDK` unchanged.
- React Native configuration, state, capabilities, identifiers, progress, errors, and native file paths may cross the bridge; recording and firmware bytes may not.
- The Objective-C++ adapter must call `BotaAppleSDK`, not the Rust C ABI.
- The default pod dependency must resolve the immutable matching App SDK tag; local source consumption is an explicit test/development override.
- This slice does not switch Demo or Bota One and does not publish the React Native package.

---

### Task 1: CocoaPods And Apple Package Contract

**Files:**
- Create: `frameworks/react-native/BotaDeviceSDK.podspec`
- Modify: `frameworks/react-native/package.json`
- Modify: `tools/react-native/verify-package.mjs`
- Modify: `tools/react-native/verify-package.test.mjs`

**Interfaces:**
- Consumes: `sdk-version.toml`, package `codegenConfig`, React Native's `install_modules_dependencies` and `spm_dependency` helpers.
- Produces: pod `BotaDeviceSDK`, module `BotaDeviceSDK`, React Native's iOS 15.1 floor, Swift 6 compilation, and an exact `BotaAppleSDK` dependency with `BOTA_APPLE_SDK_PACKAGE_PATH` as the local override.

- [x] **Step 1: Write failing package-verifier tests** that require the podspec in npm files, require synchronized pod metadata, reject a missing Apple dependency, reject a non-exact remote version, and reject a mismatched iOS floor or Swift version.
- [x] **Step 2: Run `node --test tools/react-native/verify-package.test.mjs`** and confirm the new tests fail because the podspec and Apple metadata do not exist.
- [x] **Step 3: Add the minimum podspec and verifier implementation** using `https://github.com/bota-dev/app-sdk.git`, `{ kind: "exactVersion", version: package["version"] }`, product `BotaAppleSDK`, iOS `15.1`, Swift `6.0`, and the local path override.
- [x] **Step 4: Run the focused tests and package verification** and confirm both pass.
- [x] **Step 5: Commit** the package contract with the required Codex co-author trailer.

### Task 2: Serialized Swift Lifecycle Bridge

**Files:**
- Create: `frameworks/react-native/Package.swift`
- Create: `frameworks/react-native/ios/BotaDeviceSDKAppleLifecycle.swift`
- Create: `frameworks/react-native/Tests/BotaDeviceSDKAppleLifecycleTests/BotaDeviceSDKAppleLifecycleTests.swift`
- Modify: `frameworks/react-native/package.json`

**Interfaces:**
- Consumes: `BotaDeviceClient.configure(_:)`, `BotaDeviceClient.destroy()`, and an optional application-support filesystem path.
- Produces: `BotaDeviceSDKAppleLifecycle.configure(applicationSupportDirectory:) async throws`, `destroy() async`, `state() -> String`, and fixed low-volume iOS capabilities.

- [x] **Step 1: Write failing XCTest cases** for initial state, successful configure, coalesced concurrent configure, configure failure, recovery after failure, destroy during configuration, idempotent destroy, exact directory forwarding, and capability values.
- [x] **Step 2: Run `swift test --package-path frameworks/react-native`** and confirm failure because the lifecycle actor is missing.
- [x] **Step 3: Implement the minimum actor and injectable Apple-client protocol** so configure calls are coalesced, destroy is ordered after an in-flight configure, lifecycle state cannot be changed by a stale continuation, and race tests synchronize on the actor's actual destroying phase instead of scheduler yields.
- [x] **Step 4: Run XCTest with strict concurrency and warnings as errors** and confirm all lifecycle tests pass.
- [x] **Step 5: Commit** the Swift lifecycle behavior with the required Codex co-author trailer.

### Task 3: Objective-C Completion Bridge And TurboModule

**Files:**
- Create: `frameworks/react-native/ios/BotaDeviceSDKAppleBridge.swift`
- Create: `frameworks/react-native/ios/BotaDeviceSDK.mm`
- Create: `frameworks/react-native/test/apple-adapter-contract.test.mjs`

**Interfaces:**
- Consumes: generated `NativeBotaDeviceSDKSpec`, the Swift lifecycle actor, and React Native resolve/reject blocks.
- Produces: native module `BotaDeviceSDK` implementing `configure`, `destroy`, `getCapabilities`, `getState`, and `getTurboModule`.

- [x] **Step 1: Write a failing adapter-contract test** that requires every generated lifecycle selector, stable module registration, generated JSI construction, the Swift bridge import, and rejection through one native error path.
- [x] **Step 2: Run the focused Node test** and confirm failure because the native sources are missing.
- [x] **Step 3: Implement the Objective-C-compatible Swift completion bridge** over the actor and the minimum Objective-C++ generated-spec adapter.
- [x] **Step 4: Run the focused contract test and the existing Codegen drift test** and confirm both pass.
- [x] **Step 5: Commit** the TurboModule adapter with the required Codex co-author trailer.

### Task 4: Real CocoaPods And Xcode Build Gate

**Files:**
- Create: `tools/react-native/create-apple-adapter-consumer.rb`
- Create: `tools/react-native/test-apple-adapter.sh`
- Create: `frameworks/react-native/scripts/bota_device_sdk_spm_workaround.rb`
- Create: `frameworks/react-native/test/apple-spm-workaround.test.rb`
- Modify: `frameworks/react-native/package.json`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: the local npm package, its podspec, React Native 0.86.3 pods, and the repository root `BotaAppleSDK` package.
- Produces: a disposable iOS 15.1 CocoaPods consumer whose `BotaDeviceSDK` pod target resolves the local Swift package and compiles for the iOS simulator without signing, plus a separate exact-version resolution of the default remote package URL.

- [x] **Step 1: Add a build-gate test command** and run it to confirm it fails before a consumer generator exists.
- [x] **Step 2: Generate a minimal temporary Xcode application and Podfile** with `BOTA_APPLE_SDK_PACKAGE_PATH` pointing to the repository root, then run `pod install` and build and link the disposable application target.
- [x] **Step 3: Fix only integration defects exposed by the real build** until Swift, Objective-C++, generated Codegen, and `BotaAppleSDK` link successfully.
- [x] **Step 4: Add the same build gate to a macOS CI job** after the nested npm install.
- [x] **Step 5: Commit** the build gate with the required Codex co-author trailer.
- [x] **Step 6: Lock the Ruby build toolchain, select Xcode 26.3 explicitly in CI, and resolve the default remote Apple package at the synchronized version.**
- [x] **Step 7: Carry React Native's target-scoped module-map deduplication for the 0.86.3 floor** so the static `BotaDeviceSDK` pod builds against its binary Swift-package dependency on Xcode 26.3 without consumer Podfile changes.
- [x] **Step 8: Compile Objective-C++ and Swift in the disposable application target** so the Xcode 26.3 link gate exercises the same C++ and Swift runtime linkage required by a real React Native application.

### Task 5: Documentation, Review, And Main Integration

**Files:**
- Modify: `AGENTS.md`
- Modify: `ARCHITECTURE.md`
- Modify: `CONTRIBUTING.md`
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-08-28-app-sdk-implementation.md`
- Modify: `docs/superpowers/plans/2026-08-31-react-native-package-foundation.md`
- Modify: this plan

**Interfaces:**
- Consumes: passing package, Swift, CocoaPods, Xcode, Codegen, tooling, license, Rust, and Apple package gates.
- Produces: accurate public and contributor status that marks only the Apple lifecycle adapter complete and leaves Android, full 0.0.65 compatibility, app rollout, and npm publication open.

- [x] **Step 1: Search all documentation** for `BotaDeviceSDK`, `frameworks/react-native`, `BotaAppleSDK`, `TurboModule`, `CocoaPods`, and `spm_dependency`; update every relevant status statement.
- [x] **Step 2: Run the complete applicable local verification suite** for the nested package, root tooling and licenses, Swift adapter package, Apple package, Rust formatting/lint/tests, and git whitespace.
- [x] **Step 3: Request an independent code review** and resolve every actionable finding with focused tests.
- [ ] **Step 4: Mark this plan complete, merge the focused commits to `main`, push, and wait for both CI and License Gate success.**
- [ ] **Step 5: Remove the completed feature worktree** only after remote verification succeeds.
