# Protected Direct STREAMING Firmware Contract

This appendix to [FIRMWARE_PROTOCOL.md](../../FIRMWARE_PROTOCOL.md) describes
`recording_markers_stream_v1`: device Wi-Fi/4G HTTP capture with bounded RAM,
without a durable local recording. It uses existing BLE start/stop control; no
BLE audio/marker relay, remote marker creation or new live-marker notification
is allocated. The ordinary unmarked and marked BATCH profiles stay separate.

Read [marker security](recording-markers-security.md) for CaptureIdentityV1,
BOTAMRK1 marker requests, snapshots and signatures. The backend generates a
fresh 32-byte K_stream, stores it encrypted and delivers it only to the enrolled
device's P-256 key. A phone may not choose that key or obtain K_stream. The
origin guarantee protects against an untrusted App/relay, not the trusted backend.
The feature remains disabled until matching qualified builds and cohort policy
permit it; this document does not activate it.

## Common encoding

All integer fields below are unsigned little-endian unless explicitly stated; UUIDs are raw 16 bytes, nonzero where identities are required. Times are Unix seconds. Digests are 32 bytes. u64 values must fit the existing signed-database/client bound before conversion. Domains below are exact ASCII followed by one NUL. Unknown versions/kinds/reserved bits/lengths are rejected before allocation.

The stream header `SHeader` is 64 bytes: magic `BOTASTR1` at 0 (8), version=1 at 8 (u16), kind at 10 (u16), total document length at 12 (u32), request UUID at 16 (16), marker-compatible context digest at 32 (32). It is NOT a BOTAMRK1 document despite sharing offsets.

Context remains the existing 176-byte CaptureIdentityV1 with mode=2. Backend constructs it from authoritative identity and recording admission; device compares all local capture identities. STREAMING starts only after this admission and key grant succeed. No silent fallback to legacy dual-write recording. BATCH remains available through its own explicit mode.

## Stream authorization — kind 0x1100, 468 bytes

Document = SHeader[64] + body[340] + raw low-S P-256 signature[64]. Sign `BOTA-STREAM-AUTH-V1\0 || header || body`, using the existing upload signing-key registry and trusted-time rules.

| Body offset | Bytes | Field |
|---:|---:|---|
| 0 | 176 | Complete CaptureIdentityV1, mode=2 |
| 176 | 16 | Marker HPKE X25519 recipient UUID |
| 192 | 32 | Marker HPKE X25519 recipient public key |
| 224 | 16 | Fresh device-generated RAM capture nonce |
| 240 | 4 | signing_key_id |
| 244 | 8 | issued_at |
| 252 | 8 | expires_at |
| 260 | 32 | canonical effective policy digest |
| 292 | 4 | max_audio_chunk_bytes (plaintext) |
| 296 | 4 | max_pending_audio_chunks |
| 300 | 4 | max_pending_markers |
| 304 | 4 | max_markers |
| 308 | 8 | max_audio_plaintext_bytes |
| 316 | 8 | max_media_duration_ms |
| 324 | 4 | foreground_stop_wait_ms |
| 328 | 4 | max_document_bytes (complete document) |
| 332 | 8 | max_canonical_snapshot_bytes |

All limits are positive. max_document_bytes must be at least 468; max_audio_chunk_bytes must be no greater than max_document_bytes−144 or max_audio_plaintext_bytes; max_pending_markers must not exceed max_markers; canonical snapshot capacity must cover the complete negotiated marker set: `max_canonical_snapshot_bytes >= 128 + 52 × max_markers` (calculate in u64). Negotiation reduces max_markers to fit this capacity and then clamps max_pending_markers; a device rejects an inconsistent signed grant before capture. These are wire/implementation validity conditions, not production defaults. Limits are bounded by the intersection of server policy, negotiated firmware capability and firmware compile-time ceilings; no production numeric default is invented here. Device verifies before allocating. The policy digest uses the existing canonical configuration-digest serialization mechanism; the admitted policy record must retain the exact canonical bytes and include codec/profile, retry/Retry-After behavior, trusted-time rules, authorization lifetime and limits. A digest alone without the exact immutable policy record is insufficient. STOP wait exhaustion changes UI to pending; it does not discard RAM or claim completion. Authorization expiry never grants indefinite retention: stop new capture before the admitted limit/expiry, preserve recoverable cloud facts, and report partial if the bounded active session cannot finish.

