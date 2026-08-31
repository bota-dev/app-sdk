# React Native Android Lifecycle Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the private React Native package's lifecycle TurboModule executable on Android by adapting it to the synchronized `dev.bota:bota-android-sdk` facade and proving a clean React Native 0.86.3 Codegen build consumes it.

**Architecture:** A small Kotlin lifecycle object serializes `configure` and `destroy` with a coroutine mutex and delegates to `BotaDeviceClient.shared`. A generated-spec module translates `ReadableMap` and `Promise` values only, while a `BaseReactPackage` registers the TurboModule. The package depends on the exact App SDK version from its own `package.json`; local tests resolve the same AAR from `target/android-m2`, while applications resolve it from Maven Central.

**Tech Stack:** Kotlin 2.1.20, coroutines 1.10.2, Android Gradle Plugin 8.13.2, JDK 17, Android API 26/36, React Native 0.86.3 Codegen, Gradle 8.13, Node.js 22, JUnit 4. The Android facade and coroutines API are compiled at or below React Native's Kotlin level so a stock consumer can read their metadata without a project-wide Kotlin override.

**Spec:** `ARCHITECTURE.md` React Native boundary and `docs/superpowers/plans/2026-08-28-app-sdk-implementation.md` Milestone 4.

## Global Constraints

- Keep `@bota.dev/react-native-sdk` private until both native adapters, semantic `0.0.65` compatibility, app acceptance, and npm release gates pass.
- Keep package and Android facade versions equal to `sdk-version.toml`.
- Keep Codegen names `BotaDeviceSDKSpec` and `BotaDeviceSDK` unchanged.
- Use `BotaDeviceClient` and `BotaConfiguration`; the adapter must not call JNI or the Rust ABI directly.
- Carry only lifecycle configuration, state, capabilities, identifiers, progress, errors, and native file paths over Codegen. Recording and firmware bytes stay native.
- Android support starts at API 26 and compiles with API 36 and JDK 17.
- Local verification must consume the packaged AAR from `target/android-m2`, not compile the Android facade as an undeclared source dependency.

---

### Task 1: Android Package And Generated-Spec Contract

**Files:**
- Create: `frameworks/react-native/test/android-adapter-contract.test.mjs`
- Create: `frameworks/react-native/android/build.gradle`
- Create: `frameworks/react-native/android/src/main/AndroidManifest.xml`
- Modify: `frameworks/react-native/package.json`
- Modify: `tools/react-native/verify-package.mjs`
- Modify: `tools/react-native/verify-package.test.mjs`

**Interfaces:**
- Consumes: `package.json.version`, `codegenConfig.name`, `codegenConfig.android.javaPackageName`, React Native's `com.facebook.react` Gradle plugin, and Maven coordinate `dev.bota:bota-android-sdk`.
- Produces: Android namespace `dev.bota.sdk.reactnative`, API 26 minimum, exact synchronized facade dependency, and generated `NativeBotaDeviceSDKSpec` source under the configured package.

- [x] **Step 1: Write failing contract tests** that require the manifest, Gradle library and React plugins, API 26/36, JDK 17, the exact package-version-derived Android facade dependency, and no direct JNI/Rust calls in adapter sources.
- [x] **Step 2: Run `node --test test/android-adapter-contract.test.mjs` and verifier tests** and confirm failure because the Android package is absent.
- [x] **Step 3: Add the minimum Android library build** using root-project overrides where available and synchronized defaults otherwise. Configure `react { libraryName = "BotaDeviceSDKSpec"; codegenJavaPackageName = "dev.bota.sdk.reactnative" }` and depend on `com.facebook.react:react-android`, `dev.bota:bota-android-sdk:${packageVersion}`, and coroutines.
- [x] **Step 4: Extend package verification** to reject missing Android files, namespace/name drift, API-floor drift, and a facade version not derived from package metadata.
- [x] **Step 5: Run focused Node tests and `npm run verify`** and confirm they pass.
- [x] **Step 6: Commit** with `feat(react-native): define Android adapter package` and the required Codex trailer.

### Task 2: Serialized Kotlin Lifecycle And TurboModule

**Files:**
- Create: `frameworks/react-native/android/src/main/java/dev/bota/sdk/reactnative/BotaDeviceSDKAndroidLifecycle.kt`
- Create: `frameworks/react-native/android/src/main/java/dev/bota/sdk/reactnative/BotaDeviceSDKModule.kt`
- Create: `frameworks/react-native/android/src/main/java/dev/bota/sdk/reactnative/BotaDeviceSDKPackage.kt`
- Create: `frameworks/react-native/android/src/test/java/dev/bota/sdk/reactnative/BotaDeviceSDKAndroidLifecycleTest.kt`
- Modify: `frameworks/react-native/test/android-adapter-contract.test.mjs`

**Interfaces:**
- Consumes: `BotaDeviceClient.shared.configure(BotaConfiguration)` and `destroy()`, generated `NativeBotaDeviceSDKSpec`, `ReactApplicationContext`, `ReadableMap`, and `Promise`.
- Produces: `BotaDeviceSDKAndroidLifecycle.configure(File?)`, `destroy()`, `state()`, fixed Android capabilities, module name `BotaDeviceSDK`, and `BotaDeviceSDKPackage`.

