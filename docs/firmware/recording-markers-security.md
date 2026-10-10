# Recording Marker Security and Binary Contract

This appendix to [FIRMWARE_PROTOCOL.md](../../FIRMWARE_PROTOCOL.md) defines the
marker extension for firmware implementers. Native SDK/App relays keep its
signed/encrypted documents opaque. It describes implemented source behavior,
not released package availability or permission to enable a device cohort.

BATCH assumes the existing [encrypted-upload-v2 contract](../superpowers/specs/2026-09-03-encrypted-upload-v2-protocol-contract-design.md),
including its 408-byte audio authorization, 336-byte receipt, trusted key/time
registry, upload context and owner checks. The marker extension below is
additive. STREAMING has a [separate admission and HTTP contract](protected-streaming.md).
Use the [fixture pack and rejection checklist](vectors/README.md) for byte-level integration.

## Canonical encoding and context

All integer fields are little-endian (ECDSA signature r/s encoding is separately defined below). UUIDs are 16 raw bytes in RFC byte order, not Windows GUID memory order. SHA-256 values occupy 32 bytes. Do not transmit/sign C structs directly. Declared length must equal actual input. Reject trailing bytes, overflow, nonzero reserved fields, and unsupported versions. JSON u64/i64 values are canonical decimal strings; HTTP envelopes use standard base64. Unknown future versions may only be retained/forwarded as opaque bytes, not re-encoded, interpreted as success, or used to delete data.

`CaptureIdentityV1` consists of the following contiguous 176 bytes. Tenant/device/configuration digests follow the corresponding upload contract:

| offset | bytes | Field |
|---|---:|---|
| 0 | 1 | environment: 0 development, 1 gamma, 2 production |
| 1 | 1 | mode: 1 BATCH, 2 STREAMING |
| 2 | 2 | reserved=0 |
| 4 | 4 | owner_revision |
| 8 | 4 | capture_binding_generation |
| 12 | 4 | recording_generation |
| 16 | 16 | upload/session UUID |
| 32 | 16 | recording UUID |
| 48 | 32 | tenant_context_digest |
| 80 | 32 | device_identity_digest |
| 112 | 32 | SHA256(ASCII `BOTA-MARKER-REC-ID-V1` + NUL + UTF8 exact `rec_*`) |
| 144 | 32 | configuration_digest |

`context_digest = SHA256(ASCII BOTA-MARKER-CONTEXT-V1 + NUL + CaptureIdentityV1)`. Every new BOTA-MARKER string domain in this schema is its exact listed ASCII text followed by one 0x00, without quotes or newlines. The device constructs context from verified authorization and its own recording identity, not a blindly trusted request digest. Owner/session replacement requires reauthorization, new context, and a new derived key. Event IDs/content remain unchanged; the recording's existing K_data does not change with transport. Offline BATCH capture does not depend on this upload context. It first uses local recording identity and existing at-rest protection, and constructs the rec_*-bound context at upload.

## Common document header

Every new document starts with a 64-byte header followed by its kind-specific body. This kind namespace exists only inside the new marker profile; these are not existing BLE opcodes or C ABI numbers.

| offset | bytes | Field |
|---|---:|---|
| 0 | 8 | magic, ASCII `BOTAMRK1` |
| 8 | 2 | version=1 |
| 10 | 2 | kind |
| 12 | 4 | total_length, including header and authentication trailer |
| 16 | 16 | request_uuid, nonzero and unchanged on idempotent retry |
| 32 | 32 | context_digest |

| kind | Document | Total length |
|---|---|---:|
| 0x0001 | Encrypted single-marker request | 228 |
| 0x0002 | Encrypted final seal intent | 200 |
| 0x0003 | Encrypted BATCH snapshot page | 216 + page_bytes |
| 0x1001 | Persisted-marker ACK | 208 |
| 0x1002 | Final logical completion | 296 |
| 0x1003 | MarkerAuthorization | 280 |

