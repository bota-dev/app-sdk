# Task 7 Report: Browser Encrypted Upload v2

## Status

DONE

- Starting HEAD: `09f889b647a87629f02c4802148e8e9a3ddd1f37`
- Commit subject: `feat(web): add encrypted upload v2 sync`
- Trailer: `Co-Authored-By: OpenAI Codex <noreply@openai.com>`
- Scope stopped at Task 7. Task 8 was not started.

## Implementation Summary

- Added a Rust/WASM decoder for signed-document RESULT frames so browser code
  never decodes that wire format itself.
- Added the four planned browser owners:
  `EncryptedUploadV2SignedBlobWriter`, `EncryptedUploadV2TransferControl`,
  `EncryptedUploadV2TransferReceiver`, and `EncryptedUploadV2Host`.
- Implemented fresh `0406` capability reads, capability-byte SHA-256 provider
  binding, and v2 LIST with both `040B` catalog and `0409` error subscriptions
  established before the Rust-encoded `0408` request.
- Intersected device bounds with the Web transport's 128-byte ceiling. The
  resulting canonical test bounds are 15 window packets and 100 data bytes.
- Kept every outbound signed-document and transfer frame under Rust codec
  authority, including LIST, BEGIN/DATA/COMMIT/ABORT, START/RESUME, WINDOW_ACK,
  CONFIRM, and transfer ABORT.
- Implemented exact transfer identity checks, bounded queued metadata, exact
  offset ciphertext staging, identical-only duplicate acceptance, repair,
  durable checkpoint-before-ACK ordering, resume truncation/prefix checking,
  fixed 580-byte manifest assembly, and exact EOF evidence verification.
- Implemented the ciphertext upload, exact manifest submission, finalization,
  receipt acceptance, signed receipt delivery, and receipt-bound CONFIRM
  sequence.
- Added explicit `profile: 'encrypted_upload_v2'` sync and recovery through the
  existing recording journal phases. Receipt digests and cloud evidence are
  durable before CONFIRM; raw receipts, authorizations, URLs, headers, and
  provider callbacks are never persisted.
- Added zero-fill and late-completion quarantine where JavaScript permits.
  Cancellation never retries legacy. Uncertain abort or unsubscribe cleanup
  poisons shared BLE ownership until a confirmed disconnect.
- Added exact `cloud_completed` recovery: provider material is reacquired for
  the same IDs and owner revision, and a changed receipt digest is rejected.
- `models.ts` did not require another edit because Tasks 1-6 had already added
  the v2 recording metadata consumed by this task.

## Files Changed

- `.superpowers/sdd/2026-09-17-web-sdk-foreground-workflows/task-7-report.md`
- `bindings/device-sdk-wasm/src/codecs.rs`
- `bindings/device-sdk-wasm/tests/bridge_contract.rs`
- `frameworks/web/src/core.ts`
- `frameworks/web/src/encryptedUploadV2Host.ts`
- `frameworks/web/src/gatt.ts`
- `frameworks/web/src/providers.ts`
- `frameworks/web/src/recordingManager.ts`
- `frameworks/web/src/wasmCore.ts`
- `frameworks/web/src/workflowRuntime.ts`
- `frameworks/web/src/__tests__/core.test.ts`
- `frameworks/web/src/__tests__/encryptedUploadV2Host.test.ts`
- `frameworks/web/src/__tests__/encryptedUploadV2Recording.test.ts`
- `frameworks/web/src/__tests__/fakeBluetooth.ts`
- `frameworks/web/src/__tests__/fakeProviders.ts`
- `frameworks/web/src/__tests__/recordingManager.test.ts`

## RED Evidence

Initial browser host tests were written before production implementation:

```text
PATH=/Users/zhangqi/.nvm/versions/node/v22.23.2/bin:$PATH node --test \
  src/__tests__/encryptedUploadV2Host.test.ts \
  src/__tests__/encryptedUploadV2Recording.test.ts
Result: expected failure. The host module and v2 GATT exports did not exist;
explicit v2 sync still rejected as unsupported.
```

The signed RESULT bridge test preceded its Rust decoder:

```text
cargo test -p bota-device-sdk-wasm --test bridge_contract \
  encrypted_upload_signed_blob_result_uses_the_shared_decoder
Result: expected compile failure. The decoder export was unresolved.
```

Focused implementation regressions were observed before each fix:

