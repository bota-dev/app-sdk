# Bota SDK for Web Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and publish `@bota.dev/web-sdk` from `app-sdk` with a WASM-backed exact-identity browser Bluetooth connection and read-only device snapshot.

**Architecture:** Compile the existing Rust protocol/workflow core into a private `wasm-bindgen` bridge, then place an idiomatic TypeScript/Web Bluetooth facade above it. The public npm package owns browser lifecycle only; Rust continues to own connection sequencing and protocol decoding, and host applications continue to own backend API calls.

**Tech Stack:** Rust 1.98, `wasm-bindgen`, `serde-wasm-bindgen`, WebAssembly, TypeScript 6, Node 24 tests, Web Bluetooth, Vite consumer smoke test, npm 11.10.0.

**Implementation status (2026-09-15):** Tasks 1–7 are complete in commits
`0171de6`, `20837c4`, `8abc7ae`, `58bd0d4`, `0962b92`, `40bb8dc`, and
`b01a7f6`, plus the documentation commit that closes this plan. Publication
and Portal consumption remain separate rollout steps.

**Spec:** `docs/superpowers/specs/2026-09-15-web-sdk-foundation-design.md`

## Global Constraints

- The public package identifier is exactly `@bota.dev/web-sdk`.
- Every platform version is synchronized from `sdk-version.toml`.
- Rust owns connection workflow behavior and protocol decoding.
- TypeScript owns the browser Bluetooth transport and browser lifecycle.
- The SDK does not call a Bota backend API.
- Advertised names are never identity proof; connection succeeds only after a fresh `2A25` serial read matches the expected serial.
- The first increment is read-only and never writes a device characteristic.
- Unsupported browsers fail before the device picker opens.
- No recording bytes, tokens, grants, certificates, or encrypted-upload documents enter logs or error messages.
- Production package contents come from an exact `npm pack` artifact, never a source link.
- Every production behavior begins with a failing test that is observed before implementation.

---

### Task 1: Add the private WASM core bridge

**Files:**
- Modify: `Cargo.toml`
- Modify: `Cargo.lock`
- Create: `bindings/device-sdk-wasm/Cargo.toml`
- Create: `bindings/device-sdk-wasm/src/lib.rs`
- Create: `bindings/device-sdk-wasm/tests/bridge_contract.rs`

**Interfaces:**
- Consumes: `bota_device_sdk_core::engine::WorkflowEngine`, `Command::Connect`, `Event`, `parse_device_status`, and `decode_encrypted_upload_v2_capabilities`.
- Produces: `WebCoreBridge::start_exact_connection`, `WebCoreBridge::dispatch`, `WebCoreBridge::status`, `decode_device_status`, and `decode_encrypted_upload_v2_capabilities` as private WASM exports.

- [x] **Step 1: Write failing bridge contract tests**

  Add native tests that construct a bridge, start a connection for
  `GDPPSBZJN6`, assert the first effects contain `BleEffect::Connect`, and feed
  the connect/discover/serial/persist events until the terminal notification
  contains the exact verified serial. Add fixture-backed decoder tests that
  assert valid status and `0406` values produce typed DTOs and malformed values
  return stable core errors.

- [x] **Step 2: Run the bridge test and verify the missing crate fails**

  Run:

  ```bash
  cargo test -p bota-device-sdk-wasm --test bridge_contract
  ```

  Expected: failure because the new workspace member and bridge do not exist.

- [x] **Step 3: Add the workspace member and bridge crate**

  Add `bindings/device-sdk-wasm` to the root workspace. Configure the crate as
  both `cdylib` and `rlib`, depend on `bota-device-sdk-core`, and pin
  `wasm-bindgen`, `serde`, and `serde-wasm-bindgen` in `Cargo.lock`.

  Keep the exported surface narrow:

  ```rust
  #[wasm_bindgen]
  pub struct WebCoreBridge {
      engine: WorkflowEngine,
  }

  #[wasm_bindgen]
  impl WebCoreBridge {
      #[wasm_bindgen(constructor)]
      pub fn new() -> Self;

      pub fn start_exact_connection(
          &mut self,
          expected_serial: &str,
          peripheral_id: &str,
          name: Option<String>,
          cancellation_id: &[u8],
      ) -> Result<JsValue, JsValue>;

      pub fn dispatch(&mut self, event: JsValue) -> Result<JsValue, JsValue>;
      pub fn status(&self) -> Result<JsValue, JsValue>;
  }

  #[wasm_bindgen]
  pub fn decode_device_status(bytes: &[u8]) -> Result<JsValue, JsValue>;

  #[wasm_bindgen]
  pub fn decode_encrypted_upload_v2_capabilities(
      bytes: &[u8],
  ) -> Result<JsValue, JsValue>;
  ```

  Serialize 64-bit values as JavaScript `bigint`; never silently narrow them
  into JavaScript numbers. Convert `DeviceSdkError` into a structured private
  bridge error object instead of returning formatted Rust debug output.

