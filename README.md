# Bota App SDK

Published React Native beta.17 provides Rust-generated JavaScript through
`@bota.dev/react-native-app-sdk/runtime`, using installed Bluetooth, file and HTTP
ports. Compatible shared-logic upgrades can travel in an app's OTA bundle.
All five SDK packages, exact main CI/License, public JS/declaration/native
consumers and complete Flutter archive verification pass. App OTA delivery,
installed-host qualification and physical acceptance remain separate. See
[setup and runtime limits](frameworks/react-native/README.md) and
[publication review](release/evidence/2.0.0-beta.17-publication.md).

BYO live-upload source now connects encrypted capture, HTTP/WS and fenced Batch recovery. See [current implementation and validation](docs/parity/byo-storage.md); rollout and physical qualification remain separate.

[![CI](https://github.com/bota-dev/app-sdk/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/bota-dev/app-sdk/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

The official SDK for connecting your application to **Bota Pin** and **Bota
Note** recording devices. Build device discovery, recording sync, and firmware
update flows in React Native, Swift, Kotlin, Flutter, or a web application.

[Getting started](#installation) · [Quick start](#quick-start) ·
[Documentation](#documentation) · [Examples](https://github.com/bota-dev/examples) ·
[Changelog](CHANGELOG.md)

## Features

- **Device connectivity:** discover nearby devices, connect, reconnect by serial
  number, and observe battery, storage, and recording status.
- **Recordings:** control recording, list device recordings, and transfer and
  upload them with progress reporting and recovery support.
- **Device setup:** integrate provisioning, connection settings, and device-side
  WiFi configuration with your backend's authorization flow.
- **Firmware updates:** download and transfer firmware through the SDK's OTA
  workflows.
- **Mobile integration:** Apple, Android and Flutter use shared Rust workflows
  through native adapters. React Native's generated `/runtime` executes Rust
  behavior in JavaScript over installed OS ports.

Capabilities vary by platform and device firmware. Use the platform guides below
to check the workflows available to your application.

## Supported platforms

| Platform | Package | Requirements | Guide |
| --- | --- | --- | --- |
| React Native | `@bota.dev/react-native-app-sdk` | RN 0.86.3+ with New Architecture, React 19.2.3+, iOS 15.1+ / Android API 26+ | [React Native](frameworks/react-native/README.md) |
| Apple | `BotaAppSDK` | iOS 15+ / macOS 13+ | [Installation](#apple) |
| Android | `dev.bota:bota-app-sdk` | Android API 26+ | [Android](platforms/android/README.md) |
| Flutter | `bota_app_sdk` | iOS 15+ / Android API 26+ | [Flutter](frameworks/flutter/bota_app_sdk/README.md) |
| Web | `@bota.dev/web-app-sdk` | Desktop Chromium with Web Bluetooth, HTTPS, foreground use | [Web](frameworks/web/README.md) |

Windows and a dedicated Electron SDK are planned. Flutter Web and desktop are
not supported. Consult each platform guide for its capability limits.

## Installation

**Published SDK version: `2.0.0-beta.17` (beta).** All five packages and public
consumer/archive checks pass; see the
[publication review](release/evidence/2.0.0-beta.17-publication.md).
[GitHub Releases](https://github.com/bota-dev/app-sdk/releases) provides the
publication status and verified artifacts; [CHANGELOG.md](CHANGELOG.md) records
version changes.

Choose the package for your application. npm's `beta` tag tracks prereleases;
`latest` remains at `2.0.0-beta.0`, so use an explicit version when installing.

### React Native

Published beta.17 provides the generated-JS factory through
`@bota.dev/react-native-app-sdk/runtime`. This entry evaluates without React Native
module imports, native registry access or WebAssembly. Install compatible OS ports
in the app binary once; compatible generated logic can then update through app
OTA. New OS capabilities and installed transport fixes still require an app build.
See the
[runtime boundary and review](docs/parity/react-native-runtime.md).

The complete package retains native compatibility adapters and autolinking.
Selecting `/runtime` does not disable package autolinking. The companion directory
is a private verification fixture; applications install only the original package.

Use Node.js 22+ to install and build your app:

```bash
npm install --save-exact @bota.dev/react-native-app-sdk@2.0.0-beta.17
npx pod-install
```

Rebuild the native iOS and Android applications. Expo projects require a
development or production build; Expo Go cannot load this native module.
Follow the [React Native setup guide](frameworks/react-native/README.md#install)
for permissions and Expo configuration.

### Apple

In Xcode, add `https://github.com/bota-dev/app-sdk.git` at exact version
`2.0.0-beta.17` and select the **BotaAppSDK** product. With Swift Package Manager:

```swift
.package(url: "https://github.com/bota-dev/app-sdk.git", exact: "2.0.0-beta.17")
```

Add `NSBluetoothAlwaysUsageDescription` to your application. Sandboxed macOS
apps also need the **App Sandbox > Hardware > Bluetooth** entitlement.

```swift
import BotaAppSDK

let bota = BotaDeviceClient.shared
try await bota.configure()
```

### Android

Add the dependency with `mavenCentral()` configured in your repositories:

```kotlin
implementation("dev.bota:bota-app-sdk:2.0.0-beta.17")
```

Your app requests Bluetooth runtime permissions. See the
[Android guide](platforms/android/README.md) for client lifecycle and permission
requirements.

### Flutter

```yaml
dependencies:
  bota_app_sdk: 2.0.0-beta.17
```

Follow the [Flutter guide](frameworks/flutter/bota_app_sdk/README.md) for native
setup and backend callbacks, then rebuild the iOS or Android app.

### Web

```bash
npm install --save-exact @bota.dev/web-app-sdk@2.0.0-beta.17
```

Start the Bluetooth picker from a user gesture. Web integration requires
compatible firmware with the Bota Identity service; background and closed-tab
work are unsupported. See the [Web guide](frameworks/web/README.md) for client
creation, exact-serial connection and tenant-scoped storage.

## Quick start

This React Native example discovers devices and reads the status of a device
selected by the user. Complete the platform's Bluetooth permission setup before
running it.

```ts
import {
  BotaClient,
  type DiscoveredDevice,
} from '@bota.dev/react-native-app-sdk';

await BotaClient.configure({ environment: 'production' });
await BotaClient.waitForBluetooth();

// Present these discoveries in your application's device picker.
BotaClient.devices.on('deviceDiscovered', (device) => {
  console.log(device.id, device.name);
});
await BotaClient.devices.startScan({ timeout: 30_000 });

// Call this with the device selected in your picker.
async function inspectDevice(selectedDevice: DiscoveredDevice) {
  BotaClient.devices.stopScan();
  const device = await BotaClient.devices.connect(selectedDevice);
  const status = await BotaClient.devices.getStatus(device);
  return { device, status };
}
```

Use `BotaClient.devices` for connectivity and device controls,
`BotaClient.recordings` for recording sync, and `BotaClient.ota` for updates.
Call `await BotaClient.destroy()` when ending the SDK session, such as on logout.
See the [React Native guide](frameworks/react-native/README.md) for the native
upload API and lifecycle details, or choose another platform above.

## Integrating your backend

Your backend authenticates users and authorizes device operations. The App SDK
handles device communication, file transfer, and local recovery. A typical
recording integration has three steps:

1. Your application asks its authenticated backend for a recording upload session.
2. The SDK transfers the recording and uploads it using the supplied destination.
3. The backend acknowledges cloud commitment before the SDK confirms device cleanup.

Provide fresh credentials and scoped callbacks for each operation. Cloud upload
commitment and device cleanup are separate phases; an upload result alone does
not authorize deletion of the device recording.

For React Native encrypted uploads, start with the
[managed backend adapter](docs/parity/v2-managed-backend.md). It communicates
with your authenticated proxy and handles native session recovery and signed
receipts. See [Bota API documentation](https://docs.bota.dev) for the backend API.

Beta.15 bounds Apple encrypted-v2 DATA and signed-blob
frames by the current single ATT-value capacity. CoreBluetooth's long-write
capacity is not a notification limit. It also preserves numeric device
rejections through native upload errors. See [verification and delivery
limits](docs/parity/v2-demo-apple.md#october-9-single-att-frame-capacity-unpublished-source).

## Client presence

Beta.15 distinguishes iOS system connections
from this application's local connection. It acquires a retrieved peripheral
through the current central before SDK use and clears local ownership on
disconnect or Bluetooth loss. See [verification and delivery limits](docs/parity/apple-connection-ownership.md).

`clientPresence.nextReport(deviceId)` returns passive metadata for the current
verified SDK connection, or null. The host can relay it with fresh status and
the matching authenticated scope. See the [client-presence guide](docs/client-presence.md)
for field mapping and lifecycle rules; the getter does not send heartbeats.

## Documentation

| I want to… | Start here |
| --- | --- |
| Integrate React Native | [React Native guide](frameworks/react-native/README.md) |
| Integrate Swift / Apple | [Apple installation and configuration](#apple) |
| Integrate Kotlin / Android | [Android guide](platforms/android/README.md) |
| Integrate Flutter | [Flutter guide](frameworks/flutter/bota_app_sdk/README.md) |
| Integrate Web Bluetooth | [Web guide](frameworks/web/README.md) |
| Add encrypted recording uploads | [Managed backend adapter](docs/parity/v2-managed-backend.md) |
| Explore example applications | [Bota examples](https://github.com/bota-dev/examples) |
| Migrate an existing integration | [Package migration](docs/migrations/app-sdk-package-names.md) and [standalone SDK retirement](docs/migrations/react-native-sdk-sunset.md) |
| Integrate device firmware | [Firmware protocol](FIRMWARE_PROTOCOL.md) — recording control, marked BATCH and protected STREAMING boundaries |
| Understand the SDK's design | [Architecture](ARCHITECTURE.md) |
| See what changed between versions | [Changelog](CHANGELOG.md) |

When migrating from `@bota.dev/react-native-sdk`, replace the old dependency and
imports, then rebuild the native app. Install only the replacement package.

## Support

For SDK bugs and feature requests, [open an issue](https://github.com/bota-dev/app-sdk/issues).
Include your SDK version, platform, device firmware, and a minimal reproduction.
Report security vulnerabilities through [SECURITY.md](SECURITY.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, required checks,
and documentation conventions. Maintainers use the [release procedure](docs/releasing.md).

## License

[MIT](LICENSE)

See [BYO native/RN source preview](docs/parity/byo-storage.md) for integration, recovery and unreleased capability limits.
