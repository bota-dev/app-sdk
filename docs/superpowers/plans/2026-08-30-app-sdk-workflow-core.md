# Device SDK Workflow Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement deterministic, resumable device workflows in the Rust core
without taking Bluetooth, storage, HTTP, or application-backend ownership away
from platform hosts.

**Architecture:** `WorkflowEngine` authorizes one command at a time and routes
typed host events to a workflow-specific reducer. Reducers emit correlated host
effects and public workflow notifications; durable checkpoints contain only
stable identity, phase, counters, and retry state. Language-neutral scenario
traces pin decisions inherited from the production React Native SDK.

**Tech Stack:** Rust 1.98, Serde, Cargo tests, Node.js 22 fixture tooling,
language-neutral JSON scenarios.

**Spec:** Bota's private `App SDK Architecture.md`, sections 5, 7, 8, 11,
and 12; public boundary contract in `docs/adr/0001-command-event-host-boundary.md`.

## Global Constraints

- The production React Native reference is commit `44ac1221cb71` until the
  React Native migration milestone passes physical-device acceptance.
- Core code has no async runtime, filesystem, Bluetooth framework, HTTP client,
  platform SDK, or FFI generator dependency.
- Every host request carries an operation, cancellation ID, and request ID.
- Only one radio-owning workflow is active per engine.
- Checkpoints never contain credentials, presigned URLs, private keys, file
  paths, recording bytes, firmware bytes, or provisioning payloads.
- High-volume recording and OTA bytes remain between Rust and native hosts; a
  future JavaScript or Dart facade receives progress and terminal metadata only.
- Manual connection and pairing take priority over background reconnect.
- Unsupported capabilities fail before any transport effect is emitted.
- Device upload ownership must be freshly inactive before BLE fallback begins.
- Factory reset persists the exact successful device result before sending its
  receipt and never acknowledges a failed wipe.
- Stable `v1.0.0` remains reserved for the React Native-consumable release;
  workflow-core artifacts use `1.0.0-alpha.N`.

---

### Task 1: Convert the unpublished release candidate to `1.0.0-alpha.1`

**Files:**
- Modify: `sdk-version.toml`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `core/device-sdk-core/Cargo.toml`
- Modify: `tools/xtask/Cargo.toml`
- Modify: `protocol/compatibility/firmware-compatibility.json`
- Rename: `release/examples/1.0.0.json` to
  `release/examples/1.0.0-alpha.1.json`
- Rename: `release/evidence/1.0.0-readiness.md` to
  `release/evidence/1.0.0-alpha.1-readiness.md`
- Modify: `tools/xtask/tests/release_manifest.rs`
- Modify: `tools/xtask/tests/release_readiness.rs`
- Modify: `README.md`
- Modify: `core/device-sdk-core/README.md`
- Modify: `AGENTS.md`
- Modify: `docs/releasing.md`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: one synchronized version, `1.0.0-alpha.1`, accepted only by tag
  `v1.0.0-alpha.1`.

- [x] **Step 1: Make release tests expect the prerelease**

Change hard-coded release fixture paths and assertions to
`1.0.0-alpha.1`/`v1.0.0-alpha.1`, while retaining rejection coverage for an
unprefixed tag and a mismatched stable tag.

- [x] **Step 2: Run the focused tests and confirm they fail**

Run: `cargo test -p xtask --test release_manifest --test release_readiness`

Expected: failure because metadata and the release example still say `1.0.0`.

- [x] **Step 3: Synchronize release metadata and documentation**

Set every version authority and artifact entry to `1.0.0-alpha.1`. Update
release instructions to explain that stable `v1.0.0` is reserved for the
React Native compatibility release.

- [x] **Step 4: Verify the prerelease package**

Run:

```bash
cargo xtask release verify-tag v1.0.0-alpha.1
cargo package --locked --package bota-device-sdk-core
cargo publish --locked --package bota-device-sdk-core --dry-run
```

Expected: all commands pass; the final command aborts only because it is a dry
run.

- [x] **Step 5: Commit**

```bash
git add sdk-version.toml package.json package-lock.json Cargo.lock \
  core/device-sdk-core/Cargo.toml tools/xtask/Cargo.toml \
  tools/xtask/tests protocol/compatibility release README.md AGENTS.md \
  docs/releasing.md docs/superpowers/plans/2026-08-30-app-sdk-workflow-core.md
git commit -m "chore: reserve stable sdk 1.0.0"
```

### Task 2: Add the deterministic workflow runtime and trace harness