- [x] **Step 4: Run native bridge and workspace tests**

  Run:

  ```bash
  cargo test -p bota-device-sdk-wasm --test bridge_contract
  cargo test --workspace
  cargo fmt --all -- --check
  cargo clippy --workspace --all-targets --all-features -- -D warnings
  ```

  Expected: all commands pass.

- [x] **Step 5: Verify the actual browser target compiles**

  Run:

  ```bash
  rustup target add wasm32-unknown-unknown --toolchain 1.98.0
  cargo build -p bota-device-sdk-wasm --release --target wasm32-unknown-unknown
  ```

  Expected: `target/wasm32-unknown-unknown/release/bota_device_sdk_wasm.wasm`
  exists and no native-only dependency enters the browser graph.

- [x] **Step 6: Commit the bridge**

  ```bash
  git add Cargo.toml Cargo.lock bindings/device-sdk-wasm
  git commit -m "feat(web): add wasm core bridge" \
    -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
  ```

### Task 2: Scaffold the publishable Web package and core loader

**Files:**
- Create: `frameworks/web/package.json`
- Create: `frameworks/web/package-lock.json`
- Create: `frameworks/web/tsconfig.json`
- Create: `frameworks/web/src/index.ts`
- Create: `frameworks/web/src/core.ts`
- Create: `frameworks/web/src/errors.ts`
- Create: `frameworks/web/src/models.ts`
- Create: `frameworks/web/src/__tests__/core.test.ts`
- Create: `tools/web/build-wasm.sh`
- Create: `tools/web/verify-package.mjs`
- Create: `tools/web/verify-package.test.mjs`
- Modify: `.gitignore`
- Modify: `package.json`

**Interfaces:**
- Consumes: generated `wasm-bindgen` module from Task 1.
- Produces: `CoreBridge` internal interface, stable `BotaSDKError`, public device/status/capability models, and deterministic package build/verification scripts.

- [x] **Step 1: Write failing loader and error tests**

  Tests must prove that concurrent `create()` calls share one WASM
  initialization promise, an initialization failure can be retried, structured
  core failures map to stable public codes, and raw DOM exception text is kept
  only as the private `cause`.

- [x] **Step 2: Run tests and verify the package is absent**

  Run:

  ```bash
  npm test --prefix frameworks/web
  ```

  Expected: failure because the Web package has not been scaffolded.

- [x] **Step 3: Add the package and deterministic WASM build**

  Configure ESM-only exports, declaration output, `sideEffects: false`,
  `engines.node >= 22`, `packageManager: npm@11.10.0`, and `files` containing
  only `dist`, `README.md`, and `LICENSE`. `tools/web/build-wasm.sh` must invoke
  the pinned Rust toolchain and pinned `wasm-bindgen-cli`, place generated
  browser output below `frameworks/web/src/generated`, and reject an unexpected
  number of `.wasm` files.

  The internal loader contract is:

  ```ts
  export interface CoreBridge {
    startExactConnection(input: CoreConnectionInput): CoreEffect[]
    dispatch(event: CoreHostEvent): CoreEffect[]
    status(): CoreWorkflowStatus
    decodeDeviceStatus(bytes: Uint8Array): DeviceStatus
    decodeEncryptedUploadV2Capabilities(
      bytes: Uint8Array,
    ): EncryptedUploadV2Capabilities
  }

  export type CoreLoader = () => Promise<CoreBridge>
  ```

  The generated module remains internal and is not exported from the npm
  package.

- [x] **Step 4: Implement public models and errors**

  Export the exact `BotaSDKError`, `BotaSDKErrorCode`, `BotaOperation`,
  `ConnectedDevice`, `DeviceStatus`, `EncryptedUploadV2Capabilities`, and
  `DeviceSnapshot` shapes from the design. Map unsupported, picker cancellation,
  permission, disconnect, protocol, and core failures without exposing raw
  characteristic bodies.

