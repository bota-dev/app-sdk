# Bota SDK for Web Foreground Workflow Parity Design

**Status:** Approved for implementation

**Date:** 2026-09-17

## Goal

Extend `@bota.dev/web-sdk` from its read-only connection foundation into the
complete browser-feasible foreground SDK agreed for the `1.2.0-beta.1`
candidate. A supported browser application can connect to an exact Bota device,
resume access to a previously authorized device, synchronize recordings,
provision and configure the device, control recording, update firmware, and
read device logs without reimplementing Bota protocol or workflow logic.

The package remains a device SDK. The host application owns authentication,
all Bota backend API calls, user authorization, and presentation.

## Relationship To The Foundation

This design extends the implemented
[`2026-09-15-web-sdk-foundation-design.md`](./2026-09-15-web-sdk-foundation-design.md).
The existing exact-identity picker, Rust/WASM connection workflow, snapshot,
package verification, and Vite consumer remain the base. This increment
implements the foreground workflows that the foundation intentionally
deferred.

## Release Boundary

### Included

- Explicit picker connection and exact serial verification.
- Explicit reconnect to a previously authorized browser device.
- Fresh identity, status, and capability reads.
- Recording list, legacy transfer, Encrypted Upload v2 transfer, cloud upload
  handoff, progress, cancellation, recovery, and receipt-bound confirmation.
- Provisioning and non-destructive deprovisioning through host-issued material.
- Connection-settings reads and writes.
- WiFi scan, configure, disconnect, status read, and status subscription.
- Recording start and stop control using host-issued authority where required.
- Firmware download, integrity verification, BLE transfer, reboot, reconnect,
  cancellation, and recovery.
- Device-log subscription and explicit unsubscribe.
- Durable browser checkpoints and bounded large-payload storage.
- Stable browser capability reporting and stable SDK errors.
- Packed-package, browser-consumer, physical-device, and synchronized release
  gates.

### Excluded

- Background scan, closed-tab work, service-worker Bluetooth, or silent
  reconnect outside browser capabilities.
- Safari/iOS fallback transports or a Bluetooth polyfill.
- Live recording streaming.
- Authenticated destructive factory reset.
- Flutter Web and Windows support.
- Bota API authentication or a generated Bota API client.
- Portal-specific state, UI, or business rules inside the SDK.

These exclusions must be visible in the public capability matrix. They must
not be represented as temporary runtime failures for otherwise advertised
features.

## Browser Support Contract

The SDK supports secure-context browsers that implement the required Web
Bluetooth GATT APIs. A new permission requires `requestDevice()` from a user
gesture. Previously granted devices may be retrieved through `getDevices()`
when the browser implements it. Web Bluetooth is not exposed to workers, so
every workflow is page-owned and foreground-only.

The SDK reports capabilities independently:

- `bluetooth`: picker and GATT support are present;
- `authorizedDeviceReconnect`: `getDevices()` is present;
- `durableStorage`: IndexedDB and OPFS are available;
- `largeRecordingSync`: durable storage and required GATT operations are
  available;
- `firmwareUpdate`: durable storage, fetch, and required GATT operations are
  available.

An unavailable optional capability fails before device mutation with a stable
`unsupported_capability` error. The SDK never guesses that a browser supports
a workflow merely because `navigator.bluetooth` exists.

References:

- <https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API>
- <https://developer.mozilla.org/en-US/docs/Web/API/Bluetooth/getDevices>
- <https://developer.mozilla.org/en-US/docs/Web/API/Bluetooth/requestDevice>

## Architectural Decisions

1. Rust remains authoritative for state machines, protocol encoding and
   decoding, retry decisions, checkpoints, integrity, and stable workflow
   errors.
2. The private WASM bridge exposes workflow-specific start methods and codec
   methods. JavaScript does not construct raw internal `Command` values or
   device protocol packets.
3. One TypeScript `BrowserWorkflowRuntime` executes typed Rust effects for all
   workflows. Feature managers do not each implement their own effect loop.
4. Browser Bluetooth, storage, network, and backend-material providers are
   separate host adapters behind narrow interfaces.
5. Large recording and firmware bodies never cross the WASM boundary as one
   unbounded value. Rust coordinates chunks; browser adapters own bytes.
6. The SDK serializes mutating GATT workflows per client. Passive status and
   log subscriptions may coexist only when they own distinct characteristics
   and cleanup is deterministic.
