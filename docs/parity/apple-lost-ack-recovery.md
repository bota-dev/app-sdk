# Apple Lost-WINDOW_ACK Recovery

Verified on 2026-09-24 against maintenance reference commit `318974f`, including
the `f32410a` regressions in `encryptedUploadV2ProtocolHandler.test.ts` and the
`ProtocolHandler.transferEncryptedUploadV2` implementation.

## Behavior

- One reconciliation is permitted for a resumed transfer, only on
  `RESUME_REJECT` reason `0x000f`. Both revision and offset must be strictly
  older. Zero revision and zero offset must occur together. The device prefix
  SHA-256 must match the local ciphertext file before any metadata replacement.
- Foreign transport sessions, foreign ownership rejection, newer/equal
  checkpoints, inconsistent zero boundaries, hash mismatch, and repeated
  rejection fail closed without another rollback or implicit legacy fallback.
- The native sidecar is atomically replaced and flushed before truncation. A
  persistence failure cannot authorize truncation or retry. Successful
  reconciliation keeps recording/upload/owner/sink identity and negotiated
  bounds, and resets the resumed packet-sequence boundary to zero (absent at
  offset zero), not the old transport's last sequence.
- Rust still encodes all START, RESUME_REQUEST, WINDOW_ACK, CONFIRM and ABORT
  frames and produces every opaque core checkpoint. The host uses the existing
  Rust resume-restart transition: `requiresCoreRestart` marks the native
  sidecar authoritative while the old core checkpoint is retired. The exact
  owned delete effect retains that sidecar, and the truncate effect uses its
  verified offset. Reload omits the retired opaque core checkpoint, preserving
  the native prefix through restart; the next normal Rust checkpoint replaces
  the marker. No opaque core checkpoint is decoded or rewritten in Swift.
- Reconciliation retains the original `0409` subscription, peripheral/session
  identity, and internal control generation; retry does not re-subscribe.
  Observed source termination rejects retry, ACK and CONFIRM before dispatch.
  An explicitly invoked `resetAfterConfirmedDisconnect()` invalidates the
  internal generation. This is not a production disconnect barrier; see the
  live ownership limits below. The original bounded notification reader is
  handed to the host, retaining the 1 MiB byte cap and phase/window limits
  without another buffering queue.
- Cancellation and restart callbacks remain bound to their generation and
  cancellation ID. Cancellation returns `CancellationError` to a cancelled
  caller; a stale or foreign restart cannot delete the saved prefix.
- No data-mode, radio-policy, ABI, version, core, or React Native changes are
  part of this Apple implementation.

## Verification

Native bridge preparation: `tools/apple/build-xcframework.sh` succeeded. An
initial shared-tree test build encountered other agents' unfinished diagnostics
tests. Red evidence was therefore captured from a disposable baseline snapshot
under `target/apple-lost-ack-source`, with only the new Apple regression tests
overlaid, before implementation:

```sh
swift test --package-path target/apple-lost-ack-source/platforms/apple \
  --scratch-path target/apple-lost-ack-isolated \
  --filter 'EncryptedUploadV2TransferHostTests.testLostAck'
```

All six initial regressions failed (21 assertions/errors): missing durable
rollback, destructive restart on unsafe rejection, and stale START/ABORT on a
replacement connection. Further red/green checks caught cancellation/foreign
delete fallthrough and stale CONFIRM after notification termination.

Final checks on the shared worktree and native XCFramework:

```sh
swift test --package-path platforms/apple --scratch-path target/apple-lost-ack \
  --filter EncryptedUploadV2
swift test --package-path platforms/apple --scratch-path target/apple-lost-ack
swift test --package-path frameworks/react-native --scratch-path target/apple-lost-ack-rn
```

- Focused: **92 tests, zero failures**.
- Full Apple package after diagnostics integration: **226 tests, 9 skipped
  physical tests, zero failures**. Independently repeated during review.
- Final RN Apple adapter against the current native package: **42 tests, zero
  failures**, with complete concurrency checking and warnings treated as errors.
- Lost-ACK plus caller-cancellation and closed-source guards: **20 consecutive
  successful runs**, 11 tests per run.
- The two successful recovery tests drive the real Rust engine through
  checkpoint creation, rejection, restart, retransmitted window persistence,
  ACK, EOF, and the staging effect. Other tests cover reload after persistence,
  persistence failure, invalid rejection combinations, repeat rejection,
  cancellation identity, confirmed disconnect and original-source termination.

This is automated source-level evidence, not hardware, firmware, publication,
BLE interoperability, or physical power-loss qualification. Actual filesystem
power-loss behavior and device checkpoint/sequence behavior still require the
separate supervised physical-device gates. Compatibility metadata remains
contract-only.

## Live Ownership Limits

Read-only integration review found a pre-existing production disconnect wiring
gap: `EncryptedUploadV2TransferControl.resetAfterConfirmedDisconnect()` has no
production caller in the current Apple source tree. `BotaConfiguration` routes
disconnect through `CoreBluetoothHost.disconnect`; it does not invoke the
transfer-control reset. Consequently, generation invalidation currently applies
only when an internal caller explicitly invokes that hook, as the tests do.

The live retry guard is the retained notification reader. `CoreBluetoothDriver`
finishes its subscription on disconnect; after the reader observes that
termination, the new retry fails without re-subscribing. Termination observation
is asynchronous. It is not an atomic connection lease at native write execution.

ID-only queued writes and unsubscribe operations also predate this change.
Cleanup validates generation and reads reader state in separate actor hops, so
a reset between those checks is not an atomic barrier. A write or unsubscribe
already admitted to the host/driver queue can still race a same-ID replacement
connection. The new guards reduce that exposure but do not establish the stronger
claim that no stale operation can execute on a replacement connection. Tests
cover explicit internal reset and observed stream termination, not a live
disconnect/reconnect barrier across native queues. No generic transport or
production disconnect-wiring changes were made in this parity work.
