# Apple v2 Maintenance Parity

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
