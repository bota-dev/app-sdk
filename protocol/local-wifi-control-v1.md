# App-Local WiFi Minimal Control Security

**Version:** 1.0 (unreleased candidate)
**Updated:** 2026-10-29
**Requirements:** UP-17 / BRD51-12 / SD51-12
**Scope:** Ordinary encrypted-v2 local WiFi only. Implementation and qualification
remain tracked in [the single checklist](../docs/parity/local-wifi.md).

## 1. Decision and Existing Authorities

Use one backend-authorized, short-lived symmetric control key per physical BLE
connection and existing transport `session_id`. This is application-layer
authenticated encryption; neither BLE bonding nor JustWorks is an identity proof.
No new pairing account, certificate authority, durable key registry, upload queue,
or receipt is introduced. Production firmware belongs to the external team.

Reuse independently enrolled `PK_D`, the existing backend signing-key pin and
environment, current `device_id` / `project_id` / `end_user_id` /
`binding_generation`, and the existing 16-byte `AUTH_NONCE`. Never enroll a key
supplied by the phone. The existing device-token HPKE suite is reused, with a
different domain and payload; the token envelope and token installer are unchanged.

The new grant permits local control only. It does not permit recording access,
cloud publication, channel changes or deletion. Existing signed upload
authorization, owner revision, encrypted manifest, completion receipt and CONFIRM
remain mandatory. Device-local binding retirement invalidates the control key.
Server-side revocation prevents new grants; an offline device cannot learn a new
cloud revocation immediately, so an existing lease is bounded to five minutes.

## 2. Order and Minimal Additions

```mermaid
sequenceDiagram
  participant A as App / shared SDK
  participant B as Existing authenticated backend
  participant D as Device
  A->>D: Read storage + local capability; require secure profile 2
  A->>B: Existing recording/session authorization
  A->>D: Existing upload context and signed upload authorization
  D-->>A: Existing installation result (upload nonce consumed)
  A->>D: Read fresh AUTH_NONCE
  A->>B: POST local-wifi/control-grant (binding, session_id, nonce)
  B-->>A: HTTPS: control key + device-only signed HPKE envelope
  A->>D: Existing signed-blob fragmentation, kind 7, envelope
  D-->>A: Existing signed-blob installation result
  A->>D: AEAD LINK_QUERY, App counter 0
  D-->>A: AEAD LINK_STATE idle, device counter 0
  Note over A,D: Both sides proved possession; no hotspot secrets sent earlier
  A->>D: AEAD PREPARE / LINK_OPEN
  D-->>A: AEAD evidence / READY (password, TLS pin, download token)
  A->>D: Existing pinned TLS 1.3 GET / Range
  A->>D: AEAD FINISH / LINK_CLOSE
  A->>B: Existing ciphertext/manifest publication
  A->>D: Original signed receipt / CONFIRM
```

Upload authorization is installed **before** reading the control nonce, otherwise
consuming the control nonce could invalidate a previously issued upload grant.
No cloud recording is created until OS and profile-capability checks pass. The
control handshake then completes before PREPARE, SoftAP start or secret delivery.

Only these additions are needed: one stateless HTTPS issuance action, signed-blob
kind 7, and encrypted framing on the existing local-control/event characteristics.
LINK_QUERY / LINK_STATE provide key confirmation; there is no new handshake
opcode or GATT service. Existing payload fields retain their meanings.

## 3. Issuance and Device Envelope

`POST /v1/devices/{device_id}/local-wifi/control-grant` uses existing partner
authentication with `devices:write`; device tokens are forbidden. The first-party
App proxy authenticates its EndUser, checks ownership and injects `end_user_id`.
The backend locks the active EndUser and device, checks current binding generation,
pending reset, and the independently enrolled, non-revoked recipient profile.
The existing local WiFi rollout gate also gates issuance.

Request: `end_user_id`, `binding_generation`, `session_id` (existing nonzero u64,
decimal string), `auth_nonce_base64` (canonical base64 of 16 bytes, not all zero).
Response: `format=bota-local-wifi-control-v1`, `control_key_base64` (32 random
bytes), `envelope_base64` and `expires_in_seconds=300`. TLS protects the App copy.
Set `Cache-Control: no-store`; bypass idempotency response storage. Do not log,
persist, put in telemetry, or retry a captured key response across connections.
An uncertain delivery aborts this attempt; a new attempt reads a fresh nonce.

Envelope header (52 bytes) reuses the token envelope's algorithm identifiers and
encoding: magic `BOTAWFC1` (8), KEM 0x0010 / KDF 0x0001 / AEAD 0x0003 (u16 BE),
environment (u8: dev=0, prod=1, gamma=2), action 1 (u8), signing-key ID (4),
SHA-256 of raw `PK_D` (32). These are the existing token environment values,
not the recording-format environment enum. Raw public keys are existing 64-byte
X||Y coordinates without the SEC1 0x04 prefix; signing-key ID is the first four
bytes of SHA-256 of the raw backend public key.
HPKE info is ASCII `bota-local-wifi-control-v1`. Wire is header || enc(65) ||
ciphertext; header is HPKE AAD. The encrypted plaintext is payload || signature64.
Signature is the existing ECDSA P-256 / SHA-256, raw r||s, low-S, over header||payload.