## Device-only key grant — 257 bytes

The opaque grant is `HPKE enc[65] || ciphertext[192]`. HPKE is the P-256 Base suite (KEM 0x0010, KDF 0x0001, AEAD 0x0003), NOT X25519; the 65-byte encapsulated key is an uncompressed P-256 point. Plaintext before signature is 112 bytes: SHA256(complete StreamAuthorization)[32], context_digest[32], device RAM nonce[16], K_stream[32]. Append raw low-S backend signature[64] over `BOTA-STREAM-KEY-PAYLOAD-V1\0 || plaintext112`.

HPKE info = `BOTA-STREAM-KEY-GRANT-V1\0 || SHA256(complete StreamAuthorization)`; AAD = context_digest. Backend uses authoritative stored `pk_d`. Firmware separately verifies the stream authorization, then decrypts the grant, checks its signature and every duplicated binding, and only then installs a private active handle. The trusted RAM capture owner must atomically consume its nonce/generation once, after cryptographic verification and before exposing a handle. The security-open API rejects a second open while preserving the existing live handle; a retransmitting caller reuses that handle rather than reopening it. Disposing a handle does not authorize reuse of the consumed nonce. Claiming the one audio producer is also one-shot; initialization failure cannot reset its nonce counter. A changed grant for the same live capture is rejected. Private-key copies, temporary symmetric keys and intermediate buffers are cleared on all exit paths. Backend storage uses envelope encryption with project/session associated data; plaintext keys must never be stored in logs or returned in API JSON. A key-ref row is not proof of successful cloud publication.

Derivations: HKDF-SHA256 with salt=context_digest, IKM=K_stream. Audio info=`BOTA-STREAM-AUDIO-KEY-V1\0`, stop info=`BOTA-STREAM-STOP-KEY-V1\0`, both output32. Marker authentication uses the existing `BOTA-MARKER-AUTH-KEY-V1\0` derivation unchanged, treating the private handle's K_stream as its input. Audio and marker HPKE randomness/keys never share a nonce space.

## Audio documents and stop intent

Audio kind=0x0001: SHeader[64] + metadata[64] + ChaCha20-Poly1305 ciphertext[plaintext_length+16]. Complete size=144+plaintext_length. Metadata is AAD together with the complete SHeader:

| Metadata offset | Bytes | Field |
|---:|---:|---|
| 0 | 4 | chunk index, contiguous from 1 |
| 4 | 8 | cumulative plaintext byte offset |
| 12 | 4 | plaintext length, positive |
| 16 | 8 | media_start_ms |
| 24 | 8 | media_end_ms |
| 32 | 32 | previous audio input chain |

Chunk index is u32 in 1..0xffffffff; nonce encoding widens that exact value to u64 without allowing a larger index. Reaching the index ceiling stops new input before wraparound. Audio nonce = zero[4] + u64LE(chunk index). The key is unique to the admitted context. Each index is encrypted once; pending queue stores exact bytes/request UUID and retries those bytes. Never encrypt changed content/header at an existing index. Overflow, lost RAM chunk, insufficient queue capacity or index exhaustion makes the capture incomplete; it cannot be repaired by skipping data or restarting index 1. A new recording obtains fresh UUID, nonce, context and key. Backend dedup compares complete document digest, identity, index and authenticated plaintext facts; conflict=409, never overwrite.

