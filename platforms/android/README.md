# Bota SDK for Android

This directory is the unpublished Android facade for the Bota App SDK family.
It produces `dev.bota:bota-android-sdk` from the synchronized version in the
repository root. The AAR packages the frozen Rust ABI and a thin internal JNI
ownership adapter; the legacy Android repository remains a migration input
until the public facade, physical-device, compatibility, and release gates pass.

## Toolchain

- JDK 17
- Gradle 8.13
- Android Gradle Plugin 8.13.2
- Kotlin 2.3.20
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
val connected = bota.devices.connect(serialNumber, selectedDevice)

bota.destroy()
```

Discovery, manual connection, and reconnect are Rust-owned workflows. A manual
connection requires the selected peripheral plus the expected serial number;
reconnect accepts saved peripheral and advertised-address hints. Display names
are never identity. Connection and device-status observations are Kotlin
`Flow`s, and status payloads use the shared Rust decoder. Destroy cancels the
active workflow, ends status subscriptions, disconnects the verified device,
closes observers, and releases the native engine and Android Bluetooth thread.

## Verify

```bash
JAVA_HOME=/path/to/jdk-17 \
ANDROID_HOME="$HOME/Library/Android/sdk" \
npm --prefix ../.. run test:android:foundation
```

The foundation gate cross-compiles `libbota_device_sdk_ffi.so` and compiles
`libbota_android_jni.so` for `arm64-v8a`, `armeabi-v7a`, `x86_64`, and `x86`.
Release inspection requires exactly those two libraries under every AAR ABI:

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
