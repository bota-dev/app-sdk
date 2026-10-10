# Firmware Protocol Reference — Bota App SDK

This is the all-English, App-facing firmware integration reference for Bota App
SDK (`@bota.dev/react-native-app-sdk`, `BotaAppSDK`, and `dev.bota:bota-app-sdk`).
New SDK development belongs in this repository. The retired
`bota-dev/react-native-sdk` repository is retained as migration history.

This edition covers recording control and the #201 recording-marker extension:
marked BATCH transfer, the App boundary and the device HTTP contract of protected
direct STREAMING. It retains the existing GATT allocations and ordinary v2 transport. It is not a
complete reference for provisioning, OTA or every other device service.

## Integration Documents

Read this entry point for behavior, BLE allocation and SDK/App boundaries, then:

- [Marker security and binary format](docs/firmware/recording-markers-security.md): context, marker bodies, encryption, signature domains, BATCH HTTP and durable recovery.
- [Protected direct STREAMING](docs/firmware/protected-streaming.md): device admission, key grant, audio/marker ACKs, all HTTP endpoints, retry/expiry and final proofs.
- [Interoperability fixtures](docs/firmware/vectors/README.md): downloadable test-only bytes, verification command and required rejection cases.

These appendices are part of this contract and keep transport delivery, durable
marker acceptance, final publication and local deletion as separate outcomes.

## Availability and Compatibility

The marker contract is an integration-development specification checked against
the #201 firmware/native SDK implementation. This documentation-only change does
not include that implementation, publish packages, enable a firmware profile or
prove target-binary compatibility. Published App SDK `2.0.0-beta.14` does not
contain the new marked-transfer/native-status implementation described here.
Integrators need matching qualified firmware, backend and native SDK/App builds;
service discovery alone must not enable a marked transfer.

Ordinary unmarked v2 messages remain unchanged. Protected STREAMING is disabled
by default and has no new BLE audio relay in this scope. A device can perform
protected direct capture with existing App start/stop controls when firmware and
backend admission permit it; that does not make old SDKs marked-BATCH capable.

## Recording Markers

### Recording Marker Behavior

1. Start one logical recording through the device button or authorized App control. The device owns its UUID, generation and media clock.
2. During recording, each valid short press creates one marker. Nominal short press is 40ms ≤ duration < 750ms, dispatched on qualified release; long press starts/stops according to device state. Separate short presses remain distinct even at the same media time. There is no App command to create/edit a marker in this scope.
3. Record the marker ID, sequence and original-audio media offset. Successful marker feedback is a 100ms white flash with no vibration. BATCH confirms after local persistence/read-back; protected STREAMING confirms only after verifying the exact backend durable marker ACK. Queue/capacity rejection does not invent a marker or damage an already persisted BATCH prefix. A late ACK after stop does not start another white flash.
4. Stop capture promptly, seal the audio and the complete marker set, including an explicit zero-marker set. Network completion is asynchronous.
5. The backend verifies and publishes the audio and marker snapshot together. Playback seeks the original audio; AI freezes the sealed revision/hash and transcript version for annotations and summary attention hints.
6. BATCH deletes local payload only after exact audio + marker completion proofs and authenticated durable local terminal read-back. Protected STREAMING has no durable local recording to delete; pending RAM is not a power-loss backup.

| Mode | Capture/storage | Upload owner | Marker-success evidence | Completion |
| --- | --- | --- | --- | --- |
| BATCH | Encrypted local audio and protected marker journal | Firmware Wi-Fi/4G or native SDK BLE relay under one authorized owner | Verified local persistence | Backend dual proofs plus local terminal persistence before deletion |
| Protected STREAMING | Bounded encrypted RAM; no durable recording copy | Firmware Wi-Fi/4G direct worker | Exact signed backend marker ACK | Verify final audio proof, marker proof and exact snapshot; App JSON is informational |

The thresholds describe recording-marker input, not a new remote marker command.
Device state and authorization still decide whether a start/stop request is
allowed.

### Recording Control and Status

Use the existing secure connection/binding and a valid recording-scope grant.
Connection alone grants no recording or upload permission. The native SDK should
own GATT operations; an App should not handcraft signed material in JavaScript.

UUIDs below are complete: replace `xxxx` in
`B07A0002-xxxx-1000-8000-00805F9B34FB` or `B07A0004-xxxx-1000-8000-00805F9B34FB`
with the listed four hex digits.

