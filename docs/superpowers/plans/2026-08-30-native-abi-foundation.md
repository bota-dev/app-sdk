# Native ABI Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the comparison-only JSON FFI spike with a tested, versioned, typed C ABI that Apple and Android facades can ship.

**Architecture:** A new `bota-device-sdk-ffi` crate wraps `WorkflowEngine` behind opaque handles and ABI-v1 typed field-list packet views. Commands and host events enter as borrowed typed packets; effects and notifications leave as owned packets. UTF-8 metadata and binary payloads occupy explicit slices, so no JSON or base64 representation crosses the shipping ABI.

**Tech Stack:** Rust 1.98, C17, Swift 6, Cargo, Swift compiler smoke tests

**Spec:** `docs/superpowers/specs/2026-08-30-native-facades-design.md`

## Global Constraints

- Every exported symbol begins with `bota_device_sdk_v1_`.
- Existing enum numeric values and packet-field meanings never change within ABI v1.
- Input slices are borrowed for one call; output packets are SDK-owned until exactly one free.
- Panics never unwind across FFI.
- Recording, firmware, characteristic, key, grant, and token bytes use raw slices, never JSON or base64.
- Checkpoints are opaque bytes to native storage.
- Native code never calls the Bota API directly.
- `bota-device-sdk-core` remains free of platform, FFI, and async-runtime dependencies.
- Every commit includes `Co-Authored-By: OpenAI Codex <noreply@openai.com>`.

---

### Task 1: Pin Native Migration Baselines

**Files:**
- Create: `protocol/baseline/native-sdks.json`
- Create: `tools/baseline/verify-native-baselines.mjs`
- Create: `tools/baseline/verify-native-baselines.test.mjs`
- Modify: `package.json`
- Modify: `ARCHITECTURE.md`

**Interfaces:**
- Consumes: Apple revision `cd15e545cabb8d6186dea93208b512a4f46cb5fd`, Android revision `0f06d2a22c55e4976778520cce42230d23ca4226`, React Native revision `44ac1221cb71eb01cafcdbfdf7a370847d3a10b4`.
- Produces: `npm run baseline:native -- --apple-path PATH --android-path PATH`, which rejects a dirty or revision-mismatched source checkout.

- [ ] **Step 1: Write the failing verifier tests**

Create tests that build temporary git repositories and assert that the verifier:

```javascript
test('accepts clean native checkouts at the pinned revisions', async () => {
  const result = await verifyNativeBaselines({ manifest, applePath, androidPath });
  assert.deepEqual(result, {
    apple: 'cd15e545cabb8d6186dea93208b512a4f46cb5fd',
    android: '0f06d2a22c55e4976778520cce42230d23ca4226',
  });
});

test('rejects a dirty native checkout', async () => {
  await assert.rejects(
    verifyNativeBaselines({ manifest, applePath, androidPath }),
    /Apple baseline is dirty/,
  );
});

test('rejects a revision mismatch', async () => {
  await assert.rejects(
    verifyNativeBaselines({ manifest, applePath, androidPath }),
    /Android revision .* does not match/,
  );
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `node --test tools/baseline/verify-native-baselines.test.mjs`

Expected: FAIL because `verify-native-baselines.mjs` and its exports do not exist.

- [ ] **Step 3: Implement the manifest and verifier**

The manifest contains exact repository URLs, revisions, package names, public
entry points, platform floors, and baseline test commands. The verifier uses
`git rev-parse HEAD` and `git status --porcelain`, never directory names or
branch names, to establish source identity.

- [ ] **Step 4: Run the native verifier and tooling tests**

Run:

```bash
npm run baseline:native -- \
  --apple-path ../bota-mobile-sdk-ios \
  --android-path ../bota-mobile-sdk-android \
  --allow-dirty-docs AGENTS.md
npm run test:tooling
```

Expected: PASS and print both pinned full revisions. Only the pre-existing
`AGENTS.md` edits may be admitted by the explicit audit flag.

- [ ] **Step 5: Commit**

```bash
git add protocol/baseline/native-sdks.json tools/baseline \
  package.json ARCHITECTURE.md
git commit -m "test: pin native sdk migration baselines" \
  -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
