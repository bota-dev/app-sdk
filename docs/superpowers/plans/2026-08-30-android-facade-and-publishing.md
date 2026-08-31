# Android Facade and Maven Central Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Plan Status:** Approved architecture translated into an execution plan. The Android facade is not implemented, published, or physically verified by this document.

**Goal:** Build, verify, and publish Bota SDK for Android as `dev.bota:bota-android-sdk`, backed by the frozen manual C ABI and shared Rust workflow core.

**Architecture:** A Kotlin facade owns Android lifecycle, permissions, BluetoothGatt, persistence, Keystore, files, and OkHttp while a single coroutine-confined runtime drives the existing opaque Rust engine through a thin JNI adapter. Release CI cross-compiles the Rust `cdylib` for each supported Android ABI, packages those libraries and the Kotlin facade in one AAR, validates the AAR through an unrelated emulator consumer, and publishes signed Maven Central artifacts only after release-manifest v2, conformance, migration, and physical-device gates pass.

**Tech Stack:** Rust 1.98.0, manual C ABI v1, Android API 26+, compile/target SDK 36, Android Gradle Plugin 8.13.2, Gradle 8.13, JDK 17, NDK 28.2.13676358, CMake 3.22.1, Kotlin 2.3.20, kotlinx.coroutines 1.11.0, OkHttp 4.12.0, Dokka 2.2.0, Vanniktech Maven Publish 0.35.0, Kotlin Binary Compatibility Validator 0.18.1, Maven Central Publisher Portal, JUnit 4.13.2, AndroidX Test 1.7.0/JUnit 1.3.0

**Spec:** `docs/superpowers/specs/2026-08-30-native-facades-design.md`

## Global Constraints

- Public family: **Bota App SDK**; documentation name: **Bota SDK for Android**.
- Public Maven coordinate: `dev.bota:bota-android-sdk`; Kotlin namespace: `dev.bota.sdk`; public entry point: `BotaDeviceClient`.
- Minimum Android version is API 26. Compile and target SDK are 36; builds use JDK 17, AGP 8.13.2, Gradle 8.13, NDK 28.2.13676358, CMake 3.22.1, and `com.vanniktech.maven.publish` 0.35.0. Do not upgrade the publishing plugin to 0.36.0 or newer without moving the wrapper to Gradle 9 and revalidating AGP, Kotlin, Dokka, and every publication task.
- `sdk-version.toml` is the version authority. Gradle, the AAR, POM, module metadata, SBOM, release manifest, release tag, and consumer tests must use its exact value.
- Stable Android publication starts at the next synchronized family release, `1.1.0`. The immutable Apple `v1.0.0` tag and assets are never changed or reused for later Android source.
- Consume the manual ABI in `bindings/device-sdk-ffi/include/bota_device_sdk.h` and the evidence in `release/evidence/1.0.0-alpha.1-native-abi.md`. Do not generate or ship UniFFI bindings.
- Preserve every ABI v1 numeric kind, field, operation, capability, status, error, ownership rule, and `bota_device_sdk_v1_*` symbol. ABI additions are reviewed separately before facade work consumes them.
- Rust owns protocol parsing, serialization, workflow state, retry/checkpoint decisions, cancellation identity, and stable core errors. Kotlin owns Android Bluetooth, permissions, lifecycle, files, Keystore, and network integration.
- One `CoreEngineRuntime` owns one native engine handle on one dedicated coroutine dispatcher. Every host completion returns the original operation, request ID, and 128-bit cancellation ID.
- The AAR contains `libbota_device_sdk_ffi.so` and `libbota_android_jni.so` for `arm64-v8a`, `armeabi-v7a`, `x86_64`, and `x86`. If a pinned Rust/NDK toolchain cannot build one ABI, stop and amend the accepted architecture, compatibility matrix, package metadata, and public docs before removing it.
- The app, not the SDK, requests runtime permissions. Missing permission returns a stable authorization error before scanning, connection, or device mutation.
- The SDK does not call the Bota API. Applications provide provisioning material, reset grants, upload destinations, and firmware requests through opaque registrations.
- Recording and firmware bytes remain in Android-owned files or bounded direct buffers. No full recording or firmware image is accumulated in Kotlin heap memory.
- Checkpoints contain workflow state only. Paths, URLs, headers, grants, device tokens, private keys, and recording payloads stay behind Android-owned opaque IDs.
- Display names never establish identity. Manual connect and reconnect finish only after the shared Rust workflow verifies the exact serial number.
- Remove-only deprovision never invokes authenticated factory reset. Reset resume may close only the exact command ID and binding generation stored with the physical result.
- The pinned Android scaffold at `0f06d2a22c55e4976778520cce42230d23ca4226` is a migration input, not behavior authority. React Native revision `44ac1221cb71eb01cafcdbfdf7a370847d3a10b4` and canonical Rust fixtures remain authoritative until native acceptance passes.
- The replacement AAR keeps deprecated `com.bota.sdk` source-compatibility shims for the pinned scaffold surface, but no legacy Maven coordinate is published and the old repository remains available through migration acceptance.
- Release manifest version 2 uses `sdkFamily: "bota-app-sdk"`, `platform: "android"`, and `packageIdentifier: "dev.bota:bota-android-sdk"` for the Android artifact.
- Automated CI never manufactures physical-device evidence. A stable Android publication requires reviewed Bota Pin and Bota Note results, including the separately gated authenticated-reset receipt.
- Every implementation commit updates the affected root or Android documentation, and every AI commit includes `Co-Authored-By: OpenAI Codex <noreply@openai.com>`.

## Planned File Map

```text
platforms/android/
  settings.gradle.kts                         Android build and repositories
  build.gradle.kts                            Pinned plugins and family version
  gradle.properties                           Reproducible Gradle defaults/version mirror
  gradle/libs.versions.toml                    Tool and dependency pins
  gradle/wrapper/                              Gradle 8.13 wrapper
  README.md                                    Android contributor status and gates
  sdk/
    build.gradle.kts                           AAR, JNI, publication, sources, Dokka
    consumer-rules.pro                         JNI/public-model keep rules
    src/main/AndroidManifest.xml               Bluetooth feature/permission declarations
    src/main/cpp/                              Thin JNI adapter and CMake import
    src/main/kotlin/dev/bota/sdk/              Public facade and native hosts
    src/main/kotlin/com/bota/sdk/              Deprecated migration facade
    src/test/                                  JVM facade/host/transport tests
    src/androidTest/                           Real JNI and fixture conformance tests
tests/conformance/android-consumer/            Unrelated Maven/AAR emulator consumer
tests/conformance/android-legacy-consumer/     Frozen source and precompiled legacy consumer
tools/android/                                 Native build, package, test, and publish gates
tools/release/                                 Android SBOM and manifest-v2 generators
docs/migration/android.md                      Legacy-to-new API mapping
docs/testing/android-physical-device.md        Supervised hardware procedure
release/evidence/1.1.0-android-facade.md       Automated and physical evidence
release/examples/1.1.0.json                    Synchronized multi-artifact manifest example
```

---

### Task 1: Create the Version-Synchronized Android Build

**Files:**
- Create: `platforms/android/settings.gradle.kts`
- Create: `platforms/android/build.gradle.kts`
- Create: `platforms/android/gradle.properties`
- Create: `platforms/android/gradle/libs.versions.toml`
- Create: `platforms/android/gradle/wrapper/gradle-wrapper.jar`
- Create: `platforms/android/gradle/wrapper/gradle-wrapper.properties`
- Create: `platforms/android/gradlew`
- Create: `platforms/android/gradlew.bat`
- Create: `platforms/android/sdk/build.gradle.kts`
- Create: `platforms/android/sdk/consumer-rules.pro`
- Create: `platforms/android/sdk/src/main/AndroidManifest.xml`
- Create: `platforms/android/sdk/src/main/kotlin/dev/bota/sdk/BotaAndroidSDK.kt`
- Create: `platforms/android/sdk/src/test/kotlin/dev/bota/sdk/PackageSmokeTest.kt`
- Create: `platforms/android/README.md`
- Modify: `tools/xtask/src/lib.rs`
- Modify: `tools/xtask/tests/release_readiness.rs`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `sdk-version.toml` and repository-pinned Node/Rust toolchains.
- Produces: Android library project `:sdk`, namespace `dev.bota.sdk`, Maven identity `dev.bota:bota-android-sdk`, and `BotaAndroidSDK.version`.

- [ ] **Step 1: Write the failing synchronized-version tests**

Add release-readiness assertions that `platforms/android/gradle.properties`
contains the same `VERSION_NAME` as `sdk-version.toml`, the wrapper is exactly
Gradle 8.13, AGP is 8.13.2, and `com.vanniktech.maven.publish` is exactly 0.35.0.
The test rejects 0.36.0+ while the wrapper remains on Gradle 8. Add this package
test:

```kotlin
class PackageSmokeTest {
    @Test fun publicVersionComesFromTheFamilyAuthority() {
        assertEquals(System.getProperty("bota.test.sdkVersion"), BotaAndroidSDK.version)
        assertEquals("dev.bota", BotaAndroidSDK.mavenGroup)
        assertEquals("bota-android-sdk", BotaAndroidSDK.mavenArtifact)
    }
}
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
cargo test -p xtask --test release_readiness
```

Expected: FAIL because the Android version authority and project do not exist.

- [ ] **Step 3: Add the pinned Gradle project**

Use exact version-catalog entries for AGP 8.13.2, Kotlin 2.3.20, coroutines
1.11.0, OkHttp/MockWebServer 4.12.0, Dokka 2.2.0, Vanniktech Maven Publish
0.35.0, JUnit 4.13.2, AndroidX Test runner/core/rules 1.7.0, and AndroidX Test
JUnit 1.3.0. Configure `:sdk`
with `minSdk = 26`, `compileSdk = 36`, `targetSdk = 36`, Java/Kotlin target 17,
`ndkVersion = "28.2.13676358"`, `cmake.version = "3.22.1"`, and the four ABI
filters from the global constraints. Set `group = "dev.bota"` and read
`version` from `VERSION_NAME`; `xtask` rejects any mismatch with
`sdk-version.toml`.

`BotaAndroidSDK` exposes only immutable metadata:

```kotlin
public object BotaAndroidSDK {
    public val version: String get() = BuildConfig.BOTA_SDK_VERSION
    public const val mavenGroup: String = "dev.bota"
    public const val mavenArtifact: String = "bota-android-sdk"
}
```

Enable `buildFeatures.buildConfig`, inject `BOTA_SDK_VERSION` from the Gradle
project version, and pass that same value to JVM tests as
`bota.test.sdkVersion`. Enable dependency verification and locking,
deterministic archives, explicit API mode, warnings as errors, and release lint.
Apply `com.vanniktech.maven.publish` 0.35.0 to `:sdk` now, configure the Android
release variant, sources and Dokka JARs, Central Portal target, and an unsigned
file Maven repository named `Local` rooted at `target/android-m2`. Name the
plugin-created publication exactly `maven`. Do not call `signAllPublications()`
in the default graph: without the exact property `botaProtectedSigning=true`,
`:sdk:signMavenPublication` and the protected raw-repository publish task must be
absent. Register a guard named `:sdk:stageSignedCentralRawRepository` that fails
unless the protected property is present; Task 12 replaces that guard with the
credential-checked signing graph. The first Gradle gate proves plugin application
and unsigned local publication-task discovery without credentials or upload.
Declare Bluetooth permissions
without requesting them: legacy `BLUETOOTH`/`BLUETOOTH_ADMIN` capped at API 30,
and `BLUETOOTH_SCAN`/`BLUETOOTH_CONNECT` for API 31+. Keep the hardware feature
optional so installation is possible before capability discovery.

- [ ] **Step 4: Run the package shell gate**

Run:

```bash
cargo test -p xtask --test release_readiness
platforms/android/gradlew -p platforms/android --version
mkdir -p target
env -u ORG_GRADLE_PROJECT_signingInMemoryKey \
  -u ORG_GRADLE_PROJECT_signingInMemoryKeyPassword \
  -u ORG_GRADLE_PROJECT_signingInMemoryKeyId \
  platforms/android/gradlew -p platforms/android :sdk:tasks --all \
  | tee target/android-publication-tasks.txt
rg -n '^(publishToMavenLocal|publishToMavenCentral|publishAndReleaseToMavenCentral|publishAllPublicationsToMavenCentralRepository|publishMavenPublicationToLocalRepository|stageSignedCentralRawRepository) - ' \
  target/android-publication-tasks.txt
if rg -n '^(signMavenPublication|publishMavenPublicationToCentralRawRepository) - ' \
  target/android-publication-tasks.txt; then
  exit 1
fi
platforms/android/gradlew -p platforms/android :sdk:testDebugUnitTest :sdk:lintRelease :sdk:assembleRelease
```

Expected: Gradle reports 8.13 on JDK 17; plugin 0.35.0 applies successfully; all
six named unsigned/local/plugin Central/guard tasks are discoverable; signing
and `CentralRaw` publication tasks are absent without the protected property;
the JVM package test passes; lint is clean; and the unsigned release AAR is built
with version matching `sdk-version.toml`. A missing expected task, an unexpected
signing task, or any Gradle/plugin compatibility error stops Task 1.

- [ ] **Step 5: Commit**

```bash
git add .gitignore platforms/android tools/xtask
git commit -m "build(android): add synchronized facade project" \
  -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
```

### Task 2: Package the Frozen Rust ABI Behind Thin JNI

**Files:**
- Create: `platforms/android/sdk/src/main/cpp/CMakeLists.txt`
- Create: `platforms/android/sdk/src/main/cpp/bota_android_jni.cpp`
- Create: `platforms/android/sdk/src/main/kotlin/dev/bota/sdk/internal/jni/NativeCoreBridge.kt`
- Create: `platforms/android/sdk/src/main/kotlin/dev/bota/sdk/internal/jni/NativePacket.kt`
- Create: `platforms/android/sdk/src/androidTest/kotlin/dev/bota/sdk/internal/jni/NativeCoreBridgeTest.kt`
- Create: `tools/android/build-native.sh`
- Create: `tools/android/inspect-aar.sh`
- Create: `tools/android/test-package.sh`
- Modify: `platforms/android/sdk/build.gradle.kts`
- Modify: `platforms/android/README.md`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `bota-device-sdk-ffi` `cdylib`, `bota_device_sdk.h`, ABI v1 evidence, and the four Rust Android targets.
- Produces: `libbota_device_sdk_ffi.so`, `libbota_android_jni.so`, and an internal Kotlin `NativeCore` API with explicit ownership.

```kotlin
internal interface NativeCore : AutoCloseable {
    fun start(command: NativePacket, capabilityBits: ULong)
    fun poll(): NativePacket?
    fun dispatch(event: NativePacket)
    fun cancel(cancellationHigh: ULong, cancellationLow: ULong)
    fun decode(packet: NativePacket): NativePacket
    fun encode(packet: NativePacket): NativePacket
    override fun close()
}
```

- [ ] **Step 1: Write failing real-library ownership tests**

Instrumented tests load the packaged libraries, assert ABI version 1, create
and close one engine, round-trip all five field types including embedded zero
bytes, copy an error before freeing it, poll one owned packet, and verify that
close, packet free, and error free each happen exactly once through JNI test
counters compiled only into the debug test variant.

- [ ] **Step 2: Run the JNI test and verify RED**

Run:

```bash
tools/android/test-package.sh --instrumentation-class dev.bota.sdk.internal.jni.NativeCoreBridgeTest
```

Expected: FAIL because Android native libraries and JNI entry points do not
exist.

- [ ] **Step 3: Cross-compile the Rust library reproducibly**

`build-native.sh` verifies the header SHA-256 recorded in native ABI evidence,
installs only these Rust targets, and invokes the matching API-26 NDK clang
linker:

| Android ABI | Rust target | NDK linker prefix |
| --- | --- | --- |
| `arm64-v8a` | `aarch64-linux-android` | `aarch64-linux-android26-clang` |
| `armeabi-v7a` | `armv7-linux-androideabi` | `armv7a-linux-androideabi26-clang` |
| `x86_64` | `x86_64-linux-android` | `x86_64-linux-android26-clang` |
| `x86` | `i686-linux-android` | `i686-linux-android26-clang` |

Build `bota-device-sdk-ffi` with `cargo build --locked --release --target`,
remap the checkout and Cargo registry paths, copy each
`libbota_device_sdk_ffi.so` into generated `jniLibs/<abi>/`, and reject source
paths, undefined ABI symbols, or unexpected exported `bota_device_sdk_*`
symbols.

- [ ] **Step 4: Implement the JNI ownership adapter**

JNI converts primitive metadata arrays plus `ByteArray` or direct `ByteBuffer`
payloads into borrowed `BotaDeviceSdkFieldViewV1` values for the duration of
one call. It copies every SDK-owned packet/error into immutable Kotlin values,
then invokes the matching free exactly once. The Kotlin wrapper stores the
engine as a private `Long`, rejects calls after `close()`, and loads the Rust
library before `bota_android_jni`.

Do not introduce JSON, base64, a second packet schema, or JNI-owned workflow
state. Large recording and firmware chunks use direct buffers; scalar and
small metadata use primitive arrays.

- [ ] **Step 5: Inspect all AAR native entries and run JNI tests**

Run:

```bash
tools/android/build-native.sh
tools/android/test-package.sh --instrumentation-class dev.bota.sdk.internal.jni.NativeCoreBridgeTest
tools/android/inspect-aar.sh platforms/android/sdk/build/outputs/aar/sdk-release.aar
```

