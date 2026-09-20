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
