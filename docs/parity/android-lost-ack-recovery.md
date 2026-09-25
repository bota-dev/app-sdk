# Android Lost-WINDOW_ACK Recovery

## Reference And Scope

Maintenance reference: `318974f925a573cf04b0d624978bee04784af09b`, specifically
`f32410ae3415e6d160ea8b82b495edfc3758d1cd` in `src/protocol/ProtocolHandler.ts`
and `__tests__/encryptedUploadV2ProtocolHandler.test.ts`.

This is Android-native source parity, not firmware, hardware, or published
release acceptance. Root documentation, versions, shared Rust, ABI, and React
Native sources are outside this change's ownership.

Owned changes are `EncryptedUploadV2TransferControl.kt`,
`EncryptedUploadV2TransferReceiver.kt`, `EncryptedUploadV2CheckpointStore.kt`,
`EncryptedUploadV2TransferHost.kt`, their four matching Android `*Test.kt` files,
and this evidence note. Other shared-worktree modifications belong to their
respective owners.

## Recovery Contract

- Only a RESUME_REJECT for the exact transport session with reason `0x000f`
  can reconcile. Both revision and ciphertext offset must be strictly older;
  zero revision and zero offset must agree. Other reasons, foreign sessions,
  newer/equal checkpoints, corrupt prefixes, and a second rejection fail closed.
- The receiver verifies the device prefix against the retained native file.
  It constructs a new checkpoint without changing the caller's original
  checkpoint. Sequence state restarts at zero for a nonempty prefix and is
  absent for an empty prefix, matching the maintenance behavior.
- The atomic catalog replacement completes before truncation. A failed save
  retains the old bytes and checkpoint. Cancellation or connection replacement
  during persistence prevents truncation and retry; a committed older
  checkpoint with surplus file bytes remains recoverable.
- The retry retains the same `0409` subscription, upload identity, transport
  session, negotiation bounds, and connection generation. A zero prefix uses
  START; a nonzero prefix uses RESUME_REQUEST. All outgoing protocol frames
  still come from the existing Rust mapper, including replay repair/clean ACKs.
- Opening cancellation is checked against both the caller coroutine and the
  host lifecycle. Cleanup carries the exact session object, coalesces concurrent
  aborts, and skips BLE writes/unsubscribe against a replacement generation.
  A late opening cancellation cannot undo CONFIRM or cancel a newer owner.

## Opaque Rust Checkpoints

The existing Rust reducer accepts only forward-progress windows relative to its
selected checkpoint. Android does not rewrite its opaque checkpoint encoding or
fabricate a lower Rust checkpoint.

Instead, native sidecar version 2 stores an optional `EncryptedUploadV2ReplayBoundary`
beside the verified native prefix. It retains the exact original Rust bytes and
their revision/offset boundary. Version 1 sidecars remain readable.

On restart, Rust loads its original bytes, while the host truncates/prepares only
the durable native prefix. Retransmitted windows are verified, repaired as
needed, durably saved, and acknowledged natively until their revision exceeds
the original revision AND their offset reaches or exceeds the original offset.
Rewindowing can cross either coordinate first; these intermediate checkpoints
remain restartable without rewriting the original Rust bytes. They are not
reported as new Rust progress. The first window satisfying both conditions
returns to normal Rust WINDOW_STAGED/SAVE_CHECKPOINT/ACK handling and clears the
replay marker. EOF continues to require full ciphertext and manifest integrity.

## Verification

Tests exercise real native control, receiver, and catalog behavior with fake
Bluetooth/JNI packet and journal boundaries. Host fixtures use real temporary
ciphertext files. They do not establish physical-device or actual JNI execution.

Observed red-green regressions:

- Stale-generation active write and abort/unsubscribe: two failures before the
  connection guards.
- Zero/nonzero recovery, unsafe checkpoint rejection, and a reconnect during
  persistence: three failures before host reconciliation.
- Caller cancellation and a cancellation claim during persistence: failures
  before the post-persistence caller/host checks.
- Concurrent abort: duplicate cleanup before the shared cleanup completion.
- Late cancellation after successful CONFIRM with uncertain unsubscribe:
  extra ABORT before the confirmation guard.
- Review regression: old `(revision=2, offset=4)` reconciles to `(1, 2)`, then
  rewindowed progress reaches `(2, 6)` before `(3, 8)`. The host and sidecar
  decoder both failed before permitting independent boundary crossings.
  The complementary `(3, 3)` intermediate checkpoint also passes, including
  native-prefix truncation after reopening each intermediate checkpoint.

Additional coverage includes retained subscription and Rust encoder fields,
single retry, repeated device rejection, stale callback after replacement,
checkpoint-before-truncate ordering, interrupted recovery followed by a fresh
host, version 1 compatibility, version 2 replay persistence, replay repair,
replay persistence failure before ACK, forward-progress return to Rust, and EOF.

Full unfiltered `./gradlew :sdk:test --continue --console=plain` passed on
2026-09-24: **201 debug + 201 release tests**, zero failures/errors/skips.
Each variant includes **73 encrypted-upload tests**. Both variants compile with
warnings treated as errors. JDK 17 and the configured Android SDK were used.

Earlier shared-worktree runs encountered unfinished diagnostics compilation and
one transient `DeviceDiagnosticsTest` failure. A temporary external Gradle init
script excluded only unfinished diagnostics tests for early focused red-green
runs; the full passing run used no exclusions and no init script.

After Android diagnostics sources were finalized, the unfiltered test
run completed, followed by successful
`./gradlew :sdk:lint :sdk:assemble :sdk:publishMavenPublicationToLocalRepository
--console=plain`. Both exited zero. Protocol fixtures (9
suites) and workflow fixtures (33 scenarios) were current; the lint report says
`No issues found.` The earlier local
publication was superseded after the rewindowing regression fix.

- Local repository: `target/android-m2`
- Coordinate: `dev.bota:bota-app-sdk:2.0.0-beta.1`
- AAR: `dev/bota/bota-app-sdk/2.0.0-beta.1/bota-app-sdk-2.0.0-beta.1.aar`
- Published: `2026-09-24 18:04:57 PDT`; size `3874190` bytes.
- AAR SHA-256: `c2e0a0f16ed8af9735f08f0073fa0f27b8d8611764f3c3d0f747f667964eb0cb`
- Native input SHA-256 before/after:
  `320bbf153681a4ea42cf4f01efff93ac2fa5929feef2a2f1f40935d8baab0e22`.
  This hashes sorted, nonignored files under `platforms/android`, `core`,
  `bindings`, `tools/android`, `protocol`, and the root SDK/Cargo/toolchain
  manifests. RN and Apple sources are excluded.
- AAR inspection found both JNI and Rust shared libraries for all four Android
  ABIs. The final build reused the diagnostics owner's already rebuilt Rust
  libraries; the resume fix changes no Rust source or wire encoding.
- XML results: `platforms/android/sdk/build/test-results/testDebugUnitTest/`
  and `testReleaseUnitTest/`.

The coordinating task received the final repository path and checksum for its
RN integration refresh. This is local publication only, not a public release.

## Remaining Gates

No physical BLE, device power-loss, Android process-kill instrumentation,
firmware-advertisement, or published-consumer acceptance was run for this change.
File/journal ordering and restart behavior are unit-tested, not proof of storage
durability under physical power loss. The native replay host fixtures use
synthetic opaque Rust checkpoint bytes; actual v2 JNI/reducer integration is a
remaining gate. Runtime compatibility metadata remains
unchanged. Cross-platform and RN integration belong to the coordinating task.
