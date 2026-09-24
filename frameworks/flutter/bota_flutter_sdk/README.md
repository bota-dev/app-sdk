# Bota SDK for Flutter

`bota_flutter_sdk` is the Flutter facade for the Bota App SDK. It supports
Flutter applications on iOS 15+ and Android API 26+ by delegating Bluetooth,
file, network, and workflow ownership to `BotaAppleSDK` and
`dev.bota:bota-android-sdk`.

The source facade is implemented and passes local build and release-consumer
gates. The package was not part of the published synchronized `1.1.0` release.
`1.2.0-beta.0` is occupied by an immutable non-Flutter tag and must not be
reused. `1.2.0-beta.7` was partially published without a CocoaPod or Flutter
package. `1.2.0-beta.12` is the selected synchronized replacement candidate but
is not yet published on pub.dev. Until it is published and verified, consume
this package only from an exact source revision for development.

## Install

After the first Flutter beta is published, pin its exact prerelease version:

```yaml
dependencies:
  bota_flutter_sdk: 1.2.0-beta.12
```

For source development, point at an exact checkout rather than a moving branch:

```yaml
dependencies:
  bota_flutter_sdk:
    git:
      url: https://github.com/bota-dev/app-sdk.git
      ref: <exact-commit>
      path: frameworks/flutter/bota_flutter_sdk
```

Every Flutter package version must match the Apple and Android native artifact
version from the same synchronized release. Do not combine independently
versioned facade and native packages.

## Platform Setup

On iOS, set the deployment target to 15.0 or newer and add both Bluetooth usage
descriptions to `ios/Runner/Info.plist`:

```xml
<key>NSBluetoothAlwaysUsageDescription</key>
<string>Connect to and manage your Bota device.</string>
<key>NSBluetoothPeripheralUsageDescription</key>
<string>Connect to and manage your Bota device.</string>
```

On Android, set `minSdk` to 26 or newer and add the API-specific Bluetooth
permissions to `android/app/src/main/AndroidManifest.xml`:

```xml
<uses-permission
    android:name="android.permission.BLUETOOTH"
    android:maxSdkVersion="30" />
<uses-permission
    android:name="android.permission.BLUETOOTH_ADMIN"
    android:maxSdkVersion="30" />
<uses-permission
    android:name="android.permission.ACCESS_FINE_LOCATION"
    android:maxSdkVersion="30" />
<uses-permission
    android:name="android.permission.BLUETOOTH_SCAN"
    android:usesPermissionFlags="neverForLocation" />
<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
```

The SDK reports missing authorization; it never displays a system permission
prompt. The application must request the applicable runtime permissions before
scanning or connecting.

## Configure And Destroy

Create one client per Flutter engine and configure it before using a manager.
Application callbacks are the only bridge to your backend. They must return
request-bound provisioning material, reset authority, durable reset-result
acknowledgement, and firmware access without logging those values.

```dart
final BotaDeviceClient bota = BotaDeviceClient();

await bota.configure(
  BotaConfiguration(
    applicationSupportNamespace: 'com.example.my_app.bota',
    callbacks: BotaApplicationCallbacks(
      provisioningMaterial: backend.provisioningMaterial,
      factoryResetGrant: backend.factoryResetGrant,
      persistFactoryResetResult: backend.persistFactoryResetResult,
      firmware: backend.firmwareSource,
    ),
  ),
);
```

Call `await bota.destroy()` when the engine permanently stops using the SDK.
Destroy is terminal and idempotent. Cancel stream subscriptions before
destroying the client so application-owned listeners also finish promptly.

The SDK contains no Bota backend API client. A missing callback or a callback
that cannot verify its request must fail rather than returning cached or
unbound authority. The example deliberately throws from every backend stub.

## Discovery And Reconnect

Manual connection starts from a discovered device handle:

```dart
await for (final device in bota.devices.scan()) {
  // Present the result and connect only after the user selects it.
}

final connected = await bota.devices.connect(selectedDevice);
```

Persist `connected.serialNumber` with any platform reconnect hint. Reconnect is
strictly serial verified; an advertised name is display metadata and is never
identity:

```dart
final connected = await bota.devices.reconnect(
  savedSerial,
  hint: BotaReconnectHint(
    storedPeripheralId: savedApplePeripheralId,
    advertisedAddress: savedAndroidAddress,
  ),
);
```

Use `readStatus()` for a snapshot or `status` for an owned status stream. An
explicit `disconnect()` stops the selected connection.

## Encrypted Batch Handoff

Recording transfer completes into a native file. Keep the device copy until
your backend upload succeeds, consume the transfer metadata, require the
expected encrypted format, and then send the exact confirmation:

