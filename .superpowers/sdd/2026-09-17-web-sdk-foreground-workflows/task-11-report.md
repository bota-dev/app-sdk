# Task 11 Report: Sanitized Single-Owner Web Device Logs

## Status

DONE

- Starting HEAD: `0cdfa870524fe65518d1cc5e387161fc2c184a9e` (verified clean).
- Commit subject: `feat(web): add device log subscription`
- Trailer: `Co-Authored-By: OpenAI Codex <noreply@openai.com>`
- Scope stopped at Task 11. Task 12 was not started.

## Implementation

- Added public `LogManager`, `DeviceLogLine`, and `DeviceLogSubscription`
  surfaces and composed `BotaDeviceClient.logs` into client destruction.
- Starts the existing Rust `ReadDeviceLogs` workflow with a random exact
  cancellation identity. TypeScript does not parse device-log packets and maps
  only typed Rust `device_log` notifications to `{ message, isBacklog }`.
- Holds one shared-runtime workflow owner and one exact diagnostics data
  characteristic lease. A second local or sibling manager fails with
  `operation_in_progress` before a second Rust workflow or subscription starts.
- Added a generation-scoped runtime `onRunning` observer so `subscribe()`
  resolves only after Rust's subscribe-before-START effects finish and the
  workflow remains running.
- Sanitizes core/decoder failures behind stable `BotaSDKError` values without
  retaining raw bytes, decoder names, or private causes. Unexpected workflow
  completion is retained as a retryable `connection_failed` stream error.
- Listener exceptions close callbacks immediately and cancel the exact Rust
  workflow. Explicit removal, repeated removal, disconnect, destroy, and late
  notification paths are idempotent and release the lease only after runtime
  cleanup settles.

## Files Changed

- `.superpowers/sdd/2026-09-17-web-sdk-foreground-workflows/task-11-report.md`
- `AGENTS.md`
- `ARCHITECTURE.md`
- `docs/superpowers/specs/2026-09-17-web-sdk-foreground-workflows-design.md`
- `frameworks/web/README.md`
- `frameworks/web/src/__tests__/logManager.test.ts`
- `frameworks/web/src/client.ts`
- `frameworks/web/src/gatt.ts`
- `frameworks/web/src/index.ts`
- `frameworks/web/src/logManager.ts`
- `frameworks/web/src/models.ts`
- `frameworks/web/src/workflowRuntime.ts`

## RED Evidence

The log ownership and sanitization tests were added before production code.

```text
PATH=/Users/zhangqi/.nvm/versions/node/v22.23.2/bin:$PATH \
  npm test --prefix frameworks/web
Result: expected failure, 336 passed and 1 failed because logManager.ts was
missing.

PATH=/Users/zhangqi/.nvm/versions/node/v22.23.2/bin:$PATH \
  node --test frameworks/web/src/__tests__/logManager.test.ts
Result: expected failure, ERR_MODULE_NOT_FOUND for
frameworks/web/src/logManager.ts.
```

## GREEN Evidence

All Node commands used Node `v22.23.2`.

```text
node --test frameworks/web/src/__tests__/logManager.test.ts
Result: PASS, 10 passed, 0 failed, 0 cancelled, 0 skipped.

npm test --prefix frameworks/web
Result: PASS, 346 passed, 0 failed, 0 cancelled, 0 skipped.

npm run type-check --prefix frameworks/web
Result: PASS, TypeScript completed without errors.

npm run build --prefix frameworks/web
Result: PASS, ESM JavaScript, declarations, and WASM asset emitted.

git diff --check
Result: PASS, no whitespace errors.
```

## Ownership, Sanitization, And Teardown Coverage

Automated tests cover Rust subscribe-before-START ordering; one workflow and
characteristic owner; multi-line backlog decoding from Rust notifications;
public shape filtering; secret-bearing malformed decode failure; retryable
unexpected stream completion; exact cancellation identity after listener
failure; concurrent repeated removal; late notifications after removal;
disconnect cleanup without a STOP write; client destruction; and lease reuse.

Race tests gate both asynchronous subscription setup and the initiated START
write. Destruction remains pending with the lease occupied until the eventual
subscription handle is removed or the unabortable write settles. Only then can
the workflow owner and characteristic lease be released.

## Documentation Impact

Changed-token searches covered `internal-docs/`, public `docs/`, the approved
Web plan/spec, and every repository `AGENTS.md`, `ARCHITECTURE.md`, and
`README.md`. Tokens included `LogManager`, `DeviceLogLine`,
`DeviceLogSubscription`, `logs.subscribe`, `read_device_logs`, and the two
device-log characteristic names. The affected Web README, app-sdk architecture,
agent guidance, and approved design now describe the public API, Rust-only
decoding boundary, single ownership, readiness, and teardown behavior. No
wrapper `internal-docs/` or public API-doc page quoted the changed Web symbols.

## Physical And External Gaps

- No physical Chromium/Web Bluetooth or device diagnostics stream was tested.
  The tests use the real Rust/WASM workflow with deterministic browser transport
  boundaries; no physical-device claim is made.
- The diagnostics service may be absent from non-debug firmware. Actual product
  firmware availability and START/STOP behavior remain a physical acceptance
  gate and surface through the existing stable capability/connection errors.
- Browser disconnect timing, notification delivery after native GATT teardown,
  and long-running log volume were not exercised against a production browser
  profile.
- Device-log content can itself contain sensitive device information. The SDK
  exposes only complete decoded lines and never raw packets, but application
  storage, display, and redaction policy remain host responsibilities.
- No push, merge, tag, publish, or Task 12 work was performed.
