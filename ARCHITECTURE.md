# Architecture

The 2.x source uses explicit App SDK distribution names. Apple SwiftPM and
CocoaPods, Android Maven, both npm artifacts, and Flutter pub.dev are public at
`2.0.0-beta.1`. Physical acceptance and application rollout remain separate,
pending gates. See the
[migration guide](docs/migrations/app-sdk-package-names.md). Historical release
records below retain their original names and versions.

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
bindings/       Internal native ABI and WebAssembly bridges
platforms/      Apple, Android, and future Windows facades/adapters
frameworks/     React Native, Web, and future Flutter bindings
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
The Web package follows the same immutable-candidate rule. CI builds its WASM
bridge with host paths remapped, packs `@bota.dev/web-app-sdk` once with the pinned
npm CLI, and installs that exact tarball in a clean Vite consumer. Package
verification records per-file hashes plus raw and normalized tarball hashes;
the production ESM/WASM consumer and pinned Chromium behavior suite run against
that installed copy. CI uploads the tarball and inventory together. The
protected release verifies and publishes only that preserved tarball under npm
`beta`, verifies the registry `dist.shasum`, and does not move `latest`.

The Flutter facade is implemented in source, but it is not part of the
immutable `1.1.0` public release and has not been published. The historical
`1.2.0-beta.0` candidate identity is occupied by immutable non-Flutter source
and cannot identify this tree. Selected replacement `1.2.0-beta.12` binds its
exact source revision, Pigeon identity, raw and normalized archive digests, and
every file's digest before it can be tagged or published.

## Migration Rule

The existing React Native SDK at revision `44ac1221cb71` is the initial
behavioral baseline. It remains authoritative until the monorepo implementation
passes the relevant fixture, workflow, native, application, and physical-device
acceptance gates.

The public TypeScript surface remains frozen against `0.0.65` at that revision.
Executable workflow evidence is a separate authority: maintenance SDK `0.0.67`
at revision `318974f925a573cf04b0d624978bee04784af09b`. CI and tagged-release
verification run its referenced v2 tests without changing the public-surface
contract.

The newer maintenance additions have a separate explicit contract, rather than
weakening the frozen surface check. Unpublished source now includes typed
diagnostics read/acknowledgement on Apple, Android and RN, native-file RN upload
recovery with fresh exact-scope credentials, and Apple/Android lost-WINDOW_ACK
resume reconciliation. These changes do not imply complete cross-platform or
hardware parity. JavaScript `RecordingDataStore` byte callbacks are unsupported
by the native-file architecture and fail explicitly during configuration.
The feature-specific notes under `docs/parity/` describe the boundaries and
tests; published beta.1 and encrypted-v2 capability metadata remain unchanged.

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