```

### Task 2: Create the Shipping FFI Crate and Lifecycle ABI

**Files:**
- Create: `bindings/device-sdk-ffi/Cargo.toml`
- Create: `bindings/device-sdk-ffi/src/lib.rs`
- Create: `bindings/device-sdk-ffi/src/error.rs`
- Create: `bindings/device-sdk-ffi/include/bota_device_sdk.h`
- Create: `bindings/device-sdk-ffi/tests/lifecycle.rs`
- Modify: `Cargo.toml`
- Modify: `sdk-version.toml`
- Modify: `core/device-sdk-core/tests/ffi_contract.rs`

**Interfaces:**
- Consumes: `bota_device_sdk_core::engine::WorkflowEngine`.
- Produces: `bota_device_sdk_v1_abi_version`, `engine_new`, `engine_free`, `last_error`, and stable status/error enums.

- [ ] **Step 1: Write failing ABI lifecycle tests**

```rust
#[test]
fn abi_version_and_engine_lifecycle_are_stable() {
    assert_eq!(unsafe { bota_device_sdk_v1_abi_version() }, 1);
    let engine = unsafe { bota_device_sdk_v1_engine_new() };
    assert!(!engine.is_null());
    unsafe { bota_device_sdk_v1_engine_free(engine) };
}

#[test]
fn null_engine_reports_invalid_argument_without_panicking() {
    let status = unsafe { bota_device_sdk_v1_engine_cancel(std::ptr::null_mut(), 0, 1) };
    assert_eq!(status, BotaDeviceSdkStatusV1::InvalidArgument);
}
```

- [ ] **Step 2: Run the lifecycle test and verify RED**

Run: `cargo test -p bota-device-sdk-ffi --test lifecycle`

Expected: FAIL because the shipping crate and symbols do not exist.

- [ ] **Step 3: Add the crate and minimal panic-safe exports**

The crate has:

```toml
[lib]
crate-type = ["rlib", "staticlib", "cdylib"]
```

It defines status values `OK=0`, `NO_OUTPUT=1`, `INVALID_ARGUMENT=-1`,
`OPERATION_FAILED=-2`, `PANIC=-3`, and `UNSUPPORTED_ABI=-4`. `last_error`
returns stable error code, operation, retryability, optional platform/protocol
code, and UTF-8 detail through an SDK-owned error handle.

- [ ] **Step 4: Verify lifecycle, formatting, and strict lint**

Run:

```bash
cargo test -p bota-device-sdk-ffi --test lifecycle
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add Cargo.toml Cargo.lock sdk-version.toml bindings \
  core/device-sdk-core/tests/ffi_contract.rs
git commit -m "feat: add shipping device sdk ffi crate" \
  -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
```

### Task 3: Define the ABI-v1 Packet Contract

**Files:**
- Create: `bindings/device-sdk-ffi/src/packet.rs`
- Create: `bindings/device-sdk-ffi/tests/packet_contract.rs`
- Modify: `bindings/device-sdk-ffi/src/lib.rs`
- Modify: `bindings/device-sdk-ffi/include/bota_device_sdk.h`
- Modify: `docs/adr/0001-command-event-host-boundary.md`

**Interfaces:**
- Produces: borrowed `BotaDeviceSdkPacketViewV1`, opaque `BotaDeviceSdkPacketV1`, `packet_view`, and `packet_free`.

Packet kind ranges are fixed:

```text
0x0101-0x0110 commands
0x0201-0x0220 host events
0x0301-0x0340 host effects
0x0401-0x0420 workflow notifications
0x0501-0x05ff protocol values (the foundation slice initially allocated through 0x0520)
```

The view layout is:

```c
typedef struct BotaDeviceSdkFieldViewV1 {
    uint32_t field_id;
    uint32_t field_type;
    uint64_t unsigned_value;
    int64_t signed_value;
    BotaDeviceSdkSliceV1 data;
} BotaDeviceSdkFieldViewV1;