Expected: the instrumentation test uses the real Rust ABI, and inspection
finds exactly two expected `.so` files under each of the four ABI directories,
with API-26-compatible ELF metadata and no absolute build paths.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/ci.yml platforms/android tools/android
git commit -m "feat(android): bridge the frozen native abi" \
  -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
```

### Task 3: Map Kotlin Models, Stable Errors, and Protocol Fixtures

**Files:**
- Create: `platforms/android/sdk/src/main/kotlin/dev/bota/sdk/model/DeviceModels.kt`
- Create: `platforms/android/sdk/src/main/kotlin/dev/bota/sdk/model/RecordingModels.kt`
- Create: `platforms/android/sdk/src/main/kotlin/dev/bota/sdk/model/ConnectionModels.kt`
- Create: `platforms/android/sdk/src/main/kotlin/dev/bota/sdk/model/ProgressModels.kt`
- Create: `platforms/android/sdk/src/main/kotlin/dev/bota/sdk/BotaSDKError.kt`
- Create: `platforms/android/sdk/src/main/kotlin/dev/bota/sdk/internal/core/CoreModelMapper.kt`
- Create: `platforms/android/sdk/src/androidTest/kotlin/dev/bota/sdk/internal/core/ProtocolCodecTest.kt`
- Create: `platforms/android/sdk/src/test/kotlin/dev/bota/sdk/internal/core/ModelMappingTest.kt`
- Create: `tools/android/sync-protocol-fixtures.mjs`
- Modify: `package.json`
- Modify: `platforms/android/sdk/build.gradle.kts`
- Modify: `platforms/android/README.md`

**Interfaces:**
- Consumes: ABI protocol decode/encode functions, 50 language-neutral fixtures, and useful model shape from the pinned Android scaffold.
- Produces: immutable public Kotlin models, forward-compatible wire values, and sealed stable `BotaSDKError` values.

```kotlin
public sealed class BotaSDKError(
    public open val operation: BotaOperation,
    public open val retryable: Boolean,
    message: String,
) : Exception(message) {
    public data class AuthorizationRequired(
        val permissions: Set<String>,
        override val operation: BotaOperation,
    ) : BotaSDKError(operation, false, "Required Bluetooth permission is missing")

    public data class Core(
        val code: BotaErrorCode,
        override val operation: BotaOperation,
        override val retryable: Boolean,
        val protocolStatus: UShort?,
        val detail: String,
    ) : BotaSDKError(operation, retryable, detail)
}

public sealed interface WireValue<out T> {
    public data class Known<T>(val value: T) : WireValue<T>
    public data class Unknown(val rawValue: ULong) : WireValue<Nothing>
}
```

- [ ] **Step 1: Generate fixture resources and write failing tests**

Sync protocol JSON into Android test resources and add `--check` mode. Tests
cover valid, malformed, unknown-enum, Bota Note normalization, recording
encryption, transfer packet, OTA, settings, WiFi, provisioning, and device-log
fixtures. Encoded bytes must match fixture hex exactly.

- [ ] **Step 2: Verify RED through the real JNI path**

Run:

```bash
node tools/android/sync-protocol-fixtures.mjs --check
tools/android/test-package.sh --instrumentation-class dev.bota.sdk.internal.core.ProtocolCodecTest
```

Expected: FAIL because Kotlin model mapping does not exist.

- [ ] **Step 3: Implement model mapping without a Kotlin parser copy**

Port useful data-class names and nullability from the pinned scaffold, move
them to `dev.bota.sdk.model`, and make byte-array equality explicit where it is
publicly observable. Every protocol parse/serialize operation invokes
`NativeCore.decode` or `NativeCore.encode`; Kotlin never reconstructs wire
layouts. Map unknown numeric states to `WireValue.Unknown` and core failures by
stable numeric fields, never by diagnostic text.

- [ ] **Step 4: Run Kotlin and Rust fixture gates**

Run:

```bash
tools/android/test-package.sh --instrumentation-class dev.bota.sdk.internal.core.ProtocolCodecTest
platforms/android/gradlew -p platforms/android :sdk:testDebugUnitTest
cargo test -p bota-device-sdk-core --test fixture_decode --test fixture_encode --test model_contract --test round_trip
```

Expected: Kotlin/JNI and Rust agree on every committed fixture.

- [ ] **Step 5: Commit**

```bash
git add package.json tools/android platforms/android
git commit -m "feat(android): map shared models and codecs" \
  -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