Encrypted Upload v2 remains contract-only in compatibility metadata: the
canonical vectors, Rust codecs, native Apple and Android runtimes, target React
Native facade, and maintenance React Native runtime evidence exist, while
firmware advertisement, published-release, and hardware gates remain open. The
Rust workflow engine and additive C ABI model v2 session ownership,
durable checkpoint ordering, opaque native staging, and receipt-gated
confirmation. Apple has an internal command mapper, an
exhaustive twelve-effect host port with typed failure and staged-notification
routing, and an in-memory application-material registry keyed by opaque ID.
The shared Rust engine keeps cancellation ordinary when the CONFIRM effect is
only queued or doing local cleanup. Apple and Android atomically claim native
cancellation before the canonical write, or—once that write is actually
attempted—settle exact completion or stable cleanup-uncertainty code 19 without
a later rollback. When cancellation races Apple engine startup return, exact
Completed or code 19 preserves terminal material, while an ordinary cancel
failure after a pre-CONFIRM claim removes the material as cancelled. Android
rejects phase-invalid transfer frames as notifications arrive, uses bounded
loss-aware broadcast delivery for concurrent observers,
and reconciles the retired split checkpoint/index files into its atomic catalog.
The registry keeps authorization, manifest, receipt, and staging credentials
out of Rust and persistent state; validates exact document sizes, evidence, and
bodyless HTTPS PUT requests; and removes providers before terminal cancellation
callbacks run. Registration generations also reject callbacks that complete
after removal or replacement. Apple also pins the separate `0406..040B`
characteristic allocation and configures a fresh capability reader. Each
selection read fetches `0406` again, delegates exact 24-byte decoding to Rust,
and returns the raw-value SHA-256 plus typed bounds; it has no firmware/model
inference or cache. The additive `0x0523` ABI encoder also delegates outbound
signed-blob BEGIN/DATA/COMMIT/ABORT bytes to the Rust codec, keeping
authorization and receipt framing out of platform implementations. Additive
kind `0x0524` delegates app-originated LIST, START, WINDOW_ACK, RESUME_REQUEST,
CONFIRM, and ABORT transfer encoding to the same codec; device-originated
transfer messages are rejected. Both directions represent upload-session UUIDs
as exact 16-byte fields and missing sequences as one packed little-endian u32
byte field; decoded CONFIRM exposes `owner_revision` under its dedicated field.
The internal Apple mapper now exposes canonical WINDOW_ACK/CONFIRM encoding and
typed DATA, WINDOW_END, MANIFEST_CHUNK, EOF, and ERROR decoding through that
shared Rust boundary. A bounded internal receiver now writes DATA directly by
offset to a protected native file, retains only packet metadata and the fixed
580-byte manifest, validates resume-prefix truncation and final evidence,
selectively requests exact gaps, and refuses to produce a clean WINDOW_ACK
until the matching native checkpoint sidecar, including the highest contiguous
sequence needed for exact EOF validation after resume, is reported persisted.
An internal transfer host now connects it to the retained `0409` stream for
START/RESUME, DATA/window repair, manifest, EOF, abort, protected ciphertext
file writes, and recoverable native checkpoint sidecars. The host emits
structured `WINDOW_STAGED` evidence to Rust and sends only Rust-encoded
ACK/repair frames through the exact owned transport session. Its phase-aware
notification queue is capped at 1 MiB, premature post-window traffic fails
closed, START/ABORT races cannot resurrect ownership, and checkpoint
replacement or deletion flushes the file and parent directory before success.
Optional internal completion services bind START to the prepared authorization,
pin its exact material-registration lease, pass the verified opaque file to
staging before submitting the fixed manifest, and await the exact backend
receipt. Before receipt delivery or canonical CONFIRM, the host durably removes
its local ciphertext and checkpoint; a cleanup failure leaves the device copy
intact. Cancellation routing owns the task before entering the asynchronous v2
host callback. The live control actor writes CONFIRM only for the claimed
transport session and then releases its `0409` subscription. Once CONFIRM is
written, later cancellation or subscription-cleanup uncertainty cannot reverse
the confirmed result; uncertain cleanup poisons BLE ownership until reconnect.
Production configuration installs this host with the signed-blob writer,
transfer-control owner, material registry, and native file upload service.
`RecordingManager.syncEncryptedRecordingV2` reads `0406` fresh and gathers the
matching native checkpoint before its application-owned provider selects the
explicit v2 material. It owns cancellation before the first asynchronous read,
records cancellation through engine startup, cancels that exact Rust workflow
before it consumes output or performs non-success cleanup, and binds a
resume to the checkpoint's exact transport session, sink, and safe negotiated
bounds; it never infers or retries a legacy profile after that selection.
Cancellation cleanup claimed before an actor hop retains the original runtime
and executes even when the facade operation finishes first. Late cleanup must
not cancel or finish a replacement operation. Tests await the cleanup callback
separately from the cancelled caller's completion.
Apple's
serialized signed-blob writer uses the current CoreBluetooth
write-with-response limit capped at 512 bytes, subscribes to `0407` before
BEGIN, checks cancellation between writes, starts its RESULT timeout only after
COMMIT, and matches RESULT by both blob kind and `write_id`. It rejects
concurrent owners; failure cleanup is bounded and best-effort ABORTs plus
unsubscribes, with uncertain cleanup blocking another owner until a confirmed
disconnect. Apple's internal transfer-control actor also subscribes to
notify-only `0409` before sending Rust-encoded START or RESUME_REQUEST to
write-only `0408`. It fails closed on foreign-session traffic, requires exact
echoed identity, ciphertext, negotiated bounds, and checkpoint values on
successful replies, preserves the device checkpoint on RESUME_REJECT/ERROR,
and retains the live `0409` stream plus serialized owner for DATA/window/EOF.
Cancellation or explicit abort applies the same bounded ABORT/unsubscribe
ownership policy. Android now mirrors this boundary with coroutine ownership:
it reads `0406` fresh, sends only Rust-encoded signed documents and transfer
controls on `0407..0409`, writes bounded ciphertext windows directly through
`FileChannel`, and keeps exact resume metadata in `AtomicFile` sidecars. Its
OkHttp staging host replaces an application-provided empty HTTPS PUT template
with a streaming body for only the verified native ciphertext file, submits the
fixed manifest, awaits application finalization and an exact receipt, then sends
canonical CONFIRM. Production configuration installs both native ports after
application-owned selection. React Native now exposes an additive explicit v2
selection/progress workflow, but no bulk bytes or sensitive control-plane or
cryptographic material cross Codegen. Apple and Android consume that material
from a one-shot native `BotaDeviceSDKEncryptedUploadV2Materials` registration
selected by an opaque ID; existing JavaScript managers and events are
unchanged, with no implicit legacy fallback. The remaining firmware, release,
and hardware gates keep runtime support and firmware advertisement false.
The core now also exposes a side-effect-free three-profile selection validator:
it requires every batch capability bit, usable advertised bounds, and an
immutable recording generation in `bota_enc_v2` storage before accepting v2;
rejects either legacy
profile under `v2_required`; and accepts historical P10 only after its header
was observed. This validator emits no BLE, file, network, delete, or fallback
effect. The Apple provider contract is selected by the public manager entry,
which installs matching material and starts only the explicit v2 profile. A byte-free batch-v2
coordinator now drives the shipping reducer
and additive ABI contract: it persists each complete window before ACK,
truncates resume state to the last proven offset, exposes staging evidence,
and cannot emit CONFIRM until a native host reports receipt acceptance. It has
no legacy-fallback action. Apple production wiring provides the host's
transport, staging, receipt, and cancellation services; other native facades
remain outside this runtime milestone.

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
0.86's iOS 15.1 floor and resolves the exact matching `BotaAppSDK` release;
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

