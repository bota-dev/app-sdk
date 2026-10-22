# Device token envelope v1 (unreleased)

This candidate keeps bind → provision → confirm/abort and existing refresh
semantics. HTTPS returns `credential_envelope` with `format=bota-device-token-v1`,
`encoding=base64url` and unpadded canonical `data`. Encrypted responses never
include `device_token`. Clients request `credential_delivery=hpke_v1` in the
existing request; all devices reject clients that omit it.

## Delivery versus subsequent authentication

`credential_envelope` means application-layer ciphertext delivered at bind or
refresh. It is never a Bearer credential. Firmware decrypts/verifies it and
stores the resulting raw `device_token` (`dtok_*`) through existing interfaces.
After binding confirmation, the device sends that original token in
`Authorization: Bearer` over HTTPS. TLS encrypts the subsequent request on the
wire; the token is not resealed with the delivery envelope for each request.
Recording/content encryption follows its own contract. The withdrawn
version-prefixed ciphertext in `device_token` is not accepted. Apps validate
format/encoding, canonical unpadded base64url (including unused trailing bits)
and bounds before relaying `credential_envelope.data` to the SDK.

## Cryptography and byte layout

RFC 9180 base HPKE: DHKEM(P-256, HKDF-SHA256) 0x0010, HKDF-SHA256 0x0001,
ChaCha20-Poly1305 0x0003. Info is ASCII `bota-device-token-v1` without NUL.
Only a separately enrolled physical-device public key may select the recipient.
A BLE-read key is a consistency check, never enrollment authority.

All integers are unsigned big-endian. The envelope is 230–768 bytes:

| Offset | Length | Field |
| --- | --- | --- |
| 0 | 8 | ASCII BOTATOK1 |
| 8 | 2 each | KEM, KDF, AEAD identifiers |
| 14 | 1 | Environment: dev=0, prod=1, gamma=2 |
| 15 | 1 | Purpose: initial binding=1, refresh=2 |
| 16 | 4 | First four SHA-256 bytes of signer raw P-256 x\|y |
| 20 | 32 | SHA-256 of recipient raw P-256 x\|y |
| 52 | 65 | HPKE encapsulated point, 04\|x\|y |
| 117 | variable | Ciphertext followed by 16-byte AEAD tag |

The entire 52-byte header is HPKE AAD. Plaintext is `payload || signature`.
The 64-byte IEEE P1363 ECDSA-P256 signature authenticates SHA-256(header ||
payload); only low-S signatures are accepted. Signers are pinned in device
firmware; the four-byte identifier only selects/checks a pinned key and cannot
supply or authenticate an arbitrary public key. Current gamma shares the
existing development grant trust anchor. Production uses its existing distinct
anchor. No ephemeral signing-key fallback is permitted.

Payload: binding generation u64, token expiry in Unix seconds u64 (0 means no
expiry), then six u16-length-prefixed UTF-8 fields in this order: serial number
(max32), backend device ID (64), project ID (64), EndUser ID (64), binding attempt
ID (64, may be empty), device token (255). Every other field is nonempty. NUL,
trailing bytes, invalid length, invalid suite/environment/purpose, wrong recipient
and invalid signatures fail closed. Maximum payload is 571 bytes. A provisional
bind carries the generation observed under its device lock; this is context,
not a new device-side anti-replay counter. Existing server expiry/revocation
remains authoritative; this increment does not add an offline clock or replay
ledger. The shared synthetic vector is `fixtures/credentials/device-token-v1.json`.
Its known test private key must never be used in a device or deployment.

## BLE transport

Service B07A000A-0000-1000-8000-00805F9B34FB, write-with-response characteristic
B07A000A-0001-1000-8000-00805F9B34FB. Existing handles are unchanged. Each write
is `[index:u8, total:u8, bytes...]`, index zero-based, at most 64 fragments and
768 reassembled bytes. SDK chunk capacity remains MTU−7. Minimum MTU is 23.
Fragments are ordered; only an immediately repeated identical fragment is
idempotent. A new index0 starts a new assembly. Incomplete assemblies expire
on the next received fragment after 30 seconds and are cleared on disconnect.
No extra notification/ACK characteristic or request round is introduced.

Firmware copies a complete bounded envelope into an app_core job. Crypto and
credential persistence run outside the Bluetooth callback. Connection and
credential epochs fence delayed jobs; pending reset/already-paired devices
reject initial installation. Read-back verifies the existing syscfg write and
existing provisioning-result/pairing notifications report success or failure.
The initial BLE route accepts purpose1 only. A purpose2 refresh is for a device
HTTP consumer calling the shared verifier with expected purpose2; this candidate
does not add a new direct-HTTP activation or refresh workflow.

Firmware unconditionally rejects the retired plaintext characteristic. The
legacy installer and compile-time opt-out have been removed. All devices must
have trusted enrollment; missing enrollment fails rather than issuing plaintext. Already stored credentials are
not re-encrypted by an OTA and still require normal rotation to retire exposure.

## HTTPS refresh recovery (backend source candidate)

Use `POST /v1/devices/:id/token/refresh` with the original device Bearer and
`{ "credential_delivery": "hpke_v1" }`; omit `Idempotency-Key`. The server saves
the encrypted purpose2 result atomically with rotation. For 15 minutes from
receipt creation, retrying that same predecessor on the exact same-device route
returns identical `credential_envelope` bytes without another rotation or an
extended deadline. The retired predecessor cannot call ordinary APIs.

Recovery requires unchanged project/owner/generation, live device and EndUser,
matching trusted key, a valid successor and no pending reset. Explicit revocation,
unbind/transfer/deletion, successor expiry/rotation or deadline expiry stops it.
Missing signing configuration can block new issuance but does not block saved
ciphertext recovery. Success responses use `Cache-Control: no-store`.

The firmware HTTP consumer must keep its predecessor until purpose2 verification
and reliable successor persistence complete, retry uncertain outcomes with that
same credential and bounded backoff, then use the successor for HTTPS. Recovery
failure outside the window requires supported authenticated binding recovery;
never reinstall plaintext or assume indefinite offline replay. The server
stores ciphertext only, at most one receipt per device (migration125). This
change adds no user step, request field, BLE opcode or SDK ABI change. Firmware
HTTP orchestration and local encrypted storage remain unimplemented separately.

## SDK and rollout

Rust `ProvisioningMaterial` requires `credential_envelope` bytes at runtime. The
old `device_token` ABI slot must be empty and is retained only to reject old
callers without renumbering fields. Native ABI field223 is mandatory for successful
provisioning; absent, plaintext or mixed material fails before any write. Apple, Android, Web and Flutter
carry bytes. RN exposes `credentialEnvelope` as canonical unpadded base64url
and `DeviceManager.provisionEnvelope`; it never decrypts. Invalid envelopes,
missing GATT support and old SDKs must fail, never retry through the plaintext
characteristic. Bota One/Demo keep published dependency pins until the candidate
runtime and release are qualified.

Release requires migration124, independently verified Manufacturing enrollment,
a provisioned device private key and matching backend signing trust, regenerated
RN core on the mandated Linux/Rust toolchain, native/Web/Flutter qualification,
and physical BLE/WiFi/LTE acceptance. Legacy claim/provision token-return routes
are retired for all devices (claim: HTTP410; provision: HTTP410 when mounted, otherwise HTTP404; no state mutation or token issuance). Existing certificate private
key delivery, device plaintext-at-rest storage and confirmation/replay limits
are separate work; encrypted delivery does not claim to fix them.
