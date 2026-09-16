# Encrypted Upload v2 Protocol Contract Design

**Status:** Approved; canonical contract and inspection implemented, runtime workflow pending

**Approved:** 2026-09-03

**Implementation snapshot (2026-09-03):** The machine-readable manifest,
generated constants, bounds-checked Rust codecs, canonical vectors, Apple and
Android internal inspection, and React Native byte/runtime boundary gates are
implemented. Profile selection, transfer orchestration, staging, completion,
receipt-gated deletion, and firmware capability advertisement remain
unimplemented.

## Decision

Encrypted Upload v2 uses one canonical device ciphertext object and one
authenticated upload manifest across Bluetooth, WiFi, and cellular. The first
release slice covers completed batch recordings. Live streaming keeps its
released compatibility behavior while `legacy_allowed` or an explicitly
backend-selected `v2_preferred` fallback permits it; a device with durably
applied `v2_required` policy rejects legacy streaming until streaming-v2 is
implemented.

The protocol is fixed binary rather than JSON, CBOR, a compiler-packed C
structure, or a renamed P10 format. All new Bluetooth behavior uses separately
allocated characteristics and message codes. The exact legacy 17-byte START,
legacy DATA/EOF/SHA packets, P10 `0x05`/`0x81`/`0x82` packets, and legacy
CONFIRM remain unchanged.

This document designs the contract that must be encoded in the canonical
machine-readable App SDK manifest and test vectors. The generated manifest,
not prose or one implementation, becomes the wire authority when the
protocol-contract change lands.

## Scope and Repository Ownership

The protocol-contract milestone changes all of these owners together:

| Owner | Responsibility |
|---|---|
| `app-sdk` | Canonical v2 manifest/schema, golden vectors, Rust constants/codecs, workflow vocabulary, and native opaque-file boundary |
| `react-native-sdk` | The same capability negotiation and v2 codecs/fixtures while preserving released v1/P10 behavior and public compatibility |
| `firmware` integration guide | Published GATT allocation, exact byte tables, stable result codes, and old/new compatibility behavior |
| `internal-docs` | Normative cross-system security, lifecycle, rollout, and implementation status |
| `bota` backend | Signed authorization/receipt production, staging, manifest validation, HPKE decapsulation, decryption, publication, and cleanup |

`app-sdk` is the canonical protocol source. Because `react-native-sdk` is an
independently released maintenance line, it vendors the exact canonical vector
bundle together with the source revision and bundle digest and runs every
applicable vector. A v2 contract change is incomplete until both repositories
accept the same bundle.

The maintenance React Native implementation is a transitional exception to the
target native-file boundary: `react-native-ble-plx` already delivers recording
notifications to TypeScript. It may relay opaque v2 ciphertext without parsing
or decrypting it, subject to its existing memory limits. In `app-sdk`, bulk
ciphertext stays in native sinks and uploads; Codegen carries identifiers,
policy/profile decisions, progress, stable errors, and terminal evidence only.

## Binary Conventions

Unless a field explicitly names an RFC encoding:

- integers are unsigned little-endian;
- UUIDs are the raw 16 bytes represented by their canonical textual UUID at API
  boundaries;
- SHA-256 and HMAC-SHA256 values are raw 32-byte values;
- reserved bytes and reserved flag bits are zero on write and rejected when
  nonzero on read;
- every fixed object has one exact length, and trailing bytes are rejected;
- variable payloads carry an explicit length that must exactly match the
  containing frame;
- counters and length arithmetic are checked before addition or allocation;
- unknown version, enum, suite, critical flag, or message type is rejected;
- no compiler-packed structure is directly hashed, authenticated, or written;
- comparisons of digests, tags, and signatures are constant time.

Protocol enum values are:

| Enum | Value |
|---|---:|
| `legacy_plain_v1` | `0x01` |
| `legacy_p10_relay` | `0x02` |
| `encrypted_upload_v2` | `0x03` |
| `legacy_plain` storage | `0x01` |
| `bota_enc_v1` storage | `0x02` |
| `bota_enc_v2` storage | `0x03` |
| `legacy_allowed` | `0x00` |
| `v2_preferred` | `0x01` |
| `v2_required` | `0x02` |
| BLE channel | `0x01` |
| WiFi channel | `0x02` |
| cellular channel | `0x03` |
| development environment | `0x00` |
| gamma environment | `0x01` |
| production environment | `0x02` |

The initial algorithm identifiers are:

| Suite | Value |
|---|---:|
| Storage cipher/auth: ChaCha20-Poly1305 + HKDF-SHA256 + HMAC-SHA256 | `0x0001` |
| Local key wrap: ChaCha20-Poly1305 + HKDF-SHA256 | `0x0001` |
| Manifest/trailer authentication: HMAC-SHA256 | `0x0001` |
| Backend signature: ECDSA P-256/SHA-256, raw P1363 `r || s`, low-S required | `0x0001` |
| RFC 9180 DHKEM(X25519, HKDF-SHA256) | `0x0020` |
| RFC 9180 HKDF-SHA256 | `0x0001` |
| RFC 9180 ChaCha20-Poly1305 | `0x0003` |

