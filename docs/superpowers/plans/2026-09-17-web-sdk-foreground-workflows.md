# Bota SDK for Web Foreground Workflow Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `@bota.dev/web-sdk` from its read-only foundation into the complete browser-feasible foreground App SDK and publish the exact synchronized beta candidate.

**Architecture:** Rust remains the authority for long-running workflow reducers, protocol codecs, integrity decisions, checkpoints, and stable errors. A private WASM bridge exposes workflow-specific starts and bounded codecs; one TypeScript `BrowserWorkflowRuntime` executes browser Bluetooth, storage, network, provider, and lifecycle effects while feature managers expose browser-idiomatic APIs.

**Tech Stack:** Rust 1.98, `wasm-bindgen`, `serde-wasm-bindgen`, WebAssembly, TypeScript 6.0.3, Node 22+, npm 11.10.0, Web Bluetooth, IndexedDB, OPFS, Fetch, Playwright 1.63.0, Vite.

**Spec:** `docs/superpowers/specs/2026-09-17-web-sdk-foreground-workflows-design.md`

## Global Constraints

- The package identifier remains exactly `@bota.dev/web-sdk` and the package remains ESM-only.
- The candidate version remains `1.2.0-beta.1` only while the Git tag and every target package coordinate remain unused; all version authorities move together if it becomes occupied.
- The SDK is foreground-only and page-owned. It does not claim worker, background, closed-tab, Safari/iOS fallback, Flutter Web, or Windows support.
- Live recording streaming and authenticated factory reset stay outside this increment.
- A new Bluetooth permission always uses `requestDevice()` from a user gesture. Explicit reconnect uses only `getDevices()` results already authorized by the browser.
- A device is trusted only after a fresh Device Information serial read exactly matches the requested serial. Advertised names are filter/display metadata only.
- Rust owns workflow state, packet encoding/decoding, protocol limits, integrity evidence, and stable workflow errors. TypeScript never hand-builds a Bota wire packet.
- One mutating GATT operation owns the client at a time. Passive subscriptions coexist only on distinct characteristics with deterministic teardown.
- Recording and firmware bodies stay in OPFS and cross JavaScript/WASM only as bounded chunks.
- A tenant `storageNamespace` is mandatory before a durable workflow starts. Read-only connection and snapshot operations continue to work without one.
- Presigned URLs, headers, grants, credentials, tokens, authorization documents, and receipts stay memory-only and never enter logs, public errors, IndexedDB, or OPFS metadata.
- Device recording confirmation occurs only after a tenant-scoped durable journal proves cloud completion and contains the exact profile-specific confirmation material.
- Host applications own authentication and every Bota backend API call. Providers return only exact operation-scoped material.
- Every behavior starts with an observed failing test. Every task ends with a focused passing gate and a separate commit carrying `Co-Authored-By: OpenAI Codex <noreply@openai.com>`.
- Existing Apple, Android, React Native, Flutter, release-manifest, license, and candidate-inventory gates cannot be weakened.

## File And Ownership Map

The implementation adds focused Web files instead of growing `deviceManager.ts` into a second platform core:

| File | Responsibility |
|---|---|
| `bindings/device-sdk-wasm/src/workflows.rs` | Typed Rust command construction and workflow-specific browser starts |
| `bindings/device-sdk-wasm/src/codecs.rs` | Browser-required Rust codec and bounded integrity exports |
| `frameworks/web/src/gatt.ts` | Canonical service/characteristic UUID constants only |
| `frameworks/web/src/capabilities.ts` | Browser feature detection and public capability matrix |
| `frameworks/web/src/transport.ts` | Browser transport interfaces and sanitized transport errors |
| `frameworks/web/src/webBluetoothTransport.ts` | Real Web Bluetooth picker, authorized-device, GATT, and notification adapter |
| `frameworks/web/src/storage.ts` | Public custom-storage contract plus durable record types |
| `frameworks/web/src/indexedDbWorkflowStore.ts` | Tenant-scoped small-state persistence |
| `frameworks/web/src/opfsBlobStore.ts` | Bounded large-body reads, writes, truncation, and deletion |
| `frameworks/web/src/workflowRuntime.ts` | Single workflow/effect executor and direct-operation ownership queue |
| `frameworks/web/src/providers.ts` | Host backend-provider contracts and redacted operation material |
| `frameworks/web/src/recordingManager.ts` | Recording list, legacy sync, v2 selection, resume, cancel, and confirmation recovery |
| `frameworks/web/src/encryptedUploadV2Host.ts` | Browser v2 signed-document, transfer-control, receiver, staging, receipt, and abort host |
| `frameworks/web/src/provisioningManager.ts` | Provision, backend close-loop, deprovision, and connection settings |
| `frameworks/web/src/wifiManager.ts` | WiFi scan/configure/disconnect/status/subscription |
| `frameworks/web/src/controlManager.ts` | Grant-bound recording start/stop |
| `frameworks/web/src/otaManager.ts` | Durable download, integrity, firmware workflow, reconnect, resume, and cancellation |
| `frameworks/web/src/logManager.ts` | Sanitized single-owner device-log subscription |
| `frameworks/web/src/client.ts` | Dependency composition, public managers, destruction, and scoped cleanup |

---

### Task 1: Expand the private WASM bridge to every included Rust workflow

**Files:**
- Create: `bindings/device-sdk-wasm/src/workflows.rs`
- Modify: `bindings/device-sdk-wasm/src/lib.rs`
- Modify: `bindings/device-sdk-wasm/tests/bridge_contract.rs`
- Modify: `frameworks/web/src/core.ts`
- Modify: `frameworks/web/src/wasmCore.ts`
- Modify: `frameworks/web/src/deviceManager.ts`
- Modify: `frameworks/web/src/__tests__/core.test.ts`

**Interfaces:**
- Consumes: `WorkflowEngine`, `Command::{Reconnect, Provision, TransferRecording, TransferEncryptedRecording, UpdateFirmware, ReadDeviceLogs}`, `Event::Cancelled`, and each command's existing core model.
- Produces: `CoreBridge.startReconnect`, `startProvisioning`, `startRecordingTransfer`, `startEncryptedUploadV2`, `startFirmwareUpdate`, `startDeviceLogs`, and `cancel`, with every returned effect preserving `requestId`, `operation`, and the exact 16-byte `cancellationId`.

- [ ] **Step 1: Write failing native bridge tests for every workflow start and cancellation owner**

  Add one table-driven test per command. Assert the first semantic effect, required capability set, structured invalid-input failure, second-owner rejection, exact cancellation-owner rejection, and idempotent cancellation after terminal settlement. Use concrete values:

  ```rust
  const SERIAL: &str = "EVFXXW67KP";
  const CANCELLATION_ID: [u8; 16] = [0x11; 16];
  const RECORDING_UUID: [u8; 16] = [0x22; 16];

  #[test]
  fn recording_transfer_starts_without_device_confirmation() {
      let effects = BridgeCore::default()
          .start_recording_transfer(
              SERIAL,
              RECORDING_UUID,
              "web-sink-1",
              4096,
              CANCELLATION_ID,
          )
          .unwrap();
      assert!(matches!(
          effects[1].effect,
          Effect::Persistence(PersistenceEffect::LoadCheckpoint)
      ));
  }
  ```

  The bridge must hard-code `confirm_on_completion: false`; cloud-gated confirmation belongs to `RecordingManager` recovery, never the transfer start.

- [ ] **Step 2: Run the bridge tests and observe the missing methods**

  Run:

  ```bash
  cargo test -p bota-device-sdk-wasm --test bridge_contract
  ```

  Expected: compilation fails because the new workflow methods do not exist.

- [ ] **Step 3: Implement typed Rust workflow starts and cancellation**

  Put core command construction in `workflows.rs`. Keep WASM conversion in `lib.rs`:

  ```rust
  impl BridgeCore {
      pub fn cancel(
          &mut self,
          cancellation_id: [u8; 16],
      ) -> Result<Vec<EffectRequest>, DeviceSdkError> {
          self.engine.dispatch(Event::Cancelled {
              cancellation_id: CancellationId::from_bytes(cancellation_id),
          })
      }
  }
  ```

  Each `start_*` method validates strings and fixed-length byte arrays through existing core constructors, supplies only the capabilities required by that command, and delegates to `WorkflowEngine::start`. Do not expose generic raw `Command` construction to JavaScript.

- [ ] **Step 4: Expand the private TypeScript bridge contract**

  Preserve ownership metadata on every effect:

  ```ts
  export interface CoreEffectEnvelope {
    requestId: bigint
    operation: CoreOperation
    cancellationId: Uint8Array
    effect: CoreEffect
  }

  export interface CoreBridge {
    startExactConnection(input: CoreConnectionInput): CoreEffectEnvelope[]
    startReconnect(input: CoreReconnectInput): CoreEffectEnvelope[]
    startProvisioning(input: CoreProvisioningInput): CoreEffectEnvelope[]
    startRecordingTransfer(input: CoreRecordingTransferInput): CoreEffectEnvelope[]
    startEncryptedUploadV2(input: CoreEncryptedUploadV2Input): CoreEffectEnvelope[]
    startFirmwareUpdate(input: CoreFirmwareUpdateInput): CoreEffectEnvelope[]
    startDeviceLogs(input: CoreDeviceLogsInput): CoreEffectEnvelope[]
    cancel(cancellationId: Uint8Array): CoreEffectEnvelope[]
    dispatch(event: CoreHostEvent): CoreEffectEnvelope[]
    status(): CoreWorkflowStatus
  }

  export interface CoreReconnectInput {
    expectedSerialNumber: string
    hint: {
      storedPeripheralId: string | null
      advertisedAddress: string | null
      storedName: string | null
      scanTimeoutMs: bigint
      connectionTimeoutMs: bigint
    }
    cancellationId: Uint8Array
  }

  export interface CoreProvisioningInput {
    serialNumber: string
    materialId: string
    cancellationId: Uint8Array
  }

  export interface CoreRecordingTransferInput {
    serialNumber: string
    recordingUuid: string
    sinkId: string
    totalUnits: bigint
    cancellationId: Uint8Array
  }

  export interface CoreEncryptedUploadV2Input {
    serialNumber: string
    recordingUuid: string
    recordingGeneration: number
    storageFormat: number
    uploadSessionId: string
    ownerRevision: number
    transportSessionId: bigint
    materialId: string
    sinkId: string
    policy: 'legacy_allowed' | 'v2_preferred' | 'v2_required'
    capabilities: EncryptedUploadV2Capabilities
    windowPackets: number
    dataPayloadBytes: number
    ciphertextLength: bigint
    ciphertextSha256: Uint8Array
    cancellationId: Uint8Array
  }

  export interface CoreFirmwareUpdateInput {
    serialNumber: string
    version: string
    sizeBytes: number
    crc32: number
    downloadId: bigint
    reconnectHint: CoreReconnectInput['hint']
    cancellationId: Uint8Array
  }

  export interface CoreDeviceLogsInput {
    serialNumber: string
    cancellationId: Uint8Array
  }
  ```

  Normalize all current `Effect` and `HostEventKind` variants needed by the included workflows. Unknown variants fail as `internal_error`; they are never silently ignored.

  Update the existing foundation `DeviceManager` to unwrap
  `CoreEffectEnvelope.effect` while retaining its current exact-connection
  behavior. This keeps the repository buildable before Task 5 moves connection
  execution into the shared runtime.

