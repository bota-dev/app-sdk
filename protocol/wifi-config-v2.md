# Secure personal WiFi provisioning v2

Contract: `wifi-config-v2-2026-11-02`. This is a coordinated source change;
package publication, firmware image qualification and phone/radio acceptance
are separate release gates. Legacy plaintext credential encoding is disabled
on all shared-core adapters. The React Native JavaScript runtime implements
this profile; older/native-only adapters reject it before credential writes.

## Authority and capability

Use the existing WiFi service (`B07A0006`), grant characteristic (`0001`),
credential characteristic (`0002`) and status characteristic (`0003`). Handles
do not change. Read grant capability before writing:
`b2 02 07 00 fd 01 7e 00` means version 2, set/disconnect/protected-storage
flags, 509-byte envelope and 126-byte maximum credential frame. Missing or
different capability fails closed. Grant and credential writes require BLE
encryption with a 16-byte negotiated key. Just Works pairing is not identity
authentication; the signed device-targeted envelope provides that authority.

Read the 16-byte `AUTH_NONCE` and request a grant through the trusted backend
proxy. The backend locks the current EndUser and device, checks project,
binding generation, reset state and enrolled device public key. Partner
requests require a secret/restricted key with `devices:write` and explicit
`end_user_id`. Dashboard requests additionally require organization membership
and `config.manage`. Request fields are `action` (`set` or `disconnect`),
`auth_nonce` (32 lowercase hex digits) and positive `binding_generation`.
SSID and password never enter this API.

The no-store response is `format: bota-wifi-config-v2`, `envelope_base64`,
`key_base64` (random 32-byte operation key), decimal-u64 `request_id`, echoed
`auth_nonce`, `action`, `serial_number`, `binding_generation`, and UTC ISO
`expires_at`. The key is delivered to the App through authenticated HTTPS and
to the device through signed HPKE. Never log, persist, cache or reuse it.
The response bypasses generic idempotency caches. Every retry gets fresh
authority. The SDK checks serial, nonce, action, format and expiry; connection
generation, workspace scope and cancellation remain fenced throughout BLE work.

## Signed HPKE envelope

Envelope size is 509: header 52, uncompressed ephemeral P-256 public key 65,
encrypted payload 312 plus signature 64, and authentication tag 16. The suite
is DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, ChaCha20-Poly1305. HPKE info is
`bota-wifi-config-v2`; the full header is AAD. The backend signature is low-S
ECDSA P-256/SHA256 over header concatenated with the payload. Firmware pins
the backend signer and validates the installed device identity.

| Header offset | Field |
| --- | --- |
| 0 | ASCII `BOTAWFP2` (8 bytes) |
| 8 | Big-endian u16 suite IDs `0010 0001 0003` |
| 14 | Environment: 0 dev, 1 production, 2 gamma |
| 15 | Action: 1 set/replace, 2 disconnect |
| 16 | First 4 bytes of SHA256(raw 64-byte signer public key) |
| 20 | SHA256(raw 64-byte enrolled device public key) |

| Payload offset | Field |
| --- | --- |
| 0 | Binding generation u64BE |
| 8 | Issued-at Unix seconds u64BE |
| 16 | Expiry u64BE, exactly issued-at + 60 |
| 24 | Nonzero request ID u64LE |
| 32 | AUTH_NONCE, 16 bytes |
| 48 | Nonzero operation key, 32 bytes |
| 80 | Four u16BE-length-prefixed UTF-8 values: serial (max 32), device ID, project ID, EndUser ID (each max 64) |
| after identity | Zero padding to 312 bytes |

The device compares the complete identity and generation with its retained,
verified signed device-token envelope. Legacy installations without that
envelope need encrypted credential reprovisioning/rebinding. A serial number,
BLE name, old unsigned token or proximity is insufficient. The shared nonce
read rotates after 30 seconds; installation atomically consumes a nonce younger
than 30 seconds. The operation expires at nonce creation + 60 seconds, also
checking signed UTC expiry when the device has a clock. Connection, credential
epoch change, reset, failed authentication and one completed operation retire
authority. Crypto, persistent reads/writes and radio work run on `app_core`,
outside ATT callbacks.

The envelope is split into grant writes:
`b2 00 || offset:u16LE || total:u16LE(509) || ciphertext fragment`.
Offsets must be sequential from zero, fragments nonempty, assembly under
10 seconds and within one connection. A write response only acknowledges
bounded enqueueing, not grant validation or configuration success.

## Credential and result frames

Compute HKDF-SHA256 with operation key as IKM and SHA256(envelope) as salt.
Expand independently to 44 bytes with info `bota/wifi-config/v2/app` and
`bota/wifi-config/v2/device`. Each output is a 32-byte ChaCha20-Poly1305 key
followed by its 12-byte nonce; each direction is used exactly once.

Header (12 bytes): `b2 || kind:u8 || action:u8 || 00 || request_id:u64LE`.
Kind 1 is credentials; kind 2 is the result. AAD is ASCII
`bota/wifi-config/v2` concatenated with the header. Wire form is header,
ciphertext, 16-byte tag. It has no plaintext SSID/password.

Credential plaintext: `ssid_length:u8 || password_length:u8 || ssid || password`.
Lengths are UTF-8 byte lengths, maximum 32/64, no NUL. Set requires a nonempty
SSID; disconnect requires both lengths zero. Frames are 30..126 bytes and must
fit one ATT write (MTU minus 3). The grant alone is fragmented. Insufficient
MTU fails before any write. Plaintext legacy packets and the old single-byte
disconnect command are rejected.

Subscribe before grant writes. A result is exactly 29 bytes, with one encrypted
status byte: 0 success, 1 invalid grant, 2 expired, 3 decrypt error, 4 storage
error. Authentication failures may instead produce an ATT error or timeout;
they never produce an unauthenticated success. Ordinary WiFi status packets
(including SSID-bearing status) are not configuration receipts. A result from
another request/action, a reflected credential or a duplicate fails validation.

Set success means encrypted A/B journal commit and readback verification, then
radio connection scheduling. DHCP/association success is reported separately.
Disconnect stops the connection and preserves encrypted profiles; this profile
does not implement forget/delete. Firmware enables protected personal storage
independently of enterprise managed WiFi. It disables vendor plaintext saves,
raw PMK caching and credential logs. Legacy profile migration deletes a source
only after encrypted commit; failure prevents using that source. Factory reset
clears protected journals and legacy PMK. Physical flash remanence and hardware
reboot/factory-reset behavior still require target qualification.

## Verification and rollout

`wifi-config-v2.vector.json` is generated using real backend HPKE/ECDSA and
Node AEAD. Shared Rust, committed generated JavaScript and firmware mbedTLS
consume the same bytes. Tests cover tamper, replay, identity, expiry, legacy
refusal, storage faults, protected-store reboot and PMK cleanup. Host results
do not establish vendor stack key-size enforcement, physical storage or phone
pairing behavior.

Publish compatible SDK, backend and firmware together, then update the App's
registry lock and build a new App. The App feature-detects
`DeviceManager.configureSecureWiFi`; its old pinned SDK fails safely until
upgraded. Test both Android and iOS, old/new peers, idle nonce renewal,
disconnect/reconnect, MTU limits, GATT cache refresh, packet capture, power loss
and factory reset before calling this released or hardware-qualified.