```text
PATH=/Users/zhangqi/.nvm/versions/node/v22.23.2/bin:$PATH node --test \
  src/__tests__/encryptedUploadV2Host.test.ts \
  src/__tests__/encryptedUploadV2Recording.test.ts
Result: expected failures included LIST timeout, explicit v2 unsupported,
signed-writer cancellation not settling, an orphan provider journal, late
provider/receipt mutation, persisted unknown receipt material, EOF recovery
not entering manifest, late staging advancement, and redundant ABORT after an
exact signed RESULT or START ERROR.
```

The final ownership review added six more tests in RED first:

```text
node --test --test-name-pattern='failed signed BEGIN' \
  src/__tests__/encryptedUploadV2Host.test.ts
Result: expected failure; an uncertain BEGIN write did not send Rust ABORT.

node --test --test-name-pattern='0409 rejection' \
  src/__tests__/encryptedUploadV2Host.test.ts
Result: expected watchdog failure; LIST did not monitor exact `0409` ERROR.

node --test --test-name-pattern='START subscription' \
  src/__tests__/encryptedUploadV2Host.test.ts
Result: expected failure; pre-START cancellation emitted an unnecessary ABORT.

node --test --test-name-pattern='discards ciphertext' \
  src/__tests__/encryptedUploadV2Host.test.ts
Result: expected failure; an aborted queue yielded a buffered DATA frame.

node --test --test-name-pattern='uncertain v2 LIST cleanup' \
  src/__tests__/encryptedUploadV2Recording.test.ts
Result: expected failure; the manager had not wired LIST cleanup poisoning.

node --test --test-name-pattern='OPFS quota' \
  src/__tests__/encryptedUploadV2Host.test.ts
Result: expected failure; quota identity was collapsed to protocol_error.
```

## GREEN Evidence

Canonical vector gate:

```text
PATH=/Users/zhangqi/.nvm/versions/node/v22.23.2/bin:$PATH \
  npm run encrypted-upload-v2:vectors:check
Result: PASS, encrypted upload v2 vectors are current.
```

Required Rust command:

```text
cargo test -p bota-device-sdk-core encrypted_upload_v2
Result: PASS, but Cargo selected 0 tests because the test function names do not
contain the file-name prefix; all relevant binaries were filtered out.
```

The actual Rust v2 test binaries were therefore run directly:

```text
cargo test -p bota-device-sdk-core \
  --test encrypted_upload_v2_codec \
  --test encrypted_upload_v2_coordinator \
  --test encrypted_upload_v2_selection \
  --test encrypted_upload_v2_workflow
Result: PASS, 33 passed, 0 failed.
```

WASM bridge gate:

```text
cargo test -p bota-device-sdk-wasm --test bridge_contract
Result: PASS, 11 passed, 0 failed.
```

Focused browser v2 gate:

```text
PATH=/Users/zhangqi/.nvm/versions/node/v22.23.2/bin:$PATH node --test \
  src/__tests__/encryptedUploadV2Host.test.ts \
  src/__tests__/encryptedUploadV2Recording.test.ts
Result: PASS, 30 passed, 0 failed, 0 cancelled, 0 skipped.
```

Full Web gate:

```text
PATH=/Users/zhangqi/.nvm/versions/node/v22.23.2/bin:$PATH \
  npm test --prefix frameworks/web
Result: PASS, 207 passed, 0 failed, 0 cancelled, 0 skipped.
```

Type-check and build:

```text
PATH=/Users/zhangqi/.nvm/versions/node/v22.23.2/bin:$PATH \
  npm run type-check --prefix frameworks/web
Result: PASS, TypeScript completed without errors.

PATH=/Users/zhangqi/.nvm/versions/node/v22.23.2/bin:$PATH \
  npm run build --prefix frameworks/web
Result: PASS, JavaScript, declarations, and the WASM asset were emitted.
```

Diff validation:

```text
git diff --check
Result: PASS, no whitespace errors.
```

## Coverage

The focused tests prove:

- fresh capability reads for LIST and every attempted v2 start, with exact raw
  capability bytes and SHA-256 in provider context;
- dual LIST subscriptions before write, exact session/count/revision/digest,
  v2 metadata exposure, typed missing-characteristic fallback only, and no
  fallback on transport failure;
- Rust framing and exact kind/write/session/recording/generation/digest checks;
- correct pre-write cancellation, uncertain-write ABORT, exact device terminal
  rejection, queued-frame discard, and poison-until-disconnect behavior;
- bounded offset staging, identical duplicates, overlap/conflict rejection,
  gap repair, OPFS durability before checkpoint and ACK, and preserved quota
  identity;
