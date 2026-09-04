# Encrypted Upload v2 SDK Runtime Implementation Plan

> **For agentic workers:** Execute this plan task-by-task with test-first
> checkpoints. Do not mark the compatibility surface as runtime-supported until
> every native, recovery, and application-provider gate below passes.

**Goal:** Implement capability-gated batch Encrypted Upload v2 in both the
target `app-sdk` and maintenance `react-native-sdk` while preserving byte-exact
v1/P10 behavior and preventing every implicit or post-failure downgrade.

**Architecture:** The application owns the backend profile decision and backend
API calls. The Rust core owns validation, workflow sequencing, checkpoint
semantics, mixed-profile rejection, and stable terminal errors. Apple and
Android own BLE packet bytes, opaque native files, staging requests, durable
checkpoint storage, and cancellation. The target React Native Codegen boundary
carries only profile, identifiers, progress, hashes, opaque registration IDs,
and typed errors; it never carries ciphertext, authorization, manifest,
receipt, staging URL/header, or native-file bytes. The maintenance React Native
SDK retains its TypeScript transport architecture but treats every v2
cryptographic artifact as opaque.

**Tech Stack:** Rust 1.98 / edition 2024, the frozen C ABI v1, Swift 6,
Kotlin 2.1.20, TypeScript 6, React Native Codegen, XCTest, JUnit, and Jest 30.

**Specs:**

- `docs/superpowers/specs/2026-09-03-encrypted-upload-v2-protocol-contract-design.md`
- `../internal-docs/device/Encrypted-Upload-v2.md`
- `../internal-docs/device/Upload-Management.md`

## Success Criteria

- An application-owned provider receives the exact recording identity, fresh
  24-byte capability value/digest, and resumable-checkpoint summary before it
  returns one discriminated profile decision.
- `encrypted_upload_v2` requires an explicit decision, full recording
  UUID/generation, committed `bota_enc_v2` storage, every batch capability bit,
  and usable device-advertised bounds.
- `v2_required` rejects v1 and P10 before any START or recording byte. A v2
  failure closes that session and never starts a legacy workflow.
- P10 remains historical-only and is selected only after the existing valid
  `E2E_START` is observed; `BACKEND_PUBKEY`, recording flags, model, and
  firmware version are never selection inputs.
- Ciphertext is appended directly to an opaque native sink, uploaded unchanged
  to the authorized staging destination, and verified against START_ACK/EOF
  length and SHA-256 evidence without parsing the storage object.
- The exact 580-byte manifest is reassembled and staged/submitted as opaque
  bytes. Device deletion occurs only after the exact 336-byte backend receipt
  is delivered, accepted, and bound by v2 CONFIRM.
- Resume discards every unproved tail byte and restarts only from the newest
  mutually acknowledged `(revision, offset, prefix SHA-256)` checkpoint.
- Cancellation, expiry, disconnect, malformed framing, mixed profile, staging
  failure, manifest failure, and receipt failure all retain the device copy.
- Existing v1/P10 fixtures and public behavior remain unchanged in both SDKs.
- Firmware capability advertising, policy cohorts, and production deployment
  remain out of scope for this SDK milestone.

## Global Constraints

- Do not call the Bota control-plane API from either SDK. Providers are owned by
  the consuming application.
- Do not decrypt, transcode, or inspect v2 ciphertext, HPKE envelopes,
  manifests, or receipts.
- Do not reuse `TransferRecording` or its v1 characteristics for v2. Use the
  separately allocated `0406..040B` surface and reject mixed messages.
- Keep `protocol/compatibility/firmware-compatibility.json` at
  `status: contract_only`, `runtimeWorkflow: false`, and
  `firmwareAdvertised: false` until Tasks 1-8 are complete.
- ABI v1 changes are additive only. Existing packet kinds, field IDs, symbols,
  and ownership rules cannot change meaning.
- Durable checkpoints contain identifiers, digests, revisions, offsets,
  counters, and negotiated bounds only. They contain no URL, header,
  authorization, receipt, manifest, ciphertext, or file path.
- Every App SDK commit includes
  `Co-Authored-By: OpenAI Codex <noreply@openai.com>`.
- Every code commit includes the corresponding repository documentation update.

## Provider Boundary

The legacy one-argument `UploadInfoProvider(recording)` stays source-compatible
and always enters released legacy behavior. The additive provider receives:

```text
recording UUID + immutable generation
fresh capability bytes + SHA-256 (or explicit absence)
available mutually acknowledged checkpoint summary
```

It returns exactly one of:

```text
legacy_plain_v1  -> existing presigned upload material
legacy_p10_relay -> existing relay material, usable only after valid P10 header
encrypted_upload_v2 -> upload-session/owner IDs + opaque native material ID
```