## Cryptographic Domains and Context Digests

All ASCII domain strings below are encoded without a terminating NUL.

```text
bota/enc-v2/local-wrap/v1
bota/enc-v2/wrapped-key-aad/v1
bota/enc-v2/block-aad/v1
bota/enc-v2/trailer-key/v1
bota/enc-v2/trailer-auth/v1
bota/enc-v2/manifest-key/v1
bota/enc-v2/manifest-auth/v1
bota/enc-v2/storage-identity/v1
bota/enc-v2/upload-context/v1
bota/enc-v2/hpke-key-export/v1
bota/enc-v2/device-identity/v1
bota/enc-v2/tenant-context/v1
bota/enc-v2/staging-object/v1
bota/enc-v2/publication/v1
```

Length-prefixed text uses `u16LE length || UTF-8 bytes` and is rejected above
the field's server-side bound before hashing.

- `device_identity_digest = SHA256(device-identity-domain || LP(serial))`.
- `tenant_context_digest = SHA256(tenant-context-domain || LP(organization_id)
  || LP(project_id))`.
- `staging_object_digest = SHA256(staging-object-domain || upload_session_id
  || LP(staging_bucket) || LP(staging_key))`.
- `configuration_digest` is the raw SHA-256 of the backend's deterministic
  effective-configuration snapshot already persisted with the session.
- `publication_identity_digest = SHA256(publication-domain || LP(final_bucket)
  || LP(final_key) || plaintext_sha256)`.
- `upload_context_digest = SHA256(upload-context-domain || complete
  UploadAuthorizationV2 bytes, including its signature)`.

The backend signing public key is selected by the signed firmware environment
and `signing_key_id`. It is not `BACKEND_PUBKEY`. Signatures use raw 64-byte
P1363 form and verifiers reject high-S encodings, invalid points, and any key
not allowed for the firmware environment.

## `bota_enc_v2` Storage Object

The batch object is:

```text
BotaEncV2Header (128 bytes)
BlockFrame[0]
BlockFrame[1]
...
BotaEncV2Trailer (144 bytes)
```

Firmware encrypts encoded OGG bytes before their first persistent write. It
does not create v2 by post-processing a plaintext file. The exact object bytes
are relayed through every transport.

### Header

`BotaEncV2Header` is exactly 128 bytes:

| Offset | Size | Field |
|---:|---:|---|
| 0 | 8 | ASCII magic `BOTAENC2` |
| 8 | 2 | format version `0x0002` |
| 10 | 2 | header length `128` |
| 12 | 4 | flags: bit 0 batch, bit 1 streaming |
| 16 | 2 | storage cipher/auth suite `0x0001` |
| 18 | 2 | local key-wrap suite `0x0001` |
| 20 | 4 | device wrapping-key version |
| 24 | 4 | plaintext block size; initial value `4096` |
| 28 | 16 | logical recording UUID |
| 44 | 4 | immutable recording generation |
| 48 | 12 | random block nonce base |
| 60 | 12 | random local key-wrap nonce |
| 72 | 32 | wrapped `K_data` ciphertext |
| 104 | 16 | wrapped `K_data` Poly1305 tag |
| 120 | 8 | reserved zero |

`K_wrap_v2` is derived with HKDF-Extract using an empty salt and `S_dev` as the
IKM, followed by HKDF-Expand to 32 bytes with
`local-wrap-domain || wrapping_key_version u32LE` as `info`. The wrapped-key
AEAD plaintext is the fresh 32-byte `K_data`; its AAD is the
`wrapped-key-aad` domain followed by header bytes `0..71` and `120..127`.
`K_data`, the wrapping key, and temporary AEAD state are zeroed on every
terminal path.

### Block frames

Each block frame is exactly `20 + plaintext_length` bytes:

| Offset | Size | Field |
|---:|---:|---|
| 0 | 2 | plaintext length, `1..block_size` |
| 2 | 2 | reserved zero |
| 4 | N | ciphertext, same length as plaintext |
| 4+N | 16 | Poly1305 tag |

Only the final block may be shorter than `block_size`. Block indices start at
zero. The 12-byte nonce keeps nonce-base bytes `0..7`; for `i` in `0..3`, byte
`8+i` is `nonce_base[8+i] XOR I2OSP_LE(block_index, 4)[i]`. This mapping is
injective for all valid 32-bit block indices. The AEAD AAD is the `block-aad`
domain followed by this fixed encoding:

```text
format_version u16LE
recording_uuid[16]
recording_generation u32LE
block_index u32LE
plaintext_offset u64LE
plaintext_length u32LE
```

### Trailer

`BotaEncV2Trailer` is exactly 144 bytes:

| Offset | Size | Field |
|---:|---:|---|
| 0 | 8 | ASCII magic `BOTAEND2` |
| 8 | 2 | format version `0x0002` |
| 10 | 2 | trailer length `144` |
| 12 | 1 | completion state `0x01` (complete) |
| 13 | 1 | mode `0x01` batch, `0x02` streaming |
| 14 | 2 | reserved zero |
| 16 | 4 | block count |
| 20 | 8 | exact plaintext length |
| 28 | 8 | ciphertext-body length from object byte 0 through the last block tag |
| 36 | 32 | plaintext OGG SHA-256 |
| 68 | 32 | ciphertext-body SHA-256 |
| 100 | 12 | reserved zero |
| 112 | 32 | HMAC-SHA256 trailer tag |

The trailer key is HKDF-Extract with
`recording_uuid || recording_generation u32LE` as salt and `K_data` as IKM,
then HKDF-Expand to 32 bytes with the `trailer-key` domain as `info`. The tag
covers the `trailer-auth` domain followed by trailer bytes `0..111`.

The complete ciphertext SHA-256 is computed over the header, every block
frame, and the complete authenticated trailer. It is stored outside the object
in the upload journal/manifest to avoid a self-reference. A missing or invalid
trailer is never a complete upload candidate.

## `UploadAuthorizationV2`

The backend produces one exact 408-byte authorization per upload session. It
is valid for one recording UUID/generation, one binding generation, one
recipient key, and the declared channel set.

| Offset | Size | Field |
|---:|---:|---|
| 0 | 8 | ASCII magic `BOTAAUT2` |
| 8 | 2 | authorization version `0x0002` |
| 10 | 2 | total length `408` |
| 12 | 1 | environment |
| 13 | 1 | required transport profile; v2 is `0x03` |
| 14 | 1 | minimum storage format; v2 is `0x03` |
| 15 | 1 | effective downgrade policy |
| 16 | 1 | allowed channel mask: BLE bit 0, WiFi bit 1, cellular bit 2 |
| 17 | 1 | reserved zero |
| 18 | 2 | storage cipher/auth suite |
| 20 | 2 | HPKE KEM ID |
| 22 | 2 | HPKE KDF ID |
| 24 | 2 | HPKE AEAD ID |
| 26 | 2 | backend signature suite |
| 28 | 2 | recipient-key format version |
| 30 | 2 | flags: bit 0 batch, bit 1 resume, bit 2 cross-channel resume |
| 32 | 4 | upload owner revision |
| 36 | 4 | binding generation |
| 40 | 4 | recording generation |
| 44 | 4 | backend signing-key ID |
| 48 | 8 | effective policy revision |
| 56 | 8 | issued-at Unix seconds |
| 64 | 8 | expires-at Unix seconds |
| 72 | 8 | minimum permitted ciphertext length |
| 80 | 8 | maximum permitted ciphertext length |
| 88 | 16 | upload-session UUID |
| 104 | 16 | one-time recipient-key UUID |
| 120 | 16 | recording UUID |
| 136 | 16 | fresh device `AUTH_NONCE` value |
| 152 | 32 | one-time X25519 recipient public key |
| 184 | 32 | tenant-context digest |
| 216 | 32 | device-identity digest |
| 248 | 32 | effective-configuration digest |
| 280 | 32 | staging-object digest |
| 312 | 32 | exact committed ciphertext SHA-256 |
| 344 | 64 | ECDSA P-256 signature over SHA-256(bytes `0..343`) |

For the batch slice, minimum and maximum ciphertext lengths are equal to the
committed local object's exact length. Firmware requires trusted authoritative
time, exact environment, device identity, binding generation, recording
identity/generation, nonce, suites, storage format, and policy before it opens
key material. Any well-formed authorization processing attempt rotates the
nonce.

Policy state applies monotonically by `(binding_generation, policy_revision)`.
A newer signed revision may intentionally relax or strengthen policy; an SDK
cannot. An older revision is rejected, and the same revision is idempotent only
when its policy/configuration digest is identical.

Within one upload session, a higher signed owner revision may replace the
active authorization for an explicit backend-controlled channel handoff. The
recording UUID/generation and canonical ciphertext identity must remain equal;
the old owner revision can no longer finalize or confirm. The data object stays
unchanged even when the new authorization produces a fresh HPKE envelope.

## Upload-time Key Export

Firmware validates the local header and trailer, unwraps only this recording's
`K_data`, and derives the manifest key. It does not decrypt an audio block.

The HPKE plaintext is exactly 96 bytes:

```text
K_data[32]
storage_identity_digest[32]
upload_context_digest[32]
```

`storage_identity_digest` is:

```text
SHA256(storage-identity-domain
  || recording_uuid
  || recording_generation u32LE
  || SHA256(header)
  || SHA256(trailer)
  || ciphertext_length u64LE
  || ciphertext_sha256
  || plaintext_length u64LE
  || plaintext_sha256)
```

RFC 9180 Base-mode HPKE uses the approved X25519/HKDF-SHA256/
ChaCha20-Poly1305 suite. HPKE `info` is the `hpke-key-export` domain followed
by manifest version and recipient-key version as `u16LE`. HPKE AAD is
`upload_context_digest || storage_identity_digest`. The encapsulated key is 32
bytes and the sealed payload is 112 bytes.

