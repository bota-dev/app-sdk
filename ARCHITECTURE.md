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

Every published App SDK artifact uses the exact semantic version in
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
revision `0f06d2a22c55` provided package shape, public models, and idiomatic async
conventions as incomplete transport scaffolds. The monorepo Apple migration
target now passes automated facade and packaging gates, but its supervised
physical-device matrix is not run. The pinned Apple repository therefore
remains a migration input rather than being replaced as accepted authority.
Neither native input supersedes the React Native behavioral baseline or the
Rust workflow conformance matrix.
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
comparison spike only. The shipping boundary uses versioned typed field-list
packets; the JSON smoke envelope remains comparison tooling and is not a public
serialization contract. No facade artifact is published yet. See
[`ADR 0001`](docs/adr/0001-command-event-host-boundary.md) and the
[`FFI evaluation`](docs/spikes/ffi-boundary-evaluation.md).

The shipping ABI implementation lives in `bindings/device-sdk-ffi` and exports
only versioned `bota_device_sdk_v1_*` symbols. Its opaque engine lifecycle and
structured error ownership are frozen. All ten core workflow commands enter
through `bota_device_sdk_v1_engine_start`, use stable numeric field and
capability IDs, reject unknown or duplicate fields, and retain the core's model
validation. Every current host effect and workflow notification leaves through
the ordered `bota_device_sdk_v1_engine_poll_output` queue as one explicitly
freed packet. Durable checkpoints are versioned opaque bytes to native storage,
not platform-visible reducer models. All current BLE, timer, persistence,
host-material, recording-sink, firmware-blob, secure-storage, and network
callbacks return through `bota_device_sdk_v1_engine_dispatch`; operation,
request, and cancellation ownership are checked before the reducer advances.
The ABI's typed protocol decode/encode entry points delegate status,
recording-list, transfer, OTA, provisioning,
connection-settings, and device-log formats to the shared core. Fragmented log
state is scoped to the engine handle, and unknown wire enum values remain
numeric fields rather than being discarded.

The public header exposes Swift-importable typed numeric constants and a Clang
module map. Standalone C and Swift programs compile and run against the shipping
static library in CI; the old JSON C exports have been removed, leaving JSON
only inside the explicitly enabled UniFFI decision spike.
ABI v1 is frozen for facade implementation: existing symbol names, packet-kind
values, field meanings, ownership rules, and status/error values are additive
only. The exact tested revision and header digest live in
`release/evidence/1.0.0-alpha.1-native-abi.md`. This freeze is an interface
milestone, not an Android support claim. Apple now has an automated facade
acceptance record, while its supervised physical-device gate and Android's AAR,
transport, and device gates remain open.

Apple facade development uses `platforms/apple/Package.swift` with a local
binary target assembled by `tools/apple/build-xcframework.sh` from arm64 iOS,
universal iOS simulator, and universal macOS Rust archives. Public consumers
use the root `Package.swift`, which compiles the same Swift facade source and
downloads the matching `BotaDeviceSDKCore.xcframework.zip` from the immutable
GitHub Release URL declared for that SDK version. SwiftPM verifies that archive
against the checked-in checksum before exposing product `BotaAppleSDK`.
Release packaging rewrites Xcode-generated XCFramework metadata into one
canonical plist so archives built by supported Xcode versions have identical
container metadata and checksums.
Assembly rejects a header digest or Swift package version that differs from the
frozen repository evidence.

`CoreAbiClient` is the sole Swift owner of the opaque native engine. It keeps
every borrowed input buffer alive through the complete C call, immediately
copies packet and error views into `Sendable` Swift values, and frees each
native owner exactly once. The ABI function table is injectable only to verify
those lifetime rules; production calls remain bound to the frozen v1 symbols.

The Apple facade maps those owned packets into public `Sendable` device,
recording, connection, progress, and stable-error values. Unknown numeric wire
states use `WireValue.unknown` rather than legacy fallbacks. Protocol fixtures
are mirrored into SwiftPM resources by `sync-protocol-fixtures.mjs`, checked for
drift on every package test, and executed through the Rust decode/encode ABI;
Swift does not contain a second wire parser.

`CoreEngineActor` is the single Swift workflow executor. It submits all ten
typed command shapes to Rust, drains notifications and host effects in order,
dispatches correlated host completions before polling again, and keeps the
active cancellation identity until a terminal notification. Unexpected stale
host events are rejected by Rust without releasing the current owner. The
compact SwiftPM workflow resource is generated from all seven canonical suites;
package tests reject drift and cover all 29 scenario labels. Concrete native
effect implementations route through the native hosts described below.

`HostEffectExecutor` converts the ABI boundary into six narrow native host
ports plus executor-owned timers and progress delivery. `CoreEffect` is an
exhaustive 30-case enum; routing has no catch-all branch. The executor preserves
the operation, request, and cancellation identity on every callback, rejects
oversized raw fields and mismatched event kinds, maps thrown host failures to
the ABI category event, and cancels suspended work by workflow identity. A late
completion therefore retains its old request identity and cannot satisfy a
newer operation.