The draft [Encrypted Upload v2](../internal-docs/device/Encrypted-Upload-v2.md)
adds an explicit third workflow beside released plaintext v1 and historical
P10 compatibility. The core's pure validator now enforces the initial
policy/capability decision, including observed-P10 evidence, without selecting
or starting a workflow. Its separate deterministic batch coordinator defines
mixed-profile failure, proven-checkpoint resume, staging, and receipt-gated
CONFIRM without carrying ciphertext or cryptographic documents. Native hosts
stream opaque canonical ciphertext and the opaque upload manifest to staging
after their transport implementations are complete. Apple production
configuration installs the dedicated internal host port, while the public
manager obtains a fresh capability/checkpoint snapshot before the application
selects its v2 material. Its current completion metadata remains contract-only:
this Apple runtime work does not enable the broader release workflow or
firmware advertisement.

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
runtime submits the additive command set to Rust, drains all 47 effect and 16
notification kinds, and returns all 51 correlated host-event kinds with the
original request and 128-bit cancellation IDs. API-35 instrumentation verifies
the Android resource generated from all 33 canonical workflow scenarios. An
exhaustive `HostEffectExecutor` routes all 47 effects through separate BLE,
persistence, secure-storage, network, material, recording-sink, firmware-blob,
and Encrypted Upload v2 ports. It owns timers, bounds returned bytes, permits
multi-event streams only where the ABI does, and rejects mismatched callbacks
before Rust sees them.
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
The dedicated Android Encrypted Upload v2 host reads `0406` immediately before
application profile selection, uses the Rust encoders for signed documents and
all `0408` transfer controls, and retains the exact `0409` subscription for
START, repair, manifest, and EOF. Its receiver writes DATA by offset into a
bounded `FileChannel`, forces each staged window before persisting the matching
non-secret `AtomicFile` checkpoint, and resumes only from mutually proven
identity, bounds, offset, sequence, and prefix-hash metadata. The application
provides an empty HTTPS PUT template, fixed-manifest submission, finalization,
and receipt callbacks; the OkHttp host streams only the verified native
ciphertext file. Canonical CONFIRM is written only after the receipt digest
matches, and every earlier failure or cancellation retains the device copy.
`RecordingManager.syncEncryptedRecordingV2` starts only command `0x010c` and
never falls back to a legacy transfer after selection.
Host-owned cancellation while START is awaiting the transport opening returns
the stable code-16 cancellation result; cancellation of the caller coroutine
still propagates as coroutine cancellation.
The `0409` collector is attached before START and the platform plus transfer
queues share a one-MiB byte budget. Overflow, phase-invalid repair traffic,
mixed-profile framing, and pre-EOF completion fail closed. Checkpoint metadata
and recording lookup identity live in one AtomicFile catalog whose file and
parent directory are synced. Transfer and signed-document cleanup is bounded;
an unproven unsubscribe, ABORT, or post-CONFIRM outcome poisons the owner until
the exact current peripheral/GATT-generation confirmed disconnect. Once the
CONFIRM write succeeds, its evidence reaches host state before the transfer
  owner is released. Disconnect reset installs the host replacement barrier,
  removes the exact control/writer owners under the DeviceRuntime mutex, then
  leaves that mutex before it waits for settlement. It detaches and fails the
  old generation's channels and joins its opening and pump jobs before new
  ownership can start. Once the write is attempted, cancellation never
