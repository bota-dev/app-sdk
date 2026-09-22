# Task 10 Report: Recoverable Web Firmware Update

## Status

DONE

- Starting HEAD: `2c6256e2be283b9caf42ffecf268de52c4cc5970` (verified clean).
- Commit subject: `feat(web): add recoverable firmware update`
- Trailer: `Co-Authored-By: OpenAI Codex <noreply@openai.com>`
- Scope stopped at Task 10. Task 11 was not started.

## Implementation

- Added `OTAManager` with `updateFirmware`, `resumeFirmwareUpdate`,
  `cancelFirmwareUpdate`, monotonic typed progress, and client composition.
- Added stable firmware image/provider contracts. Only image identity, integrity
  metadata, opaque blob/download identity, and workflow checkpoints are durable;
  provider URLs and headers remain operation-local.
- Streams response bodies directly to OPFS in at most 64 KiB writes. HTTP
  status, optional `Content-Length`, exact final length, Rust-backed SHA-256,
  and CRC32 are checked before Rust can issue a GATT write. Firmware reads are
  one bounded, safe-integer OPFS read per Rust effect.
- Revalidates and reuses compatible verified blobs after reload. Incomplete
  artifacts restart at byte zero with a fresh provider request. Incompatible
  journal/checkpoint identity fails before provider or GATT work.
- Reboot recovery uses `getDevices()` and only the browser device ID captured by
  the verified connection. It never opens the picker or probes a same-name
  device, including after a fresh runtime/manager reload.
- Cancellation joins provider, fetch, reader, storage, GATT, subscription, and
  authorized-device enumeration work before releasing mutation ownership. It
  rereads latest durable state and preserves a compatible verified artifact.
- Successful cleanup deletes the Rust checkpoint, OPFS blob, then firmware
  journal. Integrity failure removes the untrusted blob while retaining stable
  journal identity for fail-closed recovery.
- `firmwareUpdate` now requires authorized-device reconnect in addition to Web
  Bluetooth, durable storage, and fetch.

## Files Changed

- `.superpowers/sdd/2026-09-17-web-sdk-foreground-workflows/task-10-report.md`
- `AGENTS.md`
- `ARCHITECTURE.md`
- `docs/superpowers/specs/2026-09-17-web-sdk-foreground-workflows-design.md`
- `frameworks/web/README.md`
- `frameworks/web/src/otaManager.ts`
- `frameworks/web/src/__tests__/otaManager.test.ts`
- `frameworks/web/src/workflowRuntime.ts`
- `frameworks/web/src/deviceManager.ts`
- `frameworks/web/src/__tests__/deviceManager.test.ts`
- `frameworks/web/src/capabilities.ts`
- `frameworks/web/src/__tests__/transport.test.ts`
- `frameworks/web/src/providers.ts`
- `frameworks/web/src/models.ts`
- `frameworks/web/src/client.ts`
- `frameworks/web/src/index.ts`

## RED Evidence

The OTA test suite was added before production implementation:

```text
PATH=/Users/zhangqi/.nvm/versions/node/v22.23.2/bin:$PATH \
  node --test frameworks/web/src/__tests__/otaManager.test.ts
Result: expected failure, ERR_MODULE_NOT_FOUND for
frameworks/web/src/otaManager.ts.
```

## GREEN Evidence

All Node commands used Node `v22.23.2`.

```text
node --test frameworks/web/src/__tests__/otaManager.test.ts
Result: PASS, 29 passed, 0 failed, 0 cancelled, 0 skipped after the final
provider-error normalization change.

npm test --prefix frameworks/web
Result: PASS, 318 passed, 0 failed, 0 cancelled, 0 skipped.

npm run type-check --prefix frameworks/web
Result: PASS, TypeScript completed without errors.

npm run build --prefix frameworks/web
Result: PASS, ESM JavaScript, declarations, and WASM asset emitted.

git diff --check
Result: PASS, no whitespace errors.
```

## Coverage

Automated tests cover capability-first failure; ephemeral provider secrets;
HTTPS and deterministic loopback policy; status, size, SHA-256, and CRC32
validation; bounded OPFS streaming and reads; verified reuse and incomplete
restart; Rust-owned device rejection and CRC errors; live and reload reboot
reconnect; exact authorized-device selection; success cleanup order; late
provider, durable-save, subscription, and `getDevices()` cancellation races;
late-progress rejection; and incompatible image/checkpoint rejection before
GATT.

## Documentation Impact

Changed-token searches covered `internal-docs/`, public `docs/`, the approved
plan/spec, and repository `AGENTS.md`, `ARCHITECTURE.md`, and `README.md` files.
Tokens included `OTAManager`, `updateFirmware`, `resumeFirmwareUpdate`,
`cancelFirmwareUpdate`, `FirmwareDownloadProvider`, `firmwareUpdate`,
`network_download`, and `firmware_blob_read_chunk`. The Web README,
architecture, agent guidance, and capability design text now describe the
implemented foreground OTA surface and exact reconnect requirement.