typedef struct BotaDeviceSdkPacketViewV1 {
    uint32_t abi_version;
    uint32_t kind;
    uint32_t operation;
    uint32_t reserved;
    uint64_t request_id;
    uint64_t cancellation_id_high;
    uint64_t cancellation_id_low;
    const BotaDeviceSdkFieldViewV1 *fields;
    uint64_t field_count;
} BotaDeviceSdkPacketViewV1;
```

- [ ] **Step 1: Write failing layout and ownership tests**

Assert exact `size_of`, `align_of`, enum values, empty-slice representation,
UTF-8 validation, binary round-trip including embedded NUL, and one successful
view followed by one free.

- [ ] **Step 2: Run the packet tests and verify RED**

Run: `cargo test -p bota-device-sdk-ffi --test packet_contract`

Expected: FAIL because packet types and exports are absent.

- [ ] **Step 3: Implement owned packet storage and borrowed views**

Rust-owned packets retain all strings and byte vectors. `packet_view` fills a
caller-owned view whose pointers remain valid only while the packet is live.
Empty fields use a null pointer with length zero. No packet accessor allocates.

- [ ] **Step 4: Run packet tests and external header compilation**

Run:

```bash
cargo test -p bota-device-sdk-ffi --test packet_contract
cc -std=c17 -Wall -Wextra -Werror -fsyntax-only \
  -Ibindings/device-sdk-ffi/include tools/ffi-smoke/tests/abi_header.c
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bindings/device-sdk-ffi tools/ffi-smoke/tests/abi_header.c \
  docs/adr/0001-command-event-host-boundary.md
git commit -m "feat: define typed native packet abi" \
  -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
```

### Task 4: Map Every Workflow Command Into ABI v1

**Files:**
- Create: `bindings/device-sdk-ffi/src/command.rs`
- Create: `bindings/device-sdk-ffi/tests/commands.rs`
- Modify: `bindings/device-sdk-ffi/src/lib.rs`
- Modify: `bindings/device-sdk-ffi/include/bota_device_sdk.h`

**Interfaces:**
- Consumes: `Command`, `CapabilitySet`, `CancellationId`.
- Produces: `bota_device_sdk_v1_engine_start` for all ten existing command variants.

Numeric command kinds are fixed in declaration order:

```text
0x0101 discover devices
0x0102 connect
0x0103 reconnect
0x0104 provision
0x0105 transfer recording
0x0106 upload recording
0x0107 update firmware
0x0108 read device logs
0x0109 factory reset
0x010A resume factory reset
```

- [ ] **Step 1: Write one failing test per command kind**

Each test builds a packet with native-looking slices, starts the engine, and
asserts the first core effect. Include malformed serial, UUID, firmware size,
missing required field, unknown capability bit, and unknown command kind cases.

- [ ] **Step 2: Run command tests and verify RED**

Run: `cargo test -p bota-device-sdk-ffi --test commands`

Expected: FAIL because `engine_start` and command decoding are absent.

- [ ] **Step 3: Implement minimal command conversion**

Use core constructors and validators. Do not duplicate identifier validation in
the FFI crate. Convert the two 64-bit cancellation fields to the exact core
128-bit byte order already proven by the comparison spike.

- [ ] **Step 4: Run command and core workflow tests**

Run:

```bash
cargo test -p bota-device-sdk-ffi --test commands
cargo test -p bota-device-sdk-core workflow
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bindings/device-sdk-ffi
git commit -m "feat: map workflow commands across native abi" \
  -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
```

### Task 5: Map Effects and Notifications Into Owned Packets

**Files:**
- Create: `bindings/device-sdk-ffi/src/output.rs`
- Create: `bindings/device-sdk-ffi/tests/outputs.rs`
- Modify: `bindings/device-sdk-ffi/src/lib.rs`
- Modify: `bindings/device-sdk-ffi/include/bota_device_sdk.h`

**Interfaces:**
- Consumes: all `Effect`, `WorkflowNotification`, and `EffectRequest` variants.
- Produces: `bota_device_sdk_v1_engine_poll_output` returning one owned packet at a time.

Effect kind groups are fixed by capability:

```text
0x0301 timer schedule; 0x0302 timer cancel
0x0303-0x0308 persistence load/save/delete/identity/reset-save/reset-delete
0x0309-0x030B secure storage read/write/delete
0x0310-0x0318 BLE scan/stop/connect/discover/disconnect/read/write/subscribe/unsubscribe
0x0320-0x0321 network download/upload
0x0328 progress
0x0330-0x0331 provisioning/reset host material
0x0338-0x033B recording sink truncate/append/finalize/discard
0x0340 firmware blob read
```

Notification kinds occupy `0x0401` through `0x040C` in the order declared by
`WorkflowNotification`.

- [ ] **Step 1: Write failing output mapping tests**

Construct representative engine traces that cover every output kind. Assert
request/cancellation identity, raw payload equality for BLE write and recording
append, opaque checkpoint bytes, and stable error notification fields.

- [ ] **Step 2: Run output tests and verify RED**

Run: `cargo test -p bota-device-sdk-ffi --test outputs`

Expected: FAIL because output packet conversion is absent.

- [ ] **Step 3: Implement the output queue and mappings**

The queue stores Rust packet owners, not serialized bytes. Poll returns
`NO_OUTPUT` without allocating. BLE and recording payload vectors move into the
owned packet; they are not copied into integer arrays or text fields.

- [ ] **Step 4: Run output, ownership, and workflow tests**

Run:

```bash
cargo test -p bota-device-sdk-ffi --test outputs
cargo test -p bota-device-sdk-ffi --test packet_contract
cargo test --workspace
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bindings/device-sdk-ffi
git commit -m "feat: expose typed workflow outputs to native hosts" \
  -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
