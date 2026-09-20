# Task 8 Report: Web Provisioning, Deprovision, and Settings

## Status

DONE

- Starting HEAD: `66201ad28bf1f50176782d82adf57298b60c00e0`
- Commit subject: `feat(web): add provisioning and settings`
- Trailer: `Co-Authored-By: OpenAI Codex <noreply@openai.com>`
- Scope stopped at Task 8. Task 9 was not started.

## Implementation Summary

- Added `ProvisioningManager` and composed it into `BotaDeviceClient` with the
  host-owned `ProvisioningProvider` contract.
- Passed the caller's opaque attempt ID, a fresh Device Information serial,
  Rust-read nonce, and Rust-read device public key to provider `prepare`.
- Kept endpoint and device-token bytes memory-only. Provider inputs, provider
  material, Rust/WASM BLE effect payloads, direct command copies, and encoded
  settings are zero-filled at their terminal ownership boundary.
- Added the durable close-loop phases `prepared`, `device_applied`,
  `backend_confirmed`, and `aborted`. Physical completion is durable before
  backend confirmation, and a failed confirmation resumes only `confirm` for
  the same attempt without touching the device.
- Fenced provider, cancellation, and destruction callbacks so an old attempt
  cannot dispatch or persist into a newer attempt. Physical failure invokes
  provider `abort`; confirmation failure never aborts or deprovisions.
- Added non-destructive deprovision under the shared runtime owner: fresh serial
  verification, grant write, result subscription, Rust-encoded opcode `0x05`,
  post-command result correlation, a 30-second default result bound, and
  unconditional unsubscribe. Cancellation joins an in-flight GATT operation
  before cleanup.
- Added connection-settings read/write under the shared owner with fresh serial
  and model reads. Rust remains the only settings decoder/encoder, including
  unsupported-version defaults, Note cellular normalization, and canonical v2
  heartbeat serialization. A write performs one response-bearing GATT write.
- Added canonical Task 8 GATT characteristic constants and stable, redacted
  error mapping. No Task 9 WiFi or recording-control behavior was added.

## Files Changed

- `.superpowers/sdd/2026-09-17-web-sdk-foreground-workflows/task-8-report.md`
- `frameworks/web/src/provisioningManager.ts`
- `frameworks/web/src/__tests__/provisioningManager.test.ts`
- `frameworks/web/src/providers.ts`
- `frameworks/web/src/models.ts`
- `frameworks/web/src/gatt.ts`
- `frameworks/web/src/workflowRuntime.ts`
- `frameworks/web/src/client.ts`
- `frameworks/web/src/index.ts`

## RED Evidence

The Task 8 tests were written before the production manager and contracts:

```text
PATH=/Users/zhangqi/.nvm/versions/node/v22.23.2/bin:$PATH \
  node --test src/__tests__/provisioningManager.test.ts
Result: expected failure, ERR_MODULE_NOT_FOUND for provisioningManager.ts.
```

The full Web RED confirmed only the new Task 8 file failed:

```text
PATH=/Users/zhangqi/.nvm/versions/node/v22.23.2/bin:$PATH \
  npm test --prefix frameworks/web
Result: expected failure; 226 existing tests passed and the new import failed.
```

Security and exact-identity review added two focused RED checks before their
production changes:

```text
node --test src/__tests__/provisioningManager.test.ts
Result: expected failure; 11 passed and the captured provisioning BLE payload
reference remained nonzero after the workflow.

node --test --test-name-pattern='fresh exact context' \
  src/__tests__/provisioningManager.test.ts
Result: expected failure; the manager rejected an opaque caller attempt ID
instead of passing it through exactly.
```

The first static gate also found the exact-optional timeout fixture mismatch:

```text
npm run type-check --prefix frameworks/web
Result: expected TS2379 failure for `deprovisionTimeoutMs: number | undefined`.
```

## GREEN Evidence

Focused provisioning/settings gate:

```text
PATH=/Users/zhangqi/.nvm/versions/node/v22.23.2/bin:$PATH \
  node --test frameworks/web/src/__tests__/provisioningManager.test.ts
Result: PASS, 12 passed, 0 failed, 0 cancelled, 0 skipped.
```

The existing Rust/WASM parity suite is part of the full Web gate and covers the
released deprovision status meanings, unknown-byte preservation, exact `0x05`
encoding, connection-settings fixture bytes, Rust defaults, Note normalization,
and the canonical v2 heartbeat mask. No new Rust codec was needed.

Full Web gate:

```text
PATH=/Users/zhangqi/.nvm/versions/node/v22.23.2/bin:$PATH \
  npm test --prefix frameworks/web
Result: PASS, 238 passed, 0 failed, 0 cancelled, 0 skipped.
```

Type-check and build:

