# Bota App SDK

Connect your application to **Bota Pin** and **Bota Note** devices. The Bota App
SDK provides Bluetooth discovery and connection, device status, recording
transfer, provisioning, WiFi configuration, recording control, and firmware
updates through a shared Rust core and platform-native adapters.

**Current beta: `2.0.0-beta.12`.** Pin exact versions when installing. See the
[Changelog](CHANGELOG.md) for changes and [GitHub Releases](https://github.com/bota-dev/app-sdk/releases)
for published artifacts. The SDK is in beta; supported workflows depend on the
platform and device firmware.

## Platforms

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

The examples below use the published `2.0.0-beta.12` release. npm's `beta` tag
tracks newer prereleases; `latest` remains at the initial `2.0.0-beta.0`.
An unversioned npm install therefore does not select the current beta.

### React Native

Use Node.js 22+ to install and build your app:

```bash
npm install --save-exact @bota.dev/react-native-app-sdk@2.0.0-beta.12
npx pod-install
```

Rebuild the native iOS and Android applications. Expo projects require a
development or production build; Expo Go cannot load this native module.
Follow the [React Native setup guide](frameworks/react-native/README.md#install)
for permissions and Expo configuration.

```ts
import { BotaClient } from '@bota.dev/react-native-app-sdk';

await BotaClient.configure({ environment: 'production' });
await BotaClient.waitForBluetooth();
```

After configuration, use `BotaClient.devices`, `BotaClient.recordings`, and
`BotaClient.ota` for device workflows.

### Apple

In Xcode, add `https://github.com/bota-dev/app-sdk.git` at exact version
`2.0.0-beta.12` and select the **BotaAppSDK** product. With Swift Package Manager:

```swift
.package(url: "https://github.com/bota-dev/app-sdk.git", exact: "2.0.0-beta.12")
```

```swift
import BotaAppSDK

let bota = BotaDeviceClient.shared
try await bota.configure()
```

Add `NSBluetoothAlwaysUsageDescription` to your application. Sandboxed macOS
apps also need the **App Sandbox > Hardware > Bluetooth** entitlement.

### Android

Add the dependency with `mavenCentral()` configured in your repositories:

```kotlin
implementation("dev.bota:bota-app-sdk:2.0.0-beta.12")
```

Your app requests Bluetooth runtime permissions. See the
[Android guide](platforms/android/README.md) for client lifecycle and permission
requirements.

### Flutter

```yaml
dependencies:
  bota_app_sdk: 2.0.0-beta.12
```

Follow the [Flutter guide](frameworks/flutter/bota_app_sdk/README.md) for native
setup and backend callbacks, then rebuild the iOS or Android app.

### Web

```bash
npm install --save-exact @bota.dev/web-app-sdk@2.0.0-beta.12
```

Start the Bluetooth picker from a user gesture. Web integration requires
compatible firmware with the Bota Identity service; background and closed-tab
work are unsupported. See the [Web guide](frameworks/web/README.md) for client
creation, exact-serial connection and tenant-scoped storage.

## Integrating your backend

Your application owns user authentication and scoped backend authorization.
Provide fresh credentials and operation-specific callbacks; the SDK owns device
transport, transfer state and local recovery. Recording and firmware bytes stay
in native files on mobile, outside the JavaScript and Dart bridges.

For React Native encrypted uploads, start with the
[managed backend adapter](docs/parity/v2-managed-backend.md). It communicates
with your authenticated proxy and handles native session recovery and signed
receipts. Cloud upload commitment and device cleanup are separate phases;
follow the integration contract before deleting a device recording.

## Client presence

`clientPresence.nextReport(deviceId)` returns passive metadata for the current
verified SDK connection, or null. The host can relay it with fresh status and
the matching authenticated scope. See the [client-presence guide](docs/client-presence.md)
for field mapping and lifecycle rules; the getter does not send heartbeats.

## Documentation

- [Examples](https://github.com/bota-dev/examples): applications using the public packages.
- [Package migration](docs/migrations/app-sdk-package-names.md): replace historical package names and imports.
- [Standalone React Native retirement](docs/migrations/react-native-sdk-sunset.md): migrate from the deprecated `@bota.dev/react-native-sdk`; do not co-install both packages.
- [Architecture](ARCHITECTURE.md): shared core, platform boundaries and workflow ownership.
- [Changelog](CHANGELOG.md): release changes and links to verification evidence.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, required checks,
and documentation conventions. Maintainers use the [release procedure](docs/releasing.md).
Report vulnerabilities through [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
