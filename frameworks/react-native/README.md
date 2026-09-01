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

## Documentation

See [docs.bota.dev](https://docs.bota.dev) for pairing, provisioning,
recording transfer, WiFi, OTA, and device-management guides.

## License

MIT