```dart
const sinkId = 'application-owned-opaque-id';
String? localPath;

await for (final event in bota.recordings.sync(
  connected,
  recording,
  sinkId: sinkId,
  confirmOnCompletion: false,
)) {
  switch (event) {
    case BotaRecordingSyncProgress(:final progress):
      showProgress(progress.completedBytes, progress.totalBytes);
    case BotaRecordingSyncCompleted(localPath: final path):
      localPath = path;
  }
}

final metadata = await bota.recordings.takeTransferMetadata(sinkId);
if (localPath == null || metadata == null || !metadata.isE2EEncrypted) {
  throw StateError('Encrypted transfer evidence is incomplete');
}
await backend.uploadRecordingFile(localPath!, metadata);
await bota.recordings.confirm(connected, recording.recordingId);
```

The contract-only Encrypted Upload v2 workflow exposed by the native and React
Native facades is not part of this Flutter beta. Flutter applications use the
retained native-file handoff above; they must not infer v2 staging or
receipt-confirmed deletion support from an encrypted recording flag.

Confirmation removes the matching recording from the physical device. Do not
confirm on a failed or uncertain upload. High-volume recording bodies stay in
native files; native live-audio streaming is not supported by this Flutter
release.

## WiFi And Firmware

WiFi configuration requires a fresh application grant for the exact request:

```dart
await bota.wifi.configure(
  connected,
  BotaWifiCredentials(ssid: ssid, password: password),
  grantBlob: await backend.wifiGrant(connected.serialNumber),
);
```

Do not log the password or grant. WiFi status reads, status streams, disconnect,
and device-side scans are also available through `bota.wifi`.

OTA takes bounded metadata and an opaque `sourceId`. The configured firmware
callback resolves that request to a presigned URL and headers in native code;
the firmware body never crosses Dart channels:

```dart
await for (final progress in bota.ota.update(
  connected,
  BotaFirmwareImage(
    sourceId: release.sourceId,
    version: release.version,
    sizeBytes: release.sizeBytes,
    crc32: release.crc32,
  ),
)) {
  showFirmwareProgress(progress.phase, progress.completedBytes);
}
```

## Remove-Only And Factory Reset

Remove-only deprovision and factory reset are intentionally different:

```dart
await bota.provisioning.deprovision(
  connected,
  grantBlob: await backend.deprovisionGrant(connected.serialNumber),
);
```

Deprovision removes the pairing but retains recordings on the physical device.
It must never be presented as factory reset.

Factory reset wipes every recording on the physical device. Obtain the exact
backend command ID and current binding generation, let the configured callback
resolve a nonce-bound grant, and durably persist the device result before the
callback acknowledges it:

```dart
final command = await backend.factoryResetCommand(connected.serialNumber);
final completion = await bota.factoryReset.reset(connected, command);
```

On restart, `resumePending(connected, currentBindingGeneration: generation)`
resumes receipt recovery only. It does not obtain another grant or resend the
reset command, and a newer binding generation must be rejected.

## Errors

SDK failures use `BotaSdkException`. Branch on `code`, `operation`, and
`retryable`; `detail` is diagnostic text and is not a stable API:

```dart
try {
  await bota.devices.readStatus();
} on BotaSdkException catch (error) {
  handleSdkFailure(error.code, error.operation, error.retryable);
}
```

Adapter-only failures, including configuration conflicts, detached engines,
missing engine-local devices, and cross-engine ownership violations, are
projected into the same stable fields. Native bridge codes, messages, and
detail text are not public branching surfaces.

Unknown future enum values are preserved. Treat them as unsupported until the
application has an explicit policy.

## Supported Surface

This beta targets Flutter iOS and Android only. Web, macOS, Windows, and Linux
Flutter targets are unsupported. Native live-audio streaming and Encrypted
Upload v2 staging are unsupported. The supported mobile surface includes
discovery, connection, status, recording control and batch transfer,
provisioning, connection settings, upload ownership, WiFi, OTA, sanitized
device logs, remove-only deprovision, and authenticated factory reset.

Prereleases use exact `1.x.y-beta.n` versions. Applications must opt into each
beta explicitly; no Flutter package from the historical `1.1.0` release should
be inferred or installed.

## Example And Verification

[`example/lib/main.dart`](example/lib/main.dart) is a compact device-management
screen with safe backend stubs. The release consumer gate generates complete,
disposable iOS and Android applications around those maintained example files.

From the repository root:

```bash
tools/flutter/run-flutter.sh test frameworks/flutter/bota_flutter_sdk/test
tools/flutter/test-consumers.sh
npm run flutter:verify
# Available only after replacing occupied beta.0 across every version authority:
tools/flutter/package-release.sh --check
```

The conformance suite discovers all 33 canonical JSON workflow traces, checks
typed Dart routing for the 29 supported traces through a fake native bridge,
and explicitly classifies the four Encrypted Upload v2 traces as unsupported.
Rust remains the only workflow reducer. The package-release command
additionally preserves the exact archive, sorted file inventory, normalized
archive digest, dependency lock and license evidence, dry-run result, consumer
result, and v2 release manifest under `target/flutter-release/`; it performs no
publication.
