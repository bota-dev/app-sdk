# Task 9 Report: Web WiFi and Recording Control

## Status

DONE

- Starting HEAD: `d0c7f2bc8c1d49ec79e15bf189374c8ffaa11cc0` (verified clean).
- Commit subject: `feat(web): add wifi and recording control`
- Trailer: `Co-Authored-By: OpenAI Codex <noreply@openai.com>`
- Scope stopped at Task 9. Task 10 was not started.

## Implementation Summary

- Added `WiFiManager` with scan, configure, disconnect, status read, and one
  passive status subscription. Scan subscribes before Rust-encoded START,
  ignores Rust-decoded pending updates, accepts one DONE result, and uses a
  30-second default deadline.
- WiFi configuration validates JavaScript input and delegates NUL/length and
  packet validation to Rust before transport work. It writes the Rust-encoded
  grant with response, subscribes to status, and writes only Rust-encoded
  credentials with response. Disconnect uses the Rust empty-credential packet
  and does not write a grant or password.
- Added exact characteristic leases to the Task 5 runtime. Passive WiFi status
  owns one canonical device/service/characteristic lease and releases it once
  on setup failure, listener failure, disconnect, destroy, or explicit removal.
  A conflicting owner is rejected before a mutating write.
- Added grant-bound `ControlManager` and `RecordingControlProvider`. The
  provider receives the exact operation ID, fresh serial, action, and authority
  ID. Start/stop write the one-operation grant with response, subscribe to the
  result, then write the Rust command with response. Stop preserves both
  released 50 ms pacing points.
- Control and WiFi writes use the same Task 5 mutating owner. Result acceptance
  opens only after the corresponding command write settles, accepts one
  Rust-decoded result, and closes after 30 seconds. Grant expiration maps to
  non-retryable `authorization_expired` without provider retry or authority
  widening.
- Authority and credential buffers remain operation-local, are never logged or
  persisted, and are zero-filled only after initiated provider/GATT work and
  subscription cleanup have joined. Public control remains start/stop only;
  no recording-state read or stream API was added.
- Composed `client.wifi` and `client.controls`, exported the new public models
  and provider, and added the canonical Task 9 GATT characteristics.

## Files Changed

- `.superpowers/sdd/2026-09-17-web-sdk-foreground-workflows/task-9-report.md`
- `frameworks/web/src/wifiManager.ts`
- `frameworks/web/src/controlManager.ts`
- `frameworks/web/src/__tests__/wifiManager.test.ts`
- `frameworks/web/src/__tests__/controlManager.test.ts`
- `frameworks/web/src/workflowRuntime.ts`
- `frameworks/web/src/providers.ts`
- `frameworks/web/src/models.ts`
- `frameworks/web/src/gatt.ts`
- `frameworks/web/src/client.ts`
- `frameworks/web/src/index.ts`

## RED Evidence

The WiFi and control tests were created before either manager:

```text
PATH=/Users/zhangqi/.nvm/versions/node/v22.23.2/bin:$PATH \
  node --test frameworks/web/src/__tests__/wifiManager.test.ts \
  frameworks/web/src/__tests__/controlManager.test.ts
Result: expected failure, ERR_MODULE_NOT_FOUND for wifiManager.ts and
controlManager.ts.
```

Self-review added four focused regressions before their production fixes:

```text
node --test --test-name-pattern='configure validates malformed' \
  frameworks/web/src/__tests__/wifiManager.test.ts
Result: expected failure; malformed runtime credential shapes mapped to
internal_error instead of invalid_input.

node --test --test-name-pattern='passive status delivers' \
  frameworks/web/src/__tests__/wifiManager.test.ts
Result: expected failure; a synchronous setup notification reached the passive
callback before its owner was assigned and surfaced as internal_error.

node --test --test-name-pattern='configure zeroes encoded credentials' \
  frameworks/web/src/__tests__/wifiManager.test.ts
Result: expected failure; credential bytes remained
04426f746106736563726574 after grant encoding failed.

node --test --test-name-pattern='passive status redacts synchronous setup failure' \
  frameworks/web/src/__tests__/wifiManager.test.ts
Result: expected failure; a synchronously throwing custom transport exposed the
raw exception and retained the passive characteristic lease.
```

The fixes validate runtime shapes before codec calls, buffer notifications
delivered during subscription setup, and place both preflight buffers inside
the terminal zero-fill boundary. Synchronous setup failure is now normalized
and releases the lease before returning.

## GREEN Evidence