- [x] **Step 5: Run Web unit and package-verifier tests**

  Run:

  ```bash
  npm ci --prefix frameworks/web
  npm test --prefix frameworks/web
  node --test tools/web/verify-package.test.mjs
  ```

  Expected: all tests pass.

- [x] **Step 6: Commit the package foundation**

  ```bash
  git add .gitignore package.json frameworks/web tools/web
  git commit -m "feat(web): scaffold browser sdk package" \
    -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
  ```

### Task 3: Implement the Web Bluetooth host and exact connection lifecycle

**Files:**
- Create: `frameworks/web/src/transport.ts`
- Create: `frameworks/web/src/webBluetoothTransport.ts`
- Create: `frameworks/web/src/deviceManager.ts`
- Create: `frameworks/web/src/client.ts`
- Create: `frameworks/web/src/__tests__/fakeBluetooth.ts`
- Create: `frameworks/web/src/__tests__/deviceManager.test.ts`
- Modify: `frameworks/web/src/index.ts`

**Interfaces:**
- Consumes: `CoreBridge` and public models from Task 2.
- Produces: `BotaDeviceClient.create`, `BotaDeviceClient.destroy`, `DeviceManager.connect`, `DeviceManager.disconnect`, and `DeviceManager.connectedDevice`.

- [x] **Step 1: Write failing lifecycle tests**

  Cover these behaviors individually:

  - unsupported browser rejects before `requestDevice`;
  - malformed expected serial rejects before `requestDevice`;
  - picker cancellation becomes `picker_cancelled`;
  - the picker requests Device Information, Bota Control, and Bota Storage;
  - successful connect follows the Rust effect order and returns the freshly
    read serial;
  - mismatched serial follows the Rust-required disconnect before rejecting;
  - a second connect fails with `operation_in_progress`;
  - browser disconnect clears `connectedDevice`;
  - explicit disconnect is idempotent;
  - destroy cancels timers, disconnects, and rejects later operations.

- [x] **Step 2: Run the focused tests and observe missing behavior**

  Run:

  ```bash
  npm test --prefix frameworks/web -- deviceManager.test
  ```

  Expected: tests fail because `DeviceManager` and the transport do not exist.

- [x] **Step 3: Implement the injectable transport boundary**

  Define a narrow internal transport rather than referencing browser globals
  throughout the SDK:

  ```ts
  export interface BrowserBluetoothTransport {
    readonly isSupported: boolean
    requestDevice(): Promise<BrowserDeviceHandle>
    connect(device: BrowserDeviceHandle): Promise<void>
    discoverServices(device: BrowserDeviceHandle): Promise<void>
    read(
      device: BrowserDeviceHandle,
      serviceUuid: string,
      characteristicUuid: string,
    ): Promise<Uint8Array>
    disconnect(device: BrowserDeviceHandle): Promise<void>
    onDisconnected(
      device: BrowserDeviceHandle,
      listener: () => void,
    ): () => void
  }
  ```

  The real adapter performs the picker request only from `connect()` and copies
  every `DataView` into a new `Uint8Array` before returning it.

- [x] **Step 4: Drive Rust effects to completion**

  Generate a cryptographically random 16-byte cancellation ID, start the exact
  connection workflow, execute only the allowed read-only connect effects, and
  dispatch each event with its original request ID. Acknowledge the in-memory
  identity-save effect only after the exact serial has been verified. Reject
  every unexpected effect as `internal_error` and clean up the selected device.

- [x] **Step 5: Run lifecycle tests and type-check**

  Run:

  ```bash
  npm test --prefix frameworks/web -- deviceManager.test
  npm run type-check --prefix frameworks/web
  ```

  Expected: all focused tests and type-check pass.

- [x] **Step 6: Commit the connection lifecycle**

  ```bash
  git add frameworks/web/src
  git commit -m "feat(web): add exact browser bluetooth connection" \
    -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
  ```

### Task 4: Add the read-only device snapshot

**Files:**
- Modify: `frameworks/web/src/deviceManager.ts`
- Modify: `frameworks/web/src/webBluetoothTransport.ts`
- Modify: `frameworks/web/src/__tests__/fakeBluetooth.ts`
- Create: `frameworks/web/src/__tests__/snapshot.test.ts`