All plaintext key material, ephemeral private material, shared secrets, and
HKDF state are zeroed on success and failure. The SDK never receives
`K_data`.

## Upload Manifest

The canonical batch manifest is exactly 580 bytes:

| Offset | Size | Field |
|---:|---:|---|
| 0 | 8 | ASCII magic `BOTAMNF2` |
| 8 | 2 | manifest version `0x0002` |
| 10 | 2 | total length `580` |
| 12 | 1 | transport profile |
| 13 | 1 | storage format |
| 14 | 1 | effective policy |
| 15 | 1 | selected channel |
| 16 | 2 | storage cipher/auth suite |
| 18 | 2 | HPKE KEM ID |
| 20 | 2 | HPKE KDF ID |
| 22 | 2 | HPKE AEAD ID |
| 24 | 2 | manifest-authentication suite |
| 26 | 2 | recipient-key format version |
| 28 | 4 | upload owner revision |
| 32 | 4 | binding generation |
| 36 | 4 | recording generation |
| 40 | 4 | plaintext block size |
| 44 | 4 | block count |
| 48 | 4 | flags: bit 0 complete, bit 1 batch, bit 2 streaming |
| 52 | 16 | upload-session UUID |
| 68 | 16 | recipient-key UUID |
| 84 | 16 | recording UUID |
| 100 | 32 | tenant-context digest |
| 132 | 32 | device-identity digest |
| 164 | 32 | effective-configuration digest |
| 196 | 32 | staging-object digest |
| 228 | 32 | SHA-256 of complete UploadAuthorizationV2 |
| 260 | 8 | complete ciphertext length |
| 268 | 8 | expected plaintext length |
| 276 | 32 | complete ciphertext SHA-256 |
| 308 | 32 | plaintext OGG SHA-256 |
| 340 | 32 | header SHA-256 |
| 372 | 32 | trailer SHA-256 |
| 404 | 32 | HPKE encapsulated key |
| 436 | 112 | HPKE sealed key payload |
| 548 | 32 | HMAC-SHA256 manifest tag |

The manifest key is HKDF-Extract with
`recording_uuid || recording_generation u32LE` as salt and `K_data` as IKM,
then HKDF-Expand to 32 bytes with the `manifest-key` domain as `info`. The tag
covers the `manifest-auth` domain followed by manifest bytes `0..547`.

The SDK validates transport framing, total manifest length, and manifest
SHA-256 only. It does not interpret cryptographic fields. Backend validation
performs exact parsing, session/context comparison, HPKE decapsulation,
storage-identity comparison, manifest HMAC verification, storage trailer and
block verification, plaintext streaming decryption, OGG validation, and
publication.

## `CompletionReceiptV2`

The backend returns a 336-byte deletion receipt only after the final plaintext
object and recording state are durably published:

| Offset | Size | Field |
|---:|---:|---|
| 0 | 8 | ASCII magic `BOTARCPT` |
| 8 | 2 | receipt version `0x0002` |
| 10 | 2 | total length `336` |
| 12 | 1 | environment |
| 13 | 1 | result `0x01` (published) |
| 14 | 1 | transport profile |
| 15 | 1 | storage format |
| 16 | 4 | terminal upload owner revision |
| 20 | 4 | binding generation |
| 24 | 4 | recording generation |
| 28 | 4 | backend signing-key ID |
| 32 | 8 | issued-at Unix seconds |
| 40 | 8 | expires-at Unix seconds |
| 48 | 16 | upload-session UUID |
| 64 | 16 | recording UUID |
| 80 | 32 | tenant-context digest |
| 112 | 32 | device-identity digest |
| 144 | 32 | ciphertext SHA-256 |
| 176 | 32 | plaintext OGG SHA-256 |
| 208 | 32 | publication-identity digest |
| 240 | 32 | effective-configuration digest |
| 272 | 64 | ECDSA P-256 signature over SHA-256(bytes `0..271`) |

Receipt verification requires trusted time and an exact match on environment,
profile, storage format, session, owner revision, binding generation,
recording UUID/generation, device/tenant/configuration digests, and both object
hashes. Replaying the same valid receipt is idempotent. A receipt for any other
generation or session never deletes data.

## Bluetooth Allocation

The Storage service adds new characteristics; no released characteristic is
reinterpreted:

