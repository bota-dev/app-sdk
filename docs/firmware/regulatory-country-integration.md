# External firmware integration: signed regulatory country v1

This handoff targets the external BES implementation. It does not require changes
to a different reference firmware repository. The wire authority is
[Regulatory Country v1](../../protocol/regulatory-country-v1.md); this guide
organizes implementation and acceptance without introducing another wire format.

## Read in this order

1. [Firmware protocol entry](../../FIRMWARE_PROTOCOL.md): existing GATT and token installation.
2. [Token envelope v1](../../protocol/device-token-v1.md): unchanged BOTATOK1, encrypted-only delivery, identity and refresh recovery.
3. [Country v1](../../protocol/regulatory-country-v1.md): sections 2, 4, 5 and 6 for sequencing, document, BLE and receipt layouts.
4. [Shared country vector](../../protocol/vectors/regulatory-signed-v1.json): deterministic signature/codec interoperability, not an approved RF profile or a live grant.
5. [WiFi v2/v3](../../protocol/wifi-config-v2.md): independent credential authorization and exact capability negotiation.

The [manifest](../../protocol/manifest/device-protocol.yaml) owns UUIDs; the
[Rust codec](../../core/device-sdk-core/src/protocol/regulatory.rs) and
[codec tests](../../core/device-sdk-core/tests/regulatory_profile.rs) provide a
reference. SDK structural validation does not replace firmware signature checks.

## What remains and what changes

| Area | Required implementation |
| --- | --- |
| Country source | Backend project country only, plus approved SKU/profile artifacts. No organization fallback, phone locale, IP inference or hard-coded CN/US. |
| Ownership | Keep bind → encrypted token installation → confirm/abort. Configuration ACK is not a third ownership phase. |
| Token | Preserve BOTATOK1 HPKE and signature verification. Reject new plaintext installation; retain valid tokens from historical completed bindings. |
| Country document | Add readable server-signed BOTAREG1. Do not decrypt it with HPKE or feed it into the token installer. |
| Completion | Persist and apply the driver configuration, then sign BOTARAK1 with SK_D. ATT success alone is not application success. |
| Radio admission | Gate active scan, personal manual/QR setup, managed STA and SoftAP/fast transfer on an applied valid profile. Keep recovery over BLE available. |

## Binding sequence and durable state

1. Expose the actual device SN, raw P-256 public key PK_D and implemented
   capabilities over BLE. SK_D remains on the device. The App relays these values.
2. The backend's authorized bind preparation pins an absent PK_D using TOFU,
   snapshots project country/profile, and returns an attempt plus opaque BOTATOK1.
   Existing pins cannot be replaced. Committed preparation followed by abort
   retains the pin, but does not create a permanent country lock.
3. Install BOTATOK1 using the existing encrypted characteristic and actual durable
   provisioning result. The token carries provisional binding generation `g`.
4. Expose a fresh regulatory nonce. The App sends it with the same attempt's
   confirm. The backend atomically activates binding/token, commits the country
   lock and returns a signed country document for generation `g+1`.
5. Verify the document against the same token's device/project/end-user/attempt
   and exactly `g+1`. Persist this confirmed context only after authentication.
   Later documents match the confirmed generation; refreshed tokens already
   carrying it match directly. Never accept an arbitrary generation jump.
6. Persist the country/profile journal, apply/read back the driver domain, and
   persist the success receipt. The App relays that receipt to the cloud ACK API.
   Only the matching authenticated result `APPLIED` completes cloud state.

PK_D enrollment happens during successful bind preparation. The permanent country
lock is created at confirm. These are different persistence moments.

## Firmware work items