```

### Task 4: Drive the Rust Engine from One Coroutine Runtime

**Files:**
- Create: `platforms/android/sdk/src/main/kotlin/dev/bota/sdk/internal/core/CoreCommand.kt`
- Create: `platforms/android/sdk/src/main/kotlin/dev/bota/sdk/internal/core/CoreEffect.kt`
- Create: `platforms/android/sdk/src/main/kotlin/dev/bota/sdk/internal/core/CoreHostEvent.kt`
- Create: `platforms/android/sdk/src/main/kotlin/dev/bota/sdk/internal/core/CoreNotification.kt`
- Create: `platforms/android/sdk/src/main/kotlin/dev/bota/sdk/internal/core/CoreEngineRuntime.kt`
- Create: `platforms/android/sdk/src/test/kotlin/dev/bota/sdk/internal/core/CoreEngineRuntimeTest.kt`
- Create: `platforms/android/sdk/src/androidTest/kotlin/dev/bota/sdk/internal/core/WorkflowConformanceTest.kt`
- Create: `tools/android/sync-workflow-fixtures.mjs`
- Modify: `package.json`
- Modify: `platforms/android/README.md`

**Interfaces:**
- Consumes: all 10 commands, 30 effects, 34 host events, 12 notifications, and 29 canonical workflow scenarios.
- Produces: `CoreEngineRuntime.run`, `cancel`, ordered effect execution, and a cold `Flow<CoreNotification>` with one command owner.

```kotlin
internal interface CoreWorkflowRunner : AutoCloseable {
    fun run(command: CoreCommand, capabilities: CoreCapabilities): Flow<CoreNotification>
    suspend fun cancel(cancellationId: UUID)
    override fun close()
}
```

- [ ] **Step 1: Write failing ownership, cancellation, and trace tests**

Generate Android resources from all seven `protocol/workflows/*.json` suites.
Tests assert monotonic request IDs, exact effect/notification ordering, one
active owner, unchanged cancellation halves, stale callback rejection without
owner loss, close-after-cancel behavior, and all 29 canonical scenario labels.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
platforms/android/gradlew -p platforms/android :sdk:testDebugUnitTest --tests '*CoreEngineRuntimeTest'
```

Expected: FAIL because the coroutine runtime does not exist.

- [ ] **Step 3: Implement the confined engine loop**

Create one closeable single-thread dispatcher per configured client. Every JNI
engine call runs on that dispatcher. `run` submits one typed command, drains
all outputs, emits notifications, executes one host effect, dispatches its
correlated result, and resumes polling. A second command reaches Rust and
returns `operation_in_progress`; Kotlin does not invent parallel workflow
ownership. Flow cancellation sends the original 128-bit cancellation ID and
waits for the terminal notification before releasing the owner.

- [ ] **Step 4: Run workflow conformance through Kotlin and Rust**

Run:

```bash
node tools/android/sync-workflow-fixtures.mjs --check
tools/android/test-package.sh --instrumentation-class dev.bota.sdk.internal.core.WorkflowConformanceTest
npm run test:workflows -- --sdk-path "$BOTA_REACT_NATIVE_SDK_PATH"
```

Expected: 29 Kotlin/JNI traces and 29 Rust/React Native traces agree on ordered
effects, notifications, errors, cancellation, and terminal state.

- [ ] **Step 5: Commit**

```bash
git add package.json tools/android platforms/android
git commit -m "feat(android): drive workflows through native core" \
  -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
```

### Task 5: Route Every Host Effect Exhaustively

**Files:**
- Create: `platforms/android/sdk/src/main/kotlin/dev/bota/sdk/internal/host/CoreHost.kt`
- Create: `platforms/android/sdk/src/main/kotlin/dev/bota/sdk/internal/host/BluetoothHost.kt`
- Create: `platforms/android/sdk/src/main/kotlin/dev/bota/sdk/internal/host/PersistenceHost.kt`
- Create: `platforms/android/sdk/src/main/kotlin/dev/bota/sdk/internal/host/SecureStorageHost.kt`
- Create: `platforms/android/sdk/src/main/kotlin/dev/bota/sdk/internal/host/NetworkHost.kt`
- Create: `platforms/android/sdk/src/main/kotlin/dev/bota/sdk/internal/host/MaterialHost.kt`
- Create: `platforms/android/sdk/src/main/kotlin/dev/bota/sdk/internal/host/RecordingSinkHost.kt`
- Create: `platforms/android/sdk/src/main/kotlin/dev/bota/sdk/internal/host/FirmwareBlobHost.kt`
- Create: `platforms/android/sdk/src/main/kotlin/dev/bota/sdk/internal/host/HostEffectExecutor.kt`
- Create: `platforms/android/sdk/src/test/kotlin/dev/bota/sdk/internal/host/HostEffectExecutorTest.kt`
- Modify: `platforms/android/README.md`

**Interfaces:**
- Consumes: the sealed 30-case `CoreEffect` model.
- Produces: one or more exactly correlated `CoreHostEvent` values and no untyped fallback route.

- [ ] **Step 1: Write one failing routing case per effect**

Use scripted fake ports to assert the target port, operation, request ID,
cancellation ID, bounded bytes, streaming termination, thrown-error mapping,
timer cancellation, late completion identity, and permitted multi-event BLE
scan/notification streams for all 30 effects.

- [ ] **Step 2: Run the executor tests and verify RED**

Run:

```bash
platforms/android/gradlew -p platforms/android :sdk:testDebugUnitTest --tests '*HostEffectExecutorTest'
```

Expected: FAIL because host ports and routing are absent.

- [ ] **Step 3: Implement exhaustive sealed routing**

Use a Kotlin `when` expression over sealed `CoreEffect` without `else`. Key
timers and jobs by request/cancellation identity. Convert platform exceptions
to the ABI event category required for that effect while preserving every
correlation field. Reject an oversized field or an event kind outside the
effect's allowed set before dispatching it to Rust.

- [ ] **Step 4: Run Kotlin and ABI effect coverage**

Run:

```bash
platforms/android/gradlew -p platforms/android :sdk:testDebugUnitTest --tests '*HostEffectExecutorTest'
cargo test -p bota-device-sdk-ffi --test events --test outputs
```

Expected: every effect and callback variant is covered on both sides.

- [ ] **Step 5: Commit**

```bash
git add platforms/android
git commit -m "feat(android): execute correlated host effects" \
  -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
```

### Task 6: Implement the Serialized BluetoothGatt Transport

**Files:**
- Create: `platforms/android/sdk/src/main/kotlin/dev/bota/sdk/internal/bluetooth/BotaBluetoothUUIDs.kt`
- Create: `platforms/android/sdk/src/main/kotlin/dev/bota/sdk/internal/bluetooth/AndroidBluetoothPlatform.kt`
- Create: `platforms/android/sdk/src/main/kotlin/dev/bota/sdk/internal/bluetooth/BluetoothGattDriver.kt`
- Create: `platforms/android/sdk/src/main/kotlin/dev/bota/sdk/internal/bluetooth/BluetoothGattHost.kt`
- Create: `platforms/android/sdk/src/main/kotlin/dev/bota/sdk/internal/bluetooth/GattOperationQueue.kt`
- Create: `platforms/android/sdk/src/main/kotlin/dev/bota/sdk/internal/bluetooth/RadioArbiter.kt`
- Create: `platforms/android/sdk/src/main/kotlin/dev/bota/sdk/internal/bluetooth/BluetoothPermissionChecker.kt`
- Create: `platforms/android/sdk/src/test/kotlin/dev/bota/sdk/internal/bluetooth/BluetoothGattHostTest.kt`
- Create: `platforms/android/sdk/src/androidTest/kotlin/dev/bota/sdk/internal/bluetooth/BluetoothPermissionTest.kt`
- Modify: `platforms/android/README.md`
- Modify: `ARCHITECTURE.md`

**Interfaces:**
- Consumes: scan, connect, discover, disconnect, read, write, subscribe, and unsubscribe effects.
- Produces: correlated BLE host events; Android framework objects never escape the Bluetooth package.

- [ ] **Step 1: Write scripted callback-order tests**

Tests cover scan deduplication, optional duplicate delivery, API-31 permission
preflight, API-26 location preflight, manual-work priority, independent
per-device queues, MTU negotiation, service/characteristic discovery,
API-33 and legacy write APIs, CCCD enable/disable order, notification delivery,
timeouts, nonzero GATT statuses, disconnect bypass, and stale callbacks from an
older `BluetoothGatt` generation.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
platforms/android/gradlew -p platforms/android :sdk:testDebugUnitTest --tests '*BluetoothGattHostTest'
```

Expected: FAIL because the transport is absent.

- [ ] **Step 3: Implement HandlerThread-owned Android callbacks**

Create `BluetoothLeScanner`, `BluetoothGatt`, `ScanCallback`, and
`BluetoothGattCallback` only on one named `HandlerThread`. Forward value-only
records to coroutine code. Serialize MTU, service discovery, reads, writes, and
descriptor changes per connection; allow unrelated devices to progress; let
disconnect fail blocked work immediately. Complete connect only after required
Bota services/characteristics are discovered. Key callback validity by a
monotonic connection generation so a late callback cannot satisfy newer work.

`RadioArbiter` gives manual selection priority over reconnect. Scan filters use
Bota service UUID/manufacturer data; advertised names are display metadata only.
Permission checks return `BotaSDKError.AuthorizationRequired` before a scan,
connect, or any workflow command reaches Rust. The SDK exposes required
permission names but never starts a permission prompt.

- [ ] **Step 4: Run transport, lint, and Android permission tests**

Run:

```bash
platforms/android/gradlew -p platforms/android :sdk:testDebugUnitTest --tests '*BluetoothGattHostTest'
for api in 26 35; do
  tools/android/test-package.sh --api "$api" \
    --instrumentation-class dev.bota.sdk.internal.bluetooth.BluetoothPermissionTest
done
platforms/android/gradlew -p platforms/android :sdk:lintRelease
```

Expected: operation order and permission behavior pass on API 26 and API 35
test devices, with no name-based identity path.

- [ ] **Step 5: Commit**

```bash
git add ARCHITECTURE.md platforms/android
git commit -m "feat(android): add serialized bluetooth gatt host" \
  -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
```

### Task 7: Add Durable Android Host Services

**Files:**
- Create: `platforms/android/sdk/src/main/kotlin/dev/bota/sdk/internal/host/JournalStore.kt`
- Create: `platforms/android/sdk/src/main/kotlin/dev/bota/sdk/internal/host/AtomicFilePersistenceHost.kt`
- Create: `platforms/android/sdk/src/main/kotlin/dev/bota/sdk/internal/host/AndroidKeystoreSecureStorageHost.kt`
- Create: `platforms/android/sdk/src/main/kotlin/dev/bota/sdk/internal/host/FileRecordingSinkHost.kt`
- Create: `platforms/android/sdk/src/main/kotlin/dev/bota/sdk/internal/host/FileFirmwareBlobHost.kt`
- Create: `platforms/android/sdk/src/main/kotlin/dev/bota/sdk/internal/host/OkHttpNetworkHost.kt`
- Create: `platforms/android/sdk/src/main/kotlin/dev/bota/sdk/internal/host/ApplicationMaterialHost.kt`
- Create: `platforms/android/sdk/src/test/kotlin/dev/bota/sdk/internal/host/JournalStoreContractTest.kt`
- Create: `platforms/android/sdk/src/test/kotlin/dev/bota/sdk/internal/host/FileHostContractTest.kt`
- Create: `platforms/android/sdk/src/test/kotlin/dev/bota/sdk/internal/host/NetworkHostTest.kt`
- Create: `platforms/android/sdk/src/androidTest/kotlin/dev/bota/sdk/internal/host/AtomicFilePersistenceHostTest.kt`
- Create: `platforms/android/sdk/src/androidTest/kotlin/dev/bota/sdk/internal/host/AndroidFileHostTest.kt`
- Create: `platforms/android/sdk/src/androidTest/kotlin/dev/bota/sdk/internal/host/KeystoreHostTest.kt`
- Modify: `platforms/android/README.md`
- Modify: `ARCHITECTURE.md`

**Interfaces:**
- Consumes: opaque checkpoint, key, sink, blob, material, destination, and download IDs.
- Produces: atomic journals, Keystore-backed secrets, bounded file chunks, CRC32-verified recording sinks, and application-authorized OkHttp transfers.

- [ ] **Step 1: Write failing restart, cancellation, and secrecy tests**

Keep the local JVM suite Android-free. `JournalStoreContractTest` runs the
checkpoint/reset-journal contract against an in-memory `JournalStore` fake;
`FileHostContractTest` exercises pure stream, truncate/append/finalize, bounded
read, and CRC32 logic through interfaces backed by `java.nio`; and
`NetworkHostTest` uses MockWebServer to cover cancellation and response-body
cleanup. These tests contain no `android.*` imports.

Put every concrete Android storage assertion under `src/androidTest`.
`AtomicFilePersistenceHostTest` uses `InstrumentationRegistry` application
storage to verify `startWrite`/`finishWrite`/`failWrite`, interrupted replacement,
host recreation, exact reset-result retention, and command-ID/binding-generation
binding. `AndroidFileHostTest` exercises `noBackupFilesDir`,
`ParcelFileDescriptor`, and `FileChannel` against real framework implementations.
`KeystoreHostTest` verifies AES-GCM ciphertext cannot be read without the Android
Keystore key. All three scan persisted bytes to prove that URLs, headers, tokens,
grants, keys, and external file paths are absent from core checkpoints.

- [ ] **Step 2: Run host tests and verify RED**

Run:

```bash
platforms/android/gradlew -p platforms/android :sdk:testDebugUnitTest \
  --tests '*JournalStoreContractTest' \
  --tests '*FileHostContractTest' \
  --tests '*NetworkHostTest'
tools/android/test-package.sh --api 26 \
  --instrumentation-class dev.bota.sdk.internal.host.AtomicFilePersistenceHostTest
```

Expected: the JVM command fails because the host interfaces do not exist and the
API-26 instrumentation command fails because the concrete Android adapters do
not exist. A local JVM test must never be used as evidence for `AtomicFile`,
Android application storage, `ParcelFileDescriptor`, or Keystore behavior.

- [ ] **Step 3: Implement Android-native storage and network ports**

Use `AtomicFile` under `noBackupFilesDir/bota-app-sdk/` for checkpoints and
reset journals. Use a non-exportable Android Keystore AES-GCM key and private
ciphertext files for secure-storage effects. Registry keys are random opaque
IDs; Rust never receives a file path, `Uri`, URL, or header. Use
`ParcelFileDescriptor`/`FileChannel` for bounded sink/blob access and the frozen
protocol CRC32 for finalization. OkHttp requests come from application
registrations, stream progress, and close response bodies on every terminal
path. Application callbacks resolve provisioning/reset material in memory and
remove each registration on completion, cancellation, failure, or destroy.

- [ ] **Step 4: Run host, Keystore, and credential searches**

Run:

```bash
platforms/android/gradlew -p platforms/android :sdk:testDebugUnitTest \
  --tests '*JournalStoreContractTest' \
  --tests '*FileHostContractTest' \
  --tests '*NetworkHostTest'
for api in 26 35; do
  tools/android/test-package.sh --api "$api" \
    --instrumentation-class dev.bota.sdk.internal.host.AtomicFilePersistenceHostTest
  tools/android/test-package.sh --api "$api" \
    --instrumentation-class dev.bota.sdk.internal.host.AndroidFileHostTest
  tools/android/test-package.sh --api "$api" \
    --instrumentation-class dev.bota.sdk.internal.host.KeystoreHostTest
done
rg -n "sk_live_|sk_test_|dtok_|Authorization:" platforms/android/sdk/src/main
```

Expected: pure interface tests pass on the JVM; concrete AtomicFile, application
storage, file-descriptor, and Keystore tests pass on both API 26 and API 35; and
no embedded credential or Bota backend client is found.

- [ ] **Step 5: Commit**

```bash
git add ARCHITECTURE.md platforms/android
git commit -m "feat(android): add durable native host services" \
  -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
```

### Task 8: Expose Client Lifecycle, Discovery, and Connection

**Files:**
- Create: `platforms/android/sdk/src/main/kotlin/dev/bota/sdk/BotaConfiguration.kt`
- Create: `platforms/android/sdk/src/main/kotlin/dev/bota/sdk/BotaDeviceClient.kt`
- Create: `platforms/android/sdk/src/main/kotlin/dev/bota/sdk/DeviceManager.kt`
- Create: `platforms/android/sdk/src/main/kotlin/dev/bota/sdk/internal/DeviceRuntime.kt`
- Create: `platforms/android/sdk/src/test/kotlin/dev/bota/sdk/BotaDeviceClientTest.kt`
- Create: `platforms/android/sdk/src/test/kotlin/dev/bota/sdk/DeviceManagerTest.kt`
- Modify: `platforms/android/README.md`
- Modify: `ARCHITECTURE.md`

**Interfaces:**
- Consumes: configured Android hosts and discovery/connect/reconnect core commands.
- Produces: public `BotaDeviceClient`, `DeviceManager`, suspending operations, and typed connection/status flows.

```kotlin
public class BotaDeviceClient private constructor() {
    public val devices: DeviceManager
    public val provisioning: ProvisioningManager
    public val factoryReset: FactoryResetManager
    public val recordings: RecordingManager
    public val ota: OTAManager
    public val logs: DeviceLogManager

    public suspend fun configure(configuration: BotaConfiguration = BotaConfiguration())
    public suspend fun destroy()

    public companion object { public val shared: BotaDeviceClient }
}
```

- [ ] **Step 1: Write failing public lifecycle tests**

Assert configure is idempotent until destroy, operations fail before configure,
authorization fails before core start, capabilities reflect actual hosts, scan
is a `Flow`, exact serial is mandatory for connect, reconnect forwards saved
peripheral/address hints to Rust, connection observation completes on destroy,
status uses the shared decoder, cancellation stops scan, and destroy closes JNI,
HandlerThread, dispatcher, registrations, and observers exactly once.

- [ ] **Step 2: Run public API tests and verify RED**

Run:

```bash
platforms/android/gradlew -p platforms/android :sdk:testDebugUnitTest --tests '*BotaDeviceClientTest' --tests '*DeviceManagerTest'
```

Expected: FAIL because the public client and manager do not exist.

- [ ] **Step 3: Implement the public connection facade**

`BotaConfiguration` requires an application `Context` and optional injected
material/network/file policies; it retains only `applicationContext`. Public
models are immutable. `DeviceManager` translates flow cancellation to the
original core cancellation ID and delegates manual/reconnect policy to Rust.
It publishes a `ConnectedDevice` only after exact serial verification, never
selects by display name, and routes status bytes through `CoreModelMapper`.

- [ ] **Step 4: Run focused and shared connection gates**

Run:

```bash
platforms/android/gradlew -p platforms/android :sdk:testDebugUnitTest --tests '*BotaDeviceClientTest' --tests '*DeviceManagerTest'
cargo test -p bota-device-sdk-core --test connection_workflow
```

Expected: Kotlin lifecycle and public connection behavior follow the canonical
reducer.

- [ ] **Step 5: Commit**

```bash
git add ARCHITECTURE.md platforms/android
git commit -m "feat(android): expose connection workflows" \
  -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
```

### Task 9: Expose Provisioning and Authenticated Reset Safely

**Files:**
- Create: `platforms/android/sdk/src/main/kotlin/dev/bota/sdk/ProvisioningManager.kt`
- Create: `platforms/android/sdk/src/main/kotlin/dev/bota/sdk/FactoryResetManager.kt`
- Create: `platforms/android/sdk/src/main/kotlin/dev/bota/sdk/model/SecurityModels.kt`
- Create: `platforms/android/sdk/src/test/kotlin/dev/bota/sdk/ProvisioningManagerTest.kt`
- Create: `platforms/android/sdk/src/test/kotlin/dev/bota/sdk/FactoryResetManagerTest.kt`
- Modify: `platforms/android/README.md`
- Modify: `ARCHITECTURE.md`

**Interfaces:**
- Consumes: application material providers, durable reset journal, shared codecs, provisioning/reset reducers, and current binding generation.
- Produces: `provision`, `writeConnectionSettings`, `deprovision`, `factoryReset`, and `resumePendingFactoryReset` suspend APIs.

- [ ] **Step 1: Write failing secure-lifecycle tests**

Tests prove nonce/device key reads precede material resolution; subscribe
precedes grant write; oversize material fails before mutation; Bota Note strips
cellular settings; deprovision sends only the remove command; reset persists the
exact three-byte success before receipt; restart sends receipt only; stale
binding generation is rejected before Rust starts; and cancellation removes
material registrations without deleting a valid durable result.

- [ ] **Step 2: Run security tests and verify RED**

Run:

```bash
platforms/android/gradlew -p platforms/android :sdk:testDebugUnitTest --tests '*ProvisioningManagerTest' --tests '*FactoryResetManagerTest'
```

Expected: FAIL because secure-lifecycle managers do not exist.

- [ ] **Step 3: Implement opaque material and receipt flows**

Register each application callback under a random material/grant ID. Keep
tokens, endpoint bytes, nonces, public keys, command grants, and receipt URLs in
Android memory/host registries. Expose deprovision and factory reset as separate
methods. On restart, compare the journal's command ID and binding generation
with the application-supplied current generation before running only the resume
receipt command.

- [ ] **Step 4: Run Kotlin and Rust security gates**

Run:

```bash
platforms/android/gradlew -p platforms/android :sdk:testDebugUnitTest --tests '*ProvisioningManagerTest' --tests '*FactoryResetManagerTest'
cargo test -p bota-device-sdk-core --test provisioning_workflow --test factory_reset_workflow
```

Expected: ordering, cancellation, and restart behavior match the shared core.

- [ ] **Step 5: Commit**

```bash
git add ARCHITECTURE.md platforms/android
git commit -m "feat(android): expose secure device lifecycle" \
  -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
```

### Task 10: Expose Recording, Upload Ownership, OTA, and Logs

**Files:**
- Create: `platforms/android/sdk/src/main/kotlin/dev/bota/sdk/RecordingManager.kt`
- Create: `platforms/android/sdk/src/main/kotlin/dev/bota/sdk/OTAManager.kt`
- Create: `platforms/android/sdk/src/main/kotlin/dev/bota/sdk/DeviceLogManager.kt`
- Create: `platforms/android/sdk/src/test/kotlin/dev/bota/sdk/RecordingManagerTest.kt`
- Create: `platforms/android/sdk/src/test/kotlin/dev/bota/sdk/OTAManagerTest.kt`
- Create: `platforms/android/sdk/src/test/kotlin/dev/bota/sdk/DeviceLogManagerTest.kt`
- Modify: `platforms/android/README.md`
- Modify: `ARCHITECTURE.md`

**Interfaces:**
- Consumes: recording transfer, upload handoff, firmware update, and device-log reducers plus Android file/network hosts.
- Produces: typed `Flow` progress/events and Android-native completed recording/firmware resources.

- [ ] **Step 1: Write failing workflow facade tests**

Recording cases cover durable append before ACK, replay deduplication, CRC32
failure without delete, final ACK before confirm, opaque encrypted bytes, sink
cleanup, and BLE fallback only after fresh inactive status. OTA covers streamed
download, eight-packet windows, retry from device offset zero with one host
blob, reboot/reconnect, target-version readback, and registration cleanup. Logs
cover subscribe-before-start, fragmented UTF-8, sequence gaps, one owner,
stop-before-unsubscribe, and disconnect cleanup without a BLE stop write.

- [ ] **Step 2: Run manager tests and verify RED**

Run:

```bash
platforms/android/gradlew -p platforms/android :sdk:testDebugUnitTest --tests '*RecordingManagerTest' --tests '*OTAManagerTest' --tests '*DeviceLogManagerTest'
```

Expected: FAIL because the managers do not exist.

- [ ] **Step 3: Implement typed manager flows**

Map core progress directly into sealed Kotlin events. Completed recording
events expose the application-registered destination as a `Uri` or file handle,
not raw recording bytes. Upload ownership returns only device-completed,
device-preserved, or BLE-fallback results for opaque IDs. Firmware sources stay
in one native blob across retries. Logs expose only complete sanitized lines.
All managers share one facade operation coordinator and release ownership on
completion, failure, cancellation, collector termination, and destroy.

- [ ] **Step 4: Run facade and reducer workflow gates**

Run:

```bash
platforms/android/gradlew -p platforms/android :sdk:testDebugUnitTest --tests '*RecordingManagerTest' --tests '*OTAManagerTest' --tests '*DeviceLogManagerTest'
cargo test -p bota-device-sdk-core --test recording_transfer_workflow --test upload_handoff_workflow --test firmware_update_workflow --test device_logs_workflow
```

Expected: all four facade families match their canonical reducers.

- [ ] **Step 5: Commit**

```bash
git add ARCHITECTURE.md platforms/android
git commit -m "feat(android): expose transfer ota and logs" \
  -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
```

### Task 11: Add Legacy Migration Shims and an Unrelated Consumer

**Files:**
- Create: `protocol/baseline/android-sdk-0f06d2a-public-api.txt`
- Create: `tools/android/capture-legacy-api.sh`
- Create: `tools/android/verify-legacy-api.sh`
- Create: `platforms/android/sdk/src/main/kotlin/com/bota/sdk/CompatibilityClient.kt`
- Create: `platforms/android/sdk/src/main/kotlin/com/bota/sdk/CompatibilityManagers.kt`
- Create: `platforms/android/sdk/src/main/kotlin/com/bota/sdk/CompatibilityModels.kt`
- Create: `platforms/android/sdk/src/main/kotlin/com/bota/sdk/CompatibilityProtocol.kt`
- Create: `platforms/android/sdk/src/test/kotlin/com/bota/sdk/CompatibilityContractTest.kt`
- Create: `platforms/android/sdk/api/sdk.api`
- Create: `tests/conformance/android-legacy-consumer/settings.gradle.kts`
- Create: `tests/conformance/android-legacy-consumer/build.gradle.kts`
- Create: `tests/conformance/android-legacy-consumer/app/build.gradle.kts`
- Create: `tests/conformance/android-legacy-consumer/app/src/main/AndroidManifest.xml`
- Create: `tests/conformance/android-legacy-consumer/app/src/main/kotlin/dev/bota/legacy/FrozenLegacyConsumer.kt`
- Create: `tests/conformance/android-legacy-consumer/app/src/androidTest/kotlin/dev/bota/legacy/LegacyBinaryConsumerTest.kt`
- Create: `tests/conformance/android-consumer/settings.gradle.kts`
- Create: `tests/conformance/android-consumer/build.gradle.kts`
- Create: `tests/conformance/android-consumer/app/build.gradle.kts`
- Create: `tests/conformance/android-consumer/app/src/main/AndroidManifest.xml`
- Create: `tests/conformance/android-consumer/app/src/main/kotlin/dev/bota/example/MainActivity.kt`
- Create: `tests/conformance/android-consumer/app/src/androidTest/kotlin/dev/bota/example/AndroidConsumerTest.kt`
- Create: `tools/android/test-consumer.sh`
- Create: `tools/android/test-legacy-consumer.sh`
- Create: `docs/migration/android.md`
- Modify: `platforms/android/sdk/build.gradle.kts`
- Modify: `README.md`
- Modify: `platforms/android/README.md`

**Interfaces:**
- Consumes: public signatures from Android baseline `0f06d2a22c55e4976778520cce42230d23ca4226` and a locally published Maven repository.
- Produces: a generated/frozen JVM signature inventory, one-major deprecated
  `com.bota.sdk` compatibility layer, a frozen legacy consumer, and a clean new
  consumer that resolves only `dev.bota:bota-android-sdk`.

- [ ] **Step 1: Generate and freeze the legacy API inventory**

`capture-legacy-api.sh --legacy-path "$BOTA_LEGACY_ANDROID_PATH"` first requires
the checkout to be clean and exactly at
`0f06d2a22c55e4976778520cce42230d23ca4226`. It builds the baseline AAR, extracts
`classes.jar`, and writes a path-free, locale-stable dump using
`javap -public -s -constants`. Include constructors, getters/setters, companion
members, default-argument bridges, `copy`/`componentN` members, enum entries, and
method descriptors; sort only at class-block boundaries so overloads remain
visible. Review and commit the generated output as
`protocol/baseline/android-sdk-0f06d2a-public-api.txt`. A normal gate runs the
same command to a temporary file and compares it byte-for-byte; it never
regenerates the baseline silently.

The frozen inventory must contain these public families from the pinned commit:

- `BotaClient`, `BotaConfig`, `SdkState`, `LogLevel`, all four
  `BotaSdkException` variants, and `BotaClient.shared`;
- `BluetoothTransport`, `UnimplementedBluetoothTransport`, `BluetoothState`,
  and `ScanOptions`;
- `DeviceManager`, `RecordingManager`, `OtaManager`, `BotaProtocol`, and
  `BotaSdkVersion`;
- all enum entries for `DeviceType`, `PairingState`, `ConnectionState`,
  `DeviceState`, `LteStatus`, `WifiRadioStatus`, `AudioCodec`,
  `TransferPacketType`, `ConnectionType`, and `SyncStage`;
- exact constructors and properties for `DeviceFlags`, `ModemInfo`,
  `DeviceStatus`, `DeviceRecording`, `TransferPacket`, `EnabledConnections`,
  `PowerManagement`, `DeviceConnectionSettings`, `DiscoveredDevice`,
  `ConnectedDevice`, `UploadInfo`, and `SyncProgress`.

Pin Kotlin Binary Compatibility Validator 0.18.1. `apiDump` creates
`platforms/android/sdk/api/sdk.api`; review it once, then `apiCheck` protects
both `com.bota.sdk` and `dev.bota.sdk`. `verify-legacy-api.sh` separately compares
only the `com.bota.sdk` JVM descriptors in the new AAR with the generated legacy
inventory, so a broad new-surface dump cannot hide a legacy binary break.

- [ ] **Step 2: Freeze source and binary consumer failures**

`FrozenLegacyConsumer.kt` is copied from executable calls generated from the
inventory, not maintained as a hand-selected sample. It constructs every public
type, reads every public property, references every enum entry and constant,
calls every manager/protocol/client method with and without each default
argument, implements every `BluetoothTransport` member, and exercises
`BotaClient.shared`. Keep the generated source checked in and reject drift from
the inventory.

The gate runs the fixture in two modes:

1. **Source:** compile `FrozenLegacyConsumer.kt` directly against the replacement
   AAR.
2. **Binary:** compile it against the pinned legacy AAR, then package and execute
   that already-compiled bytecode with only the replacement AAR at runtime. Any
   missing JVM descriptor fails as `NoSuchMethodError`, `NoSuchFieldError`, or
   linkage failure.

The unrelated `android-consumer` compiles only the new `dev.bota.sdk` API from
the local Maven repository and must not import JNI/internal packages or depend
on the project source tree.

- [ ] **Step 3: Run compatibility gates and verify RED**

Run:

```bash
tools/android/capture-legacy-api.sh --legacy-path "$BOTA_LEGACY_ANDROID_PATH" \
  --check protocol/baseline/android-sdk-0f06d2a-public-api.txt
platforms/android/gradlew -p platforms/android :sdk:apiCheck
tools/android/verify-legacy-api.sh --legacy-path "$BOTA_LEGACY_ANDROID_PATH"
tools/android/test-legacy-consumer.sh --api 26 --mode source
tools/android/test-legacy-consumer.sh --api 26 --mode binary
tools/android/test-consumer.sh --api 26
```

Expected: baseline capture succeeds, then API comparison and both consumers fail
because compatibility wrappers and the Maven consumers are absent.

- [ ] **Step 4: Implement the exact adapter and unsupported map**

Ship deprecated wrappers in package `com.bota.sdk` inside the new AAR so a
Kotlin app can replace its dependency before changing imports. Delegate to
`dev.bota.sdk` and annotate every wrapper with a concrete `ReplaceWith` target.
Do not publish a second or legacy coordinate. Document that applications must
remove the old AAR before adding the replacement because both define
`com.bota.sdk` classes.

Freeze this mapping in `docs/migration/android.md` and
`CompatibilityContractTest`:

| Legacy surface | Replacement behavior |
|---|---|
| `BotaClient.state`, `bluetoothState`, `config`, `isBluetoothReady`, and `isInitialized` | Read-only snapshots adapted from the new lifecycle/connection state while preserving the legacy mutable-property JVM accessors and private setters. |
| `configure` and `waitForBluetooth` | Suspend delegation to `BotaDeviceClient.configure` and the power-state flow with the exact legacy defaults and timeout behavior. |
| `DeviceManager.currentBluetoothState`, `startScan`, `stopScan`, `connect`, `disconnect`, `isConnected`, `getStatus`, and `subscribeToStatus` | Exact adapters to the native BluetoothGatt-backed manager; legacy/new device and status models convert explicitly in both directions. |
| `DeviceManager.provision` | Registers the token and environment as one-use in-memory provisioning material, delegates the Rust provisioning workflow, and removes the material in `finally`; no Bota API call or persistence. |
| `DeviceManager.writeConnectionSettings` | Converts the complete legacy settings model and delegates the Rust-owned settings workflow. |
| `RecordingManager.listRecordings`, `syncRecording`, and `confirmSync` | Delegate list/transfer/confirm workflows; `UploadInfo` becomes an ephemeral application-authorized destination registration and is removed on completion/cancel/failure. |
| `OtaManager.destroy` | Uses the shared compatibility lifecycle close path; no OTA operation existed in the baseline manager. |
| All listed enums and data classes | Preserve every constructor, default, property mutability, enum entry, `copy`, and `componentN` descriptor; conversion is exhaustive and unknown new values map to the documented legacy `ERROR`/`UNKNOWN` value or a stable exception where no sentinel exists. |
| `BotaSdkVersion.current` | Generate the exact `public const val` literal from `sdk-version.toml` so the static JVM field shape and synchronized value are preserved; release-readiness rejects drift, and docs warn that already-inlined constants retain their original compile-time value. |
| `BotaProtocol` UUID constants | Preserve the exact constant names and values. |
| `BotaProtocol.parseDeviceStatus`, `parseRecordingEntry`, `parseTransferPacket`, and `serializeConnectionSettings` | Preserve signatures but throw `BotaSdkException.UnsupportedOperation("Raw protocol helpers moved to the Rust core")`; do not copy the legacy parser/serializer into Kotlin or add an unreviewed C ABI. |
| A caller-supplied `BluetoothTransport`, direct standalone manager construction, and non-default `backgroundSyncEnabled`, `wifiOnlyUpload`, or `debug` | Preserve source/binary signatures but fail during `configure`/first operation with a field-specific `UnsupportedOperation`; the default `UnimplementedBluetoothTransport` sentinel selects the supported native BluetoothGatt host. `environment` and `logLevel` remain supported. |

Define lifecycle semantics rather than hiding suspend work behind `runBlocking`:

- legacy synchronous `stopScan()` posts an immediate idempotent cancellation to
  the HandlerThread and updates the scan snapshot before return;
- legacy synchronous `isConnected()` reads the connection `StateFlow` snapshot
  and never starts I/O;
- legacy synchronous manager `destroy()` methods release only their facade
  subscriptions and are idempotent;
- legacy synchronous `BotaClient.destroy()` atomically marks the compatibility
  facade uninitialized, rejects new operations, cancels flows, and starts the
  same internal close operation used by suspending `BotaDeviceClient.destroy()`.
  It does not block the main thread or send a device mutation. Native teardown
  finishes on the confined runtime dispatcher; a later `configure()` awaits that
  teardown before creating another handle. The suspending new API awaits full
  teardown before returning.

Test repeated destroy, destroy during scan/connection/transfer, reconfigure after
legacy destroy, no callbacks after return, and no leaked JNI handles. These
semantics are part of the one-major migration contract.

The unrelated new app resolves from `target/android-m2`, imports the public API,
configures a test context, loads JNI on API 26 and API 35 emulators, checks
`VERSION_NAME`, and type-checks scan, reconnect, provisioning, reset, recording,
upload ownership, OTA, logs, cancellation, and suspending destroy.

- [ ] **Step 5: Run binary, source, migration, and consumer gates**

Run:

```bash
tools/android/capture-legacy-api.sh --legacy-path "$BOTA_LEGACY_ANDROID_PATH" \
  --check protocol/baseline/android-sdk-0f06d2a-public-api.txt
platforms/android/gradlew -p platforms/android :sdk:apiCheck \
  :sdk:testDebugUnitTest --tests '*CompatibilityContractTest'
tools/android/verify-legacy-api.sh --legacy-path "$BOTA_LEGACY_ANDROID_PATH"
for api in 26 35; do
  tools/android/test-legacy-consumer.sh --api "$api" --mode source
  tools/android/test-legacy-consumer.sh --api "$api" --mode binary
  tools/android/test-consumer.sh --api "$api"
done
```

Expected: the generated legacy inventory is unchanged; `apiCheck`, exact JVM
descriptor comparison, source recompilation, and precompiled binary execution
pass; both consumers load JNI from the replacement AAR and report ABI v1 on API
26 and API 35; every unsupported legacy path returns the documented stable
exception.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/migration/android.md platforms/android protocol/baseline \
  tests/conformance/android-consumer tests/conformance/android-legacy-consumer \
  tools/android
git commit -m "feat(android): add consumer and migration contract" \
  -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
```

### Task 12: Generate Maven and Release-Manifest v2 Evidence

**Files:**
- Create: `tools/android/package-release.sh`
- Create: `tools/android/verify-publication.sh`
- Create: `tools/android/test-publication-graphs.sh`
- Create: `tools/android/normalize-central-repository.mjs`
- Create: `tools/android/normalize-central-repository.test.mjs`
- Create: `tools/android/build-central-bundle.mjs`
- Create: `tools/android/build-central-bundle.test.mjs`
- Create: `tools/release/generate-android-sbom.mjs`
- Create: `tools/release/generate-android-sbom.test.mjs`
- Create: `tools/release/generate-native-manifest.mjs`
- Create: `tools/release/generate-native-manifest.test.mjs`
- Create: `release/evidence/1.1.0-android-facade.md`
- Modify: `tools/release/generate-apple-manifest.mjs`
- Modify: `tools/release/generate-apple-manifest.test.mjs`
- Modify: `platforms/android/sdk/build.gradle.kts`
- Modify: `platforms/android/gradle.properties`
- Create: `platforms/android/gradle/verification-metadata.xml`
- Modify: `scripts/check-licenses.mjs`
- Modify: `docs/releasing.md`
- Modify: `ARCHITECTURE.md`

**Interfaces:**
- Consumes: tested AAR, sources/Dokka JARs, POM/module metadata, Rust/Gradle dependency metadata, protocol fixture digest, compatibility matrix, and root `LICENSE`.
- Produces: deterministic Android release directory, SPDX 2.3 SBOM, checksums, complete Maven Central metadata, and a schema-valid version 2 native manifest.

- [ ] **Step 1: Write failing release-metadata tests**

Require Android artifact metadata:

```javascript
assert.equal(android.platform, 'android');
assert.equal(android.packageIdentifier, 'dev.bota:bota-android-sdk');
assert.equal(android.ecosystem, 'maven');
assert.equal(android.version, sdkVersion);
assert.match(android.name, /^bota-android-sdk-.+\.aar$/);
```

SBOM tests require the Kotlin facade, Rust core/FFI, both native libraries, all
four ABI paths, Gradle runtime dependencies, MIT license, artifact SHA-256, and
no local paths. POM tests require exact coordinates, name, description, URL,
license, developer, SCM, sources, Dokka JAR, and no dynamic dependency version.
Central-bundle tests require one `maven` publication with exactly five primary
files, a detached signature for each primary, four checksum sidecars for each
primary, a deterministic complete inventory, and no unrecorded ZIP entry.
Publication-graph tests require the unsigned local, protected-without-key, and
protected-with-ephemeral-key cases. Normalization tests distinguish Gradle's raw
repository files from the canonical 30-file Portal tree.

- [ ] **Step 2: Run release tests and verify RED**

Run:

```bash
node --test tools/android/normalize-central-repository.test.mjs \
  tools/android/build-central-bundle.test.mjs \
  tools/release/generate-android-sbom.test.mjs \
  tools/release/generate-native-manifest.test.mjs
tools/android/test-publication-graphs.sh
```

Expected: FAIL because Android release generators do not exist.

- [ ] **Step 3: Configure deterministic Maven publication**

Use Vanniktech Maven Publish 0.35.0 to create one publication named `maven` for
`dev.bota:bota-android-sdk`. Configure `androidSingleVariant("release")` with
sources and Dokka JARs and the full POM. The unsigned `Local` file repository at
`target/android-m2` is unconditional. Signing and the separately rooted
`CentralRaw` repository at `target/android-central-raw` exist only when the
Gradle property `botaProtectedSigning` is present with the exact value `true`;
absence means unsigned mode and any other value is an error. Never call
`signAllPublications()` in unsigned mode.

In protected mode, require nonblank Gradle properties `signingInMemoryKey` and
`signingInMemoryKeyPassword` before applying `signAllPublications()` or creating
the raw directory. The release workflow maps protected secrets into
`ORG_GRADLE_PROJECT_signingInMemoryKey` and
`ORG_GRADLE_PROJECT_signingInMemoryKeyPassword`; an optional key ID uses
`ORG_GRADLE_PROJECT_signingInMemoryKeyId`. Never put key material in command
arguments, files, artifacts, build scans, or logs. Wire the two graphs explicitly:

```kotlin
val protectedSigningProperty = providers.gradleProperty("botaProtectedSigning")
val protectedSigning = protectedSigningProperty.map { value ->
    if (value != "true") throw GradleException("botaProtectedSigning must be exactly true")
    true
}.orElse(false)

publishing.repositories.maven {
    name = "Local"
    url = rootProject.layout.projectDirectory.dir("../../target/android-m2").asFile.toURI()
}

if (protectedSigning.get()) {
    val key = providers.gradleProperty("signingInMemoryKey").orNull
    val password = providers.gradleProperty("signingInMemoryKeyPassword").orNull
    if (key.isNullOrBlank() || password.isNullOrBlank()) {
        throw GradleException("protected Android staging requires in-memory signing key and password")
    }
    mavenPublishing { signAllPublications() }
    publishing.repositories.maven {
        name = "CentralRaw"
        url = rootProject.layout.projectDirectory
            .dir("../../target/android-central-raw").asFile.toURI()
    }
    val cleanRaw = tasks.register<Delete>("cleanCentralRawRepository") {
        delete(rootProject.layout.projectDirectory.dir("../../target/android-central-raw"))
    }
    val sign = tasks.named("signMavenPublication") { mustRunAfter(cleanRaw) }
    val publishRaw = tasks.named("publishMavenPublicationToCentralRawRepository") {
        dependsOn(sign)
        mustRunAfter(cleanRaw)
    }
    tasks.register("stageSignedCentralRawRepository") {
        dependsOn(cleanRaw, publishRaw)
    }
} else {
    tasks.register("stageSignedCentralRawRepository") {
        doFirst { throw GradleException("use -PbotaProtectedSigning=true in the protected release job") }
    }
}
```

`test-publication-graphs.sh` forbids `set -x`, unsets all three in-memory signing
properties, and exercises these exact cases with isolated target directories:

1. Default graph: assert `signMavenPublication` and
   `publishMavenPublicationToCentralRawRepository` are absent, then run
   `:sdk:publishMavenPublicationToLocalRepository` successfully without a key and
   prove the local repository contains no `.asc` file.
2. Protected graph without material: run
   `-PbotaProtectedSigning=true :sdk:stageSignedCentralRawRepository`, require the
   exact missing-key/password error and nonzero status, and prove
   `target/android-central-raw` was never created or is empty.
3. Protected graph with material: create a password-protected ephemeral PGP key
   in a mode-`0700` temporary `GNUPGHOME`, export it only into the two
   `ORG_GRADLE_PROJECT_*` environment variables for one process, run
   `-PbotaProtectedSigning=true :sdk:stageSignedCentralRawRepository`, verify all
   five signatures with the ephemeral public key, then remove the keyring and
   variables in a `trap`. No test or release key is committed.

Task 12 runs before the coordinated `1.1.0` authority bump in Task 15. Read the
current `SDK_VERSION` from `sdk-version.toml` for every real Gradle staging,
normalization, bundle, and inventory assertion in this task; do not hard-code
`1.1.0` in a real artifact path or command before Task 15 changes the authority.
The raw version directory must contain these five primary files and one `.asc`
for each, using that current value:

```text
bota-android-sdk-${SDK_VERSION}.aar
bota-android-sdk-${SDK_VERSION}.pom
bota-android-sdk-${SDK_VERSION}.module
bota-android-sdk-${SDK_VERSION}-sources.jar
bota-android-sdk-${SDK_VERSION}-javadoc.jar
```

Gradle 8.13 also emits `.md5`, `.sha1`, `.sha256`, and `.sha512` for each of
those ten files. `normalize-central-repository.mjs` must validate the exact 50
version-directory files and every checksum's syntax and recomputed value. It
also parses and validates Gradle's single coordinate-level `maven-metadata.xml`
plus its four checksum sidecars, then rejects any other file anywhere under the
raw root. Metadata and signature-checksum files are valid raw Gradle output but
are never copied into the Portal tree.

The normalizer deletes and recreates only the exact separately rooted
`target/android-central-portal` directory after checking that it is beneath the
repository `target/` root. It copies the five primaries and five signatures from
raw staging, reparses POM/module coordinates, and generates and verifies
`.md5`, `.sha1`, `.sha256`, and `.sha512` for each primary: exactly 20 primary
checksum files. It must finish with exactly 30 files and no metadata or `.asc.*`
checksum. `build-central-bundle.mjs`
accepts only that normalized Portal root and writes
`central-bundle-files.json` with schema version, coordinate, version, source
revision, and a path-sorted `files` array containing relative Maven path, role,
byte length, and SHA-256 for every entry. The inventory is not in the ZIP.

Build the ZIP from that inventory only, in sorted path order, with UTF-8 relative
paths, mode `0644`, fixed DOS timestamp `1980-01-01T00:00:00Z`, no directory
entries, no comments, and no extra fields. Use a repository-pinned Node ZIP
dependency. Unit tests cover raw checksum corruption, missing/extra/renamed files,
unexpected metadata, wrong coordinates, traversal, duplicate ZIP names, and
Portal byte/digest mismatch. The third graph case is the integration test: feed
its real Gradle 8.13 signed raw repository through normalization and bundle build,
assert raw and Portal inventories are exactly 55 and 30 files respectively,
build twice with the same raw bytes, compare ZIP bytes, compare `unzip -Z1` to the
inventory, and compare every extracted byte/digest to the normalized source.
Dependency lockfiles and verification metadata pin all dependencies.

The protected signed-bundle producer is exactly:

```bash
SDK_VERSION="$(sed -n 's/^version = "\([^"]*\)"$/\1/p' sdk-version.toml)"
test -n "$SDK_VERSION"
platforms/android/gradlew -p platforms/android \
  -PbotaProtectedSigning=true \
  :sdk:stageSignedCentralRawRepository \
  --no-daemon --no-parallel --no-configuration-cache
node tools/android/normalize-central-repository.mjs \
  --raw-repository target/android-central-raw \
  --portal-repository target/android-central-portal \
  --coordinate dev.bota:bota-android-sdk \
  --version "$SDK_VERSION"
node tools/android/build-central-bundle.mjs build \
  --repository target/android-central-portal \
  --coordinate dev.bota:bota-android-sdk \
  --version "$SDK_VERSION" \
  --source-revision "$(git rev-parse HEAD)" \
  --inventory target/android-release/central-bundle-files.json \
  --output target/android-release/central-bundle.zip
node tools/android/build-central-bundle.mjs verify \
  --repository target/android-central-portal \
  --inventory target/android-release/central-bundle-files.json \
  --zip target/android-release/central-bundle.zip
```

- [ ] **Step 4: Generate one version 2 native release manifest**

Refactor the Apple-specific manifest assembly behind
`generateNativeManifest({ sdkVersion, sourceRevision, artifacts, baseline,
compatibility })` while preserving `generateAppleManifest` compatibility. The
manifest contains Apple and Android entries only when their exact package
artifacts are supplied. Android capabilities come from reviewed Android facade
evidence, never from Rust-only compatibility status.

`package-release.sh --check` is check-only: it requires a clean tree, builds
twice, compares AAR/native-library digests, emits only under `target/`, creates
the local Maven layout by invoking only
`:sdk:publishMavenPublicationToLocalRepository` with `botaProtectedSigning`
absent and all signing variables unset, copies `LICENSE`, writes checksums, and
generates the SBOM and version 2 manifest. Assert the task graph contains no
`Sign` task and the local repository contains no signature. It never changes
tracked release metadata. Reject dirty source, local paths, zero checksums,
version drift, missing ABI entries, an unreviewed Android capability, or a
manifest `sourceRevision` different from `git rev-parse HEAD`.

- [ ] **Step 5: Validate the complete unpublished package**

Run:

```bash
npm run test:release
tools/android/test-publication-graphs.sh
tools/android/package-release.sh --check
tools/android/verify-publication.sh target/android-release
cargo xtask release validate target/android-release/release-manifest.json
npm run check
```

Expected: two clean builds match; AAR, POM, Gradle module metadata, sources,
Dokka, license, SBOM, MD5/SHA-1/SHA-256/SHA-512 files, and manifest validate;
the source revision is the clean HEAD; no tracked file changes; unsigned local
publication succeeds without a key; protected staging fails without both key
and password and succeeds with its ephemeral key; and real Gradle raw output
normalizes to the exact deterministic 30-entry signed ZIP.

- [ ] **Step 6: Commit**

```bash
git add ARCHITECTURE.md docs/releasing.md platforms/android scripts tools/android tools/release release/evidence
git commit -m "build(android): generate maven release evidence" \
  -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
```

### Task 13: Add Android CI, Emulator, and License Gates

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/license-gate.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `tools/xtask/tests/release_readiness.rs`
- Modify: `CONTRIBUTING.md`
- Modify: `platforms/android/README.md`
- Modify: `docs/releasing.md`

**Interfaces:**
- Consumes: pinned Android toolchain, Gradle lock/verification data, real AAR, and unrelated consumer.
- Produces: non-publishing CI artifacts and release jobs that cannot publish before every prerequisite succeeds.

- [ ] **Step 1: Write failing workflow assertions**

Extend release-readiness tests to require JDK 17, Android SDK 36, NDK
28.2.13676358, all four Rust targets, package/consumer scripts, an API-26 x86
emulator lane, an API-35 x86_64 emulator lane, JNI conformance in both lanes,
AAR upload, Central secrets only inside `environment: release`, manifest v2
validation, and post-publication Maven consumers on both APIs. Assert PR/push CI
contains no publish task and no signing/Central credential reference.

- [ ] **Step 2: Run workflow tests and verify RED**

Run:

```bash
cargo test -p xtask --test release_readiness
```

Expected: FAIL because CI has no Android jobs.

- [ ] **Step 3: Add non-publishing Android CI**

On Ubuntu, install JDK 17, platform 36, build-tools 35.0.0, NDK
28.2.13676358, CMake 3.22.1, and these exact Android Emulator CLI lanes:

| Lane | SDK Manager image | AVD name | Native ABI |
|---|---|---|---|
| Minimum runtime | `system-images;android-26;google_apis;x86` | `bota-api-26` | `x86` |
| Current runtime | `system-images;android-35;google_apis;x86_64` | `bota-api-35` | `x86_64` |

Use SDK Manager, `avdmanager`, and `emulator -no-window -no-audio -no-boot-anim`
through `tools/android/test-package.sh --api <26|35>` and
`tools/android/test-consumer.sh --api <26|35>`. Do not model API 26 as a Gradle
managed virtual device because that feature supports API 27 and newer. Each lane
waits for `sys.boot_completed=1`, disables animations, installs fresh test and
consumer APKs, and always deletes the AVD. API 26 runs legacy location permission,
JNI loading, lifecycle, concrete storage, fixture/workflow instrumentation,
legacy source/binary consumers, and the unrelated Maven consumer. API 35 runs
modern Bluetooth permission handling and the same JNI/storage/consumer suites.

Run Gradle unit/lint/assemble and Rust Android cross-build once, inspect all four
AAR ABIs once, then feed the same immutable AAR and local Maven repository to
both emulator lanes. Upload `target/android-release/` only as a CI artifact.
Cache Gradle and Rust inputs by lockfile/toolchain digest; never cache AVD data
or signing material.

The license workflow validates dependency locks, checksums, SPDX output, and
reviewed license policy for Maven dependencies in addition to npm/Cargo.

- [ ] **Step 4: Add gated release assembly without enabling publication**

Add an Android packaging job for `v*.*.*` tags. It runs all Android gates and
uploads the unsigned deterministic payload plus signed-publication inputs. Make
the existing publish job depend on Rust, Apple, and Android verification. Keep
the actual Central upload disabled behind a failing readiness assertion until
Task 15 adds physical evidence and protected credentials.

- [ ] **Step 5: Run local workflow and Android gates**

Run:

```bash
cargo test -p xtask --test release_readiness
platforms/android/gradlew -p platforms/android :sdk:testDebugUnitTest :sdk:lintRelease :sdk:assembleRelease
for api in 26 35; do
  tools/android/test-package.sh --api "$api"
  tools/android/test-legacy-consumer.sh --api "$api" --mode source
  tools/android/test-legacy-consumer.sh --api "$api" --mode binary
  tools/android/test-consumer.sh --api "$api"
done
tools/android/package-release.sh --check
npm run check
```

Expected: local gates plus API-26 x86 and API-35 x86_64 emulator gates pass,
workflow YAML parses, and no command can publish from pull-request or ordinary
`main` CI. A stable release cannot claim API 26+ if either lane is skipped.

- [ ] **Step 6: Commit**

```bash
git add .github CONTRIBUTING.md docs/releasing.md platforms/android tools/xtask
git commit -m "ci(android): verify aar and emulator consumer" \
  -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
```

### Task 14: Execute the Supervised Physical-Device Matrix

**Files:**
- Create: `platforms/android/sdk/src/androidTest/kotlin/dev/bota/sdk/physical/PhysicalTestConfiguration.kt`
- Create: `platforms/android/sdk/src/androidTest/kotlin/dev/bota/sdk/physical/PhysicalReadOnlyTest.kt`
- Create: `platforms/android/sdk/src/androidTest/kotlin/dev/bota/sdk/physical/PhysicalConnectionSettingsTest.kt`
- Create: `platforms/android/sdk/src/androidTest/kotlin/dev/bota/sdk/physical/PhysicalProvisioningTest.kt`
- Create: `platforms/android/sdk/src/androidTest/kotlin/dev/bota/sdk/physical/PhysicalRecordingDeleteTest.kt`
- Create: `platforms/android/sdk/src/androidTest/kotlin/dev/bota/sdk/physical/PhysicalOtaTest.kt`
- Create: `platforms/android/sdk/src/androidTest/kotlin/dev/bota/sdk/physical/PhysicalDeprovisionTest.kt`
- Create: `platforms/android/sdk/src/androidTest/kotlin/dev/bota/sdk/physical/PhysicalFactoryResetFixture.kt`
- Create: `platforms/android/sdk/src/androidTest/kotlin/dev/bota/sdk/physical/PhysicalFactoryResetTest.kt`
- Create: `tools/android/test-physical.sh`
- Create: `tools/android/factory-reset-lab.sh`
- Create: `tools/android/factory-reset-lab.test.mjs`
- Create: `tools/android/verify-physical-prerequisites.mjs`
- Create: `tools/android/verify-physical-prerequisites.test.mjs`
- Create: `protocol/baseline/android-physical-prerequisites.json`
- Create: `docs/testing/android-physical-device.md`
- Modify: `release/evidence/1.1.0-android-facade.md`
- Modify: `protocol/compatibility/firmware-compatibility.json`
- Modify: `protocol/baseline/native-sdks.json`
- Modify: `ARCHITECTURE.md`
- Modify: `README.md`
- Cross-repo prerequisite, firmware owner: create
  `$BOTA_FIRMWARE_PATH/sdk/apps/common/device/bota_factory_reset_lab_inspector.c`
  and `.h`, `$BOTA_FIRMWARE_PATH/scripts/factory_reset_lab.py`,
  `$BOTA_FIRMWARE_PATH/scripts/test_factory_reset_lab.py`, and
  `$BOTA_FIRMWARE_PATH/docs/testing/factory-reset-lab.md`; modify the explicit
  source list, profile targets, and artifacts in
  `$BOTA_FIRMWARE_PATH/sdk/apps/demo_audio/board/wl83/Makefile`, the USB-device
  feature selection in
  `$BOTA_FIRMWARE_PATH/sdk/apps/demo_audio/board/wl83/sdk_config.h`, the profile
  guards/classes in `$BOTA_FIRMWARE_PATH/sdk/apps/demo_audio/include/app_config.h`,
  and the CDC receive/lifecycle owner
  `$BOTA_FIRMWARE_PATH/sdk/apps/common/usb/device/task_pc.c`. Update the owning
  firmware repository's `AGENTS.md`, `ARCHITECTURE.md`, `CLAUDE.md`, `README.md`,
  and `docs/llms.txt` with the lab-only profile, exact artifacts, and supported
  verification commands. Do not modify `cdc.c`: `task_pc.c` already owns CDC
  wakeup dispatch and `usb_start`/`usb_pause` lifecycle integration.
- Cross-repo prerequisite, backend owner: create
  `$BOTA_BACKEND_PATH/api/src/routes/internal/factory-reset-lab/{controller,validation}.ts`,
  `$BOTA_BACKEND_PATH/api/src/middleware/factory-reset-lab-auth.ts`,
  `$BOTA_BACKEND_PATH/api/src/services/factory-reset-lab.service.ts`,
  `$BOTA_BACKEND_PATH/api/src/tools/factory-reset-lab-control.ts`, and
  `$BOTA_BACKEND_PATH/api/tests/integration/factory-reset-lab-control.test.ts`;
  modify the internal route registry and backend operations runbook.

**Interfaces:**
- Consumes: an explicitly selected ADB target, exact Bota serial/model, reviewed and pinned firmware/backend lab-control revisions, the matching lab firmware image, per-case disposable data, a fresh reset-specific artifact fixture, and application-provided test material.
- Produces: auditable Bota Pin and Bota Note evidence; it never runs against an arbitrary nearby device.

- [ ] **Step 1: Land, review, and pin the reset-control prerequisites**

The required inspection/control channels do not exist in the maintained
workspace at plan-writing time. Implement and review them in their owning
repositories before attempting Android factory-reset evidence. The firmware
channel is a versioned, wired USB-CDC lab protocol named
`factory-reset-inspector-v1`. Its authenticated operations are exactly
`create-fixture`, `snapshot`, and `cleanup-fixture`. `create-fixture` may create
only run-ID-prefixed `active`, `complete`, `encrypted`, `sidecar`, and `partial`
objects beneath `RECORDER/`; `snapshot` returns their class, relative-path
digest, size, content digest, and counted-recording flag. It also returns only
presence, count, or fingerprints for the syscfg allowlist: device token, BLE
bonds, WiFi credentials, project key, policy, user settings, serial/model,
and `S_dev` attestation. The same read-only response fingerprints `PK_D` and the
device certificate through their existing identity/file owners without exposing
their bodies. It never returns raw token, WiFi, project-key, `SK_D`, `S_dev`,
private-key, or certificate-body bytes.

Compile that protocol only when
`CONFIG_BOTA_FACTORY_RESET_LAB_INSPECTOR=1`. The maintained WL83 Makefile has an
explicit `c_SRC_FILES` list, a fixed shared `objs/` directory, a fixed
`sdk/cpu/wl83/tools/sdk.elf`, and an unconditional `CONFIG_RELEASE_ENABLE`; the
firmware prerequisite must change all four facts rather than treating
`BOTA_BUILD_PROFILE` as a flag the current build already consumes.

Implement this exact board-build contract. `BOTA_BUILD_PROFILE` accepts only
`production` and `factory-reset-inspector-v1`, defaulting to `production`.
Remove `-DCONFIG_RELEASE_ENABLE` from the unconditional `DEFINES` block and put
it inside the `BOTA_CFLAGS` passed by the default build and each normal
`dev`/`gamma`/`prod` recursive target, preserving today's production behavior.
Concretely, the direct `all` default is
`BOTA_CFLAGS ?= -DCONFIG_RELEASE_ENABLE`; the three environment targets and the
two artifact targets construct their complete recursive `BOTA_CFLAGS`
explicitly.
The phony `factory-reset-lab` target requires `DEBUG=0` and a lowercase 40-hex
`BOTA_BUILD_REVISION`, runs `clean`, removes the fixed generated `jl_isd.ufw`,
then recursively invokes `all` with `DEBUG=0`,
`BOTA_BUILD_PROFILE=factory-reset-inspector-v1`, and these flags actually inside
`BOTA_CFLAGS`:

```make
-DBOTA_DEFAULT_API_ENDPOINT=0
-DCONFIG_BOTA_FACTORY_RESET_LAB_INSPECTOR=1
-DBOTA_FACTORY_RESET_LAB_PROFILE=\"factory-reset-inspector-v1\"
-DBOTA_FACTORY_RESET_LAB_REVISION=\"$(BOTA_BUILD_REVISION)\"
```

Replace the existing `DEBUG=1` USB-device source block with this exact
profile-exclusive `c_SRC_FILES` selection. Keep the existing
`../../../../apps/common/usb/device/usb_device.c` entry in the unconditional
base list; do not move or duplicate it in either branch:

```make
ifeq ($(BOTA_BUILD_PROFILE),factory-reset-inspector-v1)
# The dedicated lab image is DEBUG=0 and exposes CDC without mass storage.
c_SRC_FILES += \
	../../../../apps/common/usb/device/cdc.c \
	../../../../apps/common/usb/device/descriptor.c \
	../../../../apps/common/usb/device/task_pc.c \
	../../../../apps/common/usb/device/user_setup.c \
	../../../../apps/common/device/bota_factory_reset_lab_inspector.c
else ifeq ($(DEBUG),1)
# Restore the vendor USB device sources only for the maintenance image.
c_SRC_FILES += \
	../../../../apps/common/usb/device/cdc.c \
	../../../../apps/common/usb/device/descriptor.c \
	../../../../apps/common/usb/device/msd.c \
	../../../../apps/common/usb/device/msd_upgrade.c \
	../../../../apps/common/usb/device/task_pc.c \
	../../../../apps/common/usb/device/user_setup.c
endif
```

Thus the `DEBUG=0` lab image compiles the existing CDC implementation,
descriptors, lifecycle/receive owner, and setup owner together with the
inspector; `msd.c` and `msd_upgrade.c` remain exclusive to the existing
`DEBUG=1` maintenance image. After the fixed post-build packaging succeeds,
copy the inspectable ELF and flashable UFW to these stable profile-owned paths:

```text
sdk/cpu/wl83/tools/artifacts/factory-reset-inspector-v1/sdk.elf
sdk/cpu/wl83/tools/artifacts/factory-reset-inspector-v1/jl_isd.ufw
```

Add a phony `production-artifact` target that also performs a mandatory clean,
removes the fixed UFW, and recursively uses the exact normal `prod` flags
`-DCONFIG_RELEASE_ENABLE -DBOTA_DEFAULT_API_ENDPOINT=1` with `DEBUG=0` and
`BOTA_BUILD_PROFILE=production`. It copies the independently generated files to:

```text
sdk/cpu/wl83/tools/artifacts/production/sdk.elf
sdk/cpu/wl83/tools/artifacts/production/jl_isd.ufw
```

Both wrapper targets fail if either fixed output is missing or empty before the
copy and set the copied files to mode `0600`, matching the physical prerequisite
gate. The existing ignore rule for `sdk/cpu/wl83/tools/*` keeps these copied
artifacts from dirtying the pinned checkout. Keep `BOTA_EXTRA_CFLAGS` at the end
of each recursive `BOTA_CFLAGS` value so the negative coexistence gate can
exercise the real compiler guard. Do not reuse `objs/`, `sdk.elf`, or
`jl_isd.ufw` across profiles without the mandatory clean/removal sequence, and
never inspect the fixed shared paths after the next profile starts building.

Define `CONFIG_BOTA_FACTORY_RESET_LAB_INSPECTOR` to `0` by default in
`app_config.h`, and fail preprocessing with the literal diagnostic
`CONFIG_BOTA_FACTORY_RESET_LAB_INSPECTOR cannot coexist with CONFIG_RELEASE_ENABLE`
when it is true and `CONFIG_RELEASE_ENABLE` is defined. Also reject coexistence
with `BOTA_USB_OTA_DEBUG`: the inspector is a dedicated CDC-only device profile,
not the `DEBUG=1` CDC-plus-mass-storage maintenance profile. In `sdk_config.h`,
make `TCFG_PC_ENABLE` true for either the existing USB OTA debug profile or the
lab inspector. In `app_config.h`, select `CDC_CLASS` alone for both
`USB_DEVICE_CLASS_CONFIG` values and `USB_PC_NO_APP_MODE=2` for the lab profile;
retain the existing `(CDC_CLASS | MASSSTORAGE_CLASS)` override only for
`BOTA_USB_OTA_DEBUG`. Keep `CONFIG_USB_DEBUG_ENABLE` undefined so the inspector
owns CDC bytes without rerouting `printf` onto the same transport.

Wire the dedicated profile through the actual CDC owner. Under the inspector
compile guard, `task_pc.c` includes the new header; `usb_start()` calls
`bota_factory_reset_lab_usb_attach(usbfd)` and installs
`bota_factory_reset_lab_usb_rx_ready` instead of the generic CFG-tool wakeup;
`usb_pause()` clears the wakeup and calls
`bota_factory_reset_lab_usb_detach(usbfd)` before disabling the SIE. The wakeup
function does no parsing or storage work in interrupt context: it posts to the
inspector-owned RTOS worker, which alone calls `cdc_read_data()` and
`cdc_write_data()`. Production preprocessing contains no reference to those
symbols.

The image exposes the literal profile and exact pinned build revision in an
immutable USB hello/readback envelope before authenticated operations; the host
CLI names this transport check `read-profile`, but it is not a fourth inspector
operation. Readback contains exactly `protocol`, `firmwareRevision`,
`inspectorEnabled`, and `publicKeyFingerprint`, with protocol
`factory-reset-inspector-v1` and `inspectorEnabled=true`. The inspector has no
BLE, WiFi, or LTE command surface. Every authenticated request carries an exact
device serial, run ID, fresh device nonce, expiry, and Ed25519 signature created
with the lab private key from the owner-only control file; the lab image contains
only the pinned public key and its fingerprint. Nonce reuse, expiry, wrong
signature, wrong serial/profile, unknown operation, path outside the run prefix,
or production firmware fails closed. `cleanup-fixture` can delete only artifacts
created for that run ID and cannot write syscfg.

The backend route is registered only when
`BOTA_FACTORY_RESET_LAB_CONTROL=1`, `NODE_ENV` is `test` or `staging`, and a
dedicated lab project/device allowlist is configured; startup fails if the flag
is enabled in production. It requires an audience-restricted service JWT with
scope `factory-reset:lab-control`, run ID, exact project/device/serial, expiry,
and one-use mutation nonce. The service reuses production command/binding
transactions and exposes these versioned operations: `create`, `snapshot`,
`query-audit`, `finalize`, `prepare-newer-bind`, `confirm-newer-bind`,
`replay-stale`, and `cleanup-session`. Snapshots contain the stable device row,
binding generation/status, token active/revoked state, device configuration,
ordered audit sequence, and recording/transcription/summary IDs plus stored
object size/checksum/ETag. Manufacturing fields are returned only as stable IDs
and fingerprints. The lab route cannot delete cloud objects, manufacturing
identity, or arbitrary commands, and every mutation is itself audited.

Run the owning-repository gates before review. Firmware tests create/snapshot/
cleanup against a fake block device and reject unauthorized frames.
`test_factory_reset_lab.py` must also evaluate the Makefile's final
`c_SRC_FILES` membership for each row below and assert every inclusion and
exclusion; it additionally asserts that `usb_device.c` remains in the
unconditional base assignment rather than either conditional branch:

| `DEBUG` | `BOTA_BUILD_PROFILE` | Required in `c_SRC_FILES` | Required absent from `c_SRC_FILES` |
|---|---|---|---|
| `0` | `factory-reset-inspector-v1` | `usb_device.c`, `cdc.c`, `descriptor.c`, `task_pc.c`, `user_setup.c`, `bota_factory_reset_lab_inspector.c` | `msd.c`, `msd_upgrade.c` |
| `1` | `production` | `usb_device.c`, `cdc.c`, `descriptor.c`, `task_pc.c`, `user_setup.c`, `msd.c`, `msd_upgrade.c` | `bota_factory_reset_lab_inspector.c` |
| `0` | `production` | `usb_device.c` | `cdc.c`, `descriptor.c`, `task_pc.c`, `user_setup.c`, `msd.c`, `msd_upgrade.c`, `bota_factory_reset_lab_inspector.c` |

The same test statically locks the remaining Makefile profile/output contract,
dedicated CDC-only macros, `task_pc.c` attach/wakeup/detach dispatch, and the
exact release sentinel. Then, in the configured Linux x86-64 JieLi environment,
build and inspect the real lab target and normal production from separate
mandatory-clean invocations. The copied lab ELF must contain
`bota_factory_reset_lab_usb_attach`, the exact profile, and the pinned revision;
the copied production ELF must contain neither that symbol nor the profile.
Injecting the lab flag into the normal production target must fail with the
exact `CONFIG_RELEASE_ENABLE` preprocessing diagnostic. Both independently
built copied UFW files must be nonempty; the lab UFW at the exact path below is
the only image accepted by `BOTA_LAB_FIRMWARE_IMAGE`. Backend tests cover every
operation, scope/project/device/run/nonce rejection, exact finalize ordering,
stale-generation fencing, cloud/manufacturing immutability, redaction, and
production startup refusal:

```bash
set -euo pipefail

python3 "$BOTA_FIRMWARE_PATH/scripts/test_factory_reset_lab.py"

firmware_revision="$(git -C "$BOTA_FIRMWARE_PATH" rev-parse --verify HEAD)"
firmware_board="$BOTA_FIRMWARE_PATH/sdk/apps/demo_audio/board/wl83"
lab_elf="$BOTA_FIRMWARE_PATH/sdk/cpu/wl83/tools/artifacts/factory-reset-inspector-v1/sdk.elf"
lab_ufw="$BOTA_FIRMWARE_PATH/sdk/cpu/wl83/tools/artifacts/factory-reset-inspector-v1/jl_isd.ufw"
production_elf="$BOTA_FIRMWARE_PATH/sdk/cpu/wl83/tools/artifacts/production/sdk.elf"
production_ufw="$BOTA_FIRMWARE_PATH/sdk/cpu/wl83/tools/artifacts/production/jl_isd.ufw"

make -C "$firmware_board" factory-reset-lab \
  BOTA_BUILD_REVISION="$firmware_revision"
test -s "$lab_elf"
test -s "$lab_ufw"
/opt/jieli/pi32v2/bin/objdump -t "$lab_elf" \
  | rg -n 'bota_factory_reset_lab_usb_attach$'
strings "$lab_elf" | rg -Fx 'factory-reset-inspector-v1'
strings "$lab_elf" | rg -Fx "$firmware_revision"
sha256sum "$lab_ufw"

conflict_log="$(mktemp)"
if make -C "$firmware_board" production-artifact \
  BOTA_EXTRA_CFLAGS=-DCONFIG_BOTA_FACTORY_RESET_LAB_INSPECTOR=1 \
  >"$conflict_log" 2>&1; then
  rm -f "$conflict_log"
  exit 1
fi
rg -F 'CONFIG_BOTA_FACTORY_RESET_LAB_INSPECTOR cannot coexist with CONFIG_RELEASE_ENABLE' \
  "$conflict_log"
rm -f "$conflict_log"

make -C "$firmware_board" production-artifact
test -s "$production_elf"
test -s "$production_ufw"
if /opt/jieli/pi32v2/bin/objdump -t "$production_elf" \
  | rg -n 'bota_factory_reset_lab_'; then
  exit 1
fi
if strings "$production_elf" | rg -F 'factory-reset-inspector-v1'; then
  exit 1
fi
sha256sum "$production_ufw"

npm --prefix "$BOTA_BACKEND_PATH/api" test -- \
  tests/integration/factory-reset-lab-control.test.ts
npm --prefix "$BOTA_BACKEND_PATH/api" run type-check
npm --prefix "$BOTA_BACKEND_PATH/api" run build
```

After both prerequisite changes are separately reviewed, pushed, and green,
write their real 40-hex revisions and review status, the firmware lab profile,
the copied lab ELF and flashable UFW SHA-256 values, backend contract version,
deployment identity, and backend OpenAPI fragment SHA-256 to
`protocol/baseline/android-physical-prerequisites.json`. Do not use symbolic
branches or an `unreviewed` value. `verify-physical-prerequisites.mjs` requires
clean absolute `BOTA_FIRMWARE_PATH`/`BOTA_BACKEND_PATH` checkouts at those exact
commits, proves each commit is contained by its fetched protected main branch,
requires `--firmware-image` to resolve exactly to
`$BOTA_FIRMWARE_PATH/sdk/cpu/wl83/tools/artifacts/factory-reset-inspector-v1/jl_isd.ufw`,
checks both firmware artifact digests plus USB `read-profile` against the pinned
profile/revision/fingerprint, checks contract digests and the live backend
capabilities response, and rejects missing, zero, dirty, divergent, or
unreviewed pins. All Android physical reset runs block before
ADB/Bluetooth/device mutation until this command passes:

```bash
node tools/android/verify-physical-prerequisites.mjs \
  --manifest protocol/baseline/android-physical-prerequisites.json \
  --firmware-path "$BOTA_FIRMWARE_PATH" \
  --backend-path "$BOTA_BACKEND_PATH" \
  --firmware-image "$BOTA_LAB_FIRMWARE_IMAGE" \
  --backend-control-stdin \
  < "$BOTA_ANDROID_RESET_BACKEND_CONTROL_FILE"
```

- [ ] **Step 2: Add opt-in tests that skip before client creation**

Require these selectors for every physical invocation:

| Name | Exact accepted value |
|---|---|
| `BOTA_ANDROID_PHYSICAL_TESTS` | `1` |
| `ANDROID_SERIAL` | one explicit `adb devices` serial |
| `BOTA_DEVICE_SERIAL` | exact serial read back from the selected Bota device |
| `BOTA_DEVICE_MODEL` | `bota-pin` or `bota-note` |

The host script checks that ADB exposes exactly the selected target, validates
model and serial syntax, and passes only the non-secret instrumentation arguments
`botaPhysicalEnabled=1`, `botaPhysicalCase`, `botaDeviceModel`, and
`botaDeviceSerial`; factory reset additionally passes non-secret
`botaPhysicalPhase=reset|rebind|stale-reconcile`, one phase per instrumentation
process. `PhysicalTestConfiguration` requires the exact allowed set and tests
skip before `BotaDeviceClient.configure()` when `botaPhysicalEnabled` is absent.
Each invocation accepts exactly one `--case` and maps it to one test class and
this exact gate/input contract:

| `--case` | Required opt-in | Required private input |
|---|---|---|
| `read-only` | global gate only | none |
| `connection-settings` | `BOTA_ALLOW_CONNECTION_SETTINGS=1` | `BOTA_ANDROID_SETTINGS_MATERIAL_FILE` with JSON member `connectionSettings` |
| `provisioning` | `BOTA_ALLOW_PROVISIONING=1` | `BOTA_ANDROID_PROVISIONING_MATERIAL_FILE` with `provisioning.deviceToken` and `provisioning.environment` |
| `recording-transfer-delete` | `BOTA_ALLOW_RECORDING_DELETE=1` | `BOTA_ANDROID_RECORDING_MATERIAL_FILE` with `recording.uuid`, `recording.expectedSha256`, `upload.url`, and `upload.headers` |
| `ota` | `BOTA_ALLOW_OTA=1` | `BOTA_ANDROID_OTA_MATERIAL_FILE` with `ota.expectedVersion` and `ota.sha256`, plus `BOTA_ANDROID_OTA_IMAGE_FILE` |
| `deprovision` | `BOTA_ALLOW_DEPROVISION=1` | none; the selected device must begin bound |
| `factory-reset` | `BOTA_ALLOW_FACTORY_RESET=1` | `BOTA_ANDROID_RESET_MATERIAL_FILE` reset specification, `BOTA_ANDROID_RESET_DEVICE_CONTROL_FILE` USB lab-signing material, and `BOTA_ANDROID_RESET_BACKEND_CONTROL_FILE` lab URL/JWT/project/device material; also requires absolute `BOTA_FIRMWARE_PATH`, `BOTA_BACKEND_PATH`, `BOTA_LAB_FIRMWARE_IMAGE`, and selected `BOTA_LAB_USB_PORT` |

Unknown cases, missing exact gates, extra `BOTA_ALLOW_*` variables, absent JSON
members, a non-absolute material path, checksum mismatch, or a material/image
file with any group/other permission bit fail before Bluetooth initialization.
Never infer authorization from a combined `BOTA_ALLOW_MUTATION` switch.

Freeze the private-control schemas. `BOTA_ANDROID_RESET_DEVICE_CONTROL_FILE`
contains exactly `protocol`, `publicKeyFingerprint`, and
`privateKeyPkcs8Base64`; the protocol must be `factory-reset-inspector-v1` and
the fingerprint must match the selected lab image readback.
`BOTA_ANDROID_RESET_BACKEND_CONTROL_FILE` contains exactly `baseUrl`,
`contractVersion`, `audience`, `serviceJwt`, `projectId`, and `deviceId`; require
HTTPS, the pinned contract version, audience `factory-reset-lab-control`, an
unexpired JWT, and the selected allowlisted project/device. Reject unknown
members, symlinks, non-owner ownership, or permissions other than `0600`.

For each material-bearing case, `test-physical.sh` builds and installs the test
APK, then streams the owner-readable file through stdin into instrumentation
private storage without putting its contents in a process argument:

```bash
adb -s "$ANDROID_SERIAL" exec-in run-as dev.bota.sdk.test sh -c \
  'umask 077; mkdir -p files/bota-physical; cat > files/bota-physical/material.json' \
  < "$BOTA_ANDROID_CASE_MATERIAL_FILE"
```

The script resolves the case-specific variable from the table into the internal
`BOTA_ANDROID_CASE_MATERIAL_FILE`; that helper name is never a caller input. OTA
bytes are streamed the same way to `files/bota-physical/firmware.bin` after the
host verifies `ota.sha256`. Instrumentation reads only from
`targetContext.filesDir/bota-physical`, parses structured JSON, never logs secret
members, and deletes material in `finally`. A host `trap` removes the directory,
clears `dev.bota.sdk.test`, and asserts the private files are absent after pass,
failure, timeout, or signal. Do not pass tokens, headers, grants, URLs, or file
contents through Gradle `-P`, instrumentation `-e`, shell arguments, BuildConfig,
test names, reports, or logs; `set -x` is forbidden for this script.

For factory reset, `factory-reset-lab.sh` creates a mode-`0700` host run
directory under the system temporary directory with `umask 077`; every request,
response, command/grant, receipt, and snapshot remains mode `0600` there. The lab
private signing key and backend JWT enter the wrapper only by reading the two
owner-only files; downstream tools receive signed or bearer-authenticated request
envelopes only through stdin. The wrapper streams only minimum phase material
into instrumentation private storage and streams receipt output back with
`adb exec-out run-as`; secrets never appear in argv, environment, Gradle
properties, instrumentation arguments, reports, or logs. Its `trap` clears the
test package, removes device fixture artifacts when reset has not already wiped
them, calls backend `cleanup-session`, removes the host run directory, unsets
credential variables, and verifies all app-private/host files are gone on pass,
failure, timeout, or signal.

`BOTA_ANDROID_RESET_MATERIAL_FILE` is a reset specification, not a credential
container. It contains `factoryReset.expectedDeletedCount` and
`fixtureArtifacts[]` entries with a recording ID, artifact class, relative-path
digest, expected pre-reset size/digest, and `countsTowardDeletedCount`. It also
contains the expected pre-reset token,
pairing, WiFi, policy, project-key, and user-settings states; stable cloud
recording/transcription/summary IDs; the stable backend device-row ID; serial,
model, device-public-key and certificate fingerprints; and a `newerBinding`
object with expected next generation, environment, and post-bind settings. The
command ID, binding generation, completion grant, and one-use newer-binding token
are generated by the backend adapter into the private host run directory and
streamed only to the applicable instrumentation phase. The schema requires at least one
entry for each class `active`, `complete`, `encrypted`, `sidecar`, and `partial`.
`expectedDeletedCount` must equal the number of manifest entries marked
`countsTowardDeletedCount`; sidecars and auxiliary partial files are wiped but
do not inflate the firmware's recording count. Secret values and raw artifact
paths remain private material; evidence contains only counts, classes, stable
public IDs, and digests.

After the earlier recording-transfer case has deleted its disposable recording,
the reset case must use newly created IDs and bytes. `factory-reset-lab.sh`
orchestrates these host-only phases; the Android facade never calls the backend
or raw device inspector:

1. `host-prepare` verifies prerequisite pins and image/profile/serial readback,
   creates the backend lab session and pending reset command, creates the
   reset-only device fixture, and captures device/backend `before` snapshots
   before any grant is handed to instrumentation.
2. `instrumentation-reset` streams only the command-bound grant and fixture
   expectations to the test APK, runs the BLE reset through receipt `0x0A`, and
   streams its persisted raw-result/receipt record back to the host.
3. `host-finalize` queries audit/binding/token state first, proving no early
   unbind/revocation, then submits the exact receipt to the backend and captures
   post-finalization audit/state plus post-reset device `RECORDER/`/syscfg state.
4. `instrumentation-rebind` obtains a one-use newer-binding token from the host,
   provisions the physical device, and returns physical acceptance; the host
   confirms the bind and snapshots generation `G + 1`.
5. `instrumentation-stale-reconcile` injects only the saved generation-`G`
   journal into app-private test storage and runs reconciliation. The host calls
   `replay-stale`, queries final audit/device/backend/cloud state, and verifies no
   generation-`G + 1` mutation.
6. `cleanup` removes the scoped lab session/private files and, only if reset did
   not run, the run-ID fixture artifacts. It never restores or fabricates state.

The wrapper creates owner-only request envelopes and executes these exact
low-level create/snapshot/query/finalize commands; subcommand, serial, port, and
phase are non-secret, while each authenticated envelope enters on stdin:

```bash
node "$BOTA_BACKEND_PATH/api/dist/tools/factory-reset-lab-control.js" create \
  --request-stdin < "$RUN_DIR/backend-create.request.json" \
  > "$RUN_DIR/backend-create.json"
python3 "$BOTA_FIRMWARE_PATH/scripts/factory_reset_lab.py" create-fixture \
  --port "$BOTA_LAB_USB_PORT" --serial "$BOTA_DEVICE_SERIAL" --request-stdin \
  < "$RUN_DIR/device-create.request.json" > "$RUN_DIR/device-create.json"
python3 "$BOTA_FIRMWARE_PATH/scripts/factory_reset_lab.py" snapshot \
  --port "$BOTA_LAB_USB_PORT" --serial "$BOTA_DEVICE_SERIAL" --request-stdin \
  < "$RUN_DIR/device-snapshot-before.request.json" > "$RUN_DIR/device-before.json"
node "$BOTA_BACKEND_PATH/api/dist/tools/factory-reset-lab-control.js" snapshot \
  --request-stdin < "$RUN_DIR/backend-snapshot-before.request.json" \
  > "$RUN_DIR/backend-before.json"

node "$BOTA_BACKEND_PATH/api/dist/tools/factory-reset-lab-control.js" query-audit \
  --request-stdin < "$RUN_DIR/backend-query-pre-finalize.request.json" \
  > "$RUN_DIR/backend-pre-finalize.json"
node "$BOTA_BACKEND_PATH/api/dist/tools/factory-reset-lab-control.js" finalize \
  --request-stdin < "$RUN_DIR/backend-finalize.request.json" \
  > "$RUN_DIR/backend-finalize.json"
python3 "$BOTA_FIRMWARE_PATH/scripts/factory_reset_lab.py" snapshot \
  --port "$BOTA_LAB_USB_PORT" --serial "$BOTA_DEVICE_SERIAL" --request-stdin \
  < "$RUN_DIR/device-snapshot-after.request.json" > "$RUN_DIR/device-after.json"
node "$BOTA_BACKEND_PATH/api/dist/tools/factory-reset-lab-control.js" snapshot \
  --request-stdin < "$RUN_DIR/backend-snapshot-after.request.json" \
  > "$RUN_DIR/backend-after.json"

node "$BOTA_BACKEND_PATH/api/dist/tools/factory-reset-lab-control.js" prepare-newer-bind \
  --request-stdin < "$RUN_DIR/backend-newer-prepare.request.json" \
  > "$RUN_DIR/backend-newer-prepare.json"
node "$BOTA_BACKEND_PATH/api/dist/tools/factory-reset-lab-control.js" confirm-newer-bind \
  --request-stdin < "$RUN_DIR/backend-newer-confirm.request.json" \
  > "$RUN_DIR/backend-newer-confirm.json"
node "$BOTA_BACKEND_PATH/api/dist/tools/factory-reset-lab-control.js" replay-stale \
  --request-stdin < "$RUN_DIR/backend-stale-replay.request.json" \
  > "$RUN_DIR/backend-stale-replay.json"
node "$BOTA_BACKEND_PATH/api/dist/tools/factory-reset-lab-control.js" query-audit \
  --request-stdin < "$RUN_DIR/backend-query-final.request.json" \
  > "$RUN_DIR/backend-final.json"
node "$BOTA_BACKEND_PATH/api/dist/tools/factory-reset-lab-control.js" snapshot \
  --request-stdin < "$RUN_DIR/backend-snapshot-final.request.json" \
  > "$RUN_DIR/backend-snapshot-final.json"
python3 "$BOTA_FIRMWARE_PATH/scripts/factory_reset_lab.py" snapshot \
  --port "$BOTA_LAB_USB_PORT" --serial "$BOTA_DEVICE_SERIAL" --request-stdin \
  < "$RUN_DIR/device-snapshot-final.request.json" > "$RUN_DIR/device-final.json"
python3 "$BOTA_FIRMWARE_PATH/scripts/factory_reset_lab.py" cleanup-fixture \
  --port "$BOTA_LAB_USB_PORT" --serial "$BOTA_DEVICE_SERIAL" --request-stdin \
  < "$RUN_DIR/device-cleanup.request.json" > "$RUN_DIR/device-cleanup.json"
node "$BOTA_BACKEND_PATH/api/dist/tools/factory-reset-lab-control.js" cleanup-session \
  --request-stdin < "$RUN_DIR/backend-cleanup.request.json" \
  > "$RUN_DIR/backend-cleanup.json"
```

Before `finalize`, the wrapper validates that the instrumentation receipt file is
exactly the persisted command ID/generation and three raw bytes expected by the
reset specification; it embeds those bytes into the owner-only finalize request.
Before `confirm-newer-bind`, it similarly requires instrumentation proof of
physical provisioning acceptance. The stale replay request contains only the
old command/journal identity plus current expected generation, never a current
token. Missing inspector/backend capability, failed prerequisite pin, wrong
fixture, missing snapshot field, command/session mismatch, nonmonotonic audit
sequence, or any tool output on stderr that is not an allowlisted status line
stops before the next mutating phase.

Each instrumentation phase is a fresh process. The wrapper streams a phase JSON
to `files/bota-physical/material.json`, invokes only
`PhysicalFactoryResetTest` with the non-secret phase argument, streams its result
back, clears the package, and proves private files are absent before proceeding.
Unit tests use fake USB/backend servers to prove phase order and cleanup; the
supervised gate uses only the pinned real firmware and backend adapters.

```bash
adb -s "$ANDROID_SERIAL" shell am instrument -w \
  -e class dev.bota.sdk.physical.PhysicalFactoryResetTest \
  -e botaPhysicalEnabled 1 \
  -e botaPhysicalCase factory-reset \
  -e botaPhysicalPhase "$PHASE" \
  -e botaDeviceModel "$BOTA_DEVICE_MODEL" \
  -e botaDeviceSerial "$BOTA_DEVICE_SERIAL" \
  dev.bota.sdk.test/androidx.test.runner.AndroidJUnitRunner
adb -s "$ANDROID_SERIAL" exec-out run-as dev.bota.sdk.test \
  cat files/bota-physical/phase-result.json \
  > "$RUN_DIR/instrumentation-$PHASE.json"
adb -s "$ANDROID_SERIAL" shell pm clear dev.bota.sdk.test
```

- [ ] **Step 3: Prove the default gate is non-destructive**

Run:

```bash
node --test tools/android/verify-physical-prerequisites.test.mjs \
  tools/android/factory-reset-lab.test.mjs
tools/android/test-package.sh
```

Expected: physical tests report skipped before Bluetooth initialization; unit,
fixture, and consumer tests still pass; missing, symbolic, dirty, divergent, or
unreviewed firmware/backend prerequisite pins are rejected by focused tests.

- [ ] **Step 4: Run Bota Pin and Bota Note under supervision**

For each model, export the four selectors once, then run every case explicitly:

```bash
export BOTA_ANDROID_PHYSICAL_TESTS=1
export ANDROID_SERIAL="<adb-serial>"
export BOTA_DEVICE_SERIAL="<bota-serial>"
export BOTA_DEVICE_MODEL="<bota-pin|bota-note>"

tools/android/test-physical.sh --case read-only

BOTA_ALLOW_CONNECTION_SETTINGS=1 \
BOTA_ANDROID_SETTINGS_MATERIAL_FILE="/absolute/private/settings.json" \
  tools/android/test-physical.sh --case connection-settings

BOTA_ALLOW_PROVISIONING=1 \
BOTA_ANDROID_PROVISIONING_MATERIAL_FILE="/absolute/private/provisioning.json" \
  tools/android/test-physical.sh --case provisioning

BOTA_ALLOW_RECORDING_DELETE=1 \
BOTA_ANDROID_RECORDING_MATERIAL_FILE="/absolute/private/recording.json" \
  tools/android/test-physical.sh --case recording-transfer-delete

BOTA_ALLOW_OTA=1 \
BOTA_ANDROID_OTA_MATERIAL_FILE="/absolute/private/ota.json" \
BOTA_ANDROID_OTA_IMAGE_FILE="/absolute/private/firmware.bin" \
  tools/android/test-physical.sh --case ota

BOTA_ALLOW_DEPROVISION=1 \
  tools/android/test-physical.sh --case deprovision
```

Stop after deprovision, preserve its report, and rebind/reprovision the device
under supervision before any reset preparation. Prepare the three owner-only
control/specification files only after that rebind; `host-prepare` creates and
snapshots the reset-only fixture after all prerequisite checks pass.
Deprovision and factory reset must never share a process, Gradle invocation,
instrumentation APK session, artifact IDs, command/grant, or evidence file. Run
authenticated reset last in a fresh invocation:

```bash
export BOTA_FIRMWARE_PATH="/absolute/firmware-checkout"
export BOTA_BACKEND_PATH="/absolute/backend-checkout"
export BOTA_LAB_FIRMWARE_IMAGE="$BOTA_FIRMWARE_PATH/sdk/cpu/wl83/tools/artifacts/factory-reset-inspector-v1/jl_isd.ufw"
export BOTA_LAB_USB_PORT="/dev/selected-wired-device"

BOTA_ALLOW_FACTORY_RESET=1 \
BOTA_ANDROID_RESET_MATERIAL_FILE="/absolute/private/factory-reset.json" \
BOTA_ANDROID_RESET_DEVICE_CONTROL_FILE="/absolute/private/device-control.json" \
BOTA_ANDROID_RESET_BACKEND_CONTROL_FILE="/absolute/private/backend-control.json" \
  tools/android/test-physical.sh --case factory-reset
```

For `factory-reset`, capture the raw notification before decoding and require its
length to be exactly three bytes and its bytes to equal
`[0x00, expectedDeletedCount & 0xff, (expectedDeletedCount >> 8) & 0xff]`. Persist the
same command-bound `{resultCode: 0, deletedRecordingCount}` app journal before
any receipt, then send only receipt opcode `0x0A`. Until that exact receipt write
succeeds, require the pinned backend adapter's pre-finalize query to show that
the stable device row remains bound at the original generation and no token is
revoked. A failure, short or
long result, wrong status/count, disconnect without exact replay, or journal
write failure must not send `0x0A`, finalize the command, unbind, revoke, or
continue the case.

Only after the exact receipt succeeds may the harness submit that command's
completion proof. Require the backend to accept that exact command receipt and
only then atomically unbind and revoke; its audit order must prove neither action
ran earlier. Reboot and reconnect unpaired. Before any re-provisioning, verify
the public recording list and pinned wired USB `RECORDER/` inspector are both
empty; no active recording/upload remains; the device token, BLE pairing/bonds,
WiFi credentials, project key, policy, and user settings are cleared; and the
backend row is preserved but unbound with the old token revoked. Re-query the
cloud snapshots and require all recording, transcription, and summary IDs and
bytes to remain unchanged. Read manufacturing identity again and require serial, model,
device-public-key/certificate fingerprints, hardware identity/attestation, and
the stable backend device-row ID to match the pre-reset snapshot. Never export or
log `SK_D`, `S_dev`, tokens, grants, WiFi values, or project keys; prove secret
identity preservation by fingerprint/attestation and successful authenticated
re-provisioning, not by reading secret bytes.

Finally, use the backend adapter's one-use `prepare-newer-bind` output to
provision the same physical device at generation `G + 1`, confirm that bind, and
apply the reset specification's distinct settings. Inject a
test-only copy of the already-completed generation-`G` app journal and replay the
old command completion/reconciliation without sending grant `G`, destructive
opcode `0x06`, or receipt `0x0A` to the device. Require the host/backend outcome
`stale_binding_ignored`; the generation-`G + 1` binding, token, pairing, settings,
and device row must remain unchanged and usable. Any mutation or revocation of
the newer generation fails the physical case. Run this complete exact-generation
reset plus stale-generation fence independently on both Bota Pin and Bota Note,
with fresh command IDs, grants, fixture artifacts, and newer-binding tokens.

Record Android hardware/OS, app revision, Bota model/serial, firmware revision,
and individual results for permission/scan, serial-verified pairing, app/device
restart reconnect, status/settings, provisioning, interrupted recording resume,
checksum/upload/delete, direct-upload ownership, OTA/reboot/readback, logs,
deprovision, and the separately gated authenticated-reset contract. Store
`deprovision` and `factory-reset` as distinct signed evidence records. Each model's
reset record includes artifact classes/counts, the exact three result bytes,
journal-before-receipt and backend-finalize-before-unbind ordering, empty local
state, every cleared credential/setting category, preserved cloud/manufacturing
checks, `G + 1` stale-replay rejection, and private-material cleanup, but no
private values.

- [ ] **Step 5: Update status only from preserved evidence**

Mark Android `automated_verified` after automated gates. Mark model rows
`physical_device_verified` only after every supported row passes. Do not add
Android to `nativeAbi.publishedFacades` or replace the legacy baseline until
both models and exact reset receipt are reviewed. Stable native publication
also requires the accepted Apple physical matrix from the same compatibility
baseline; otherwise stop before Task 15.

- [ ] **Step 6: Run the full pre-publication gate and commit evidence**

Run:

```bash
npm ci
npm run check
npm run test:tooling
npm run test:release
npm run sync:apple-fixtures
npm run test:workflows -- --sdk-path "$BOTA_REACT_NATIVE_SDK_PATH"
cargo xtask protocol generate --check
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace
tools/ffi-smoke/run-native-c-smoke.sh
tools/ffi-smoke/run-native-swift-smoke.sh
tools/apple/test-package.sh -Xswiftc -strict-concurrency=complete -Xswiftc -warnings-as-errors
tools/apple/test-consumer.sh
for api in 26 35; do
  tools/android/test-package.sh --api "$api"
  tools/android/test-legacy-consumer.sh --api "$api" --mode source
  tools/android/test-legacy-consumer.sh --api "$api" --mode binary
  tools/android/test-consumer.sh --api "$api"
done
tools/android/package-release.sh --check
cargo deny check
```

Expected: automated gates pass; the evidence file clearly separates JVM,
emulator, generic package, and supervised physical results.

```bash
git add ARCHITECTURE.md README.md docs/testing/android-physical-device.md \
  platforms/android release/evidence/1.1.0-android-facade.md protocol tools/android
git commit -m "docs(android): record facade acceptance evidence" \
  -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
```

### Task 15: Publish the Synchronized 1.1.0 Native Release

**Files:**
- Modify: `sdk-version.toml`
- Modify: `package.json`
- Modify: Cargo workspace package versions and `Cargo.lock`
- Modify: `platforms/android/gradle.properties`
- Modify: `platforms/apple/Sources/BotaAppleSDK/BotaAppleSDK.swift`
- Modify: `Package.swift`
- Modify: `protocol/compatibility/firmware-compatibility.json`
- Create: `release/examples/1.1.0.json`
- Modify: `.github/workflows/release.yml`
- Create: `tools/android/central-portal.mjs`
- Create: `tools/android/central-portal.test.mjs`
- Create: `tools/release/write-candidate-inventory.sh`
- Modify: `tools/xtask/tests/release_readiness.rs`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `AGENTS.md`
- Modify: `docs/releasing.md`

**Interfaces:**
- Consumes: reviewed Apple and Android physical evidence, protected GitHub `release` environment, verified `dev.bota` Central namespace, Central user token, and in-memory PGP key.
- Produces: immutable tag `v1.1.0`, GitHub Apple assets, Maven Central
  `dev.bota:bota-android-sdk:1.1.0`, and retryable Central deployment evidence
  from one clean source revision.

- [ ] **Step 1: Verify external publication prerequisites without secrets**

Confirm `dev.bota` is verified in Central Portal, the protected `release`
environment has required reviewers, and CI secret names exist. The workflow
uses only `MAVEN_CENTRAL_USERNAME`, `MAVEN_CENTRAL_PASSWORD`,
`SIGNING_IN_MEMORY_KEY`, and `SIGNING_IN_MEMORY_KEY_PASSWORD`; no value is
printed, written to disk, or passed to pull-request jobs. The protected Gradle
step maps the last two secrets to `ORG_GRADLE_PROJECT_signingInMemoryKey` and
`ORG_GRADLE_PROJECT_signingInMemoryKeyPassword` in that step's environment only.

- [ ] **Step 2: Write failing 1.1.0 synchronization tests**

Change release-readiness expectations to `v1.1.0` and require both Apple and
Android artifacts in `release/examples/1.1.0.json`. Assert the workflow signs
and publishes `dev.bota:bota-android-sdk:1.1.0`, captures and persists the Central
deployment ID before polling, resumes by deployment state, verifies the complete
remote artifact inventory, publishes GitHub assets idempotently, and runs remote
SwiftPM and Maven consumers. Require a protected `workflow_dispatch` recovery
path with exact tag-ref and deployment-ID inputs, the same release concurrency
key, and no rebuild/re-sign/re-upload behavior. Unit-test every Portal state
transition plus tag, commit, coordinate, bundle, inventory, source-revision, and
checksum mismatch refusal.

Keep `validate_manifest` and `cargo xtask release validate` strict against the
current checkout's `sdk-version.toml`. Exercise
`release/examples/published-1.0.0-v1.json` through the explicit
checkout-independent format/semantic validation entry point instead: it must
enforce manifest/artifact consistency, checksums, firmware ranges,
capabilities, and v1 semantics against the fixture's own `1.0.0` authority
without requiring the later checkout version to match. Add a paired assertion
that the strict validator rejects that historical fixture after the authority
changes to `1.1.0`.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
cargo test -p xtask --test release_readiness --test release_manifest
node --test tools/android/central-portal.test.mjs
```

Expected: FAIL while family version authorities remain `1.0.0` and the 1.1.0
manifest is absent.

- [ ] **Step 4: Commit synchronized version authorities before packaging**

Set `sdk-version.toml`, npm/Cargo metadata, Android `VERSION_NAME`, Apple public
version, compatibility data, release-schema example, release workflow, and
readiness tests to `1.1.0`. The checked-in example is deterministic schema test
data; it is not the authoritative release manifest. Do not run either native
packager while these edits are dirty. Run the focused metadata/unit checks that
permit a dirty tree, review the diff, and commit:

```bash
cargo test -p xtask --test release_readiness --test release_manifest
node --test tools/android/central-portal.test.mjs
cargo xtask release validate release/examples/1.1.0.json
if STRICT_OUTPUT="$(cargo xtask release validate \
  release/examples/published-1.0.0-v1.json 2>&1)"; then
  echo "strict validation unexpectedly accepted historical v1" >&2
  exit 1
fi
printf '%s\n' "$STRICT_OUTPUT" | \
  grep -F "sdkVersion 1.0.0 does not match sdk-version.toml 1.1.0"
git diff --check
git add .github AGENTS.md ARCHITECTURE.md Cargo.lock Cargo.toml README.md docs \
  package.json platforms protocol release sdk-version.toml tools
git commit -m "release: prepare Bota App SDK 1.1.0" \
  -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
test -z "$(git status --porcelain --untracked-files=normal)"
```

Expected: every version authority is committed and HEAD is clean before an
archive checksum or release-manifest `sourceRevision` is calculated. The
current `1.1.0` example passes the strict CLI, the same CLI rejects the
historical `1.0.0` fixture for authority mismatch, and the checkout-independent
historical-format test remains green.

- [ ] **Step 5: Commit the Apple checksum from a clean source commit**

Run the repository's manifest-writing mode only from the clean Step 4 commit:

```bash
tools/apple/package-release.sh --write-package-manifest
swift package dump-package
git diff --check
git diff -- Package.swift
test "$(git status --short | wc -l | tr -d ' ')" = 1
git add Package.swift
git commit -m "build(release): pin Bota App SDK 1.1.0 package checksum" \
  -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
test -z "$(git status --porcelain --untracked-files=normal)"
```

The write mode may change only `Package.swift`. All deterministic tracked
Android version/manifest-example metadata was committed in Step 4; Android
`package-release.sh --check` writes only `target/` and must never create a
post-packaging source commit. The resulting clean HEAD is the sole release
candidate and eventual tag commit.

- [ ] **Step 6: Persist and resume Central Portal deployment state**

Vanniktech 0.35.0 configures the `maven` publication and signs it, but the
protected release job does not use its one-shot `publishToMavenCentral` or
`publishAndReleaseToMavenCentral` aliases because that version does not expose a
durable deployment-ID output contract. Task 12's
protected `:sdk:stageSignedCentralRawRepository`, explicit raw normalization,
and `build-central-bundle.mjs` instead create the signed raw repository, clean
30-file Portal tree, deterministic inventory, and byte-reproducible Portal ZIP.
`central-portal.mjs` only validates, uploads, resumes, publishes, and verifies
those already-built bytes through the documented Portal API. It reads Central
credentials from the protected process environment, builds authorization in
memory, redacts HTTP errors, and never puts credentials in arguments, state,
artifacts, or logs.

Before contacting Central, `central-portal.mjs prepare` verifies the exact
coordinate/version/source revision, reruns the Task 12 ZIP verifier, hashes the
bundle and inventory, and atomically writes this initial durable record:

```json
{
  "schemaVersion": 1,
  "packageIdentifier": "dev.bota:bota-android-sdk",
  "version": "1.1.0",
  "sourceRevision": "<40-hex tag commit>",
  "bundleSha256": "<64-hex>",
  "inventorySha256": "<64-hex>",
  "deploymentName": "bota-android-sdk-1.1.0-<first-16-lowercase-hex-of-bundle-sha256>",
  "deploymentId": null,
  "deploymentState": "READY",
  "updatedAt": "<UTC timestamp>"
}
```

The normal tag workflow uses concurrency key
`central-dev.bota-bota-android-sdk-1.1.0` with `cancel-in-progress: false`. Before
any upload it creates or reuses an unpublished draft GitHub Release for
`v1.1.0`, uploads the exact ZIP, inventory, and `READY` state as immutable-named
assets on the first run. A rerun with existing assets downloads and validates
those exact bytes and does not re-sign or rebuild them. Immediately after Central
returns HTTP 201, the script fsyncs the returned deployment UUID and `PENDING`
state to a replacement state file before polling. An `if: always()` step uploads
the non-secret record both as a workflow artifact and as the draft release asset
with `gh release upload --clobber` after every transition; the ZIP and inventory
assets are never clobbered after their first matching-hash upload.

Add this manually triggered recovery surface to the same workflow:

```yaml
on:
  push:
    tags: ["v*.*.*"]
  workflow_dispatch:
    inputs:
      releaseRef:
        description: Exact annotated release tag ref, for example refs/tags/v1.1.0
        required: true
        type: string
      centralDeploymentId:
        description: Existing Central Portal deployment UUID
        required: true
        type: string
concurrency:
  group: central-dev.bota-bota-android-sdk-1.1.0
  cancel-in-progress: false
```

The recovery job uses the protected `release` environment and checks out only
`releaseRef`. It requires exactly `refs/tags/v1.1.0`, an existing annotated tag,
and equality among `releaseRef^{commit}`, checked-out `HEAD`, the manifest source
revision, the state source revision, and the version authorities. It retrieves
`central-portal-state.json`, `central-bundle-files.json`, and
`central-bundle.zip` from that tag's draft Release, with a retained same-tag
workflow artifact only as a byte-identical fallback. It then reruns bundle verification; recomputes and
matches the complete bundle and inventory hashes; validates the exact
`dev.bota:bota-android-sdk:1.1.0` coordinate in the inventory, POM, module, and
state; and requires the input deployment UUID to equal the persisted UUID. The
only exception is an uncertain initial upload whose durable record is still
`READY` with a null ID: in that case, query the supplied ID first and fill it
only when Central returns the expected deterministic deployment name and
coordinate/component identity. Recovery never rebuilds, re-signs, regenerates,
or uploads the bundle.

Missing release assets or state, an absent/ambiguous Portal identity, a mutable
or lightweight tag, an invalid UUID, any tag/commit/coordinate/hash mismatch, an
input ID different from a recorded ID, a state/Portal transition disagreement,
an unknown state, or `FAILED` stops recovery without changing or dropping the
deployment. A missing public POM is never an idempotency signal.

Resume exactly by Portal state:

- `PENDING` or `VALIDATING`: poll the recorded ID with a bounded timeout;
- `VALIDATED`: POST the recorded deployment ID once to publish, persist
  `PUBLISHING`, then poll;
- `PUBLISHING`: poll only; never upload another bundle;
- `PUBLISHED`: skip upload/publish and run complete remote-byte verification;
- `FAILED`: persist the returned errors and stop. Dropping and replacing it
  requires a separate explicit coordinator approval and the same bundle hash.

If an upload has an uncertain network outcome before its response ID is durably
saved, fail closed and require the coordinator to recover the deployment ID from
Central Portal with the protected dispatch mode; never guess from public-POM
absence or automatically upload again. A missing public POM is expected during
validation, publishing, and repository synchronization.

Once state is `PUBLISHED`, download and byte-verify this exact Maven version
directory against the signed bundle inventory:

- `bota-android-sdk-1.1.0.aar`, `.pom`, `.module`, `-sources.jar`, and
  `-javadoc.jar`;
- one `.asc`, `.md5`, and `.sha1` for each of those five primary files;
- the emitted `.sha256` and `.sha512` for each primary file.

Compare SHA-256 of every downloaded file, validate every checksum file and PGP
signature, parse POM/module coordinates and dependency versions, inspect all
four native ABI entries in the remote AAR, and reject any missing or extra
version-directory file. Central's generated parent `maven-metadata.xml` is
outside this bundle comparison. `verify-published` may retry 404 responses for a
bounded repository-synchronization window after `PUBLISHED`; a present file with
wrong bytes, an unexpected file, or an expired timeout fails immediately.

After Rust, Apple, Android, license, both emulator lanes, and reviewed physical
evidence jobs pass, the first protected run signs only in memory and invokes:

```bash
test -z "$(git status --porcelain --untracked-files=normal)"
platforms/android/gradlew -p platforms/android \
  -PbotaProtectedSigning=true \
  :sdk:stageSignedCentralRawRepository \
  --no-daemon --no-parallel --no-configuration-cache
node tools/android/normalize-central-repository.mjs \
  --raw-repository target/android-central-raw \
  --portal-repository target/android-central-portal \
  --coordinate dev.bota:bota-android-sdk \
  --version 1.1.0
node tools/android/build-central-bundle.mjs build \
  --repository target/android-central-portal \
  --coordinate dev.bota:bota-android-sdk \
  --version 1.1.0 \
  --source-revision "$(git rev-parse HEAD)" \
  --inventory target/android-release/central-bundle-files.json \
  --output target/android-release/central-bundle.zip
node tools/android/build-central-bundle.mjs verify \
  --repository target/android-central-portal \
  --inventory target/android-release/central-bundle-files.json \
  --zip target/android-release/central-bundle.zip
node tools/android/central-portal.mjs prepare \
  --bundle target/android-release/central-bundle.zip \
  --inventory target/android-release/central-bundle-files.json \
  --state target/central-portal-state.json \
  --source-revision "$(git rev-parse HEAD)"
node tools/android/central-portal.mjs upload-or-resume \
  --bundle target/android-release/central-bundle.zip \
  --inventory target/android-release/central-bundle-files.json \
  --state target/central-portal-state.json \
  --source-revision "$(git rev-parse HEAD)"
node tools/android/central-portal.mjs verify-published \
  --state target/central-portal-state.json \
  --inventory target/android-release/central-bundle-files.json
```

The protected dispatch runs the same verifier and then uses the persisted files
without invoking Gradle or `build`:

```bash
node tools/android/central-portal.mjs recover-and-resume \
  --release-ref "${{ inputs.releaseRef }}" \
  --deployment-id "${{ inputs.centralDeploymentId }}" \
  --bundle target/android-release/central-bundle.zip \
  --inventory target/android-release/central-bundle-files.json \
  --state target/central-portal-state.json
node tools/android/central-portal.mjs verify-published \
  --state target/central-portal-state.json \
  --inventory target/android-release/central-bundle-files.json
```

and only then updates the draft GitHub Release with Apple/Android artifacts and
evidence. No workflow overwrites an existing Central component or Git tag.

A final job creates a clean Gradle app, resolves only
`dev.bota:bota-android-sdk:1.1.0`, and loads JNI/checks SDK and ABI versions on
both the API-26 x86 and API-35 x86_64 lanes. The existing public SwiftPM smoke
resolves `v1.1.0` independently.

- [ ] **Step 7: Run check-only packaging from the exact tag candidate**

Run:

```bash
test -z "$(git status --porcelain --untracked-files=normal)"
SOURCE_REVISION="$(git rev-parse HEAD)"
npm ci
npm run check
npm run test:tooling
npm run test:release
npm run sync:apple-fixtures
npm run test:workflows -- --sdk-path "$BOTA_REACT_NATIVE_SDK_PATH"
cargo xtask protocol generate --check
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace
tools/ffi-smoke/run-native-c-smoke.sh
tools/ffi-smoke/run-native-swift-smoke.sh
tools/apple/test-package.sh -Xswiftc -strict-concurrency=complete -Xswiftc -warnings-as-errors
tools/apple/test-consumer.sh
tools/apple/package-release.sh
for api in 26 35; do
  tools/android/test-package.sh --api "$api"
  tools/android/test-legacy-consumer.sh --api "$api" --mode source
  tools/android/test-legacy-consumer.sh --api "$api" --mode binary
  tools/android/test-consumer.sh --api "$api"
done
tools/android/package-release.sh --check
cargo deny check
git diff --check
git diff --exit-code
git diff --cached --exit-code
test "$(jq -r .sourceRevision target/apple-release/release-manifest.json)" = "$SOURCE_REVISION"
test "$(jq -r .sourceRevision target/android-release/release-manifest.json)" = "$SOURCE_REVISION"
tools/release/write-candidate-inventory.sh \
  --source-revision "$SOURCE_REVISION" \
  --output target/release-candidate-files.json \
  target/apple-release target/android-release
test -z "$(git status --porcelain --untracked-files=normal)"
```

Expected: all automated gates pass from a clean source revision; generated
Apple and Android metadata agree on version, source revision, fixture digest,
firmware range, and release-manifest v2 family identity. The candidate inventory
contains the exact SHA-256 and size of every unsigned primary package and
generated metadata file, identifies `SOURCE_REVISION`, and no tracked file
changes after either packager. Protected CI adds PGP signatures, required
checksum sidecars, and the Central bundle wrapper only after reproducing these
primary bytes. There is no release-preparation commit after this point.

- [ ] **Step 8: Tag the candidate, push, and verify remote evidence**

```bash
SOURCE_REVISION="$(git rev-parse HEAD)"
test -z "$(git status --porcelain --untracked-files=normal)"
CANDIDATE_INVENTORY_SHA256="$(shasum -a 256 target/release-candidate-files.json | awk '{print $1}')"
git tag -a v1.1.0 \
  -m "Bota App SDK 1.1.0" \
  -m "Source-Revision: $SOURCE_REVISION" \
  -m "Candidate-Inventory-SHA256: $CANDIDATE_INVENTORY_SHA256"
test "$(git rev-list -n 1 v1.1.0)" = "$SOURCE_REVISION"
cargo xtask release verify-tag v1.1.0
git push origin main
git push origin v1.1.0
```

The annotated tag binds the clean source commit to the digest of the unsigned
candidate inventory without adding a post-packaging source commit. The tag
workflow checks out `v1.1.0`, requires the tag's `Source-Revision` trailer and
`GITHUB_SHA` to equal the checked-out commit, reruns both check-only packagers,
regenerates `release-candidate-files.json`, and requires its SHA-256 to match the
tag's `Candidate-Inventory-SHA256` trailer before signing. It then records every
signed/checksum file in `central-bundle-files.json`. The Central state file must
record that same revision and the resulting signed Android bundle hash.

After protected publication reaches `PUBLISHED`, complete artifact verification
and both remote consumers pass, publish the draft GitHub Release. Record immutable
GitHub/Maven checksums, the Central deployment ID/final state, and workflow URLs
in a follow-up evidence commit; do not alter the tag or published bytes. Only
then add Android to `nativeAbi.publishedFacades` and change public status text
from planned/unpublished to available.

## Exit Criteria

- `dev.bota:bota-android-sdk` imports from an unrelated Gradle consumer on API 26+ and loads the real JNI/Rust library on an emulator.
- The AAR contains only the reviewed Kotlin/JNI surface and both expected native libraries for `arm64-v8a`, `armeabi-v7a`, `x86_64`, and `x86`.
- Kotlin/JNI executes all protocol fixtures and 29 canonical workflows without a copied parser or workflow implementation.
- BluetoothGatt operations are HandlerThread-owned, serialized per connection, correlation-safe, permission-safe, and identity-safe.
- Checkpoints/reset receipts survive restart; secrets use Android Keystore; recordings and firmware remain in bounded native files/buffers; OkHttp receives only application-authorized requests.
- Public APIs expose `BotaDeviceClient`, suspend functions, `Flow`, immutable models, and sealed stable errors under `dev.bota.sdk`.
- Deprecated `com.bota.sdk` wrappers match the generated pinned JVM inventory, pass source and precompiled-binary consumers, and do not publish or require the legacy artifact at runtime.
- The Android release includes AAR, sources, Dokka, POM/module metadata, license, SPDX 2.3 SBOM, signatures, checksums, and a validated release-manifest v2 Android entry.
- Unsigned local publication has no signing task or secret; protected raw staging fails without both in-memory key and password, and real Gradle output normalizes into the exact 30-entry Portal bundle.
- CI proves all four ABIs, real JNI, API-26 x86 and API-35 x86_64 emulator consumption, release metadata, dependency licenses, and synchronized `sdk-version.toml` before protected publication.
- Bota Pin and Bota Note physical rows use reviewed, pinned wired firmware and authenticated backend control revisions to prove reset-only artifact wipe/count, post-receipt credential clearing, cloud/manufacturing preservation, and the newer-generation fence separately from automated CI and deprovision.
- Central retries recover persisted bundle/inventory/state bytes under the protected same-concurrency dispatch, never infer upload state from public-POM absence, and verify the complete published version directory byte-for-byte.
- Until the final remote checksums and consumers pass, repository documentation continues to say that Android is planned and unpublished.

## Primary References

- [Android Gradle Plugin 8.13 compatibility](https://developer.android.com/build/releases/agp-8-13-0-release-notes)
- [Vanniktech Maven Publish compatibility changelog](https://vanniktech.github.io/gradle-maven-publish-plugin/changelog/)
- [Vanniktech Maven Central configuration and publication tasks](https://vanniktech.github.io/gradle-maven-publish-plugin/central/)
- [Vanniktech 0.35.0 conditional signing implementation](https://github.com/vanniktech/gradle-maven-publish-plugin/blob/0.35.0/plugin/src/main/kotlin/com/vanniktech/maven/publish/MavenPublishBaseExtension.kt#L123-L167)
- [Gradle publication artifacts, checksums, and signatures](https://docs.gradle.org/8.13/userguide/publishing_setup.html)
- [Gradle file-repository checksum behavior](https://github.com/gradle/gradle/issues/22482)
- [Kotlin library backward-compatibility and `apiCheck`](https://kotlinlang.org/docs/api-guidelines-backward-compatibility.html)
- [Android Emulator command-line operation](https://developer.android.com/studio/run/emulator-commandline)
- [Android instrumentation from the command line](https://developer.android.com/studio/test/command-line)
- [Android app-specific private storage](https://developer.android.com/training/data-storage/app-specific)
- [Android `AtomicFile` contract](https://developer.android.com/reference/android/util/AtomicFile)
- [Central Publisher Portal API and deployment states](https://central.sonatype.org/publish/publish-portal-api/)
- [Maven Central artifact, signature, checksum, and POM requirements](https://central.sonatype.org/publish/requirements/)
- [Maven Central immutability](https://central.sonatype.org/publish/requirements/immutability/)
