import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { DeviceManager } from '../deviceManager.ts'
import { BotaSDKError } from '../errors.ts'
import {
  BOTA_CONTROL_SERVICE,
  BOTA_STORAGE_SERVICE,
  DEVICE_INFORMATION_SERVICE,
  DEVICE_STATUS_CHARACTERISTIC,
  FIRMWARE_REVISION_CHARACTERISTIC,
  HARDWARE_REVISION_CHARACTERISTIC,
  MODEL_NUMBER_CHARACTERISTIC,
  STORAGE_TRANSFER_CAPABILITIES_V2_CHARACTERISTIC,
} from '../gatt.ts'
import { BrowserTransportError } from '../transport.ts'
import { createWasmCore } from '../wasmCore.ts'
import { FakeBrowserBluetoothTransport } from './fakeBluetooth.ts'
import { FakeRecordingStorage } from './fakeProviders.ts'

const STATUS_BYTES = Uint8Array.from([
  0x43, 0x03, 0x03, 0x01, 0x00, 0xf1, 0x53, 0x65, 0x18, 0x00, 0x08,
  0x00, 0x02, 0x14, 0x03, 0x68, 0x10, 0x49, 0x4d, 0x45, 0x49, 0x3d,
  0x31, 0x32, 0x33, 0x0a, 0x52, 0x4f, 0x41, 0x4d, 0x3d, 0x31, 0x0a,
])
const CAPABILITY_BYTES = Uint8Array.from([
  0x01, 0x02, 0x18, 0x00, 0x7f, 0x00, 0x00, 0x00, 0x98, 0x01, 0x44,
  0x02, 0xf4, 0x00, 0x10, 0x00, 0x08, 0x00, 0x00, 0x00, 0x04, 0x00,
  0x00, 0x00,
])

async function connectedManager(): Promise<{
  manager: DeviceManager
  transport: FakeBrowserBluetoothTransport
}> {
  const wasm = await readFile(
    new URL('../generated/bota_device_sdk_core_bg.wasm', import.meta.url),
  )
  const core = await createWasmCore(wasm)
  const transport = new FakeBrowserBluetoothTransport()
  transport.setRead(
    DEVICE_INFORMATION_SERVICE,
    MODEL_NUMBER_CHARACTERISTIC,
    new TextEncoder().encode('Bota Pin'),
  )
  transport.setRead(
    DEVICE_INFORMATION_SERVICE,
    HARDWARE_REVISION_CHARACTERISTIC,
    new TextEncoder().encode('WL83-A'),
  )
  transport.setRead(
    DEVICE_INFORMATION_SERVICE,
    FIRMWARE_REVISION_CHARACTERISTIC,
    new TextEncoder().encode('1.4.0'),
  )
  transport.setRead(
    BOTA_CONTROL_SERVICE,
    DEVICE_STATUS_CHARACTERISTIC,
    STATUS_BYTES,
  )
  transport.setRead(
    BOTA_STORAGE_SERVICE,
    STORAGE_TRANSFER_CAPABILITIES_V2_CHARACTERISTIC,
    CAPABILITY_BYTES,
  )
  const manager = new DeviceManager(core, transport)
  await manager.connect({ expectedSerialNumber: 'GDPPSBZJN6' })
  transport.calls.length = 0
  return { manager, transport }
}

test('snapshot returns exact identity and shared-core decoded status and capabilities', async () => {
  const { manager } = await connectedManager()

  const snapshot = await manager.readSnapshot()

  assert.deepEqual(snapshot.identity, {
    serialNumber: 'GDPPSBZJN6',
    modelNumber: 'Bota Pin',
    hardwareRevision: 'WL83-A',
    firmwareRevision: '1.4.0',
  })
  assert.equal(snapshot.status.batteryPercent, 67)
  assert.equal(snapshot.status.pendingRecordings, 1)
  assert.equal(snapshot.capabilities.encryptedUploadV2?.maximumSignedBlobBytes, 408)
  assert.ok(snapshot.capturedAt instanceof Date)
})

test('every snapshot performs a fresh encrypted v2 capability read', async () => {
  const { manager, transport } = await connectedManager()

  await manager.readSnapshot()
  await manager.readSnapshot()

  assert.equal(
    transport.calls.filter(
      (call) =>
        call ===
        `read:browser-peripheral-1:${BOTA_STORAGE_SERVICE}:${STORAGE_TRANSFER_CAPABILITIES_V2_CHARACTERISTIC}`,
    ).length,
    2,
  )
})

test('an absent encrypted v2 capability characteristic maps to null', async () => {
  const { manager, transport } = await connectedManager()
  transport.failRead(
    BOTA_STORAGE_SERVICE,
    STORAGE_TRANSFER_CAPABILITIES_V2_CHARACTERISTIC,
    new BrowserTransportError('characteristic_not_found'),
  )

  const snapshot = await manager.readSnapshot()

  assert.equal(snapshot.capabilities.encryptedUploadV2, null)
})

test('malformed encrypted v2 capabilities map to protocol_error', async () => {
  const { manager, transport } = await connectedManager()
  transport.setRead(
    BOTA_STORAGE_SERVICE,
    STORAGE_TRANSFER_CAPABILITIES_V2_CHARACTERISTIC,
    Uint8Array.of(0x01),
  )

  await assert.rejects(manager.readSnapshot(), hasCode('protocol_error'))
})

test('malformed device status maps to protocol_error', async () => {
  const { manager, transport } = await connectedManager()
  transport.setRead(
    BOTA_CONTROL_SERVICE,
    DEVICE_STATUS_CHARACTERISTIC,
    Uint8Array.of(0x00),
  )

  await assert.rejects(manager.readSnapshot(), hasCode('protocol_error'))
})

test('a changed serial disconnects and rejects the snapshot', async () => {
  const { manager, transport } = await connectedManager()
  transport.serialNumber = 'OTHERDEVICE1'

  await assert.rejects(manager.readSnapshot(), hasCode('identity_mismatch'))
  assert.equal(manager.connectedDevice, null)
  assert.equal(transport.calls.at(-1), 'disconnect:browser-peripheral-1')
})

test('snapshot re-verifies the exact serial after reconnect without picker fallback', async () => {
  const wasm = await readFile(
    new URL('../generated/bota_device_sdk_core_bg.wasm', import.meta.url),
  )
  const core = await createWasmCore(wasm)
  const transport = new FakeBrowserBluetoothTransport()
  const storage = new FakeRecordingStorage()
  const manager = new DeviceManager(core, transport, { storage })
  await manager.connect({ expectedSerialNumber: 'GDPPSBZJN6' })
  await manager.disconnect()
  await manager.reconnect({ expectedSerialNumber: 'GDPPSBZJN6' })
  transport.calls.length = 0
  transport.serialNumber = 'OTHERDEVICE1'

  await assert.rejects(manager.readSnapshot(), hasCode('identity_mismatch'))
  assert.equal(transport.calls.includes('request_device'), false)
  assert.equal(transport.calls.includes('get_authorized_devices'), false)
  assert.equal(manager.connectedDevice, null)
})

test('a GATT disconnect during snapshot reads maps to device_disconnected', async () => {
  const { manager, transport } = await connectedManager()
  transport.failRead(
    DEVICE_INFORMATION_SERVICE,
    MODEL_NUMBER_CHARACTERISTIC,
    new BrowserTransportError('disconnected'),
  )

  await assert.rejects(manager.readSnapshot(), hasCode('device_disconnected'))
})

function hasCode(code: BotaSDKError['code']): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof BotaSDKError)
    assert.equal(error.code, code)
    return true
  }
}