```text
PATH=/Users/zhangqi/.nvm/versions/node/v22.23.2/bin:$PATH \
  npm run type-check --prefix frameworks/web
Result: PASS, TypeScript completed without errors.

PATH=/Users/zhangqi/.nvm/versions/node/v22.23.2/bin:$PATH \
  npm run build --prefix frameworks/web
Result: PASS, ESM JavaScript, declarations, and the WASM asset were emitted.
```

Diff validation:

```text
git diff --check
Result: PASS, no whitespace errors.
```

## Coverage

The focused tests prove:

- exact opaque attempt ID, fresh serial, nonce, and public-key provider input;
- prepared/device-applied/confirmed ordering with no secret journal fields;
- provider-buffer zero-fill on success, cancellation, failure, destruction,
  and late completion, plus BLE-effect payload zero-fill after completed writes;
- provider abort on physical rejection and no false backend completion;
- retryable confirm failure with same-attempt confirm-only recovery and no GATT;
- old-attempt callback fencing across cancellation and a newer attempt;
- grant-write/subscribe/Rust-opcode/result/unsubscribe deprovision ordering;
- stale pre-command result rejection, bounded timeout, stable non-reset errors,
  and in-flight-write cancellation joining;
- Rust defaults on settings read, Rust Note normalization and heartbeat mask on
  write, exactly one response write, and immutable caller settings; and
- shared runtime ownership plus changed-serial rejection before settings I/O.

## Self-Review

- Confirmed TypeScript constructs no provisioning, deprovision, or settings
  wire packet. Provisioning is the Rust workflow; direct packets use only the
  Rust/WASM codec exports already covered by committed fixtures.
- Confirmed backend prepare cannot mark binding complete. `device_applied` is
  saved only after Rust reports physical success and before provider confirm.
- Confirmed a `device_applied` retry cannot invoke provider prepare, rewrite
  endpoint/token bytes, or send any device operation.
- Confirmed abort is restricted to pre-physical-completion failures. Provider
  confirm failure leaves the journal at `device_applied` and is retryable.
- Confirmed journals and public errors contain no endpoint, token, nonce, key,
  provider exception detail, URL, or raw packet bytes.
- Confirmed deprovision uses only opcode `0x05`, preserves its non-destructive
  name and result, and contains no reset API, reset wording, or data deletion.
- Confirmed settings re-read both serial and model under the same direct owner;
  Note normalization and default expansion are not duplicated in TypeScript.
- Confirmed no Task 9 manager, provider, model, GATT behavior, test, or export
  was added.

## Documentation Impact

Changed-token searches covered `internal-docs/`, public `docs/`, the App SDK
plan/spec, and repository `AGENTS.md`, `ARCHITECTURE.md`, and `README.md` files.
Tokens included `ProvisioningManager`, `ProvisioningProvider`,
`DEVICE_SETTINGS_CHARACTERISTIC`, `backend_confirmed`,
`encodeDeprovisionCommand`, `readConnectionSettings`,
`writeConnectionSettings`, and `deprovision`.

The authoritative provisioning/security documents already distinguish
non-destructive opcode `0x05` from authenticated factory reset, and the approved
Web design already defines this close-loop and settings surface. This task does
not change that cross-system contract or claim completed browser support.
Task 14 owns the public capability/status and physical-evidence updates. This
report is the immediate implementation documentation required for Task 8.

## Concerns

- No physical Chromium/device/backend run was performed. Automated tests prove
  ownership and packet parity only; Tasks 13 and 14 own browser and physical
  acceptance evidence.
- A process crash in the narrow interval after the device reports provisioning
  success but before `device_applied` commits leaves the durable phase at
  `prepared`. The manager fails that ambiguous resume closed and never rewrites
  the device; operator/backend reconciliation is still required for that crash
  interval because the approved journal has no physical-result evidence field.

## Fix Round 1

### Status and Scope

- Starting HEAD: `35a958e02e3e4b43cb31daf2bee13086787de640` (verified clean).
- Commit subject: `fix(web): harden provisioning close loop`.
- Scope remains Task 8 only. No Task 9 behavior, firmware implementation,
  backend implementation, publish, push, or physical-device operation was
  performed.
- This section supersedes the original report's claim of deprovision "result
  correlation." The released one-byte result supports only a bounded
  post-write freshness window, not exact command-bound correlation.

### Resolved SDK Behavior

- The workflow runtime now retains one mutating owner from physical success
  through the durable `device_applied` save and the provider-confirm outcome.
  Deprovision, settings, and another provisioning attempt cannot pass a blocked
  durable handoff.
- Physical success is recorded before completion cleanup. A later unsubscribe
  or other cleanup failure cannot invoke provider `abort` or persist `aborted`;
  the close-loop handoff still saves `device_applied` and attempts confirmation.
- `device_applied` confirmation is unabortable once initiated. Cancel and
  destroy join the provider promise and durable journal resolution before owner
  release, so an old confirm cannot overlap a newer attempt or publish a late
  journal transition into it.