sends ABORT or reports ordinary cancellation. Physical power-loss durability
and physical-device interoperability remain unverified gates.
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
The clean consumer resolves only `dev.bota:bota-app-sdk`; coroutine and
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
preserved bytes as a fresh deployment. Publication is claimed only after all
30 public Maven file URLs match the signed inventory and unrelated API 26 and
API 35 consumers run it. When Central serves an HTML directory index, the
verifier also rejects missing or extra entries; an absent index is not
evidence that the published files are absent.

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
numeric request/cancellation identity. UniFFI `0.32.1` remains a non-shipping
comparison spike only. The shipping boundary uses versioned typed field-list
packets; the JSON smoke envelope remains comparison tooling and is not a public
serialization contract. The Apple, Android, and React Native facades are
published for `v1.1.0`; the remaining planned facades are not yet published. See
[`ADR 0001`](docs/adr/0001-command-event-host-boundary.md) and the
[`FFI evaluation`](docs/spikes/ffi-boundary-evaluation.md).

Main CI always runs the complete Flutter source, package, and fresh-consumer
verification. For occupied beta.0, it withholds the Flutter release directory
and emits a transitional four-platform inventory that must not be tagged. For
selected beta.1, the same CI path adds Flutter and produces the taggable
five-platform inventory from one source revision. An annotated tag records that
inventory digest. The tag workflow downloads the CI inventory, compares its
native subset before any publication, publishes and verifies the immutable
Apple asset and CocoaPod, runs clean public SwiftPM, CocoaPods, and Maven
consumers, then rebuilds and compares the Flutter
subset. The first pub.dev version pauses for a protected clean-tag interactive
bootstrap; later betas wait for the ordered Flutter artifact before invoking
Dart's OIDC reusable workflow. Public archive normalization and per-file hashes
must match before synchronized release completion.

The shipping ABI implementation lives in `bindings/device-sdk-ffi` and exports
only versioned `bota_device_sdk_v1_*` symbols. Its opaque engine lifecycle and
structured error ownership are frozen. All released core workflow commands,
plus the contract-only Encrypted Upload v2 command, enter through
`bota_device_sdk_v1_engine_start`, use stable numeric field and
capability IDs, reject unknown or duplicate fields, and retain the core's model
validation. Every current host effect and workflow notification leaves through
the ordered `bota_device_sdk_v1_engine_poll_output` queue as one explicitly
freed packet. Durable checkpoints are versioned opaque bytes to native storage,
not platform-visible reducer models. All current BLE, timer, persistence,
host-material, recording-sink, firmware-blob, secure-storage, and network
callbacks return through `bota_device_sdk_v1_engine_dispatch`; the additive v2
surface carries only identifiers, bounds, opaque registration IDs, checkpoint
metadata, and digests—not ciphertext or cryptographic documents. Operation,
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
against the checked-in checksum before exposing product `BotaAppSDK`.
Release packaging rewrites Xcode-generated XCFramework metadata into one
canonical plist so archives built by supported Xcode versions have identical
container metadata and checksums.
The CocoaPods release asset is a separate deterministic, checksummed archive
containing that XCFramework and the same Swift facade sources. Its podspec uses
an HTTP source with the archive digest and no `prepare_command`: Trunk forbids
install-time scripts in new pods. Beta.7 published the SwiftPM asset but could
not bootstrap the first CocoaPod, so the synchronized Flutter release remained
incomplete. Beta.8 is the script-free replacement.
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