For native Apple/Android consumers, the material ID indexes an in-memory
application callback that supplies authorization, staging requests, manifest
submission, finalization, and receipt. For the target React Native facade, the
same ID must already be registered by an application-owned native adapter; the
Codegen API never transports those artifacts. The maintenance React Native SDK
may retain them in its TypeScript-owned operation state because that is its
existing transport architecture, but they remain opaque and are excluded from
logs and persistent queue serialization.

---

### Task 1: Freeze profile decisions and capability gating in both SDKs

**Files:**

- Create: `core/device-sdk-core/src/model/upload_profile.rs`
- Modify: `core/device-sdk-core/src/model/mod.rs`
- Create: `core/device-sdk-core/tests/encrypted_upload_v2_selection.rs`
- Create: `react-native-sdk/src/protocol/encryptedUploadV2Selection.ts`
- Create: `react-native-sdk/__tests__/encryptedUploadV2Selection.test.ts`
- Modify: both SDK architecture/status documents

- [x] Write table-driven tests for all policy/profile combinations, absent and
  malformed capabilities, missing required bits, unusable bounds, missing full
  recording generation, unobserved P10, and valid v2.
- [x] Add stable `encrypted_upload_v2_unsupported` and
  `encrypted_upload_v2_required` failures.
- [x] Implement the smallest pure validator in Rust and TypeScript. It has no
  BLE, file, network, delete, or fallback effect.
- [x] Prove the validators agree on the canonical capability vector and all
  negative cases.

### Task 2A: Freeze the deterministic batch-v2 coordinator

**Files:**

- Create: `core/device-sdk-core/src/workflow/encrypted_upload_v2.rs`
- Create: `core/device-sdk-core/tests/encrypted_upload_v2_coordinator.rs`

- [x] Validate explicit v2 selection, exact storage format, session identity,
  negotiated bounds, and the minimum canonical object size before actions.
- [x] Model fresh start, proven-checkpoint resume, missing-window repair,
  persist-before-ACK, exact transfer evidence, native staging, receipt wait,
  receipt-gated CONFIRM, and completion as byte-free actions/events.
- [x] Make mixed profile, cancellation, staging failure, and stale phase events
  retain the device copy; expose no legacy-fallback action.
- [x] Keep the coordinator disconnected from `WorkflowEngine`, ABI, native
  hosts, and released managers until Task 2B and Task 3 are complete.

### Task 2B: Integrate the coordinator with the workflow engine

**Files:**

- Create: `core/device-sdk-core/tests/encrypted_upload_v2_workflow.rs`
- Modify: `core/device-sdk-core/src/engine/{command,effect,event,output,runtime}.rs`

- [x] Test the correlated engine adapter for fresh transfer, window repair,
  proven-checkpoint resume, rejected
  resume, staging/finalization/receipt failure, cancellation, mixed profile,
  stale callback, second owner, and no-downgrade behavior.
- [x] Add one v2 command carrying only profile/policy, recording/session IDs,
  negotiated bounds, and opaque host registration IDs.
- [x] Model native sink/staging and application-material work as correlated host
  effects; DATA and cryptographic document bytes never enter checkpoints or
  public notifications.
- [x] Emit terminal staging evidence before waiting for the application-owned
  finalization result and receipt.

The existing `protocol/workflows/schema.json` is deliberately tied to the
released `@bota.dev/react-native-sdk` `0.0.65` baseline. A v2 cross-SDK trace
would falsely claim that baseline implements this workflow, so the v2 trace is
deferred to Task 8 after the maintenance SDK has a real source test and both
runtimes can consume the same trace.

### Task 3: Extend frozen ABI v1 additively

**Files:**

- Modify: `bindings/device-sdk-ffi/include/bota_device_sdk.h`
- Modify: `bindings/device-sdk-ffi/src/{command,event,output,packet}.rs`
- Modify: `bindings/device-sdk-ffi/tests/**`
- Modify: native ABI evidence and digest records

- [x] Allocate additive command, effect, event, notification, and field
  constants without changing any existing numeric value; reuse the existing
  stable error vocabulary.
- [x] Reject duplicate/unknown fields and sensitive bytes at the ABI boundary.
- [x] Prove C and Swift smoke consumers compile and existing ABI fixtures remain
  byte-identical.

### Task 4: Implement Apple native transfer, staging, and recovery

- [x] Add the internal opaque v2 command mapper, exhaustive twelve-effect host
  boundary, typed failure mapping, staged-notification mapping, and a real C ABI
  engine-loop test. The default production port remains unavailable, so this
  checkpoint alone is not runtime support.
- [x] Add an in-memory application provider registry keyed by opaque material
  ID; unregister it on every terminal path. Apple now validates fixed document
  sizes, digest evidence, bodyless HTTPS staging requests, and removes entries
  before non-success cancellation callbacks run.