STREAMING sends one kind1 document per marker. BATCH sends one seal plus encrypted snapshot pages; it does not send a list of kind1 documents. Every encrypted document has its own stable request UUID. Version 1 accepts only `source=button`. Do not accept a different kind's signature/ciphertext merely because its document length matches.

## MarkerBody and snapshots

MarkerBody is 52 bytes; `marker_digest = SHA256(ASCII BOTA-MARKER-EVENT-V1 + NUL + MarkerBody)`.

| offset | bytes | Field |
|---|---:|---|
| 0 | 16 | marker UUID |
| 16 | 4 | sequence, starting at 1 |
| 20 | 8 | media_offset_ms |
| 28 | 4 | segment_index, starting at 0 |
| 32 | 8 | segment_offset_ms |
| 40 | 8 | created_at_utc_ms, signed i64; 0 when absent |
| 48 | 1 | source: 1 button; other values rejected in this version |
| 49 | 1 | flags: bit0 indicates UTC presence; all other bits must be 0 |
| 50 | 2 | reserved=0 |

Present UTC is not used for media ordering. Except for UTC, application u64 values must also fit database/client contract bounds. Check before narrowing. Distinct IDs/sequences may share a millisecond; the same ID with different content is rejected.

Kind1 plaintext content is `MarkerBody[52] || previous_input_chain[32]`. STREAMING's input chain covers admitted events: `H0 = SHA256(D_chain0 || recording UUID || u32 recording_generation || device_identity_digest)`; `Hi = SHA256(D_chain || H(i-1) || u32 sequence || marker_digest)`. Domains are `BOTA-MARKER-CHAIN-INIT-V1` and `BOTA-MARKER-CHAIN-V1`, each followed by NUL. The chain excludes mutable upload session/owner identity, so network changes or controlled owner handoff do not alter the final set. Context separately authenticates origin, tenant, and current authorization. Out-of-order receipt cannot advance a prefix with gaps.

Kind2 plaintext is 56 bytes, in order: requested_count u32, last_requested_sequence u32, final_input_chain[32], final_media_duration_ms u64, segment_count u32, reserved u32=0. For no markers, count/last are 0 and chain is H0. A complete v1 set requires count=last; skipping unconfirmed inputs cannot complete a seal. BATCH also submits this final intent, checked alongside the sealed snapshot and original audio proof. Only the device still owning the capture session may generate stop intent; background expiry cannot invent it.

Canonical BATCH snapshot plaintext starts with a 36-byte header: schema u16=1, flags u16 with only bit0 sealed, manifest_revision u64, media_duration_ms u64, segment_count u32, marker_count u32, last_sequence u32, reserved u32=0. It is followed by 92-byte SegmentRefs in index order and then 52-byte MarkerBodies in sequence order. Each SegmentRef contains, in order: index u32, media_start_ms u64, duration_ms u64, plaintext_bytes u64, plaintext_sha256[32], immutable_encrypted_object_sha256[32]. Hashes come from the same physical segment verified by the recording system, not an App guess. Active segments cannot masquerade as final sealed segments.

Kind3 plaintext contains a 72-byte page header followed by page_bytes: manifest_revision u64, page_index u32, page_count u32, byte_offset u64, total_plaintext_length u64, page_length u32, reserved u32=0, complete_snapshot_sha256[32]. The complete snapshot hash is `SHA256(D_snapshot || snapshot_bytes)`, with domain `BOTA-MARKER-SNAPSHOT-V1`. Pages must have no gaps/overlaps or range overflow, and must share revision/hash. Validate all canonical content at completion. Each page has its own request UUID; retries reuse original ciphertext rather than generating another randomized envelope.

## Authorization, encryption, and device-origin authentication