The public Flutter package is `frameworks/flutter/bota_app_sdk`. One
`BotaDeviceClient` and `PigeonBotaPlatform` belong to each Flutter engine. Dart
exposes immutable device, settings, recording, WiFi, OTA, security, and error
values through manager APIs; it does not own Bluetooth, network requests,
recording or firmware bodies, workflow checkpoints, or reducer decisions.
Pigeon carries bounded commands, typed progress, native file paths, and
request-bound application callback results. Operation, subscription, and
callback ownership is removed before terminal completion, and destroy is
terminal and idempotent.

Native SDK failures retain their typed error details. Adapter-only failures use
an exhaustive sanitized projection from native outer bridge codes to stable
Dart error codes while preserving the operation selected by the public Dart
call. Unknown outer codes fail closed and native message/detail text is never a
public branching surface.

The application supplies provisioning material, factory-reset grants, durable
reset-result persistence, and firmware sources through one-shot callbacks.
WiFi and deprovision grants remain exact command inputs. These values may cross
their request-bound method but never appear in event streams, checkpoints, or
logs. Batch recording transfer returns a native file path and retains the
device copy until application upload succeeds and the exact confirmation is
sent. Native live-audio streaming and Flutter Web, macOS, Windows, and Linux
targets are not supported.

Flutter conformance discovers every canonical JSON workflow suite at test time,
routes the 29 Flutter-supported scenarios through a fake host implementation,
and explicitly classifies the four Encrypted Upload v2 scenarios as
unsupported. The fake emits only each fixture's already-decided typed outcome;
Rust remains the sole workflow reducer. Release-consumer verification generates
a complete fresh iOS/Android Flutter application, copies in the maintained
example and platform permissions, rebuilds local native artifacts, reserves
the `dev.bota` Maven group for the fresh local candidate, resolves the local
Apple package, and requires new release outputs. The temporary consumer and its
isolated Gradle cache are deleted after each run, so stale application outputs
cannot satisfy the gate.

The Flutter Android plugin delegates every generated Pigeon host operation,
stream, and callback to `BotaDeviceClient.shared`; it does not duplicate native
Bluetooth or workflow behavior. Each engine owns a `SupervisorJob` on the
Android main dispatcher plus private discovered/connected handle registries.
A process-wide coordinator serializes shared-client configuration and owns each
native operation category by engine. One-shot and stream-start work is
registered before suspension, and detach rejects callbacks once, cancels and
awaits its work, and clears only that engine's registries. Failed native stop
keeps the category unavailable until native terminal cleanup or destruction of
the final shared-client lease; collector completion and a returned but
uninstalled `Flow` are not cleanup evidence.

The Android plugin build reads the exact version from its packaged
`android/sdk-version.toml`, resolved from the plugin project rather than the
consumer build root. Package verification requires that copy to match the root
`sdk-version.toml`; the build rejects a different Gradle override, requires API
26 or newer, and resolves `dev.bota:bota-app-sdk:<version>`. Local adapter
tests publish the same native Android artifact into the repository test Maven
directory and configure the plugin from a temporary consumer root before
compiling it. The consumable plugin does not declare AGP or Kotlin versions in
its own project because the Flutter application owns that classpath; standalone
package and adapter-test settings pin AGP 8.13.2 and Kotlin 2.1.20. Its build
uses the public Android `LibraryExtension` and Kotlin compiler-options APIs so
the same source compiles in the pinned toolchain and the newer toolchain emitted
by the pinned Flutter application template.

