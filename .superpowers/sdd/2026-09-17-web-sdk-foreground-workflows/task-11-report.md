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

## Fix Round 1

### Status And Ruling

Applied review fixes against reviewed HEAD
`ef9840a939a7b4011e4cc44c07d090b4b7dd014b`. The recorded ruling makes the
canonical Rust codec fixture authoritative over the contradictory Task 11 plan
sentence: empty and undersized device-log packets are non-terminal, produce no
public value, preserve decoder sequence state, and permit later valid packets to
decode normally. Rust semantics and `protocol/fixtures/device-logs.json` were
not changed. Genuine Rust, bridge, and runtime failures remain sanitized.

### Files Changed

- `.superpowers/sdd/2026-09-17-web-sdk-foreground-workflows/task-11-report.md`
- `AGENTS.md`
- `ARCHITECTURE.md`
- `docs/superpowers/plans/2026-09-17-web-sdk-foreground-workflows.md`
- `docs/superpowers/specs/2026-09-17-web-sdk-foreground-workflows-design.md`
- `frameworks/web/README.md`
- `frameworks/web/src/__tests__/logManager.test.ts`
- `frameworks/web/src/logManager.ts`

### RED Evidence

The review regressions were added before production changes.

```text
PATH=/Users/zhangqi/.nvm/versions/node/v22.23.2/bin:$PATH \
  node --test frameworks/web/src/__tests__/logManager.test.ts
Result: expected failure, 11 tests discovered; 5 passed and 6 were cancelled
because the rejected promise-like listener result was not observed and exact
cleanup never started. Exit code 1.

PATH=/Users/zhangqi/.nvm/versions/node/v22.23.2/bin:$PATH \
  node --test --test-name-pattern='explicit and repeated removal' \
  frameworks/web/src/__tests__/logManager.test.ts
Result: expected failure, 1 failed, 0 passed. The retained owner still held the
exact application listener instead of `null` after terminal cleanup. Exit code
1.
```

The new real Rust/WASM malformed-packet test passed during RED. It loads and
delivers the canonical `malformed-packet-keeps-sequence-state` inputs through
the production workflow/runtime, observes no listener value for the malformed
packets, then receives only `{ message, isBacklog }` for `first` and `second`.

### Implementation And Race Coverage

- Replaced the fabricated core-dispatch throw with the canonical fixture driven
  through real Rust/WASM and the production `BrowserWorkflowRuntime`.
- Consumes rejected promise-like listener results using the established Web
  listener pattern. Rejection disables delivery, cancels the exact workflow,
  removes the exact subscription, and does not become an unhandled rejection.
- Makes the owner listener nullable and clears it both when closing begins and
  in the centralized terminal finalizer, including unexpected stream terminal
  paths. A deterministic regression retains the public removal handle and the
  former owner, then proves the owner no longer references the application
  listener.
- Blocks unsubscribe during rejected-listener cleanup and proves the exact
  diagnostics lease remains occupied until cleanup joins. A late notification
  during that window is ignored. Exact cancellation identity, repeated remove,
  and post-cleanup lease reuse remain covered.

### GREEN Evidence

All Node commands used Node `v22.23.2`.

```text
node --test frameworks/web/src/__tests__/logManager.test.ts
Result: PASS, 11 passed, 0 failed, 0 cancelled, 0 skipped.

npm test --prefix frameworks/web
Result: PASS, 347 passed, 0 failed, 0 cancelled, 0 skipped.

npm run type-check --prefix frameworks/web
Result: PASS, TypeScript completed without errors.

npm run build --prefix frameworks/web
Result: PASS, ESM JavaScript, declarations, and WASM asset emitted.

git diff --check
Result: PASS, no whitespace errors.
```

### Documentation Impact

Changed-symbol searches covered wrapper `internal-docs/`, the app-sdk `docs/`
tree, `AGENTS.md`, `ARCHITECTURE.md`, and the Web README for `LogManager`,
`DeviceLogLine`, `DeviceLogSubscription`, `logs.subscribe`,
`read_device_logs`, and `malformed-packet-keeps-sequence-state`. The tracked
Task 11 plan sentence, approved design, Web README, architecture, and agent
guidance now document the ruled non-terminal undersized-packet compatibility
behavior and the distinct sanitization of genuine failures. No wrapper internal
document quoted the changed Web symbols.

### Physical And External Gaps

- No physical Chromium/Web Bluetooth or real diagnostics stream was exercised;
  malformed-packet coverage uses real Rust/WASM with the deterministic browser
  transport boundary.
- Browser event-loop timing and listener rejections from a production host app
  remain physical acceptance gaps, although promise-like rejection, blocked
  teardown, late delivery, and lease ordering are deterministic automated tests.
- Firmware diagnostics-service availability and long-running log volume remain
  device acceptance gates.
- No push, merge, tag, publish, external release action, or Task 12 work was
  performed.