Audio chain H0 = SHA256(`BOTA-STREAM-AUDIO-CHAIN-INIT-V1\0` + recording UUID + u32LE(recording_generation) + device identity digest). Hi = SHA256(`BOTA-STREAM-AUDIO-CHAIN-V1\0` + metadata64 + SHA256(plaintext chunk)). Validate previous chain, byte continuity and monotonically valid media bounds. Audio is a single negotiated encoded media stream; chunk boundaries need not be independently playable. Durable transport ACK does not assert complete media validity.

Audio stop kind=0x0002: SHeader[64] + encrypted body88 + AEAD tag16, total168. Body: chunk_count u32, last_index u32, total_plaintext_bytes u64, final_media_duration_ms u64, final_audio_chain[32], complete_plaintext_sha256[32]. Encrypt with the separate stop key, nonce=zero[12], AAD=SHeader. Exactly one immutable stop document may be produced per context; retries reuse its exact bytes. Count=last_index. Empty media cannot become a playable publication. Firmware must prepare/freeze the one stop body before encryption and never regenerate different stop content after an uncertain response.

This stop intent is independent of existing BOTAMRK1 kind2 marker seal. Both must bind the same context and final media endpoint. Stopping capture does not wait for networking. Backend assembles verified chunks, checks full stream SHA/length/chain and decoder-derived validity/duration against the admitted codec policy; no receipt is signed from self-reported metadata alone.

## Final audio proof — kind 0x1101, 296 bytes

SHeader[64] + body[168] + signature[64], domain `BOTA-STREAM-AUDIO-COMPLETE-V1\0`. Header request UUID equals the accepted audio-stop request UUID. Body offsets: signing key0:u32, issued4:u64, expires12:u64, chunk_count20:u32, plaintext_bytes24:u64, duration_ms32:u64, plaintext_sha25640:32, final_audio_chain72:32, exact_audio_stop_document_sha256104:32, publication_identity_digest136:32.

Sign only after verified immutable media object/reference and final audio facts are durably committed under live recording/ownership fences. Persist the first full proof bytes; retries/query replay exactly. The backend computes the publication identity from immutable publication facts. Firmware checks that the audio and marker proofs carry the same signed publication digest, alongside the complete context, exact stop documents and snapshot; it must not substitute a URL or arbitrary worker JSON.

Use `audio_proof_kind=2` in a **separate STREAMING logical-completion validator/issuer**. BOTAMRK1 0x1002 still has body168/total296; its audio-proof digest binds the entire 296-byte stream audio proof and metadata-seal digest binds exact marker-stop bytes. Snapshot hash binds the canonical final snapshot, not an ACK list. BATCH kind1 still only accepts its original 336-byte audio proof; never widen that validator. Audio proof alone means verified cloud audio, not complete marker-required publication. Public logical completion remains gated on both proofs, final marker set and retained object reference. No local-delete operation exists for this no-local-copy profile.


## Durable audio ACK — kind 0x1102, 224 bytes

`SHeader[64] || body[96] || raw64 signature`, signed with domain
`BOTA-STREAM-AUDIO-ACCEPT-V1` plus NUL. Body offsets: signing_key_id u32@0,
issued_seconds u64@4, expires_seconds u64@12, chunk_index u32@20,
SHA256(exact audio document)[32]@24, resulting_audio_chain[32]@56,
committed_revision u64@88. Revision is positive. Request UUID, context, index,
document hash and resulting chain must match the retained pending chunk.

Verify the signature against the admission's retained key ID and trusted time;
ACK validity must remain inside the capture grant. Only this verified ACK
permits releasing that pending audio buffer. It is not final media validation,
marker confirmation or a final audio proof.

## Marker admission, ACK and seal

Marker authorization is BOTAMRK1 kind0x1003 (280 bytes). Its original-authority
hash binds the complete StreamAuthorization468. Mode is 2; recipient UUID/key,
issued/expiry times, policy digest and all marker limits must equal the signed
stream authority. Use a separate validator from BATCH mode1.

