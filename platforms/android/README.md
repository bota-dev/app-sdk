# Bota SDK for Android

This directory is the unpublished Android facade for the Bota App SDK family.
It produces `dev.bota:bota-android-sdk` from the synchronized version in the
repository root. The AAR packages the frozen Rust ABI and a thin internal JNI
ownership adapter. The public facade and one-major `com.bota.sdk` compatibility
contract now pass JVM descriptor, source-consumer, precompiled-binary, API 26,
and API 35 gates. Maven Central publication and supervised physical-device
acceptance remain release gates.

## Toolchain

- JDK 17
- Gradle 8.13
- Android Gradle Plugin 8.13.2
- Kotlin 2.1.20
- Android API 26 minimum and API 36 compile, lint, and test target
- Android NDK 28.2.13676358
- CMake 3.22.1

Applications request Bluetooth runtime permissions. The library declares the
required permissions, including location for BLE scanning through API 30, and
the optional BLE hardware feature but never prompts the user itself.

## Client lifecycle

`BotaDeviceClient` owns one configured Android runtime. Configuration retains
the application context, is idempotent until `destroy()`, and may receive an
application-owned `OkHttpClient` or storage directory. Applications remain
responsible for requesting the permissions reported by
`BotaSDKError.AuthorizationRequired`.

```kotlin
val bota = BotaDeviceClient.shared
bota.configure(BotaConfiguration(applicationContext))

val scan = bota.devices.startScan()
val connected = bota.devices.connect(selectedDevice)

bota.destroy()
```

Discovery, manual connection, and reconnect are Rust-owned workflows. A manual
connection reads the selected peripheral's serial over GATT; callers that
already know the serial may use `connect(serialNumber, selectedDevice)` to
require an exact match. Reconnect always requires the serial and accepts saved
peripheral and advertised-address hints. Display names are never identity.
Connection and device-status observations are Kotlin
`Flow`s, and status payloads use the shared Rust decoder. Destroy cancels the
active workflow, ends status subscriptions, disconnects the verified device,
closes observers, and releases the native engine and Android Bluetooth thread.
Scan flows are cold: creating one does not reserve the engine, and every
collection owns a fresh command and cancellation ID. Late callbacks from a
destroyed or replaced runtime cannot publish connection state. Multiple status
collectors share device notification ownership, so one collector stopping does
not disable notifications for the others.

## Secure device lifecycle

`ProvisioningManager` resolves tokens and endpoint bytes through an
application callback registered under a random opaque ID. Connection settings
use the shared Rust encoder and always remove cellular configuration for Bota
Note. `deprovision` is remove-only and never invokes factory reset.

`FactoryResetManager` requires an application-supplied command ID, current
binding generation, and grant callback. The physical reset result is persisted
with that exact generation before receipt. After restart,
`resumePendingFactoryReset` rejects a different generation and sends only the
saved command's receipt workflow. Material callbacks are memory-only, and all
secure operations share the facade-wide operation owner with discovery and
connection workflows.

## Recording, OTA, and logs

`RecordingManager` lists recordings through subscribe-before-write BLE access,
syncs encrypted or plaintext recording bytes into a native no-backup file, and
returns its `Path` only after the reducer completes durable finalization.
Upload ownership emits only device-completed, device-preserved, or authorized
Bluetooth-fallback identifiers; applications still own backend destination
resolution.

`OTAManager` accepts a `FirmwareImage` containing an OkHttp `Request`. The URL,
headers, downloaded image, and blob path remain in Android hosts; Rust receives
only the opaque download ID and bounded bytes. `DeviceLogManager` emits complete
sanitized `DeviceLogLine` values. These APIs are cold Kotlin `Flow`s, and
collector termination, explicit cancellation, failure, success, and client
destroy all release their native registrations and shared operation owner.

## Verify

```bash
JAVA_HOME=/path/to/jdk-17 \
ANDROID_HOME="$HOME/Library/Android/sdk" \
npm --prefix ../.. run test:android:foundation
```

The foundation gate cross-compiles `libbota_device_sdk_ffi.so` and compiles
`libbota_android_jni.so` for `arm64-v8a`, `armeabi-v7a`, `x86_64`, and `x86`.
Both native link steps set the 16 KiB maximum and common page size explicitly.
Release inspection requires exactly those two libraries under every AAR ABI
and rejects 64-bit ELF load segments aligned below `0x4000`:

```bash
tools/android/build-native.sh
tools/android/inspect-aar.sh platforms/android/sdk/build/outputs/aar/sdk-release.aar
```

JNI ownership tests require one running Android target. On an API 35 emulator:

```bash
tools/android/test-package.sh --api 35 \
  --instrumentation-class dev.bota.sdk.internal.jni.NativeCoreBridgeTest
```

The instrumentation test loads both packaged libraries, drives ABI v1 codecs
and one workflow output through Rust, and checks exact-once engine, packet, and
error frees. Those counters are compiled into debug tests only.

Public Kotlin value models preserve unknown wire values and expose stable error
codes independently of diagnostics. Protocol serialization and parsing remain
in Rust; Android's mapper only converts typed ABI fields. The 50 canonical
protocol cases are mirrored into Android test assets and checked byte-for-byte:

```bash
npm run sync:android-fixtures
tools/android/test-package.sh --api 35 \
  --instrumentation-class dev.bota.sdk.internal.core.ProtocolCodecTest
```

Do not edit `src/androidTest/assets/ProtocolFixtures` directly. Run
`node tools/android/sync-protocol-fixtures.mjs` after changing a canonical
fixture, then rerun the check above.

