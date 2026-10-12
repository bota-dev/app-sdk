# Apple v2 Maintenance Parity

The reviewed Apple transfer corrections are released in synchronized beta.15;
see [publication evidence](../../release/evidence/2.0.0-beta.15-publication.md).
The dated source/candidate entries below retain their original acceptance scope.

Scope: unpublished Apple source parity against maintenance reference
`318974f925a573cf04b0d624978bee04784af09b`. This is not a release, firmware
advertisement, backend deployment, or physical-device acceptance claim. Existing
lost-WINDOW_ACK and diagnostics behavior remains in place. Runtime compatibility
metadata stays contract-only.

## Public Native Surface

- `RecordingManager.listEncryptedUploadV2Recordings(_:)` returns full v2
  identities and committed metadata from the dedicated catalog.
- `listPendingRecordings(_:)` returns `[PendingRecording]`, with cases
  `.legacy(DeviceRecording)` and `.encryptedV2(EncryptedUploadV2Recording)`.
  It reads legacy before v2, returns v2 first, suppresses matching four-byte
  legacy aliases, and rejects alias collisions. Only an explicitly absent
  capability characteristic permits legacy-only results; malformed capability,
  catalog, or GATT failures never trigger fallback.
- `EncryptedUploadV2Recording` adds `startedAtMs`, `durationMs`, and
  `plaintextLength` (`UInt64`, default zero), plus `storageFormat` (`UInt8`,
  default three). Existing initializer arguments are unchanged.
- `EncryptedUploadV2ContextExchange(challenge:exchangeProof:)` and
  `EncryptedUploadV2ContextProvider` keep challenge/proof/result bytes native.
  The provider receives the independent device context nonce, not a Grant
  nonce. Material `uploadContext` defaults to nil for source compatibility,
  but sync rejects missing context before material registration or device writes.
- `EncryptedUploadV2Material.shouldUploadCiphertext` is an asynchronous native
  evidence-to-Bool callback, defaulting to true. False skips both staging-URL
  resolution and PUT, while still verifying the completed native file and
  retaining manifest, finalization, receipt, and confirmation sequencing. The
  host application decides whether backend state already makes PUT unnecessary.
- `syncEncryptedRecordingV2` accepts `operationID: UUID = UUID()`;
  `cancelEncryptedUploadV2Operation(_:)` cancels only that active v2 owner.
  `material.cancelPreparation()` is public, asynchronous, and idempotent for
  disposal of late unused native registrations.
  Inactive operation IDs are not tombstoned: adapters must atomically retain
  the exact Swift `Task` with the ID, cancel that task before requesting native
  cancellation, and await its settlement. This also closes cancellation before
  native registration; an already cancelled task fails before BLE or provider work.
- `EncryptedUploadV2ProviderContext.readAuthNonce()` returns native `Data`
  under the exact operation and connection generation, checked before and after
  GATT. Its default is unsupported. Context equality compares metadata only,
  never callback identity. A retained callback cannot read after terminal
  cleanup, cancellation, or reconnect.

## Runtime Boundaries

Rust owns the catalog digest/count/identity validator, LIST and signed-blob
encoders, context snapshot/document shape validation, authorization identity,
and capability admission. See [protocol contract](v2-demo-protocol.md).
Apple converts validated catalog time to milliseconds with overflow checks.
Both catalog subscriptions precede LIST and are released on terminal paths.
Transfer frame bounds below 140 bytes fail before provider preparation or START:
the mandatory START_ACK requires 140 bytes even though START fits in 128.

Context is reacquired before authorization and before first completion receipt.
Each attempt has a new nonzero correlation ID and one 30-second deadline,
including provider waits. Polling does not renew it. Cancellation and timeout
fence late provider completions from further BLE writes. Context, provider,
material registration, and connection ownership are checked independently;
the SDK never interprets opaque documents as cryptographic or time authority.
Application callbacks remain backend-neutral.

Signed session replacement requires the advertised recovery capability, a
different session and strictly higher signed owner revision, exact selected
recording/storage/policy/ciphertext identity, and retained checkpoint ciphertext
identity when an owner already exists. New sidecars persist ciphertext length
and digest. Historical sidecars without those optional fields allow same-owner
resume only. Replacement starts with a fresh sink and transport; old checkpoints
remain until new durable evidence exists. Superseded same-recording sidecars
and sinks are retired only after the replacement's persisted window is ACKed
or its completed resumed transfer is verified. Every candidate must have a
strictly older owner and matching ciphertext identity before any deletion.
Lookup prefers a newer owner only
when all retained candidates have distinct revisions/sessions and matching
ciphertext identity; conflicts fail closed. Backend expiry decisions, successor
traversal, signed replacement issuance, and publication recovery remain host
responsibilities, not inferred SDK behavior.