- [ ] **Step 5: Add WASM adapter tests for bigint, byte-array, error, and effect-shape fidelity**

  Tests must prove that `u64` stays `bigint`, all 16/32-byte fields keep exact bytes, malformed fixed lengths return `invalid_input`, and the adapter preserves operation/cancellation identity through start, dispatch, and cancel.

- [ ] **Step 6: Run focused Rust and Web bridge gates**

  Run:

  ```bash
  cargo test -p bota-device-sdk-wasm --test bridge_contract
  npm test --prefix frameworks/web
  cargo fmt --all -- --check
  cargo clippy -p bota-device-sdk-wasm --all-targets --all-features -- -D warnings
  ```

  Expected: all commands pass.

- [ ] **Step 7: Commit the workflow bridge**

  ```bash
  git add bindings/device-sdk-wasm frameworks/web/src/core.ts frameworks/web/src/wasmCore.ts frameworks/web/src/deviceManager.ts frameworks/web/src/__tests__/core.test.ts
  git commit -m "feat(web): expose foreground workflow bridge" \
    -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
  ```

### Task 2: Export browser-required Rust codecs and bounded integrity helpers

**Files:**
- Create: `bindings/device-sdk-wasm/src/codecs.rs`
- Modify: `bindings/device-sdk-wasm/Cargo.toml`
- Modify: `bindings/device-sdk-wasm/src/lib.rs`
- Modify: `Cargo.lock`
- Modify: `bindings/device-sdk-wasm/tests/bridge_contract.rs`
- Modify: `core/device-sdk-core/src/protocol/provisioning.rs`
- Modify: `core/device-sdk-core/src/protocol/mod.rs`
- Modify: `core/device-sdk-core/tests/fixture_decode.rs`
- Modify: `frameworks/web/src/core.ts`
- Modify: `frameworks/web/src/wasmCore.ts`
- Create: `frameworks/web/src/__tests__/codecParity.test.ts`

**Interfaces:**
- Consumes: canonical fixtures in `protocol/fixtures`, existing Rust codecs in `core/device-sdk-core/src/protocol`, and encrypted-upload-v2 vectors.
- Produces: private bridge methods for recording list/confirm, deprovision, settings, WiFi, recording control, v2 frames/status, and bounded CRC32/SHA-256 hashing.

- [ ] **Step 1: Write fixture-backed failing codec tests**

  Cover these exact exports and both valid/malformed inputs:

  ```ts
  decodeRecordingList(bytes)
  encodeRecordingListCommand()
  encodeRecordingConfirm(recordingUuid)
  encodeDeprovisionCommand()
  decodeDeprovisionResult(bytes)
  decodeConnectionSettings(bytes)
  encodeConnectionSettings(settings, model)
  encodeWiFiGrant(grant, capacity)
  encodeWiFiCredentials(ssid, password)
  encodeWiFiScanCommand()
  decodeWiFiConfigResult(bytes)
  decodeWiFiStatus(bytes)
  decodeWiFiScanUpdate(bytes)
  encodeRecordingControlCommand('start' | 'stop')
  decodeRecordingControlResult(bytes)
  decodeEncryptedUploadV2Transfer(bytes)
  encodeEncryptedUploadV2Transfer(frame)
  decodeEncryptedUploadV2Status(bytes)
  encodeEncryptedUploadV2SignedBlob(frame)
  ```

  Assert byte equality with committed fixtures rather than reconstructing expected packet bytes in TypeScript.

- [ ] **Step 2: Run focused tests and observe missing exports**

  Run:

  ```bash
  cargo test -p bota-device-sdk-wasm --test bridge_contract codecs
  npm test --prefix frameworks/web
  ```

  Expected: failures name the absent codec methods.

- [ ] **Step 3: Add a typed Rust deprovision result decoder**

  Move the native facades' duplicated status mapping into the core:

  ```rust
  #[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
  pub enum DeprovisionFailure {
      InvalidToken,
      StorageError,
      ChunkError,
      AlreadyPaired,
      Unknown(u8),
  }

  #[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
  pub struct DeprovisionResult {
      pub success: bool,
      pub error: Option<DeprovisionFailure>,
  }
  ```

  `parse_deprovision_result` accepts exactly the released status values `0..=4` and preserves an unknown byte without logging payload data.

- [ ] **Step 4: Implement narrow codec exports**

  `codecs.rs` calls existing core functions and converts typed DTOs through `serde_wasm_bindgen`. No Web manager may import generated protocol constants or assemble packets itself.

  Add a private streaming integrity object that accepts bounded chunks and exposes snapshots without retaining body bytes:

  ```rust
  #[wasm_bindgen]
  pub struct WebIntegrityHasher {
      sha256: sha2::Sha256,
      crc32: u32,
      length: u64,
  }

  #[wasm_bindgen]
  impl WebIntegrityHasher {
      #[wasm_bindgen(constructor)]
      pub fn new() -> Self;
      pub fn update(&mut self, bytes: &[u8]);
      pub fn length(&self) -> u64;
      pub fn crc32(&self) -> u32;
      #[wasm_bindgen(js_name = sha256Snapshot)]
      pub fn sha256_snapshot(&self) -> Vec<u8>;
  }
  ```

  Use the standard reflected IEEE CRC-32 polynomial and test `"123456789" == 0xcbf43926`. Reconstruct a resumed digest by streaming OPFS chunks back through a new hasher; never serialize hasher internals.

- [ ] **Step 5: Run codec, fixture, vector, and WASM build gates**

  Run:

  ```bash
  cargo test -p bota-device-sdk-core --test fixture_decode
  cargo test -p bota-device-sdk-wasm --test bridge_contract
  npm test --prefix frameworks/web
  npm run encrypted-upload-v2:vectors:check
  npm run build:wasm --prefix frameworks/web
  ```

  Expected: all fixture bytes and malformed-input errors match Rust authority.

- [ ] **Step 6: Commit the codec boundary**

  ```bash
  git add Cargo.lock core/device-sdk-core bindings/device-sdk-wasm frameworks/web/src/core.ts frameworks/web/src/wasmCore.ts frameworks/web/src/__tests__/codecParity.test.ts
  git commit -m "feat(web): expose browser protocol codecs" \
    -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
  ```

### Task 3: Extend Web Bluetooth transport and explicit browser capabilities

**Files:**
- Create: `frameworks/web/src/gatt.ts`
- Create: `frameworks/web/src/capabilities.ts`
- Modify: `frameworks/web/src/models.ts`
- Modify: `frameworks/web/src/transport.ts`
- Modify: `frameworks/web/src/webBluetoothTransport.ts`
- Modify: `frameworks/web/src/deviceManager.ts`
- Modify: `frameworks/web/src/__tests__/fakeBluetooth.ts`
- Create: `frameworks/web/src/__tests__/transport.test.ts`
- Modify: `frameworks/web/src/__tests__/deviceManager.test.ts`

**Interfaces:**
- Consumes: browser `Bluetooth`, `BluetoothDevice`, `BluetoothRemoteGATTCharacteristic`, and current exact-connection lifecycle.
- Produces: authorized-device enumeration, read/write/subscribe support, characteristic-aware notifications, deterministic teardown, and `BrowserCapabilities`.

- [ ] **Step 1: Write failing transport and capability tests**

  Prove these cases separately:

  - no `navigator.bluetooth` reports all Bluetooth-dependent capabilities false;
  - picker support without `getDevices` reports `bluetooth: true` and `authorizedDeviceReconnect: false`;
  - missing IndexedDB or OPFS independently disables durable storage, large recording sync, and firmware update;
  - picker options contain Device Information plus all Bota services used by the included managers;
  - authorized devices are returned without opening a picker;
  - write-with-response, write-without-response, notification delivery, removal, disconnect, and repeated removal are deterministic;
  - a cached characteristic is discarded on disconnect and cannot receive a late callback.

- [ ] **Step 2: Run Web tests and observe interface failures**

  Run:

  ```bash
  npm test --prefix frameworks/web
  ```

  Expected: TypeScript compilation fails on the missing transport methods and capability model.

- [ ] **Step 3: Centralize UUIDs and define the transport contract**

  `gatt.ts` is the only Web file containing UUID literals. Expand the interface to:

  ```ts
  export interface BrowserNotification {
    characteristicUuid: string
    value: Uint8Array
  }

  export interface BrowserSubscription {
    remove(): Promise<void>
  }

  export interface BrowserBluetoothTransport {
    readonly isSupported: boolean
    readonly supportsAuthorizedDevices: boolean
    readonly maximumWriteValueLength: number
    requestDevice(): Promise<BrowserDeviceHandle>
    getAuthorizedDevices(): Promise<BrowserDeviceHandle[]>
    connect(device: BrowserDeviceHandle): Promise<void>
    discoverServices(device: BrowserDeviceHandle): Promise<void>
    read(device: BrowserDeviceHandle, serviceUuid: string, characteristicUuid: string): Promise<Uint8Array>
    write(device: BrowserDeviceHandle, serviceUuid: string, characteristicUuid: string, value: Uint8Array, withResponse: boolean): Promise<void>
    subscribe(device: BrowserDeviceHandle, serviceUuid: string, characteristicUuid: string, listener: (notification: BrowserNotification) => void): Promise<BrowserSubscription>
    disconnect(device: BrowserDeviceHandle): Promise<void>
    onDisconnected(device: BrowserDeviceHandle, listener: () => void): () => void
  }
  ```

  Use a conservative protocol write ceiling of 128 bytes because Web Bluetooth does not expose negotiated ATT MTU. V2 code must still enforce the smaller of this ceiling and freshly advertised device bounds.