One closeable, single-thread coroutine runtime owns every JNI engine call. It
preserves 128-bit cancellation IDs, lets Rust reject concurrent commands, and
converts all 10 commands, 30 host effects, 34 host events, and 12 notifications
without a Kotlin workflow implementation. The 29 canonical workflow scenarios
are mirrored into Android instrumentation assets:

```bash
npm run sync:android-workflows
tools/android/test-package.sh --api 35 \
  --instrumentation-class dev.bota.sdk.internal.core.WorkflowConformanceTest
```

Do not edit `src/androidTest/assets/WorkflowFixtures` directly. Regenerate it
with `node tools/android/sync-workflow-fixtures.mjs` after changing a canonical
workflow suite.

`HostEffectExecutor` routes every effect through typed Bluetooth, persistence,
secure-storage, network, application-material, recording-sink, or
firmware-blob ports. It owns timers, bounds returned bytes, allows multi-event
streams only for scan, subscribe, download, and upload, and converts platform
failures to correlated ABI events. Additions to ABI effect or event kinds must
extend its exhaustive tests before a host implementation changes.

`BluetoothGattHost` implements the Bluetooth port with one HandlerThread-owned
Android platform adapter. GATT operations are serialized per peripheral, not
globally; disconnect bypasses queued work, and a monotonic generation prevents
callbacks from a replaced GATT from satisfying current operations. Connect
negotiates MTU 517, while the following Rust-requested discovery effect verifies
that a Bota service exists. API 33+ uses value-bearing write APIs and older
versions use the legacy characteristic and descriptor fields. CCCD writes occur
only after local notification state changes.

The SDK filters scans by Bota service UUID or manufacturer ID and never uses an
advertised name as identity. It merges system-connected peripherals with live
scan results and honors the workflow's duplicate-delivery flag. Permission
checks return `BotaSDKError.AuthorizationRequired`; applications remain
responsible for prompts. Verify both permission contracts with:

```bash
tools/android/test-package.sh --api 26 \
  --instrumentation-class dev.bota.sdk.internal.bluetooth.BluetoothPermissionTest
tools/android/test-package.sh --api 35 \
  --instrumentation-class dev.bota.sdk.internal.bluetooth.BluetoothPermissionTest
```

Android durable hosts keep non-secret workflow journals in AtomicFile entries
under `noBackupFilesDir/bota-app-sdk/`. Factory-reset receipts bind the exact
command ID and registered binding generation. Secure-storage values are
AES-GCM ciphertext files whose non-exportable key remains in Android Keystore;
opaque key names are SHA-256-derived filenames and are also authenticated data.

Recording destinations and firmware sources are registered as opaque IDs backed
by a host path or ParcelFileDescriptor. Recording append progress is emitted
only after FileChannel force, finalization validates protocol CRC32, and firmware
reads reject zero-length or oversized chunks. Presigned OkHttp requests are also
registered outside Rust and consumed once. Response bodies and file resources
close on every terminal path; destroying the host cancels only its owned calls,
not unrelated requests on an injected OkHttpClient.

Run the JVM contracts plus real framework tests on both supported compatibility
targets:

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
```

Normal builds can publish unsigned artifacts only to the `Local` repository at
`target/android-m2`. Remote publication and signing require the exact
`botaProtectedSigning=true` Gradle property and release-environment credentials.
`VERSION_NAME` must match the root `sdk-version.toml`; Gradle rejects an
override rather than producing a differently versioned artifact.

CI creates `target/android-release` once, verifies its checksums and SPDX
document, and reconstructs `target/android-m2` from those files. Both emulator
lanes consume that repository and verify its AAR digest before and after the
lane. The helper creates a fresh CLI AVD, waits for `sys.boot_completed`,
disables animations, removes prior test packages, and always stops and deletes
the AVD:

```bash
tools/android/install-release-repository.sh target/android-release target/android-m2
tools/android/test-emulator-lane.sh --api 26
tools/android/test-emulator-lane.sh --api 35
```

API 26 uses `system-images;android-26;google_apis;x86`; API 35 uses
`system-images;android-35;google_apis;x86_64`. They are x86_64-host release
lanes and cannot be replaced by Apple Silicon arm64 images. Runtime Maven
coordinates and their approved licenses are frozen in
`protocol/baseline/android-maven-license-policy.json`; package generation and
the license workflow require that policy, Gradle module metadata, and the SPDX
document to match exactly.

Binary migration testing uses the checksummed
`protocol/baseline/android-legacy-consumer-0f06d2a.jar`. It contains only the
frozen Bota consumer bytecode compiled against the pinned legacy AAR, never the
legacy SDK itself. Normal CI verifies its revision, API-baseline digest, file
inventory, and bytecode references without access to the private source repo.
Maintainers regenerate it only with
`generate-legacy-consumer-fixture.sh --legacy-path` from the exact clean pinned
checkout.

The clean Maven consumer and legacy migration consumers resolve only from that
repository:

```bash
tools/android/verify-legacy-api.sh --legacy-path /path/to/pinned/legacy-sdk
tools/android/test-legacy-consumer.sh --api 26 --mode source
tools/android/test-legacy-consumer.sh --api 26 --mode binary \
  --legacy-path /path/to/pinned/legacy-sdk
tools/android/test-consumer.sh --api 26
```

After Maven Central publication is enabled, `test-public-consumer.sh` omits the
local repository entirely. The release workflow currently keeps that smoke
disabled by reporting `android-central-published=false`; physical-device
evidence and protected Central credentials must land before that value changes.

See [`docs/migration/android.md`](../../docs/migration/android.md) before
replacing the old AAR. The old and replacement AARs must never be packaged
together because both define `com.bota.sdk`.
