# Bota Flutter SDK Facade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the public `bota_flutter_sdk` beta for Flutter iOS and Android applications while preserving the native Bota App SDK facades as the Bluetooth and workflow owners.

**Architecture:** A single Flutter plugin exposes immutable Dart models and manager APIs. Pigeon generates one versioned Dart/Swift/Kotlin bridge; the host adapters map bounded values to `BotaAppleSDK` and `dev.bota:bota-android-sdk`, while recording bodies, firmware bodies, Bluetooth objects, and device-private material remain native. Per-engine registries and a process-wide lease coordinator make configure, streams, callbacks, detach, and destroy deterministic.

**Tech Stack:** Flutter 3.47.2, Dart 3.13.2, Pigeon 28.0.0, Swift 6 toolchain with the generated Flutter bridge compiled in Swift 5 language mode, BotaAppleSDK, Kotlin 2.2, Android API 26, Gradle, Node.js 22 release tooling, GitHub Actions, pub.dev OIDC.

**Spec:** `docs/superpowers/specs/2026-09-03-flutter-facade-design.md`

## Global Constraints

- The package is `bota_flutter_sdk` at `frameworks/flutter/bota_flutter_sdk/` with native namespace `dev.bota.sdk.flutter`.
- Consumer floors are Dart `>=3.11.0 <4.0.0`, Flutter `>=3.41.0`, iOS 15, and Android API 26.
- CI pins Flutter 3.47.2, Dart 3.13.2, and Pigeon 28.0.0 exactly.
- The first synchronized Flutter release is `1.2.0-beta.0`; every platform version comes from `sdk-version.toml`.
- Flutter supports iOS and Android only in this slice; live audio streaming is excluded and must not be advertised.
- Dart never implements BLE, reducers, encryption, persistence, firmware download, or recording byte transfer.
- Recording and firmware bodies, raw BLE packets, device-private material, and native Bluetooth objects never cross a Flutter channel. Application-supplied WiFi credentials and one-shot provisioning/reset material may cross request-bound commands or callbacks; they never appear in stream events, logs, or plugin persistence.
- Generated Pigeon Dart, Swift, and Kotlin files are checked in and regenerated in CI; generated files are never edited manually.
- Every behavior change follows red-green-refactor. Generated code and static package configuration are generated from reviewed source and verified by drift/package tests.
- Every commit includes `Co-Authored-By: OpenAI Codex <noreply@openai.com>`.

---

### Task 1: Reproducible Flutter Package Foundation

**Files:**
- Create: `frameworks/flutter/bota_flutter_sdk/pubspec.yaml`
- Create: `frameworks/flutter/bota_flutter_sdk/analysis_options.yaml`
- Create: `frameworks/flutter/bota_flutter_sdk/LICENSE`
- Create: `frameworks/flutter/bota_flutter_sdk/lib/bota_flutter_sdk.dart`
- Create: `frameworks/flutter/bota_flutter_sdk/test/package_contract_test.dart`
- Create: `tools/flutter/flutter-version.json`
- Create: `tools/flutter/run-flutter.sh`
- Create: `tools/flutter/verify-package.mjs`
- Create: `tools/flutter/verify-package.test.mjs`
- Modify: `.gitignore`
- Modify: `package.json`

**Interfaces:**
- Consumes: root `sdk-version.toml` and the repository Node 22 runtime.
- Produces: `tools/flutter/run-flutter.sh <flutter-arguments...>` and `npm run flutter:verify`; every later task uses these commands.

- [ ] **Step 1: Write the failing repository package-contract tests**

  Add Node tests that require `verifyFlutterPackage(root)` to reject a missing package, a version different from `sdk-version.toml`, a Dart or Flutter floor different from the global constraints, non-iOS/Android platforms, a non-exact Pigeon version, and a missing package file. Add a passing fixture containing exactly the expected metadata. Add a Dart test importing `package:bota_flutter_sdk/bota_flutter_sdk.dart` and asserting `BotaFlutterSdk.packageName == 'bota_flutter_sdk'`.

- [ ] **Step 2: Run the tests and verify RED**

  Run:

  ```bash
  source "$HOME/.nvm/nvm.sh" && nvm use 22.23.2 >/dev/null
  node --test tools/flutter/verify-package.test.mjs
  ```

  Expected: FAIL because `tools/flutter/verify-package.mjs` does not exist.

- [ ] **Step 3: Add the pinned toolchain wrapper and package scaffold**

  `flutter-version.json` contains version `3.47.2`, Dart `3.13.2`, and the official archive SHA-256. `run-flutter.sh` resolves `BOTA_FLUTTER_HOME` first, otherwise downloads the matching official archive into `target/flutter-sdk/`, verifies its SHA-256 before extraction, and executes its `bin/flutter`. The script never installs globally.

  `pubspec.yaml` declares:

  ```yaml
  name: bota_flutter_sdk
  version: 1.1.0
  environment:
    sdk: ">=3.11.0 <4.0.0"
    flutter: ">=3.41.0"
  dependencies:
    flutter:
      sdk: flutter
  dev_dependencies:
    flutter_test:
      sdk: flutter
    flutter_lints: 6.0.0
    pigeon: 28.0.0
  flutter:
    plugin:
      platforms:
        android:
          package: dev.bota.sdk.flutter
          pluginClass: BotaFlutterSdkPlugin
        ios:
          pluginClass: BotaFlutterSdkPlugin
  ```

  `verifyFlutterPackage(root)` parses the canonical version, parses the pubspec without accepting aliases, verifies the package inventory and constraints, and rejects symlinks escaping the package root. Root scripts add `flutter:test`, `flutter:analyze`, `flutter:generate`, `flutter:generate:check`, and `flutter:verify`.

