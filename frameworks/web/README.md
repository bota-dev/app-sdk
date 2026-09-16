# Bota SDK for Web

`@bota.dev/web-sdk` is the browser distribution of the Bota App SDK. The first
beta supports an explicit, foreground Web Bluetooth connection with exact
serial verification and read-only device identity, status, and capability
reads. Protocol sequencing and decoding come from the shared Rust core compiled
to WebAssembly.

## Install

```bash
npm install @bota.dev/web-sdk@1.2.0-beta.0
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

## Initial beta scope

Supported:

- one explicit browser-selected connection per client;
- exact serial-number verification and explicit disconnect;
- model, hardware-revision, and firmware-revision reads when present;
- shared-core decoding of device status;
- a fresh shared-core decode of encrypted-upload-v2 capability `0406` when the
  firmware exposes it;
- stable typed SDK errors and deterministic cleanup through `destroy()`.

Not yet supported:

- recording list, transfer, sync, or upload;
- provisioning, connection settings, remote recording control, OTA, or logs;
- automatic scan, saved-device reconnect, background work, or closed-tab work;
- browsers without Web Bluetooth;
- Bota API calls. Authentication and backend requests remain application-owned.