| Service / characteristic | Direction / use |
| --- | --- |
| `B07A0002 / 0001` DEVICE_STATUS | Device status; native `getStatus().flags.syncActive` reports upload ownership |
| `B07A0002 / 0002` RECORDING_CONTROL | App → device: one-byte `10` hex START or `11` hex STOP, after existing grant admission |
| `B07A0002 / 0003` RECORDING_STATUS | Device → App: read/notify activity snapshot or result notification |
| `B07A0004 / 0006` CAPABILITIES_V2 | Read existing 24-byte transfer capability document and enforce resource ceilings |
| `B07A0004 / 0007` SIGNED_BLOB_V2 | App → device signed opaque bundle transport; receive result through the existing characteristic mechanism |
| `B07A0004 / 0008` CONTROL_V2 | App → device transfer commands |
| `B07A0004 / 0009` TRANSFER_V2 | Device → App audio, manifest, marker chunks and EOF |
| `B07A0004 / 000A` STATUS_V2 | Existing transfer status |
| `B07A0004 / 000B` LIST_V2 | Recording directory results |
| `B07A0004 / 000C` UPLOAD_CONTEXT_V2 | Existing authenticated upload-context exchange |

The compatibility API uses `requestStartRecording` / `requestStopRecording`.
Device dispatch goes through `ble_recording_control → orchestrator → recorder`;
enabled protected mode enters the direct worker after admission. Protected
ownership is established before recording=true is notified.

RECORDING_STATUS has two distinct packet shapes:

| Length | Bytes | Meaning |
| --- | --- | --- |
| 18 | active u8@0; initiated_by u8@1; UUID[16]@2 | Activity/recording identity. Current firmware writes initiated_by=0, so do not use it to infer actual button versus App origin. |
| 6 | active u8@0; zero bytes@1..4; result u8@5 | Command result. Never interpret byte 5 of an 18-byte snapshot as a result. |

Result values: `00` success, `01` error, `02` already recording, `03` not
recording, `04` invalid grant, `05` grant expired, `06` invalid state. These are
recording-control results, not marker persistence or upload completion proofs. A
successful control ATT write alone is not confirmation that capture
started/stopped.

### Marked BATCH Transfer

Reuse the existing encrypted-upload-v2 transfer. Transport integers in the
tables below are little-endian; this does **not** override endian rules inside
signed/encrypted documents. Keep those bytes opaque. UUIDs use RFC byte order;
never transmit a C struct. JSON u64 values remain decimal strings, not
JavaScript numbers.

Existing CONTROL_V2 message codes: `20` START, `21` WINDOW_ACK, `22`
RESUME_REQUEST, `23` CONFIRM, `24` ABORT, `25` LIST (hex). The common 12-byte
header is message type u8@0, protocol version u8@1, flags u16@2, transport
session ID u64@4. The transport ID is not the backend session UUID.

1. Read capabilities and establish the existing authorized upload context/owner.
2. Send LIST with `request_flags` u32@12 bit0 set to include marked entries; total LIST length is 16 bytes. Legacy flags=0 omits marked recordings.
3. A 96-byte directory entry has `completion_state=2` at byte 33 for marked recordings; native maps this to `markersRequired=true`. This means the audio is locally committed and marker metadata is required, **not** that cloud completion permits deletion.
4. Native provider first GETs saved marker authorization. Only an explicit pre-manifest 404 permits new admission; 403/409/5xx must not open another owner.
5. Send blob kind 5: audio authorization408 + capture context176 + marker authorization280 = **864 bytes**. It must match the exact recording/generation/session/owner and negotiated limits.
6. Transfer encrypted audio/manifest and all marker documents. Marker chunks are emitted before EOF. New START/RESUME replays the metadata; preserve exact documents and request identities.
7. After the audio manifest, submit the encrypted marker seal/pages to the backend. Await both durable final receipts. Send blob kind 6: audio receipt336 + marker receipt296 = **632 bytes**, then the existing CONFIRM flow. Keep existing audio-prefix hash semantics: hash the audio 408/336-byte prefix where required, not the whole marked bundle.
8. During kind6 COMMIT, firmware verifies signatures, context, owner and exact content, then persists/read-backs its authenticated local terminal before successful blob RESULT. CONFIRM separately rechecks identity and that terminal before deleting audio and subsequently sidecars. Incomplete/conflicting proof keeps the payload.