**Interfaces:**
- Consumes: verified connected-device ownership from Task 3 and Rust decoders from Task 1.
- Produces: `DeviceManager.readSnapshot(): Promise<DeviceSnapshot>`.

- [x] **Step 1: Write failing snapshot tests**

  Test valid identity/status decoding, a fresh `0406` read on every call, an
  absent `0406` mapping to `null`, a malformed `0406` mapping to
  `protocol_error`, a malformed status mapping to `protocol_error`, and a GATT
  disconnect during reads mapping to `device_disconnected`.

- [x] **Step 2: Run the focused snapshot tests and observe failure**

  Run:

  ```bash
  npm test --prefix frameworks/web -- snapshot.test
  ```

  Expected: failure because `readSnapshot` is missing.

- [x] **Step 3: Implement the snapshot reads**

  Read serial, model, hardware revision, firmware revision, and device status.
  Reverify that the serial still matches the connected identity. Read `0406`
  fresh and return `null` only for the transport's typed
  `characteristic_not_found`; propagate all other failures. Decode status and
  capabilities only through the WASM bridge.

- [x] **Step 4: Run all Web package tests**

  Run:

  ```bash
  npm test --prefix frameworks/web
  npm run type-check --prefix frameworks/web
  ```

  Expected: all tests pass without warnings.

- [x] **Step 5: Commit the snapshot**

  ```bash
  git add frameworks/web/src
  git commit -m "feat(web): read verified device snapshot" \
    -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
  ```

### Task 5: Verify the packed package in a clean browser consumer

**Files:**
- Create: `tests/consumers/web-vite/package.json`
- Create: `tests/consumers/web-vite/package-lock.json`
- Create: `tests/consumers/web-vite/index.html`
- Create: `tests/consumers/web-vite/src/main.ts`
- Create: `tests/consumers/web-vite/tsconfig.json`
- Create: `tests/consumers/web-vite/vite.config.ts`
- Create: `tools/web/test-consumer.sh`
- Modify: `frameworks/web/package.json`
- Modify: `package.json`

**Interfaces:**
- Consumes: exact `npm pack` tarball from Tasks 2–4.
- Produces: deterministic package-content and clean-consumer evidence used by release CI.

- [x] **Step 1: Write a failing package-verifier case**

  Add a fixture tarball inventory missing the `.wasm` file and assert that
  `verify-package.mjs` rejects it. Add another with an unexpected source map or
  absolute workspace path and assert rejection.

- [x] **Step 2: Run package tests and observe failure**

  Run:

  ```bash
  node --test tools/web/verify-package.test.mjs
  ```

  Expected: the new checks fail before the verifier is extended.

- [x] **Step 3: Add package and consumer verification**

  Build the WASM and TypeScript outputs, pack once into `target/web-release`,
  inspect the tarball, install that tarball into a clean Vite consumer, and run
  a production Vite build. The consumer imports only:

  ```ts
  import { BotaDeviceClient, BotaSDKError } from '@bota.dev/web-sdk'
  ```

  It must not import repository source or generated bridge internals.

- [x] **Step 4: Run the complete local Web gate**

  Run:

  ```bash
  npm run web:verify
  ```

  Expected: WASM release build, unit tests, type-check, pack verification, and
  clean Vite production build all pass.

- [x] **Step 5: Commit consumer verification**

  ```bash
  git add package.json frameworks/web tests/consumers/web-vite tools/web
  git commit -m "test(web): verify packed vite consumer" \
    -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
  ```

### Task 6: Integrate Web into synchronized release metadata and CI

**Files:**
- Modify: `sdk-version.toml`
- Modify: `package.json`
- Modify: `core/device-sdk-core/Cargo.toml`
- Modify: `tools/xtask/Cargo.toml`
- Modify: `frameworks/react-native/package.json`
- Modify: `platforms/android/gradle.properties`
- Modify: `protocol/compatibility/firmware-compatibility.json`
- Modify: `release/examples/<next-version>.json`
- Modify: `tools/xtask/src/lib.rs`
- Modify: `tools/xtask/tests/release_readiness.rs`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `docs/releasing.md`

**Interfaces:**
- Consumes: verified Web tarball and consumer gate from Task 5.
- Produces: one synchronized release candidate containing Apple, Android, React Native, and Web artifacts plus idempotent npm publication/checksum verification for both npm packages.