- [ ] Read capabilities fresh, run selection before START, and implement signed
  blob, START/ACK, DATA/window repair, manifest, EOF, receipt, and CONFIRM on the
  dedicated characteristics.
  - [x] Pin Apple's `0406..040B` UUIDs and configure an uncached `0406` read
    whose exact 24 bytes are decoded by Rust and SHA-256-bound for the provider.
  - [x] Add ABI packet kind `0x0523` so native hosts encode canonical signed-blob
    BEGIN/DATA/COMMIT/ABORT frames through the Rust codec.
  - [x] Add ABI packet kind `0x0524` so native hosts encode only app-originated
    LIST, START, WINDOW_ACK, RESUME_REQUEST, CONFIRM, and ABORT frames through
    Rust; reject device-originated variants, preserve `owner_revision`, and
    keep 16-byte upload-session UUID and packed-u32 missing-sequence field types
    symmetric across decode/encode. Include the new allocation in exhaustive
    codec-dispatch coverage.
  - [x] Add the serialized Apple `0407` writer: subscribe before BEGIN, chunk by
    the live write-with-response limit capped at 512 bytes, check cancellation
    between writes, start the exact kind/`write_id` RESULT timeout after COMMIT,
    and use bounded ABORT/unsubscribe cleanup that fails closed until confirmed
    disconnect when ownership cannot be proven released.
  - [x] Add the serialized Apple START/RESUME control boundary using the Rust
    `0x0524` encoder and `0x0522` decoder. Subscribe to notify-only `0409`
    before writing each request to `0408`, fail closed on foreign-session
    traffic, exactly verify echoed identity/digest/accepted-checkpoint fields,
    preserve device checkpoint state on RESUME_REJECT/ERROR, and retain the live
    stream/owner after acceptance. Bound cancellation or explicit
    ABORT/unsubscribe cleanup with a confirmed-disconnect reset gate.
  - [ ] Wire the resulting snapshot through application selection before START,
    then implement the Apple DATA/window repair, manifest, EOF, and CONFIRM
    lifecycle using the shared encoder.
- [ ] Stream ciphertext to a bounded native file and staging request without a
  plaintext copy or bridge payload.
- [ ] Persist and recover only mutually proven checkpoint metadata.
- [ ] Add XCTest coverage for all reducer traces and native failure paths.

### Task 5: Implement Android native transfer, staging, and recovery

- [ ] Mirror Task 4 with coroutine cancellation, bounded file I/O, OkHttp
  staging, and the same opaque material-provider lifecycle.
- [ ] Run JVM unit tests, Android host tests, and compile gates without claiming
  physical-device support.

### Task 6: Add the target React Native provider and progress surface

- [ ] Add only capability/profile/identifier/checkpoint/progress/error and
  opaque registration-ID fields to Codegen.
- [ ] Add static tests forbidding v2 DATA, authorization, manifest, receipt,
  staging URL/header, and native file bytes on the Codegen surface.
- [ ] Keep the legacy provider and public `BotaClient` behavior unchanged.

### Task 7: Implement maintenance `react-native-sdk` batch-v2

- [ ] Extend `ProtocolHandler` with the dedicated v2 characteristics and an
  opaque sink; do not reuse the v1/P10 parser or packet types.
- [ ] Persist only resumable checkpoint metadata. Keep authorization, receipt,
  manifest, staging credentials, and ciphertext out of AsyncStorage queue JSON.
- [ ] Stage the exact ciphertext bytes, submit the opaque manifest, wait for the
  application receipt, and confirm deletion only after device acceptance.
- [ ] Preserve all existing `syncRecording` and `syncAllRecordings` behavior for
  the legacy provider overload.

### Task 8: Cross-SDK conformance and release gating

- [ ] Run canonical/malformed vectors and identical workflow traces through
  Rust, Swift, Kotlin, target React Native, and maintenance React Native.
- [ ] Verify v1/P10 fixture digests, public surface compatibility, cancellation,
  restart recovery, and every retain-device failure.
- [ ] Update compatibility metadata only when both SDK runtime suites pass; keep
  `firmwareAdvertised: false` until firmware and hardware gates finish.
- [ ] Publish no package and enable no policy cohort as part of this plan.

## Verification Commands

```bash
cd /Users/zhangqi/ws/bota/app-sdk
cargo test -p bota-device-sdk-core
cargo test -p bota-device-sdk-ffi
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
npm test

cd /Users/zhangqi/ws/bota/react-native-sdk
npm test
npm run lint
npm run typecheck
npm run build
```

Native platform verification follows the existing commands in each repository's
`AGENTS.md`; physical-device and publication gates remain explicitly separate.
