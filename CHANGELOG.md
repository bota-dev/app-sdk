# Changelog

User-facing changes to the Bota App SDK. Entries under **Unreleased** describe
source changes that are not in the published packages. Published versions and
tags are immutable; package publication and application/device acceptance are
tracked separately.

## Unreleased

- Correct recording-control decoding so an activity snapshot's UUID bytes are
  not treated as a command result. Android waits for the requested activity or
  an explicit result. See the [recording-control review](docs/parity/recording-control-notifications.md).
- Require dedicated, generation-bound factory-reset authorization instead of
  accepting remove-only deprovision grants. Receipt recovery does not issue a
  new reset. This needs matching SDK, app, backend and firmware releases; see
  the [reset contract](docs/parity/factory-reset-authorization.md).

## 2.0.0-beta.12

- Repair Android encrypted-upload resume at a complete ciphertext checkpoint so
  the validated resume can proceed to manifest and EOF handling.
- Reset Android and Apple packet counters for each accepted resumed attempt,
  while retaining durable checkpoint identity and integrity checks.
- Close incomplete Android connections when connect or MTU negotiation fails,
  times out or is cancelled.

All five packages are published. The [publication and recovery review](release/evidence/2.0.0-beta.12-publication.md)
records the bounded Android recovery result and remaining physical acceptance
limits. These fixes do not establish resolution of every Android GATT 8/133 error.

## 2.0.0-beta.11

- Add the managed encrypted-v2 backend adapter for React Native iOS/Android.
  Applications provide authenticated proxy routes, fresh credentials, exact
  scope and lifecycle hooks; the native adapter handles upload-session recovery.

See the [integration guide](docs/parity/v2-managed-backend.md) and
[publication record](release/evidence/2.0.0-beta.11-publication.md).

## 2.0.0-beta.10

- Retire the exact Android connection when explicit disconnect times out or is
  cancelled without a native callback, while preserving loss notifications.

See the [publication and acceptance review](release/evidence/2.0.0-beta.10-publication.md).

## 2.0.0-beta.9

- Handle Android Bluetooth-adapter shutdown even when the system omits the GATT
  loss callback. Explicit reconnect remains required.

See the [publication and acceptance review](release/evidence/2.0.0-beta.9-preflight.md#publication).

## 2.0.0-beta.8

- Propagate confirmed Android GATT loss to native connection observers and
  React Native without requiring an active status subscription.

See the [release record](release/evidence/2.0.0-beta.8-preflight.md).

## Standalone React Native retirement - September 29, 2026

The standalone `@bota.dev/react-native-sdk` package is retired. New integrations
use `@bota.dev/react-native-app-sdk`; existing versions remain available. Follow
the [migration and retirement notice](docs/migrations/react-native-sdk-sunset.md)
and rebuild native applications.

## 2.0.0-beta.7

- Repair Flutter publication staging and complete the synchronized five-platform
  release. Runtime behavior is unchanged from beta.6; verified beta.6 mobile
  binaries do not need rebuilding solely for this publication fix.

See the [release record](release/evidence/2.0.0-beta.7-preflight.md).

## 2.0.0-beta.6

- Add standalone-compatible client presence, fresh scoped observations and
  shared native upload recovery to the React Native integration.
- Include native encrypted-v2, reconnect and recording-transfer work from the
  maintenance-parity migration.

Apple, Android and npm packages were published; Flutter publication did not
complete. Use beta.7 or later for the synchronized family. See the
[release record](release/evidence/2.0.0-beta.6-preflight.md).

## 2.0.0-beta.1

- Fix Flutter Android SDK discovery through the application's standard build
  configuration, removing beta.0's explicit SDK-path workaround.

All five renamed packages were published and verified. See the
[publication record](release/evidence/2.0.0-beta.1-publication.md).

## 2.0.0-beta.0

- Introduce the current App SDK package names across Apple, Android, React
  Native, Flutter and Web. Historical package names and versions remain intact.

See the [package-name migration guide](docs/migrations/app-sdk-package-names.md)
and [publication record](release/evidence/2.0.0-beta.0-publication.md).

## Earlier releases and incomplete attempts

The [release evidence directory](release/evidence/) retains the 1.x release
records and incomplete 2.x attempts, including beta.2 through beta.5. A tag or
partially published package is not evidence of a complete synchronized release.
Maintainer recovery procedures and publication details belong in
[the release guide](docs/releasing.md), not installation instructions.
