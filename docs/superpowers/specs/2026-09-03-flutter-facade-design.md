# Bota Flutter SDK Facade Design

**Status:** Approved direction; detailed design awaiting review

## Goal

Add the first Flutter facade to the Bota App SDK monorepo as the public
`bota_flutter_sdk` plugin. The initial package supports Flutter applications on
iOS and Android by delegating to the already-published `BotaAppleSDK` and
`dev.bota:bota-android-sdk` facades. It does not introduce another Bluetooth
stack, another workflow engine, or a backend API client.

The first Flutter-bearing synchronized release is `1.2.0-beta.0`. Apple,
Android, React Native, and Flutter continue to use the same version from
`sdk-version.toml`.

## Scope

The first Flutter beta supports:

- SDK configure and destroy;
- discovery, manual selection, serial-strict reconnect, disconnect, connection
  observation, status reads, and status observation;
- nonce-bound provisioning, remove-only deprovision, authenticated factory
  reset, and exact-generation reset receipt recovery;
- connection-settings reads and normalized writes, including independent
  heartbeat-channel selection;
- remote recording start, stop, state reads, and state observation;
- recording list, retained batch transfer, native-file completion, explicit
  confirm-after-upload, and device-upload ownership observation;
- native firmware download, BLE OTA progress, reboot, and reconnect recovery;
- sanitized device-log streaming; and
- WiFi configure, disconnect, status, status observation, and device-side scan.

Live audio streaming is not part of this release. Web, macOS, Windows, and Linux
Flutter targets are also unsupported until their own capability and lifecycle
plans pass. Unsupported operations fail before native device state changes and
are absent from the advertised Flutter capability set.

## Approaches Considered

### Chosen: one native Flutter plugin with generated typed channels

One package contains the public Dart API, checked-in Pigeon schema and generated
Dart/Swift/Kotlin channel code, plus thin Apple and Android adapters. The
adapters translate values and delegate ownership to the existing native
facades. This preserves the tested Bluetooth and workflow implementations and
keeps the bridge low volume.

### Rejected: Dart FFI directly into the Rust core

Direct FFI would still require separate Dart-owned Bluetooth, persistence,
network, permission, and lifecycle hosts. That would create a third mobile
implementation and bypass the native-facade conformance already accepted for
Apple and Android.

### Deferred: package-separated federated plugin

A federated structure is useful once Web or Windows ships, but it adds package
and version coordination before a second implementation exists. Pigeon also
warns that generated Dart and host code in separately updated packages can
become incompatible. The first release therefore keeps all generated channel
code in one versioned package. A later design may extract a stable platform
interface before adding desktop implementations.

## Repository And Toolchains

The plugin lives at:

```text
frameworks/flutter/bota_flutter_sdk/
```

The package uses:

- package name `bota_flutter_sdk`;
- reverse-domain native namespace `dev.bota.sdk.flutter`;
- Dart SDK `>=3.11.0 <4.0.0`;
- Flutter SDK `>=3.41.0` for consumers;
- Flutter `3.47.2` with Dart `3.13.2` in CI;
- Pigeon `28.0.0`, pinned exactly as a development dependency;
- the Swift 6 toolchain, with the Pigeon-generated Flutter bridge compiled in
  Swift 5 language mode until the pinned generator is sendability-clean;
- iOS 15 as the Apple deployment floor; and
- Android API 26 as the Android minimum SDK.

Pigeon output is committed. CI regenerates it with the pinned tool and rejects
any diff. Generated Dart and native files are never edited by hand.

## Public Dart API

The public entry point is `BotaDeviceClient`. It exposes manager properties
matching the native ownership boundaries:

```text
devices       discovery, connection, reconnect, status
controls      recording control and recording state
provisioning  bind material, settings, remove-only deprovision
factoryReset  authenticated reset and receipt recovery
recordings    list, retained transfer, confirm, upload ownership
ota           native download and firmware update
logs          sanitized line stream
wifi          credentials, disconnect, status, scan
```

Async one-shot operations return `Future<T>`. Observations and progress return
single-subscription `Stream<T>` values whose cancellation stops the matching
native owner exactly once. Public models are immutable Dart values. Known wire
enums retain an `unknown(rawValue)` representation rather than discarding
future firmware values.

Failures use `BotaSdkException` with stable `code`, `operation`, `retryable`,
optional `protocolStatus`, and diagnostic `detail` fields. Dart applications
branch on those fields, not platform exception text.

`BotaDeviceClient.configure` accepts asynchronous application callbacks for
provisioning material, command-bound reset grants, durable reset-result
persistence, and application-authorized firmware sources. Batch-upload
destinations remain application-owned after the SDK returns a completed native
file path. The plugin never calls Bota backend APIs itself.

## Bridge Contract

Pigeon defines a host API for one-shot commands and a Flutter API for native
requests, events, and progress. Every operation and subscription carries an
opaque 128-bit identifier represented as a validated lowercase hexadecimal
string. Host adapters reject duplicate, missing, stale, or wrong-kind
identifiers before delegating to a native facade.

Only bounded values cross the channel:

- identifiers, serial numbers, enums, booleans, timestamps, counters, and
  status fields;
- provisioning/reset material encoded by the application and decoded into
  bytes only by the native facade;
- firmware-download request metadata registered natively under an opaque ID;
- native file paths after a completed retained recording transfer; and
- complete sanitized device-log lines.

Recording bodies, live audio chunks, firmware bodies, raw log packets, device
private material, and native Bluetooth objects never cross the Dart bridge.

## Native Integration

### Apple