- [ ] **Step 4: Run foundation verification and verify GREEN**

  Run:

  ```bash
  node --test tools/flutter/verify-package.test.mjs
  tools/flutter/run-flutter.sh pub get --directory frameworks/flutter/bota_flutter_sdk
  tools/flutter/run-flutter.sh test frameworks/flutter/bota_flutter_sdk/test/package_contract_test.dart
  npm run flutter:verify
  ```

  Expected: all commands pass and Flutter reports 3.47.2/Dart 3.13.2.

- [ ] **Step 5: Commit the foundation**

  ```bash
  git add .gitignore package.json tools/flutter frameworks/flutter/bota_flutter_sdk
  git commit -m "feat(flutter): scaffold reproducible plugin" \
    -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
  ```

### Task 2: Immutable Dart Domain API

**Files:**
- Create: `frameworks/flutter/bota_flutter_sdk/lib/src/errors.dart`
- Create: `frameworks/flutter/bota_flutter_sdk/lib/src/models/device.dart`
- Create: `frameworks/flutter/bota_flutter_sdk/lib/src/models/settings.dart`
- Create: `frameworks/flutter/bota_flutter_sdk/lib/src/models/recording.dart`
- Create: `frameworks/flutter/bota_flutter_sdk/lib/src/models/ota.dart`
- Create: `frameworks/flutter/bota_flutter_sdk/lib/src/models/wifi.dart`
- Create: `frameworks/flutter/bota_flutter_sdk/lib/src/models/security.dart`
- Create: `frameworks/flutter/bota_flutter_sdk/lib/src/managers.dart`
- Create: `frameworks/flutter/bota_flutter_sdk/lib/src/platform.dart`
- Create: `frameworks/flutter/bota_flutter_sdk/lib/src/client.dart`
- Create: `frameworks/flutter/bota_flutter_sdk/test/models_test.dart`
- Create: `frameworks/flutter/bota_flutter_sdk/test/public_api_test.dart`
- Modify: `frameworks/flutter/bota_flutter_sdk/lib/bota_flutter_sdk.dart`

**Interfaces:**
- Consumes: no native bridge; managers delegate to the internal abstract `BotaPlatform` defined in this task.
- Produces: `BotaDeviceClient`, `BotaSdkException`, immutable public models, manager method signatures, `BotaApplicationCallbacks`, and `BotaPlatform` used by bridge and native tasks.

- [ ] **Step 1: Write failing model and public-API tests**

  Assert value equality/hash behavior, defensive copying of every byte list, `unknown(rawValue)` preservation for device type, pairing state, WiFi state, recording state, OTA phase, and errors. Assert the public barrel exports only documented symbols, that the capability set contains every supported first-beta operation but no streaming or unsupported platform capability, and that `BotaDeviceClient.forTesting(platform)` exposes managers named `devices`, `controls`, `provisioning`, `factoryReset`, `recordings`, `ota`, `logs`, and `wifi`.

- [ ] **Step 2: Run the focused Dart tests and verify RED**

  ```bash
  tools/flutter/run-flutter.sh test \
    frameworks/flutter/bota_flutter_sdk/test/models_test.dart \
    frameworks/flutter/bota_flutter_sdk/test/public_api_test.dart
  ```

  Expected: FAIL on missing public types.

