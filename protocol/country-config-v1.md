# Project country configuration v1

**Status:** Unreleased coordinated source contract. Backend/SDK/App implementation,
package publication and external BES firmware qualification are separate.

This replaces the earlier [regulatory-country service](regulatory-country-v1.md).
It keeps two-stage binding, [BOTATOK1](device-token-v1.md), Wi-Fi v3 and file-transfer
protocols unchanged. Country is a readable signed configuration, not a new
credential, HPKE package, GATT service, challenge or device-signed receipt.

## Scope and lifecycle

New Project creation requires an explicit uppercase two-letter `country_alpha2`.
Existing Projects with absent/null configuration resolve server-side to US, with
revision at least 1 (preserve a higher historical revision). The server includes
that effective country in the signed bytes. Saving the same effective value does
not advance revision; a real change increments it atomically. Clearing country is
rejected. No organization/phone/IP fallback or RF-artifact catalog is involved.
Firmware still enforces its supported country domains and hardware limits.

Bind preparation returns preview metadata. After the original encrypted token
installation, first confirm reads the latest Project country under the Project
lock and returns signed configuration with the committed binding. A country
change since preparation does not require another token. A post-confirm delivery
failure retains ownership and retries country synchronization only.

Later changes travel in existing heartbeat responses, directly to the device or
through the App's existing connection/foreground/settings cycle. Fully offline
devices keep their last valid applied configuration and catch up to the latest
revision when reachable; intermediate revisions need not be replayed. This is
eventual synchronization, not immediate fleet-wide enforcement.

## Signed document

The HTTP document wrapper is `{format:"bota-country-config-v1",
encoding:"base64url",data:"..."}`. Base64url is canonical and unpadded. Decoded
length is **exactly 264 bytes**. Multi-byte integers inside this document are
big-endian; the existing signed-blob framing remains little-endian.

| Offset | Bytes | Field |
| --- | --- | --- |
| 0 | 8 | ASCII `BOTACFG1` |
| 8 | 1 | Version = 1 |
| 9 | 1 | Environment: **dev=0, prod=1, gamma=2**, matching BOTATOK1 |
| 10 | 1 | Purpose = 1 (country configuration) |
| 11 | 1 | Reserved = 0 |
| 12 | 4 | Trusted signer key ID |
| 16 | 8 | Confirmed binding generation, positive u64 |
| 24 | 8 | Project country revision, positive u64 |
| 32 | 2 | Uppercase ASCII country code |
| 34 | 2 | Reserved = 0 |
| 36 | 32 | Country-specific current-credential tag |
| 68 | 2 | Project ID UTF-8 byte length, 1..64 |
| 70 | 64 | Project ID bytes followed by zero padding |
| 134 | 2 | Device ID UTF-8 byte length, 1..64 |
| 136 | 64 | Device ID bytes followed by zero padding |
| 200 | 64 | ECDSA P-256 P1363 signature, r32 followed by low-S s32 |

Reject invalid length/version/purpose/environment, nonzero reserved/padding bytes,
invalid UTF-8, embedded NUL, or invalid country/generation/revision. The two IDs
are the existing backend identity values, not user-provided display names.
HTTP revisions use decimal strings to preserve u64 precision. Current HTTP
binding generation is a positive JavaScript-safe integer; reject overflow rather
than round it. Do not reuse the different encrypted-upload environment enum.

Signer key ID is the first four bytes of SHA-256 over the trusted cloud public
key's raw P-256 `X || Y` coordinates. It selects an already trusted key; the
App cannot install a trust anchor through this package. Signature verification is:

```text
body = document[0:200]
message = ASCII("bota/country-config/signature/v1") || 0x00 || body
ECDSA-P256-SHA256(message), P1363 r32 || s32, low-S required
```

Hash the domain and body once. Reject zero/out-of-range r or s, high-S signatures
and an unknown trusted key ID. App/SDK structural parsing is not firmware
signature verification and cannot establish successful application.

Let `C` be the existing Wi-Fi v3 credential commitment of the installed original
token. The public matching tag is:

```text
HMAC-SHA256(key=C, data=ASCII("bota/country-config/credential/v1") || 0x00)
```

Never expose the token or raw `C` in the readable package. The signature covers
the tag and all configuration fields. The tag distinguishes replaced prepare
credentials with the same provisional generation; it does not authorize anything
without the signature and current binding checks. It is not computed from token
HPKE ciphertext and adds no new long-term secret.

## Existing binding context and application

Persist the verified token context with its token. Compare country packages within
`(environment, project_id, device_id, confirmed_binding_generation)`.

- Two-stage initial BOTATOK1 purpose 1 with a nonempty attempt carries generation
  `g`; its expected confirmed generation is `g+1`.
- Refresh purpose 2 carries the already-confirmed generation `g`.
- Historical immediate-bind purpose-1/empty-attempt tokens must not receive the
  `g+1` rule. Ordinary encrypted refresh can normalize them before admission,
  without rebind. Do not depend on attempt ID as a permanent scope.

Check structure/signature, current scope and current credential tag **before**
revision comparison. Reject older revisions; accept the same revision/country
idempotently; reject the same revision with a different country. A higher revision
may change country. A package cannot itself establish a new owner or Project.

