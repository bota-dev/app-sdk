# Android SDK Migration

The Bota SDK for Android is published as one artifact:

```kotlin
implementation("dev.bota:bota-android-sdk:1.0.2")
```

Remove the legacy AAR or project dependency before adding this artifact. Both
contain `com.bota.sdk` classes, so keeping both causes duplicate-class failures.
The replacement carries a deprecated `com.bota.sdk` adapter for one major
release; new code should import `dev.bota.sdk` directly.

## Recommended Migration

```kotlin
val bota = BotaDeviceClient.shared
bota.configure(BotaConfiguration(applicationContext))

val devices = bota.devices.startScan()
val connected = bota.devices.connect(expectedSerialNumber, selectedDevice)
```

The new API uses suspending lifecycle calls, cold `Flow` operations, explicit
serial verification, and application callbacks for provisioning and reset
material. Call `bota.destroy()` when the owning application scope ends.

## Compatibility Behavior

| Legacy API | Replacement behavior |
| --- | --- |
| `BotaClient` state and configuration properties | Preserved JVM accessors backed by the replacement lifecycle. |
| `configure` and `waitForBluetooth` | Suspend until native configuration or Bluetooth readiness completes, with the legacy defaults. |
| Scan, stop, disconnect, status read, and status subscription | Delegate to the native BluetoothGatt facade and convert models explicitly. |
| `connect(device)` | Delegates only when the advertised name is a serial number. Generic-name devices must migrate to `connect(serialNumber, device)`. Display names are never otherwise accepted as identity. |
| `provision` | Registers token and environment bytes as one-use in-memory material. Native workflow cleanup removes them on every terminal path. |
| `writeConnectionSettings` | Converts the complete model and applies Bota Note cellular normalization. |
| Recording list, transfer, and confirmation | Delegate to the Rust-owned recording workflow. Migrate upload ownership to the new application-authorized API. |
| `destroy()` | Returns immediately, rejects new work, and finishes native teardown on the SDK dispatcher. A later suspending `configure()` waits for teardown. |
| `BotaProtocol` raw helpers | Throw `BotaSdkException.UnsupportedOperation("Raw protocol helpers moved to the Rust core")`. |
| `BotaSdkVersion.current` | Remains a `const val` synchronized with `sdk-version.toml`. Already-compiled callers may retain their originally inlined value. |

Unknown wire values map to the legacy `ERROR` value when that enum has one.
Values without a safe legacy sentinel fail with `UnsupportedOperation` instead
of being mislabeled.

## Unsupported Legacy Options

The compatibility facade preserves source and binary signatures but rejects:

- caller-supplied `BluetoothTransport` implementations;
- directly constructed `DeviceManager`, `RecordingManager`, or `OtaManager`;
- non-default `backgroundSyncEnabled`, `wifiOnlyUpload`, or `debug` values;
- raw protocol parser and serializer calls.

`environment` and `logLevel` remain accepted. The default
`UnimplementedBluetoothTransport` sentinel selects the native BluetoothGatt
host. A non-exported provider captures only the application context needed by
that host; it performs no network or device operation during startup.

## Verification

The migration surface is frozen from legacy revision
`0f06d2a22c55e4976778520cce42230d23ca4226`. Release gates compare every JVM
descriptor, compile the checked-in source consumer against the replacement,
and execute bytecode compiled against the old AAR with only the replacement AAR
at runtime on API 26 and API 35.

```bash
tools/android/verify-legacy-api.sh --legacy-path /path/to/pinned/legacy-sdk
tools/android/test-legacy-consumer.sh --api 26 --mode source
BOTA_LEGACY_ANDROID_PATH=/path/to/pinned/legacy-sdk \
  tools/android/test-legacy-consumer.sh --api 26 --mode binary
tools/android/test-consumer.sh --api 26
```