- resume truncation and prefix verification, fixed manifest assembly, and EOF
  ciphertext length/hash verification;
- exact upload/manifest/finalize/receipt/CONFIRM order with durable journal,
  cloud, and receipt-digest evidence before device deletion;
- no durable raw receipt or provider template, plus authorization/receipt
  zero-fill and late provider/network completion quarantine;
- cancellation before/after provider, START, staging, receipt, and CONFIRM;
- exact `cloud_completed` material reacquisition and receipt mismatch refusal;
  and
- no v2 failure or cancellation invokes legacy transfer.

## Self-Review

- Confirmed the Rust workflow remains the only long-running protocol reducer.
  TypeScript owns browser I/O, bounded staging, and effect execution only.
- Confirmed production code constructs no Bota wire frame manually. Every
  outbound frame is returned by a Rust/WASM codec.
- Confirmed `0407`, `0408`, `0409`, and `040B` subscriptions are established
  before their corresponding writes and retain one exact owner.
- Confirmed a clean WINDOW_ACK requires both completed OPFS writes and the
  matching durable IndexedDB checkpoint revision.
- Confirmed persisted state is parsed into an explicit allow-list and binds
  serial, recording/generation, upload session, owner, transport session,
  negotiated bounds, sink, checkpoint, and evidence.
- Confirmed device confirmation cannot precede accepted receipt persistence,
  and cancellation cannot reverse an attempted/successful CONFIRM.
- Confirmed unknown cleanup ownership blocks all non-disconnect operations and
  is cleared only by `markDeviceDisconnected`.
- Confirmed legacy sync behavior and tests remain intact, and no Task 8 files,
  provisioning behavior, publication, push, or merge were added.

## Documentation Impact

Changed-token searches covered `internal-docs/`, public `docs/`, and every
repository `AGENTS.md`, `ARCHITECTURE.md`, and `README.md` under the wrapper.
Tokens included the four new v2 owner names,
`decodeEncryptedUploadV2SignedBlobResult`, `prepareEncryptedUploadV2`, the v2
GATT constant names, and `0406` through `040B`.

Relevant hits already describe the approved v2 contract, native canonical
owners, and this Web plan. This implementation does not change the cross-system
protocol or public support status. Task 14 owns public capability and
compatibility documentation. This report is the immediate Task 7
implementation evidence required by the repository instructions.

## Concerns

- The required `cargo test -p bota-device-sdk-core encrypted_upload_v2`
  command is a green but empty name-filter gate. The direct four-binary command
  above is the meaningful 33-test Rust evidence.
- Physical Chromium/Web Bluetooth, real OPFS durability, device firmware, and
  backend staging/receipt behavior are not exercised in this task; the
  approved plan assigns those qualification claims to later tasks.
- No Task 8 work was started.

## Fix Round 1

### Status

DONE

- Starting HEAD: `363e1d644358bbf8775d5e87c2dfc8d48500b5fc`
- Commit subject: `fix(web): harden encrypted upload v2 ownership`
- Trailer: `Co-Authored-By: OpenAI Codex <noreply@openai.com>`
- Scope remained inside Task 7. Task 8 was not started.

### Implementation Summary

- Serialized signed-document and transfer-control GATT writes. Cancellation now
  waits for an initiated BEGIN/CHUNK/COMMIT or START/RESUME before queuing Rust
  ABORT and subscription cleanup. An owner remains active until that cleanup
  settles; a bounded cleanup failure poisons shared BLE ownership until an
  explicit disconnect.
- Delayed authorization and receipt zero-fill until signed-document terminal
  cleanup has joined. Added runtime-level proof that a blocked BEGIN retains
  both the owner and authorization bytes, plus unit proof for blocked COMMIT
  receipt bytes and poison-on-unjoined-write behavior.
- Opened signed RESULT correlation only when COMMIT is actually initiated,
  retained the legitimate synchronous notification race, used one randomized
  process-wide monotonic write-ID sequence across host instances, and added a
  bounded post-COMMIT RESULT timeout with exact teardown.
- Added atomic IndexedDB creation and deletion of the v2 operation metadata and
  recording journal. Rust `RemoveCheckpoint` now persists the same operation
  with a null transfer checkpoint instead of deleting its identity/material
  binding before the replacement save.