- [ ] **Step 4: Implement real Web Bluetooth behavior**

  Cache services/characteristics only under a connected device ID. Clone every `DataView` into a fresh `Uint8Array`. `BrowserSubscription.remove()` stops notifications, removes its exact listener, and is idempotent. Convert only known DOM states to sanitized `BrowserTransportError` codes; keep the original error as private `cause`.

- [ ] **Step 5: Add the public browser capability matrix**

  ```ts
  export interface BrowserCapabilities {
    bluetooth: boolean
    authorizedDeviceReconnect: boolean
    durableStorage: boolean
    largeRecordingSync: boolean
    firmwareUpdate: boolean
  }

  export interface BrowserStorageSupport {
    indexedDB: boolean
    opfs: boolean
  }

  export function detectBrowserCapabilities(
    transport: BrowserBluetoothTransport,
    storage: BrowserStorageSupport = detectBrowserStorageSupport(),
  ): BrowserCapabilities
  ```

  `DeviceManager.getCapabilities()` returns this immutable snapshot. Managers call `requireCapability` before acquiring operation ownership or mutating a characteristic.

- [ ] **Step 6: Run transport tests and type checking**

  Run:

  ```bash
  npm test --prefix frameworks/web
  npm run type-check --prefix frameworks/web
  ```

  Expected: all transport, teardown, and capability tests pass.

- [ ] **Step 7: Commit transport expansion**

  ```bash
  git add frameworks/web/src
  git commit -m "feat(web): add foreground bluetooth transport" \
    -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
  ```

### Task 4: Add tenant-scoped IndexedDB journals and OPFS blob storage

**Files:**
- Modify: `frameworks/web/package.json`
- Modify: `frameworks/web/package-lock.json`
- Create: `frameworks/web/src/storage.ts`
- Create: `frameworks/web/src/indexedDbWorkflowStore.ts`
- Create: `frameworks/web/src/opfsBlobStore.ts`
- Create: `frameworks/web/src/__tests__/storage.test.ts`
- Create: `frameworks/web/src/__tests__/fakeOpfs.ts`

**Interfaces:**
- Consumes: browser IndexedDB, OPFS `FileSystemDirectoryHandle`, and the integrity helper from Task 2.
- Produces: optional caller-provided `BrowserSdkStorage`, default tenant-scoped storage, bounded blob handles, verified-device hints, workflow checkpoints, recording journals, provisioning journals, and firmware journals.

- [ ] **Step 1: Add failing storage tests with fake IndexedDB and fake OPFS**

  Pin `fake-indexeddb@6.2.5` as a development dependency. Tests must prove:

  - namespace validation rejects empty, whitespace, and values over 256 characters;
  - two tenant namespaces cannot enumerate or open each other's records or blobs;
  - checkpoint acknowledgement happens only after the IndexedDB transaction completes;
  - journal phase cannot move backward;
  - OPFS append is offset-exact, `truncate` removes an unproved tail, reads are bounded, and delete is idempotent;
  - quota failure maps to `storage_quota_exceeded` without deleting an existing checkpoint;
  - `clear()` removes only the current namespace and never emits device confirmation;
  - reopening a store recovers the same checkpoint, journal, verified-device hint, and blob size.

- [ ] **Step 2: Run the storage test and observe missing modules**

  Run:

  ```bash
  npm test --prefix frameworks/web
  ```

  Expected: module resolution fails for the new storage files.

- [ ] **Step 3: Define durable records without ephemeral secrets**

  ```ts
  export type RecordingJournalPhase =
    | 'prepared'
    | 'transferring'
    | 'staged'
    | 'uploading'
    | 'cloud_completed'
    | 'confirmed'

  export interface RecordingJournal {
    schemaVersion: 1
    operationId: string
    serialNumber: string
    recordingUuid: string
    profile: 'legacy' | 'encrypted_upload_v2'
    phase: RecordingJournalPhase
    sinkId: string
    uploadId: string | null
    cloudCompletionId: string | null
    confirmationDigestHex: string | null
    updatedAtEpochMs: number
  }

  export interface FirmwareJournal {
    schemaVersion: 1
    operationId: string
    serialNumber: string
    imageId: string
    downloadId: bigint
    version: string
    sizeBytes: number
    crc32: number
    sha256Hex: string
    blobId: string
    downloadedBytes: number
    verified: boolean
    state?: 'active' | 'cleanup_only'
    updatedAtEpochMs: number
  }

  export interface VerifiedDeviceHint {
    schemaVersion: 1
    serialNumber: string
    browserDeviceId: string
    name: string | null
    updatedAtEpochMs: number
  }

  export interface ProvisioningJournal {
    schemaVersion: 1
    attemptId: string
    serialNumber: string
    phase: 'prepared' | 'device_applied' | 'backend_confirmed' | 'aborted'
    updatedAtEpochMs: number
  }
  ```

  Add records for `VerifiedDeviceHint`, opaque Rust `WorkflowCheckpointRecord`, v2 checkpoint metadata, and `ProvisioningJournal`. Reject unknown schema versions as `resume_rejected`; never guess a migration.

- [ ] **Step 4: Define the custom-storage and blob contracts**

  ```ts
  export interface BrowserBlobHandle {
    readonly id: string
    size(): Promise<number>
    truncate(size: number): Promise<void>
    write(offset: number, bytes: Uint8Array): Promise<void>
    read(offset: number, maximumLength: number): Promise<Uint8Array>
    stream(chunkSize?: number): AsyncIterable<Uint8Array>
    delete(): Promise<void>
  }

  export interface BrowserSdkStorage {
    readonly namespace: string
    loadVerifiedDevice(serialNumber: string): Promise<VerifiedDeviceHint | null>
    saveVerifiedDevice(value: VerifiedDeviceHint): Promise<void>
    deleteVerifiedDevice(serialNumber: string): Promise<void>
    loadWorkflowCheckpoint(operationId: string): Promise<unknown | null>
    saveWorkflowCheckpoint(operationId: string, checkpoint: unknown): Promise<void>
    deleteWorkflowCheckpoint(operationId: string): Promise<void>
    loadEncryptedUploadV2Checkpoint(operationId: string): Promise<unknown | null>
    saveEncryptedUploadV2Checkpoint(operationId: string, checkpoint: unknown): Promise<void>
    deleteEncryptedUploadV2Checkpoint(operationId: string): Promise<void>
    loadRecordingJournal(operationId: string): Promise<RecordingJournal | null>
    saveRecordingJournal(journal: RecordingJournal): Promise<void>
    listRecordingJournals(): Promise<RecordingJournal[]>
    deleteRecordingJournal(operationId: string): Promise<void>
    loadProvisioningJournal(attemptId: string): Promise<ProvisioningJournal | null>
    saveProvisioningJournal(journal: ProvisioningJournal): Promise<void>
    deleteProvisioningJournal(attemptId: string): Promise<void>
    loadFirmwareJournal(operationId: string): Promise<FirmwareJournal | null>
    saveFirmwareJournal(journal: FirmwareJournal): Promise<void>
    deleteFirmwareJournal(operationId: string): Promise<void>
    openBlob(blobId: string): Promise<BrowserBlobHandle>
    clear(): Promise<void>
  }
  ```

- [ ] **Step 5: Implement default IndexedDB and OPFS adapters**

  Use one versioned database with stores `verified_devices`,
  `workflow_checkpoints`, `encrypted_upload_v2_checkpoints`,
  `recording_journals`, `provisioning_journals`, and `firmware_journals`.
  Prefix every key with a collision-safe encoded namespace. OPFS uses a root
  `bota-app-sdk/v1/<sha256(namespace)>/`; no raw tenant identifier becomes a
  filename.

  Map only `QuotaExceededError` to `storage_quota_exceeded`; unavailable APIs map to `storage_unavailable`; all public messages remain fixed.

- [ ] **Step 6: Run storage, Web, and package tests**

  Run:

  ```bash
  npm test --prefix frameworks/web
  npm run type-check --prefix frameworks/web
  npm run build --prefix frameworks/web
  ```

  Expected: all persistence and reload tests pass and generated declarations contain the custom adapter contract.

- [ ] **Step 7: Commit durable browser storage**

  ```bash
  git add frameworks/web
  git commit -m "feat(web): add durable workflow storage" \
    -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
  ```

### Task 5: Introduce one browser workflow runtime and exact reconnect

**Files:**
- Create: `frameworks/web/src/workflowRuntime.ts`
- Create: `frameworks/web/src/__tests__/workflowRuntime.test.ts`
- Modify: `frameworks/web/src/deviceManager.ts`
- Modify: `frameworks/web/src/client.ts`
- Modify: `frameworks/web/src/errors.ts`
- Modify: `frameworks/web/src/models.ts`
- Modify: `frameworks/web/src/__tests__/deviceManager.test.ts`
- Modify: `frameworks/web/src/__tests__/fakeBluetooth.ts`

**Interfaces:**
- Consumes: full `CoreBridge`, transport from Task 3, storage from Task 4, and manager-specific effect hosts registered by later tasks.
- Produces: `BrowserWorkflowRuntime.run`, `cancel`, `runExclusive`, `destroy`, direct-operation ownership, effect-host registration, and `DeviceManager.reconnect`.