- [x] **Step 1: Write failing release-readiness tests**

  Require `frameworks/web/package.json` to match `sdk-version.toml`, require the
  release manifest to contain platform `web` and package identifier
  `@bota.dev/web-sdk`, and reject release workflows that omit the Web artifact
  from the immutable candidate inventory.

- [x] **Step 2: Run release tests and verify they fail**

  Run:

  ```bash
  npm run test:release
  cargo test -p xtask release_readiness
  ```

  Expected: failures identify the missing Web version/artifact/release job.

- [x] **Step 3: Choose and synchronize the next version**

  Use the next release version approved at execution time and update every
  synchronized version authority listed in the file section. Do not reuse an
  existing immutable tag or npm version.

- [x] **Step 4: Add Web CI and release jobs**

  CI runs `npm run web:verify`. The tag workflow builds and uploads
  `target/web-release`, includes it in the candidate inventory and GitHub
  Release, publishes the exact tarball via OIDC to the resolved npm dist-tag,
  and checks the public `dist.shasum`. First publication must not assume an
  existing `latest` tag; reruns must verify exact checksum identity rather than
  overwrite a version.

- [x] **Step 5: Run synchronized release verification locally**

  Run:

  ```bash
  npm run test:tooling
  npm run test:release
  npm run web:verify
  cargo xtask release verify-tag v<next-version>
  cargo test --workspace
  cargo fmt --all -- --check
  cargo clippy --workspace --all-targets --all-features -- -D warnings
  ```

  Expected: every command except the tag check passes before a tag exists; run
  the exact tag check again only after creating the reviewed annotated tag.

- [x] **Step 6: Commit release integration**

  ```bash
  git add sdk-version.toml package.json Cargo.lock core tools frameworks platforms protocol release .github docs/releasing.md
  git commit -m "release: include web sdk candidate" \
    -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
  ```

### Task 7: Update architecture and public package documentation

**Files:**
- Modify: `AGENTS.md`
- Modify: `ARCHITECTURE.md`
- Modify: `README.md`
- Create: `frameworks/web/README.md`
- Modify: `docs/superpowers/plans/2026-08-28-app-sdk-implementation.md`
- Modify: `../internal-docs/App SDK Architecture.md`
- Modify: `../internal-docs/Requirements System Design Traceability.md`

**Interfaces:**
- Consumes: final behavior and verified commands from Tasks 1–6.
- Produces: accurate implementation status, public installation/usage instructions, and cross-system traceability.

- [x] **Step 1: Search the complete documentation surface**

  Search `Web SDK`, `@bota.dev/web-sdk`, `Web Bluetooth`,
  `bindings/device-sdk-wasm`, `BotaDeviceClient`, and `readSnapshot` across
  `internal-docs/`, `docs/`, and every repository `AGENTS.md`,
  `ARCHITECTURE.md`, and `README.md`. Classify every hit before editing.

- [x] **Step 2: Update implementation status and usage**

  Document only the first increment's read-only capabilities, explicit picker,
  foreground lifecycle, exact identity check, unsupported-browser behavior,
  and deferred recording operations. Do not advertise recording sync or broad
  browser support.

- [x] **Step 3: Run documentation and package gates**

  Run:

  ```bash
  npm run check
  npm run web:verify
  cargo test --workspace
  ```

  Expected: all applicable gates pass.

- [x] **Step 4: Commit documentation**

  ```bash
  git add AGENTS.md ARCHITECTURE.md README.md frameworks/web/README.md docs ../internal-docs
  git commit -m "docs: document web sdk foundation" \
    -m "Co-Authored-By: OpenAI Codex <noreply@openai.com>"
  ```

## Self-Review

- Spec coverage: Tasks 1–4 cover WASM authority, browser lifecycle, identity,
  status, capabilities, errors, and cleanup. Tasks 5–6 cover immutable package
  and publication gates. Task 7 covers required documentation and traceability.
- Deferred features remain absent: no recording list, transfer, upload,
  provisioning, configuration, control, OTA, logs, or background lifecycle.
- Type consistency: the public `BotaDeviceClient`, `DeviceManager`,
  `ConnectedDevice`, and `DeviceSnapshot` names match the design spec and every
  downstream task.
- Execution order is mandatory because Portal integration must consume an exact
  published tarball/version and is planned separately after Task 6.