- [ ] **Step 3: Implement the immutable public API**

  Define manager methods with these shapes:

  ```dart
  abstract interface class BotaDeviceManager {
    Stream<BotaDiscoveredDevice> scan({Duration timeout, bool allowDuplicates});
    Future<BotaConnectedDevice> connect(BotaDiscoveredDevice device, {String? serialNumber});
    Future<BotaConnectedDevice> reconnect(String serialNumber, {BotaReconnectHint hint});
    Future<void> disconnect();
    Stream<BotaConnectedDevice?> get connections;
    Future<BotaDeviceStatus> readStatus();
    Stream<BotaDeviceStatus> get status;
    Future<void> cancelCurrentOperation();
  }

  abstract interface class BotaControlManager {
    Future<void> startRecording(BotaConnectedDevice device, {required String grantBlob});
    Future<void> stopRecording(BotaConnectedDevice device, {required String grantBlob});
    Future<BotaRecordingState> readRecordingState(BotaConnectedDevice device);
    Stream<BotaRecordingState> recordingState(BotaConnectedDevice device);
  }

  abstract interface class BotaProvisioningManager {
    Future<void> provision(BotaConnectedDevice device);
    Future<BotaConnectionSettings> readConnectionSettings(BotaConnectedDevice device);
    Future<void> writeConnectionSettings(BotaConnectedDevice device, BotaConnectionSettings settings);
    Future<BotaDeprovisionResult> deprovision(BotaConnectedDevice device, {required String grantBlob});
    Future<void> cancelCurrentOperation();
  }

  abstract interface class BotaFactoryResetManager {
    Future<BotaFactoryResetCompletion> reset(BotaConnectedDevice device, BotaFactoryResetCommand command);
    Future<BotaFactoryResetCompletion?> resumePending(BotaConnectedDevice device, {required int currentBindingGeneration});
    Future<BotaFactoryResetCompletion> resumeUnjournaled(BotaConnectedDevice device, BotaFactoryResetCommand command);
    Future<void> cancelCurrentOperation();
  }

  abstract interface class BotaRecordingManager {
    Future<List<BotaDeviceRecording>> list(BotaConnectedDevice device);
    Stream<BotaRecordingSyncEvent> sync(BotaConnectedDevice device, BotaDeviceRecording recording, {required String sinkId, bool confirmOnCompletion});
    Future<BotaRecordingTransferMetadata?> takeTransferMetadata(String sinkId);
    Future<void> confirm(BotaConnectedDevice device, String recordingId);
    Stream<BotaUploadOwnershipEvent> observeUploadOwnership(BotaConnectedDevice device, {required String recordingId, required String uploadId, required String destinationId});
    Future<void> cancelCurrentOperation();
  }

  abstract interface class BotaOtaManager {
    Stream<BotaFirmwareProgress> update(BotaConnectedDevice device, BotaFirmwareImage image);
    Future<void> cancelCurrentOperation();
  }

  abstract interface class BotaLogManager {
    Stream<BotaDeviceLogLine> stream(BotaConnectedDevice device);
    Future<void> stop();
  }

  abstract interface class BotaWifiManager {
    Future<BotaWifiConfigResult> configure(BotaConnectedDevice device, BotaWifiCredentials credentials, {required String grantBlob});
    Future<BotaWifiConfigResult> disconnect(BotaConnectedDevice device);
    Future<BotaWifiStatus> readStatus(BotaConnectedDevice device);
    Stream<BotaWifiStatus> status(BotaConnectedDevice device);
    Future<BotaWifiScanResult> scan(BotaConnectedDevice device);
    Future<void> cancelCurrentOperation();
  }
  ```

  `BotaConfiguration` contains an application-support namespace plus `BotaApplicationCallbacks` for provisioning material, reset grants/results, and firmware requests. Callback request/response values are immutable and request-bound. Batch-upload destinations remain application-owned after the SDK returns a completed native file path; the beta has no unused upload-destination callback. `BotaPlatform` repeats these method shapes internally so the public managers remain trivial typed delegates; Task 4 supplies the channel implementation while tests use an in-memory fake.

  `BotaSdkException` contains `code`, `operation`, `retryable`, optional `protocolStatus`, and `detail`; `toString()` redacts material and never includes callback payload bytes.

- [ ] **Step 4: Run Dart tests, formatting, and analysis**

  ```bash
  tools/flutter/run-flutter.sh test frameworks/flutter/bota_flutter_sdk/test
  tools/flutter/run-dart.sh format --output=none --set-exit-if-changed frameworks/flutter/bota_flutter_sdk/lib frameworks/flutter/bota_flutter_sdk/test
  tools/flutter/run-flutter.sh analyze frameworks/flutter/bota_flutter_sdk
  ```

  Expected: PASS with no diagnostics.

- [ ] **Step 5: Commit the public API**

  ```bash
  git add frameworks/flutter/bota_flutter_sdk/lib frameworks/flutter/bota_flutter_sdk/test
  git commit -m "feat(flutter): define public device API" \
    -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
  ```

### Task 3: Typed Pigeon Contract And Drift Gate

**Files:**
- Create: `frameworks/flutter/bota_flutter_sdk/pigeons/bota_api.dart`
- Create: `frameworks/flutter/bota_flutter_sdk/pigeon_options.yaml`
- Generate: `frameworks/flutter/bota_flutter_sdk/lib/src/generated/bota_api.g.dart`
- Generate: `frameworks/flutter/bota_flutter_sdk/ios/bota_flutter_sdk/Sources/bota_flutter_sdk/BotaApi.g.swift`
- Generate: `frameworks/flutter/bota_flutter_sdk/android/src/main/kotlin/dev/bota/sdk/flutter/BotaApi.g.kt`
- Create: `frameworks/flutter/bota_flutter_sdk/test/bridge_contract_test.dart`
- Create: `tools/flutter/generate-pigeon.sh`
- Create: `tools/flutter/verify-pigeon.mjs`
- Create: `tools/flutter/verify-pigeon.test.mjs`
- Modify: `tools/flutter/verify-package.mjs`

**Interfaces:**
- Consumes: Task 2 public models and manager operations.
- Produces: `BotaHostApi`, `BotaFlutterApi`, typed bridge messages, and checked-in generator output consumed by Tasks 4-6.

- [ ] **Step 1: Write failing bridge and drift tests**

  Assert every public manager operation maps to one host method; every stream maps to `startSubscription` plus `cancelSubscription`; every callback kind maps to one Flutter API request; operation/subscription IDs must match `^[0-9a-f]{32}$`; and forbidden fields named `bytes`, `body`, `chunk`, `packet`, `password`, `grant`, or `privateKey` do not exist in event messages. The Node drift test copies the tree, changes one generated token, and expects verification to fail.