Both BLE and heartbeat call one serialized firmware apply handler. Recheck the
credential/binding epoch before commit. Use existing driver and durable settings
facilities; report success only after driver application and durable readback.
OTA or active transfer defers application at its safe boundary without stealing
ownership or discarding checkpoints. Local recording alone need not stop.
On error, retain the last applied revision and restore/verify its driver state;
if recovery is uncertain, block radio use and retain BLE recovery. Restore stored
configuration before radio use after reboot.

Within the same binding, token refresh leaves previously verified durable country
and revision valid. Do not compare its historical tag with the refreshed token
or close radio for that mismatch. Newly received packages must match the current
token. A reissued same-revision package can have a new tag/signature; idempotency
is based on scope, revision and country, not whole-document byte equality.

No nonce or expiry is added. Revision checks prevent rollback below an already
accepted revision in this scope; they do not prove that an offline device has
learned the latest cloud setting or protect against whole-store rollback.

## BLE transport and results

Use existing `SIGNED_BLOB_V2`
`B07A0004-0007-1000-8000-00805F9B34FB`, business **kind 8**, total length **264**.
Reuse BEGIN/DATA/COMMIT/ABORT/RESULT, transfer hash, nonzero write ID, subscription
ordering, GATT queue ownership and cancellation. Do not start an upload or an
upload-context handshake solely to send country configuration.

The current sender requires effective ATT write capacity >=64 bytes, hence
**ATT MTU >=67**. No MTU23 transport extension is introduced. New capability bits
must not be appended to the strict legacy storage-capability decoder.

Reuse existing encrypted-v2 result codes. `0` means applied and durably restored
or saved; `14` means owner busy; `4/5/8/9/13` retain signature/environment/identity/
generation/authorization mismatch meanings; `19` covers revision conflicts and
`255` internal driver/storage failure. Unsupported country is a configuration
authorization mismatch (`13`). Never return zero for merely queued work or ATT
acceptance. Unknown nonzero codes remain failures; SDK preserves the raw u16.
Correlate RESULT by kind and write ID before reporting its package as applied.

## HTTP synchronization and observed state

Bind requests declare `country_protocol_version:1` independently of the retired
`regulatory_protocol_version`. Preview fields are `protocol_version`,
`country_alpha2`, `country_revision` and `source:"project"`.
The existing register/bind requests carry the connected device's observed
`firmware_version`; bind may refresh this metadata while the device is still
unbound. It is not an identity proof or a new binding phase. An idempotent replay
of an already successful confirm returns the bound device without requiring
another signature; recover country delivery through the ordinary heartbeat.
Confirm and heartbeat can return:

```json
{
  "country_config": {
    "protocol_version": 1,
    "binding_generation": 7,
    "country_alpha2": "CN",
    "country_revision": "3",
    "expected_firmware_version": "<observed device version>",
    "document": {
      "format": "bota-country-config-v1",
      "encoding": "base64url",
      "data": "<264 signed bytes, unpadded base64url>"
    }
  }
}
```

Metadata must agree with the signed package. `expected_firmware_version` is an
admission/transport check, not signed authority; SDK reads the actual GATT firmware
version and requires an exact match before sending. There is no configured firmware
minimum or global/Project country switch. This comparison checks connection metadata,
not proof of kind-8 support. Binding without `country_protocol_version:1` retains
legacy encrypted binding without a country package; explicit scoped synchronization
can follow later. Qualify matching SDK/App and firmware before distributing them.
Characteristic presence or a server default alone cannot add firmware support.
A missing/invalid/unauthenticated package must never become an unsigned US default.

Heartbeat requests optionally carry `country_sync` with `protocol_version:1`,
the operation's captured `binding_generation`, optional `force:true`, and optional
`state`. An authenticated App proxy supplies/checks `expected_end_user_id`; direct
device authentication supplies its own identity.
An inputless legacy App relay receives no country package. Direct device-token
heartbeats may synchronize an already admitted binding without an App extension.

| State | Fields | Meaning |
| --- | --- | --- |
| Omitted | No new state | Preserve prior observation; force can request redelivery |
| `status:"missing"` | No country/revision | Current scope lacks valid configuration; redeliver |
| `status:"applied"` | `country_alpha2`, `country_revision` | Actual completed application |
| `status:"failed"` | `attempted_revision`, nonzero u16 `result` | Failed attempt; never invent a new applied revision |

The response uses `country_sync_result` (`accepted`, `stale_binding`, `invalid`
or `unavailable`) and optional `country_config`. Optional extension failure does
not turn a valid ordinary heartbeat into a failed heartbeat. Missing configuration
or force requests permit idempotent recovery even after a past cloud success.

Reports are observations, not device-signed proof or Wi-Fi-grant authorization.
Compare the operation's captured generation with current binding, never relabel
old reports on receipt. Old revisions cannot clear newer pending state. Failed
attempt metadata and actual applied state remain separate. No signed country ACK
endpoint or cloud ACK-dependent Wi-Fi grant gate remains in this flow.

## Integration evidence

Use the shared [synthetic vector](vectors/country-config-v1.json) for exact bytes,
domain, tag and signature agreement; it is not a production key or RF evidence.
The [firmware handoff](../docs/firmware/regulatory-country-integration.md) owns
application/recovery acceptance and the [source review](../docs/parity/regulatory-country.md)
distinguishes implemented checks from publication and physical qualification.
Earlier `BOTAREG1`/`BOTARAK1` messages and vectors retain their historical meaning;
they are not aliases for this format.