**Files:**
- Create: `core/device-sdk-core/src/engine/runtime.rs`
- Create: `core/device-sdk-core/src/engine/output.rs`
- Create: `core/device-sdk-core/src/engine/request.rs`
- Create: `core/device-sdk-core/src/workflow/discovery.rs`
- Create: `core/device-sdk-core/src/workflow/mod.rs`
- Modify: `core/device-sdk-core/src/engine/mod.rs`
- Modify: `core/device-sdk-core/src/engine/command.rs`
- Modify: `core/device-sdk-core/src/engine/effect.rs`
- Modify: `core/device-sdk-core/src/engine/event.rs`
- Modify: `core/device-sdk-core/src/error.rs`
- Create: `core/device-sdk-core/tests/support/fake_host.rs`
- Create: `core/device-sdk-core/tests/workflow_runtime.rs`

**Interfaces:**
- Produces: `RequestId(u64)`, `WorkflowStatus`, `WorkflowNotification`, and
  `WorkflowEngine::{start, dispatch, status}`.
- Produces: `WorkflowReducer`, implemented by every workflow reducer.
- Consumes: existing `Command::authorize`, `EffectRequest`, `CancellationId`,
  and `WorkflowCheckpoint`.

```rust
pub struct WorkflowEngine {
    active: Option<ActiveWorkflow>,
    next_request_id: u64,
}

impl WorkflowEngine {
    pub fn start(
        &mut self,
        command: Command,
        capabilities: &CapabilitySet,
        cancellation_id: CancellationId,
    ) -> Result<Vec<EffectRequest>, DeviceSdkError>;

    pub fn dispatch(&mut self, event: Event)
        -> Result<Vec<EffectRequest>, DeviceSdkError>;

    pub fn status(&self) -> WorkflowStatus;
}
```

- [x] **Step 1: Write runtime tests**

Cover capability rejection before effects, monotonic request IDs, one active
operation, stale request-event rejection, idempotent cancellation, terminal
completion, and rejection of events after completion.

- [x] **Step 2: Run the focused test and confirm it fails**

Run: `cargo test -p bota-device-sdk-core --test workflow_runtime`

Expected: compile failure because the runtime API does not exist.

- [x] **Step 3: Implement the minimal runtime**

Add `RequestId` to response-producing BLE, persistence, secure-storage, timer,
and network effects/events. Add `Effect::Notify(WorkflowNotification)` for
started, progress, retrying, completed, cancelled, and failed outputs. Return
`operation_in_progress` and `unexpected_event` through stable `ErrorCode`
variants.

- [x] **Step 4: Add the deterministic fake host**

The test-only host records each effect before returning one scripted event. It
must reject an event whose request ID does not match the effect being completed.
No sleeping, threads, filesystem, Bluetooth, or HTTP are used.

- [x] **Step 5: Verify and commit**

Run:

```bash
cargo test -p bota-device-sdk-core --test workflow_runtime
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

Commit: `feat: add deterministic workflow runtime`

### Task 3: Implement manual connection and single-owner reconnect

**Files:**
- Create: `core/device-sdk-core/src/model/discovery.rs`
- Create: `core/device-sdk-core/src/workflow/mod.rs`
- Create: `core/device-sdk-core/src/workflow/connection.rs`
- Modify: `core/device-sdk-core/src/lib.rs`
- Modify: `core/device-sdk-core/src/engine/{command,effect,event,runtime}.rs`
- Modify: `core/device-sdk-core/src/engine/checkpoint.rs`
- Create: `protocol/workflows/connection.json`
- Create: `core/device-sdk-core/tests/connection_workflow.rs`

**Interfaces:**
- Produces: `DeviceCandidate`, `ReconnectHint`, `ConnectionMode`, and
  `ConnectionWorkflow`.
- Adds commands:

```rust
Command::Connect {
    device: DeviceSerialNumber,
    candidate: DeviceCandidate,
}
Command::Reconnect {
    device: DeviceSerialNumber,
    hint: ReconnectHint,
}
```

- [x] **Step 1: Add failing React Native parity scenarios**

Pin these reference behaviors from `DeviceManager.test.ts`: manual connects
always read serial fresh; advertised-address matches keep scanning without
same-name probing; stale addresses recover by serial probe; rotated iOS IDs and
app reinstall probe candidates sequentially; background reconnect never starts
while manual work owns the engine.

- [x] **Step 2: Run the connection test and confirm it fails**

Run: `cargo test -p bota-device-sdk-core --test connection_workflow`

- [x] **Step 3: Implement candidate selection and identity verification**

Manual flow: connect selected handle, discover services, read serial, reject a
mismatch, persist the verified identity, complete. Reconnect flow: try a stored
handle, then scan for an advertised-address match, then probe Bota candidates
one at a time by serial. Disconnect every mismatched probe before considering
the next candidate.

- [x] **Step 4: Implement timeout and retry state**

Use monotonic timer effects. A single reconnect command owns one scan and at
most one candidate connection at a time. Persist only phase, retry count,
device identity, and candidate index; never persist advertisement bytes.

- [x] **Step 5: Verify and commit**

Run the focused test, workspace tests, fixture tooling, formatting, and Clippy.
Commit: `feat: add deterministic connection recovery`

### Task 4: Implement provisioning and authenticated factory reset

**Files:**
- Create: `core/device-sdk-core/src/workflow/provisioning.rs`
- Create: `core/device-sdk-core/src/workflow/factory_reset.rs`
- Modify: `core/device-sdk-core/src/model/provisioning.rs`
- Modify: `core/device-sdk-core/src/engine/{command,effect,event,runtime}.rs`
- Modify: `core/device-sdk-core/src/engine/checkpoint.rs`
- Create: `protocol/workflows/provisioning.json`
- Create: `protocol/workflows/factory-reset.json`
- Create: `core/device-sdk-core/tests/provisioning_workflow.rs`
- Create: `core/device-sdk-core/tests/factory_reset_workflow.rs`

**Interfaces:**
- Provisioning consumes an opaque host material ID, reads the nonce and device
  public key, asks the host for ephemeral material, writes bounded chunks, and
  completes only after device acceptance.
- Factory reset consumes `command_id` and an opaque grant ID. It emits
  `PersistenceEffect::SaveFactoryResetResult` before the receipt write and
  deletes the durable result only after receipt success.

- [x] **Step 1: Port provisioning and reset scenario traces**

Include chunk rejection, disconnect recovery, invalid grant, wipe/storage
failure, persistence failure before receipt, receipt-write failure, and replay
of an already-persisted successful result without resending the destructive
command.

- [x] **Step 2: Confirm focused tests fail**

Run both new workflow tests; expect missing reducer APIs.

- [x] **Step 3: Implement provisioning**

Keep nonce, keys, grants, and payload bytes in volatile reducer state only.
Persist phase and retry counters, redact notifications, and zeroize volatile
buffers on completion, cancellation, and failure without adding a dependency.

- [x] **Step 4: Implement reset close-loop**

Subscribe before writing the grant and reset opcode. Accept only the exact
command-bound success result. Persist `{command_id, result_code,
deleted_recording_count}` before receipt opcode `0x0A`. Never send receipt for
firmware failure or ambiguous disconnect.

- [x] **Step 5: Verify and commit separately**

Commit provisioning as `feat: add deterministic provisioning workflow` and
factory reset as `feat: add authenticated reset workflow`.

### Task 5: Implement resumable recording transfer and upload handoff

**Files:**
- Create: `core/device-sdk-core/src/workflow/recording_transfer.rs`
- Create: `core/device-sdk-core/src/workflow/upload_handoff.rs`
- Modify: `core/device-sdk-core/src/engine/{command,effect,event,runtime}.rs`
- Modify: `core/device-sdk-core/src/engine/checkpoint.rs`
- Create: `protocol/workflows/recording-transfer.json`
- Create: `protocol/workflows/upload-handoff.json`
- Create: `core/device-sdk-core/tests/recording_transfer_workflow.rs`
- Create: `core/device-sdk-core/tests/upload_handoff_workflow.rs`

**Interfaces:**
- Adds host-owned sink effects for append, truncate-to-checkpoint, finalize, and
  discard; notification payload bytes never become public facade events.
- Upload handoff accepts opaque upload and destination IDs; URLs and credentials
  never enter core state or checkpoints.

- [x] **Step 1: Add failing transfer scenarios**

Cover subscribe-before-start, ACK sequencing, duplicate packet idempotence,
checkpoint resume, disconnect retry, cancellation without device deletion,
integrity failure, and confirm-delete only after durable sink finalization.

- [x] **Step 2: Add failing upload-ownership scenarios**

Port busy, detached, unknown ownership, direct-upload failure with fresh
inactive status, and successful direct upload. BLE fallback is emitted only for
the fresh-inactive case.

- [x] **Step 3: Implement transfer and upload reducers**

The transfer reducer owns sequence and checkpoint decisions; the native host
owns file and network bytes. The handoff reducer owns channel/fallback policy;
the application still obtains upload destinations and finalizes backend state.

- [x] **Step 4: Verify and commit separately**

Commit transfer as `feat: add resumable recording transfer` and handoff as
`feat: add guarded upload handoff`.

### Task 6: Implement OTA download, transfer, reboot, and reconnect

**Files:**
- Create: `core/device-sdk-core/src/workflow/firmware_update.rs`
- Modify: `core/device-sdk-core/src/model/ota.rs`
- Modify: `core/device-sdk-core/src/engine/{command,effect,event,runtime}.rs`
- Modify: `core/device-sdk-core/src/engine/checkpoint.rs`
- Create: `protocol/workflows/firmware-update.json`
- Create: `core/device-sdk-core/tests/firmware_update_workflow.rs`

**Interfaces:**
- Firmware bytes remain in a host-owned blob identified by `download_id`.
- Progress uses phase plus byte counts and never emits the image buffer.

- [x] **Step 1: Add failing OTA scenarios**

Cover HTTP rejection, unknown download total with firmware-size fallback,
early flow-control ACK, ACK timeout, device rejection, transfer resume,
expected reboot disconnect, reconnect timeout, and successful version readback.

- [x] **Step 2: Implement the reducer**

Sequence download, device preparation, chunk writes, flow-control ACKs,
verification, expected reboot, reconnect, and version readback. Cache an ACK
that arrives before the reducer begins waiting for it.

- [x] **Step 3: Verify and commit**

Run focused and full gates. Commit: `feat: add resumable firmware workflow`.

### Task 7: Implement device-log subscription ownership

**Files:**
- Create: `core/device-sdk-core/src/workflow/device_logs.rs`
- Modify: `core/device-sdk-core/src/engine/{command,effect,event,runtime}.rs`
- Create: `protocol/workflows/device-logs.json`
- Create: `core/device-sdk-core/tests/device_logs_workflow.rs`

**Interfaces:**
- Produces sanitized line notifications from the existing decoder.
- One pending or active subscription owns diagnostics for a device.

- [x] **Step 1: Add failing ownership scenarios**

Port subscribe-before-start, overlapping-subscription rejection, stop-on-user
cancel, cleanup-without-stop on disconnect, feature-unavailable start failure,
sequence wrap, gaps, dropped-byte recovery, and split UTF-8 input.

- [x] **Step 2: Implement and verify**

Reuse `protocol::logs`; do not duplicate decoding. Commit:
`feat: add device log workflow`.

### Task 8: Close cancellation, recovery, and conformance gaps

**Files:**
- Create: `protocol/workflows/schema.json`
- Create: `tools/baseline/compare-workflows.mjs`
- Create: `tools/baseline/compare-workflows.test.mjs`
- Modify: `package.json`
- Modify: `protocol/compatibility/firmware-compatibility.json`
- Modify: `ARCHITECTURE.md`
- Modify: `README.md`
- Create: `release/evidence/1.0.0-alpha.1-workflow-core.md`

**Interfaces:**
- Produces: `npm run test:workflows`, validating every scenario against the
  schema and the deterministic Rust trace export.

- [x] **Step 1: Define and test the scenario schema**

Require unique scenario names, pinned React Native source test, command,
capabilities, ordered inputs, ordered effects/notifications, and terminal
status. Reject credentials, URLs, paths, and payload bodies in checkpoints.

- [x] **Step 2: Add cancellation and stale-event matrix**

Every workflow must handle cancellation in each nonterminal phase, ignore no
stale correlated response, and reject a second command without mutating the
active workflow.

- [x] **Step 3: Update compatibility claims and evidence**

Mark a workflow supported only when positive, rejection, cancellation, and
resume scenarios all pass. Record exact commands and counts.

- [x] **Step 4: Verify and commit**

Run all Node, Rust, license, formatting, lint, documentation, package, and
publish-dry-run gates. Commit: `docs: record workflow core milestone evidence`.

### Task 9: Decide the native binding boundary without shipping a facade

**Files:**
- Create: `docs/spikes/ffi-boundary-evaluation.md`
- Create: `core/device-sdk-core/include/bota_device_sdk.h`
- Create: `tools/ffi-smoke/Cargo.toml`
- Create: `tools/ffi-smoke/src/lib.rs`
- Modify: `Cargo.toml`
- Modify: `deny.toml`
- Modify: `docs/adr/0001-command-event-host-boundary.md`
- Create: `core/device-sdk-core/tests/ffi_contract.rs`

**Interfaces:**
- Produces a reviewed choice between a manually owned C ABI and one pinned
  binding generator, with measured Swift/Kotlin support, cancellation/event
  delivery, ownership/copy boundaries, binary size, licenses, and CI behavior.
- Does not publish Apple, Android, React Native, Flutter, Web, or Windows
  artifacts.

- [x] **Step 1: Write the ABI contract test before the spike**

Require opaque engine handles, caller-owned input buffers, SDK-owned output
buffers with an explicit free function, numeric request/cancellation IDs, and
no Rust layout or async-runtime types in the header.

- [x] **Step 2: Implement both smoke boundaries and measure them**

Expose engine create/free, command JSON decode for the spike only, event
dispatch, output polling, and buffer free. Record generated source, binary
size, dependency tree, license result, and minimal Swift/Kotlin call sites.

- [x] **Step 3: Update ADR 0001 with the decision**

Choose only after both paths pass the same smoke contract. Document rejected
trade-offs and pin every adopted tool version.

- [x] **Step 4: Verify and commit**

Run all repository gates. Commit: `docs: decide native sdk binding boundary`.
