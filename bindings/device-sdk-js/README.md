# Private Rust runtime bridge for generated JavaScript

This source crate runs the existing `device-sdk-core::WorkflowEngine`. It is
intended to compile to an MVP-compatible wasm32 module and then to executable
JavaScript through Binaryen. It has no wasm-bindgen dependency, JS reference
imports, host-native calls, or exported 64-bit arguments/results. Compilation,
conversion, Hermes qualification and app OTA delivery require their own evidence.

The bridge exposes every current core command: discovery, selected/exact
connection, reconnect, provisioning, legacy/v2 recording transfer, streaming,
upload handoff, firmware update, device logs, authenticated reset and reset receipt
recovery. This does not imply every consuming host supplies those capabilities.
The supplied capability set is checked by the shared core before workflow start.

## Memory ABI version 1

All exported arguments and results are `u32`. Zero is an invalid handle.

| Export | Result |
| --- | --- |
| `bota_js_abi_version()` | `1` |
| `bota_js_buffer_alloc(length)` | Owned zero-filled buffer handle, or `0` |
| `bota_js_buffer_ptr(handle)` | Borrowed wasm32 linear-memory address, or `0` |
| `bota_js_buffer_len(handle)` | Registered byte length, or `0` |
| `bota_js_buffer_free(handle)` | `0` on success; `1` for absent/unavailable |
| `bota_js_engine_new()` | Owned engine handle, or `0` |
| `bota_js_engine_free(handle)` | `0` on success; `1` for absent/unavailable |
| `bota_js_rpc(engine, input_buffer)` | Owned output buffer handle, or `0` |

Callers copy input JSON into a registered allocation, call RPC, copy its result,
and free both allocations. Rust accepts handles only and never reconstructs
ownership from caller-supplied pointers. Handles increase monotonically and never
reuse. Re-read the memory buffer after operations that can grow linear memory.
`buffer_ptr` returns zero in native unit tests; tests inspect the safe registry.
The memory consumer itself is trusted; untrusted data enters through bounded RPC.

The registry allows 16 engines, 128 buffers, one MiB per message/buffer and eight
MiB of live buffers. RPC reserves worst-case output capacity before changing the
reducer. Workflow RPCs have an additional 64 KiB callback bound; bulk bodies
belong to host files. Engines allow 256 pending callbacks and 16 instances of each stateful
decoder/hasher kind. Incomplete log lines are bounded to 64 KiB. A build-time
maximum linear-memory setting must also bound the generated runtime's total heap;
registry limits do not replace a linear-memory ceiling.

## JSON RPC

Every request has `version: 1` and one `action`. Core enums keep their existing
externally tagged serde representation and snake_case fields. Every typed `u64`
and `i64` serializes as a canonical decimal string; input accepts those strings
or integers within JavaScript's exact range. `u32` and smaller integers remain
numbers. Bytes use arrays of numbers. Errors use stable snake_case code/operation
names and preserve retryability and optional protocol status.

```json
{
  "version": 1,
  "action": "start",
  "generation": "1",
  "operation": "Discover",
  "cancellation_id": [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
  "command": {"DiscoverDevices": {"timeout_ms": "5000", "allow_duplicates": false}},
  "capabilities": ["Ble", "Timer"]
}
```

`start` advances the workflow generation. Its optional `operation` must match the
command. `dispatch` contains exact `generation`, `operation`, `cancellation_id`
and an `event` with the originating `request_id` and `HostEventKind`. The bridge
checks all owner fields, pending request, event family and resource identity before
calling Rust. It also preserves the core's own request/phase validation. Cancelled
timers and unsubscribed streams release their obsolete callback owners.

`cancel` supplies the same exact owner fields. `status` supplies only version and
action. Success is `{"ok":true,"result":{"generation":"1","effects":[],"status":"Idle"}}`;
failure is `{"ok":false,"error":{"code":"invalid_input","operation":"validate","retryable":false,"detail":"..."}}`.
Workflow notifications remain ordinary shared-core `Notify` effects.

Codec RPC is `{"version":1,"action":"codec","codec":"encodeTimeSync","input":{"epochMilliseconds":"1700000000123","timezoneOffsetMinutes":0}}`.
It requires an allocated engine; decoder state belongs to that engine. Successful
codec output is the `result` directly, rather than a workflow envelope.

## Codecs and hosts