Signed blob wrapper (existing transport): BEGIN `60`, DATA `61`, COMMIT `62`,
ABORT `63`, RESULT `64` (hex). Common prefix: code/version/kind/reserved=0 at
bytes0..3, write_id u32@4. BEGIN length42 adds total_length u16@8 and
SHA256[32]@10; DATA adds offset u16@8, chunk_length u16@10 and bytes@12;
COMMIT/ABORT length8; RESULT length10 adds result u16@8. Enforce
write/session/connection identity, exact length/hash and negotiated MTU.
Fragment reception or blob RESULT is not a backend persistence proof.

### Marked Authorization, START and CONFIRM

All offsets below are absolute byte offsets. Transfer headers use protocol
version `2`; reserved fields and undefined flags are zero. Size checks precede
allocation. Before writing kind5, require maximum_signed_blob_bytes >= 864;
kind6 requires >= 632. Do not send a shortened bundle if the device cannot fit
it. The blob's SHA-256 covers the entire bundle, while START/CONFIRM retain
their original audio-prefix hashes.

| Bundle | Offset | Length | Opaque component |
| --- | ---: | ---: | --- |
| kind5 | 0 | 408 | Original audio authorization |
| kind5 | 408 | 176 | Capture identity/context |
| kind5 | 584 | 280 | Marker authorization, BOTAMRK1 kind `0x1003` |
| kind6 | 0 | 336 | Original audio completion receipt |
| kind6 | 336 | 296 | Marker logical completion, BOTAMRK1 kind `0x1002` |

Native SDKs relay these documents without possessing device/recipient keys.
Marker durable ACK kind `0x1001` is 208 bytes and cannot substitute for kind6.
Metadata document kinds are not CONTROL_V2 opcodes. Preserve the complete
backend-supplied bytes, including the request UUID, context digest and
signature; do not serialize parsed JSON back into a replacement document.

START (`0x20`, 128 bytes) uses the common 12-byte header followed by:

| Offset | Length | Field |
| --- | ---: | --- |
| 12 | 16 | Backend upload_session_uuid |
| 28 | 16 | recording_uuid |
| 44 | 4 | recording_generation u32LE |
| 48 | 32 | SHA-256 of the 408-byte audio authorization prefix |
| 80 | 4 | checkpoint_revision u32LE |
| 84 | 8 | next_ciphertext_offset u64LE |
| 92 | 32 | Persisted ciphertext prefix SHA-256 |
| 124 | 2 | window_packets u16LE |
| 126 | 2 | data_payload_bytes u16LE |

Require the existing exact 140-byte START_ACK and ATT MTU >= 143. A fresh
transfer uses revision/offset zero and SHA-256(empty) for its prefix. Resume
uses the durable checkpoint flow; do not infer a new owner from a transport ID.

CONFIRM (`0x23`, 84 bytes) uses the common header followed by:

| Offset | Length | Field |
| --- | ---: | --- |
| 12 | 16 | Backend upload_session_uuid |
| 28 | 16 | recording_uuid |
| 44 | 4 | recording_generation u32LE |
| 48 | 4 | owner_revision u32LE |
| 52 | 32 | SHA-256 of the 336-byte audio receipt prefix |

Subscribe to completion STATUS_V2 and ERROR on TRANSFER_V2 before CONFIRM.
Uncertain confirmation retains the checkpoint and both receipts for recovery;
never send legacy `0x07`, discard evidence or assume an error proves no deletion
occurred. A changed binding/connection/account invalidates stale callbacks.
Owner replacement is only through an authorized pre-manifest successor, with a
new session and increased owner revision. Marker IDs and content remain fixed.

```text
App/native -> Device: existing upload context; LIST(request_flags=1)
Device -> App/native: marked entry(completion_state=2), list end
App/native <-> Backend: recover/create exact marker authorization
App/native -> Device: signed blob kind5(864), START(128)
Device -> App/native: START_ACK(140), audio windows, manifest
App/native -> Device: durable-checkpoint WINDOW_ACK for each audio window
Device -> App/native: MARKER_CHUNK(0x4A): seal + all pages; EOF
App/native -> Backend: finalize audio manifest and submit exact marker batch
Backend -> App/native: final audio336 + marker296 receipts
App/native -> Device: signed blob kind6(632), COMMIT
Device: verify both receipts -> persist/read-back authenticated local terminal
Device -> App/native: signed-blob RESULT
App/native -> Device: CONFIRM(84)
Device: recheck exact identity + persisted terminal -> cleanup
Device -> App/native: exact-session completion result
```