Reuse existing upload verification with P-256 SHA-256 raw64 low-S backend signatures and the approved HPKE Base X25519/HKDF-SHA256/ChaCha20-Poly1305 suite. Do not invent cryptographic algorithms. Existing crypto modules own algorithm implementation and official test vectors. Backend signatures are ECDSA P-256 over SHA-256 of the domain-prefixed message, encoded as big-endian r[32] || s[32], with 0 < r < n and 0 < s <= n/2. Reject DER, high-S, unknown signing keys and invalid trusted time; select the retained verification key by the signed key ID, never by a caller-supplied key.

Kind0x1003 has a 152-byte body, in order: verified original upload-authorization document SHA256[32], recipient_key_uuid[16], recipient_public_key[32], issued_at_seconds u64, expires_at_seconds u64, signing_key_id u32, max_frame_bytes u32, max_pending u32, max_snapshot_bytes u64, max_markers u32, metadata_policy_digest[32]. Append the 64-byte backend signature. Sign `D_auth || header || body`, with domain `BOTA-MARKER-AUTH-V1`. Kind/length/request/context are signed. max_frame must hold required fixed documents. All limits are nonzero and constrained by the intersection of server policy and device resources. A device resource ceiling does not authorize the server to enlarge allocations arbitrarily. max_frame_bytes means the whole document, not an ATT fragment; max_snapshot_bytes means total canonical plaintext snapshot bytes; max_pending counts admitted events without exact ACKs; max_markers is the negotiated safe-processing boundary, not a new fixed product limit. Check local hard bounds before allocating any receive buffer; do not malloc from a network claim and validate afterward.

MarkerAuthorization's recipient_public_key and recipient_key_uuid must match the verified original upload authorization byte for byte. BATCH reuses the same protected recipient; a new naked public key is not another key-export destination. Recipient replacement follows upload-owner successor authorization and rebuilds context. Do not mix old authorization/key material. The additional authorization explicitly permits the marker profile and binds original upload authorization. It does not reinterpret an old 408-byte authorization or naked public key as metadata permission. BATCH exports the recording K_data to the exact recipient through the existing protected key-export flow. STREAMING uses the separate device-only RAM key grant in [Protected STREAMING](protected-streaming.md); it never bypasses sealed BATCH-file checks.

Request kinds1/2/3 use `header[64] || hpke_enc[32] || hpke_ciphertext`. Inside the protected recording-key handle, derive `K_marker_auth` from K_data with HKDF-SHA256: salt=context_digest, info=`BOTA-MARKER-AUTH-KEY-V1`+NUL, length32. Plaintext is kind-specific content P followed by `HMAC-SHA256(K_marker_auth, D_request || header || P)`, where D_request=`BOTA-MARKER-REQUEST-V1`+NUL.

The marker HPKE suite identifiers are KEM 0x0020, KDF 0x0001 and AEAD 0x0003, in Base mode.

HPKE info=`BOTA-MARKER-HPKE-V1`+NUL+recipient_key_uuid[16]+context_digest; AAD is the complete header. After decryption, the recipient also verifies the HMAC so an App possessing only the public key cannot forge device events. Reject HMAC/decryption failure, unknown key IDs, context mismatch, or authorization failure. Do not log keys/plaintext. Apps must not receive export/derivation privileges. Clear temporary K_data and derived keys on every success/failure path.

Generate one HPKE encapsulation for each new document and retransmit its stored exact bytes. Do not fix HPKE randomness or encrypt different contents under the same key/nonce. BATCH local ciphertext/checkpoints follow existing at-rest protection; STREAMING retains only RAM. Authorized BATCH owner replacement may re-encapsulate the same semantic event under new context, authorization, and request UUID, but marker ID/content remain unchanged. An old owner's proof cannot directly authorize the new owner. Live STREAMING owner/key replacement is not implemented in revision 1.

## Backend signed responses

Signing algorithms and key registry follow upload security. Domain-separated inputs are `BOTA-MARKER-ACCEPT-V1` and `BOTA-MARKER-COMPLETE-V1`, each followed by NUL and then the complete header/body. Append a raw64 low-S signature; DER is not a substitute. Certificate/key rotation, trusted time, and exact replay after expiry follow approved upload policy. Require issued_at <= trusted_now < expires_at. Unknown time must not silently admit new proof.

