# External firmware design: Project country synchronization

**Status: design proposal, not implemented or qualified.** This replaces the
earlier country integration direction for the external BES firmware team.
[SDK #84](https://github.com/bota-dev/app-sdk/pull/84) implements the earlier
B07A000C design; its [wire contract](../../protocol/regulatory-country-v1.md)
and [vector](../../protocol/vectors/regulatory-signed-v1.json) describe that
source only. They are not vectors for this proposal. This documentation change
does not replace that implementation, allocate a wire kind, or enable devices.

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
A Project with bound devices cannot clear its country. A Project without a
configured country cannot start an admitted country-managed binding.

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
Exact bytes, purpose identifier, size limits and shared vectors must be agreed
before implementation. Do not reinterpret `BOTAREG1` bytes from the old design.

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
commitment `C`. The proposed purpose-separated matching tag is:

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
Freeze the exact derivation in shared vectors before implementing it.

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
Kind **8 is proposed**; kinds 1–7 are occupied. The manifest, fixed-length codec
validation and all consuming bindings must be updated together in a later
implementation. Do not start an upload workflow just to send country settings.

The existing sender needs effective write capacity at least 64 bytes, meaning
**ATT MTU ≥67**. This proposal does not add MTU23 support. Mere presence of the
characteristic does not prove support for the new kind. Qualify the BES firmware
and negotiate actual supported protocol capabilities before enabling this path;
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

First agree the minimal wire encoding, kind registration, result meanings and
shared vectors. Then implement backward-compatible backend fields, the SDK/App
relay, and the BES handler; keep new country admission off until the coordinated
candidate is qualified. Existing old-design devices need an explicit migration
decision before enabling this replacement. Do not delete old locks or reinterpret
their bytes as part of a documentation update. Dev acceptance precedes separately
authorized gamma/prod rollout. Token encrypted-only policy remains independent.

Qualification must cover initial binding; Project change during bind; `CN → US → CN`;
same-value save; concurrent/out-of-order BLE and heartbeat delivery; token refresh
before and after first country application; different device/Project/environment/
generation; altered signature/tag; unsupported country; result loss; restart and
power loss; busy OTA/transfer; and offline catch-up. Regress manual/QR WiFi,
scanning, managed STA and local WiFi fast transfer with the target firmware.
Software checks, published packages, installed APK provenance and physical-device
results remain separate evidence. None is established by this design proposal.
