# External firmware design: Project country synchronization

**Status: unreleased SDK source; coordinated backend/App delivery and external
BES firmware qualification remain separate.** The current source implements the
[fixed country contract](../../protocol/country-config-v1.md) and reuses kind 8
of SIGNED_BLOB_V2. The earlier B07A000C methods now reject before device I/O;
its [wire contract](../../protocol/regulatory-country-v1.md) and old vector are
historical references, not the active installation path. Use the
[current shared vector](../../protocol/vectors/country-config-v1.json).

## Scope

The backend owns a Project's `country_alpha2` and monotonic `country_revision`.
The device applies the latest authorized version through existing transports.
Country changes do not require rebinding or token replacement.

- Country comes only from the Project: no organization inheritance, phone
  locale, IP inference, or default CN/US.
- Keep `bind → install encrypted token → confirm / abort` and the existing
  [BOTATOK1 contract](../../protocol/device-token-v1.md) unchanged.
- Use one readable, server-signed country document. There is no country HPKE,
  new BLE service, country nonce, device-signed ACK, permanent country lock, or
  cloud RF-profile distribution system.
- Preserve [WiFi v3](../../protocol/wifi-config-v2.md), QR parsing, credential
  encryption and transfer frames. Firmware still enforces its supported country
  domains and hardware limits; this proposal does not redefine them.

## First binding

1. The App relays the device's existing SN, PK_D and actual capabilities.
   Authorized bind preparation retains the existing TOFU policy and returns an
   attempt, unchanged encrypted BOTATOK1, and an optional country preview.
2. Firmware installs the encrypted token and returns the existing provisioning
   result. Failure before confirm follows the existing abort path.
3. Confirm reads the **current** Project country and revision under the same
   Project lock used for country updates, and commits the normal binding/token
   activation with the signed configuration. A country change after preparation
   updates the configuration returned at confirm; the preview is not a lock.
4. The App relays the signed configuration through `SIGNED_BLOB_V2`. Firmware
   verifies, applies and persists it, then reports the application result.
5. If country delivery fails after confirm, ownership remains confirmed. Retry
   configuration synchronization only. A lost confirm response uses the same
   attempt's existing idempotent recovery, without issuing another initial token.

PK_D is pinned during successful authorized bind preparation. Country preview
is not a permanent device record. Actual applied country/revision are persisted
by firmware after successful application; their first-write timing differs.

## Project changes and synchronization

Changing the country increments the Project revision atomically; saving the same
country is idempotent. `CN → US → CN` therefore produces revisions `1 → 2 → 3`.
New Projects must explicitly select a country and start at revision 1. Existing
Projects without a configured country resolve to US on the server before signing;
a higher historical revision is retained. Explicitly saving that effective US
does not advance the revision. Clearing country is rejected. Firmware uses the
verified signed value; it must not default malformed or missing packages to US.

The backend derives desired state from the current Project. No per-device
command fanout is needed. The App fetches current configuration through its
existing connection/foreground/configuration cycle and before WiFi setup.
Direct-device heartbeat responses can carry the same signed `country_config`.
Both transports reach one firmware validator and application handler.

Firmware reports applied country, revision and result through ordinary status
and heartbeat, keeping a failed attempted revision separate from the actual
applied revision. The backend compares that observation with current desired state;
an old report cannot complete a newer revision or overwrite a newer observation.
Reports are operational observations, not device-signed evidence or authorization
to issue WiFi grants. The old independent signed-country-ACK gate is not retained.

Report the confirmed binding generation captured at the operation, not one
looked up after its completion; reject late reports from an old scope. A relay
success belongs to its completed write ID's package. Failed attempts do not
claim the target revision or a cached revision as currently applied. Omitted
country fields mean no new observation; explicit `missing` requests redelivery.
Without an existing applied-state reader, the App can request resynchronization
at existing hooks and resend idempotently, even after a past cloud success.

An offline device keeps its last valid configuration and catches up to the
latest revision on reconnection. Intermediate revisions need not be replayed.
This is eventual synchronization, not an immediate fleet-wide country switch.

## Firmware validation and state

The signed document logically contains protocol/purpose and signer ID, environment,
Project ID, device ID, confirmed binding generation, country, revision and a
country-specific credential tag. Use the existing trusted cloud signature
verifier and one canonical encoding; the App cannot supply a new trust anchor.
The [wire contract](../../protocol/country-config-v1.md) fixes the 264-byte encoding,
purpose and shared vector. Do not reinterpret `BOTAREG1` bytes from the old design.

The binding scope is `(environment, project_id, device_id, confirmed_generation)`.
Firmware retains this authenticated context with its installed token. In the
two-stage flow, initial BOTATOK1 (`purpose=1`, nonempty binding attempt) contains
provisional generation `g`, so its expected confirmed generation is `g+1`;
a refresh (`purpose=2`) already contains confirmed generation `g`. Historical
immediate-binding purpose-1 tokens can have an empty attempt and an already
confirmed generation: normalize them through ordinary encrypted token refresh
before country admission, without rebinding. Do not add one to every historical
purpose-1 generation or depend on attempt ID as the permanent scope.

The public document must not expose the token or the existing WiFi v3 credential
commitment `C`. The purpose-separated matching tag is:

```text
country_credential_tag = HMAC-SHA256(
  key = C,
  data = ASCII("bota/country-config/credential/v1") || 0x00
)
```