For each admitted press, produce BOTAMRK1 kind1 (228 bytes) and retain its exact
bytes. After backend authentication and transaction commit, it returns kind0x1001
(208 bytes). Verify request UUID, complete context, marker UUID/sequence/digest,
positive revision, retained grant signing key, signature and validity interval
before confirming. A marker ACK may arrive before audio: it proves durable
metadata only. Exact retries return the saved ACK without incrementing revision.
Do not regenerate ciphertext or request UUID after response loss.

ACK verification confirms at most once. A late ACK after stop updates counts but
does not trigger another white flash. An expired historical ACK remains a cloud
fact; it cannot renew capture or authorize foreground success feedback.

On stop, freeze one kind2 marker seal (200 bytes), including **all admitted
presses**, even unacknowledged ones. Count must equal last sequence. Missing
members may fill declared gaps, but later new events outside the final set are
rejected. An explicit zero-marker seal uses the initial marker chain and the
same final media endpoint as audio stop. Do not manufacture a seal on timeout
or power loss. Finalization requires the complete authenticated set and verified
media, not merely the received subset.

## Device HTTP API

All operations below require `Authorization: Bearer <device_token>` for the
current device/end-user binding and recording scope. Application login/API
credentials cannot call these device-only writes. Use the configured HTTPS API
origin. START uses `Content-Type: application/json`; encrypted document uploads
use `application/octet-stream`. Binary transport is bounded at 65,536 bytes and
further restricted by signed limits. Responses are naked JSON, with no `data`
wrapper. Opaque fields use standard padded Base64.

### START request and admission

`POST /v1/recordings/streaming-sessions` returns 200 only after admission.
Required request properties:

| Property | Format |
| --- | --- |
| recording_uuid | Device-owned canonical lowercase UUID, version 1..5 and RFC variant |
| recording_generation | Integer 1..4294967295 |
| writer_id | Stable canonical lowercase UUID for this admission attempt |
| device_nonce | Fresh nonzero 16-byte RAM nonce, encoded as 32 lowercase hex characters |
| profile_digest | Lowercase SHA-256 of the exact canonical profile JSON below |
| capabilities | Object containing every limit below; values are positive JSON integers |

Optional properties: `name` (at most 255 characters), `recorded_at` (ISO datetime),
`metadata` (JSON object, at most 4096 encoded bytes), `upload_method`
(`ble|wifi_direct|4g_direct|import|unknown`; direct firmware uses its actual
transport). Unknown properties are rejected. Do not send a server `recording_id`,
project ID, keys or signer identity as caller authority.

Canonical profile bytes are UTF-8 of this single line, with no trailing newline:

```json
{"channels":1,"codec_config_hex":"","crypto_profile":"recording_markers_stream_v1","media_profile":"ogg-opus-mono.v1","sample_rate":48000}
```

The resulting `profile_digest` is `340e3ebc260c6e1faa849f3cafac9c3b58918463048d0a427452046d91506a2c`.

Canonical JSON recursively sorts object keys, preserves array order and uses
compact JSON with no whitespace. The effective policy is a separate canonical
record retained by the backend; its digest is not this profile digest.

| Capability | HTTP schema ceiling (not a production default) |
| --- | --- |
| max_audio_chunk_bytes | 65392; also <= max_document_bytes - 144 and total plaintext limit |
| max_pending_audio_chunks | 4096 |
| max_pending_markers | 4096; also <= max_markers |
| max_markers | 65535 |
| max_audio_plaintext_bytes | 655360000 |
| max_media_duration_ms | 9007199254740991 (safe JSON integer) |
| foreground_stop_wait_ms | 4294967295 |
| max_document_bytes | 468..65536 |
| max_canonical_snapshot_bytes | 128..4194304 |