- [ ] **Step 2: Run tests and verify RED**

  ```bash
  tools/flutter/run-flutter.sh test frameworks/flutter/bota_flutter_sdk/test/bridge_contract_test.dart
  node --test tools/flutter/verify-pigeon.test.mjs
  ```

  Expected: FAIL because the schema and verifier are absent.

- [ ] **Step 3: Define and generate the Pigeon contract**

  Use typed enums/classes for bounded device, settings, recording, OTA, WiFi, error, progress, callback-request, and callback-result values. Host methods accept an operation ID plus typed arguments and return typed values or `void`; stream starts return no body and emit `BotaEventMessage` through `BotaFlutterApi.onEvent`. Application callback requests use `BotaFlutterApi.requestMaterial`, `requestFirmware`, and `persistFactoryResetResult` and return request-bound typed responses.

  `generate-pigeon.sh` runs the exact locked dependency, writes all three targets, and normalizes generator paths. `verify-pigeon.mjs` generates into a temporary directory and byte-compares every expected output. Application callback requests use `BotaFlutterApi.requestMaterial`, `requestFirmware`, and `persistFactoryResetResult`; the frozen bridge contains no unused upload-destination callback.

- [ ] **Step 4: Generate and verify GREEN**

  ```bash
  tools/flutter/generate-pigeon.sh
  tools/flutter/run-flutter.sh test frameworks/flutter/bota_flutter_sdk/test/bridge_contract_test.dart
  node --test tools/flutter/verify-pigeon.test.mjs
  npm run flutter:generate:check
  ```

  Expected: all checks pass and a second generation leaves `git diff` empty.

- [ ] **Step 5: Commit the bridge contract**

  ```bash
  git add frameworks/flutter/bota_flutter_sdk/pigeons frameworks/flutter/bota_flutter_sdk/pigeon_options.yaml frameworks/flutter/bota_flutter_sdk/lib/src/generated frameworks/flutter/bota_flutter_sdk/ios/bota_flutter_sdk/Sources/bota_flutter_sdk/BotaApi.g.swift frameworks/flutter/bota_flutter_sdk/android/src/main/kotlin/dev/bota/sdk/flutter/BotaApi.g.kt tools/flutter
  git commit -m "feat(flutter): add typed native bridge" \
    -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
  ```

### Task 4: Dart Bridge Runtime, Callbacks, Streams, And Lifecycle

**Files:**
- Create: `frameworks/flutter/bota_flutter_sdk/lib/src/pigeon_platform.dart`
- Create: `frameworks/flutter/bota_flutter_sdk/lib/src/bridge_mapper.dart`
- Create: `frameworks/flutter/bota_flutter_sdk/lib/src/request_ids.dart`
- Create: `frameworks/flutter/bota_flutter_sdk/test/client_lifecycle_test.dart`
- Create: `frameworks/flutter/bota_flutter_sdk/test/stream_lifecycle_test.dart`
- Create: `frameworks/flutter/bota_flutter_sdk/test/callback_broker_test.dart`
- Modify: `frameworks/flutter/bota_flutter_sdk/lib/src/client.dart`

**Interfaces:**
- Consumes: Task 3 generated `BotaHostApi` and `BotaFlutterApi`.
- Produces: one `PigeonBotaPlatform` per Flutter engine, exact-once stream cancellation, request-bound callback dispatch, and public manager implementations used by applications.

- [ ] **Step 1: Write failing lifecycle, stream, and callback tests**

  With an in-memory fake `BotaHostApi`, verify configure is idempotent for equivalent configuration and rejects incompatible reconfiguration; destroy is idempotent; every stream receives only events with its own 32-hex ID; cancel sends exactly once on listener cancel/error/destroy; late events are ignored; native errors become stable `BotaSdkException`; callback results reject wrong, duplicate, expired, or wrong-kind IDs; callback payloads do not appear in exception/log text.

- [ ] **Step 2: Run focused tests and verify RED**

  ```bash
  tools/flutter/run-flutter.sh test \
    frameworks/flutter/bota_flutter_sdk/test/client_lifecycle_test.dart \
    frameworks/flutter/bota_flutter_sdk/test/stream_lifecycle_test.dart \
    frameworks/flutter/bota_flutter_sdk/test/callback_broker_test.dart
  ```

  Expected: FAIL on missing runtime classes.

- [ ] **Step 3: Implement the Dart bridge runtime**

  `RequestId.next()` creates 16 cryptographically random bytes and renders lowercase hex. `PigeonBotaPlatform` owns maps of pending operations, active stream controllers, and callback requests. It installs one generated Flutter API handler, routes events by ID and kind, converts generated values through pure `BridgeMapper` functions, and removes ownership before completing/cancelling to make reentrancy harmless. `BotaDeviceClient.destroy()` rejects pending work with `client_destroyed`, cancels all subscriptions once, clears callbacks, then calls the host destroy method.