```

### Task 6: Map Every Host Event and Cancellation

**Files:**
- Create: `bindings/device-sdk-ffi/src/event.rs`
- Create: `bindings/device-sdk-ffi/tests/events.rs`
- Modify: `bindings/device-sdk-ffi/src/lib.rs`
- Modify: `bindings/device-sdk-ffi/include/bota_device_sdk.h`

**Interfaces:**
- Consumes: every `HostEventKind`, `BleEvent`, and `NetworkEvent` variant.
- Produces: `bota_device_sdk_v1_engine_dispatch` and `bota_device_sdk_v1_engine_cancel`.

- [ ] **Step 1: Write failing event correlation tests**

Cover scan candidates, connection lifecycle, characteristic bytes, timer,
checkpoint load/save/failure, provisioning material, reset grants, recording
sink completion/integrity failure, firmware chunks, secure storage, and network
progress/completion/failure. Verify a stale request ID fails without ending the
active workflow and a mismatched cancellation ID is rejected.

- [ ] **Step 2: Run event tests and verify RED**

Run: `cargo test -p bota-device-sdk-ffi --test events`

Expected: FAIL because typed event dispatch is absent.

- [ ] **Step 3: Implement event conversion and dispatch**

Binary values read from the raw byte slice of the declared field. Optional text
omits its field for none and uses an explicit UTF-8 field for some. Native
platform codes use signed fields; protocol statuses use unsigned fields.

- [ ] **Step 4: Run event and cross-workflow correlation tests**

Run:

```bash
cargo test -p bota-device-sdk-ffi --test events
cargo test -p bota-device-sdk-core --test workflow_conformance_matrix
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bindings/device-sdk-ffi
git commit -m "feat: dispatch typed native host events" \
  -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
```

### Task 7: Expose Shared Protocol Codecs Without Parser Copies

**Files:**
- Create: `bindings/device-sdk-ffi/src/protocol.rs`
- Create: `bindings/device-sdk-ffi/tests/protocol.rs`
- Modify: `bindings/device-sdk-ffi/src/lib.rs`
- Modify: `bindings/device-sdk-ffi/include/bota_device_sdk.h`

**Interfaces:**
- Consumes: core status, recording-list, transfer, OTA, provisioning, settings, and log codecs.
- Produces: `bota_device_sdk_v1_protocol_decode` and `bota_device_sdk_v1_protocol_encode` using the initial packet-kind allocation within `0x0501` through `0x0520`; later additive protocol inspection kinds remain in the reserved `0x05xx` range.

- [ ] **Step 1: Write failing codec parity tests**

Run every committed fixture through the C ABI and assert the same typed values
or bytes as the Rust fixture tests. Include malformed, truncated, unknown-enum,
and oversized payload cases.

- [ ] **Step 2: Run codec tests and verify RED**

Run: `cargo test -p bota-device-sdk-ffi --test protocol`

Expected: FAIL because protocol exports are absent.

- [ ] **Step 3: Implement thin codec mappings**

All parsing and serialization calls the core. The FFI layer only maps owned
models to packet fields. Unknown wire enum values remain numeric and available to
facades.

- [ ] **Step 4: Run codec and fixture parity tests**

Run:

```bash
cargo test -p bota-device-sdk-ffi --test protocol
cargo test -p bota-device-sdk-core --test fixture_decode
cargo test -p bota-device-sdk-core --test fixture_encode
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bindings/device-sdk-ffi
git commit -m "feat: expose shared protocol codecs through native abi" \
  -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