| Characteristic | UUID | Properties | Purpose |
|---|---|---|---|
| `CHAR_STORAGE_TRANSFER_CAPABILITIES_V2` | `B07A0004-0006-1000-8000-00805F9B34FB` | Read | Versioned capability value |
| `CHAR_TRANSFER_SIGNED_BLOB_V2` | `B07A0004-0007-1000-8000-00805F9B34FB` | Write With Response, Notify | Chunked authorization and completion receipt |
| `CHAR_TRANSFER_CONTROL_V2` | `B07A0004-0008-1000-8000-00805F9B34FB` | Write With Response | START, window ACK, resume, confirm, abort |
| `CHAR_RECORDING_TRANSFER_V2` | `B07A0004-0009-1000-8000-00805F9B34FB` | Notify | START-ACK, DATA, window end, manifest, EOF, resume result, error |
| `CHAR_TRANSFER_STATUS_V2` | `B07A0004-000A-1000-8000-00805F9B34FB` | Read, Notify | Bounded phase/progress/status snapshot |
| `CHAR_RECORDING_LIST_V2` | `B07A0004-000B-1000-8000-00805F9B34FB` | Notify | Full recording identity and ciphertext metadata |

Absence of the capability characteristic means no v2 support. Firmware version
and model strings are never substituted for this read.

### Capability value

The capability value is exactly 24 bytes:

| Offset | Size | Field |
|---:|---:|---|
| 0 | 1 | capability encoding version `0x01` |
| 1 | 1 | highest transfer profile version `0x02` |
| 2 | 2 | value length `24` |
| 4 | 4 | capability flags |
| 8 | 2 | maximum signed blob bytes; at least `408`, initial bound `1024` |
| 10 | 2 | maximum manifest bytes; at least `580`, initial bound `1024` |
| 12 | 2 | maximum DATA payload bytes |
| 14 | 2 | maximum window packets |
| 16 | 4 | durable checkpoint interval in complete storage blocks |
| 20 | 2 | maximum missing sequences per WINDOW_ACK |
| 22 | 2 | reserved zero |

Capability flag bits are:

| Bit | Meaning |
|---:|---|
| 0 | transfer-v2 framing |
| 1 | `bota_enc_v2` storage |
| 2 | full UUID plus immutable generation |
| 3 | durable resume |
| 4 | authenticated upload manifest |
| 5 | authenticated completion receipt |
| 6 | completed batch recording support |
| 7 | live streaming-v2 support |

Batch v2 requires bits 0 through 6. The first release leaves bit 7 clear.

### Signed-blob framing

Blob kind `0x01` is UploadAuthorizationV2 and `0x02` is CompletionReceiptV2.
The App subscribes before BEGIN. One `write_id` owns assembly; a second owner is
rejected. DATA writes are ordered, but an exact duplicate at an already written
offset is idempotent. Gaps, overlaps with different bytes, excess length, or a
digest mismatch clear the assembly.

| Code | Name | Exact framing |
|---:|---|---|
| `0x60` | BLOB_BEGIN | `[code, version=2, kind, reserved=0, write_id u32LE, total_length u16LE, sha256[32]]` (42 bytes) |
| `0x61` | BLOB_DATA | `[code, version=2, kind, reserved=0, write_id u32LE, offset u16LE, chunk_length u16LE, chunk...]` |
| `0x62` | BLOB_COMMIT | `[code, version=2, kind, reserved=0, write_id u32LE]` (8 bytes) |
| `0x63` | BLOB_ABORT | `[code, version=2, kind, reserved=0, write_id u32LE]` (8 bytes) |
| `0x64` | BLOB_RESULT notify | `[code, version=2, kind, reserved=0, write_id u32LE, result u16LE]` (10 bytes) |

Authorization COMMIT verifies and consumes the fresh nonce before START can
succeed. Receipt COMMIT verifies and retains only the exact receipt digest
needed by CONFIRM. Sensitive temporary blob buffers are cleared after terminal
use.

### Transfer messages

Every transfer-v2 message begins with this 12-byte header:

| Offset | Size | Field |
|---:|---:|---|
| 0 | 1 | message type |
| 1 | 1 | protocol version `0x02` |
| 2 | 2 | message flags |
| 4 | 8 | nonzero random transport-session ID |

The message namespace is independent of legacy and P10:

| Code | Direction | Name |
|---:|---|---|
| `0x20` | App to device | START |
| `0x21` | App to device | WINDOW_ACK |
| `0x22` | App to device | RESUME_REQUEST |
| `0x23` | App to device | CONFIRM |
| `0x24` | App to device | ABORT |
| `0x25` | App to device | LIST |
| `0x40` | Device to App | START_ACK |
| `0x41` | Device to App | DATA |
| `0x42` | Device to App | WINDOW_END |
| `0x43` | Device to App | MANIFEST_CHUNK |
| `0x44` | Device to App | EOF |
| `0x45` | Device to App | RESUME_ACCEPT |
| `0x46` | Device to App | RESUME_REJECT |
| `0x48` | Device to App | RECORDING_ENTRY |
| `0x49` | Device to App | RECORDING_LIST_END |
| `0x4F` | Device to App | ERROR |

LIST is exactly 16 bytes: the common header followed by a `u32LE` request
flags field, which is zero in the initial profile. RECORDING_ENTRY is exactly
96 bytes:

| Offset | Size | Field |
|---:|---:|---|
| 0 | 12 | common header |
| 12 | 16 | recording UUID |
| 28 | 4 | immutable recording generation |
| 32 | 1 | storage format |
| 33 | 1 | completion state; `0x01` means committed |
| 34 | 2 | reserved zero |
| 36 | 8 | started-at Unix seconds; zero if unknown |
| 44 | 4 | duration seconds |
| 48 | 8 | exact plaintext length |
| 56 | 8 | exact ciphertext length |
| 64 | 32 | complete ciphertext SHA-256 |

Only committed `bota_enc_v2` entries may be used for a v2 session.
RECORDING_LIST_END is exactly 52 bytes: common header, entry count `u32LE`,
monotonic list revision `u32LE`, and SHA-256 of the ordered concatenation of
each RECORDING_ENTRY payload (bytes `12..95`, excluding its transport header).
The legacy 24-byte recording-list characteristic remains unchanged.

START is exactly 128 bytes:

| Offset | Size | Field |
|---:|---:|---|
| 0 | 12 | common header |
| 12 | 16 | upload-session UUID |
| 28 | 16 | recording UUID |
| 44 | 4 | recording generation |
| 48 | 32 | authorization SHA-256 |
| 80 | 4 | requested checkpoint revision; zero for fresh |
| 84 | 8 | requested next ciphertext offset; zero for fresh |
| 92 | 32 | SHA-256 of ciphertext prefix through that offset; SHA-256(empty) for fresh |
| 124 | 2 | requested window packets |
| 126 | 2 | requested DATA payload bytes |

START_ACK is exactly 140 bytes:

| Offset | Size | Field |
|---:|---:|---|
| 0 | 12 | common header |
| 12 | 16 | upload-session UUID |
| 28 | 16 | recording UUID |
| 44 | 4 | recording generation |
| 48 | 8 | exact ciphertext length |
| 56 | 32 | exact ciphertext SHA-256 |
| 88 | 2 | accepted window packets |
| 90 | 2 | accepted DATA payload bytes |
| 92 | 4 | durable checkpoint interval in complete storage blocks |
| 96 | 4 | accepted checkpoint revision |
| 100 | 8 | accepted next ciphertext offset |
| 108 | 32 | accepted prefix SHA-256 |

DATA is `28 + payload_length` bytes:

| Offset | Size | Field |
|---:|---:|---|
| 0 | 12 | common header |
| 12 | 4 | sequence number |
| 16 | 8 | exact ciphertext byte offset |
| 24 | 2 | payload length |
| 26 | 2 | reserved zero |
| 28 | N | opaque canonical ciphertext bytes |

WINDOW_END is exactly 68 bytes:

| Offset | Size | Field |
|---:|---:|---|
| 0 | 12 | common header |
| 12 | 4 | window index |
| 16 | 4 | first sequence in window |
| 20 | 4 | last sequence in window |
| 24 | 8 | next ciphertext offset after the proven prefix |
| 32 | 32 | proven prefix SHA-256 |
| 64 | 4 | proposed checkpoint revision |

WINDOW_ACK is `68 + 4 * missing_count` bytes:

| Offset | Size | Field |
|---:|---:|---|
| 0 | 12 | common header |
| 12 | 4 | window index |
| 16 | 4 | highest contiguous sequence |
| 20 | 8 | next ciphertext offset after the contiguous prefix |
| 28 | 32 | contiguous prefix SHA-256 |
| 60 | 4 | accepted checkpoint revision |
| 64 | 2 | missing sequence count |
| 66 | 2 | reserved zero |
| 68 | 4*N | missing sequence numbers |

MANIFEST_CHUNK is `52 + chunk_length` bytes:

| Offset | Size | Field |
|---:|---:|---|
| 0 | 12 | common header |
| 12 | 2 | total manifest length |
| 14 | 2 | chunk offset |
| 16 | 2 | chunk length |
| 18 | 2 | reserved zero |
| 20 | 32 | complete manifest SHA-256 |
| 52 | N | opaque manifest bytes |

EOF is exactly 92 bytes:

| Offset | Size | Field |
|---:|---:|---|
| 0 | 12 | common header |
| 12 | 4 | final DATA sequence |
| 16 | 4 | storage block count |
| 20 | 8 | exact ciphertext length |
| 28 | 32 | complete ciphertext SHA-256 |
| 60 | 32 | complete manifest SHA-256 |

RESUME_REQUEST and RESUME_ACCEPT are each exactly 96 bytes:

| Offset | Size | Field |
|---:|---:|---|
| 0 | 12 | common header |
| 12 | 16 | upload-session UUID |
| 28 | 16 | recording UUID |
| 44 | 4 | recording generation |
| 48 | 4 | checkpoint revision |
| 52 | 8 | next ciphertext offset |
| 60 | 32 | prefix SHA-256 |
| 92 | 2 | requested/accepted window packets |
| 94 | 2 | requested/accepted DATA payload bytes |

RESUME_REJECT is exactly 60 bytes: common header, `reason u16LE`, two reserved
zero bytes, device checkpoint revision `u32LE`, next ciphertext offset
`u64LE`, and the 32-byte device prefix digest.

