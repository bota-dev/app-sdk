# Architecture

## Purpose

`app-sdk` is the source monorepo for the Bota App SDK family. It consolidates
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
- Customer-facing package and module names follow the public matrix in
  [README.md](README.md). Internal Rust crates, C ABI artifacts, paths, and
  symbols retain their established `device-sdk` names.
- Firmware, Demo, Bota One, Portal, and backend services remain in their own
  repositories.
- Remote actions preserve one backend command identity across every transport.
  The SDK relays opaque exact-action authority and device receipt/result
  evidence; it does not create a second transport-local command identity.

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

Release manifest version 2 identifies the public family with
`sdkFamily: "bota-app-sdk"` and requires every artifact's `platform` and
`packageIdentifier` to match the public matrix in [README.md](README.md). It
also pins the source revision, firmware compatibility range, protocol-fixture
digest, artifact checksums, and artifact capability sets. Version 1 remains
accepted for immutable published evidence. An artifact is not publishable
unless it appears in a validated manifest and its version matches
`sdk-version.toml`.

The React Native package is packed with the exact npm CLI declared by its
`packageManager` field. The tarball is uploaded as release evidence, included
in the annotated tag's candidate inventory, and published only from the
protected `release.yml` environment through npm OIDC trusted publishing. A
rerun first compares the registry `dist.shasum` with the candidate tarball, so
an uncertain publish is recoverable without attempting to replace an immutable
npm version. The npm package trusts `bota-dev/app-sdk`, `release.yml`, and the
`release` environment; no long-lived npm write token enters GitHub Actions.

## Migration Rule

The existing React Native SDK at revision `44ac1221cb71` is the initial
behavioral baseline. It remains authoritative until the monorepo implementation
passes the relevant fixture, workflow, native, application, and physical-device
acceptance gates.

Its public TypeScript entrypoint is frozen separately in
`protocol/baseline/react-native-public-api-0.0.65.json`. The semantic contract
records 80 exports, expanded type aliases, class static APIs, and every reachable
public member, including inherited EventEmitter and Error instance and static
APIs. It excludes private, protected, and internal-only declarations. Contract
extraction requires dependency declarations installed from the npm lockfile,
permits only npm's lock-marked platform-optional omissions, and validates the
baseline package, version, source revision, normalized path, and digest as one
identity.
Protocol parity is necessary but does not satisfy React Native compatibility
unless the target package also matches this surface digest.

The replacement package lives at `frameworks/react-native` as an independently
locked npm package and is published as `@bota.dev/react-native-sdk@1.1.0` after
passing the native adapters, frozen 0.0.65 TypeScript surface, application
acceptance, and publication gates. Its initial New Architecture floor is React
Native 0.86.3, matching Demo and Bota One. The Codegen library is
`BotaDeviceSDKSpec` and its native module is `BotaDeviceSDK`. JavaScript uses
optional TurboModule lookup so importing a bundle before the native application
is rebuilt does not throw; the first native operation instead returns stable
`native_module_unavailable`.

The bridge contract contains configure, destroy, state, capabilities, device
discovery, selected-device connect, serial-strict reconnect, disconnect, a
device-status read, a typed device-status event subscription, nonce-bound
provision/deprovision operations, native-file recording transfer, and guarded
upload ownership, plus native-download firmware update, sanitized device-log
subscription, and WiFi configure, disconnect, status, status-subscription, and
device-side scan operations. WiFi credentials and grant values cross Codegen as
application inputs, while native facades own packet encoding, characteristic
writes, notification ordering, parsing, and cancellation. Provisioning uses a
one-shot application material event and response rather than separating
nonce/public-key reads from the native workflow. Upload ownership passes opaque
recording, upload, and destination identifiers into native code; JavaScript
receives progress and the reducer's terminal ownership decision but never a
destination URL or upload credential.
Batch recording transfer accepts both plaintext packets and the encrypted
streaming-AEAD packet family. The shared reducer writes encrypted sessions in
the backend relay format directly into the native sink and rejects mixed or
headerless encrypted streams before upload ownership can advance.
Firmware update accepts version, size, and a presigned URL; native hosts derive
CRC32 from the downloaded bytes after durable storage, Rust uses that value for
device verification, and Codegen emits only typed phase and byte progress.
Device-log framing, sequence recovery, and UTF-8 assembly stay in the Apple and
Android facades. Codegen carries only complete `message` and `isBacklog`
values, while the JavaScript subscription preserves the frozen
`DeviceLogEvent` shape and owns one native stop.
React Native Codegen produces a canonical schema plus iOS and Android artifact
digests in
`frameworks/react-native/generated/codegen-contract.json`; CI regenerates and
compares that contract with the pinned React Native version. Recording and
firmware payloads never cross the JavaScript bridge. Future workflow methods
carry identifiers, progress, errors, and native file paths while native hosts
own high-volume files and transfer buffers.