- [ ] **Step 1: Write failing runtime ownership and reconnect tests**

  Test exact event order for BLE scan/connect/discover/read/write/subscribe/unsubscribe, timers, persistence, progress, disconnect, cancellation, and destruction. Add race tests proving:

  - a second mutating owner fails before any GATT call;
  - an event with a foreign request or cancellation identity cannot advance the core;
  - cancellation removes subscriptions and aborts fetch/sink hosts before resolving;
  - late notifications and provider completions are ignored after terminal settlement;
  - reconnect loads one verified hint, calls `getAuthorizedDevices`, submits only that exact browser ID as a core scan result, and re-verifies `2A25`;
  - absent `getDevices` fails as `picker_required` without opening the picker;
  - an authorized same-name device with another ID or serial is never selected.

- [ ] **Step 2: Run Web tests and observe the missing runtime**

  Run:

  ```bash
  npm test --prefix frameworks/web
  ```

  Expected: imports or missing runtime methods fail.

- [ ] **Step 3: Define runtime operation and host contracts**

  ```ts
  export interface WorkflowResult {
    notifications: CoreNotification[]
  }

  export interface WorkflowEffectContext {
    operationId: string
    cancellationId: Uint8Array
    signal: AbortSignal
    dispatch(event: CoreHostEvent): Promise<void>
    addCleanup(cleanup: () => Promise<void>): void
  }

  export interface WorkflowEffectHost {
    execute(
      effect: CoreEffectEnvelope,
      context: WorkflowEffectContext,
    ): Promise<CoreHostEvent | readonly CoreHostEvent[] | null>
    cancel(): Promise<void>
  }

  export interface WorkflowObserver {
    onNotification?(notification: CoreNotification): void
    onProgress?(completedUnits: bigint, totalUnits: bigint): void
  }

  export interface WorkflowEffectHosts {
    persistence: WorkflowEffectHost
    recordingSink?: WorkflowEffectHost
    network?: WorkflowEffectHost
    firmwareBlob?: WorkflowEffectHost
    hostMaterial?: WorkflowEffectHost
    encryptedUploadV2?: WorkflowEffectHost
  }

  export class BrowserWorkflowRuntime {
    run(
      operationId: string,
      cancellationId: Uint8Array,
      start: () => CoreEffectEnvelope[],
      hosts: WorkflowEffectHosts,
      observer?: WorkflowObserver,
    ): Promise<WorkflowResult>
    cancel(operationId: string): Promise<void>
    runExclusive<T>(operation: BotaOperation, body: (signal: AbortSignal) => Promise<T>): Promise<T>
    destroy(): Promise<void>
  }
  ```

  One internal promise tail serializes core dispatch. The operation registry stores the exact request/cancellation owner, timers, subscriptions, abort controller, and cleanup callbacks.

- [ ] **Step 4: Implement all common effects once**

  Map `Ble.StartScan` to authorized-device enumeration only; dispatch each permitted handle as a candidate and then `ScanStopped`. Map transport callbacks to the request ID that created the subscription. Await durable persistence before dispatching `CheckpointSaved`. Fire-and-forget effects still complete their browser side before the queue advances.

  `runExclusive` shares the same mutating owner as Rust workflows, so codec-backed managers cannot interleave writes with transfer, provisioning, or OTA.

- [ ] **Step 5: Refactor connection through the runtime and add reconnect**

  `connect()` still opens the picker first, registers the selected handle, then starts `startExactConnection`. On verified completion it persists `{serialNumber, browserDeviceId, name}` only when durable storage is configured. `reconnect()` starts the Rust reconnect workflow with the stored exact browser ID and dispatches only authorized handles returned by `getDevices()`.

- [ ] **Step 6: Expand stable browser errors**

  Add the approved codes and operations:

  ```ts
  type BotaSDKErrorCode =
    | 'unsupported_browser'
    | 'invalid_input'
    | 'picker_cancelled'
    | 'bluetooth_unavailable'
    | 'permission_denied'
    | 'operation_in_progress'
    | 'connection_failed'
    | 'identity_mismatch'
    | 'device_disconnected'
    | 'protocol_error'
    | 'cancelled'
    | 'internal_error'
    | 'unsupported_capability'
    | 'picker_required'
    | 'storage_unavailable'
    | 'storage_quota_exceeded'
    | 'authorization_expired'
    | 'resume_rejected'
    | 'integrity_failed'
    | 'upload_failed'
    | 'firmware_rejected'

  type BotaOperation =
    | 'initialize'
    | 'connect'
    | 'reconnect'
    | 'disconnect'
    | 'read_snapshot'
    | 'provision'
    | 'deprovision'
    | 'settings'
    | 'wifi'
    | 'recording_control'
    | 'transfer_recording'
    | 'upload'
    | 'update_firmware'
    | 'read_device_logs'
    | 'unknown'
  ```

  Map core operation names to `reconnect`, `provision`, `transfer_recording`, `upload`, `update_firmware`, and `read_device_logs`. Public error context may contain operation IDs, serials, recording UUIDs, or image IDs, but never URLs, headers, credentials, grants, receipts, or packet bodies.

- [ ] **Step 7: Run runtime, connection, and lifecycle gates**

  Run:

  ```bash
  npm test --prefix frameworks/web
  npm run type-check --prefix frameworks/web
  npm run build --prefix frameworks/web
  ```

  Expected: every ownership, reconnect, cancellation, and late-event test passes.

- [ ] **Step 8: Commit the shared runtime**

  ```bash
  git add frameworks/web/src
  git commit -m "feat(web): add browser workflow runtime" \
    -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
  ```

### Task 6: Implement recording list and cloud-gated legacy synchronization

**Files:**
- Create: `frameworks/web/src/providers.ts`
- Create: `frameworks/web/src/recordingManager.ts`
- Create: `frameworks/web/src/__tests__/recordingManager.test.ts`
- Create: `frameworks/web/src/__tests__/fakeProviders.ts`
- Modify: `frameworks/web/src/models.ts`
- Modify: `frameworks/web/src/client.ts`
- Modify: `frameworks/web/src/index.ts`

**Interfaces:**
- Consumes: codec methods from Task 2, runtime from Task 5, OPFS sink, and a host-owned recording upload provider.
- Produces: `recordings.list`, legacy `sync`, `resume`, `cancel`, recovery-only `confirm`, and `listPendingOperations`.

- [ ] **Step 1: Write failing list, legacy sync, and recovery tests**

  Cover exact ordering and failure behavior:

  - list subscribes before writing LIST, decodes one completed list, and always unsubscribes;
  - sync persists `prepared` before START and passes `confirmOnCompletion: false` to Rust;
  - sink append is durably flushed before `RecordingSinkAppendCompleted` reaches Rust;
  - CRC mismatch NACKs and never asks the provider for an upload destination;
  - upload starts only after Rust reports a finalized staged body;
  - cloud completion is persisted before CONFIRM is written;
  - upload ambiguity calls provider reconciliation before a retry;
  - `confirm(operationId)` rejects `prepared`, `transferring`, `staged`, and `uploading` journals;
  - reconnect/reload resumes from the exact stored phase;
  - a legacy profile without device resume support explicitly truncates to zero and restarts;
  - cancellation during transfer sends Rust cancellation and cleans only unverified local state;
  - quota, disconnect, upload, and provider failures preserve the device recording.

- [ ] **Step 2: Run Web tests and observe the missing manager**

  Run:

  ```bash
  npm test --prefix frameworks/web
  ```

  Expected: imports fail for `RecordingManager` and recording provider types.

- [ ] **Step 3: Define exact upload-provider and source contracts**

  ```ts
  export interface UploadRequestTemplate {
    method: 'PUT'
    url: string
    headers: Readonly<Record<string, string>>
  }

  export interface LegacyUploadContext {
    operationId: string
    serialNumber: string
    recording: DeviceRecording
    sizeBytes: bigint
    sha256Hex: string | null
    encrypted: boolean
  }

  export interface RecordingUploadProvider {
    prepareLegacyUpload(context: LegacyUploadContext): Promise<{
      uploadId: string
      request: UploadRequestTemplate
    }>
    completeLegacyUpload(context: LegacyUploadContext & { uploadId: string }): Promise<{
      cloudCompletionId: string
    }>
    reconcileLegacyUpload(context: LegacyUploadContext & { uploadId: string }): Promise<
      | { state: 'not_uploaded' }
      | { state: 'cloud_completed'; cloudCompletionId: string }
    >
    prepareEncryptedUploadV2(context: EncryptedUploadV2ProviderContext): Promise<EncryptedUploadV2Material>
  }
  ```

  The provider implementation makes backend calls. The SDK's network host uses `fetch` only against the returned operation-scoped request template and never persists it.

- [ ] **Step 4: Expose the recording models and API**

  ```ts
  export interface DeviceRecording {
    uuid: string
    startedAtTimestampSeconds: number
    durationMilliseconds: bigint
    fileSizeBytes: bigint
    codec: 'pcm_16k' | 'pcm_8k' | 'opus_16k' | 'opus_8k' | 'unknown'
    codecRaw?: number
    encrypted: boolean
    encryptedUploadV2: {
      generation: number
      storageFormat: number
      plaintextLength: bigint
      ciphertextLength: bigint
      ciphertextSha256: Uint8Array
    } | null
  }

  export interface RecordingSyncProgress {
    phase: RecordingJournalPhase
    completedBytes: bigint
    totalBytes: bigint
  }

  export interface RecordingSyncResult {
    operationId: string
    recordingUuid: string
    profile: 'legacy' | 'encrypted_upload_v2'
    cloudCompletionId: string
  }

  export interface RecordingSyncOptions {
    profile: 'legacy' | 'encrypted_upload_v2'
    operationId?: string
    signal?: AbortSignal
    onProgress?: (progress: RecordingSyncProgress) => void
  }

  export class RecordingManager {
    list(): Promise<DeviceRecording[]>
    sync(recording: DeviceRecording, options: RecordingSyncOptions): Promise<RecordingSyncResult>
    resume(operationId: string, options?: Pick<RecordingSyncOptions, 'signal' | 'onProgress'>): Promise<RecordingSyncResult>
    cancel(operationId: string): Promise<void>
    confirm(operationId: string): Promise<void>
    listPendingOperations(): Promise<RecordingJournalSummary[]>
  }
  ```

  Reject any size or offset above `Number.MAX_SAFE_INTEGER` before passing it
  to OPFS, because browser file APIs use JavaScript numbers even though the
  Rust bridge preserves protocol `u64` values as `bigint`.

  `profile` is explicit. Once v2 is selected, no failure path retries legacy. The v2 branch is implemented in Task 7.

