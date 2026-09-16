# Bota SDK for Web Foundation Design

**Status:** Approved for implementation

**Date:** 2026-09-15

## Goal

Publish `@bota.dev/web-sdk` from the `app-sdk` monorepo and consume that
package from the production Portal device-detail page. The first increment
provides an explicit, foreground-only browser Bluetooth connection, verifies
the selected physical device against the device-detail serial number, and
reads device identity, transfer capabilities, and status. Recording listing
and upload are intentionally deferred to the next increment.

## Decisions

1. `app-sdk` remains the single source repository for every Bota App SDK
   distribution. The Web package is not implemented in the Portal repository.
2. Rust remains authoritative for protocol parsing and deterministic workflow
   behavior. The Web package uses the Rust core compiled to WebAssembly.
3. TypeScript owns the browser Bluetooth transport, user-gesture lifecycle,
   and browser-facing public API.
4. The Portal owns authentication and every Bota backend API call. The Web SDK
   does not become a Bota API client.
5. The production Device Detail page exposes the feature directly. There is no
   staff-only or project feature flag.
6. Unsupported browsers fail before opening a device picker or changing device
   state. The SDK does not provide a Bluetooth polyfill.
7. The first increment never writes a device characteristic and does not
   provision, configure, control, list, transfer, upload, or delete recordings.

## Scope

### Included

- A publishable ESM package named `@bota.dev/web-sdk` under `frameworks/web`.
- A private `wasm-bindgen` bridge under `bindings/device-sdk-wasm`.
- Browser capability detection.
- An explicit device picker started by a user action.
- One active device connection per `BotaDeviceClient`.
- Exact serial-number verification using Device Information characteristic
  `2A25`; advertised names are display metadata only.
- Device Information reads for model, hardware revision, and firmware revision.
- Device-status reads from Bota characteristic `0001`, decoded by the Rust
  core.
- Fresh Encrypted Upload v2 capability reads from Bota characteristic `0406`,
  decoded by the Rust core when that characteristic exists.
- Predictable disconnect and destroy behavior.
- Stable, typed SDK errors with safe browser-facing messages.
- A Portal Device Detail section that connects, displays the local snapshot,
  refreshes it explicitly, and disconnects.

### Deferred

- Background scan, background reconnect, or reconnect without a picker.
- Recording list, transfer, staging, upload, confirmation, or deletion.
- Provisioning, WiFi configuration, recording control, OTA, and device logs.
- Browser persistence of connection identity or workflow checkpoints.
- Electron-specific native transport.
- Safari/iOS fallback transports or a Bluetooth polyfill.

## Package Architecture

```text
core/device-sdk-core
  Rust protocol decoders + connection workflow
          |
          v
bindings/device-sdk-wasm
  private wasm-bindgen bridge; no public product API
          |
          v
frameworks/web
  @bota.dev/web-sdk
  TypeScript public facade + Web Bluetooth host
          |
          v
bota/portal
  production Device Detail consumer
```

The WebAssembly bridge exposes only the internal operations required by the
public TypeScript facade:

- start an exact-identity manual connection workflow;
- dispatch typed host events and return typed effects;
- inspect terminal workflow status;
- decode device-status bytes;
- decode Encrypted Upload v2 capability bytes.

The bridge does not expose backend URLs, tokens, grants, presigned requests,
or unbounded recording bodies. Its generated JavaScript and `.wasm` files are
build outputs placed in the npm package, not hand-maintained source.

## Public Web API

```ts
const client = await BotaDeviceClient.create()

if (!client.devices.isSupported) {
  // Render the unsupported-browser state.
}

const device = await client.devices.connect({
  expectedSerialNumber: 'GDPPSBZJN6',
})

const snapshot = await client.devices.readSnapshot()
await client.devices.disconnect()
await client.destroy()
```

The public surface consists of:

```ts
class BotaDeviceClient {
  static create(options?: BotaDeviceClientOptions): Promise<BotaDeviceClient>
  readonly devices: DeviceManager
  destroy(): Promise<void>
}

class DeviceManager {
  readonly isSupported: boolean
  readonly connectedDevice: ConnectedDevice | null
  connect(options: ConnectOptions): Promise<ConnectedDevice>
  readSnapshot(): Promise<DeviceSnapshot>
  disconnect(): Promise<void>
}

interface ConnectOptions {
  expectedSerialNumber: string
}

interface ConnectedDevice {
  id: string
  name: string | null
  serialNumber: string
}

interface DeviceSnapshot {
  identity: {
    serialNumber: string
    modelNumber: string | null
    hardwareRevision: string | null
    firmwareRevision: string | null
  }
  status: DeviceStatus
  capabilities: {
    encryptedUploadV2: EncryptedUploadV2Capabilities | null
  }
  capturedAt: Date
}
```