## Verification

### October 9 single ATT frame capacity (unpublished source)

A supervised consuming-iPhone retry using public beta.14 reached the native
START effect, then threw `EncryptedUploadV2TransferControlRejection` with
device result `0x0002` (`INVALID_LENGTH`) and failed message type `0x20`.
The sink remained zero bytes without a durable checkpoint. The application
reported `internal` because the executor only recognized host-specific errors.
This establishes a device START rejection, not cloud publication or cleanup.

`CoreBluetoothHost.maximumWriteValueLength` now defaults to
`withoutResponse`, which bounds one ATT value. Both v2 transfer negotiation and
signed-blob framing use that query; writes still use responses. A fake driver
with a 512-byte long-write capacity and a 182-byte single-value capacity
reproduced the old 512-byte selection and now returns 182. Existing negotiation
subtracts the 28-byte DATA header and bounds WINDOW_ACK missing sequences, so
it selects at most 154 ciphertext bytes for that link. Explicit long-write
queries remain available. The 140-byte mandatory START_ACK guard is unchanged.

The executor also translates exact transfer-control rejections to ABI code 17
(`protocol_rejected`), preserving retryability, fixed detail and numeric device
result. Unknown errors retain their existing generic mapping. No authorization,
receipt, checkpoint identity or cleanup rule is relaxed.

| Requirement | Evidence | Status |
| --- | --- | --- |
| Framed values fit the current ATT link, independent of device capacity | Before-fix capacity regression failed 512 vs 182; corrected host query and existing DATA/window bounds | matched in controlled tests |
| Preserve exact START rejection through the v2 host boundary | Before-fix event was internal/code 21 without status; regression now requires code 17/status 2 and exact effect identity | matched in controlled tests |
| Manager START bounds use the single ATT capacity | Real host integration selects DATA 154/window 28 with capacities 512/182; an isolated old-default mutation fails with DATA 484/window 44 | matched in controlled tests |
| Preserve signed-document framing, cancellation and identity fences | Complete Apple suite: 268 tests, 9 opt-in physical tests skipped, zero failures; focused integration build uses warnings as errors | matched in controlled tests |
| Public package and normal consuming-iPhone upload/receipt/cleanup | Source remains unpublished; phone retry of the corrected SDK has not run | unverified |

Verification rebuilt the current Rust XCFramework and used a fresh SwiftPM
scratch directory. An earlier run reused an obsolete copied binary and failed
diagnostic/catalog/context codecs; the fresh full run passes those cases.
The actual phone's negotiated frame capacity and rejected START bounds still
require runtime capture. Android's working result is owner-reported; this
source change does not claim cross-platform physical acceptance.

```sh
BOTA_PHYSICAL_TESTS=0 swift test --package-path platforms/apple \
  --scratch-path target/apple-ios-mtu --jobs 4 -Xswiftc -warnings-as-errors
```

Exact-revision CI, publication and a rebuilt consuming app remain delivery
gates. Demo retains its pinned published package; do not patch SDK caches or
represent this source correction as an installed public release.

October 11 follow-up now confirms cloud commitment for the owner's original
retained encrypted capture using the private Demo 1.0.15 SE candidate. Normal
SE logs show a target reconnect and explicit v2 BLE sync immediately before
publication at 2026-10-12 03:57:07 UTC. Exact scoped metadata found the latest
owner revision 6 in `published`; the older revision 2 remained `expired`.
Ciphertext matches the independently observed device catalog's 25,119-byte
length/hash. Published plaintext is 24,707 bytes with a verified hash, and the
backend persisted/returned the exact 336-byte completion receipt. Resource
identities and restricted artifacts stay in private evidence.

This qualifies cloud publication and receipt issuance for that private SE
capture, not physical source cleanup: the current SDK reconnect cannot find
the wearable, and a fresh scan returned no Bota advertisements. Empty app/SDK
upload journals are supporting evidence only. A successful fresh native catalog
must confirm the exact capture is gone, or existing published-session recovery
must finish receipt/CONFIRM without another PUT. Public SDK delivery, physical
system-connected ownership acquisition and wider recovery cases remain open.