The Swift plugin imports `BotaAppleSDK`, translates Pigeon values explicitly,
and delegates every operation to `BotaDeviceClient`. Local CI resolves the
nested source package. Published Flutter Swift Package Manager consumers resolve
the exact synchronized Git tag and `BotaAppleSDK` product; CocoaPods consumers
resolve the exact synchronized `BotaAppleSDK` pod. The plugin supports both
Flutter integrations with one shared Swift adapter implementation and fails
closed when the matching native dependency cannot be resolved.

### Android

The Kotlin plugin depends on
`dev.bota:bota-android-sdk:<synchronized-version>` from Maven Central. It uses
`BotaDeviceClient.shared`, maps Pigeon values explicitly, and launches facade
calls in a plugin-owned coroutine scope. Detaching the Flutter engine cancels
bridge collectors but does not bypass native durable recovery.

### Multiple Flutter engines

Each engine receives its own plugin instance, request registry, stream
registry, and callback channel. A process-wide native lease coordinator
reference-counts access to the shared Apple/Android client. Equivalent
configuration coalesces; incompatible concurrent configuration fails with
`configuration_conflict`. The final lease release destroys the shared client.
An engine detach rejects its pending Dart requests and removes only its own
subscriptions. Process-wide operation ownership remains assigned through
native cancellation and the original operation's terminal unwind. A failed
cancellation poisons that category until terminal unwind or final shared-client
destruction proves cleanup, preventing another engine from acquiring or
cancelling shared native work. Direct CoreBluetooth reads and writes are task
cancellation-aware: cancellation removes and resumes their pending continuation
exactly once. The characteristic key remains quarantined until its stale delegate
callback is discarded or disconnect proves it cannot arrive, so ambiguous reuse
fails closed. A terminal Flutter stream collector is not native-terminal proof
when its corresponding stop throws.

## Data And Security Ownership

The Rust workflow core remains the only deterministic workflow authority. The
Apple and Android facades continue to own Bluetooth serialization, radio
permissions, persistence, secure storage, HTTP transfers, recording sinks,
firmware blobs, and cancellation.

The Flutter layer performs no encryption or decryption. For encrypted batch
recordings it returns the native transfer metadata and completed native file
path; the application obtains and registers the backend-authorized destination.
Deletion from the device occurs only after the application reports durable
upload completion and explicitly confirms the recording.

Application callbacks may return credentials or grants, but those values are
one-shot, request-bound, never logged, never placed in Dart stream events, and
never persisted by the plugin.

## Release And pub.dev Bootstrap

The release candidate includes a canonical source inventory for
`frameworks/flutter/bota_flutter_sdk`, `flutter pub publish --dry-run` output,
Pigeon generator identity, dependency lock, license result, and example-build
evidence. The v2 release manifest gains a `flutter` artifact with package
identifier `bota_flutter_sdk` only after these gates pass.

pub.dev requires a package's first version to be published interactively. The
one-time `1.2.0-beta.0` bootstrap therefore uses this fail-closed sequence:

1. CI builds and preserves the exact Flutter candidate from the annotated tag.
2. The protected release environment pauses before public publication.
3. An authorized maintainer publishes that candidate interactively from a
   clean tag checkout.
4. CI downloads the public pub.dev archive, compares its normalized files and
   content hashes with the preserved candidate inventory, and records the
   archive SHA-256.
5. The publisher enables pub.dev GitHub Actions publishing for repository
   `bota-dev/app-sdk` and tag pattern `v{{version}}`.
6. The release continues only after the verified Flutter version exists.

Future Flutter betas publish from the protected tag workflow using pub.dev OIDC
with no long-lived token. Existing-version recovery downloads and verifies the
public archive; it never republishes an occupied version.

## Verification

The implementation is accepted only when all of the following pass:

- Dart model, error, lifecycle, cancellation, and callback-broker unit tests;
- Pigeon schema generation and checked-in-output drift tests;
- Swift and Kotlin adapter mapping and multi-engine lease tests;
- all canonical protocol fixtures and 29 workflow traces through fake native
  facades without reimplementing the Rust reducers in Dart;
- iOS and Android Flutter example applications built in release mode;
- API 26 and API 35 Android consumers using the exact candidate AAR;
- generic iOS device and simulator builds using the exact Apple candidate;
- `flutter analyze`, `dart format --output=none --set-exit-if-changed`, and
  `flutter test`;
- dependency-license and package-content gates;
- `flutter pub publish --dry-run`; and
- supervised physical-device acceptance for pairing, reconnect after reboot and
  OTA, active-device identity, provisioning, settings, encrypted batch upload,
  WiFi, BLE fallback, firmware progress, logs, remove-only, and reset.

The existing Apple, Android, React Native, Rust, release-manifest, and license
gates remain mandatory. Flutter cannot weaken or replace them.

## Documentation

The package includes `README.md`, `CHANGELOG.md`, `LICENSE`, API documentation,
an example application, and a package skill for coding assistants. Public Bota
docs add installation, capability, permission, error, batch-upload, OTA, and
reset guidance before publication. Internal architecture and traceability docs
record only evidence-backed support.

## Exit Criteria

Milestone 5's Flutter slice exits when:

- the package API and generated bridge are frozen for the beta;
- iOS and Android delegate all declared capabilities to the native facades;
- unsupported targets and live streaming are explicit;
- local, CI, release-mode example, and supervised hardware gates pass;
- `1.2.0-beta.0` is published and checksum-verified on pub.dev together with the
  matching Apple, Android, and React Native beta artifacts; and
- no production application is silently moved from the legacy npm `latest`
  line.

## References

- Flutter plugin development: https://docs.flutter.dev/packages-and-plugins/developing-packages
- Flutter platform channels: https://docs.flutter.dev/platform-integration/platform-channels
- Pigeon: https://pub.dev/packages/pigeon
- pub.dev automated publishing: https://dart.dev/tools/pub/automated-publishing