- Every initiated generic workflow GATT write is tracked. Cancellation first
  joins those unabortable writes, then performs host/subscription cleanup and
  releases ownership. Secret effect, runtime transport, and Web Bluetooth
  copies remain live until the write settles and are then zero-filled.
- Provisioning generates one operation-scoped `materialId`, supplies it to both
  Rust and `ProvisioningProvider.prepare`, requires the provider response to
  match exactly before any sensitive device write, and persists the nonsecret
  identity immutably with the attempt and serial.
- A durable `prepared` journal is now a retryable
  `reconciliation_required` state. The SDK reacquires the shared owner and
  freshly verifies the connected serial, then performs no prepare, confirm,
  abort, or device write because current firmware cannot prove whether the
  exact material was durably applied. Another attempt for the same serial is
  also blocked by that unresolved state. A pre-fix journal with no material ID
  is preserved as explicit, immutable `materialId: null` and follows the same
  typed recovery path; the SDK never invents an identity for it.
- Deprovision subscribes before the Rust-encoded opcode and opens its result
  window only after the opcode write settles. A stale pre-write or in-write
  notification is ignored; the post-write wait remains bounded to 30 seconds
  by default and teardown always unsubscribes.
- WASM bridge number-array and typed-array copies used by provisioning dispatch
  are zero-filled after the synchronous bridge call. Normalized effects retain
  independent owned bytes, and the recursive scrubber copies nonsecret array
  inputs before scrubbing so it cannot mutate caller state.
- Public errors remain fixed and redacted; `reconciliation_required` exposes no
  journal material, endpoint, token, nonce, key, provider error, or raw packet.

### Files Changed

- `.superpowers/sdd/2026-09-17-web-sdk-foreground-workflows/task-8-report.md`
- `frameworks/web/src/provisioningManager.ts`
- `frameworks/web/src/workflowRuntime.ts`
- `frameworks/web/src/webBluetoothTransport.ts`
- `frameworks/web/src/wasmCore.ts`
- `frameworks/web/src/providers.ts`
- `frameworks/web/src/storage.ts`
- `frameworks/web/src/indexedDbWorkflowStore.ts`
- `frameworks/web/src/errors.ts`
- `frameworks/web/src/__tests__/provisioningManager.test.ts`
- `frameworks/web/src/__tests__/workflowRuntime.test.ts`
- `frameworks/web/src/__tests__/transport.test.ts`
- `frameworks/web/src/__tests__/storage.test.ts`
- `frameworks/web/src/__tests__/fakeProviders.ts`
- `frameworks/web/src/__tests__/deviceManager.test.ts`

No Rust source or generated protocol implementation changed.

### RED Evidence

The Fix Round 1 probes were added before their production changes and failed in
the expected ownership, identity, recovery, and zeroization paths:

```text
PATH=/Users/zhangqi/.nvm/versions/node/v22.23.2/bin:$PATH \
  node --test src/__tests__/provisioningManager.test.ts
Result: expected RED, 11 passed and 8 failed out of 19.
Failures covered missing prepare materialId, accepting cross-material output,
nonzero WASM bridge copies, early release during a blocked token write,
post-success cleanup incorrectly aborting, owner release before a blocked
device_applied save, prepared resume returning resume_rejected, and early
release during a blocked provider confirm.

PATH=/Users/zhangqi/.nvm/versions/node/v22.23.2/bin:$PATH \
  node --test src/__tests__/workflowRuntime.test.ts
Result: expected RED, 18 passed and 1 failed out of 19; cancellation released
the workflow owner before the blocked GATT write settled.

PATH=/Users/zhangqi/.nvm/versions/node/v22.23.2/bin:$PATH \
  node --test src/__tests__/transport.test.ts
Result: expected RED, 15 passed and 1 failed out of 16; Web Bluetooth's owned
write copies remained nonzero after both write modes settled.

PATH=/Users/zhangqi/.nvm/versions/node/v22.23.2/bin:$PATH \
  node --test src/__tests__/storage.test.ts
Result: expected RED, 57 passed and 3 failed out of 60; material identity was
not immutable, was absent after reopen, and could not be enumerated.

PATH=/Users/zhangqi/.nvm/versions/node/v22.23.2/bin:$PATH \
  node --test src/__tests__/storage.test.ts
Result: expected migration RED, 60 passed and 1 failed out of 61; a valid
`prepared` journal written by the starting commit without `materialId` still
failed as `resume_rejected` instead of preserving explicit unknown identity.
```

### GREEN Evidence