The JavaScript compatibility layer now restores all 80 frozen exports. This
includes every `0.0.65` public type, the runtime error hierarchy,
`deriveSyncStatus`, `DeviceLogDecoder`, `DeviceManager`, `RecordingManager`, and
`StreamingSession`, `OTAManager`, and the singleton `BotaClient`; a semantic
test compares each declaration with the frozen
contract, and behavior tests cover every non-inherited manager method. Rust and
the platform hosts own live-transfer ordering, buffers, upload bytes,
finalization, and cancellation; Codegen carries only low-volume requests and
progress. `BotaClient` serializes configure and destroy operations and replaces
its compatibility manager graph as one unit during reconfiguration.
Local application acceptance uses the packed npm artifact rather than source
linking so Metro resolves the same files that publication would contain. Demo
and Bota One both produce release-mode iOS and Android Expo bundles from that
artifact. This is a mobile build gate only: it does not replace supervised
physical-device acceptance or preview and production rollout evidence.
The exported `DeviceManager` compatibility owner preserves the already
native-backed scan, selected connection, status, settings, logs, WiFi, and
last-known WiFi cache behavior, including idempotent legacy removal functions.
The sibling `BotaDeviceSDK.controls` facade now delegates provisioning-state,
device-public-key, auth-nonce, API-endpoint, certificate, backend-public-key,
recording-grant, time-sync, grant-gated recording start/stop, recording-state
reads, and one owned recording-state stream to native Apple and Android
`DeviceControlManager` facades. Certificate chunk framing, public-key bytes,
grant writes, subscription ordering, opcodes, and stop-command pacing remain
native; Codegen carries only typed text, command results, and recording state.
The compatibility owner preserves the frozen recording grant-fetcher overloads,
pending command precedence, state cache fallback, synchronous idempotent
subscription removal, serialized reconnect ownership, and user-disconnect
pause. While auto-reconnect is enabled, one native status watchdog reports
transport loss through a private Codegen event, clears stale connection state,
and restarts the single serial-strict reconnect loop.
The package's new `BotaDeviceSDK.devices` facade is intentionally smaller than
the exported compatibility `DeviceManager`: it owns a typed discovery subscription, preserves
the frozen JavaScript scan filters, connects a selected peripheral while the
native facade learns its serial identity, reconnects only by an expected serial,
disconnects, reads current status, and owns a typed status subscription. It is
an incremental workflow surface, not class parity.
The sibling `BotaDeviceSDK.provisioning` facade delegates provisioning and
grant-gated remove-only deprovision to native managers. During provisioning, native code
emits only a request ID, serial, nonce, and public device key; JavaScript
returns the endpoint, token, and MTU or rejects the request. Pending requests
are cancelled on destroy so no continuation outlives its native workflow.
The endpoint field and native `API_ENDPOINT` write are retained compatibility
behavior in the current implementation, not the target environment boundary.
Firmware treats that characteristic as a no-op; the replacement flow must
validate the signed firmware/build environment against the Partner backend and
omit the write. Current conformance is tracked in `internal-docs/System Design
v5.md`.
Deprovision decodes and writes the nonce-bound grant natively, subscribes before
opcode `0x05`, maps the firmware response to a typed result, and tears down that
notification owner exactly once.
Its `writeConnectionSettings` operation accepts the frozen JavaScript settings
shape, expands omitted defaults at the compatibility boundary, and passes a
complete typed value through Codegen. Apple and Android apply their public
facades' device-model normalization and own serialization plus the BLE write;
raw encoded settings bytes never enter JavaScript. Heartbeat channel selection
remains distinct from upload preference through the complete path, and an
omitted heartbeat setting retains the frozen both-channels-enabled default.
The paired `readConnectionSettings` path keeps the characteristic bytes and
shared decoder native, returns only a complete typed settings value through
Codegen, and maps it back to the frozen snake-case JavaScript shape. Unknown
future connection types remain representable natively and are omitted from the
legacy JavaScript union.

