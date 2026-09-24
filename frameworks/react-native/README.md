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

This source prepares synchronized `2.0.0-beta.1`; use the exact pin below after
publication. Version `2.0.0-beta.0` remains the previous published release.
Remove `@bota.dev/react-native-sdk` before adding the replacement; do not
co-install both. Production maintenance 0.0.x consumers need not migrate.

```bash
npm install --save-exact @bota.dev/react-native-app-sdk@2.0.0-beta.1
npx pod-install
```

Rebuild the native iOS and Android applications after installation. An Expo Go
runtime cannot load this native module; use a development or production build.

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

## Documentation

See [docs.bota.dev](https://docs.bota.dev) for pairing, provisioning,
recording transfer, WiFi, OTA, and device-management guides.

## License

MIT