The ACK body is 80 bytes, in order: signing_key_id u32, issued_at_seconds u64, expires_at_seconds u64, committed_revision u64, marker UUID[16], sequence u32, marker_digest[32]. Kind0x1001 has no pending/failure variant; issue it only after marker authentication and transaction commit. Before incrementing successful count, the device checks request, complete context, marker/sequence/digest, signature, and time. Duplicate ACKs do not flash again. A 200 JSON body or client-reported revision is not an ACK.

Logical completion body is 168 bytes, in order: signing_key_id u32, issued_at_seconds u64, expires_at_seconds u64, final_manifest_revision u64, snapshot_sha256[32], audio_completion_proof_sha256[32], publication_identity_digest[32], metadata_seal_document_sha256[32], marker_count u32, last_sequence u32, audio_proof_kind u16, reserved u16=0. BATCH requires audio_proof_kind=1 and binds the original 336-byte signed audio receipt. The separate STREAMING verifier requires audio_proof_kind=2 and binds the complete 296-byte final audio proof. Never accept a STREAMING proof through the BATCH deletion verifier or a chunk ACK as final proof.

After committing facts, the issuer stores the complete bytes of the first successful signature document. Repeated GET/submission returns that same document rather than re-signing and changing the proof hash. On signing failure, retain recoverable facts and return processing, not a fabricated ACK. BATCH owner succession requires explicit reauthorization and a new context. STREAMING final-proof refresh is the narrowly defined same-publication exception in [Protected STREAMING](protected-streaming.md#completion-expiry-and-refresh); it never renews capture authority. Updated logical proof must match the exact audio proof hash again; never splice old and new signatures.

Local deletion verifies both original audio proof and its exact kind0x1002 binding, then persists and reads back authenticated terminal state. STREAMING without local files uses it only to prove cloud completeness. The final receipt's metadata seal digest is SHA256 of the device's complete raw final-seal document. The issuer verifies that document and the final set; the received subset is not a substitute. Without complete seal intent, no complete result may be signed.


## Context digest inputs

For the inherited v2 identity digests, `LP(text)` is u16LE UTF-8 byte length
followed by those exact bytes (maximum 65535 bytes). These two inherited domains
have **no terminating NUL**, unlike the new `BOTA-MARKER-*` domains:

- tenant_context_digest = SHA256(ASCII `bota/enc-v2/tenant-context/v1` || LP(organization_id) || LP(project_id)).
- device_identity_digest = SHA256(ASCII `bota/enc-v2/device-identity/v1` || LP(serial_number)).

The configuration digest is the verified upload configuration snapshot digest.
Do not substitute the STREAMING effective policy digest: it has its own signed
field. Compute the recording-ID digest from the exact server-assigned `rec_*`
string, not from the recording UUID. All duplicated context fields must match
locally known identity and verified authority before any key is used.

## Body offset quick reference

Offsets here start immediately after the 64-byte BOTAMRK1 header. A signed
body is followed by raw64 signature; no alignment padding is inserted.

| Document | Body fields: offset:length |
| --- | --- |
| Authorization (152) | original_authorization_sha256 0:32; recipient_uuid 32:16; recipient_public_key 48:32; issued_seconds 80:8; expires_seconds 88:8; signing_key_id 96:4; max_frame_bytes 100:4; max_pending 104:4; max_snapshot_bytes 108:8; max_markers 116:4; metadata_policy_digest 120:32 |
| Marker ACK (80) | signing_key_id 0:4; issued_seconds 4:8; expires_seconds 12:8; committed_revision 20:8; marker_uuid 28:16; sequence 44:4; marker_digest 48:32 |
| Logical completion (168) | signing_key_id 0:4; issued_seconds 4:8; expires_seconds 12:8; final_revision 20:8; snapshot_sha256 28:32; audio_proof_sha256 60:32; publication_digest 92:32; seal_document_sha256 124:32; marker_count 156:4; last_sequence 160:4; audio_proof_kind 164:2; reserved 166:2 |

The authorization binds SHA256(audio authorization408) in BATCH, or
SHA256(stream authorization468) in STREAMING. An ACK's request UUID equals the
original marker request UUID. A logical completion's request UUID equals the
exact final marker-seal request UUID. The publication digest must match the
independently verified audio proof. Firmware does not invent an object URL or
recompute server storage identity from untrusted JSON.

## BATCH export and HTTP mapping

Prefix `B` is `/v1/recordings/:id/encrypted-upload-v2/sessions/:session_id/markers`.
Use the existing scoped upload actor authentication and exact owner revision.
Requests and responses below are JSON; Base64 is canonical standard padded
Base64, not Base64url. There is no extra `data` envelope.

| Method/path | Request | Response / rule |
| --- | --- | --- |
| GET `B/authorization` | query `owner_revision` | Saved `{profile:"recording-markers/1",context_base64,authorization_base64,authorization_sha256}`; 176-byte context and 280-byte marker authorization |
| POST `B/authorization` | `{owner_revision,request_uuid}` | Same DTO; only an explicit missing authorization before the audio manifest permits creation |
| POST `B/batch` | `{owner_revision,seal_base64,pages_base64:[...]}` | `{profile,state,revision,marker_count}`; 202 is pending. Completed 200 also includes `marker_completion_receipt_base64` and `marker_completion_receipt_sha256` |
| GET `B` | `owner_revision`, pinned positive decimal `revision`, optional `after_sequence` (default 0), `limit` (default 100, maximum 1000) | Verified marker page or scalar pending/unsupported state; display data never authorizes deletion |

The existing audio session status also returns the optional final marker
receipt and its SHA-256. Obtain the separate audio receipt through the existing
audio completion path. A 200 response alone is insufficient: validate and retain
both exact signed documents. Exact batch retries recover the same completion
bytes; changing retained ciphertext under an existing identity conflicts.

Current firmware exports a single physical segment: canonical snapshot size is
`128 + 52 * marker_count` (36-byte header plus one 92-byte SegmentRef). There is
at least one page even for zero markers. Each page carries at most 186 snapshot
bytes, so kind3 length is `216 + page_bytes`, at most 402. The seal is 200 bytes.
BLE allows at most 4096 pages plus one seal. Signed limits, local memory bounds
and page-count limits all apply; the server's larger generic HTTP document
ceiling does not enlarge the firmware's bounds.

## Durable completion and recovery

1. On kind6 blob COMMIT, authenticate both receipts against the exact capture,
   owner, snapshot, seal and publication; flush the authenticated local terminal
   and read it back before returning a successful blob RESULT.
2. CONFIRM checks the exact transfer/session identity and original 336-byte
   audio-receipt hash, re-reads the authenticated terminal and rechecks ownership.
   Only then may firmware remove the payload and subsequently its sidecars.
3. A disconnect after COMMIT but before CONFIRM leaves durable proof for recovery.
   It is not permission to infer deletion from a lost RESULT. Recover through
   the exact-session v2 checkpoint/receipt flow. A missing or corrupt terminal
   retains the payload. The expiry exception applies only to an already
   authenticated durable terminal, never arbitrary expired receipts.
4. Failure after payload deletion may leave sidecars for idempotent cleanup.
   Absence of a response is ambiguous; retain evidence and reconcile. Never
   issue legacy deletion or fall back to audio-only completion for a marked file.

The current firmware's `.MRK` journal, `.MXP` cached export and `.MCT` terminal
are private at-rest files, not formats an App should parse. A replacement
firmware storage adapter must provide authenticated identity binding, atomic
or recoverable flush/read-back and power-loss-safe cleanup with the same proof
invariants. A missing journal never represents a verified empty marker set.