The Apple host is now executable. A Swift actor coalesces concurrent
configuration, orders destruction after any in-flight configuration, and calls
the public `BotaDeviceClient` facade. A separate actor owns scan and status
collection and cancels status before a connection transition or destruction.
Objective-C++ implements only the generated TurboModule spec, typed discovery,
status, recording-state, provisioning, and reset-grant event emission, and
promise conversion. The pod uses React Native
0.86's iOS 15.1 floor and resolves the exact matching `BotaAppleSDK` release;
the local package-path override exists only for source and CI builds. A
disposable Objective-C++ and Swift CocoaPods application compiles and links the
complete native chain.
The build toolchain is locked, and a separate remote-resolution gate confirms
that the default package URL resolves the synchronized immutable release. A
target-scoped CocoaPods hook carries React Native's upstream fix for duplicate
binary Swift-package module maps on Xcode 26.3 while the package floor remains
0.86.3. This proves lifecycle plus device discovery, connection, status,
provisioning, connection-settings reads and writes, authenticated-reset,
recording control and state, recording-transfer, upload-ownership, OTA,
device-log, and WiFi integration, not the remaining workflow surface or
application parity.

The Android host is also executable. A coroutine mutex serializes
configuration and destruction through `BotaDeviceClient.shared`, and a
`BaseReactPackage` registers the generated TurboModule with stable state,
capability, and `android_sdk_error` behavior. A separate owner contains scan and
status failures and cancels owned streams before connection transitions or
destroy. A one-shot material broker delegates provisioning, remove-only
deprovision, authenticated reset, and exact-generation receipt recovery through
the public Android facade. A checked-in React Native 0.86.3
Gradle consumer regenerates Codegen, runs lifecycle unit tests and lint, and
assembles the adapter against the exact AAR reconstructed from the immutable
local Maven payload. This proves Android lifecycle plus device discovery,
connection, status, provisioning, connection-settings reads and writes,
authenticated-reset, recording control and state, recording-transfer,
upload-ownership, OTA, device-log, and WiFi integration only; the remaining
workflow bindings and application parity remain open.

The React Native reset broker exposes only the nonce, command ID, binding
generation, and an encoded grant string. Apple and Android decode the grant into
native bytes before calling their public `FactoryResetManager`; Codegen never
carries the destructive payload. Both adapters return the exact command and
generation completion. When the application supplies a result persister, each
native host writes its own reset journal, awaits the application durable-save
callback, and only then reports the save to Rust so receipt opcode `0x0A` can be
sent. Exact-result replay repeats that application save before the receipt.
`resumePendingFactoryReset` delegates directly to the native receipt-only
workflow, which rejects a stale generation before Rust starts and cannot
request another grant or resend opcode `0x06`.
After application reinstallation removes the native reset journal, resume can
still wait for the device's exact successful replay, persist that result through
the application hook, and send only receipt opcode `0x0A`.

The React Native recording broker maps native recording metadata to the frozen
JavaScript shape and emits transfer progress as counts only. Apple and Android
consume their public recording streams behind the TurboModule and return the
completed native file path together with the actual transfer's E2E-framing flag
and optional device SHA-256. Relay selection must use that completion metadata,
not the recording-list encryption flag. The compatibility path asks native code
to retain the device copy, completes the native file upload, and only then sends
a typed native confirm for the exact recording. Audio content, transfer packets,
and sink handles never enter Codegen, and teardown cancels the native recording
owner.

The React Native device-log broker subscribes to the public native log stream
before starting delivery. Apple and Android retain packet decoding and emit
only complete sanitized lines through Codegen. JavaScript assigns the frozen
`debug` level, preserves the backlog marker, and idempotently removes the event
listener before stopping the native stream.