```text
PATH=/Users/zhangqi/.nvm/versions/node/v22.23.2/bin:$PATH \
  node --test src/__tests__/provisioningManager.test.ts \
    src/__tests__/workflowRuntime.test.ts \
    src/__tests__/transport.test.ts src/__tests__/storage.test.ts
Result: PASS, 116 passed, 0 failed, 0 cancelled, 0 skipped.

PATH=/Users/zhangqi/.nvm/versions/node/v22.23.2/bin:$PATH npm test
Working directory: frameworks/web
Result: PASS, 248 passed, 0 failed, 0 cancelled, 0 skipped.

PATH=/Users/zhangqi/.nvm/versions/node/v22.23.2/bin:$PATH npm run type-check
Working directory: frameworks/web
Result: PASS; the WASM build and `tsc --noEmit` completed without errors.

PATH=/Users/zhangqi/.nvm/versions/node/v22.23.2/bin:$PATH npm run build
Working directory: frameworks/web
Result: PASS; the WASM asset, ESM JavaScript, and declarations were emitted.

cargo test -p bota-device-sdk-wasm
Result: PASS, 13 passed, 0 failed.

cargo test -p bota-device-sdk-core --test provisioning_workflow
Result: PASS, 4 passed, 0 failed.

git diff --check
Result: PASS, no whitespace errors.
```

### Self-Review

- Confirmed `device_applied` and `backend_confirmed` occur while the same shared
  runtime owner remains active; every exit releases ownership only after the
  completion handoff and cleanup settle.
- Confirmed physical success flips the abort fence before either durable work or
  cleanup can fail. Only a pre-success failure can call provider `abort`.
- Confirmed a blocked provider confirm is joined even when caller cancellation
  and client destruction race it; the durable result is settled before the old
  operation reports cancellation and before another owner can start.
- Confirmed a `prepared` journal never causes automatic device replay, backend
  confirmation, or provider abort, and a `device_applied` journal performs
  confirm-only recovery.
- Confirmed TypeScript does not hand-build provisioning, deprovision, or settings
  protocol bytes. Opcode `0x05`, result decoding, settings defaults, Note
  normalization, and the v2 heartbeat mask remain Rust/WASM-owned.
- Confirmed direct and workflow writes preserve caller arrays, join the native
  promise, and then zero every SDK-owned transport/effect copy visible to tests.
- Confirmed no endpoint or token is journaled, logged, included in a public
  error, or retained after a terminal success/cancellation path.
- Confirmed no Task 9 symbols or behavior were added.

### Documentation Impact

Changed-token searches covered all workspace `internal-docs/`, public `docs/`,
the App SDK plan/spec, and every repository `AGENTS.md`, `ARCHITECTURE.md`, and
`README.md`. Tokens included `materialId`, `reconciliation_required`,
`listProvisioningJournals`, `WorkflowCompletionHandoff`, `resultWindowOpen`, and
`scrubBridgeBytes`.

The authoritative provisioning design already requires the versioned exact
result and records the released raw-token profile as compatibility-only. No
published SDK guide currently documents `ProvisioningProvider`; this report is
the Task 8 implementation record, while Task 14 remains responsible for public
capability/status wording and physical evidence. The new nonsecret journal
`materialId` is a Fix Round 1 requirement needed to preserve exact attempt
identity. Pre-fix records preserve absence as `null` rather than fabricating
identity; endpoint and token bytes remain excluded.

### Residual Firmware and Target-Contract Gaps

- Released firmware exposes a one-byte provisioning/deprovision result with no
  action, attempt, material, nonce, or command identity. The SDK now rejects
  stale notifications before the opcode write settles and bounds the post-write
  wait, but it does not and cannot claim exact command-bound correlation.
  Task 14 needs a negotiated, Rust-decoded versioned result tied to the exact
  action and provisioning material.
- After a crash with durable phase `prepared`, current firmware provides no
  exact persisted attempt/material outcome that can prove whether those bytes
  were applied. Generic `PAIRING_STATE` or `PAIRED` is insufficient under
  `PROV-BIND-012`. The SDK therefore returns retryable
  `reconciliation_required` after fresh identity verification and leaves the
  journal intact; it does not claim the backend is unbound or the device is
  unapplied. Safe automatic recovery depends on firmware exposing the exact
  durable attempt/material result or an equivalent action-bound query/replay
  capability through Rust.
- The public provider still returns raw `apiEndpoint` and `deviceToken` bytes.
  The target contract instead requires one opaque, versioned payload protected
  to trusted `PK_D` and bound to the fresh nonce and exact attempt context. That
  firmware/backend/provider migration remains a known compatibility gap and was
  not concealed or expanded into this SDK-only fix.
- JavaScript can explicitly zero SDK-owned arrays, as these tests prove, but it
  cannot attest to browser-engine, Web Bluetooth implementation, or WASM linear
  memory copies outside those owned references.
- No physical Chromium/device/backend acceptance run was performed. Tasks 13
  and 14 remain the owners of physical evidence and final protocol-gap status.