`BotaDeviceClientOptions` may inject an internal transport and core loader for
tests, but production consumers normally pass no options. This injection is a
testing boundary, not a second public protocol implementation.

## Connection Flow

1. `connect()` rejects malformed expected serial numbers before invoking the
   browser picker.
2. It verifies browser support and confirms that no connection workflow owns
   the client.
3. It invokes the picker with the Bota services required by this milestone.
4. The selected browser device becomes a Rust `Connect` workflow candidate.
5. Rust emits connect, service-discovery, serial-read, timer, and identity-save
   effects.
6. The TypeScript host executes each effect and returns its original request
   and cancellation identity to Rust.
7. A serial mismatch causes Rust to require disconnect and finish with
   `identity_mismatch`; the browser device is never accepted by the Portal.
8. Successful identity save is acknowledged in memory and the verified
   `ConnectedDevice` becomes visible to the caller.
9. `readSnapshot()` reads all identity fields and device status. It attempts a
   fresh `0406` read; a genuinely absent characteristic maps to `null`, while a
   malformed value is a protocol error.
10. Disconnect, browser GATT disconnect, or `destroy()` clears all references,
    cancels timers, and makes later reads fail as disconnected.

No automatic fallback, name-based identity acceptance, or firmware-version
capability inference is permitted.

## Portal Experience

The production Device Detail `properties` tab receives a **Local Bluetooth**
section for bound devices:

- Before connection: a short explanation and `Connect via Bluetooth` button.
- Unsupported browser: an inline explanation; no disabled picker loop.
- Connecting: the button is disabled with progress feedback.
- Connected: verified serial, firmware, battery, storage, pending recordings,
  state, and whether Encrypted Upload v2 is advertised.
- Actions: `Refresh` and `Disconnect`.
- Identity mismatch: a destructive error explaining that the selected device
  does not match this page, without revealing any secret material.

The Portal passes only `device.serial_number` to the SDK. It does not use the
advertised name, peripheral ID, or cloud device ID as proof of identity. The
component disconnects and destroys its client on unmount or when the route
changes to a different device.

## Error Model

`BotaSDKError` exposes a stable code, operation, retryability, and a safe
message. The first increment supports these public codes:

- `unsupported_browser`
- `invalid_input`
- `picker_cancelled`
- `bluetooth_unavailable`
- `permission_denied`
- `operation_in_progress`
- `connection_failed`
- `identity_mismatch`
- `device_disconnected`
- `protocol_error`
- `cancelled`
- `internal_error`

Raw DOM exception text and raw characteristic bodies are not placed in Portal
toasts or SDK logs. Known browser cancellation and permission failures receive
stable mappings; unknown platform details may be retained only as a private
error cause.

## Security and Privacy

- The picker must originate from an explicit user action.
- The exact Device Information serial is the only accepted identity proof in
  this milestone.
- No backend credential or device token enters the SDK.
- No recording, grant, certificate, public-key blob, or encrypted-upload
  authorization is read or logged.
- Capability support is read from the exact characteristic and decoded by
  Rust; it is never inferred from model or firmware strings.
- Only one workflow may own a client. Cleanup uncertainty fails closed until
  the browser reports a disconnect or the client is destroyed.
- Production diagnostics contain phase and stable error metadata only.

## Testing and Release Gates

The package is not publishable until all of the following pass locally and in
the protected release workflow:

1. Rust unit tests for the WASM bridge and shared protocol fixtures.
2. `wasm32-unknown-unknown` release compilation.
3. TypeScript unit tests using a deterministic fake browser transport.
4. Tests proving picker cancellation, exact identity mismatch disconnect,
   malformed status rejection, absent `0406`, malformed `0406`, disconnect,
   destroy, and concurrent-operation rejection.
5. A clean Vite consumer build from the exact `npm pack` tarball.
6. Package-content checks proving the tarball contains declarations, ESM, and
   exactly one required `.wasm` artifact with no source maps containing local
   paths.
7. Existing Rust, native, React Native, fixture, and release-readiness gates.
8. Portal type-check, lint, production build, and focused component/state
   tests against the exact packed artifact before registry publication.
9. Registry checksum verification after OIDC publication.
10. Portal installation from the exact registry version, followed by another
    production build before deployment.

The first physical acceptance test verifies successful connection and snapshot
read from the production Device Detail page and verifies that selecting a
different device fails closed. It does not claim recording-transfer coverage.

## Delivery Sequence

1. Implement and locally verify the Web SDK package in `app-sdk`.
2. Extend synchronized release metadata and the protected release workflow.
3. Publish the next synchronized App SDK version, including
   `@bota.dev/web-sdk`, and verify its registry checksum.
4. Add the exact published version to the Portal.
5. Implement and locally verify the Device Detail integration.
6. Deploy the Portal feature to production.
7. Begin the separate recording-list milestone.