- [ ] **Step 5: Implement list and the legacy journal state machine**

  Use the runtime's direct-operation owner for LIST and CONFIRM. Use the Rust transfer workflow with `confirm_on_completion: false` for body transfer. Stream the OPFS body to Fetch using `ReadableStream`; set `duplex: 'half'` only where the browser requires it and feature-test without exposing it in the public API.

  The only legal phase transitions are:

  ```text
  prepared -> transferring -> staged -> uploading -> cloud_completed -> confirmed
                                       -> staged (provider proves not uploaded)
                           uploading -> cloud_completed (provider proves complete)
  ```

  Persist each transition before performing the next external side effect. After `confirmed`, delete the body first and journal last; a crash between them leaves an idempotently recoverable confirmed journal.

- [ ] **Step 6: Run recording and full Web gates**

  Run:

  ```bash
  npm test --prefix frameworks/web
  npm run type-check --prefix frameworks/web
  npm run build --prefix frameworks/web
  ```

  Expected: list, transfer, upload ambiguity, confirm ordering, and reload recovery tests pass.

- [ ] **Step 7: Commit legacy recording synchronization**

  ```bash
  git add frameworks/web/src
  git commit -m "feat(web): add durable recording sync" \
    -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
  ```

### Task 7: Implement the browser Encrypted Upload v2 host and explicit v2 sync

**Files:**
- Create: `frameworks/web/src/encryptedUploadV2Host.ts`
- Create: `frameworks/web/src/__tests__/encryptedUploadV2Host.test.ts`
- Create: `frameworks/web/src/__tests__/encryptedUploadV2Recording.test.ts`
- Modify: `frameworks/web/src/providers.ts`
- Modify: `frameworks/web/src/recordingManager.ts`
- Modify: `frameworks/web/src/models.ts`
- Modify: `frameworks/web/src/workflowRuntime.ts`

**Interfaces:**
- Consumes: canonical v2 Rust codecs, `EncryptedUploadV2` core effects/events, fresh `0406` capability bytes, OPFS sink, and `RecordingUploadProvider.prepareEncryptedUploadV2`.
- Produces: bounded signed-document writes, exact START/RESUME ownership, window repair/checkpoint acknowledgement, ciphertext staging, manifest/finalization callbacks, receipt-bound CONFIRM, and fail-closed abort.

- [ ] **Step 1: Write failing v2 host tests from canonical vectors**

  Port behavior, not implementation, from the Apple/Android v2 host tests. Cover:

  - fresh `0406` is read for every v2 start and its raw SHA-256 is included in provider context;
  - v2 LIST subscribes before its Rust-encoded request, accepts only entries
    with the exact transport session, verifies count/list revision/list digest,
    and exposes generation plus ciphertext evidence on `DeviceRecording`;
  - device bounds are intersected with the transport's 128-byte ceiling;
  - authorization BEGIN/CHUNK/COMMIT waits for the exact kind/write ID result;
  - subscription starts before signed-document BEGIN and before START/RESUME;
  - foreign transport session, recording UUID/generation, upload session, owner revision, or digest fails closed;
  - DATA writes by exact offset, duplicate bytes are ignored only when identical, and gaps are repaired;
  - WINDOW_ACK is impossible before OPFS flush plus durable checkpoint save;
  - resume truncates an unproved tail and verifies the prefix digest before requesting more data;
  - the manifest is bounded to 580 bytes and EOF evidence matches expected ciphertext length/hash;
  - staging uploads ciphertext, submits the exact manifest, finalizes backend state, accepts only the exact receipt digest, then writes CONFIRM;
  - cancellation before/after provider, START, staging, receipt, and CONFIRM has the native fail-closed terminal behavior;
  - no v2 failure invokes legacy sync.

- [ ] **Step 2: Run v2 Web tests and observe missing host classes**

  Run:

  ```bash
  npm test --prefix frameworks/web
  ```

  Expected: imports fail for the browser v2 host.

- [ ] **Step 3: Define memory-only v2 material**

  ```ts
  export interface EncryptedUploadV2Recording {
    uuid: string
    generation: number
    storageFormat: number
    ciphertextLength: bigint
    ciphertextSha256: Uint8Array
  }

  export interface EncryptedUploadV2CheckpointSummary {
    uploadSessionId: string
    ownerRevision: number
    checkpointRevision: number
    nextCiphertextOffset: bigint
    prefixSha256: Uint8Array
    transportSessionId: bigint
    sinkId: string
    windowPackets: number
    dataPayloadBytes: number
  }

  export interface EncryptedUploadV2ProviderContext {
    operationId: string
    serialNumber: string
    recording: EncryptedUploadV2Recording
    capability: {
      rawValue: Uint8Array
      sha256: Uint8Array
      decoded: EncryptedUploadV2Capabilities
    }
    checkpoint: EncryptedUploadV2CheckpointSummary | null
  }

  export interface EncryptedUploadV2Evidence {
    ciphertextLength: bigint
    ciphertextSha256: Uint8Array
    manifestLength: number
    manifestSha256: Uint8Array
    blockCount: number
  }

  export interface EncryptedUploadV2Material {
    materialId: string
    recordingId: string
    uploadSessionId: string
    ownerRevision: number
    policy: 'legacy_allowed' | 'v2_preferred' | 'v2_required'
    authorization: Uint8Array
    stagingRequest(evidence: EncryptedUploadV2Evidence): Promise<UploadRequestTemplate>
    submitManifest(manifest: Uint8Array, evidence: EncryptedUploadV2Evidence): Promise<void>
    finalize(evidence: EncryptedUploadV2Evidence): Promise<void>
    completionReceipt(evidence: EncryptedUploadV2Evidence): Promise<Uint8Array>
    cancel(): Promise<void>
  }
  ```

  The runtime stores only `materialId`, session IDs, revisions, negotiated bounds, non-secret checkpoint hashes, and sink IDs. It removes and zero-fills authorization/receipt arrays on every terminal path where JavaScript permits.

- [ ] **Step 4: Implement four focused internal owners**

  `EncryptedUploadV2SignedBlobWriter` owns `0407`; `EncryptedUploadV2TransferControl` owns `0408/0409`; `EncryptedUploadV2TransferReceiver` owns OPFS window staging; `EncryptedUploadV2Host` maps core host effects to those owners and provider callbacks.

  Every outbound frame comes from Rust codec methods. Keep the combined queued ciphertext metadata below 1 MiB. `remove()`/abort uncertainty poisons the active BLE session until explicit disconnect so another operation cannot inherit unknown ownership.

  The transfer-control owner also implements the v2 recording LIST exchange.
  `RecordingManager.list()` reads fresh `0406`; when v2 is advertised it uses
  that exchange and returns exact v2 metadata, otherwise it uses the released
  legacy LIST path. It never merges same-name or first-four-byte identities
  across the two profiles.

- [ ] **Step 5: Connect v2 core effects to the generic runtime**

  Map all twelve `EncryptedUploadV2HostEffect` variants and exact corresponding host events. The runtime must durably save a checkpoint before dispatching `CheckpointSaved`, and `AcknowledgeWindow` may run only against the same checkpoint revision just saved.

- [ ] **Step 6: Add explicit v2 selection to `RecordingManager.sync`**

  Require `options.profile === 'encrypted_upload_v2'`, a freshly decoded capability snapshot, and provider material validated against the same recording/session. Reuse a checkpoint only when session, owner revision, sink ID, transport session, negotiated bounds, and recording generation all match. Reject mismatches as `integrity_failed`; never delete the device recording or retry legacy.

  Drive the same durable recording journal through `prepared`, `transferring`,
  `staged`, `uploading`, `cloud_completed`, and `confirmed` from the matching
  Rust host effects. Persist only the accepted receipt SHA-256, never the raw
  receipt. Recovery after `cloud_completed` calls
  `prepareEncryptedUploadV2` again for the same operation/session so the host
  can return the exact receipt in memory; `confirm(operationId)` then resumes
  the v2 workflow and rejects a different receipt digest.

- [ ] **Step 7: Run v2, Rust vector, and Web gates**

  Run:

  ```bash
  npm run encrypted-upload-v2:vectors:check
  cargo test -p bota-device-sdk-core encrypted_upload_v2
  cargo test -p bota-device-sdk-wasm --test bridge_contract
  npm test --prefix frameworks/web
  npm run type-check --prefix frameworks/web
  ```

  Expected: canonical-vector, repair, resume, receipt, cancellation, and no-fallback tests pass.

- [ ] **Step 8: Commit Encrypted Upload v2**

  ```bash
  git add frameworks/web/src
  git commit -m "feat(web): add encrypted upload v2 sync" \
    -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
  ```

### Task 8: Implement provisioning, backend close-loop, deprovision, and settings

**Files:**
- Create: `frameworks/web/src/provisioningManager.ts`
- Create: `frameworks/web/src/__tests__/provisioningManager.test.ts`
- Modify: `frameworks/web/src/providers.ts`
- Modify: `frameworks/web/src/models.ts`
- Modify: `frameworks/web/src/client.ts`
- Modify: `frameworks/web/src/index.ts`

**Interfaces:**
- Consumes: Rust provisioning workflow, host provisioning provider, durable provisioning journal, deprovision/settings codecs, and runtime direct-operation ownership.
- Produces: `provision`, idempotent backend confirmation recovery, non-destructive `deprovision`, `readConnectionSettings`, and `writeConnectionSettings`.

- [ ] **Step 1: Write failing provisioning and settings tests**

  Cover:

  - provider receives exact serial, nonce, public key, and caller attempt ID;
  - no raw token/API endpoint is persisted or logged;
  - backend prepare does not mark bind complete;
  - physical workflow failure invokes provider abort and leaves backend unbound;
  - physical success persists `device_applied` before provider confirm;
  - provider confirm failure is retryable and a second call with the same attempt confirms without rewriting the device;
  - deprovision writes the grant, subscribes result, then writes opcode `0x05` through the Rust codec and never reports factory reset;
  - deprovision timeout always unsubscribes;
  - settings read uses Rust defaults for unsupported versions;
  - settings write normalizes Note cellular fields through Rust and serializes with the canonical v2 heartbeat mask;
  - provider cancellation or client destruction scrubs material and rejects late callbacks.

