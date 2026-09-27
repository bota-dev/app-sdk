# Android v2 maintenance parity

Unpublished source parity against maintenance reference
`318974f925a573cf04b0d624978bee04784af09b`. This does not change the frozen
0.0.65 public baseline, published beta.1, SDK version, or contract-only v2
capability/release metadata. Physical firmware acceptance remains unverified.

## Native interfaces

- `RecordingManager.listEncryptedUploadV2Recordings(device)` returns full-UUID
  `EncryptedUploadV2Recording` values. Rust owns LIST framing, ordered entry
  accumulation, session/count/digest validation, and the 4,096-entry bound.
  Android subscribes to catalog and command-error characteristics before LIST,
  enforces a 30-second deadline, and releases both subscriptions on every exit.
- `listPendingRecordings(device)` returns `PendingRecording.EncryptedV2` and
  `PendingRecording.Legacy` wrappers. It reads legacy first, then v2, returns v2
  first, suppresses matching four-byte legacy aliases, and rejects collisions.
  Only explicit characteristic absence permits legacy-only listing. Malformed
  capabilities, incomplete admission flags, and GATT failures never downgrade.
- Recording metadata adds `startedAtMs`, `durationMs`, and `plaintextLength`
  (`ULong`, default zero), plus `storageFormat` (`UByte`, default three).
  Existing four-argument construction remains valid. Millisecond conversion is
  checked for overflow; ciphertext digests remain defensively copied.
- `EncryptedUploadV2ContextExchange(challenge, exchangeProof)` and
  `EncryptedUploadV2ContextProvider` keep opaque documents native. The provider
  is `suspend (ByteArray) -> EncryptedUploadV2ContextExchange`; proof exchange is
  `suspend (ByteArray) -> ByteArray`. Optional `Material.uploadContext` preserves
  construction compatibility, but absence rejects before context BEGIN,
  authorization, or transfer writes. Capability/MTU reads may precede selection.
- `EncryptedUploadV2ProviderContext.readAuthNonce()` is available only while
  that exact native provider operation owns its original device connection.
  It validates operation ownership, coroutine cancellation, generation and
  device identity before and after the read, and requires exactly 16 bytes.
  It is independent of the device-owned upload-context nonce. No nonce or
  document is sent through a JavaScript bridge by this implementation.
- The existing sync signature is retained. An additive
  `syncEncryptedRecordingV2(device, recording, operationId, provider)` overload
  and `cancelEncryptedRecordingV2(operationId)` permit exact native cancellation.
  A stale ID cannot cancel an unrelated recording operation.
- `Material.cancelPreparation()` invokes its cancellation callback at most
  once, for unused native material cleanup. `shouldUploadCiphertext(evidence)`
  defaults to true. False skips the staging request and PUT while still checking
  the complete native file, submitting the manifest callback, emitting staging
  evidence, and completing through finalization, receipt and CONFIRM.

## Context and recovery

The host obtains fresh upload context before authorization and again before
first receipt delivery. Each independent attempt has one 30-second deadline
including device reads, provider/proof latency and signed-document delivery.
Bounded polling tolerates lost hints without refreshing the deadline. Rust
validates context snapshots and challenge/result shapes, and encodes all
BEGIN and signed-blob frames. The backend and device remain the signature,
credential and trusted-time authorities. Failure never selects legacy.

Rust-decoded authorization identity must match selected session, owner,
recording UUID/generation, storage/profile/policy, BLE channel, exact ciphertext
length and digest. Replacement additionally requires the advertised recovery
feature, signed replacement flag, distinct session, strictly increasing bounded
owner revision and retained matching ciphertext identity. Backend session
recovery, successor traversal and HTTP retry policy remain application-owned.

New native checkpoint sidecars store ciphertext length/digest and checkpoint
interval alongside unchanged opaque Rust bytes. Versions one and two remain
readable: historical records without ciphertext identity can resume their exact
owner but cannot authorize replacement. No opaque checkpoint bytes are
reinterpreted or guessed. A replacement starts from zero with a fresh native
sink; its old catalog entry remains until a new durable checkpoint supersedes
it. Failed selection, context or admission preserves the old checkpoint/file.
Superseded old sink files are conservatively retained; automatic orphan-file
reclamation is not claimed by this change.

Existing lost-WINDOW_ACK replay, diagnostics, durable-before-ACK ordering,
receipt-gated deletion and post-CONFIRM uncertainty behavior remain intact.
The broader queued ID-only GATT connection-replacement limitation described in
the maintenance parity overview is not resolved by this work. Provider and
context callbacks add before/after generation fencing, not a new transport API.

## Verification

Local gates use the existing pinned JDK/Android toolchain. Fresh Rust native
libraries were built for all four Android ABIs with the frozen additive header.
Both complete JVM suites passed: 224 debug and 224 release tests, with no
failures or skips. Lint, release AAR, instrumentation APK compilation and local
Maven publication passed. The complete debug/release JVM suites cover catalog ordering/failures, native
ABI field mapping, context deadline/order, missing provider, exact cancellation,
nonce lifetime, signed replacement identity, historical checkpoints, skip-PUT
completion and existing transfer/diagnostic regressions. Lint, release AAR and
local Maven publication were separate from the unit-test invocation.

The additive real-JNI catalog/context codec instrumentation test is included,
but was not executed because no emulator or physical Android device was
attached. This work claims no hardware, power-loss, backend deployment or
published-package acceptance. The local verification artifact uses existing
coordinates `dev.bota:bota-app-sdk:2.0.0-beta.2` in `target/android-m2`.