`CoreBluetoothDriver` contains all `CBCentralManager` and `CBPeripheral`
ownership on a dedicated serial dispatch queue and exposes only value records
to `CoreBluetoothHost`. The actor host merges peripherals already connected to
a Bota service with live advertisements, deduplicates by Apple peripheral UUID,
serializes connect/discovery/read/write/subscription work per peripheral, and
allows unrelated peripherals to progress independently. Disconnect bypasses
that gate so a broken link can fail pending operations exactly once. A manual
selection preempts a background reconnect owner, and discovery timeout tears
down the half-open link before releasing radio ownership. Display names are
never used as device identity.

Apple native services keep operating-system resources behind opaque ABI IDs.
`FilePersistenceHost` atomically replaces the workflow checkpoint and retains
the exact authenticated-reset result until its matching receipt succeeds;
device secrets route to `KeychainSecureStorageHost` instead of those files.
Recording sinks and firmware blobs use registered UUID/download IDs with
bounded `FileHandle` access, and recording finalization validates the CRC32
defined by the frozen transfer protocol. `ApplicationMaterialHost` holds
application callbacks for provisioning/reset grants in memory. Network URLs,
headers, source files, and destinations are registered with
`URLSessionNetworkHost`; its delegate emits byte progress and cancellation
without placing those resources in a core packet or checkpoint.

`BotaDeviceClient` owns one configured `DeviceRuntime` and one public
`DeviceManager`. Configuration is idempotent until `destroy()`, which cancels
the active workflow, stops notification streams, disconnects the current
peripheral, and finishes observers. Manual connection and reconnect remain Rust
workflow commands, so Swift cannot introduce name-based selection or a second
retry policy. The facade forwards exact saved peripheral/address hints and
publishes a device only after serial verification. One-shot and streaming
device status bytes are read through the serialized CoreBluetooth host and
decoded through `CoreModelMapper`; there is no Swift status parser.

`ProvisioningManager` and `FactoryResetManager` register application callbacks
under opaque material IDs; endpoint bytes, device tokens, nonces, public keys,
and reset grants never enter public workflow notifications or durable reducer
checkpoints. Note settings pass through the shared encoder, which removes every
cellular selection before the serialized BLE write. Remove-only deprovision is
a direct shared-codec command and cannot invoke the authenticated reset reducer.
Factory reset binds its application grant request and durable result to both the
backend command ID and binding generation. Restart recovery rejects a stale
generation before starting the receipt-only reducer. A facade-wide operation
coordinator prevents direct writes from interleaving with any active workflow.

`RecordingManager`, `OTAManager`, and `DeviceLogManager` expose the remaining
public Apple workflows as typed `AsyncThrowingStream` values. Recording list
bytes use the shared decoder, transferred recordings complete as native file
URLs, and upload handoff returns only the reducer's direct, preserved, or BLE
fallback ownership result for application-supplied opaque IDs. OTA downloads
use application-provided `URLRequest` values registered behind a numeric ID,
reuse the native file across reducer recovery, and release host registrations
on every terminal facade path. Device logs expose only complete sanitized lines
emitted by the core. All three managers share the facade operation coordinator,
so destroy, explicit cancellation, and stream termination release ownership.

The external package under `tests/conformance/apple-consumer` depends on the
local Apple package only through its public product and deliberately cannot
import the internal C target. It runs on macOS and type-checks the complete
facade; CI separately compiles the package for generic iOS device and simulator
destinations with code signing disabled. Release builds remap checkout and
Cargo registry paths before compiling Rust, then reject binaries that retain
either machine-specific prefix. CI archives the generated XCFramework with
deterministic timestamps and entry order, verifies the root package checksum,
and publishes the archive, SHA-256 and SwiftPM checksums, SPDX
2.3 SBOM, repository license, and schema-validated artifact manifest. After
publication, a fresh macOS package resolves the release through the public Git
URL and imports only `BotaAppleSDK`, using bounded compiler parallelism on the
hosted runner. The protected release environment is the manual approval
boundary for hardware acceptance; automated CI does not claim physical-device
results.

The opt-in physical target requires `BOTA_PHYSICAL_TESTS=1`, an exact serial,
and an explicit device model. It returns `XCTSkip` before client configuration
when that global gate is absent. Serial identity is verified after connection;
display names never select a device. Settings, provisioning, recording
deletion, OTA, and deprovision each require an operation-specific gate, while
authenticated reset runs separately with a command-bound grant and
`BOTA_ALLOW_FACTORY_RESET=1`. The accepted status and unrun model matrix live in
`release/evidence/1.0.0-alpha.1-apple-facade.md`.

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
  mode; the App SDK does not receive backend decryption private keys.