- [ ] **Step 4: Run Dart runtime verification**

  ```bash
  tools/flutter/run-flutter.sh test frameworks/flutter/bota_flutter_sdk/test
  tools/flutter/run-flutter.sh analyze frameworks/flutter/bota_flutter_sdk
  tools/flutter/run-dart.sh format --output=none --set-exit-if-changed \
    $(find frameworks/flutter/bota_flutter_sdk/lib \
      frameworks/flutter/bota_flutter_sdk/test -name '*.dart' \
      ! -path '*/lib/src/generated/*' -print)
  ```

  Expected: PASS with no leaks reported by the lifecycle tests.

- [ ] **Step 5: Commit the Dart runtime**

  ```bash
  git add frameworks/flutter/bota_flutter_sdk/lib frameworks/flutter/bota_flutter_sdk/test
  git commit -m "feat(flutter): implement bridge lifecycle" \
    -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
  ```

### Task 5: Apple Native Delegation

**Files:**
- Create: `frameworks/flutter/bota_flutter_sdk/ios/bota_flutter_sdk.podspec`
- Create: `frameworks/flutter/bota_flutter_sdk/ios/bota_flutter_sdk/Package.swift`
- Create: `frameworks/flutter/bota_flutter_sdk/ios/bota_flutter_sdk/Sources/bota_flutter_sdk/BotaFlutterSdkPlugin.swift`
- Create: `frameworks/flutter/bota_flutter_sdk/ios/bota_flutter_sdk/Sources/bota_flutter_sdk/BotaAppleAdapter.swift`
- Create: `frameworks/flutter/bota_flutter_sdk/ios/bota_flutter_sdk/Sources/bota_flutter_sdk/BotaAppleMapper.swift`
- Create: `frameworks/flutter/bota_flutter_sdk/ios/bota_flutter_sdk/Sources/bota_flutter_sdk/NativeLeaseCoordinator.swift`
- Create: `frameworks/flutter/bota_flutter_sdk/ios/Tests/BotaAppleAdapterTests.swift`
- Create: `frameworks/flutter/bota_flutter_sdk/ios/Tests/NativeLeaseCoordinatorTests.swift`
- Create: `tools/flutter/test-apple-adapter.sh`
- Modify: `frameworks/flutter/bota_flutter_sdk/pubspec.yaml`
- Modify: `platforms/apple/Sources/BotaAppleSDK/Bluetooth/CoreBluetoothHost.swift`
- Modify: `platforms/apple/Sources/BotaAppleSDK/Bluetooth/CoreBluetoothDriver.swift`
- Create: `platforms/apple/Tests/BotaAppleSDKTests/CoreBluetoothDriverCancellationTests.swift`

**Interfaces:**
- Consumes: generated `BotaHostApi`, `BotaFlutterApi`, native `BotaAppleSDK.BotaDeviceClient.shared`, and exact native public manager methods.
- Produces: iOS host implementation with per-engine registries and process-wide shared-client leases.

- [ ] **Step 1: Write failing Swift adapter tests**

  Compile tests against protocol-shaped fake native managers and assert mapping for all one-shot operations, stream start/cancel, callback request/result, native error fields, unknown enum raw values, and large-value rejection. Lease tests assert equivalent configuration coalesces, a conflict returns `configuration_conflict`, detaching one engine removes only its work, failed native cancellation retains category ownership until the original operation terminates, a throwing stream stop cannot use collector completion as native-terminal proof, suspended stream startup remains owned until its exact task unwinds, and the final release destroys the shared client once. Native driver tests cancel suspended direct reads and writes before and after continuation registration, remove cancelled per-peripheral gate waiters without releasing the holder, keep notifications flowing without clearing read quarantine, quarantine same-characteristic reuse until an unambiguous stale callback or disconnect, and reject late CoreBluetooth callbacks exactly once.

- [ ] **Step 2: Run Apple tests and verify RED**

  ```bash
  tools/flutter/test-apple-adapter.sh
  ```

  Expected: FAIL because the plugin adapter is missing.

- [ ] **Step 3: Implement the Swift plugin and adapter**

  Register the generated setup on each `FlutterPluginRegistrar`. The adapter validates operation IDs before touching native state, maps to native value types explicitly, stores connected/discovered handles only in a per-engine registry, and consumes native `AsyncStream`/`AsyncThrowingStream` values in owned tasks. Cancellation removes the task before invoking the corresponding native cancellation/stop method. Callback closures invoke the generated Flutter API and validate the response ID/kind before returning native bytes or URL requests. No callback value is logged.

  Direct CoreBluetooth reads and writes install cancellation-aware gate waiters and continuations before dispatching native work. Gate handoff has an explicit granted-before-registration state, and queue-first callback removal makes cancellation arbitration atomic with quarantine installation. Task cancellation removes and resumes the matching waiter or continuation exactly once; registration races and late delegate callbacks cannot revive it. A cancelled read characteristic rejects reuse until an unambiguous stale response or disconnect clears quarantine; same-characteristic notifications continue to their subscriber and never clear that boundary. Subscription startup is tracked before process-wide coordinator acquisition. Detach and public cancellation cancel and await that exact start task, distinguish failure without native work from a returned native stream, and stop only returned work. A returned stream plus failed stop remains poisoned until final shared-client destruction; neither startup-task completion nor collector completion is terminal proof. Another engine cannot acquire or cancel that category during recovery.

  Flutter Swift Package Manager integration resolves the exact synchronized Git tag and `BotaAppleSDK` product. CocoaPods depends fail-closed on the exact synchronized `BotaAppleSDK` pod; the native Apple package therefore supplies and tests its own podspec instead of relying on a React-Native-only `spm_dependency` helper. Both integrations compile the same adapter source. The generated Flutter bridge uses Swift 5 language mode under the pinned Swift 6 toolchain because Pigeon 28 generated code is not Swift 6 sendability-clean; the native `BotaAppleSDK` remains Swift 6.