CONFIRM is exactly 84 bytes: common header, upload-session UUID, recording UUID,
recording generation, terminal owner revision, and the 32-byte SHA-256 of the
previously verified CompletionReceiptV2.

ABORT is exactly 16 bytes: common header, stable `reason u16LE`, and two
reserved zero bytes.

ERROR is exactly 20 bytes: common header, stable `error u16LE`, the failed
message type, one reserved zero byte, and the last durable checkpoint revision.

The read/notify transfer-status snapshot is exactly 24 bytes:

| Offset | Size | Field |
|---:|---:|---|
| 0 | 1 | status version `0x02` |
| 1 | 1 | phase |
| 2 | 2 | stable result/error code |
| 4 | 8 | current transport-session ID, or zero while idle |
| 12 | 8 | ciphertext bytes durably accepted/sent |
| 20 | 1 | progress percent `0..100` |
| 21 | 1 | active transport profile, or zero while idle |
| 22 | 2 | reserved zero |

Initial status phases are `0x00` idle, `0x01` receiving authorization,
`0x02` authorized, `0x03` transferring, `0x04` waiting for window ACK,
`0x05` sending manifest/final evidence, `0x06` waiting for backend completion,
`0x07` receiving receipt, `0x08` confirming, `0x09` complete, and `0x0A`
error. Unknown phase values remain numeric at SDK boundaries but do not advance
a workflow.

Messages from another profile or with a different transport-session ID end the
session. A new transport session may resume the same upload session only after
the exact resume handshake. Unproved tail bytes in the App sink are truncated
before RESUME_ACCEPT advances.

## Stable Result and Error Codes

Signed-blob results, ERROR, and resume rejection use the same `u16` namespace:

| Code | Name |
|---:|---|
| `0x0000` | success |
| `0x0001` | unsupported version |
| `0x0002` | invalid length |
| `0x0003` | noncanonical encoding |
| `0x0004` | signature invalid |
| `0x0005` | environment mismatch |
| `0x0006` | expired |
| `0x0007` | authoritative time unavailable |
| `0x0008` | device or tenant identity mismatch |
| `0x0009` | binding generation mismatch |
| `0x000A` | recording UUID or generation mismatch |
| `0x000B` | storage format or suite unsupported |
| `0x000C` | downgrade policy prohibits profile |
| `0x000D` | authorization missing or mismatched |
| `0x000E` | transfer/upload owner busy |
| `0x000F` | checkpoint or prefix mismatch |
| `0x0010` | completion receipt invalid or mismatched |
| `0x0011` | mixed transport profile |
| `0x0012` | complete ciphertext unavailable |
| `0x0013` | authorization or receipt replay conflict |
| `0x00FF` | internal failure |

Unknown errors surface numerically and retain the recording. None authorizes a
legacy retry when the selected operation was v2.

New firmware rejecting the exact legacy START because `v2_required` is durably
applied sends the existing legacy ERROR packet shape on
`CHAR_RECORDING_TRANSFER` with additive legacy error code `0x22`
(`ENCRYPTED_UPLOAD_V2_REQUIRED`). It never sends a v2 ERROR to an old
characteristic. Updated SDKs map `0x22` to a stable non-retryable policy error;
older SDKs may surface an unknown device error but still receive no new format.

## SDK Selection and Public Boundary

Both SDK repositories implement the same state transition:

1. Read the explicit v2 capability characteristic.
2. Report the capability value and recording identity to an application-owned
   upload-profile provider.
3. Receive an explicit backend decision for exactly one of the three profiles.
4. Reject a v2 decision if required capability bits are absent; do not replace
   it with v1.
5. For v2, receive opaque session identifiers, signed authorization bytes, and
   native staging targets/headers. The SDK does not construct authorization.
6. Deliver and verify authorization, transfer opaque ciphertext and manifest,
   and stage both artifacts.
7. Return terminal staging evidence to the application. The application asks
   its backend to finalize and returns the opaque signed completion receipt.
8. Deliver the receipt and send CONFIRM only after receipt verification.

The existing one-argument React Native upload-info provider remains valid and
selects legacy behavior. The additive v2 provider context includes raw
capability bytes/digest, full recording UUID/generation, and available
checkpoint metadata. Its result is a discriminated profile union; a result
cannot contain fields from multiple profiles.

The `app-sdk` React Native Codegen surface carries no DATA payload, manifest,
staging URL, credential, or native file bytes. Apple and Android own the BLE
packet stream, opaque sink, checkpoints, and staging upload. The maintenance
`react-native-sdk` keeps its existing TypeScript transport architecture but
must not parse the v2 ciphertext, HPKE envelope, or manifest fields.

## Compatibility and Downgrade Rules

| Combination | Behavior |
|---|---|
| old SDK + old firmware | Exact released v1/P10 behavior |
| new SDK + old firmware | Capability absent; backend may explicitly select legacy; exact v1 START is used |
| old SDK + new firmware, legacy permitted | Exact 17-byte START produces exact v1 packets |
| old SDK + new firmware, `v2_required` durably applied | Legacy START fails before opening the recording |
| new SDK + new firmware | V2 only after capability read and explicit backend selection |
| historical P10 device | Existing `E2E_START` and `0x81`/`0x82` handling through `/upload-relay` |