All commands used Node `v22.23.2` where Node was involved.

Focused WiFi/control tests:

```text
node --test frameworks/web/src/__tests__/wifiManager.test.ts \
  frameworks/web/src/__tests__/controlManager.test.ts
Result: PASS, 33 passed, 0 failed, 0 cancelled, 0 skipped.
```

Full Web gate, including committed Rust/WASM codec parity fixtures:

```text
npm test --prefix frameworks/web
Result: PASS, 284 passed, 0 failed, 0 cancelled, 0 skipped.
```

Type-check and package build:

```text
npm run type-check --prefix frameworks/web
Result: PASS, TypeScript completed without errors.

npm run build --prefix frameworks/web
Result: PASS, ESM JavaScript, declarations, and the WASM asset were emitted.
```

Existing WASM bridge contract:

```text
cargo test -p bota-device-sdk-wasm --test bridge_contract
Result: PASS, 12 passed, 0 failed.
```

No Rust, WASM, or protocol fixture source changed in Task 9. The full Web gate
still exercised WiFi and recording-control codec parity, and the unchanged WASM
bridge contract passed independently.

Diff validation:

```text
git diff --check
Result: PASS, no whitespace errors.
```

## Coverage

The focused tests prove:

- subscribe-before-START scan ordering, pending filtering, DONE-only results,
  30-second default timeout behavior, and one exact cleanup;
- malformed, empty, overlength, and NUL-bearing credentials fail before
  transport work, including zero-fill when later grant preflight fails;
- grant/subscription/credential ordering, response-bearing writes, stale-result
  rejection, Rust-only credential bytes, and no-grant disconnect;
- Rust-decoded status reads and passive notifications, setup-time delivery,
  setup-failure redaction, idempotent removal, and cleanup on listener failure,
  disconnect, and destroy;
- exact provider context, one provider call, grant/subscription/Rust-command
  ordering, both stop delays, and terminal authority expiration;
- grant and command zero-fill after joined terminal work, with no secret-bearing
  provider cause exposed publicly;
- shared WiFi/control mutation exclusion and same-characteristic passive-owner
  rejection; and
- client composition without an extra recording-state public API.

## Self-Review

- Confirmed production TypeScript contains no manual WiFi or recording-control
  packet construction. Commands, credentials, grants, status, scan updates, and
  results all pass through existing Rust/WASM codec interfaces.
- Confirmed grant and credential references do not enter storage, logs, public
  errors, manager fields, or durable workflow state. Cleanup waits for every
  initiated write and subscription removal before zero-fill and owner release.
- Confirmed fresh serial verification precedes every active WiFi/control
  operation and identity mismatch uses the existing fail-closed disconnect.
- Confirmed the passive lease key uses canonical device, service, and
  characteristic identity; release is idempotent and cannot release a newer
  owner.
- Confirmed control expiration is non-retryable, provider exceptions are
  redacted, and no retry, broader authority request, or fallback path exists.
- Confirmed the public control surface has only `startRecording` and
  `stopRecording`; Task 10 OTA/log behavior, release, publication, push, merge,
  and physical-device operations were not added or performed.

## Documentation Impact

Changed-token searches covered `internal-docs/`, public `docs/`, the App SDK
plan/spec, and every discovered repository `AGENTS.md`, `ARCHITECTURE.md`, and
`README.md`. Tokens included `WiFiManager`, `ControlManager`,
`RecordingControlProvider`, `claimCharacteristicLease`,
`authorization_expired`, `subscribeToStatus`, `startRecording`,
`stopRecording`, and all six affected characteristic UUIDs.

The authoritative WiFi and recording-control documents already define these
released GATT characteristics, grant ordering, Rust-owned packet formats, and
exact-action target constraints. Task 9 implements the approved Web surface
without changing that cross-system design. Task 14 retains ownership of the
public capability/status and physical-evidence updates. This report is the
required immediate implementation documentation for Task 9.

## Concerns

- No physical Chromium/Web Bluetooth, device, or backend-authority run was
  performed. Automated tests prove host ordering, cleanup, redaction, and
  shared-codec parity; Tasks 13 and 14 own browser/device acceptance evidence.
- Released WiFi/control result frames do not carry an operation identity. The
  SDK therefore provides the strongest correlation available in the current
  protocol: subscribe first, ignore results until the response-bearing command
  write settles, accept exactly one Rust-decoded result, and enforce a bounded
  30-second window. This is freshness fencing, not command-bound correlation.