| Work item | Acceptance detail |
| --- | --- |
| B07A000C service | Add capabilities `0001`, challenge `0002`, configuration `0003`, status `0004`, receipt `0005`; use the full UUIDs in the manifest. |
| Capabilities | Eight bytes: `01 0f 42 02 c6 00 78 00`. The three u16 fields are little-endian (578, 198, 120). Advertise support only after every required flag is implemented. |
| Challenge | Version1 plus 16 cryptographically random bytes; all-zero is invalid, individual zero bytes are valid. New full read creates a challenge; Read Blob continues the same snapshot. Enforce a 120-second monotonic lifetime. |
| Fragment assembly | `[index,total,data]`; data capacity `min(MTU-7,244)`, MTU23 supported. Bound to 578 bytes/64 fragments; strict order and identical immediate duplicates only. Clear partial assembly on disconnect or after 30 seconds. |
| Authentication | Validate cloud low-S ECDSA-P256 signature, provisioned signer, environment, PK_D hash, SN, owner/project/attempt/generation, nonce, lifetime, country lock and exact approved profile hash/modes. Use the canonical domains and byte offsets; document and receipt integers are big-endian. |
| Persistent state | A recoverable journal for country lock, accepted configuration and receipt. Do expensive crypto/NVM/driver work outside ATT callbacks; fence stale connection/binding/reset work. |
| Driver | Stop radio activity, safely checkpoint transfer, apply the approved profile and verify effective parameters. Radio limits are the intersection of hardware, factory limits and the approved profile. |
| Status/receipt | Coherent 64-byte status and 198-byte signed receipt; support complete long reads and framed notifications. Persist receipt before reporting success; reboot restores driver before reporting ready. |

The signed document identifies an approved RF artifact by its hash; it does not
contain the artifact's channel/power table. The firmware/RF team must supply and
integrate the exact artifact bytes, SKU, country, profile ID, SHA-256 and allowed
modes. The catalog and board must agree. Do not hash reserialized JSON.

## Recovery and compatibility

- Before confirm, provisioning failure uses the existing abort. After confirm,
  country failure keeps ownership and retries only country delivery/ACK; do not
  reinstall a token, automatically unbind or report full setup success.
- Lost confirm response: retry the same attempt. Expired/missing issuance: read
  a fresh challenge and request redelivery. Lost notification: read the complete
  receipt. Lost HTTP ACK: resend the saved receipt, without reapplying the driver.
- Persist the country lock across ordinary reset, unbind and environment/project
  changes. A higher revision does not authorize another country/profile in v1.
- Restore the last valid applied profile on failure. If recovery is uncertain,
  keep emitting paths off and BLE recovery available. A valid installed profile
  remains usable offline; the 120-second window is for installation, not use.
- WiFi v3 checks the installed original token's commitment inside its signed,
  encrypted authorization. It never hashes BOTATOK1 ciphertext or reads a
  token-delivery switch. QR parsing, credential encryption and transfer frames
  remain their existing protocols; country readiness adds an admission check.

## Joint test and delivery checklist

1. **Offline codec:** use the shared vector for signature/domain, field offsets,
   hashes, receipt and MTU23 framing. Reject altered fields, wrong environment/
   key/attempt/generation, high-S signatures, expired/all-zero nonce and overflow.
2. **Binding:** encrypted install succeeds before confirm; initial `g → g+1`
   matches. No country lock before confirm; project-country change invalidates
   the pending snapshot. Raw/mixed token input is refused.
3. **Country application:** actual driver and durable state match the exact
   approved profile; status is ready and the cloud records the signed ACK.
4. **Recovery:** disconnect/lost notification/lost confirm/lost ACK; power loss at
   journal, driver and receipt stages; driver/NVM failure; stale reset or owner.
   Verify no silent success, country unlock or unnecessary rebind.
5. **Original functionality:** scan, manual/QR WiFi, managed STA, SoftAP/fast
   transfer and applicable firmware OTA; repeat offline after reboot and after
   token refresh. Verify all emitting paths are blocked without a valid profile.

Backend migration 141 must precede API writers. Country admission defaults off
globally and per project; the approved catalog defaults empty. A merged PR or
successful deployment does not enable the pilot. First qualify matching SDK/App
consumers and target firmware, then configure the approved catalog/project and
explicitly admit the dev pilot. Gamma/prod rollout is separate.

For a local integration APK, record the exact Demo and SDK commits, packed SDK
hash, installed runtime provenance, active dev backend, APK signature and test
results. The normal App registry pin may still be older: a local SDK archive is
an unpublished integration candidate, not proof of public SDK adoption. Physical
radio, power-loss and phone acceptance remain required after software checks.
