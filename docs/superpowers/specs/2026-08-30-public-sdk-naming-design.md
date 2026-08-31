# Bota SDK Public Naming Design

**Status:** Approved

## Decision

Libraries embedded in customer applications to communicate with Bota hardware
belong to the **Bota App SDK** family. Public documentation describes each
distribution as **Bota SDK for _platform_**, while package identifiers follow
the conventions of their ecosystem.

The future backend client family is separate and is named **Bota API SDK**.
Public App SDK packages must not use **Bota Device SDK** as their family name,
because that term commonly implies software that runs on embedded hardware.

## Naming Layers

Every distribution has three distinct names:

1. **Family name:** `Bota App SDK`.
2. **Documentation name:** `Bota SDK for <platform>`.
3. **Package identifier:** the ecosystem-native identifier in the table below.

These names are intentionally related without being mechanically identical.
Forcing one spelling across SwiftPM, Maven, npm, pub.dev, and NuGet would make
the packages less idiomatic for their developers.

## Platform Matrix

| Platform | Documentation name | Package or module identifier |
|---|---|---|
| Apple | Bota SDK for Apple platforms | `BotaAppleSDK` |
| Android | Bota SDK for Android | `dev.bota:bota-android-sdk` |
| React Native | Bota SDK for React Native | `@bota.dev/react-native-sdk` |
| Flutter | Bota SDK for Flutter | `bota_flutter_sdk` |
| Web | Bota SDK for Web | `@bota.dev/web-sdk` |
| Windows | Bota SDK for Windows | `Bota.WindowsSdk` |
| Electron | Bota SDK for Electron | `@bota.dev/electron-sdk`, only when a dedicated native desktop bridge exists |

Electron does not receive a placeholder package. Applications use the Web SDK
where Web Bluetooth satisfies the capability matrix; a separate Electron SDK
is published only when native desktop BLE requires a distinct supported
transport.

## Public API Vocabulary

New native facades should use ecosystem-idiomatic forms of the same concepts:

- `BotaDeviceClient`
- `BotaConfiguration`
- `BotaSDKError`
- `DeviceManager`
- `RecordingManager`
- `OTAManager`

The existing React Native `BotaClient` remains its compatibility entry point.
Exact casing and asynchronous types may otherwise vary by language. Concept
names and behavior remain aligned through the shared capability matrix and
conformance fixtures.

## Internal Names

Internal artifacts may retain `device` because they implement the shared
physical-device protocol and are not customer-facing product names. Current
examples include:

- `bota-device-sdk-core`
- `bota-device-sdk-ffi`
- `BotaDeviceSDKC`

The source repository remains `app-sdk`.

## Reserved API SDK Family

Backend clients use **Bota API SDK**, not Bota App SDK. Their package names are
chosen separately for Node.js, Python, Java, .NET, and other API ecosystems.
An App SDK release must not expose backend-resource clients under its package
identifier, and an API SDK must not imply local Bluetooth or device transport.

## Enforcement

Release manifests identify the family, platform, public package identifier,
version, and capability set. Platform package smoke tests import only the
public identifier from the matrix. Repository documentation and release titles
use the family and documentation names defined here; internal Rust and C names
are excluded from public installation instructions.