`CoreEngineActor` is the single Swift workflow executor. It submits all ten
typed command shapes to Rust, establishes the ABI workflow owner before it
returns a notification stream, and drains the initial ABI queue through native
host-effect registration before that return. It continues draining notifications
and host effects in order, dispatches correlated host completions before polling
again, and keeps the active cancellation identity until a terminal notification.
Cancellation reaches that ABI owner before native host cancellation begins, so
an immediate cancellation cannot be followed by registration of a queued start
effect. Unexpected stale host events are rejected by Rust without releasing the
current owner. The
compact SwiftPM workflow resource is generated from all eight canonical suites;
package tests reject drift and cover all 33 scenario labels. Concrete native
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
never used as device identity. Direct read/write continuations use an exact-once
cancellation state machine so task cancellation wins safely before or after
registration and late delegate callbacks cannot resume cancelled callers. A
cancelled characteristic key rejects new requests until an unambiguous stale
callback is discarded or disconnect clears its quarantine. When that
characteristic also carries notifications, callbacks continue to the live
subscriber and cannot clear read quarantine. Cancellation removes and
quarantines a registered request on the CoreBluetooth queue before changing its
continuation state, eliminating the dequeue-to-resolution gap. The
per-peripheral serialization gate has an explicit pre-registration granted
state, so handoff cannot discard a waiter during its executor hop; cancellation
after handoff is observed by the serialized operation and releases that exact
ownership without entering the driver.

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
URL and imports only `BotaAppSDK`, using bounded compiler parallelism on the
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

## Web facade

`frameworks/web` is a publishable ESM facade over the private
`bindings/device-sdk-wasm` bridge. Browser code owns Web Bluetooth lifecycle;
the WASM core owns exact connection sequencing and protocol decoding.
`BotaDeviceClient` composes exactly one shared runtime, one operation
coordinator, and one instance of each public foreground manager. Read-only
construction needs neither storage nor providers. Durable construction uses a
non-empty tenant `storageNamespace`; a caller-provided storage adapter must
report that exact namespace, otherwise creation fails before browser or device
work. Manager names are root-exported as instance types only: operational
construction remains client-owned, and applications use `client.devices`,
`client.recordings`, `client.provisioning`, `client.wifi`, `client.controls`,
`client.ota`, and `client.logs`.

Picker connection has two explicit paths. `connect({ expectedSerialNumber })`
requires an exact match to a known application device record. The beta.2 candidate
`connectSelected()` addition (not in published `2.0.0-beta.1`) opens the same
picker and uses Rust's existing `ConnectSelected` workflow to learn a fresh
Device Information serial before the application registers or binds the device.
It neither registers nor provisions automatically. The advertised name remains
only a picker filter and display value. Both paths retain the same lifecycle
ownership and persist only a successfully read identity; reconnect always
requires the expected serial. Every
snapshot reads and verifies that serial again, then returns optional model,
hardware, and firmware identity, decoded device status, and a fresh decoded
encrypted-upload-v2 capability value when characteristic `0406` exists.
If client destruction races an open picker, the eventual picker result is
rejected as cancelled before it can become the active device or start GATT
work. If destruction races later connection work, the captured device is
disconnected and cannot be published by a late workflow completion.
Client destruction marks every manager terminal before awaiting cleanup. It
joins non-cancellable picker and verified-device-hint loads before resolving;
late results cannot publish a connection or start GATT ownership, and a late
picker device is cleaned up. It then cancels and joins every non-device direct
or workflow owner and removes passive subscriptions and leases before the one
final device disconnect. Tenant cleanup runs only through
`clearPersistedData()`: it requires no active coordinator owner, performs no
BLE command, and remains safe and repeatable after destroy for logout ordering.
Teardown uses exhaustive joins rather than fail-fast aggregation. Failure
precedence is deterministic: manager cleanup in client declaration order,
runtime teardown, then final disconnect. The first failure is normalized to a
stable public SDK error only after every initiated stage settles.

Foreground firmware update is exposed through the client's `OTAManager`. The
application resolves stable image identity to a fresh HTTPS request, while the
browser host streams bounded chunks directly to OPFS and incrementally verifies
exact length, SHA-256, and CRC32 before Rust may write GATT. Only stable image
identity and workflow checkpoints are durable; request URLs and headers remain
memory-only. An update or non-reconnecting active resume from a live connection
freshly re-verifies the exact active Device Information serial before provider,
journal mutation, or OTA GATT. Cleanup-only recovery remains local and BLE-free.
A compatible verified blob can be reused after reload, while an
incomplete blob restarts from byte zero with a freshly resolved request.