- [ ] **Step 1: Write failing Kotlin tests** with an injectable fake client for initial state, exact directory forwarding, successful configure, recoverable failure, concurrent configure coalescing, destroy waiting behind configure, idempotent destroy, and capability values.
- [ ] **Step 2: Write failing source-contract assertions** for all four generated selectors, `@ReactModule`, stable error code `android_sdk_error`, `BaseReactPackage`, and TurboModule metadata.
- [ ] **Step 3: Run the focused tests** and confirm missing lifecycle/module/package failures.
- [ ] **Step 4: Implement the lifecycle** with `Mutex`, a volatile phase, and a narrow client interface. Set `initializing` before the native call, `ready` after success, `error` after failure, and always restore `uninitialized` after destroy.
- [ ] **Step 5: Implement the module and package**. Launch suspend work on a `SupervisorJob + Dispatchers.Default` scope, convert the optional directory to `File`, resolve capabilities with a writable map, and reject all native failures with `android_sdk_error`.
- [ ] **Step 6: Run Kotlin, Node contract, Codegen, typecheck, and package tests** and confirm they pass.
- [ ] **Step 7: Commit** with `feat(react-native): add Android lifecycle adapter` and the required Codex trailer.

### Task 3: Packaged-AAR Consumer And CI Gate

**Files:**
- Create: `tests/conformance/react-native-android-adapter/settings.gradle.kts`
- Create: `tests/conformance/react-native-android-adapter/build.gradle.kts`
- Create: `tests/conformance/react-native-android-adapter/gradle.properties`
- Create: `tools/react-native/test-android-adapter.sh`
- Modify: `.github/workflows/ci.yml`
- Modify: `frameworks/react-native/test/android-adapter-contract.test.mjs`

**Interfaces:**
- Consumes: nested `node_modules`, `target/android-m2`, React Native's included Gradle plugin, and the exact packaged `dev.bota:bota-android-sdk` AAR.
- Produces: a clean Gradle build that generates `NativeBotaDeviceSDKSpec`, compiles the Kotlin adapter, runs lifecycle tests, and verifies the resolved AAR checksum matches `target/android-release`.

- [ ] **Step 1: Write failing build-gate assertions** requiring a checked-in consumer fixture, an explicit local repository argument, exact AAR digest comparison, and `generateCodegenArtifactsFromSchema`, unit-test, lint, and assemble tasks.
- [ ] **Step 2: Run the contract test** and confirm the consumer script is missing.
- [ ] **Step 3: Add the isolated Gradle fixture**. Include the React Native Gradle plugin from nested `node_modules`, include `frameworks/react-native/android` as project `:adapter`, and restrict repositories to Google, Maven Central, and the explicit local Maven directory.
- [ ] **Step 4: Add `test-android-adapter.sh`** that validates JDK/SDK inputs, verifies the packaged and repository AAR bytes match, then runs Codegen, unit tests, lint, and release assembly with dependency refresh.
- [ ] **Step 5: Run the script locally** against a freshly installed `target/android-m2` and resolve only build defects exposed by the real generated spec.
- [ ] **Step 6: Add the script to the existing Android CI job** after the immutable AAR repository is installed; install nested npm dependencies first.
- [ ] **Step 7: Run release/tooling tests and commit** with `ci(react-native): verify Android adapter consumer` and the required Codex trailer.

### Task 4: Documentation, Evidence, And Main Integration

**Files:**
- Modify: `AGENTS.md`
- Modify: `ARCHITECTURE.md`
- Modify: `CONTRIBUTING.md`
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-08-28-app-sdk-implementation.md`
- Modify: `docs/superpowers/plans/2026-08-31-react-native-package-foundation.md`
- Modify: this plan

**Interfaces:**
- Consumes: passing JavaScript, Codegen, Kotlin, Gradle, packaged-AAR, Apple adapter, native facade, license, and baseline gates.
- Produces: accurate status marking only lifecycle adapters complete while leaving workflow bindings, full `0.0.65` compatibility, app rollout, and npm publication open.

- [ ] **Step 1: Search the full documentation surface** for `frameworks/react-native`, `BotaDeviceSDK`, `BotaDeviceClient`, `TurboModule`, `0.0.65`, and `Android adapter`; update every relevant status statement.
- [ ] **Step 2: Run the complete applicable gate:** root tooling/release/license tests, nested package verification, Swift lifecycle tests, Android adapter consumer, frozen `0.0.65` workflow/API comparison, Rust format/lint/tests, native ABI smoke, and `git diff --check`.
- [ ] **Step 3: Verify generated and release artifacts leave no tracked diff** and the worktree contains only intentional documentation/status updates.
- [ ] **Step 4: Mark this plan complete and commit** with `docs(react-native): record Android lifecycle acceptance` and the required Codex trailer.
- [ ] **Step 5: Push `main` and require CI plus License Gate success** before beginning complete workflow/API compatibility or switching an application.

## Exit Criteria

- A clean React Native 0.86.3 build generates and compiles the Android TurboModule spec.
- Lifecycle calls delegate to the public Android facade, serialize configure/destroy, and preserve stable state and errors.
- The adapter consumes the exact packaged AAR from local Maven during CI and the same coordinate from Maven Central in applications.
- No recording or firmware bytes cross Codegen, and no adapter calls JNI/Rust directly.
- Apple and Android lifecycle adapters pass, while documentation still marks complete workflow parity, app migration, and npm publication as open.
