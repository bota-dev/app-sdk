# React Native Runtime Owners Compatibility Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:executing-plans` to implement this plan task by task. Commit and
> push each runtime owner independently. Do not export an owner until its exact
> frozen surface, behavior tests, native lifecycle tests, and linked-consumer
> gate pass.

**Goal:** Restore the four remaining runtime exports from
`@bota.dev/react-native-sdk` `0.0.65`: `RecordingManager`,
`StreamingSession`, `OTAManager`, and the singleton `BotaClient`.

**Architecture:** Rust and the Apple/Android facades continue to own BLE
workflow decisions and high-volume recording or firmware payloads. The React
Native layer owns the frozen JavaScript object model, application callbacks,
upload metadata, event translation, and lifecycle composition. Native upload
and streaming operations may request URLs or completion decisions from
JavaScript through one-shot request IDs, but raw recording bytes never enter a
Codegen value. The legacy `downloadFirmware()` compatibility method downloads
directly through React Native's network runtime because its frozen return type
is `ArrayBuffer`; `performUpdate()` does not call it and remains native
URL-driven end to end.

**Frozen authority:**
`protocol/baseline/react-native-public-api-0.0.65.json`, captured from source
revision `44ac1221cb71eb01cafcdbfdf7a370847d3a10b4`.

## Task 1: Freeze Runtime-Owner Behavior

**Files:**

- Create: `frameworks/react-native/test/recording-manager-compatibility.test.mjs`
- Create: `frameworks/react-native/test/streaming-session-compatibility.test.mjs`
- Create: `frameworks/react-native/test/ota-manager-compatibility.test.mjs`
- Create: `frameworks/react-native/test/bota-client-compatibility.test.mjs`
- Modify: `frameworks/react-native/test/compatibility-surface.test.mjs`

1. Capture explicit calls for every non-inherited frozen member and accessor.
2. Cover ordering, cancellation, synchronous listener removal, and destroy.
3. Verify payloads never appear in Codegen declarations.
4. Keep all four exports deferred while the tests are red.

## Task 2: Restore `RecordingManager`

**Status:** Complete. The root export was released with Task 3 because the
frozen `RecordingManager` surface includes streaming-session methods. The
shared reducer stages encrypted packets in relay wire format, both native hosts
own file upload and queue persistence, transfer completion reports actual E2E
and SHA-256 metadata, and device deletion occurs only after upload success.

**JavaScript files:**

- Create: `frameworks/react-native/src/managers/RecordingManager.ts`
- Modify: `frameworks/react-native/src/client.ts`
- Modify: `frameworks/react-native/src/index.ts`
- Modify: `frameworks/react-native/src/specs/NativeBotaDeviceSDK.ts`

**Native files:**

- Add an Apple recording-file upload owner under
  `frameworks/react-native/ios/`.
- Add an Android recording-file upload owner under
  `frameworks/react-native/android/src/main/java/dev/bota/sdk/reactnative/`.
- Extend the Objective-C++ and Kotlin generated-spec modules only with typed
  file-path/upload metadata and progress events.

**Behavior:**

1. `listRecordings()` delegates to the native recording facade.
2. `syncRecording()` transfers to a native file, queues a native file upload,
   waits for completion, and confirms the exact recording only after upload
   success. It emits the frozen stage sequence and events.
3. E2E ciphertext uses `UploadInfo.relay`; plaintext uses the presigned object
   URL plus optional completion callback. The platform uploader owns file IO.
4. Queue metadata is persisted atomically by the native host. Paused, retry,
   clear, and cancel methods preserve the frozen behavior.
5. `syncAllRecordings()` delegates upload ownership to the native reducer. BLE
   fallback begins only for a native `bluetooth_fallback` result.
6. `getStorageInfo()` uses the native status/storage read and preserves the
   frozen return shape.
7. Keep `RecordingManager` and `StreamingSession` root exports deferred together
   until Task 3 adds the frozen streaming methods and both exact surfaces pass.

**Verification:**

```bash
cd frameworks/react-native
npm run typecheck
node --test test/recording-manager-compatibility.test.mjs
npm run test:surface:exact
swift test -Xswiftc -strict-concurrency=complete -Xswiftc -warnings-as-errors
./gradlew testDebugUnitTest lintDebug assembleRelease
```

Commit: `feat(react-native): restore RecordingManager compatibility`

## Task 3: Restore `StreamingSession`

**Status:** Complete. The shared reducer owns deterministic live-transfer
ordering; Apple and Android own buffers, retries, uploads, finalization, and
cancellation; the React Native owner preserves the frozen surface and passes
the generated Apple and Android consumer gates without carrying payload bytes
through Codegen.

**Core and facade files:**

- Add a deterministic live-recording transfer workflow to
  `core/device-sdk-core` and `bindings/device-sdk-ffi`.
- Add native Apple and Android streaming-session owners that retain buffers,
  split plaintext chunks, preserve encrypted chunk sequence metadata, and
  perform uploads without crossing Codegen with payload bytes.