Canonical codecs cover status, settings, WiFi, recording control/list/transfer,
OTA/ACK, deprovision/reset results, encrypted-v2 framing/signed-blob/status/context,
markers, logs, diagnostics and incremental SHA-256/CRC32. Public RN DTO mapping is
performed in Rust. GATT UUID metadata references generated core constants. The
RN control host's 50 ms stop delay and 30-second timeout are provided as metadata.
The bridge's codec DTO normalization is separate from wire construction/parsing,
which always invokes the shared Rust protocol functions.

Private host helpers keep admission, reply acceptance and effect planning in
Rust: `planEncryptedUploadV2Opening`, `acceptEncryptedUploadV2Opening`,
`planEncryptedUploadV2SignedBlob`, `acceptEncryptedUploadV2SignedBlobResult`,
`planEncryptedUploadV2Confirm`, `acceptEncryptedUploadV2Confirm`,
`planEncryptedUploadV2Abort`, `initialEncryptedUploadV2ReceiverCheckpoint`,
`validateEncryptedUploadV2Authorization`, `validateEncryptedUploadV2Receipt`,
`acceptUploadContextSnapshot`, and `encryptedUploadV2Failure`. Inputs use
camelCase wrapper fields around the unchanged snake_case core request and
checkpoint DTOs. Digests are 32-byte arrays. Ordinary and marked authorization
digests cover the first 408 bytes; receipt digests cover the first 336 bytes.
Signed-document planning uses the shared codec's exact profile lengths and
the negotiated single-frame and blob limits. Context metadata supplies the
existing 30-second deadline and 150 ms poll interval.

`validateFactoryResetGrant` checks canonical base64, the dedicated 179-byte
envelope and its exact nonzero u32BE binding generation.
`validateFactoryResetJournal` admits only an exact serial, command and generation
with a successful durable result. An absent journal returns null; a different
generation throws identity mismatch without deleting or modifying the journal.
Streaming helpers
`encodeStreamingRelayChunk`, `streamingAcceptedUnits`, and
`streamingUploadPolicy` preserve the initial public-key/salt header, tag-excluded
accepted units, three attempts with 50/100 ms delays and allowed encrypted gaps
after sequence zero. These preserve the existing relay policy; they do not
implement a new protected streaming profile.

`planEncryptedUploadV2Request` normalizes the Native recording/decision DTOs,
enforces admission and negotiated frame limits, and restores an exact optional
checkpoint's transport, sink and window metadata. `nativeEncryptedUploadV2Capability`
returns validated capability bytes/digest metadata. `nativeEncryptedUploadV2Checkpoint`
requires the exact persistence `scope`, journal and receiver-checkpoint agreement;
it proves no file existence. The host separately opens the logical sink and
executes the receiver's durable prefix proof. `planEncryptedUploadV2Catalog`
starts with marked LIST and permits one unmarked retry after only the existing
exact protocol rejection. `mergePendingRecordings` preserves encrypted-first
ordering and rejects colliding legacy aliases.

`reduceManagedUpload` invokes the shared managed-upload reducer. Its codec result
is `{value}` on success or `{error:{code}}` with the exact `BOTA_UPLOAD_*` policy
error on failure. Public HTTP numbers remain numbers, byte lengths and durable
evidence retain decimal strings, and planned HTTP bodies remain JSON text.
`subscriptionStartupPolicy` admits notifications before subscription confirmation
only for the firmware-held `ResumeFactoryReset` result replay.

Encrypted-v2 catalog decoding uses the shared exact-session CatalogDecoder;
empty bytes establish its session, END or an error consumes it, and explicit
reset releases its decoder. Checkpoint normalization runs the shared coordinator's
real acceptance policy. Host identity validation checks an effect against its
registered request; it does not replace receipt verification or transport fencing.
Large completed catalogs whose JSON exceeds one MiB return a bounded error.

OS BLE, durable files/checkpoints, secure storage, entropy, application HTTP and
lifecycle scheduling remain supplied by host primitives. This crate performs no
OS effects and does not delegate to the high-level installed native SDK. Core
v2 `StartTransfer`, repair, receipt and confirmation effects still require a
conforming host receiver; a frame decoder alone is not that receiver.

