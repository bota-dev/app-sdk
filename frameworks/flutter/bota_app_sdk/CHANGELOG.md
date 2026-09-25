# Changelog

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