```

### Task 8: Replace the JSON Smoke With Real C and Swift Callers

**Files:**
- Create: `tests/conformance/native/c/main.c`
- Create: `tests/conformance/native/swift/main.swift`
- Create: `tools/ffi-smoke/run-native-c-smoke.sh`
- Create: `tools/ffi-smoke/run-native-swift-smoke.sh`
- Modify: `tools/ffi-smoke/Cargo.toml`
- Modify: `tools/ffi-smoke/src/lib.rs`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: shipping static library and public header.
- Produces: external callers that start discovery, dispatch a scan result, poll a notification/effect sequence, cancel, inspect one stable error, and free every owner.

- [ ] **Step 1: Write callers against the declared header**

The C and Swift programs must not depend on Rust types, private headers, JSON,
or test-only Rust helper functions.

- [ ] **Step 2: Run callers and verify RED**

Run:

```bash
tools/ffi-smoke/run-native-c-smoke.sh
tools/ffi-smoke/run-native-swift-smoke.sh
```

Expected: FAIL until the scripts link the shipping library and all required ABI
mapping is complete.

- [ ] **Step 3: Implement reproducible build and link scripts**

Scripts build only `bota-device-sdk-ffi`, compile the external caller with
warnings denied, run it, and use a temporary output directory removed by a trap.
The Swift smoke imports the Clang module generated from the public header.

- [ ] **Step 4: Remove shipping dependence on the JSON spike**

Keep UniFFI comparison tests isolated under the `uniffi-spike` feature. Delete
the manual JSON C exports from `tools/ffi-smoke` after the typed callers pass;
retain only evidence needed to reproduce the rejected binding comparison.

- [ ] **Step 5: Run both external callers and the full workspace**

Run:

```bash
tools/ffi-smoke/run-native-c-smoke.sh
tools/ffi-smoke/run-native-swift-smoke.sh
cargo test --workspace
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tests/conformance tools/ffi-smoke .github/workflows/ci.yml Cargo.lock
git commit -m "test: run native callers against shipping ffi" \
  -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
```

### Task 9: Freeze ABI Evidence and Prepare Apple Planning

**Files:**
- Create: `release/evidence/1.0.0-alpha.1-native-abi.md`
- Create: `docs/superpowers/plans/2026-08-30-apple-facade.md`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `AGENTS.md`
- Modify: `docs/releasing.md`
- Modify: `protocol/compatibility/firmware-compatibility.json`

**Interfaces:**
- Produces: reviewed ABI evidence and the next executable plan for the Apple facade.

- [ ] **Step 1: Run the complete ABI release gate**

```bash
npm ci
npm run check
npm run test:tooling
npm run test:workflows -- --sdk-path ../react-native-sdk
cargo xtask protocol generate --check
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace
tools/ffi-smoke/run-native-c-smoke.sh
tools/ffi-smoke/run-native-swift-smoke.sh
cargo deny check
cargo package --locked --package bota-device-sdk-core
```

Expected: PASS. Dependency duplicate warnings already accepted in `deny.toml`
may print, but every cargo-deny category reports `ok`.

- [ ] **Step 2: Record exact evidence**

Evidence records source revision, Rust toolchain, Swift compiler, header digest,
static-library checksum, test counts, supported packet kinds, and the explicit
statement that no Apple or Android facade capability is published yet.

- [ ] **Step 3: Write the Apple facade implementation plan**

The next plan consumes the frozen header and covers Swift model mapping,
`CoreEngineActor`, fake-host conformance, CoreBluetooth operation serialization,
storage/network ports, XCFramework assembly, package import tests, and the Apple
physical-device harness. It does not redesign ABI v1.

- [ ] **Step 4: Commit**

```bash
git add release/evidence docs README.md ARCHITECTURE.md AGENTS.md \
  protocol/compatibility/firmware-compatibility.json
git commit -m "docs: freeze native abi foundation evidence" \
  -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
```