The bridge exposes the shared Rust `EncryptedUploadV2Receiver` through
`createEncryptedUploadV2Receiver`, `startEncryptedUploadV2Receiver`,
`receiveEncryptedUploadV2Receiver`, `applyEncryptedUploadV2Receiver`,
`checkpointEncryptedUploadV2Receiver`, `cancelEncryptedUploadV2Receiver`, and
`freeEncryptedUploadV2Receiver`. Creation takes `config` in core serde form and
returns an allocated numeric `receiverId`. Every other call supplies that exact
ID; receive adds `bytes`, apply adds the externally tagged core `event`. Actions
and checkpoints use core serde form and decimal 64-bit values. IDs never reuse;
16 receivers may be live per codec engine. The receiver decides repair, durable
checkpoint ordering, ACK and transport completion; ports only perform its exact
bounded I/O requests. Completion still requires backend receipt/CONFIRM.

Marked-list and marker-chunk DTOs use the existing canonical core frame codecs.
Their availability does not enable a marker profile or establish acceptance of
marker documents. `decodeRecordingList` returns the RN public recording DTO
directly; `decodeRecordingListWebDto` preserves the private Web-style DTO option.
Status `timestamp` retains the firmware wire timestamp. Optional host observation
times supplied to codec input do not redefine that existing public field.

The approved JS-first host profile allows bounded ciphertext and signed documents
inside SDK JavaScript. These bytes remain relay material: the device/backend
verify signatures and decrypt; this crate performs no private-key operations.
Document admission checks visible framing, request identity and hashes and
conveys no cryptographic authenticity, trusted binding generation or time.
There is no CONFIRM_ACK: its receive helper returns no positive confirmation.
The host settles the exact awaited GATT write and subscription cleanup and
preserves uncertain ownership after an attempted write failure. No fabricated
credentials, acknowledgements, checksums or receipts replace actual callbacks.
Native background execution requires its separate lifecycle integration.

## Verification

Unit tests exercise the real core effect output, malformed input/newtype rejection,
exact callback ownership, safe integer round trips, stateful log bounds and memory
handle lifecycle. Codec tests compare outputs against canonical Rust encoders.
Run `cargo test -p bota-device-sdk-js` and the repository's generated-JS equivalence
and consuming-host gates. Native, converted JS and physical tests are distinct.
The native-only `js-trace` binary reads newline-delimited JSON through one
`TraceEngine` and writes exact RPC responses. The conversion gate can compare
these responses against generated JavaScript for the same entire trace, instead
of checking a hard-coded snapshot of selected initial effects.

Local source checks passed: 32 crate tests, scoped rustfmt and Clippy with
warnings denied. The native trace CLI also returned exact responses for idle
status, canonical time-sync bytes and a generation of `18446744073709551615`.
Converted-JS, consuming-host and hardware evidence belongs to the owning
integration review rather than these native-only results.

## Source design review

Reviewed against the owner's Rust-to-JavaScript migration request and the current
Rust core command/effect contracts; native ABI v1 is unchanged.

| Requirement | Evidence | Status |
| --- | --- | --- |
| Rust remains workflow behavior source | Direct WorkflowEngine invocation; all 13 command initial effects compared against core | matched |
| Raw bridge avoids JS references and native facade calls | u32-only exports; bounded registry; no wasm-bindgen or host imports | matched |
| Exact callback ownership and cancellation | Generation, operation, cancellation, pending request, effect-family/resource validation tests | matched |
| Untrusted JSON/newtype safety | Envelope validation, validating constructors, bounded bytes, numeric round-trip/rejection tests | matched |
| Canonical protocol bytes | Shared codec functions; frozen OTA golden fixture comparisons | matched |
| Durable v2 checkpoint identity and catalog ownership | Actual coordinator checkpoint acceptance; exact-session CatalogDecoder tests | matched |
| Shared v2 receiver policy | Canonical receiver bindings and exact I/O/cancellation/retired-handle tests | matched |
| Rust-owned host plans and reply admission | Opening/receipt identity, canonical signed-document vectors, exact status/context tests | matched |
| Rust-owned managed upload, catalog and compatibility DTO policy | Direct managed reducer parity; scoped checkpoint, negotiated request and exact marked fallback tests | matched |
| Approved bounded JS relay profile | Ciphertext/signed blobs permitted internally; device/backend cryptographic authority preserved | matched |
| Complete consuming v2/streaming runtime | Host integration and managed material callbacks require owning integration evidence | partial |
| Generated JS equivalence, Hermes and app OTA delivery | Owning tooling/host integration gates and consuming-app acceptance required | unverified |
| Background execution and physical-device parity | Requires lifecycle integration and separately recorded hardware evidence | unverified |