- Made prepared/transferring v2 cancellation explicit for active, resumed, and
  inactive operations. Cleanup first persists a restartable null checkpoint,
  then deletes the ciphertext and workflow checkpoint, then atomically deletes
  the v2 metadata/journal pair.
- Exposed a pure Rust/WASM profile probe that reuses
  `validate_upload_profile_selection`. LIST enters v2 only when the Rust batch
  predicate accepts the exact capability contract, and explicit v2 sync runs
  Rust capability/storage-format validation before provider, journal, OPFS, or
  v2 metadata side effects.
- Preserved the reviewed transfer bounds, exact receiver behavior,
  checkpoint-before-ACK order, manifest/EOF verification, ciphertext upload,
  receipt binding/redaction, legacy behavior, and Rust ownership of every
  outbound protocol frame.

### Files Changed

- `.superpowers/sdd/2026-09-17-web-sdk-foreground-workflows/task-7-report.md`
- `core/device-sdk-core/src/model/upload_profile.rs`
- `bindings/device-sdk-wasm/src/lib.rs`
- `bindings/device-sdk-wasm/src/workflows.rs`
- `bindings/device-sdk-wasm/tests/bridge_contract.rs`
- `frameworks/web/src/core.ts`
- `frameworks/web/src/wasmCore.ts`
- `frameworks/web/src/storage.ts`
- `frameworks/web/src/indexedDbWorkflowStore.ts`
- `frameworks/web/src/recordingManager.ts`
- `frameworks/web/src/encryptedUploadV2Host.ts`
- `frameworks/web/src/__tests__/core.test.ts`
- `frameworks/web/src/__tests__/deviceManager.test.ts`
- `frameworks/web/src/__tests__/fakeProviders.ts`
- `frameworks/web/src/__tests__/storage.test.ts`
- `frameworks/web/src/__tests__/encryptedUploadV2Host.test.ts`
- `frameworks/web/src/__tests__/encryptedUploadV2Recording.test.ts`

### RED Evidence

Blocked writes, signed RESULT correlation, timeout, and poison tests were added
before the host changes:

```text
PATH=/Users/zhangqi/.nvm/versions/node/v22.23.2/bin:$PATH node --test \
  src/__tests__/encryptedUploadV2Host.test.ts
Result: expected RED, 18 passed and 6 failed. Cancellation settled while a
blocked signed BEGIN was live; a pre-COMMIT RESULT pre-satisfied the write;
there was no terminal RESULT timeout; blocked START/RESUME allowed concurrent
ABORT; and an unjoined transfer write did not poison ownership.
```

The Rust authority probe test preceded its implementation:

```text
cargo test -p bota-device-sdk-wasm --test bridge_contract \
  encrypted_upload_profile_probe_is_side_effect_free_and_authoritative
Result: expected compile failure. `supports_encrypted_upload_v2_batch` was
private and `validate_encrypted_upload_v2_profile` did not exist.
```

Profile side-effect and runtime ownership tests were written before the Web
manager changes:

```text
PATH=/Users/zhangqi/.nvm/versions/node/v22.23.2/bin:$PATH node --test \
  --test-name-pattern='Rust profile validation|runtime cancellation joins' \
  src/__tests__/encryptedUploadV2Recording.test.ts
Result: expected RED, 3 failed. Invalid flags and storage format reached the
provider, and runtime cancellation released before the blocked BEGIN joined.
```

Durable pair and crash-boundary tests also failed before implementation:

```text
PATH=/Users/zhangqi/.nvm/versions/node/v22.23.2/bin:$PATH node --test \
  --test-name-pattern='encrypted upload v2 operation metadata' \
  src/__tests__/storage.test.ts
Result: expected RED. `saveEncryptedUploadV2Operation` did not exist.

PATH=/Users/zhangqi/.nvm/versions/node/v22.23.2/bin:$PATH node --test \
  --test-name-pattern='resume cancellation|inactive v2 cancellation|ResumeRejected' \
  src/__tests__/encryptedUploadV2Recording.test.ts
Result: expected RED. Resume cancellation retained v2 state, inactive cancel
retained the journal, and ResumeRejected removed operation metadata before the
replacement checkpoint was durable.
```

### GREEN Evidence

Canonical vectors:

```text
PATH=/Users/zhangqi/.nvm/versions/node/v22.23.2/bin:$PATH \
  npm run encrypted-upload-v2:vectors:check
Result: PASS, encrypted upload v2 vectors are current.
```

Required Rust filter command:

```text
cargo test -p bota-device-sdk-core encrypted_upload_v2
Result: PASS. Cargo selected 0 tests because the filter does not match the
individual test names; the relevant binaries were filtered out.
```

Meaningful Rust v2 binaries:

```text
cargo test -p bota-device-sdk-core \
  --test encrypted_upload_v2_codec \
  --test encrypted_upload_v2_coordinator \
  --test encrypted_upload_v2_selection \
  --test encrypted_upload_v2_workflow
Result: PASS, 33 passed, 0 failed.
```

WASM bridge:

```text
cargo test -p bota-device-sdk-wasm --test bridge_contract
Result: PASS, 12 passed, 0 failed.
```

Focused v2 Web and durable-storage tests:

```text
PATH=/Users/zhangqi/.nvm/versions/node/v22.23.2/bin:$PATH node --test \
  src/__tests__/encryptedUploadV2Host.test.ts \
  src/__tests__/encryptedUploadV2Recording.test.ts \
  src/__tests__/storage.test.ts
Result: PASS, 108 passed, 0 failed, 0 cancelled, 0 skipped.
```

Full Web suite:

```text
PATH=/Users/zhangqi/.nvm/versions/node/v22.23.2/bin:$PATH \
  npm test --prefix frameworks/web
Result: PASS, 226 passed, 0 failed, 0 cancelled, 0 skipped.
```

Type-check and build:

```text
PATH=/Users/zhangqi/.nvm/versions/node/v22.23.2/bin:$PATH \
  npm run type-check --prefix frameworks/web
Result: PASS, TypeScript completed without errors.

PATH=/Users/zhangqi/.nvm/versions/node/v22.23.2/bin:$PATH \
  npm run build --prefix frameworks/web
Result: PASS, WASM, JavaScript, declarations, and the packaged WASM asset
completed successfully.
```

Diff validation:

```text
git diff --check
Result: PASS, no whitespace errors.
```

### Self-Review

- Confirmed BEGIN/CHUNK/COMMIT and START/RESUME/ABORT writes share serialized
  queues within their characteristic owners. ABORT cannot overtake the write it
  terminates, and the active session cannot be replaced during late cleanup.
- Confirmed a cleanup timeout invokes the runtime poison callback before the
  runtime can admit another non-disconnect owner. The writer/session continues
  to hold its local owner until the original promise and cleanup settle.
- Confirmed stale signed RESULT notifications are ignored before the COMMIT
  correlation window, a synchronous RESULT from the COMMIT write is accepted,
  foreign results cannot satisfy the owner, and timeout always tears down.
- Confirmed authorization and receipt arrays remain nonzero while their GATT
  write is blocked and are zero-filled only by joined terminal cleanup.
- Confirmed the Rust profile probe is pure and runs before provider acquisition
  or any journal, v2 metadata, or OPFS mutation. TypeScript only interprets the
  Rust result and intersects already-validated bounds with the transport limit.
- Confirmed v2 operation/journal creation and deletion use one IndexedDB
  transaction. Checkpoint removal preserves operation identity, and every
  cancellation/crash boundary leaves either a restartable pair or no pair.
- Confirmed all outbound Bota frames still come from Rust codecs and no
  TypeScript protocol reducer or legacy fallback was introduced.
- Confirmed no Task 8 files or behavior were started.

### Documentation Impact

Changed-token searches covered `internal-docs/`, public `docs/`, the approved
Web plan/spec, and repository `AGENTS.md`, `ARCHITECTURE.md`, and `README.md`
files. Tokens included `saveEncryptedUploadV2Operation`,
`supportsEncryptedUploadV2Batch`, `validateEncryptedUploadV2Profile`,
`EncryptedUploadV2SignedBlobWriter`, `ResumeRejected`, and Encrypted Upload v2.

This round hardens the already approved Task 7 behavior and does not change the
wire protocol or public support matrix. The implementation report is therefore
the only documentation changed; Task 14 remains the owner of public Web SDK
capability and release documentation.

### Concerns

- The required core command remains a green but empty name-filter gate. The
  explicit four-binary command above is the meaningful 33-test core evidence.
- `BrowserSdkStorage` now requires atomic v2 operation create/delete methods.
  The default IndexedDB implementation and test providers implement them;
  caller-supplied beta storage implementations must add the same semantics.
- Real Chromium/Web Bluetooth scheduling, physical disconnect settlement,
  OPFS crash durability, firmware, and backend receipt behavior still require
  the later supervised integration and hardware gates.
- No push, merge, publish, or Task 8 work was performed.