The owner subsequently authorized a temporary iPhone candidate. It uses the
exact public beta.14 Swift source at `a275773`, plus only the two production
patches above; its published Rust binary URL and checksum are unchanged.
The native Debug build succeeded and Demo 1.0.13 was installed in place.
All three retained application journal files were byte-identical after install.
The ignored native project and normal public beta.14 resolution were restored
after the candidate build. Normal-UI sync is still unverified: the latest
Mirroring attempt reports iPhone Not Found and Apple device tools report the
phone unavailable. The debugger lost its connection and was closed; reconnect
the phone and leave it locked before continuing automation.

On October 10 the owner switched the consuming target to an iPhone SE (3rd
generation), iOS 26.6.1. Mac pairing and owner-enabled Developer Mode succeeded.
The same private candidate was rebuilt with a development profile verified to
include the SE; signature verification, installation and launch succeeded.
Normal public SDK resolution was restored after building. Original-phone
application journals are intact. At that observation, the SE used a different
Apple Account and was not offered by Mac iPhone Mirroring. The development-server
connection through the normal client launch URL succeeded. The owner completed login; passive
runtime inspection verified authenticated/onboarded state and the selected
device. Reconnection retries prevented a fresh successful recording catalog,
and a later launch was blocked by the SE's lock screen. Normal-UI
upload/receipt/cleanup remain unverified.

The owner subsequently clarified that Apple Accounts change between runs. A
fresh Mirroring selector offered the SE, and the current selection changed to
it, but setup reached Unlock iPhone and then Unable to Connect. Check current
eligibility and an actual connected phone screen each run. The later Demo
1.0.14 fresh-phone reconciliation candidate has compiled but remains uninstalled
because code signing returns `errSecInternalComponent`; unlocked-keychain and
valid-identity checks do not establish usable private-key access.

On October 11, SE Mirroring setup completed. The actual Home Screen was observed
and a swipe changed its page, verifying remote control. Demo was not launched
in that connection check; encrypted upload, receipt and cleanup remain
unverified on this phone.

The subsequent October 11 private Demo 1.0.14 build passed signing and strict
signature/provisioning/runtime checks, and device metadata confirmed an in-place
SE installation of 1.0.14(1). Candidate inspection again matched the public
beta.14 manifest/Rust payload and the two reviewed Apple source corrections;
normal public package resolution was restored. Demo was controlled through
Mirroring, but native reconnect returned `device_not_found`, operation
`reconnect`, `retryable: true`, beneath `apple_sdk_error`. No verified SDK
connection or successful device catalog was obtained, and no sync was invoked.
Reconnect's fresh-scan/serial-verification path is unchanged by these fixes;
no journal or old peripheral ID was copied to seed it. Physical upload,
publication, receipt and cleanup qualification remain open.

A later normal-UI 30-second scan found no Bota-named advertisements. The SDK
reported Bluetooth ready and five nearby cached peripherals, three unnamed;
their identity is unverified. Reconnect still returned `device_not_found` after
the user confirmed other phones were disconnected. Demo exited to Home again;
no matching crash/Jetsam report was available, so the cause is unconfirmed.
No binding changes or sync occurred, and the physical qualification gates remain
open.

Local tests cover model compatibility, native callback forwarding, missing
context, nonce owner/reconnect fencing, catalog bytes and metadata, malformed
catalog cleanup, context timeout/late callback fencing, signed replacement
constraints, skipped PUT with tampered-file rejection, and retained lost-ACK
regressions. The 128-through-139 frame-bound test reproduced 36 assertion
failures with the old admission guard, then passed with the 140-byte minimum;
the exact 140-byte boundary also passes. Pre-entry Swift task cancellation is
verified to prevent BLE capability reads, provider calls, and engine startup.

On 2026-09-24, against the parent's fresh beta.2 XCFramework:

```sh
BOTA_PHYSICAL_TESTS=0 swift test --package-path platforms/apple --scratch-path target/v2-demo-apple --jobs 4
node tools/apple/sync-encrypted-upload-v2-vectors.mjs --check
git diff --check -- platforms/apple docs/parity/v2-demo-apple.md
```

Full Swift result: 247 tests, nine physical tests skipped, zero failures.
The Rust owner's canonical unknown-capability fixture now tests bit `0x400`
because `0x100` is supported; synchronized fixture SHA-256 is
`71af9eb02c92ac694c51630d1cad2d7614db7d5d9435df0999d36bd1170d21af`.
No XCFramework build, CI dispatch, publication, or physical-device operation
was performed by this Apple workstream. Physical and release gates remain open.