- [ ] **Step 4: Run Apple adapter and package tests**

  ```bash
  tools/flutter/test-apple-adapter.sh
  tools/apple/test-package.sh -Xswiftc -strict-concurrency=complete -Xswiftc -warnings-as-errors
  ```

  Expected: all Swift tests and compilation pass.

- [ ] **Step 5: Commit Apple support**

  ```bash
  git add frameworks/flutter/bota_flutter_sdk/ios frameworks/flutter/bota_flutter_sdk/pubspec.yaml tools/flutter/test-apple-adapter.sh
  git commit -m "feat(flutter): delegate Apple device operations" \
    -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
  ```

### Task 6: Android Native Delegation

**Files:**
- Create: `frameworks/flutter/bota_flutter_sdk/android/build.gradle.kts`
- Create: `frameworks/flutter/bota_flutter_sdk/android/settings.gradle.kts`
- Create: `frameworks/flutter/bota_flutter_sdk/android/sdk-version.toml`
- Create: `frameworks/flutter/bota_flutter_sdk/android/src/main/AndroidManifest.xml`
- Create: `frameworks/flutter/bota_flutter_sdk/android/src/main/kotlin/dev/bota/sdk/flutter/BotaFlutterSdkPlugin.kt`
- Create: `frameworks/flutter/bota_flutter_sdk/android/src/main/kotlin/dev/bota/sdk/flutter/BotaAndroidAdapter.kt`
- Create: `frameworks/flutter/bota_flutter_sdk/android/src/main/kotlin/dev/bota/sdk/flutter/BotaAndroidMapper.kt`
- Create: `frameworks/flutter/bota_flutter_sdk/android/src/main/kotlin/dev/bota/sdk/flutter/NativeLeaseCoordinator.kt`
- Create: `frameworks/flutter/bota_flutter_sdk/android/src/test/kotlin/dev/bota/sdk/flutter/BotaAndroidAdapterTest.kt`
- Create: `frameworks/flutter/bota_flutter_sdk/android/src/test/kotlin/dev/bota/sdk/flutter/NativeLeaseCoordinatorTest.kt`
- Create: `tools/flutter/test-android-adapter.sh`
- Modify: `platforms/android/sdk/src/main/kotlin/dev/bota/sdk/FactoryResetManager.kt`
- Modify: `platforms/android/sdk/src/main/kotlin/dev/bota/sdk/model/SecurityModels.kt`
- Modify: `platforms/android/sdk/src/test/kotlin/dev/bota/sdk/FactoryResetManagerTest.kt`
- Modify: `platforms/android/sdk/src/test/kotlin/dev/bota/sdk/ProvisioningManagerTest.kt`
- Modify: `platforms/android/sdk/api/sdk.api`
- Modify: `platforms/android/README.md`
- Modify: `AGENTS.md`
- Modify: `ARCHITECTURE.md`

**Interfaces:**
- Consumes: generated `BotaHostApi`, `BotaFlutterApi`, native `dev.bota.sdk.BotaDeviceClient.shared`, Android application context, and Kotlin coroutine flows.
- Produces: Android host implementation with the same behavior and error surface as Task 5.

- [ ] **Step 1: Write failing Kotlin adapter tests**

  Assert the same operation, stream, callback, error, unknown-enum, bounds, and lease behaviors as Apple. Add API 26 tests for integer conversions and API 35 tests for permission errors passing through stable native error codes.

- [ ] **Step 2: Run Android tests and verify RED**

  ```bash
  tools/flutter/test-android-adapter.sh
  ```

  Expected: FAIL because the Gradle plugin and adapter do not exist.

- [ ] **Step 3: Implement the Kotlin plugin and adapter**

  Attach to the Flutter engine application context, install the generated host API, and create an engine-owned `SupervisorJob + Dispatchers.Main.immediate` scope. Validate IDs and map values before launching. Collect native flows into generated Flutter API calls; remove collectors before native cancel/stop. On detach, cancel the engine scope, fail its pending results, clear only its registries, and release the shared native lease. The Gradle build reads `sdk-version.toml`, rejects a mismatched override, depends on `dev.bota:bota-android-sdk:<version>`, sets `minSdk=26`, and uses the repository's pinned Kotlin/coroutines versions.

- [ ] **Step 4: Run Android adapter and native tests**

  ```bash
  tools/flutter/test-android-adapter.sh
  platforms/android/gradlew -p platforms/android :sdk:testDebugUnitTest
  platforms/android/gradlew -p platforms/android :sdk:apiCheck
  ```

  Expected: all Kotlin tests pass.

