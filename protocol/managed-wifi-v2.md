# Cloud-initiated enterprise WiFi v2

Contract: `managed-wifi-v2-2026-11-13`. Unreleased direct-cloud firmware
integration contract; no SDK runtime, BLE service or relay changes. This file
owns the v2 wire contract. The [heartbeat API reference](https://docs.bota.dev/api-reference/devices/heartbeat)
describes API behavior; publication, backend deployment, external receiver
implementation and physical acceptance are separate stages.

## Delivery and compatibility

After activation, use the existing authenticated device-token HTTPS heartbeat.
No initial `managed_wifi` request field, capability or nonce is required.
The cloud can return `managed_wifi: {version:2, revision, envelope}`. Unknown
optional response versions are ignored without breaking normal heartbeat.
Malformed or unknown-version request extensions do not prevent v2 delivery.
A valid legacy v1 nonce offer selects the unchanged v1 response path.

Only the exact authenticated direct device can receive credentials. App and
project-key relays cannot. No prior managed list means no extension; removing
an existing list requires a newer explicit empty snapshot. An absent field or
failed request never deletes profiles. Completely offline devices must regain
direct connectivity before this mechanism can deliver anything.

## Cryptography and wire layout

`envelope` is standard Base64 of `enc65 || ciphertext || tag16`. HPKE uses
DHKEM(P-256, HKDF-SHA256), HKDF-SHA256 and ChaCha20-Poly1305, with empty info and
AAD. The recipient is the pinned device P-256 key. The encrypted plaintext is
`body || signature64`; the backend signs the entire body with ECDSA P-256/SHA256,
encoded as IEEE P1363 `r || s`. The device pins the correct environment's backend
signing key. The signed magic separates this protocol from other grants.

All integers below are unsigned big-endian. The header is 80 bytes:

| Offset | Size | Value |
| --- | --- | --- |
| 0 | 8 | ASCII `BOTAWIF2` |
| 8 | 16 | Nonzero random cloud delivery ID, not a device challenge |
| 24 | 32 | Current device credential commitment |
| 56 | 4 | Current binding generation > 0 |
| 60 | 4 | Desired revision, 1..2147483647 |
| 64 | 4 | Issued UTC seconds |
| 68 | 4 | Expiry UTC seconds, issued + 60 |
| 72 | 1 | Profile count N, 0..40 |
| 73 | 7 | Zero reserved bytes |

Each profile at offset `80 + 119*i` has:

| Relative offset | Size | Value |
| --- | --- | --- |
| 0 | 16 | Nonzero profile ID |
| 16 | 4 | Profile version, 1..2147483647 |
| 20 | 32 | UTF-8 SSID bytes, zero padded |
| 52 | 64 | ASCII password bytes, zero padded |
| 116 | 1 | SSID byte length, 1..32; embedded NUL forbidden |
| 117 | 1 | Password length, 8..63 printable ASCII or 64 hexadecimal characters |
| 118 | 1 | Security = 1, WPA2 Personal |

IDs and SSIDs are unique within a snapshot. List order is connection order;
there is no priority field. Reject malformed UTF-8, invalid padding, unknown
security and any invalid profile before changing state. Body length must equal
`80 + 119*N`; binary envelope length is `225 + 119*N`, at most 4985 bytes or
6648 Base64 characters. Zero count clears the managed list only. Local/App
credentials stay separate. Current product limits are ten profiles per scope
and twenty after merging; receivers support the forty-entry wire capacity.

The credential commitment is SHA256 of ASCII `bota/enc-v2/credential/v1`, a NUL
byte, the installed token byte length as u16 little-endian, and token bytes.
Neither the delivery ID nor commitment appears outside the encrypted body.
Never log these values, passwords, envelopes or credentials.

## Validation and application

Accept only the current authenticated direct HTTPS heartbeat response, fenced
against in-flight credential/ownership changes. Verify HPKE, signature, exact
magic and lengths, reserved bytes, all profiles, current credential commitment
and binding generation. Require trusted UTC with `issued <= now < expires` and
`0 < expires-issued <= 60`. If time is unavailable/untrusted, defer application
until secure time recovery. A server-generated delivery ID alone is not freshness.

Atomically persist the snapshot, delivery ID and monotonic revision floor for
the current ownership binding. Reject older revisions or different ordered
profile content at the same revision. Identical snapshots preserve status and
rejection tombstones, avoid redundant flash writes and never force a reconnect.
Credential rotation can replace the delivery ID for the same snapshot, but
cannot reset the revision floor. Existing lifecycle isolation must prevent
former-owner profiles from reappearing. Do not acknowledge an interrupted write.

The server reuses the delivery ID for retries with fresh signed timestamps.
New desired configuration, binding or credential creates a new delivery ID.
Storage success is not proof of association or internet access. Preserve the
existing cloud/local fallback and qualified driver callback rules.

## Application receipts and recovery

After durable application, send the optional heartbeat extension:

```json
{"managed_wifi":{"version":2,"delivery_id":"01010101010101010101010101010101","binding_generation":7,"revision":3,"status_revision":10,"results":[{"id":"12121212121212121212121212121212","version":3,"state":"stored"}]}}
```

`delivery_id` is 32 lowercase hex digits, nonzero. `status_revision` is the durable
journal sequence, 1..4294967295. Results cover each current profile exactly once
with its exact version. States: `stored`, `verified`, `auth_rejected`,
`local_fallback`, `unavailable`, `dhcp_failed`. Only an empty desired snapshot
accepts `results:[]`. Do not include a nonce or claim application before storage.

After committing an exact current-delivery/credential/binding/revision report,
the server responds with `managed_wifi: {version:2, revision, status_ack:
{delivery_id,binding_generation,status_revision}}`. Firmware checks the exact
current request and credential epoch before accepting it. Lost ACKs retain full
report retries; duplicate reports are idempotent. Older status and conflicting
same-sequence results cannot overwrite saved evidence.

After ACK, omit `results` but retain the other fields. Matching compact receipts
may receive no extension. `status_required` carries the same receipt fields and
requests a complete report. Reboot sends a full report again; ACK bookkeeping
itself requires no flash write. If local state is missing/mismatched, the server
redelivers the snapshot even after an earlier ACK. Missing responses never clear
saved configuration or authorize a radio action.

## Interoperability and qualification

The [frozen synthetic vector](vectors/managed-wifi-v2.json) contains public test
keys, exact plaintext and ciphertext; it is byte-identical to the backend test
fixture. It proves cryptographic/layout interoperability only. Its old timestamps
must fail current-time admission unless a test clock is explicitly controlled.

External firmware qualification must cover unknown-version ignore, lost
responses/ACKs, reboot, stale replay, equal-revision conflicts, token rotation,
binding replacement, empty removal, trusted-time loss and interrupted atomic
storage. Apply the backend's additive migration before its writer. No firmware
capability flag or version allowlist is a prerequisite for cloud delivery.
