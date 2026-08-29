# Architecture

## Purpose

`app-sdk` is the source monorepo for Bota's device-facing SDKs. It consolidates
protocol and workflow behavior without hiding operating-system Bluetooth and
lifecycle differences.

The normative cross-system design is
[`internal-docs/Device SDK Architecture.md`](../internal-docs/Device%20SDK%20Architecture.md).

## Boundaries

- Rust owns wire parsing, serialization, cryptographic envelopes, deterministic
  workflow state, retries, checkpoints, and stable errors.
- Swift/CoreBluetooth, Kotlin/BluetoothGatt, C#/WinRT GATT, and TypeScript/Web
  Bluetooth own platform integration.
- React Native and Flutter delegate to native facades.
- The host application obtains backend grants, device tokens, and presigned
  upload targets. This repository does not provide a Bota API client.
- Firmware, Demo, Bota One, Portal, and backend services remain in their own
  repositories.

## Repository Shape

```text
core/           Shared Rust protocol and workflow core
platforms/      Apple, Android, Windows, and Web facades/adapters
frameworks/     React Native and Flutter bindings
protocol/       Machine-readable manifest, fixtures, and compatibility data
tests/          Cross-platform conformance and physical-device suites
tools/          Code generation, validation, and release tooling
release/        Release schema, manifests, and verification evidence
docs/           Decisions, public guides, and implementation plans
```

Directories are added only when their milestone starts.

## Versioning

Every published Device SDK artifact uses the exact semantic version in
[`sdk-version.toml`](sdk-version.toml). Release tooling rejects a package or
manifest with a different version.

The release manifest also pins the source revision, firmware compatibility
range, protocol-fixture digest, artifact checksums, and artifact capability
sets. An artifact is not publishable unless it appears in a validated manifest
and its version matches `sdk-version.toml`.

## Migration Rule

The existing React Native SDK at revision `44ac1221cb71` is the initial
behavioral baseline. It remains authoritative until the monorepo implementation
passes the relevant fixture, workflow, native, application, and physical-device
acceptance gates.

Language-neutral protocol fixtures live under `protocol/fixtures/`. The baseline
record under `protocol/baseline/` pins the SDK and firmware revisions, source
digests, fixture digest, and passing test counts. `npm run baseline:react-native`
builds and tests an explicit SDK checkout before comparing every applicable
fixture; it refuses dirty checkouts unless the audit flag is supplied.

Stable wire facts such as service UUIDs, characteristic UUIDs, opcodes, packet
types, field layouts, and size limits live in
`protocol/manifest/device-protocol.yaml`. Rust constants are generated into
`core/device-sdk-core/src/generated/protocol.rs`; edit the manifest and run
`cargo xtask protocol generate` rather than editing generated code.

## Security

- Never commit credentials, tokens, private keys, certificate bodies, signing
  material, or production endpoint secrets.
- Device identity is never inferred from the advertised BLE name alone.
- Factory reset is complete only after the authenticated physical-device receipt
  closes the backend command.
- Recording content stays encrypted according to the selected product security
  mode; the Device SDK does not receive backend decryption private keys.
