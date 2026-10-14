# Changelog

User-facing changes to the Bota App SDK. Entries under **Unreleased** describe
source changes that are not in the published packages. Published versions and
tags are immutable; package publication and application/device acceptance are
tracked separately.

## Unreleased

## 2.0.0-beta.17

- Admit HTTPS managed encrypted-v2 proxies whose routes start at the origin root,
  as well as existing path-prefixed proxies. An explicit empty Rust API prefix
  selects root routes; omitting it preserves `/v1`. Scope, origin, authorization,
  exact route and receipt-gated cleanup checks remain enforced.
- Export portable sync status, upload recovery version and presence helpers from
  `/runtime` so generated-JS applications do not import native compatibility code.
- Recognize only the exact successful-clear legacy Android checkpoint catalog
  through a Rust-generated helper; pending, malformed and torn evidence stays
  protected during app migration. Match the BLE port's disconnect nullability
  to the actual pinned `react-native-ble-plx` type without app casts.

All five synchronized packages, exact main CI/License, protected publication,
public consumers and complete archive verification pass. See the
[publication review](release/evidence/2.0.0-beta.17-publication.md). App delivery,
OTA and physical acceptance remain separate.

## 2.0.0-beta.16

- Publish all five beta.16 packages under the existing public package identities.
  React Native uses `@bota.dev/react-native-app-sdk/runtime`; the companion is a
  private verification fixture. The independent namespace/publication plan is
  withdrawn. Exact main CI/License, protected release attempt 2, public
  JS/declaration/native consumers and complete Flutter verification pass; see the
  [publication review](release/evidence/2.0.0-beta.16-publication.md).
- Add a JavaScript runtime generated from the shared Rust core, with versioned
  installed OS ports and generic BLE integration. Device workflows, encrypted-v2
  receivers, managed/BYO uploads and queue policy execute in the OTA bundle.
- Preserve exact scope, cancellation settlement, durable completion and separate
  receipt-gated device cleanup. Firmware success requires verified serial and
  installed version after reboot; compatible JS upgrades do not require rebuilding
  the full Bota native SDK.
- Publication, consuming-app integration/OTA and physical acceptance remain
  separate gates. Existing native factory and frozen compatibility exports remain.

## 2.0.0-beta.15

- Bound Apple framed transfers by single-ATT capacity and preserve numeric device
  rejection details; acquire a system-connected peripheral through the local
  central callback before SDK use.
- Add `pauseAutoReconnect()` so hosts can stop retries and await submitted
  reconnects before changing their scoped workspace.
- Remove the unsupported EndUser field from managed Apple encrypted-v2 session
  creation while retaining it on recording creation and native scope checks.
- Include reviewed main recording-marker/protected-status and BYO live/batch
  storage integrations; firmware and customer rollout gates remain separate.
- All five packages and public consumer gates passed; see the
  [publication review](release/evidence/2.0.0-beta.15-publication.md).

- Firmware OTA treats loss of the transfer-status stream after successful image
  verification as reboot recovery. Reconnect retries short scans within the
  existing two-minute deadline and still requires the same serial and target
  firmware version before success. This source change requires a native app
  rebuild; it does not update installed applications.

- Android waits for local completion of Bluetooth writes without response before
  sending the next GATT operation, preventing overlapping OTA writes. Cancelling
  an issued write retires that connection before retry. Immediate Android write
  errors retain their original code. See the
  [source review](docs/parity/android-write-completion.md).

## 2.0.0-beta.14

- Retry the exact compatibility upload-verification-pending response within the
  existing operation and persist native completion intent across app restarts.
- Accept canonical safe decimal `file_size_bytes` strings from existing backend
  integrations while preserving numeric validation and optional missing values.
- Retain device audio until completion acknowledgement; publication, native app
  delivery and physical qualification remain separate gates.
- See the [source design review](docs/parity/upload-recovery.md#october-8-pending-completion-recovery-unpublished-source)
  and [publication review](release/evidence/2.0.0-beta.14-publication.md).

All five packages, public native consumers and complete Flutter archive
verification passed. New native app binaries and physical acceptance remain
separate.


## 2.0.0-beta.13 (candidate)

- Refresh React Native legacy upload destinations only when native files are ready.
  See the [upload recovery review](docs/parity/upload-recovery.md#october-7-deferred-destination-correction-unpublished-source).
- Update reviewed dependency security patches and parser/Rust tooling pins.

- Preserve Apple error codes, descriptions, operation, retry policy and optional
  protocol status when `BotaSDKError` bridges to `NSError`. See the
  [error bridge review](docs/parity/apple-error-bridge.md).
- Correct recording-control decoding so an activity snapshot's UUID bytes are
  not treated as a command result. Android waits for the requested activity or
  an explicit result. See the [recording-control review](docs/parity/recording-control-notifications.md).
- Require dedicated, generation-bound factory-reset authorization instead of
  accepting remove-only deprovision grants. Receipt recovery does not issue a
  new reset. This needs matching SDK, app, backend and firmware releases; see
  the [reset contract](docs/parity/factory-reset-authorization.md).

Publication remains pending; see the [beta.13 preflight](release/evidence/2.0.0-beta.13-preflight.md).

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
