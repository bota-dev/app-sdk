## 2.0.0-beta.12 (candidate)

- Accept manifest/EOF after an exact validated Android encrypted-v2 resume at the full ciphertext boundary, without requesting another data window.
- Keep signed receipt/CONFIRM and scope, owner, nonce, prefix and revision checks before cleanup.
- Include Android failed connect/MTU handshake cleanup already present on main. Public APIs and firmware rollout gates are unchanged; rebuild native applications.
- Focused host regressions pass; candidate physical recovery and publication remain separate gates.

## 2.0.0-beta.11 (candidate)

- Synchronize with the RN managed encrypted-v2 backend adapter release. Flutter integration and firmware gates remain unchanged.

## 2.0.0-beta.10 (candidate)

- Retire the exact Android session when explicit disconnect times out or is cancelled without a native disconnect callback.
- Close its native client and clear facade/registry/presence state without cancelling queued replacement work or applying duplicate/stale loss events.
- Preserve public APIs and explicit reconnect behavior. The intermittent GATT 8/133 reconnect issue remains unverified; simulated regressions are not physical acceptance.

## 2.0.0-beta.9

- Retire Android connections and close GATT clients on adapter-off even when Android omits its disconnect callback.
- Settle pending operations and cancelled connects; protect replacement sessions from delayed callbacks and cleanup.
- Preserve explicit reconnect behavior and existing public APIs.
- Pre-version RN and Flutter phone candidates passed three radio-off/reconnect cycles each; final published package acceptance remains separate.

## 2.0.0-beta.8

- Forward confirmed Android Bluetooth loss through the native connection stream.
- Clear stale verified connection and presence state; preserve newer transport generations.
- Keep explicit reconnect behavior and existing public APIs.

## 2.0.0-beta.7

- Keep package publication pinned to the preserved library lock without requiring an unpublished example lock.
- Verify the extracted candidate publication path in CI before tagging.
- Runtime behavior is unchanged from beta.6.

# Changelog

## 2.0.0-beta.6

- Synchronized release with React Native presence compatibility and scoped upload recovery helpers.

## 2.0.0-beta.5 (unreleased)

- Pin Apple and Android to synchronized `2.0.0-beta.5`.
- Publish the verified CI candidate through the shared release workflow,
  preserving its dependency lock and evidence across publication retries.
- Runtime APIs and Flutter encrypted-upload-v2 availability are unchanged.

## 2.0.0-beta.4 (unreleased)

- Add passive client-presence metadata with the synchronized SDK identity.
- Pin Apple and Android to synchronized `2.0.0-beta.4`, including cancellation
  protection during Apple connection-identity lookup.
- Flutter encrypted-upload-v2 runtime support remains unavailable.

## 2.0.0-beta.3

- Pin Apple and Android to synchronized `2.0.0-beta.3`, including native
  reconnect, recording-transfer and maintenance-parity fixes.
- Flutter encrypted-upload-v2 runtime support remains unavailable; the native
  and React Native integration does not change Flutter capability claims.

## 2.0.0-beta.2

- Pin Apple and Android dependencies to synchronized `2.0.0-beta.2` alongside
  the Web selected-device discovery addition. Flutter runtime APIs are unchanged.

## 2.0.0-beta.1

- Resolve the Android Flutter SDK from the consumer's standard
  `local.properties` configuration, with `FLUTTER_ROOT` as a fallback.
  Normal applications no longer need the `BOTA_FLUTTER_HOME` workaround.
- Pin Apple and Android dependencies to synchronized `2.0.0-beta.1`.

## 2.0.0-beta.0

- Rename the public package and Dart library to `bota_app_sdk` as part of the
  Bota App SDK family. Replace the old facade dependency and imports; do not
  install both names together.
- Depend on the synchronized `BotaAppSDK` Apple product and
  `dev.bota:bota-app-sdk` Android artifact. Native applications must be rebuilt.
- Preserve runtime APIs, internal Pigeon channels and persistence identities.
  Existing releases and production React Native 0.0.x remain unchanged.
- Publication and physical-device acceptance remain pending.

## 1.2.0-beta.12 (unreleased)

- Replaced the partially published beta.11 tag after the macOS runner selected
  a different Ruby/CocoaPods installation despite installing the pinned gem.
- Installed CocoaPods into an isolated gem directory, and added a public
  beta.11 CocoaPods consumer check to main CI before another tag is cut.
- Selected a new synchronized Flutter-bearing candidate after immutable
  non-Flutter `v1.2.0-beta.0` and unpublished `v1.2.0-beta.1` occupied their
  identities.
- Synchronized Apple, Android, React Native, Flutter, Web, Rust, protocol, and
  release metadata for local candidate verification. This entry does not claim
  publication on pub.dev or any other registry.

## 1.2.0-beta.11 (partially published)

- Published Apple SwiftPM, CocoaPods, Android Maven, React Native npm, and Web
  npm, but the Flutter candidate gate stopped at its exact CocoaPods version
  check before pub.dev publication.

## 1.2.0-beta.10 (partially published)

- Published the native and npm packages, but the Flutter candidate gate failed
  before pub.dev publication because it could not locate CocoaPods 1.16.2.

## 1.2.0-beta.0 (historical unpublished Flutter metadata)

- Projected adapter-only bridge failures into sanitized stable Dart error codes
  while preserving the public operation; added `operationNotOwned` for
  cross-engine ownership rejection.
- Marked this version identity occupied by immutable non-Flutter source. The
  package must receive a new synchronized version before release packaging.
- Added the initial iOS and Android Flutter facade for discovery, connection,
  status, recording control and batch transfer, provisioning, connection
  settings, upload ownership, WiFi, OTA, sanitized logs, remove-only
  deprovision, and authenticated factory reset.
- Added generated Pigeon bindings backed by the public Apple and Android native
  facades. Recording bodies, firmware bodies, raw Bluetooth packets, and
  device-private material remain outside Dart event channels.
- Added all 29 Flutter-supported canonical workflow conformance traces;
  explicitly classified the four Encrypted Upload v2 traces as unsupported;
  and added disposable Android and iOS release consumers.
- Added a device-management example whose backend callbacks fail closed until
  the application supplies request-bound material.
- Added deterministic package/archive inventory, dependency-license evidence,
  publication verification, and clean Android/iOS release-consumer gates.

The synchronized `1.1.0` release did not publish a Flutter package. Preparing
this changelog entry does not claim that `1.2.0-beta.0` exists on pub.dev.