- [ ] **Step 5: Commit Android support**

  ```bash
  git add frameworks/flutter/bota_flutter_sdk/android tools/flutter/test-android-adapter.sh platforms/android/sdk platforms/android/README.md AGENTS.md ARCHITECTURE.md
  git commit -m "feat(flutter): delegate Android device operations" \
    -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
  ```

### Task 7: Consumer Examples, Conformance, And Public Documentation

**Files:**
- Create: `frameworks/flutter/bota_flutter_sdk/example/pubspec.yaml`
- Create: `frameworks/flutter/bota_flutter_sdk/example/lib/main.dart`
- Create: `frameworks/flutter/bota_flutter_sdk/example/ios/Runner/Info.plist`
- Create: `frameworks/flutter/bota_flutter_sdk/example/android/app/src/main/AndroidManifest.xml`
- Create: `frameworks/flutter/bota_flutter_sdk/test/workflow_conformance_test.dart`
- Create: `tools/flutter/test-consumers.sh`
- Create: `frameworks/flutter/bota_flutter_sdk/README.md`
- Create: `frameworks/flutter/bota_flutter_sdk/CHANGELOG.md`
- Create: `frameworks/flutter/bota_flutter_sdk/AGENTS.md`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `AGENTS.md`
- Modify: `docs/releasing.md`

**Interfaces:**
- Consumes: Tasks 2-6 package API and fake native bridge, canonical `protocol/workflows/*.json`, and package verification command.
- Produces: release-mode iOS/Android consumers, 29 trace conformance evidence, public setup guidance, and repository maintenance context.

- [ ] **Step 1: Write failing workflow-conformance and consumer checks**

  Feed every canonical workflow trace through a fake host facade and assert Dart emits the expected typed operation/event/error sequence without reducer logic. `test-consumers.sh` must fail when iOS Bluetooth usage descriptions are missing, Android permissions are missing, or either release build cannot resolve the exact local native artifact.

- [ ] **Step 2: Run conformance tests and verify RED**

  ```bash
  tools/flutter/run-flutter.sh test frameworks/flutter/bota_flutter_sdk/test/workflow_conformance_test.dart
  tools/flutter/test-consumers.sh
  ```

  Expected: FAIL because fixtures and example consumers are not wired.

- [ ] **Step 3: Add examples and documentation**

  The example is an actual device-management screen with scan, connect, status, recording list, WiFi, OTA progress, remove-only, and factory-reset actions; secrets and grants are supplied through callback stubs that deliberately throw until the application integrates its backend. README documents install, permissions, configure/destroy, serial-strict reconnect, encrypted batch handoff, OTA progress, WiFi, reset, errors, unsupported streaming/targets, and version-channel policy. Repository docs record Flutter as implemented only after gates pass.

- [ ] **Step 4: Run conformance and release-mode consumers**

  ```bash
  tools/flutter/run-flutter.sh test frameworks/flutter/bota_flutter_sdk/test
  tools/flutter/test-consumers.sh
  npm run flutter:verify
  ```

  Expected: 29 canonical traces pass; Android and iOS release-mode example builds pass.

- [ ] **Step 5: Commit examples and docs**

  ```bash
  git add frameworks/flutter/bota_flutter_sdk/example frameworks/flutter/bota_flutter_sdk/README.md frameworks/flutter/bota_flutter_sdk/CHANGELOG.md frameworks/flutter/bota_flutter_sdk/AGENTS.md frameworks/flutter/bota_flutter_sdk/test/workflow_conformance_test.dart tools/flutter/test-consumers.sh README.md ARCHITECTURE.md AGENTS.md docs/releasing.md
  git commit -m "docs(flutter): add consumers and integration guide" \
    -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
  ```

### Task 8: Synchronized Version, CI, Release Inventory, And pub.dev Bootstrap

**Files:**
- Create: `tools/flutter/package-release.sh`
- Create: `tools/flutter/verify-publication.mjs`
- Create: `tools/flutter/verify-publication.test.mjs`
- Create: `.github/workflows/publish-flutter.yml`
- Create: `.github/workflows/publish-apple-pod.yml`
- Modify: `sdk-version.toml`
- Modify: `package.json`
- Modify: `frameworks/react-native/package.json`
- Modify: `frameworks/react-native/package-lock.json`
- Modify: `platforms/android/gradle.properties`
- Modify: `release/schema/release-manifest.schema.json`
- Modify: `tools/xtask/src/lib.rs`
- Modify: `tools/release/write-candidate-inventory.test.mjs`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `frameworks/flutter/bota_flutter_sdk/pubspec.yaml`
- Modify: `frameworks/flutter/bota_flutter_sdk/android/sdk-version.toml`
- Modify: `Package.swift`
- Modify: `platforms/apple/BotaAppleSDK.podspec`
- Create: `release/examples/1.2.0-beta.0.json`
- Create: `release/evidence/1.2.0-beta.0-flutter.md`

**Interfaces:**
- Consumes: verified package from Tasks 1-7 and existing protected synchronized release workflow.
- Produces: synchronized `1.2.0-beta.0` candidates, Flutter release manifest artifact, protected first-publish pause, future pub.dev OIDC workflow, and checksum verification.