The backend signs only for the current valid active binding and credential.
The cloud signature covers this tag and all configuration fields. The tag
distinguishes replacement credentials whose prepare attempts share a generation.
It only matches the current credential; it cannot authorize configuration by itself.
Use the shared vector to verify this derivation and the cloud signature.

Firmware processes each received document in this order:

1. Validate framing, document bounds, purpose and cloud signature.
2. Match the installed token's authenticated binding scope and credential tag.
   A country document cannot change device ownership or Project.
3. Compare revision within that scope: older rejects; equal revision and equal
   country succeeds idempotently; equal revision with a different country rejects;
   a newer revision may change the country.
4. Apply the supported country using the existing driver/configuration storage
   mechanism at a safe point. Return success only after driver application and
   durable readback succeed.

Token refresh retains applied country/revision and the same binding scope.
Previously verified durable configuration remains valid; do not revalidate its
historical credential tag against the refreshed token or close the radio for
that mismatch. Newly received packages must match the current token. A
reissued document may have a different tag/signature at the same revision;
idempotency compares scope, revision and country, not all document bytes.
A new authorized binding establishes a new scope through the existing token
installation flow. Old in-flight configuration work must not cross that boundary,
and the old scope's country does not authorize radio use in the new scope.

## Existing transport and failure behavior

Reuse `SIGNED_BLOB_V2` at
`B07A0004-0007-1000-8000-00805F9B34FB`, including BEGIN/DATA/COMMIT/ABORT/RESULT,
write IDs, connection retirement, cancellation and the existing GATT queue.
Kind **8** has fixed total length **264** in the manifest and Rust codec.
SDK structural parsing does not authenticate the cloud signature for firmware. Do not start an upload workflow just to send country settings.

The existing sender needs effective write capacity at least 64 bytes, meaning
**ATT MTU ≥67**. This implementation does not add MTU23 support. Mere presence of the
characteristic does not prove support for the new kind. The backend admits only qualified firmware and returns its observed version;
the SDK reads the actual GATT firmware version and requires an exact match before
sending. Qualify the BES firmware before enabling this path;
do not add an unknown bit to the existing strict capabilities decoder.

| Situation | Required behavior |
| --- | --- |
| BLE and heartbeat deliver together | Serialize application; use the same scope/revision rules. |
| Transfer or OTA owns the transport/radio | Report busy/deferred and retry at a safe point; do not steal ownership or discard transfer checkpoints. |
| Country requires WiFi restart | Safely stop, apply and reconnect STA/SoftAP. Local recording alone need not stop. |
| Unsupported country or driver/storage failure | Report a specific failure; retain the last successfully applied state and restore/verify its driver settings. If restoration is uncertain, refuse radio use until recovery. Never report the new revision as applied or substitute another country. |
| Disconnect or lost result | Retry the same current configuration; successful application is idempotent. |
| Reboot or power loss | Recover through existing durable settings facilities and restore the matching driver state before reporting ready. If no valid applicable state remains, refuse WiFi startup and retain BLE recovery. |
| Delayed App callback or old binding report | Reject/ignore it using current connection and binding scope; it cannot overwrite current state. |

An ATT acknowledgement or queued work is not application success. Normal RESULT
and heartbeat are not device-signed receipts. Without a nonce, an offline device
cannot know that the cloud has issued a newer revision; revision checks prevent
rollback after the device has accepted a newer revision. They do not add protection
against rollback of the entire token store or device NVM.

## Implementation dependencies and acceptance

The wire contract and shared vector define the coordinated implementation.
Adopt matching backend fields and the SDK/App relay, then integrate and qualify
the BES handler. No global/Project country switch or configured firmware minimum
is required. Protocol-v1 opt-in and the existing observed GATT version comparison
remain; default US does not make old firmware implement kind 8. Existing old-design
devices need an explicit migration decision before adopting this replacement.
Do not delete old locks or reinterpret their bytes without a separately reviewed
data migration. Dev acceptance precedes separately
authorized gamma/prod rollout. Token encrypted-only policy remains independent.

Qualification must cover initial binding; Project change during bind; `CN → US → CN`;
same-value save; concurrent/out-of-order BLE and heartbeat delivery; token refresh
before and after first country application; different device/Project/environment/
generation; altered signature/tag; unsupported country; result loss; restart and
power loss; busy OTA/transfer; and offline catch-up. Regress manual/QR WiFi,
scanning, managed STA and local WiFi fast transfer with the target firmware.
Software checks, published packages, installed APK provenance and physical-device
results remain separate evidence. The current source does not establish package publication or physical qualification.

## App-facing SDK integration

Use `controls.applyCountryConfiguration(device, delivery)` or the DeviceManager
method with the same arguments. Map backend `country_config` metadata to
`protocolVersion`, `bindingGeneration`, `countryAlpha2`, `countryRevision`,
`expectedFirmwareVersion`, and the unchanged `document` wrapper. The SDK compares
metadata with the parsed bytes and firmware version before subscribing/writing.
It returns `{result:0, bindingGeneration, countryAlpha2, countryRevision}` only
for the matching successful kind/write-ID RESULT. `ProtocolRejected.protocolStatus`
preserves an actual device failure. Timeout or connection loss is not evidence
that the device rejected or applied a configuration. Apps must check captured
binding/account/connection state again before recording or reporting the result.
Native-only adapters without this extension fail before writing. No package pin
change is implied by this source integration; see the [conformance review](../parity/regulatory-country.md).