Rust owns OTA transfer, device status handling, verification, reboot, reconnect,
and public workflow errors. Reboot recovery requires authorized-device
enumeration and filters it to the exact browser device ID captured by the
verified connection. Cancellation retains mutation ownership until provider,
fetch, OPFS, GATT, subscription, and timer work settles, then reconciles the
latest durable journal so a compatible verified artifact remains recoverable.
Generic workflow-host operations, including checkpoint load/save/delete, also
remain joined before ownership release. Fresh-page recovery for download,
transfer, and verify phases establishes the same exact authorized connection
and re-verifies serial before OTA GATT. Before Rust's terminal checkpoint delete,
the persistence host durably advances the optional firmware-journal `state` from
`active` to the one-way `cleanup_only` value; any reload from that state performs
only idempotent checkpoint, blob, and journal cleanup.

`LogManager.subscribe()` starts the Rust `ReadDeviceLogs` workflow and resolves
only after subscribe-before-START setup reaches a running state. One exact
workflow owner and diagnostics-characteristic lease cover the stream. TypeScript
maps only Rust `DeviceLog` notifications to public `{ message, isBacklog }`
values; raw packets and decoder details never reach application callbacks.
The manager freshly re-verifies the active Device Information serial before it
claims the diagnostics lease; it never opens the picker or probes by name.
Canonical undersized packets are ignored by Rust without resetting decoder
sequence state, allowing later valid packets to decode normally; genuine Rust,
bridge, and runtime failures remain sanitized. Synchronous listener throws and
rejected promise-like listener results both disable delivery and cancel the
exact workflow.
Removal, listener failure, disconnect, and client destruction join initiated
subscription setup and GATT writes before releasing the lease. A stream that
completes without cancellation is classified as a retryable connection failure.

The foreground surface also includes exact authorized-device reconnect;
recording list and legacy or freshly advertised encrypted-upload-v2 sync;
provisioning and remove-only deprovisioning; connection settings; WiFi scan,
configuration, disconnect, status, and status subscription; grant-bound
recording start/stop; and durable OTA and log workflows described above. The
shared runtime serializes mutating GATT ownership. Recording and firmware bodies
stay in OPFS, while IndexedDB stores tenant-scoped journals and checkpoints.
Host providers own provisioning material, object-storage destinations and
cloud completion, recording-control authority, and firmware download
resolution. Their credentials and operation material remain memory-only.

This release is foreground-only and requires a secure-context browser with Web
Bluetooth. It does not provide automatic or background scan, service-worker or
closed-tab Bluetooth, live recording streaming, authenticated destructive
factory reset, Safari/iOS fallback, a Bluetooth polyfill, Flutter Web, Windows,
or a built-in Bota API client. The host application continues to own
authentication and every backend API call. Browser permission is not device
identity or backend authorization, and unsupported optional capabilities fail
before device mutation.

The Web release gate creates one npm tarball and inspects its archive headers
and bounded regular-file payloads exactly once without extraction. That pass
creates a checksum-bound inventory. The Vite consumer installs only the same
local artifact; the browser stage validates the original inventory, source
revision, tarball hash, and installed regular-file hashes without parsing the
archive again before the production ESM/WASM Chromium cases run. CI then
preserves the tarball and inventory unchanged for protected beta publication.
The supervised Chromium/device matrix in
`docs/testing/web-physical-device.md` is a separate release gate. Automated
Chromium cases use deterministic fake Bluetooth and cannot satisfy it. For
`1.2.0-beta.7` and the CocoaPods repairs `1.2.0-beta.8`, `1.2.0-beta.9`, and
`1.2.0-beta.12`, the release owner
requested beta publication before the
supervised production-device test; physical acceptance remains open.

## Security

- Never commit credentials, tokens, private keys, certificate bodies, signing
  material, or production endpoint secrets.
- Device identity is never inferred from the advertised BLE name alone.
- Factory reset is complete only after the authenticated physical-device receipt
  closes the backend command.
- Recording content stays encrypted according to the selected product security
  mode; the App SDK does not receive backend decryption private keys.