These capability inputs are JSON numbers because the schema bounds them to safe
integers. Binary u64 fields and returned u64 facts use decimal strings in JSON.
Advertise actual firmware resources, which can be much lower. Admission takes
component-wise minima with configured server limits, reduces max_markers to
`floor((max_canonical_snapshot_bytes - 128) / 52)`, then clamps pending markers.
A zero or inconsistent result fails admission. Validate signed returned bounds
against local ceilings before allocating or starting capture.

START response:

```text
{ profile: "recording_markers_stream_v1",
  recording_id, session_id, recording_generation, writer_id, writer_epoch,
  context_base64, authorization_base64, marker_authorization_base64,
  key_grant_base64 }
```

`writer_epoch` is a positive canonical decimal string. Decoded sizes are exactly
176, 468, 280 and 257 bytes respectively. The device verifies all authority/key
bindings and its fresh nonce before starting the encoder. Retry the same START
identity, nonce and request; never create a new capture merely because its
response was lost. If session IDs are already known, GET admission recovers
persisted active authority; it does not renew it.

### Session endpoints

`P = /v1/recordings/:id/streaming-sessions/:sid`. Both IDs must match admission.

| Method/path | Request | Successful result |
| --- | --- | --- |
| GET `P/admission` | None | 200, exact saved START DTO for an unexpired active session; no renewal or terminal key recovery |
| PUT `P/audio-chunks/:index` | Exact BOTASTR1 audio document; URL index matches signed metadata, starts at 1 | 200 `{profile,state:"durable",acknowledgement_base64}` with audio ACK224 |
| POST `P/markers` | Exact BOTAMRK1 marker228 | 200 `{profile,state:"confirmed",acknowledgement_base64}` with marker ACK208 |
| GET `P/markers` | Optional query `revision`, `after_sequence=0`, `limit=100` (maximum 1000); nonzero cursor requires pinned revision | 200 marker page as below; no new ACK issuance |
| POST `P/audio-stop` | Exact BOTASTR1 stop168 | 202 audio status; not final completion |
| POST `P/marker-seal` | Exact BOTAMRK1 seal200 | 202 pending or 200 sealed **marker status**, not final completion |
| GET `P/audio-status` | None | 200 scalar audio status |
| GET `P/marker-status` | None | 200 scalar marker status |
| POST `P/finalize` | No completion facts/body required | 200 final DTO after atomic publication; response loss is recovered by exact retry |
| POST `P/completion/refresh` | No completion facts/body required | 200 final DTO for the same completed publication; explicit expired-proof renewal only |

Audio status:
`{profile,recording_id,session_id,revision,contiguous_index,plaintext_bytes,media_end_ms,stop_received,audio_chunks_complete,expected_chunks}`.
Revision/bytes/time are decimal strings. `expected_chunks` can be null before
stop. Chunk completeness does not claim media verification or publication.

Marker status:
`{profile,recording_id,session_id,recording_generation,writer_epoch,revision,received_count,contiguous_sequence,state,expected_count,authorization_expired}`.
Epoch is a positive decimal string, revision a nonnegative decimal string
(initially `"0"`); counters are 0..65535 with contiguous <= received <= expected
when expected is non-null. State is `open|sealing|sealed|aborted`. `sealed` means
metadata only and requires equal counts. This is also the shape of the App's
read-only streaming status; there are no keys, ciphertext or proofs in that DTO.

Marker page:
`{recording_id,session_id,state,revision,authorization_expired,markers,next_after_sequence}`.
Each marker contains `id,sequence,media_offset_ms,segment_index,segment_offset_ms,created_at_utc_ms,accepted_revision`;
u64/UTC values are decimal strings, absent UTC and terminal cursor are null.
Pin revision on subsequent pages; never join different revisions.

Final DTO:
`{profile,state:"completed",recording_id,session_id,audio_proof_base64,marker_completion_base64,snapshot_base64}`.
Verify audio296 and marker296, their exact cross-hashes, publication identity,
stop/seal digests and canonical snapshot. A scalar `completed` is insufficient.
A zero-marker result still contains a sealed snapshot and both proofs.