The Android migration has a native package foundation in `platforms/android`.
`sdk-version.toml` is mirrored as `VERSION_NAME`, while release-readiness tests
pin Gradle 8.13, Android Gradle Plugin 8.13.2, and Maven Publish Plugin 0.35.0.
The API-26 library declares optional BLE hardware and permissions without
requesting them, locks and verifies dependencies, and produces deterministic
unsigned local AAR, sources, Dokka Javadoc, POM, and module metadata. The AAR
contains the frozen Rust C ABI plus a thin Kotlin/JNI ownership adapter for all
four supported Android ABIs. Inputs are borrowed typed fields, Rust-owned
packets and errors are copied before exactly one free, and recording or firmware
buffers may enter through direct `ByteBuffer` values without JSON or base64.
The public Kotlin surface now also includes immutable device, recording,
connection, progress, and stable error models. `CoreModelMapper` converts typed
ABI fields but never parses or serializes a wire packet in Kotlin. API-35
instrumentation runs all 55 language-neutral fixtures through JNI, including
unknown values, encrypted payload metadata, settings, OTA, WiFi, and logs. No
Kotlin workflow state machine exists: one closeable single-thread coroutine
runtime submits all 10 commands to Rust, drains all 30 effect and 12
notification kinds, and returns all 34 correlated host-event kinds with the
original request and 128-bit cancellation IDs. API-35 instrumentation verifies
the Android resource generated from all 29 canonical workflow scenarios. An
exhaustive `HostEffectExecutor` routes all 30 effects through separate BLE,
persistence, secure-storage, network, material, recording-sink, and
firmware-blob ports. It owns timers, bounds returned bytes, permits multi-event
streams only where the ABI does, and rejects mismatched callbacks before Rust
sees them.
The Android Bluetooth transport confines `BluetoothLeScanner`,
`BluetoothGatt`, callbacks, and mutable framework state to one named
HandlerThread. A per-device queue serializes MTU, discovery, read, write, and
CCCD operations while allowing independent devices to progress. Monotonic GATT
generations reject callbacks from replaced connections, disconnect cancels
blocked work, and manual selection preempts background reconnect ownership.
Scan identity uses peripheral IDs plus advertised manufacturer data; names are
display metadata only. The host checks location permission through API 30 and
scan/connect permissions on API 31+ before an effect reaches the platform.
Android non-secret checkpoints, reconnect identity, and exact factory-reset
receipts use AtomicFile journals under application no-backup storage. Secret
values are AES-GCM ciphertext bound to opaque keys, with the non-exportable key
held by Android Keystore. Recording sinks and firmware blobs use host-registered
paths or ParcelFileDescriptors and bounded FileChannel operations; Rust receives
only opaque IDs and bytes. OkHttp requests and application material are one-shot
host registrations removed on completion, cancellation, failure, replacement,
or destroy. The network host tracks and cancels only its own calls when sharing
an injected client.
Android now exposes the first public workflow facade through
`BotaDeviceClient` and `DeviceManager`. Configuration is idempotent until
destroy and retains only the application context. Permission checks occur
before Rust starts a workflow. Scan cancellation preserves the original
128-bit cancellation ID. Manual connection accepts a selected peripheral and
learns its identity from a fresh GATT serial read; callers that already know the
serial can require an exact match. Reconnect always requires the known serial
and only forwards saved peripheral/address/name hints to the canonical reducer.
A device is published only after Rust reports the verified serial. Connection
observers complete on destroy, while direct status
reads and streams use the shared ABI decoder and serialized GATT driver. The
scan flow acquires workflow ownership at collection time, with a fresh command
and cancellation identity for every collection. Runtime generations reject
late workflow completion after destroy or reconfiguration. Status teardown is
bound to its originating runtime and disables the device-wide CCCD only after
the last collector leaves. Runtime construction rollback and destroy attempt
every registered resource close, preserving cleanup failures without leaking
the Bluetooth thread or native engine.

The one-major Android migration adapter preserves the public `com.bota.sdk`
JVM descriptors from pinned revision `0f06d2a…` while delegating supported
behavior to this facade. Kotlin API dumps, source recompilation, and
already-compiled bytecode run against the replacement AAR on API 26 and API 35.
The checked-in binary fixture contains only that consumer bytecode and binds
the pinned legacy revision plus frozen API digest. Its metadata version must
match the Kotlin 2.1 consumer floor; CI verifies that invariant without access
to the private legacy repository.
The clean consumer resolves only `dev.bota:bota-android-sdk`; coroutine and
OkHttp types exposed by the public API are Maven API dependencies. The release
coordinator accepted the native physical matrix for synchronized `1.1.0`.
Central deployment `6c4384ae-fe6a-4ec4-b9b3-774e437f07f7` is published, and
release workflow run `33685720066` resolved and ran the public AAR on Android
API 26 and API 35.

Android release packaging has separate unsigned and protected graphs. Normal
builds can publish only to `target/android-m2` and do not register a signing
task. The exact protected opt-in validates both in-memory signing secrets before
it declares the separately rooted raw repository. Gradle's signed 55-file
output is checked byte-for-byte, reduced to the canonical 30-file Central
Portal tree, and archived from a separate complete inventory with fixed ZIP
metadata. The check-only package builds twice, compares the AAR and every native
library digest, and emits checksums, SPDX 2.3 evidence, the repository license,
and a manifest-v2 Android artifact bound to reviewed facade evidence rather
than Rust-only compatibility claims. Rust and CMake native link steps set a
16 KiB page size explicitly, and release inspection verifies every 64-bit ELF
load segment is aligned to at least `0x4000` before an AAR can proceed.