- Add one-shot Codegen requests for create-recording, chunk URL, and finalize
  metadata plus typed progress/state events.

**JavaScript files:**

- Create: `frameworks/react-native/src/managers/StreamingSession.ts`
- Modify: `frameworks/react-native/src/managers/RecordingManager.ts`
- Modify: `frameworks/react-native/src/client.ts`
- Modify: `frameworks/react-native/src/index.ts`

**Behavior:**

1. Preserve the frozen constructor and getters.
2. `start()` resolves create-recording metadata before native BLE streaming.
3. One session exists per `RecordingManager`; completion, disconnect, error,
   abort, and destroy release ownership exactly once.
4. Native code requests upload URLs by sequence and owns bytes, retries, E2E
   framing, finalization ordering, and cancellation.
5. Export `StreamingSession` only after exact surface and lifecycle tests pass.

Commit: `feat(react-native): restore StreamingSession compatibility`

## Task 4: Restore `OTAManager`

**Status:** Complete. The compatibility owner preserves CDN checks, direct XHR
downloads, frozen progress events, and native URL-driven updates. Apple and
Android calculate CRC32 from the downloaded firmware bytes, Rust owns transfer
and serial-strict reconnect, and destroy cancels native OTA ownership.

**Files:**

- Create: `frameworks/react-native/src/managers/OTAManager.ts`
- Modify: `frameworks/react-native/src/index.ts`
- Test: `frameworks/react-native/test/ota-manager-compatibility.test.mjs`

**Behavior:**

1. `checkForUpdate()` preserves CDN query, 404, semantic-version, and event
   behavior.
2. `downloadFirmware()` preserves the frozen direct `ArrayBuffer` contract and
   byte progress through `XMLHttpRequest`; this method is not used by
   `performUpdate()`.
3. `performUpdate()` delegates URL download and BLE transfer to
   `BotaDeviceSDK.ota`, translates phases to frozen stages, and writes an
   optional grant before native update. Native hosts calculate CRC32 from the
   downloaded bytes and Rust waits for serial-strict reconnect after reboot.
4. Destroy removes listeners and cancels native OTA ownership.

Commit: `feat(react-native): restore OTAManager compatibility`

## Task 5: Restore `BotaClient`

**Files:**

- Create: `frameworks/react-native/src/BotaClient.ts`
- Modify: `frameworks/react-native/src/compatibility/runtime.ts`
- Modify: `frameworks/react-native/src/index.ts`
- Test: `frameworks/react-native/test/bota-client-compatibility.test.mjs`

**Behavior:**

1. Preserve the singleton runtime value and exact accessors.
2. Coalesce concurrent configure calls and serialize configure/destroy through
   the existing native client.
3. Compose one `DeviceManager`, `RecordingManager`, and `OTAManager` per ready
   lifecycle. Manager access before readiness throws frozen
   `SdkError.notInitialized()`.
4. Translate native SDK/Bluetooth state into frozen events without importing
   `react-native-ble-plx`.
5. Reconfigure destroys the previous owner graph before creating the next one.
6. `setLogLevel()` and `setLogHandler()` preserve the frozen logger behavior.

Commit: `feat(react-native): restore BotaClient compatibility`

**Status (2026-08-31): complete.** The singleton now serializes native
configure/destroy ownership, coalesces duplicate calls without losing a
configure queued after destroy, composes one manager graph per ready lifecycle,
and preserves the frozen logger and event surface. The exact contract gate now
matches all 80 baseline exports.

## Task 6: Final Compatibility And Release Gates

1. Remove all four names from `deferredWorkflowClasses`; require 80 of 80
   frozen exports and the exact surface digest.
2. Run Rust workspace, Apple strict-concurrency, Android unit/lint/release,
   React Native verify, Apple CocoaPods consumer, Android packaged-AAR
   consumer, dependency-license, and deterministic package gates.
3. Update `README.md`, `ARCHITECTURE.md`, `AGENTS.md`, and the implementation
   status plan after searching the repository documentation for all affected
   symbols.
4. Run Demo and Bota One local app acceptance before marking the React Native
   package installable or publishing npm.

Commit: `feat(react-native): complete frozen runtime compatibility`

**Gate remediation (2026-08-31):** final verification made the Rust workflow
changes `rustfmt`-clean, updated the external Apple consumer to pass the
required remove-only deprovision grant, and made React Native Apple streaming
progress capture synchronous so the strict lifecycle gate observes every
callback deterministically.

## Exit Criteria

- All 80 frozen exports match exactly.
- Recording and streaming bytes never enter Codegen values.
- OTA `performUpdate()` remains URL-driven and native-owned.
- Destroy/cancel tests prove every native operation and one-shot request is
  released exactly once.
- Demo and Bota One pass the Milestone 4 physical-device acceptance matrix.
- npm publication remains blocked until the app gates pass, even when package
  construction succeeds locally.
