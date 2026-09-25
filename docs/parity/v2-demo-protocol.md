# Demo v2 Protocol Prerequisites

Scope: deterministic Rust codecs and additive C ABI v1 contracts against
maintenance reference `318974f925a573cf04b0d624978bee04784af09b`, specifically
`encryptedUploadV2Context.ts`, authorization identity decoding in
`encryptedUploadV2.ts`, and `ProtocolHandler.listEncryptedUploadV2Recordings`.
Implementation and local verification are complete. Runtime metadata stays
contract-only; this is not firmware, hardware, or publication acceptance.

## Native Contract

All calls use the existing protocol encode/decode entry points, ABI version 1,
zero operation/request/cancellation/reserved fields, and existing packet
ownership rules. Inputs are borrowed during the call; successful output is
owned until exactly one packet free. Unknown, duplicate or mistyped input
fields fail. There is no JSON, base64, audio, HTTP, crypto or trusted-time API.

Existing `0x0522` exposes complete ENTRY/END metadata. `0x0523` adds signed-blob
kinds 3 (196-byte challenge) and 4 (264-byte result). `0x0524` LIST is unchanged.

| Kind | Direction | Input | Output |
| --- | --- | --- | --- |
| `0x0527` | decode catalog | session 128 unsigned, VALUE 30 bytes | Empty for reset/ENTRY; complete validated catalog at END |
| `0x0528` | encode context BEGIN | attempt 199 unsigned, nonzero u32 | VALUE 30, eight bytes |
| `0x0529` | decode context snapshot | VALUE 30 bytes | attempt 199, state 200, result 24 unsigned; PAYLOAD 33 bytes |
| `0x052a` | validate context document shape | kind 151 unsigned (3/4), VALUE 30 bytes | kind 151, length 150 unsigned |
| `0x052b` | decode authorization identity | VALUE 30 bytes, exact 408-byte document | Typed structural identity below |
| `0x052c` | validate admission capability | VALUE 30 bytes, recovery 204 BOOL | Same capability fields as `0x0520` |

New field IDs: 199 CONTEXT_ATTEMPT_ID, 200 CONTEXT_STATE,
201 AUTHORIZATION_CHANNELS, 202 MIN_CIPHERTEXT_LENGTH,
203 MAX_CIPHERTEXT_LENGTH, 204 REQUIRE_EXPIRED_SESSION_RECOVERY.

Catalog reset uses empty VALUE and a nonzero expected transport session before
LIST. Exactly one catalog belongs to each engine. END emits prefix session128,
count85, revision148, digest123 (BYTES32), then ordered repeated entry groups:
UUID13 (canonical UTF8), generation129, storage147, completion146,
timestamp68 (u64 Unix seconds), duration149 (u32 seconds), plaintext131 (u64),
ciphertext130 (u64), hash144 (BYTES32). Other fields are UNSIGNED. Do not flatten
repeated entry fields into a map. Preserve u64 precision; native date conversion
must check its representable range rather than wrapping seconds times 1000.

The catalog hashes each exact ENTRY body after its 12-byte common header,
incrementally in arrival order, and checks END count and SHA-256. The bound is
4096 entries; no raw entry bodies are retained. Foreign session, malformed or
unexpected frame, duplicate identity, excessive entries or bad END fails and
clears the catalog. END consumes the owner. Reset also clears it. Native owns
subscription lifecycle, rejects late callbacks, and resets on cancellation and
disconnect; a reset alone cannot fence old notifications with a reused ID.

Snapshot is a complete read, not a header-only notification hint. It validates
state0..4, attempt, result/state agreement, exact length, nonce16 nonzero and
opaque proof116..366. Native bounds polling and the entire exchange to 30s,
correlates attempts, and reacquires context before authorization and first
receipt. The shape validator checks only magic/version/declared/exact length,
matching the reference; signatures, claims and time are never trusted here.

Authorization output: profile154, storage147, policy167, channels201, flags69,
owner165, generation129, min202/max203 lengths, session132 (BYTES16),
recording13 (canonical UTF8), ciphertext hash144 (BYTES32). Other fields are
UNSIGNED. This is structural extraction, not authorization verification.
Native compares these fields with the selected recording/material and retained
owner. Replacement requires flag8, explicit recovery capability, different
session and greater owner revision; failed admission preserves old checkpoint.
Historical core checkpoints do not contain ciphertext length/hash. The codec
cannot reconstruct that missing evidence or authorize a replacement from it;
native persistence and migration must handle this explicitly and fail closed
when required historical evidence is unavailable.