Non-publishing CI treats that flat release directory as the immutable Android
input. It reconstructs an exact local Maven repository, then runs source,
precompiled legacy, and unrelated public consumers against the same AAR on an
API 26 Google APIs x86 emulator and an API 35 Google APIs x86_64 emulator. AVD
state is created and deleted per lane. Runtime Maven dependencies are an exact
set governed by `android-maven-license-policy.json`; package verification
requires the Gradle module, reviewed policy, and SPDX licenses to agree. Tag
workflows bind the independently rebuilt Apple and Android payloads to an
annotated-tag candidate-inventory digest. The protected job signs Android only
in memory, preserves the first signed 30-file Central bundle, and durably records
the deployment UUID before polling. `PENDING`, `VALIDATING`, `VALIDATED`, and
`PUBLISHING` resume from that record; an uncertain initial upload stops until
an explicit protected recovery supplies the matching Portal UUID. Detached PGP
signatures include a creation time, so reruns never replace the preserved ZIP.
A confirmed `FAILED` deployment can be superseded only after the protected
recovery verifies its UUID and deployment name, then uploads those same
preserved bytes as a fresh deployment. Publication
is claimed only after the complete public Maven directory matches the signed
inventory and unrelated API 26 and API 35 consumers run it.

Android `ProvisioningManager` and `FactoryResetManager` use the same opaque
material, durable reset, shared-codec, and facade-wide operation contracts as
Apple. Provisioning tokens, endpoints, nonces, device public keys, and reset
grants stay in application-memory host registrations. Bota Note settings are
normalized before encoding, remove-only deprovision writes the grant before the
shared deprovision command and awaits its result, and authenticated reset persists the command-bound result
with its binding generation before receipt. Restart recovery rejects a stale
generation and runs only the exact receipt workflow. Registration, failure,
cancellation, detach, and destroy paths release material and operation
ownership without deleting a valid durable reset result.

Android `RecordingManager`, `OTAManager`, and `DeviceLogManager` expose cold
typed flows backed by the same reducer notifications as Apple. Recording sink
and firmware bytes stay in application no-backup files registered by opaque ID;
completed recording events return only the native `Path`. OTA registers one
OkHttp request and one firmware-blob view over the same native file, preserving
the blob across reducer retry while removing registrations on every terminal
facade path. Upload handoff emits only device-completed, device-preserved, or
BLE-fallback ownership values. Log flows emit only complete sanitized lines
from the shared decoder. Collector termination, explicit cancellation,
destroy, failure, and success release the original cancellation ID, native
registration, and facade-wide operation owner.

Native migration inputs are pinned separately in
`protocol/baseline/native-sdks.json`. Apple revision `cd15e545cabb8` and Android
revision `0f06d2a22c55` provided package shape, public models, and idiomatic async
conventions as incomplete transport scaffolds. The monorepo Apple migration
target now passes automated facade and packaging gates, and the release
coordinator accepted its supervised physical-device matrix for `1.1.0`. The
pinned Apple repository therefore
remains a migration input rather than being replaced as accepted authority.
Neither native input supersedes the React Native behavioral baseline or the
Rust workflow conformance matrix.
`npm run baseline:native` verifies exact revisions and refuses unaudited dirty
checkouts before native source is imported.

Language-neutral protocol fixtures live under `protocol/fixtures/`. The baseline
record under `protocol/baseline/` pins the SDK and firmware revisions, source
digests, fixture digest, public API digest, and passing test counts.
Recording-control fixtures freeze both the 18-byte state notification and the
6-byte command result whose result code is byte 5, including the legacy
one-byte fallback used by React Native `0.0.65`.
`npm run baseline:react-native` builds and tests an explicit SDK checkout before
comparing every applicable fixture and the semantic public API. It refuses
dirty checkouts unless the audit flag is supplied. The narrower
`baseline:react-native:api` command verifies only the public API contract.

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
serialization contract. The Apple, Android, and React Native facades are
published for `v1.1.0`; the remaining planned facades are not yet published. See
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
recording-list, recording-state/result, recording-control opcodes, transfer, OTA, provisioning,
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
milestone, not an Android support claim. Apple and Android now have automated
facade acceptance records, accepted supervised physical-device gates, and
public remote-consumer evidence for their `1.1.0` packages.

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
The Apple and Android fixture runners both execute all 39 frozen decode cases,
including recording state and command-result compatibility.

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

`DeviceControlManager` owns Apple and Android remote-recording commands. It writes the
application-provided grant, subscribes before the shared-core start or stop
opcode, preserves the two frozen 50 ms stop-command pacing gaps, and always
releases the temporary notification lease. Recording-state reads and streams
also use the shared decoder; client destruction closes every active observer
exactly once on both facades.

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
`BOTA_ALLOW_FACTORY_RESET=1`. The accepted status and model matrix live in
`release/evidence/1.1.0-apple-facade.md`; private device logs and credentials
remain outside the public repository.

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