### Marker Document Fragment (`0x4A`)

Device → native SDK on TRANSFER_V2. Minimum frame61 bytes; fixed header60 plus
at least one payload byte. One exact encrypted document per reassembly slot.

| Offset | Width | Field |
| --- | --- | --- |
| 0 | 1 | message_type=`0x4A` |
| 1 | 1 | protocol_version=`2` |
| 2 | 2 | flags |
| 4 | 8 | transport session_id |
| 12 | 4 | document_index, zero-based; 0 is seal, remaining indices are pages |
| 16 | 4 | document_count including seal; current bounds 2..4097 |
| 20 | 2 | chunk_offset in this document |
| 22 | 2 | document_length; current marked export bounds 200..402 |
| 24 | 2 | chunk_length |
| 26 | 2 | reserved=0 |
| 28 | 32 | SHA-256 of exact complete encrypted document |
| 60 | chunk_length | encrypted bytes |

Validate identity, index/count, offset/length overflow, permitted size,
contiguous coverage and hash; accept only byte-identical duplicate fragments.
Reject missing/changed/foreign fragments and preserve local evidence. Native
cannot decrypt the recipient envelope; successful reassembly does not
authenticate cloud persistence. Do not forward raw signed bundles/pages to JS.

This extension uses the existing v2 directory, kind5/kind6 and `0x4A`. It does
not allocate a separate INFO/READ/CHANGED GATT service or a BLE command to
create/edit markers. Document kinds and transport message codes occupy different
namespaces.

### Protected STREAMING and App Reads

App still uses the existing BLE start/stop commands. The firmware performs HTTP
START/grant verification, audio/marker upload, ACK verification, stop/seal and
finalization/refresh. This scope adds no BLE audio/marker write relay for
protected STREAMING.

Before either legacy App streaming entry point starts a relay, read fresh device
status and require `syncActive === false`. True, missing or failed reads cannot
select legacy relay. Firmware also rejects old BLE transfer starts during
protected ownership (`UPLOAD_BUSY`, hex20). Do not promise later BATCH recovery
for RAM-only capture.

App reads through its authorized Dashboard project context:

- `GET /dashboard/projects/:projectId/recordings/:id/streaming-status?session_id=:sid`: scalar progress. Revision/owner epoch are decimal strings. `open/sealing/sealed/aborted` describe marker metadata; sealed is not audio completion.
- `GET /dashboard/projects/:projectId/recordings/:id/markers`: published marker playback. Keep the returned revision for subsequent pages; seek original audio using exact media offsets. Pending, unsupported and verified-empty are distinct.
- New native SDK `createProtectedStreamingStatusBackend(options).getStatus(identity)` is an optional read facade requiring a matching native binary. Identity contains recordingId, sessionId, recordingGeneration and string writerEpoch. Demo currently uses its Dashboard API instead of importing this unpublished facade.

The device-only direct HTTP profile is separate from the App-facing BLE
protocol and is specified in the [direct STREAMING appendix](docs/firmware/protected-streaming.md).
Apps must not call its write endpoints with application credentials.
Its final response carries an audio296 proof, marker296 proof and exact
canonical snapshot; these are not the BATCH 632-byte receipt bundle. No signed
proof/key is part of the new JS status interface.

### Integration Verification

Verify: marked LIST negotiation; 864-byte admission; interrupted/replayed `0x4A`
and missing EOF documents; exact 632-byte receipts; wrong-owner rejection;
durable-terminal-before-delete; ordinary unmarked compatibility; 6/18-byte
recording status distinction; protected direct versus legacy BLE ownership;
pending versus final playback; account/project/binding changes cancelling stale
results.

This source contract was checked against the #201 firmware control/status/transfer
implementations and SDK protocol manifest/native providers. Integration acceptance
requires matching firmware/backend/native SDK builds, known-good wire fixtures
and negative cases. The implementation and release gates remain separate from
this documentation-only change.

Remaining delivery: target firmware/mobile builds and joint runtime validation;
WRGB board driver requires LED part, pins, polarity/control and calibration
facts. The logical marker feedback and protocol do not establish physical LED
operation. No deployment or feature activation is authorized by this document.
