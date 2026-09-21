# Bota SDK for Web

`@bota.dev/web-sdk` is the browser distribution of the Bota App SDK. It supports
explicit, foreground Web Bluetooth workflows with exact serial verification,
durable browser state, and a shared Rust core compiled to WebAssembly for
protocol sequencing, integrity, and stable workflow errors.

## Install

```bash
npm install @bota.dev/web-sdk@1.2.0-beta.1
```

Use a secure context and a browser that implements Web Bluetooth. The initial
`connect()` call must run from a user gesture because it opens the browser's
device picker.

Destroying the client while that picker or its connection workflow is pending
cancels the SDK connection. If the browser later returns a selection, the SDK
rejects it as `cancelled` before starting GATT. If GATT work had already
started, the SDK disconnects the selected device and rejects the pending
connection as `cancelled` without publishing it.

## Connect and read a snapshot

```ts
import { BotaDeviceClient, BotaSDKError } from '@bota.dev/web-sdk'

const bota = await BotaDeviceClient.create()

try {
  if (!bota.devices.isSupported) {
    throw new Error('Web Bluetooth is not supported by this browser')
  }

  const device = await bota.devices.connect({
    expectedSerialNumber: 'YOUR_DEVICE_SERIAL',
  })
  const snapshot = await bota.devices.readSnapshot()

  console.log(device.serialNumber)
  console.log(snapshot.identity.firmwareRevision)
  console.log(snapshot.status.batteryPercent)
  console.log(snapshot.capabilities.encryptedUploadV2)
} catch (error) {
  if (error instanceof BotaSDKError) {
    console.error(error.code, error.operation, error.retryable)
  }
  throw error
} finally {
  await bota.destroy()
}
```

The expected serial number must come from the application's authenticated
device record. The advertised Bluetooth name is only display and picker-filter
metadata. A selected device is returned only after its Device Information
serial matches, and `readSnapshot()` repeats that verification before returning
fresh values.

## Foreground firmware updates

`BotaDeviceClient.create()` accepts a durable browser storage implementation and
a `providers.firmwareDownload` resolver. The resolver receives only stable image
identity and returns a fresh operation-scoped `GET` URL and headers. Those
request credentials remain in memory and are never written to the firmware
journal.

Use `bota.devices.getCapabilities().firmwareUpdate` before starting. A supported
browser must provide Web Bluetooth authorized-device enumeration, IndexedDB,
OPFS, and `fetch`. `bota.ota.updateFirmware()` streams the response into OPFS,
verifies its exact size, SHA-256, and CRC32 before GATT mutation, then delegates
transfer, verification, reboot, and reconnect sequencing to Rust. Durable
operations may be continued with `resumeFirmwareUpdate(operationId)` or stopped
with `cancelFirmwareUpdate(operationId)`.

Reload recovery validates the journal, checkpoint, and verified OPFS blob before
device mutation. Download, transfer, and verify recovery reconnect through only
the persisted authorized browser device ID and re-verify its serial before OTA
GATT. Terminal success first advances the optional journal `state` to
`cleanup_only`; reload then completes checkpoint, blob, and journal deletion
without resolving a provider or reconnecting to the device.

Firmware sources must use HTTPS. Plain HTTP is accepted only for deterministic
loopback tests. Reboot recovery uses `getDevices()` and only the exact browser
device ID saved by the verified connection; it never opens the picker or falls
back to a same-name device.

## Foreground scope

Supported:

- one explicit browser-selected connection per client;
- exact serial-number verification and explicit disconnect;
- model, hardware-revision, and firmware-revision reads when present;
- shared-core decoding of device status;
- a fresh shared-core decode of encrypted-upload-v2 capability `0406` when the
  firmware exposes it;
- durable, integrity-checked foreground firmware update with reload and reboot
  recovery;
- stable typed SDK errors and deterministic cleanup through `destroy()`.

Not yet supported:

- recording list, transfer, sync, or upload;
- provisioning, connection settings, remote recording control, or logs;
- automatic scan, saved-device reconnect, background work, or closed-tab work;
- browsers without Web Bluetooth;
- Bota API calls. Authentication and backend requests remain application-owned.