- [ ] **Step 2: Run tests and observe the missing manager**

  Run:

  ```bash
  npm test --prefix frameworks/web
  ```

  Expected: imports fail for `ProvisioningManager` and provider types.

- [ ] **Step 3: Define the provider close-loop**

  ```ts
  export interface ProvisioningProvider {
    prepare(context: {
      attemptId: string
      serialNumber: string
      nonce: Uint8Array
      devicePublicKey: Uint8Array
    }): Promise<{
      materialId: string
      apiEndpoint: Uint8Array
      deviceToken: Uint8Array
      mtu: number
    }>
    confirm(context: { attemptId: string; serialNumber: string }): Promise<void>
    abort(context: { attemptId: string; serialNumber: string; reason: BotaSDKErrorCode }): Promise<void>
  }

  export interface ProvisionRequest {
    attemptId: string
    signal?: AbortSignal
  }

  export interface DeprovisionRequest {
    grant: Uint8Array
    signal?: AbortSignal
  }

  export class ProvisioningManager {
    provision(request: ProvisionRequest): Promise<void>
    deprovision(request: DeprovisionRequest): Promise<DeprovisionResult>
    readConnectionSettings(): Promise<DeviceConnectionSettings>
    writeConnectionSettings(settings: DeviceConnectionSettings): Promise<void>
  }
  ```

  `ProvisioningJournal` stores only attempt ID, serial, and phase `prepared | device_applied | backend_confirmed | aborted`.

- [ ] **Step 4: Implement provisioning and confirmation recovery**

  Start Rust `Provision` with an operation-scoped material ID. Map `PrepareProvisioning` to the provider and dispatch the exact bytes once. After Rust completes, persist `device_applied`, call provider `confirm`, then persist `backend_confirmed`. When the same attempt resumes from `device_applied`, call only `confirm`.

  Abort only before physical completion. A failed backend confirmation after `device_applied` must never send deprovision or claim the device stayed unbound.

- [ ] **Step 5: Implement direct deprovision and settings operations**

  Run both under `runtime.runExclusive`. Subscribe before the deprovision opcode and bound the result wait to 30 seconds. For settings, re-read the connected identity/model, call only Rust decoder/encoder methods, and send one write-with-response to the settings characteristic.

- [ ] **Step 6: Run provisioning and Web gates**

  Run:

  ```bash
  npm test --prefix frameworks/web
  npm run type-check --prefix frameworks/web
  npm run build --prefix frameworks/web
  ```

  Expected: prepare/device/confirm/abort, deprovision cleanup, and settings parity tests pass.

- [ ] **Step 7: Commit provisioning and settings**

  ```bash
  git add frameworks/web/src
  git commit -m "feat(web): add provisioning and settings" \
    -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
  ```

### Task 9: Implement WiFi management and grant-bound recording control

**Files:**
- Create: `frameworks/web/src/wifiManager.ts`
- Create: `frameworks/web/src/controlManager.ts`
- Create: `frameworks/web/src/__tests__/wifiManager.test.ts`
- Create: `frameworks/web/src/__tests__/controlManager.test.ts`
- Modify: `frameworks/web/src/providers.ts`
- Modify: `frameworks/web/src/models.ts`
- Modify: `frameworks/web/src/client.ts`
- Modify: `frameworks/web/src/index.ts`

**Interfaces:**
- Consumes: Rust WiFi/control codecs, runtime direct-operation ownership, and host recording-control authority provider.
- Produces: WiFi scan/configure/disconnect/status/status subscription and recording start/stop.

- [ ] **Step 1: Write failing WiFi and control sequence tests**

  Prove:

  - scan subscribes before writing START, ignores pending notifications, returns only Rust-decoded DONE, and times out after 30 seconds;
  - configure writes the opaque grant, subscribes status, then writes Rust-encoded credentials;
  - disconnect writes only the Rust-encoded empty credentials and no password;
  - status subscription has one exact lease and removes it on listener failure, disconnect, destroy, and explicit removal;
  - malformed SSID/password and NUL bytes fail before any write;
  - start/stop asks the authority provider for the exact action and serial, writes grant, subscribes result, then writes Rust command;
  - stop retains the released 50 ms grant/subscribe sequencing delay;
  - authority expiration maps to `authorization_expired` and never retries or widens the grant;
  - a WiFi write and a recording-control write cannot overlap another mutating owner.

- [ ] **Step 2: Run tests and observe missing managers**

  Run:

  ```bash
  npm test --prefix frameworks/web
  ```

  Expected: imports fail for `WiFiManager` and `ControlManager`.

- [ ] **Step 3: Define recording-control authority**

  ```ts
  export interface RecordingControlProvider {
    prepare(context: {
      operationId: string
      serialNumber: string
      action: 'start' | 'stop'
      authorityId: string
    }): Promise<{ grant: Uint8Array }>
  }

  export interface RecordingControlRequest {
    authorityId: string
    operationId?: string
    signal?: AbortSignal
  }

  export interface WiFiCredentials {
    ssid: string
    password: string
  }

  export interface WiFiStatusSubscription {
    remove(): Promise<void>
  }

  export class WiFiManager {
    scanNetworks(): Promise<WiFiScanResult>
    configure(credentials: WiFiCredentials, grant: string): Promise<WiFiConfigResult>
    disconnect(): Promise<WiFiConfigResult>
    readStatus(): Promise<WiFiStatusInfo>
    subscribeToStatus(listener: (status: WiFiStatusInfo) => void): Promise<WiFiStatusSubscription>
  }

  export class ControlManager {
    startRecording(request: RecordingControlRequest): Promise<RecordingControlResult>
    stopRecording(request: RecordingControlRequest): Promise<RecordingControlResult>
  }
  ```

  The grant is consumed by one operation, zero-filled at terminal cleanup, and never persisted.

- [ ] **Step 4: Implement WiFi operations with Rust codecs only**

  Use one shared `withSubscription` helper that subscribes, runs the body, and removes the exact lease in `finally`. `subscribeToStatus(listener)` is passive, but the runtime rejects it when another owner already owns the same WiFi status characteristic.

- [ ] **Step 5: Implement recording start/stop control**

  Use write-with-response for grant and control. Decode one control result; return the typed success/error result and remove the subscription. Keep direct state read/stream outside the public surface because the approved API contains start/stop only.

- [ ] **Step 6: Run WiFi/control and full Web gates**

  Run:

  ```bash
  npm test --prefix frameworks/web
  npm run type-check --prefix frameworks/web
  npm run build --prefix frameworks/web
  ```

  Expected: all sequencing, timeout, redaction, authority, and ownership tests pass.

- [ ] **Step 7: Commit WiFi and control support**

  ```bash
  git add frameworks/web/src
  git commit -m "feat(web): add wifi and recording control" \
    -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
  ```

### Task 10: Implement durable foreground firmware update and reload recovery

**Files:**
- Create: `frameworks/web/src/otaManager.ts`
- Create: `frameworks/web/src/__tests__/otaManager.test.ts`
- Modify: `frameworks/web/src/providers.ts`
- Modify: `frameworks/web/src/models.ts`
- Modify: `frameworks/web/src/workflowRuntime.ts`
- Modify: `frameworks/web/src/client.ts`
- Modify: `frameworks/web/src/index.ts`

**Interfaces:**
- Consumes: Rust firmware workflow, fresh host download request, OPFS firmware blob, integrity helper, explicit authorized-device reconnect, and durable firmware/workflow journals.
- Produces: `updateFirmware`, `resumeFirmwareUpdate`, `cancelFirmwareUpdate`, monotonic progress, exact integrity validation, reboot reconnect, and recoverable checkpoints.

- [ ] **Step 1: Write failing download, transfer, reconnect, and resume tests**

  Cover:

  - `firmwareUpdate` capability is checked before provider or device mutation;
  - provider resolves the stable image ID to a fresh HTTPS request and the request is never persisted;
  - response status, exact content length, expected SHA-256, and expected CRC32 are validated before the first device write;
  - download streams bounded chunks into OPFS and reports monotonic download progress;
  - a verified existing blob avoids a second download after reload;
  - an incomplete download obtains a fresh request for the same image ID and restarts safely at byte zero unless HTTP range plus exact validator support is proven;
  - Rust receives `DownloadCompleted` only after integrity validation and reads firmware chunks from OPFS in requested bounds;
  - device rejection maps to `firmware_rejected`, CRC mismatch maps to `integrity_failed`, and neither begins reboot reconnect;
  - disconnect after verify enters Rust reconnect and uses only the previously authorized exact browser device;
  - cancellation aborts fetch, stops subscriptions/timers, preserves a compatible verified blob, and rejects late progress;
  - incompatible image ID/version/size/hash/checkpoint combinations fail as `resume_rejected` before GATT writes.

- [ ] **Step 2: Run tests and observe the missing OTA manager**

  Run:

  ```bash
  npm test --prefix frameworks/web
  ```

  Expected: imports fail for `OTAManager` and firmware provider models.

- [ ] **Step 3: Define stable image and ephemeral download contracts**

  ```ts
  export interface FirmwareImageDescriptor {
    imageId: string
    version: string
    sizeBytes: number
    crc32: number
    sha256Hex: string
  }

  export interface FirmwareDownloadProvider {
    resolve(context: {
      operationId: string
      serialNumber: string
      image: FirmwareImageDescriptor
    }): Promise<{
      method: 'GET'
      url: string
      headers: Readonly<Record<string, string>>
    }>
  }

  export interface FirmwareUpdateOptions {
    operationId?: string
    signal?: AbortSignal
    onProgress?: (progress: FirmwareUpdateProgress) => void
  }

  export interface FirmwareUpdateProgress {
    phase:
      | 'downloading'
      | 'awaiting_device'
      | 'transferring'
      | 'verifying'
      | 'rebooting'
      | 'reconnecting'
      | 'complete'
    completedBytes: bigint
    totalBytes: bigint
  }
  ```

  Reject non-HTTPS URLs except loopback URLs used by deterministic tests. Redact URL and headers from all public errors.