## Deferred Evidence And Caveat

- No physical Chromium/Web Bluetooth transfer, device reboot/reconnect, or
  firmware-version readback was performed. No physical-device claim is made.
- No real backend firmware resolver, presigned URL, CDN redirect, or production
  OPFS/IndexedDB browser profile was exercised. Tests use deterministic external
  boundaries and the real Rust/WASM workflow and integrity helper.
- The implementation is foreground/page-owned only. It deliberately adds no
  worker, service-worker, closed-tab, or picker-fallback behavior.
- No push, merge, tag, publish, or Task 11 work was performed.

## Fix Round 1

Reviewed head: `d2b0e26fc19900bae356061d28a2927179c49a88`.

### Finding 1: Orphan And Incompatible Durable State

- Test: `frameworks/web/src/__tests__/otaManager.test.ts` — `an orphan Rust
  checkpoint rejects a new update before provider or GATT`; the incompatible
  state matrix also covers a corrupt verified blob.
- RED: `node --test --test-name-pattern="orphan Rust checkpoint"
  frameworks/web/src/__tests__/otaManager.test.ts` failed because the operation
  reached OTA START and returned `firmware_rejected` instead of
  `resume_rejected`.
- GREEN: the same command passed, 1 passed and 0 failed. `updateFirmware` now
  checks both journal and Rust checkpoint before provider or device mutation;
  resume validates journal/checkpoint/blob compatibility before reconnect or
  OTA GATT.

### Finding 2: Join Generic Host Persistence

- Test: `frameworks/web/src/__tests__/workflowRuntime.test.ts` — `cancellation
  joins initiated workflow-checkpoint persistence before owner release`, with
  gated load, save, and delete subtests. The pre-existing late-provider test now
  verifies the same generic-host ownership rule.
- RED: `node --test --test-name-pattern="workflow-checkpoint persistence"
  frameworks/web/src/__tests__/workflowRuntime.test.ts` failed all three gated
  subtests because cancellation settled before persistence.
- GREEN: `node --test --test-name-pattern="provider that completes late|workflow-checkpoint persistence"
  frameworks/web/src/__tests__/workflowRuntime.test.ts` passed 5 tests and 0
  failed. Every initiated generic host execution is now tracked and joined;
  cancellation effects still drain and late results remain undispatched.

### Finding 3: Fresh-Page Active-Phase Recovery

- Tests: `frameworks/web/src/__tests__/otaManager.test.ts` — `fresh managers
  recover download, transfer, verify, and reconnect through the exact authorized
  device` and `fresh recovery rejects an exact authorized device with the wrong
  serial before OTA GATT`.
- RED: `node --test --test-name-pattern="fresh managers recover|fresh recovery rejects"
  frameworks/web/src/__tests__/otaManager.test.ts` failed download, transfer,
  verify, and identity-mismatch recovery with `device_disconnected`; the existing
  reconnect phase passed.
- GREEN: the same command passed 6 tests and 0 failed. Fresh managers enumerate
  `getDevices()`, select only the persisted browser device ID, run the Rust exact
  connection workflow to re-verify serial, and never open the picker or probe a
  same-name device.

### Finding 4: Terminal Cleanup Crash Recovery

- Tests: `frameworks/web/src/__tests__/otaManager.test.ts` — `reload completes
  cleanup-only state after every terminal cleanup crash boundary`, covering
  checkpoint, blob, and journal deletion; and
  `frameworks/web/src/__tests__/storage.test.ts` — `firmware cleanup-only state
  is durable, verified, and one-way`.
- RED: the OTA command for `terminal cleanup crash boundary` failed all three
  subtests because no cleanup-only state existed:

  ```text
  node --test --test-name-pattern="terminal cleanup crash boundary" frameworks/web/src/__tests__/otaManager.test.ts
  Result: FAIL, 0 passed and 4 failed (parent plus 3 crash-boundary subtests).
  ```

  The storage command failed because IndexedDB discarded the state:

  ```text
  node --test --test-name-pattern="firmware cleanup-only state" frameworks/web/src/__tests__/storage.test.ts
  Result: FAIL, 0 passed and 1 failed.
  ```

- GREEN: both focused commands then passed:

  ```text
  node --test --test-name-pattern="terminal cleanup crash boundary" frameworks/web/src/__tests__/otaManager.test.ts
  Result: PASS, 4 passed and 0 failed (parent plus 3 subtests).

  node --test --test-name-pattern="firmware cleanup-only state" frameworks/web/src/__tests__/storage.test.ts
  Result: PASS, 1 passed and 0 failed.
  ```

  Rust's terminal checkpoint delete is wrapped by a durable one-way
  `cleanup_only` journal save; reload then performs only idempotent checkpoint,
  blob, and journal cleanup without provider, reconnect, or GATT work.