### Errors and retries

The API uses its existing error envelope; HTTP status alone never grants a
successful state. Malformed/range errors are 400, unauthorized 401, forbidden
credential/binding 403, absent scoped session or disabled START 404, identity,
content or seal conflict 409, transport ceiling 413, window pressure 429,
unavailable signer/service 503. An incomplete finalize is not a receipt; retain
the original evidence and honor the actual response status. Do not assume a
missing ACK always has a 202 polling URL.

Current direct firmware behavior is deliberately bounded:

- START performs at most three exact attempts; permanent failure ends earlier.
- Eligible response loss, server failures and 429 use global deterministic
  1/2/4/8/16/32/60-second backoff until verified success, without jitter.
  Accept only a single valid delta-seconds Retry-After, saturate it at 60 seconds
  and wait the greater of that value and backoff. Ignore HTTP-date, invalid or
  duplicate Retry-After values. Poll cancellation during waits at 100ms.
- Every non-429 HTTP 4xx stops automatic transmission and leaves an incomplete
  result. The owner waits for credential-epoch change, abort or reset; changed
  credentials retire old authority, not resume its nonce/key. Reconcile the
  cause before a fresh admitted recording. No plaintext or audio-only fallback.
- Wi-Fi/4G changes keep the same capture and exact pending documents. Check
  capture generation and credential epoch before each request; stale callbacks
  cannot update a replacement capture.
- STOP stops input promptly. Foreground wait uses the signed negotiated limit
  (the current integration caps it at 30 seconds); timeout becomes background
  pending and keeps opaque RAM buffers. It does not claim failure/success or
  erase unacknowledged data. RAM cannot survive power loss or reboot.

### Completion expiry and refresh

Stop before admitted duration/expiry; do not append new audio/markers or seal
under expired capture authority. Already stopped complete persisted inputs may
finalize after capture expiry. Final proofs have their own 3600-second validity;
this does not extend capture or white-feedback authority.

Normal finalize replays the original saved proof pair. Explicit completion
refresh reauthenticates the existing publication and appends a new issuance
only when necessary; a still-valid issuance is replayed. Context, key ID,
publication, snapshot, count and stop digests stay fixed. The marker proof must
bind the exact renewed audio-proof bytes. No upload, key restoration, capture
renewal or new foreground flash follows from refresh.

Higher-owner migration and live key replacement are unsupported in revision 1.
Reboot starts a new recording, not a resumed volatile stream. Finalization or
abort retires backend capture keys; public evidence remains for authorized
reads/refresh. Historical read access does not grant new device write authority.

## End-to-end sequence

```text
Device -> Backend: START (same UUID/generation/writer/nonce on retry)
Backend -> Device: authority468 + marker authority280 + context176 + grant257
Device: authenticate, consume nonce once, install private RAM capture handle
Device -> Backend: audio chunk; retained exact marker request on each press
Backend -> Device: signed audio ACK224 / marker ACK208 after durable commit
Device: verify exact ACK; release acknowledged buffer / confirm marker once
Device: STOP input; freeze audio stop168 and marker seal200, including zero set
Device -> Backend: drain exact pending documents, audio-stop, marker-seal
Device -> Backend: finalize after complete input is durable
Backend -> Device: final audio296 + marker296 + canonical snapshot
Device: verify both proofs and exact snapshot; retire capture state
App -> Backend: authorized scalar status / published playback reads
```

## Integration checks

Run the [public fixtures and rejection checklist](vectors/README.md). Include
response-loss replay, marker-before-audio ACK, zero-marker seal, nonce reuse,
expired capture versus final-proof expiry, refresh after key retirement,
capacity exhaustion, conflicting chunk, metadata-sealed/audio-incomplete,
credential epoch change, and legacy BLE ownership rejection. Passing software
fixtures does not qualify radio/target builds or the physical WRGB driver.