Payload order: `binding_generation:u64BE`, `issued_at:u64BE`, `expires_at:u64BE`,
`session_id:u64LE`, `auth_nonce:16`, `control_key:32`, then four UTF-8 fields
(`serial_number`, `device_id`, `project_id`, `end_user_id`), each with a u16BE byte
length; maxima 32/64/64/64. Zero-pad the payload after the four fields to 312 bytes; reject nonzero padding.
The envelope is exactly 509 bytes, reusing fixed-size signed-blob framing. Reject extra bytes,
unknown algorithms/action/environment, malformed strings, wrong signature/key,
wrong local identity/generation, all-zero nonce, or a lease other than 300 seconds.

The device compares the nonce to its current single-use AUTH_NONCE on this exact
connection and accepts it only within 30 monotonic seconds of issuance. It
atomically consumes the nonce and installs the key once. Replayed blobs cannot
replace/reset a key or counters. If trusted UTC is available, also enforce the
signed time window. If UTC is unavailable, the live nonce plus its bounded
monotonic age provides freshness; the key expires 300 seconds after nonce issuance,
not after receipt. Reboot/disconnect clears both nonce and key. This is online
backend authorization; saved offline grants are unsupported.

## 4. Protected Local Frames

Local capability version/minimum version becomes 2; required flags become 31
(previous 15 plus mandatory protected control bit 4). Profile 1 is never accepted
as secure. Existing storage capability and original v2 document sizes are unchanged.

Derive two independent 40-byte outputs with HKDF-SHA256:

* IKM = control key; salt = SHA-256(exact device envelope bytes).
* App-to-device info = ASCII `bota/local-wifi/control/v1/app`.
* Device-to-App info = ASCII `bota/local-wifi/control/v1/device`.
* Output bytes 0..32 = AEAD key; bytes 32..40 = nonce prefix.

ChaCha20-Poly1305 uses nonce `prefix8 || counter:u32LE`. Each direction starts at
zero, accepts only the exact next counter, and increments only after successful
authentication. No counter rollover, reordering, duplicate application, or retry
with reused nonce is allowed. GATT link-layer retransmission remains below this
protocol; uncertain application delivery terminates the attempt.

Wire: original common header12 || counter4 || encrypted original body || tag16.
AAD: ASCII `bota/local-wifi/control/v1` || original header12 || counter4.
The common header has no length field; derive plaintext length from the existing
opcode-specific decoder. Wire length is plaintext length + 20. Validate version, flags, session, opcode,
length and direction. Largest READY grows from 159 to 179 bytes, within the
existing 182-byte characteristic value / ATT MTU 185. For example, LINK_QUERY's
12-byte empty-body frame becomes 32 encrypted bytes, then READY's passphrase,
SPKI pin and token are only exposed after device-direction tag verification.

Protect every frame on local CONTROL/EVENT, including PREPARED/EOF. The existing
manifest and receipt transport retains its original integrity and authority.
Only verified READY material reaches the native WiFi/TLS IO port. This does not
claim that unrelated BLE characteristics are encrypted by this session.

## 5. Lifetime, Errors and Acceptance

The SDK owns crypto state in the shared Rust core, referenced by an opaque handle.
Owned key buffers are cleared on release; immutable JS/JSON copies cannot promise
physical memory erasure, so keys are never logged, persisted or exposed to App state.
OS ports only join networks and perform pinned TLS IO. Owner/account/binding,
physical BLE generation, cancellation or expiry fences all callbacks and erases
key state. After successful FINISH and acknowledged LINK_CLOSE, the SDK also
releases the local control key and timer immediately; the original storage
listener and owner continue cloud publication/receipt handling independently.
Authentication failure during a socket read cancels that read and joins network
cleanup before releasing ownership. The device stops AP/HTTP on expiry, disconnect, local binding change or
reset. Cloud success cannot extend this control lease. Partial ciphertext and
the original upload identity survive for an explicit subsequent attempt.

Acceptance covers real-crypto round trips, cross-direction reflection, wrong
key/envelope/session, modified header/body/tag, stale/replayed counters, uncertain
GATT delivery, nonce consumption order, owner retirement and cancellation. Verify
backend ownership/reset/enrollment fences, proxy EndUser injection and no secret
response caching. Retain complete-file reuse and original receipt-only deletion.
External firmware must implement these exact checks; target-board acceptance and
independent security review remain rollout gates, not simulated-test claims.

Algorithm references: [HPKE RFC 9180](https://www.rfc-editor.org/rfc/rfc9180.html),
[HKDF RFC 5869](https://www.rfc-editor.org/rfc/rfc5869.html),
[ChaCha20-Poly1305 RFC 8439](https://www.rfc-editor.org/rfc/rfc8439.html).
The application framing above is Bota's candidate protocol, not a standardized
BLE pairing protocol or a claim of forward secrecy against later PK_D compromise.

## 6. Interoperability Fixture

The [synthetic interoperability vector](local-wifi-control-v1.vector.json) includes a test-only P-256
recipient private key, backend signing public key, real 509-byte signed HPKE
envelope and expected encrypted QUERY/idle bytes. Never install these test keys
on a production device. Backend tests decrypt and verify the signature; SDK
tests compare the AEAD frames byte-for-byte with independent Node/OpenSSL output.
The total envelope is 52 + 65 + 312 + 64 + 16 = 509 bytes.
