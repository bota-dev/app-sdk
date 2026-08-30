# Architecture

## Purpose

`app-sdk` is the source monorepo for Bota's device-facing SDKs. It consolidates
protocol and workflow behavior without hiding operating-system Bluetooth and
lifecycle differences.

This file is the public architecture contract for the repository. Maintainers
also validate protocol, security, and cross-system changes against Bota's
private normative design before merge.

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

Native migration inputs are pinned separately in
`protocol/baseline/native-sdks.json`. Apple revision `cd15e545cabb8` and Android
revision `0f06d2a22c55` provide package shape, public models, and idiomatic async
conventions, but both are incomplete transport scaffolds. They do not supersede
the React Native behavioral baseline or the Rust workflow conformance matrix.
`npm run baseline:native` verifies exact revisions and refuses unaudited dirty
checkouts before native source is imported.

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

Verified feature coverage and known gaps are recorded in
`protocol/compatibility/firmware-compatibility.json`. A feature is marked
supported only when it has both positive and malformed, rejected, or recovery
fixture coverage. The current matrix proves protocol behavior at the frozen
firmware `1.0.17` baseline; it does not claim native or physical-device support.

Core models are owned Rust values with no platform Bluetooth types. Unknown
wire enum values remain representable for forward compatibility, validated
device and recording identifiers cannot be constructed from malformed input,
and connection settings preserve immediate-off (`0`) versus always-on (`-1`).
Stable errors expose a machine code, operation, retryability, optional protocol
status, and diagnostic detail; callers branch on the stable fields rather than
platform error text.

All untrusted wire reads pass through the bounded cursor in
`core/device-sdk-core/src/protocol/cursor.rs`. Decoders return structured errors
for truncated or unknown packets and are covered by language-neutral fixtures
plus deterministic arbitrary-length input tests. Unknown device states,
connection types, WiFi results, and status bytes remain available as raw values
in the core; compatibility fallbacks belong at the platform facade boundary.

Serializers are typed and capacity checked before producing transport effects.
They normalize model constraints such as removing cellular from Bota Note,
preserve unknown heartbeat-mask bits, and keep the wire distinction between
immediate-off (`0x00`) and always-on (`0xFF`). Positive legacy timeout values
match the React Native baseline by rounding down to 10-second units with a
minimum encoded value of one. Provisioning payload chunking rejects data that
would exceed the one-byte chunk-count limit.

Workflow coordination uses the command/event/effect boundary in
`core/device-sdk-core/src/engine/`. Commands are authorized against explicit
host capabilities before effects can be built. `WorkflowEngine` permits one
active command owner, gives every effect a monotonic request ID, and rejects
stale callbacks or mismatched cancellation IDs. Platform callbacks enter as
typed host events carrying the completed request ID, while every requested host
effect also carries an operation and cancellation ID. Persisted checkpoints
intentionally cannot contain
credentials, presigned URLs, private keys, file paths, or recording payloads.
Discovery and connection reducers preserve the React Native reference behavior:
manual selection always verifies serial identity, reconnect prefers an exact
saved peripheral ID or advertised address, and serial fallback probes one Bota
candidate at a time after the scan window. Mismatches are disconnected before
the next probe, and checkpoints retain only stable identity, phase, retry count,
and candidate index. Recording transfer uses an opaque host sink: the core
orders truncate, append, checkpoint, final integrity verification, final ACK,
and device delete without persisting file paths or payload bytes. Firmware
restarts a resumed transfer at sequence zero, so the reducer skips sequence
numbers already represented by the durable checkpoint before appending new
data.

Upload handoff does not carry presigned URLs or credentials. The application
supplies opaque upload-session and destination IDs, while the reducer reads
fresh device status to decide ownership. Busy, detached, and unreadable states
preserve device ownership; only a fresh `sync_active=false` result can emit a
Bluetooth-fallback notification for the application to act on.

Firmware images live in a host-owned blob named by an opaque numeric download
ID. The core sees one bounded chunk at a time, owns the eight-packet ACK window,
and checkpoints only version, phase, byte count, sequence, and retry count.
Current firmware recreates `update.ufw` on `UPLOAD_START`, so recovery reuses the
downloaded blob but restarts BLE delivery at offset zero. After CRC acceptance,
the expected reboot disconnect enters the existing reconnect reducer and the
workflow completes only after reading back the requested firmware version.

Device-log streaming has one pending or active owner in the workflow engine.
The reducer subscribes before sending the firmware start command, forwards only
sanitized complete lines from the shared decoder, and sends stop before
unsubscribe on user cancellation. A physical disconnect releases host
subscription state without attempting a BLE stop write. Firmware that rejects
the diagnostics start command returns stable `feature_unavailable`; transport
loss remains a retryable connection error.

Native facades call the Rust reducer through a manually owned C ABI with opaque
engine handles, borrowed inputs, explicitly freed SDK-owned outputs, and stable
numeric request/cancellation identity. UniFFI `0.32.0` remains a non-shipping
comparison spike only. The current JSON smoke envelope is not the final public
serialization contract, and no facade artifact is published yet. See
[`ADR 0001`](docs/adr/0001-command-event-host-boundary.md) and the
[`FFI evaluation`](docs/spikes/ffi-boundary-evaluation.md).

The shipping ABI implementation lives in `bindings/device-sdk-ffi` and exports
only versioned `bota_device_sdk_v1_*` symbols. Its opaque engine lifecycle and
structured error ownership are frozen; typed command, event, effect, and
protocol packets must pass the native ABI foundation gate before a platform
facade can publish.

Workflow release evidence lives under `protocol/workflows/`. Its schema
requires the frozen source anchor, executable Rust test, command, host
capabilities, ordered inputs, ordered effects and notifications, and terminal
status. `npm run test:workflows` rejects duplicate scenarios, sensitive
checkpoint fields, missing source/test anchors, and any `supported`
compatibility claim that lacks positive, rejection, cancellation, and resume
or restart-recovery coverage. The cross-workflow matrix additionally proves
that all command variants reject stale callbacks and second owners without
mutating the active workflow.

Provisioning reads the connection-bound nonce and device public key before it
asks the host to resolve an opaque material ID. The core validates and chunks
the returned endpoint and token, subscribes for the result before writing, and
overwrites volatile nonce, key, and payload buffers on every terminal path.
Backend requests and durable credential storage remain host responsibilities.

Authenticated factory reset is a durable close-loop. The core subscribes before
grant/opcode writes, accepts only an exact three-byte success, asks the host to
persist the command-bound result, then sends receipt opcode `0x0A`. It asks the
host to delete that journal only after the receipt write succeeds. Resume mode
waits for firmware's exact replay and can send only the receipt; it cannot
resolve a grant or resend destructive opcode `0x06`.

## Security

- Never commit credentials, tokens, private keys, certificate bodies, signing
  material, or production endpoint secrets.
- Device identity is never inferred from the advertised BLE name alone.
- Factory reset is complete only after the authenticated physical-device receipt
  closes the backend command.
- Recording content stays encrypted according to the selected product security
  mode; the Device SDK does not receive backend decryption private keys.
