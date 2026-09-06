# Bota SDK for React Native

Bluetooth device SDK for Bota Pin and Bota Note applications. Version `1.1.0`
preserves the public TypeScript API of `@bota.dev/react-native-sdk@0.0.65`
while moving Bluetooth workflows and recording, streaming, and firmware bytes
into the native Apple and Android SDKs.

## Requirements

- React Native `0.86.3` or newer with the New Architecture enabled
- iOS `15.1` or newer
- Android API `26` or newer
- Node.js `22` or newer for installation and application builds

## Install

```bash
npm install @bota.dev/react-native-sdk@1.1.0
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
import { BotaClient } from '@bota.dev/react-native-sdk';

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
import { BotaDeviceSDK } from '@bota.dev/react-native-sdk';

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

## Documentation

See [docs.bota.dev](https://docs.bota.dev) for pairing, provisioning,
recording transfer, WiFi, OTA, and device-management guides.

## License

MIT