### Files Changed In Fix Round 1

- `.superpowers/sdd/2026-09-17-web-sdk-foreground-workflows/task-10-report.md`
- `AGENTS.md`
- `ARCHITECTURE.md`
- `docs/superpowers/plans/2026-09-17-web-sdk-foreground-workflows.md`
- `docs/superpowers/specs/2026-09-17-web-sdk-foreground-workflows-design.md`
- `frameworks/web/README.md`
- `frameworks/web/src/otaManager.ts`
- `frameworks/web/src/storage.ts`
- `frameworks/web/src/indexedDbWorkflowStore.ts`
- `frameworks/web/src/workflowRuntime.ts`
- `frameworks/web/src/__tests__/otaManager.test.ts`
- `frameworks/web/src/__tests__/storage.test.ts`
- `frameworks/web/src/__tests__/workflowRuntime.test.ts`

### Final Verification

All Node commands used Node `v22.23.2`.

```text
node --test frameworks/web/src/__tests__/otaManager.test.ts
Result: PASS, 41 passed, 0 failed, 0 cancelled, 0 skipped.

npm test --prefix frameworks/web
Result: PASS, 335 passed, 0 failed, 0 cancelled, 0 skipped.

npm run type-check --prefix frameworks/web
Result: PASS, TypeScript completed without errors.

npm run build --prefix frameworks/web
Result: PASS, ESM JavaScript, declarations, and WASM asset emitted.

git diff --check
Result: PASS, no whitespace errors.
```

Changed-token searches covered the worktree plan/spec, Web README,
`ARCHITECTURE.md`, every repository `AGENTS.md`/`ARCHITECTURE.md`/`README.md`,
and wrapper `internal-docs/` and public `docs/`. The optional journal `state`,
`cleanup_only`, exact active-phase reconnect, and generic-host join semantics are
documented in the affected App SDK sources; no external wrapper document quoted
these schema names.

### Deferred Evidence And Caveat

- No physical Chromium/Web Bluetooth transfer, reboot/reconnect, firmware
  version readback, or crash interruption was performed. No physical-device
  claim is made.
- No production firmware provider, presigned URL, CDN redirect, or real browser
  IndexedDB/OPFS profile was exercised. Tests use controlled external boundaries
  with the real Rust/WASM workflow and integrity implementation.
- The cleanup marker remains optional so custom storage extensions and legacy
  active journals retain compatibility; missing `state` is interpreted as
  `active`, while `cleanup_only` cannot transition back.
- No push, merge, tag, publish, or Task 11 work was performed.

## Fix Round 2

Reviewed head: `fa5de5cc5132fa1a1eecb8e71f102faa9b76396e`.

### Provider Gate Before Resume Side Effects

- Test: `frameworks/web/src/__tests__/otaManager.test.ts` — `an incomplete
  provider-free resume fails before device or blob side effects`. It asserts
  `unsupported_capability` with no provider/fetch call, `getDevices`, connect,
  GATT, OPFS open/truncate/write/delete, or firmware-journal mutation.
- RED:

  ```text
  env PATH=/Users/zhangqi/.nvm/versions/node/v22.23.2/bin:$PATH node --test --test-name-pattern="incomplete provider-free resume" frameworks/web/src/__tests__/otaManager.test.ts
  Result: FAIL, 0 passed and 1 failed; OPFS open count changed from 2 to 4 before rejection.
  ```

- GREEN, including provider-free verified-artifact and cleanup-only preservation:

  ```text
  env PATH=/Users/zhangqi/.nvm/versions/node/v22.23.2/bin:$PATH node --test --test-name-pattern="incomplete provider-free resume|provider-free verified blob|cleanup-only state" frameworks/web/src/__tests__/otaManager.test.ts
  Result: PASS, 6 passed and 0 failed (3 top-level tests plus 3 cleanup subtests).
  ```

`resumeFirmwareUpdate` now requires a provider for an unverified active journal
immediately after journal/checkpoint validation and cleanup-only handling, before
artifact or device access. Cleanup-only journals still perform provider-free
cleanup, and compatible verified blobs still resume provider-free.

### Round 2 Verification

```text
node --test frameworks/web/src/__tests__/otaManager.test.ts
Result: PASS, 42 passed, 0 failed, 0 cancelled, 0 skipped.

npm test --prefix frameworks/web
Result: PASS, 336 passed, 0 failed, 0 cancelled, 0 skipped.

npm run type-check --prefix frameworks/web
Result: PASS, TypeScript completed without errors.

npm run build --prefix frameworks/web
Result: PASS, ESM JavaScript, declarations, and WASM asset emitted.

git diff --check
Result: PASS, no whitespace errors.
```

Round 2 changes only resume ordering and tests; no public API, durable schema,
or documented workflow state changed. No physical Web Bluetooth/reboot or
production provider/browser-storage evidence was collected. No push, merge,
tag, publish, or Task 11 work was performed.