- [ ] **Step 4: Implement the durable network and firmware-blob hosts**

  The network host writes the response stream directly to OPFS while updating bounded CRC32/SHA-256 state. It compares expected size, CRC32, and SHA-256 before flushing `verified: true` and dispatching `Network.DownloadCompleted` with the actual CRC32.

  The firmware-blob host answers `ReadChunk {offset,maxLength}` by one bounded OPFS read and dispatches the exact `downloadId`, offset, and bytes. A read beyond verified size fails closed.

- [ ] **Step 5: Implement OTA manager lifecycle and recovery**

  ```ts
  export class OTAManager {
    updateFirmware(image: FirmwareImageDescriptor, options?: FirmwareUpdateOptions): Promise<void>
    resumeFirmwareUpdate(operationId: string, options?: Pick<FirmwareUpdateOptions, 'signal' | 'onProgress'>): Promise<void>
    cancelFirmwareUpdate(operationId: string): Promise<void>
  }
  ```

  Persist the firmware journal before provider resolution. Start Rust with the journal's stable download ID and verified reconnect hint. On success, persist one-way `cleanup_only` before deleting checkpoint, blob, then journal, so every crash boundary resumes as cleanup only. On retryable failure retain only compatible durable state; on integrity failure delete the untrusted blob but preserve the journal's safe identity metadata.

- [ ] **Step 6: Run OTA and Web gates**

  Run:

  ```bash
  npm test --prefix frameworks/web
  npm run type-check --prefix frameworks/web
  npm run build --prefix frameworks/web
  ```

  Expected: download, integrity, chunking, device rejection, reboot reconnect, cancellation, and reload recovery tests pass.

- [ ] **Step 7: Commit OTA support**

  ```bash
  git add frameworks/web/src
  git commit -m "feat(web): add recoverable firmware update" \
    -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
  ```

### Task 11: Implement sanitized single-owner device logs

**Files:**
- Create: `frameworks/web/src/logManager.ts`
- Create: `frameworks/web/src/__tests__/logManager.test.ts`
- Modify: `frameworks/web/src/models.ts`
- Modify: `frameworks/web/src/client.ts`
- Modify: `frameworks/web/src/index.ts`

**Interfaces:**
- Consumes: Rust `ReadDeviceLogs` workflow and shared runtime.
- Produces: `logs.subscribe(listener)` returning one idempotent async removal handle.

- [ ] **Step 1: Write failing log ownership and sanitization tests**

  Prove:

  - one subscription starts the Rust workflow and subscribes once;
  - decoded `{message,isBacklog}` values come only from Rust notifications;
  - malformed raw packets fail without exposing bytes or decoder detail;
  - a second log owner fails with `operation_in_progress`;
  - listener exceptions remove the subscription and cancel the exact workflow;
  - explicit removal, BLE disconnect, client destruction, and repeated removal each leave no listener or characteristic lease;
  - notifications arriving after removal are ignored.

- [ ] **Step 2: Run tests and observe the missing log manager**

  Run:

  ```bash
  npm test --prefix frameworks/web
  ```

  Expected: imports fail for `LogManager`.

- [ ] **Step 3: Implement the public subscription contract**

  ```ts
  export interface DeviceLogLine {
    message: string
    isBacklog: boolean
  }

  export interface DeviceLogSubscription {
    remove(): Promise<void>
  }

  export class LogManager {
    subscribe(listener: (line: DeviceLogLine) => void): Promise<DeviceLogSubscription>
  }
  ```

  Map only `WorkflowNotification::DeviceLog` to listeners. Completion without explicit cancellation is an unexpected, retryable stream end. All cleanup runs through the shared runtime and is idempotent.

- [ ] **Step 4: Run log and full Web gates**

  Run:

  ```bash
  npm test --prefix frameworks/web
  npm run type-check --prefix frameworks/web
  npm run build --prefix frameworks/web
  ```

  Expected: sanitization, exclusivity, cancellation, and teardown tests pass.

- [ ] **Step 5: Commit device logs**

  ```bash
  git add frameworks/web/src
  git commit -m "feat(web): add device log subscription" \
    -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
  ```

### Task 12: Compose the public client and enforce lifecycle cleanup

**Files:**
- Modify: `frameworks/web/src/client.ts`
- Modify: `frameworks/web/src/deviceManager.ts`
- Modify: `frameworks/web/src/index.ts`
- Modify: `frameworks/web/src/models.ts`
- Modify: `frameworks/web/src/errors.ts`
- Create: `frameworks/web/src/__tests__/client.test.ts`
- Modify: `frameworks/web/src/__tests__/snapshot.test.ts`

**Interfaces:**
- Consumes: every manager, transport, runtime, storage adapter, and provider contract from Tasks 3-11.
- Produces: the approved `BotaDeviceClient` construction, manager graph, `clearPersistedData`, and terminal `destroy` behavior.

- [ ] **Step 1: Write failing client composition tests**

  Cover:

  - read-only creation works without `storageNamespace` or providers;
  - durable managers fail before mutation when namespace/storage/provider is absent;
  - caller-provided storage replaces the default and must match the requested namespace;
  - each client owns one manager instance and one operation coordinator;
  - `destroy()` rejects new operations, cancels active workflow/direct owners, removes passive subscriptions, disconnects, and is idempotent;
  - `clearPersistedData()` requires no active operation, delegates only to the current tenant store, and sends no BLE command;
  - logout ordering `destroy()` then `clearPersistedData()` is safe and repeatable;
  - snapshot and every sensitive manager re-verify the active serial after reconnect.

- [ ] **Step 2: Run tests and observe missing client options/managers**

  Run:

  ```bash
  npm test --prefix frameworks/web
  ```

  Expected: type and behavior failures identify unwired options and managers.

- [ ] **Step 3: Implement the final public client shape**

  ```ts
  export interface BotaDeviceClientOptions {
    storageNamespace?: string
    storage?: BrowserSdkStorage
    providers?: {
      provisioning?: ProvisioningProvider
      recordingUpload?: RecordingUploadProvider
      recordingControl?: RecordingControlProvider
      firmwareDownload?: FirmwareDownloadProvider
    }
    coreLoader?: CoreLoader
    transport?: BrowserBluetoothTransport
  }

  export class BotaDeviceClient {
    readonly devices: DeviceManager
    readonly recordings: RecordingManager
    readonly provisioning: ProvisioningManager
    readonly wifi: WiFiManager
    readonly controls: ControlManager
    readonly ota: OTAManager
    readonly logs: LogManager
    static create(options?: BotaDeviceClientOptions): Promise<BotaDeviceClient>
    clearPersistedData(): Promise<void>
    destroy(): Promise<void>
  }
  ```

  Export public models/providers/errors/managers from `index.ts`; keep WASM, runtime, GATT constants, journals, and raw bridge DTOs private.

- [ ] **Step 4: Run public surface and declaration checks**

  Run:

  ```bash
  npm test --prefix frameworks/web
  npm run type-check --prefix frameworks/web
  npm run build --prefix frameworks/web
  npm pack --prefix frameworks/web --dry-run
  ```

  Expected: all tests pass; the declaration surface contains only the intended browser API and the package inventory contains no source/tests/secrets.

- [ ] **Step 5: Commit client composition**

  ```bash
  git add frameworks/web/src
  git commit -m "feat(web): compose foreground sdk managers" \
    -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
  ```

### Task 13: Add real Chromium, packed-consumer, and package-release gates

**Files:**
- Modify: `frameworks/web/package.json`
- Modify: `frameworks/web/package-lock.json`
- Modify: `tools/web/test-consumer.sh`
- Modify: `tools/web/verify-package.mjs`
- Modify: `tools/web/verify-package.test.mjs`
- Create: `tools/web/test-browser.sh`
- Create: `tests/consumers/web-vite/e2e/foreground.spec.ts`
- Create: `tests/consumers/web-vite/playwright.config.ts`
- Modify: `tests/consumers/web-vite/package.json`
- Modify: `tests/consumers/web-vite/package-lock.json`
- Modify: `tests/consumers/web-vite/src/main.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `package.json`

**Interfaces:**
- Consumes: exact `npm pack` tarball and the public API from Task 12.
- Produces: a clean production Vite build, headless Chromium behavior gate with fake Web Bluetooth/storage, stricter tarball inventory, and immutable Web release evidence.

- [ ] **Step 1: Write failing package inventory tests**

  Require the tarball to contain one WASM asset, ESM/declarations, README/LICENSE, no source maps/tests/source files, no absolute paths, and no credentials or known sensitive fixture values. Assert `package.json.version` equals `sdk-version.toml` and npm package manager equals the repository's pinned CLI.

- [ ] **Step 2: Write failing Playwright tests against the packed package**

  Pin `@playwright/test@1.63.0` in the disposable Vite consumer. Inject a deterministic fake `navigator.bluetooth` before page load and use a real click handler for `requestDevice`. In Chromium, prove:

  - picker connection requires the click and exact serial;
  - authorized reconnect performs no picker call;
  - GATT notifications drive one WiFi status update and one log line;
  - IndexedDB plus OPFS-compatible fake state survives reload and resumes a staged upload;
  - destroy suppresses a late notification/provider completion;
  - absent Bluetooth and absent durable storage expose the exact capability matrix.

- [ ] **Step 3: Run package/browser gates and observe failures**

  Run:

  ```bash
  npm run web:verify
  tools/web/test-browser.sh
  ```

  Expected: package or browser tests fail before scripts/workflow wiring is complete.

- [ ] **Step 4: Build the consumer only from the exact tarball**

  Extend `tools/web/test-consumer.sh` to pack once, verify once, install that path into the clean Vite consumer, build production ESM, and pass the same tarball path to `test-browser.sh`. Never resolve `@bota.dev/web-sdk` from the workspace or registry in this gate.

- [ ] **Step 5: Wire local, CI, and tag verification**

  Add `web:browser` and include it in `web:verify`. CI installs only the pinned Chromium build needed by Playwright. Upload `target/web-release/` from the same commit and preserve it unchanged through release publication. Keep npm OIDC publication under the protected `release` environment and `beta` dist-tag.

- [ ] **Step 6: Run the complete Web release gate twice**

  Run:

  ```bash
  npm run web:verify
  rm -rf target/web-release
  npm run web:verify
  ```

  Expected: both runs pass, produce one tarball each, and the normalized tarball inventory and content hashes match.

- [ ] **Step 7: Commit browser and package gates**

  ```bash
  git add frameworks/web tools/web tests/consumers/web-vite .github/workflows package.json
  git commit -m "test(web): gate foreground browser package" \
    -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
  ```

### Task 14: Update implementation status, public guidance, and physical acceptance evidence

**Files:**
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `AGENTS.md`
- Modify: `frameworks/web/README.md`
- Modify: `CONTRIBUTING.md`
- Modify: `docs/releasing.md`
- Create: `docs/testing/web-physical-device.md`
- Create: `release/evidence/1.2.0-beta.1-web-foreground.md`
- Modify in sibling `internal-docs` repository: `App SDK Architecture.md`

**Interfaces:**
- Consumes: verified implementation and actual physical-browser results from Tasks 1-13.
- Produces: exact capability matrix, integration examples, security/lifecycle obligations, release runbook, and evidence that distinguishes automated tests from supervised hardware acceptance.

- [ ] **Step 1: Search every documentation surface by changed token**

  Run from the workspace root:

  ```bash
  rg -n "@bota.dev/web-sdk|frameworks/web|read-only beta|Web Bluetooth|BrowserWorkflowRuntime|clearPersistedData|firmwareDownload|encrypted_upload_v2" app-sdk internal-docs docs --glob '*.md'
  ```

  Record every relevant hit before editing. Do not infer affected docs only from file names.

- [ ] **Step 2: Replace foundation-only status with the exact foreground matrix**

  Document supported picker/reconnect/snapshot/recording/provisioning/settings/WiFi/control/OTA/log operations and explicitly unavailable background, streaming, reset, Safari/iOS fallback, Flutter Web, and Windows capabilities. Include secure-context, user-gesture, tenant namespace, logout cleanup, host-provider, and exact-identity requirements.

- [ ] **Step 3: Add complete provider integration examples**

  `frameworks/web/README.md` must show client creation, provider responsibilities, picker click, reconnect, recording sync, OTA progress, log removal, and logout cleanup. Example values use the reserved non-resolving domain `https://example.invalid` and never production endpoints, tokens, grants, or signed documents.