7. The SDK does not receive backend private keys and cannot mint or widen a
   grant. Host callbacks return exact opaque material for the current workflow
   context.
8. Device recording deletion occurs only after durable cloud completion and
   the exact required completion receipt or legacy confirmation rule.
9. `1.2.0-beta.1` remains the candidate only if both the Git tag and every
   target registry confirm that version is unused immediately before tagging.

## Component Architecture

```text
core/device-sdk-core
  state machines, codecs, integrity, checkpoints, stable errors
                    |
                    v
bindings/device-sdk-wasm
  workflow-specific starts + typed dispatch + browser-required codecs
                    |
                    v
frameworks/web
  public managers
       |
       +-- BrowserWorkflowRuntime
       |     effects, cancellation, ownership, progress
       |
       +-- WebBluetoothTransport
       |     picker/getDevices, connect, read/write, subscribe/unsubscribe
       |
       +-- BrowserWorkflowStore
       |     IndexedDB checkpoints, journals, verified-device metadata
       |
       +-- BrowserBlobStore
       |     OPFS recording and firmware bodies
       |
       +-- Host providers
             provisioning material, upload destinations/receipts,
             recording-control authority
```

### Private WASM Bridge

The bridge gains workflow-specific methods for:

- reconnect;
- provisioning;
- recording transfer;
- Encrypted Upload v2 batch transfer;
- upload ownership/handoff;
- firmware update;
- device logs.

It also exports browser-required Rust codecs for recording lists, connection
settings, WiFi requests/results/status, recording control, deprovisioning, and
other direct request/response operations that are not modeled as long-running
core workflows.

Every start method accepts a 16-byte cancellation identity and returns typed
effects. `dispatch()` remains the only continuation entry point. The bridge
must reject malformed JavaScript values without exposing raw secrets or packet
bodies in its error.

### Browser Workflow Runtime

`BrowserWorkflowRuntime` owns exactly one active mutating workflow. It:

- starts a workflow through the private bridge;
- drains effects in request order;
- validates request and cancellation identity on every completion;
- maps transport failures to typed host events;
- persists checkpoints before acknowledging persistence effects;
- reports monotonic progress;
- cancels timers, subscriptions, fetches, and sinks on terminal paths;
- rejects late completions after cancellation or client destruction;
- scrubs transient material buffers on terminal paths where JavaScript permits.

Direct codec-backed operations use the same ownership queue. They cannot
interleave writes with an active transfer, provisioning, or OTA workflow.

### Web Bluetooth Transport

The transport extends its current read-only contract with:

- `getAuthorizedDevices()`;
- write with and without response;
- characteristic subscribe and unsubscribe;
- notification delivery with characteristic identity;
- explicit availability reporting;
- deterministic teardown of cached services and characteristics.

`requestDevice()` includes every service required by the advertised Web
capability matrix in `optionalServices`. The SDK continues to treat the
advertised name as display/filter metadata only.

### Durable Browser Storage

IndexedDB stores small structured state:

- verified serial-to-browser-device identity hints;
- Rust workflow checkpoints;
- recording synchronization journals;
- Encrypted Upload v2 checkpoints and ownership metadata;
- OTA download/transfer checkpoints.

OPFS stores large bodies:

- in-progress and completed recording payloads;
- Encrypted Upload v2 ciphertext staging objects;
- downloaded firmware images.

Storage keys include SDK schema version, serial number, operation kind, and
recording/upload/firmware identity. A caller-provided tenant namespace is
required when durable workflows are enabled so two signed-in users on the same
origin cannot see or resume each other's journals.

Logout or project change is a host event. The host must destroy the client and
call scoped storage cleanup. Cleanup never sends device confirmation for an
incomplete cloud operation.

## Public API Shape

The Web package remains browser-idiomatic while preserving the App SDK manager
families:

```ts
const client = await BotaDeviceClient.create({
  storageNamespace: `${organizationId}:${projectId}:${userId}`,
  storage: customStorageAdapter, // optional; defaults to IndexedDB + OPFS
  providers: {
    provisioning,
    recordingUpload,
    recordingControl,
  },
})

client.devices
client.recordings
client.provisioning
client.wifi
client.controls
client.ota
client.logs

await client.clearPersistedData()
```

### Devices

```ts
devices.connect({ expectedSerialNumber })
devices.reconnect({ expectedSerialNumber })
devices.disconnect()
devices.readSnapshot()
devices.getCapabilities()
```