- [ ] **Step 1: Write failing release and publication tests**

  Extend xtask tests so Flutter is required only when a manifest declares the Flutter capability, then require package identifier `bota_flutter_sdk`, version equality, normalized archive SHA-256, source revision, generator identity, and package inventory. Node tests create a synthetic `.tar.gz`, reject traversal/symlink escape/extra files/checksum mismatch, and accept an exact normalized public archive. Workflow contract tests require the Flutter build job, candidate artifact, publish dependency, protected bootstrap pause, and a separate OIDC workflow restricted to `v{{version}}` tags.

- [ ] **Step 2: Run release tests and verify RED**

  ```bash
  cargo test -p xtask
  node --test tools/flutter/verify-publication.test.mjs tools/release/*.test.mjs
  ```

  Expected: FAIL because Flutter artifact validation and publication tooling are absent.

- [ ] **Step 3: Implement synchronized metadata and release tooling**

  Set `sdk-version.toml`, root/npm/Gradle/Flutter versions, and the packaged Flutter Android `sdk-version.toml` copy to `1.2.0-beta.0`; add a drift check for the packaged copy and regenerate locks. `package-release.sh` performs pub get, generation drift, format, analyze, test, package inventory, license check, and `flutter pub publish --dry-run`; it preserves the exact package candidate and evidence under `target/flutter-release/`. Extend the candidate inventory and release manifest without changing the legacy npm `latest` guard.

  The tag workflow publishes the immutable Apple core asset first, and the tagged root Swift package resolves that exact URL and checksum rather than an untracked local artifact. A protected native-pod bootstrap then publishes and verifies `BotaAppleSDK` at the synchronized version before either Flutter dependency manager is allowed to proceed. The Flutter job builds and uploads its candidate only after clean no-override CocoaPods and SwiftPM consumers resolve the public Apple release. For the first Flutter package version it pauses at the protected release environment and prints the exact clean-tag interactive publish command, then downloads the public pub.dev archive and verifies normalized files, contents, and SHA-256 before completing the GitHub release. `.github/workflows/publish-flutter.yml` uses Dart's reusable pub.dev OIDC workflow for subsequent tags and has no repository secret.

- [ ] **Step 4: Run the complete local release gate**

  ```bash
  npm run test:tooling
  npm run test:release
  npm run flutter:verify
  tools/flutter/package-release.sh --check
  cargo xtask release validate release/examples/1.2.0-beta.0.json
  cargo fmt --all -- --check
  cargo clippy --workspace --all-targets --all-features -- -D warnings
  cargo test --workspace
  platforms/android/gradlew -p platforms/android :sdk:testDebugUnitTest
  tools/apple/test-package.sh -Xswiftc -strict-concurrency=complete -Xswiftc -warnings-as-errors
  git diff --check
  ```

  Expected: every gate passes; no registry publication occurs locally.

- [ ] **Step 5: Commit release integration**

  ```bash
  git add sdk-version.toml package.json frameworks/react-native/package.json frameworks/react-native/package-lock.json platforms/android/gradle.properties release tools/xtask/src/lib.rs tools/flutter .github/workflows frameworks/flutter/bota_flutter_sdk/pubspec.yaml frameworks/flutter/bota_flutter_sdk/android/sdk-version.toml Package.swift platforms/apple/BotaAppleSDK.podspec
  git commit -m "build(flutter): integrate synchronized beta release" \
    -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
  ```

### Task 9: Final Review And Main Integration

**Files:**
- Modify if findings require: only files introduced or intentionally changed by Tasks 1-8.
- Create: `release/evidence/1.2.0-beta.0-flutter-review.md`

**Interfaces:**
- Consumes: complete branch, spec, task ledger, and all verification output.
- Produces: reviewed main-branch implementation ready for the separately authorized annotated tag and public first publish.

- [ ] **Step 1: Run a whole-branch specification and security review**

  Review every spec requirement, native operation mapping, stream/callback ownership path, detach path, secret boundary, package file, release workflow permission, and public-doc claim. Record concrete commands and results in the review evidence file.

- [ ] **Step 2: Fix findings test-first and re-run affected gates**

  For every behavioral finding, add a failing regression test, demonstrate RED, implement the smallest fix, and demonstrate GREEN. Generated/configuration-only corrections must pass their drift or package contract test.

- [ ] **Step 3: Run final verification from a clean checkout state**

  ```bash
  npm ci
  npm run test:tooling
  npm run test:release
  npm run check
  npm run flutter:verify
  tools/flutter/package-release.sh --check
  cargo fmt --all -- --check
  cargo clippy --workspace --all-targets --all-features -- -D warnings
  cargo test --workspace
  git diff --check
  git status --short
  ```

  Expected: all checks pass and status contains only the review evidence before its commit.

- [ ] **Step 4: Commit review evidence**

  ```bash
  git add release/evidence/1.2.0-beta.0-flutter-review.md
  git commit -m "test(flutter): record beta release verification" \
    -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
  ```

- [ ] **Step 5: Merge and push after verifying remote ancestry**

  Fetch `origin/main`, rebase or merge only when it preserves the reviewed commits, verify the full gate again if integration changes content, fast-forward local `main`, and push `main`. Do not create a tag or publish to pub.dev, Maven Central, npm, or GitHub Releases without a separate explicit authorization.