A recording-list encryption flag, firmware version, model, cached capability,
stored `BACKEND_PUBKEY`, receipt of a P10 packet, or presence of v2 code is not
permission to select v2. A failed, expired, cancelled, or rejected v2 operation
does not silently start v1 or P10.

## Batch-first Streaming Rule

The capability streaming bit remains clear in the first implementation. While
policy is `legacy_allowed`, released streaming may continue. Under
`v2_preferred`, only an explicit backend response may select that legacy
streaming path. Once `v2_required` is durably applied, firmware rejects legacy
live START and direct plaintext streaming before any recording bytes are
uploaded; the application reports `encrypted_streaming_not_supported` rather
than changing the profile.

Streaming-v2 later reuses the exact storage header, block frame, trailer,
authorization, key export, and manifest definitions. It adds only streaming
lifecycle/checkpoint behavior and sets the existing mode/capability flags; it
does not define another ciphertext format.

## Golden Vectors and Negative Tests

The canonical bundle contains fixed non-production keys and inputs for:

- one partial-block object and one multi-block object;
- header wrapping, block AEAD, trailer HMAC, complete-object hashes, and local
  unwrap;
- UploadAuthorizationV2 for development, gamma, and production environment
  codes using test signing keys;
- applicable RFC 9180 X25519/HKDF-SHA256/ChaCha20-Poly1305 vectors;
- key export, upload manifest, manifest HMAC, and completion receipt;
- every capability, signed-blob, control, data, resume, manifest, EOF, confirm,
  abort, status, and error frame;
- fresh transfer, clean window, missing packet repair, disconnect with unproved
  tail truncation, accepted resume, rejected identity/generation/prefix resume,
  and idempotent receipt replay;
- exact old-SDK/new-firmware and new-SDK/old-firmware traces;
- historical P10 fixtures unchanged.

Each parser suite rejects truncation at every byte boundary, one-byte extension,
nonzero reserved data, overlong sizes, arithmetic overflow, invalid enum/suite,
unknown flag, duplicate/out-of-order blob chunk, wrong session identity,
altered signature/tag/hash, high-S signature, wrong recipient key, expired
authorization/receipt, and mixed v1/P10/v2 messages.

The same canonical vector digest is recorded in:

- generated Rust evidence in `app-sdk`;
- Apple and Android facade fixture resources;
- the `app-sdk` React Native adapter tests;
- the vendored `react-native-sdk` vector bundle and test evidence;
- backend parser/worker tests; and
- firmware static tests plus physical-device acceptance evidence.

## Delivery Order and Gates

1. Land the machine-readable contract, generated constants/codecs, fixtures,
   firmware-guide tables, and both-SDK parser/serializer tests. Do not advertise
   the capability in firmware.
2. Implement the backend public session/authorization/staging/manifest API,
   streaming decryption/publication worker, completion receipt, and expiry
   cleanup against the vectors.
3. Implement batch-v2 workflow behavior in both `app-sdk` and
   `react-native-sdk`; preserve all v1/P10 tests.
4. Update Bota One and Demo application providers to supply explicit backend
   profile decisions and v2 session material.
5. Implement firmware `bota_enc_v2`, signed-blob verification, transfer-v2,
   direct raw-ciphertext upload, durable checkpointing, and receipt-gated
   deletion. Advertise bits only for completed behavior.
6. Enable internal-device cohorts under `v2_preferred`, verify byte-identical
   ciphertext and identical final OGG SHA-256 across BLE, WiFi, and cellular,
   then graduate policy cohorts.
7. Apply `v2_required` only after batch support is proven and legacy streaming
   has been explicitly disabled or streaming-v2 is available.

No production capability bit, backend policy cohort, or firmware emission is
enabled by the contract-only milestone.

## Verification Boundary

The contract milestone is complete only when:

- all generated artifacts are drift-free;
- both SDK repositories pass the same valid and malformed vector bundle;
- backend, Rust, TypeScript, Swift, Kotlin, and firmware reference decoders
  produce the same normalized values;
- v1/P10 fixture digests and public behavior remain unchanged;
- no code selects encryption from `BACKEND_PUBKEY` or a recording-list flag;
- `v2_required` rejection tests cover batch and streaming legacy entry points;
- every v2 failure retains the device recording; and
- documentation distinguishes contract support from deployed runtime support.

## Non-goals

- Re-enabling `ble_e2e_encrypt()` or relabeling P10 as v2.
- Decrypting or transcoding in either SDK.
- Adding a Bota control-plane API client to an App SDK.
- Changing released v1/P10 byte definitions.
- Advertising v2 before backend, both SDKs, application integration, firmware,
  and physical-device gates pass.
- Defining live streaming-v2 behavior in the first batch milestone.