`reconnect()` uses the persisted verified device hint and
`navigator.bluetooth.getDevices()`. It tests only the exact previously
authorized browser device and re-verifies Device Information serial before
publication. If browser permission or `getDevices()` is unavailable, it fails
with `picker_required`; it never silently selects a same-name peripheral.

### Recordings

```ts
recordings.list()
recordings.sync(recording, options?)
recordings.resume(operationId)
recordings.cancel(operationId)
recordings.confirm(operationId)
recordings.listPendingOperations()
```

The manager selects Encrypted Upload v2 only from the freshly read capability
characteristic and an exact host authorization. It does not infer support from
firmware version. Legacy transfer remains an explicit compatibility profile.

`sync()` owns transfer, durable staging, upload through host-provided
destinations, cloud completion, and final device confirmation. The host
provider owns backend calls and returns only operation-scoped destinations and
receipts. The default browser store uses OPFS; the package does not accumulate
an entire recording in ordinary JavaScript memory.

`confirm(operationId)` is a recovery operation, not an arbitrary delete API.
It rejects unless that tenant-scoped durable journal proves cloud completion
and contains the exact confirmation material required by the selected transfer
profile.

### Provisioning And Settings

```ts
provisioning.provision(request)
provisioning.deprovision(request)
provisioning.readConnectionSettings()
provisioning.writeConnectionSettings(settings)
```

The provisioning provider receives the exact serial, nonce, device public key,
and attempt identity. It returns opaque device-bound material and receives the
physical-device result so the host can confirm or abort its backend attempt.
The SDK never treats a successful backend prepare as a completed bind.

Deprovision is non-destructive and must not be described as factory reset.

### WiFi And Recording Control

```ts
wifi.scanNetworks()
wifi.configure(credentials, grant)
wifi.disconnect()
wifi.readStatus()
wifi.subscribeToStatus(listener)

controls.startRecording(authority)
controls.stopRecording(authority)
```

Rust encodes and decodes every packet. Sensitive credentials and authority
material are retained only for the active operation and are never logged or
written to durable browser storage.

### Firmware Update

```ts
ota.updateFirmware(image, { onProgress })
ota.resumeFirmwareUpdate(operationId)
ota.cancelFirmwareUpdate(operationId)
```

The image descriptor contains an HTTPS source, exact size, version, and
integrity metadata. The browser adapter downloads to OPFS, validates the
artifact before the first device write, and serves bounded chunks to the Rust
workflow. Reboot reconnect uses the already authorized browser device when
available. A reload resumes only from a durable compatible checkpoint and the
same verified artifact.

### Device Logs

```ts
const subscription = await logs.subscribe(listener)
await subscription.remove()
```

Only decoded, sanitized lines leave the SDK. Subscription ownership is unique,
and disconnect, cancellation, or client destruction unsubscribes the
characteristic before releasing callbacks.

## Recording Synchronization Flow

1. Re-verify the connected serial and read fresh transfer capabilities.
2. List recordings and select the exact logical recording identity.
3. Ask the host provider for operation-scoped authorization and staging
   destinations.
4. Persist the initial journal before starting device transfer.
5. Transfer into the OPFS sink while Rust verifies ordering, framing, and
   integrity and while checkpoints are durably acknowledged.
6. Upload only the verified staged object through the host-provided destination.
7. Ask the host provider to complete backend processing and return the exact
   completion receipt when the profile requires one.
8. Send device confirmation only after durable cloud completion.
9. Persist `confirmed`, then remove the local staged body and journal.

A disconnect, tab reload, failed upload, expired destination, stale receipt, or
browser quota failure preserves the device recording. Resume starts from the
last mutually verified checkpoint. Legacy profiles that cannot resume restart
from byte zero explicitly.

## Error And Recovery Model

Existing stable errors remain. This increment adds browser-facing codes where
the caller must take a distinct action:

- `unsupported_capability`;
- `picker_required`;
- `storage_unavailable`;
- `storage_quota_exceeded`;
- `authorization_expired`;
- `resume_rejected`;
- `integrity_failed`;
- `upload_failed`;
- `firmware_rejected`.

Errors include operation, retryability, and safe context identifiers. Raw DOM
exception messages, GATT bodies, credentials, grants, URLs, receipts, and
recording bytes are never placed in public messages or logs.

Recovery rules are explicit:

- retryable transport failure preserves a checkpoint and staged bytes;
- identity mismatch disconnects and invalidates the operation;
- browser storage failure aborts before device confirmation;
- upload ambiguity is resolved through the host provider before retry;
- stale or mismatched authorization is never widened or silently renewed;
- client destruction cancels every operation and rejects every late callback.

## Security And Privacy

- Exact serial verification precedes every sensitive workflow and is repeated
  after reconnect.
- Host providers receive only the minimum context required to call the backend.
- The SDK accepts opaque, exact-action material; it never signs or invents it.
- Encrypted Upload v2 ciphertext remains ciphertext in browser storage and in
  transit to staging. Decryption keys never enter the SDK.
- Legacy plaintext compatibility data is origin-scoped, tenant-namespaced, and
  removed after confirmed upload.
- Presigned URLs and grants are memory-only and redacted from diagnostics.
- OPFS and IndexedDB state is treated as sensitive application data. Public
  documentation requires scoped cleanup on logout and project change.
- Bluetooth permission is not identity or authorization evidence.
- Recording confirmation and deprovisioning retain their distinct meanings;
  neither is represented as destructive factory reset.

## Testing And Acceptance

### Rust And WASM

- Contract tests for every new workflow-specific start method.
- Codec parity tests against committed protocol fixtures.
- Malformed JavaScript input and stable-error tests.
- WASM release build and generated-binding drift check.

### TypeScript

- Deterministic fake transport tests for read, write, subscribe, disconnect,
  late events, and concurrent ownership.
- Fake IndexedDB/OPFS tests for checkpoint ordering, quota failure, tenant
  isolation, cleanup, and reload recovery.
- Recording tests for legacy restart, v2 resume, integrity failure, upload
  ambiguity, receipt mismatch, and confirm-after-cloud ordering.
- Provisioning tests for prepare, physical failure, confirmation, abort, and
  sensitive-buffer cleanup.
- WiFi/settings/control tests for packet parity and operation serialization.
- OTA tests for download progress, integrity failure, chunking, cancellation,
  reboot reconnect, and resume.
- Log tests for sanitization, single ownership, and teardown.

### Consumer And Browser

- Install the exact `npm pack` tarball into a clean Vite application.
- Build production ESM with the WASM asset and no source-path leakage.
- Run supported Chromium browser tests with emulated/fake Bluetooth for user
  gesture, permissions, GATT notifications, disconnect, and storage recovery.
- Verify unsupported-browser and missing-capability states.
- Run a documented physical-device acceptance matrix in a supported desktop
  Chromium browser for every included workflow.

### Cross-Platform Regression

The complete Rust, Apple, Android, React Native, Flutter, Web, release-manifest,
license, and candidate-inventory gates must remain green. Web implementation
cannot weaken an existing native release gate.

## Release Plan

1. Implement in reviewable commits: transport/runtime, persistence, recording,
   provisioning/settings/control/WiFi, OTA/logs, then release/docs.
2. Run the complete local non-publishing release matrix.
3. Push `main` and require protected CI to generate a fresh five-platform
   candidate inventory for the exact commit.
4. Verify `v1.2.0-beta.1` and all target package coordinates are unused. If any
   target is occupied, increment every version authority together before
   rebuilding candidates.
5. Create the immutable annotated tag from the verified commit and candidate
   inventory.
6. Run the protected release workflow. Publish the exact Web npm tarball with
   OIDC and the `beta` dist-tag as part of the synchronized SDK release.
7. Verify registry versions and checksums without rebuilding artifacts.
8. Run a clean registry-installed Vite consumer and the physical browser
   smoke test.
9. Update public documentation from “initial read-only beta” to the exact
   supported foreground capability matrix.

## Exit Criteria

This increment is complete only when:

1. Every included public operation delegates protocol/workflow decisions to
   Rust and passes deterministic tests.
2. Large recording and firmware bodies remain bounded and durably recoverable.
3. No device recording is confirmed before durable cloud completion.
4. Exact identity, tenant isolation, credential redaction, and cancellation
   tests pass.
5. The packed Vite consumer and physical-device browser matrix pass.
6. All synchronized platform release gates pass for one exact commit.
7. The protected release publishes immutable artifacts and registry checksum
   verification succeeds.
8. Documentation clearly distinguishes supported foreground workflows from
   unavailable background, streaming, reset, and browser targets.
