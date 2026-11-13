# Cloud-initiated enterprise WiFi v2

Contract: `managed-wifi-v2-2026-11-13`. Unreleased direct-cloud firmware
integration contract; no SDK runtime, BLE service or relay changes. This file
owns the v2 wire contract. The [heartbeat API reference](https://docs.bota.dev/api-reference/devices/heartbeat)
describes API behavior; publication, backend deployment, external receiver
implementation and physical acceptance are separate stages.

## Delivery

After activation, use the existing authenticated device-token HTTPS heartbeat.
No initial `managed_wifi` request field, capability or nonce is required.
The cloud can return `managed_wifi: {version:2, revision, envelope}`. Unknown
optional response versions are ignored without breaking normal heartbeat.
Malformed or unknown-version request extensions do not prevent v2 delivery.
Only v2 is supported. Retired v1 nonce offers are ignored as unsupported
metadata; they cannot request a v1 envelope or acknowledge configuration.
The cloud offers the latest v2 snapshot until that device confirms durable
storage. Later ordinary heartbeats omit WiFi fields and receive no repeated
snapshot until configuration or delivery authority changes, or recovery is requested.

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
In configuration responses, the delivery ID and commitment appear only inside
the encrypted body. Later receipts and ACKs carry the delivery ID over the
authenticated HTTPS channel. Never log these values, passwords, envelopes or
credentials.

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

Save valid configuration even if its AP is unavailable, the signal is weak or
the credentials cannot currently connect. Storage confirmation does not require
a connection attempt. Preserve the current connection and local fallback; do not
discard a valid snapshot solely because network access fails.

The server reuses the delivery ID for retries with fresh signed timestamps.
New desired configuration, binding or credential creates a new delivery ID.
Storage success is not proof of association or internet access. Preserve the
existing cloud/local fallback and qualified driver callback rules.

## Durable-storage receipt and recovery

After the complete snapshot is durably saved, send this optional extension on
subsequent authenticated direct heartbeats until the server acknowledges it:

```json
{"managed_wifi":{"version":2,"delivery_id":"01010101010101010101010101010101","binding_generation":7,"revision":3,"outcome":"stored"}}
```

`delivery_id` is 32 lowercase hexadecimal digits, nonzero. The receipt identifies
the exact encrypted delivery and desired revision under the current credential
and binding. `stored` means the complete validated snapshot survived the atomic
storage boundary, including when WiFi is unreachable. Merely receiving bytes,
starting a write or connecting a network is not a storage receipt. Storage
failure leaves receipt retry disabled and the cloud continues snapshot delivery.
There are no per-profile results or status sequence fields in this protocol.

The server commits storage confirmation before returning
`managed_wifi: {version:2, revision, status_ack:{delivery_id,binding_generation}}`.
Firmware checks the exact current snapshot, credential epoch and outstanding
request before accepting the ACK. Lost ACKs retain receipt retries; duplicate
receipts are acknowledged without rewriting the original saved time. Stale or
mismatched receipts cannot confirm another snapshot or a replacement credential.

After ACK, omit the **entire** `managed_wifi` request field. The cloud remembers
confirmation per device and omits the configuration from ordinary heartbeat
responses. No ongoing WiFi state advertisement or compact receipt is required.
Unchanged effective configuration does not restart delivery. New configuration,
binding or credential context does. An explicit empty new revision removes the
managed list and follows the same storage/receipt flow.

A normal reboot retains the saved snapshot and confirmation; it does not require
redelivery. If the managed journal was lost, reset or found corrupt, request
recovery explicitly using `managed_wifi: {version:2, request_config:true}`.
A pending recovery retries the same delivery identity. Recovery after prior
confirmation creates a new identity so a delayed old receipt cannot suppress
replacement delivery. Send the normal stored receipt after recovery; an omitted
field is never itself a recovery request. Missing responses never clear profiles.

The device must persist receipt/confirmation bookkeeping or conservatively retry
its saved receipt after reboot. Bookkeeping must not report success before the
snapshot and rollback floor are durable. The server's confirmation proves only
that firmware reported storage; it is not a verified connection result.

## Interoperability and qualification

The [frozen synthetic vector](vectors/managed-wifi-v2.json) contains public test
keys, exact plaintext and ciphertext; it is byte-identical to the backend test
fixture. It proves cryptographic/layout interoperability only. Its old timestamps
must fail current-time admission unless a test clock is explicitly controlled.

External firmware qualification must cover storage while disconnected, write
failure, confirmation followed by field-free heartbeats, lost responses/ACKs,
reboot and journal-loss recovery, stale replay, equal-revision conflicts, token rotation,
binding replacement, empty removal, trusted-time loss and interrupted atomic
storage. Apply the backend's additive migration before its writer. No firmware
capability flag or version allowlist is a prerequisite for cloud delivery.