- [ ] **Step 4: Run the supervised physical Chromium matrix**

  Follow `docs/testing/web-physical-device.md` on one supported desktop Chromium browser and a Bota Note or Pin with released foreground protocol support. Record browser/version, device model/serial, firmware, commit, date, and pass/fail for picker, reconnect, snapshot, legacy recording, v2 recording when advertised, provisioning/deprovision, settings, WiFi, start/stop, OTA/reconnect, logs, cancel, and reload recovery. Never turn an automated result into physical evidence.

- [ ] **Step 5: Write release evidence without secrets**

  `release/evidence/1.2.0-beta.1-web-foreground.md` links the test commands, packed-tarball SHA-256, supervised matrix, known exclusions, and exact source revision. Redact all request URLs, headers, grants, tokens, receipts, WiFi credentials, and recording content.

- [ ] **Step 6: Verify docs and package examples**

  Run:

  ```bash
  git diff --check
  npm run web:verify
  rg -n "read-only beta|remain deferred|saved reconnect.*deferred" README.md ARCHITECTURE.md AGENTS.md frameworks/web/README.md docs
  ```

  Expected: diff check and Web gate pass; the stale-status search returns no inaccurate implementation claims.

- [ ] **Step 7: Commit public repository documentation**

  ```bash
  git add README.md ARCHITECTURE.md AGENTS.md frameworks/web/README.md CONTRIBUTING.md docs release/evidence
  git commit -m "docs(web): document foreground workflow support" \
    -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
  ```

- [ ] **Step 8: Commit the separate internal architecture status update**

  In the sibling `internal-docs` repository, update only the App SDK implementation/status sections, run `git diff --check`, and commit:

  ```bash
  git add "App SDK Architecture.md"
  git commit -m "docs(sdk): record web foreground parity" \
    -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
  ```

### Task 15: Run synchronized local gates, publish the immutable beta, and verify registries

**Files:**
- Modify only when generated evidence requires it: `Package.swift`
- Modify only when selected version changes: all version authorities and `release/examples/<version>.json`
- Modify after successful publication: `docs/releasing.md`, `README.md`, and release evidence status fields

**Interfaces:**
- Consumes: clean `main`, completed physical evidence, deterministic artifacts, protected GitHub `release` environment, npm trusted publishers, Maven Central, CocoaPods, pub.dev, and GitHub Releases.
- Produces: one immutable synchronized beta across Apple, Android, React Native, Flutter, and Web, plus checksum-verified public consumers.

- [ ] **Step 1: Recheck every candidate identity immediately before release preparation**

  Run:

  ```bash
  VERSION=$(sed -n 's/^version = "\([^"]*\)"$/\1/p' sdk-version.toml)
  git ls-remote --tags origin "v$VERSION"
  npm view "@bota.dev/web-sdk@$VERSION" version --json
  npm view "@bota.dev/react-native-sdk@$VERSION" version --json
  test "$(curl -sS -o /dev/null -w '%{http_code}' "https://repo1.maven.org/maven2/dev/bota/bota-android-sdk/$VERSION/bota-android-sdk-$VERSION.pom")" = "404"
  ! pod trunk info BotaAppleSDK | grep -F " - $VERSION "
  curl -fsS https://pub.dev/api/packages/bota_flutter_sdk | jq -e --arg version "$VERSION" 'all(.versions[]; .version != $version)'
  ```

  Expected for a new release: the tag and npm lookups are absent, Maven
  returns 404, and the CocoaPods/pub.dev predicates succeed. If any target is
  occupied, stop and increment all version authorities together; never
  overwrite or partially reuse the identity.

- [ ] **Step 2: Generate and commit the exact Apple package checksum when required**

  From a clean commit:

  ```bash
  tools/apple/package-release.sh --write-package-manifest
  swift package dump-package
  git diff -- Package.swift
  ```

  If `Package.swift` changes, verify the generated URL/checksum and commit that file alone with the required co-author trailer. Rerun `tools/apple/package-release.sh` from the new clean commit.

- [ ] **Step 3: Run the complete non-publishing local release matrix**

  Run every command in `docs/releasing.md` under **Local Release Gate** and **Android Package Gate**, including:

  ```bash
  npm ci
  npm run check
  npm run test:tooling
  npm run test:release
  npm run web:verify
  npm run sync:apple-fixtures
  npm run test:workflows -- --sdk-path ../react-native-sdk
  cargo xtask protocol generate --check
  cargo fmt --all -- --check
  cargo clippy --workspace --all-targets --all-features -- -D warnings
  cargo test --workspace
  tools/apple/test-package.sh
  tools/apple/test-consumer.sh
  tools/android/package-release.sh --check
  tools/flutter/package-release.sh --check
  cargo deny check
  ```

  Expected: all commands pass from a clean tree. Do not tag after a skipped or substituted gate.

- [ ] **Step 4: Push `main` and wait for one exact five-platform candidate inventory**

  Push the clean implementation/doc commits, then resolve and download the exact run artifact:

  ```bash
  SOURCE_REVISION=$(git rev-parse HEAD)
  CI_RUN_ID=$(gh run list --workflow ci.yml --commit "$SOURCE_REVISION" --json databaseId,status,conclusion --jq 'map(select(.status == "completed" and .conclusion == "success"))[0].databaseId')
  test -n "$CI_RUN_ID"
  CANDIDATE_DIR="target/release-candidate-$SOURCE_REVISION"
  rm -rf "$CANDIDATE_DIR"
  gh run download "$CI_RUN_ID" --name "release-candidate-$SOURCE_REVISION" --dir "$CANDIDATE_DIR"
  test -f "$CANDIDATE_DIR/release-candidate-files.json"
  test -f "$CANDIDATE_DIR/release-candidate-files.json.sha256"
  ```

  Verify the JSON records `SOURCE_REVISION` and Apple/Android/React Native/Flutter/Web artifacts, then run `shasum -a 256 -c release-candidate-files.json.sha256` from `CANDIDATE_DIR`.

- [ ] **Step 5: Create and verify the annotated immutable tag**

  Run the exact runbook commands with the downloaded inventory hash:

  ```bash
  VERSION=$(sed -n 's/^version = "\([^"]*\)"$/\1/p' sdk-version.toml)
  SOURCE_REVISION=$(git rev-parse HEAD)
  CANDIDATE_DIR="target/release-candidate-$SOURCE_REVISION"
  CANDIDATE_INVENTORY_SHA256=$(awk '{print $1}' "$CANDIDATE_DIR/release-candidate-files.json.sha256")
  git tag -a "v$VERSION" \
    -m "Bota App SDK $VERSION" \
    -m "Source-Revision: $SOURCE_REVISION" \
    -m "Candidate-Inventory-SHA256: $CANDIDATE_INVENTORY_SHA256"
  cargo xtask release verify-tag "v$VERSION"
  git push origin "v$VERSION"
  ```

- [ ] **Step 6: Approve and observe the protected release without rebuilding artifacts**

  Approve the configured GitHub `release` environment only after the tag workflow reaches its protected jobs. Do not use developer npm tokens or manual local publication. On uncertain Central upload, follow the exact recovery mode in `docs/releasing.md`; never submit a second bundle without a confirmed failed deployment.

- [ ] **Step 7: Verify public versions, dist-tags, and checksums**

  Verify Web and React Native npm `beta` resolve the released version, npm `latest` did not move, registry `dist.shasum` matches the preserved tarballs, SwiftPM resolves the immutable tag/XCFramework checksum, Maven Central inventory matches signed evidence, and pub.dev archive matches the candidate inventory.

  Install `@bota.dev/web-sdk@beta` into a new clean Vite app and run a production build plus the physical picker/snapshot smoke. This consumer must come from the registry, not the workspace.

- [ ] **Step 8: Record publication status in a final documentation commit**

  Change prepared/unpublished wording to the exact public version and verified workflow run IDs. Run `git diff --check`, commit with the required trailer, and push `main`. Do not move or recreate the release tag.