Capability decoder `0x0520` recognizes only mask `0x3ff`, including context bit8
and recovery bit9, and retains structural readiness reads with flags0. The new
admission validator requires `0x17f`, or `0x37f` for recovery, plus the same
usable bounds. Missing capability never authorizes quiet legacy fallback.
The existing batch workflow's `0x7f` subset check is unchanged, so it accepts
the new masks without invalidating historical workflow fixtures. New native
admission must call `0x052c`; the older workflow check alone does not establish
upload-context readiness.

## Core API

Exports from `bota_device_sdk_core::protocol`:

- `EncryptedUploadV2CatalogDecoder::default()`, `push(session, bytes)` and
  `reset()`. `push` returns `Result<Option<EncryptedUploadV2Catalog>,
  DeviceSdkError>`; the complete catalog contains session, revision, digest
  and typed `RecordingEntryV2` entries.
- `encode_upload_context_begin(attempt_id: u32)` returns the canonical bytes.
- `decode_upload_context_snapshot(bytes)` returns `UploadContextSnapshot`
  with a borrowed payload, avoiding another copy at the core boundary.
- `decode_upload_context_document(kind, bytes)` returns the borrowed,
  shape-checked opaque document, not verified claims.
- `decode_encrypted_upload_v2_authorization_identity(bytes)` returns
  `EncryptedUploadV2AuthorizationIdentity`, structural metadata only.
- `validate_encrypted_upload_v2_admission(bytes, require_recovery)` returns
  the existing typed capabilities or an error; no effects are emitted.

All malformed catalog frames and envelopes reset pending state and publish no
partial catalog. ABI failures return null output and the existing structured
error. Catalog failures use `ProtocolRejected`; missing admission features use
`UnsupportedCapability`. Unsupported ABI version returns `UnsupportedAbi` and
also clears the catalog. Core catalog entries plus duplicate-identity tracking
are bounded to 4096; SHA-256 is incremental, not a concatenated wire buffer.
ABI VALUE length is checked before copying catalog, context and document input.

Native owns subscribe-before-LIST on `040B` and the separate LIST-error stream
on `0409`. Decode an ERROR using existing `0x0522`, correlate transport and
failed-message identity, then reset the catalog. This assembler does not own
BLE subscriptions or pretend a transport read completed successfully.

## Verification

Verified locally with Rust 1.98.0 on 2026-09-24:

```sh
cargo test --workspace
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo fmt --all -- --check
cargo xtask protocol generate --check
cargo xtask encrypted-upload-v2 vectors generate --check
shasum -a 256 -c bindings/device-sdk-ffi/bota_device_sdk.h.sha256
tools/ffi-smoke/run-native-c-smoke.sh
tools/ffi-smoke/run-native-swift-smoke.sh
git diff --check
```

All exited zero. The final workspace run includes three new core catalog tests
and eleven new ABI tests. Initial ABI red evidence was five failing
missing-feature tests, while the pre-existing complete `0x0522` metadata test
passed. The catalog's new API also failed to compile before implementation.
Green coverage includes ordered digest computation, 4096-entry capacity,
duplicate/session/count/hash rejection, reset and terminal consumption,
engine isolation, malformed ABI envelopes, full-width metadata, fixed document
shape, context state/length/nonce validation, all signed-blob frame families for
kinds3/4, and missing/unknown capability bits. Literal allocation tests pin the
Rust constants and C header together.

The first workspace run found the older unknown-capability test used `0x100`;
it now tests `0x400`, since bits8/9 are deliberately recognized. Two Clippy
findings in the added code were fixed before the successful final checks.
The follow-up fixture review also corrected the canonical
`ble-capability-unknown-flag` vector from injected bit `0x100` to `0x400`.
A generator regression first reproduced the incorrect acceptance, then passed
with the corrected fixture. Canonical JSON, generated Rust digest, Apple and
Android resources and their test pins now share SHA-256
`71af9eb02c92ac694c51630d1cad2d7614db7d5d9435df0999d36bd1170d21af`.
No release-history fixtures or evidence were rewritten.
Current header SHA-256:
`b31c506ad67f74f63fd136d1a91d99fb16eb40438f0c52962096c29c26ce643e`.

Document-token searches covered internal/public docs and repository
AGENTS/ARCHITECTURE/README files. Parent and native owners received exact
packet/field allocations early, the checkpoint-evidence limitation, and the
final build-readiness signal. Broader root/native/RN documentation updates stay
with those owners. No facade, RN, Demo, version, publication, CI, physical-device,
cryptographic implementation or trusted-time changes are included here.
