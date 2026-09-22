# Task 12 Report: Public Web Client Composition And Lifecycle Cleanup

## Status

DONE

- Starting HEAD: `8daaa3536d99f43934415d5f3741ba60632a290f`
  (verified clean).
- Commit subject: `feat(web): compose foreground sdk managers`
- Trailer: `Co-Authored-By: OpenAI Codex <noreply@openai.com>`
- Scope stopped at Task 12. Task 13 was not started.

## Implementation

- `BotaDeviceClient.create()` now composes exactly one shared
  `BrowserWorkflowRuntime`, one `DeviceManager`, and one instance of every
  foreground manager. Read-only construction still needs no durable storage or
  provider.
- Added `storageNamespace`. Default IndexedDB/OPFS storage is created only when
  a namespace is supplied, and a caller-provided adapter is accepted only when
  its `namespace` exactly matches the validated requested namespace.
- Durable manager preconditions remain ahead of provider calls, storage
  mutation, authorized-device enumeration, picker use, connection, and GATT.
- `destroy()` is terminal and idempotent across the complete manager graph. It
  marks every manager terminal synchronously, stops passive subscriptions,
  cancels and joins direct/workflow owners, waits for initiated unabortable
  work, and disconnects once cleanup owns no remaining listener or lease.
- Added local-only `clearPersistedData()`. It shares coordinator exclusion while
  the client is live, sends no BLE command, clears only the configured tenant
  adapter, and waits for destruction before supporting repeatable logout-order
  cleanup.
- Snapshot, OTA, and log entry points re-read Device Information serial for the
  exact active browser device before sensitive work. They disconnect and fail
  with `identity_mismatch` without picker or same-name fallback.
- Moved the public recording phase union into the public model declaration so
  the root declarations do not expose the private storage/journal module.
- Preserved Task 11 behavior: undersized log packets remain non-terminal Rust
  decoder compatibility inputs.

## RED Evidence

Tests were added before production changes.

```text
PATH=/Users/zhangqi/.nvm/versions/node/v22.23.2/bin:$PATH \
  node --test frameworks/web/src/__tests__/client.test.ts \
  frameworks/web/src/__tests__/snapshot.test.ts
Result: expected failure, 15 tests discovered; 10 passed and 5 failed. The
client accepted unmatched custom storage, lacked clearPersistedData(), did not
make destruction immediately terminal across managers, and logs did not
reverify the active serial.

PATH=/Users/zhangqi/.nvm/versions/node/v22.23.2/bin:$PATH \
  npm test --prefix frameworks/web
Result: expected failure, 355 tests discovered; 350 passed and 5 failed for the
same composition and lifecycle gaps.

PATH=/Users/zhangqi/.nvm/versions/node/v22.23.2/bin:$PATH \
  node --test --test-name-pattern='connected update re-verifies' \
  frameworks/web/src/__tests__/otaManager.test.ts
Result: expected failure; OTA reached the device result path and returned
firmware_rejected instead of identity_mismatch.

PATH=/Users/zhangqi/.nvm/versions/node/v22.23.2/bin:$PATH \
  node --test frameworks/web/src/__tests__/client.test.ts
Result: expected post-destroy regression failure, "Missing expected rejection".
The final added blank-namespace regression also failed before namespace
validation was wired.
```

## GREEN Evidence

All Node commands used Node `v22.23.2`.

```text
node --test frameworks/web/src/__tests__/client.test.ts \
  frameworks/web/src/__tests__/snapshot.test.ts \
  frameworks/web/src/__tests__/otaManager.test.ts
Result: PASS, 58 passed, 0 failed, 0 cancelled, 0 skipped.

npm test --prefix frameworks/web
Result: PASS, 356 passed, 0 failed, 0 cancelled, 0 skipped.

npm run type-check --prefix frameworks/web
Result: PASS, TypeScript completed without errors.

npm run build --prefix frameworks/web
Result: PASS, ESM JavaScript, declarations, and WASM asset emitted.

npm pack --dry-run --json  # run from frameworks/web
Result: PASS, @bota.dev/web-sdk@1.2.0-beta.1, 52 files, 353,627 packed
bytes, 1,575,736 unpacked bytes.

git diff --check
Result: PASS, no whitespace errors.
```

The requested root-level `npm pack --prefix frameworks/web --dry-run` command
exited successfully but npm selected the workspace root package. Running the
same dry-run from `frameworks/web` produced and inspected the intended Web SDK
inventory above; no package was published.

## Destroy And Clear Race Coverage

- A gated direct snapshot read proves destruction and post-destroy clearing
  remain pending until the initiated read settles; storage is not cleared and
  disconnect does not start early. The operation then rejects as `cancelled`,
  one tenant clear runs, and the exact device disconnects.
- A gated log START write proves immediate terminal rejection across devices,
  WiFi, recordings, provisioning, controls, logs, and OTA while repeated
  `destroy()` calls share cleanup. The write settles before one exact
  unsubscribe and one disconnect.
- Live `clearPersistedData()` is rejected with `operation_in_progress` while a
  shared owner exists and performs no storage mutation. Repeated
  destroy-then-clear calls remain BLE-free and do not reach another tenant's
  adapter.
- Existing manager/runtime tests continue to cover pending subscription setup,
  provider, storage, GATT, cancellation, listener, and lease cleanup races.

## Declaration And Tarball Evidence

- `dist/index.d.ts` exports only the approved client, seven managers, public
  error types, public models, and provider contracts. `BotaDeviceClientOptions`
  contains `storageNamespace`, optional storage/providers, `coreLoader`, and
  transport; the client declaration contains `clearPersistedData()` and
  `destroy()`.
- The public model declaration owns `RecordingJournalPhase` and no longer
  imports the private storage declaration. The root barrel does not export the
  WASM bridge, workflow runtime, GATT constants, durable journal records, raw
  bridge DTOs, transport implementation, or storage implementation.
- `package.json` exposes only the root `"."` subpath. Compiled implementation
  modules and the required WASM asset are present in `dist`, but are not public
  package subpaths.
- The 52-entry dry-run inventory contains only `dist`, `README.md`, `LICENSE`,
  and `package.json`; it contains no `src`, tests, source maps, environment
  files, private keys, or Bota credential literals.

## Documentation Impact

Changed-symbol searches covered wrapper `internal-docs/`, public `docs/`, the
app-sdk plan/spec tree, and repository `AGENTS.md`, `ARCHITECTURE.md`, and
`README.md` files for `BotaDeviceClientOptions`, `storageNamespace`,
`clearPersistedData`, `RecordingJournalPhase`, `BotaDeviceClient`, and Web SDK
phrases. The affected app-sdk README, Web README, architecture, and agent
guidance now document the single shared graph, namespace matching, terminal
destroy semantics, logout ordering, local-only clearing, and exact-serial
reverification. No public docs page or wrapper internal design required a
Task 12-specific API change; broader rollout status remains outside this task.

## Physical And External Gaps

- No physical Chromium/Web Bluetooth device was exercised. Identity, teardown,
  disconnect, and picker behavior use the real Rust/WASM core with deterministic
  browser transport boundaries.
- Real browser IndexedDB/OPFS tenant deletion, quota behavior, permission
  revocation, page unload timing, and native GATT cancellation remain browser
  acceptance gates.
- No live provisioning, recording-upload, recording-control, or firmware
  provider was called; provider ordering and cancellation are covered with
  deterministic adapters.
- No push, merge, tag, publish, external release action, subagent dispatch, or
  Task 13 work was performed.
