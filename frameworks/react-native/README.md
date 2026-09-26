# Bota SDK for React Native

Bluetooth device SDK for Bota Pin and Bota Note applications. The 2.x candidate
preserves the public TypeScript API of `@bota.dev/react-native-sdk@0.0.65`
while moving Bluetooth workflows and recording, streaming, and firmware bytes
into the native Apple and Android SDKs.

## Requirements

- React Native `0.86.3` or newer with the New Architecture enabled
- iOS `15.1` or newer
- Android API `26` or newer
- Node.js `22` or newer for installation and application builds

## Install

This source prepares synchronized `2.0.0-beta.2`; use the exact pin below after
publication. Version `2.0.0-beta.1` remains the previous published release.
Remove `@bota.dev/react-native-sdk` before adding the replacement; do not
co-install both. Production maintenance 0.0.x consumers need not migrate.

```bash
npm install --save-exact @bota.dev/react-native-app-sdk@2.0.0-beta.2
npx pod-install
```

Rebuild the native iOS and Android applications after installation. An Expo Go
runtime cannot load this native module; use a development or production build.

An application-native upload pod may depend on `BotaDeviceSDK`. With static
SwiftPM linkage, the SDK's CocoaPods workaround normalizes the module-map path
in both aggregate and dependent-pod cached build settings. This preserves the
path when Expo later writes macro flags. Do not work around missing module maps
by adding another copy of the Apple SDK.

Expo prebuild and EAS projects must set the Android minimum SDK explicitly. Add
the Expo-compatible `expo-build-properties` package and configure it in the app
config:

```ts
plugins: [
  [
    'expo-build-properties',
    {
      android: {
        minSdkVersion: 26,
      },
    },
  ],
],
```

## Configure

```ts
import { BotaClient } from '@bota.dev/react-native-app-sdk';

await BotaClient.configure({
  environment: 'production',
});

await BotaClient.waitForBluetooth();
```

The `BotaClient.devices`, `BotaClient.recordings`, and `BotaClient.ota`
managers become available after configuration completes.

Discovery exposes the manufacturer-advertised `macAddress` as uppercase,
colon-separated bytes (`AA:BB:CC:DD:EE:FF`), preserving the legacy React Native
registration contract. Compact native addresses are formatted at the RN
boundary; missing or malformed advertised values become `null`. The peripheral
`id` is unchanged and is never substituted for an absent advertised MAC.

## Encrypted upload v2

The target encrypted-upload-v2 runtime is an additive `BotaDeviceSDK` API; it
does not change the legacy `BotaClient` recording providers or events:

```ts
import { BotaDeviceSDK } from '@bota.dev/react-native-app-sdk';

await BotaDeviceSDK.recordings.syncEncryptedRecordingV2(
  device,
  recording,
  async (request) => selectNativeEncryptedUploadV2(request),
  (progress) => updateUploadProgress(progress),
);
```

The provider receives a fresh native capability snapshot, immutable recording
identity, and optional versioned checkpoint. It returns only the upload
session, owner revision, security policy, and an opaque native material
registration ID. Before returning that ID, application-native Swift or Kotlin
code must register the complete material once with
`BotaDeviceSDKEncryptedUploadV2Materials.register(...)`. Authorization,
manifest, receipt, staging URL/header/credentials, native file bytes/paths,
keys, nonces, tags, ciphertext, and plaintext must remain in that native
adapter and never cross JavaScript or Codegen. Selection is explicit and never
downgrades to a legacy profile.

Runtime compatibility metadata remains disabled until the separate firmware,
release, and hardware gates pass; this API does not advertise device support.
Its target-facade tests and the maintenance SDK `0.0.67` runtime tests are
cross-referenced by the same canonical v2 workflow evidence in CI and tagged
release verification. The frozen public compatibility surface remains `0.0.65`.

### Unpublished Native App Integration

Current source adds `BotaDeviceSDK.recordings.listPendingRecordings(device)`.
It returns legacy recordings and v2 entries tagged by `storageFormat: 3`, with
the full UUID/generation, ciphertext length/hash and catalog metadata. Catalog
errors do not silently downgrade to legacy listing. These changes require
matching native source and a newly built application; beta.1 is insufficient.

The v2 sync method accepts a fifth argument `{ signal, operationId }`. The
optional operation ID is a fresh UUID shared with an application-native
adapter; cancellation stops and awaits that exact operation. Native provider
contexts expose an operation-scoped `readAuthNonce` callback. An RN application's
Swift/Kotlin adapter can call
`BotaDeviceSDKEncryptedUploadV2Materials.readAuthNonce(operationId)` while the
profile request is pending; it must not make a competing public BLE read.

Native material must supply `uploadContext`, which relays opaque challenge/proof
documents through the application backend. The SDK owns the bounded device
handshake before authorization and the first completion receipt. Ordinary v2
requires capability mask `0x17f`; expired-session replacement requires `0x37f`.
Neither the app nor SDK verifies backend signatures or trusts the phone clock
as a substitute for device verification. Cancellation discards late native
material via `cancelPreparation`; it does not delete recoverable recordings.
Historical checkpoints without ciphertext identity may resume the same owner
but cannot authorize replacement. See `docs/parity/v2-demo-*.md` for evidence
and limitations. Hardware and publication gates remain unchanged.

## Unpublished Maintenance Additions

Current source follows the diagnostic and upload-recovery additions from
maintenance SDK commit `318974f925a573cf04b0d624978bee04784af09b`. These additions
are not part of the published `2.0.0-beta.1` package.

- `BotaClient.devices.readDiagnosticEvents(device)` returns a bounded batch.
  Reading does not delete it. After the application durably accepts events,
  call `acknowledgeDiagnosticEvents(device, acceptedEventIds)` with their exact
  16-character lowercase hexadecimal IDs. The native `BotaDeviceSDK.logs` API
  exposes the same methods. Firmware must support the diagnostics service.
- Configure `uploadRecoveryProvider` to refresh upload credentials for the
  original recording and account/project scope after restart. Only non-secret
  queue metadata persists; recording bytes stay in native files. Completion
  acknowledgement is required before releasing recoverable files.
- Legacy `RecordingDataStore` JavaScript byte callbacks are not supported.
  Supplying one fails configuration explicitly. Use the native file store and
  credential/completion callbacks instead; this is a migration adaptation,
  not byte-store API equivalence.

See the repository's `docs/parity/` notes for recovery contracts and test
coverage. This does not enable encrypted-v2 device support or complete the
separate physical-device and application rollout gates.

## Documentation

See [docs.bota.dev](https://docs.bota.dev) for pairing, provisioning,
recording transfer, WiFi, OTA, and device-management guides.

## License

MIT
