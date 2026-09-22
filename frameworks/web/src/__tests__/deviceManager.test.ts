import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { BotaDeviceClient } from '../client.ts'
import { BotaSDKError } from '../errors.ts'
import { DeviceManager } from '../deviceManager.ts'
import { FOREGROUND_GATT_SERVICES } from '../gatt.ts'
import { createWasmCore } from '../wasmCore.ts'
import { WebBluetoothTransport } from '../webBluetoothTransport.ts'
import type {
  BrowserSdkStorage,
  VerifiedDeviceHint,
} from '../storage.ts'
import { FakeBrowserBluetoothTransport } from './fakeBluetooth.ts'

async function createManager(
  transport = new FakeBrowserBluetoothTransport(),
  storage: BrowserSdkStorage | null = null,
): Promise<{
  manager: DeviceManager
  transport: FakeBrowserBluetoothTransport
}> {
  const wasm = await readFile(
    new URL('../generated/bota_device_sdk_core_bg.wasm', import.meta.url),
  )
  const core = await createWasmCore(wasm)
  return {
    manager: new DeviceManager(core, transport, { storage }),
    transport,
  }
}

function memoryStorage(initialHint: VerifiedDeviceHint | null = null):
  BrowserSdkStorage & { savedHints: VerifiedDeviceHint[] } {
  const verifiedDevices = new Map<string, VerifiedDeviceHint>()
  if (initialHint) verifiedDevices.set(initialHint.serialNumber, initialHint)
  const checkpoints = new Map<string, unknown>()
  const savedHints: VerifiedDeviceHint[] = []
  return {
    namespace: 'test-tenant',
    savedHints,
    loadVerifiedDevice: async (serialNumber) =>
      verifiedDevices.get(serialNumber) ?? null,
    saveVerifiedDevice: async (hint) => {
      const copy = { ...hint }
      savedHints.push(copy)
      verifiedDevices.set(hint.serialNumber, copy)
    },
    deleteVerifiedDevice: async (serialNumber) => {
      verifiedDevices.delete(serialNumber)
    },
    loadWorkflowCheckpoint: async (operationId) =>
      checkpoints.get(operationId) ?? null,
    saveWorkflowCheckpoint: async (operationId, checkpoint) => {
      checkpoints.set(operationId, checkpoint)
    },
    deleteWorkflowCheckpoint: async (operationId) => {
      checkpoints.delete(operationId)
    },
    loadEncryptedUploadV2Checkpoint: async () => null,
    saveEncryptedUploadV2Checkpoint: async () => undefined,
    deleteEncryptedUploadV2Checkpoint: async () => undefined,
    saveEncryptedUploadV2Operation: async () => undefined,
    deleteEncryptedUploadV2Operation: async () => undefined,
    loadRecordingJournal: async () => null,
    saveRecordingJournal: async () => undefined,
    listRecordingJournals: async () => [],
    deleteRecordingJournal: async () => undefined,
    loadProvisioningJournal: async () => null,
    saveProvisioningJournal: async () => undefined,
    deleteProvisioningJournal: async () => undefined,
    loadFirmwareJournal: async () => null,
    saveFirmwareJournal: async () => undefined,
    deleteFirmwareJournal: async () => undefined,
    openBlob: async () => {
      throw new Error('blob access is outside this test')
    },
    clear: async () => undefined,
  }
}

async function settleWithWatchdog<T>(
  promise: Promise<T>,
  label: string,
): Promise<T> {
  let watchdog: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        watchdog = setTimeout(
          () => reject(new Error(`${label} did not settle`)),
          5_000,
        )
      }),
    ])
  } finally {
    if (watchdog) clearTimeout(watchdog)
  }
}

test('unsupported browsers fail before opening the device picker', async () => {
  const transport = new FakeBrowserBluetoothTransport()
  transport.isSupported = false
  const { manager } = await createManager(transport)

  await assert.rejects(
    manager.connect({ expectedSerialNumber: 'GDPPSBZJN6' }),
    (error: unknown) => {
      assert.ok(error instanceof BotaSDKError)
      assert.equal(error.code, 'unsupported_browser')
      return true
    },
  )
  assert.deepEqual(transport.calls, [])
})

test('browser capabilities are returned as one immutable manager snapshot', async () => {
  const transport = new FakeBrowserBluetoothTransport()
  transport.supportsAuthorizedDevices = false
  const { manager } = await createManager(transport)

  const capabilities = manager.getCapabilities()

  assert.deepEqual(capabilities, {
    bluetooth: true,
    authorizedDeviceReconnect: false,
    durableStorage: false,
    largeRecordingSync: false,
    firmwareUpdate: false,
  })
  assert.equal(Object.isFrozen(capabilities), true)

  transport.supportsAuthorizedDevices = true
  assert.equal(manager.getCapabilities(), capabilities)
  assert.equal(manager.getCapabilities().authorizedDeviceReconnect, false)
})

test('invalid expected identity fails before opening the device picker', async () => {
  const { manager, transport } = await createManager()

  await assert.rejects(
    manager.connect({ expectedSerialNumber: 'not a serial!' }),
    (error: unknown) => {
      assert.ok(error instanceof BotaSDKError)
      assert.equal(error.code, 'invalid_input')
      return true
    },
  )
  assert.deepEqual(transport.calls, [])
})

test('picker cancellation maps to the stable public error', async () => {
  const { manager, transport } = await createManager()
  transport.pickerError = new DOMException('private platform detail', 'NotFoundError')

  await assert.rejects(
    manager.connect({ expectedSerialNumber: 'GDPPSBZJN6' }),
    (error: unknown) => {
      assert.ok(error instanceof BotaSDKError)
      assert.equal(error.code, 'picker_cancelled')
      assert.doesNotMatch(error.message, /private platform detail/)
      return true
    },
  )
})

test('destroy while the picker is pending cancels before any GATT work', async () => {
  const transport = new FakeBrowserBluetoothTransport()
  let releasePicker!: () => void
  transport.pickerGate = new Promise<void>((resolve) => {
    releasePicker = resolve
  })
  const { manager } = await createManager(transport)
  const connecting = manager.connect({ expectedSerialNumber: 'GDPPSBZJN6' })

  assert.deepEqual(transport.calls, ['request_device'])
  await manager.destroy()

  const rejection = assert.rejects(connecting, (error: unknown) => {
    assert.ok(error instanceof BotaSDKError)
    assert.equal(error.code, 'cancelled')
    assert.equal(error.operation, 'connect')
    return true
  })
  releasePicker()
  await rejection

  assert.deepEqual(transport.calls, ['request_device'])
  assert.equal(manager.connectedDevice, null)
})

test('the browser picker requests the read-only device services', async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  let options: RequestDeviceOptions | undefined
  const nativeDevice = {
    id: 'browser-peripheral-1',
    name: 'Bota Pin',
  } as BluetoothDevice
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      bluetooth: {
        requestDevice: async (requested: RequestDeviceOptions) => {
          options = requested
          return nativeDevice
        },
      },
    },
  })

  try {
    const selected = await new WebBluetoothTransport().requestDevice()
    assert.equal(selected.id, nativeDevice.id)
    assert.deepEqual(options, {
      filters: [{ namePrefix: 'Bota' }],
      optionalServices: [...FOREGROUND_GATT_SERVICES],
    })
  } finally {
    if (originalNavigator) {
      Object.defineProperty(globalThis, 'navigator', originalNavigator)
    } else {
      Reflect.deleteProperty(globalThis, 'navigator')
    }
  }
})

test('a verified serial completes the shared Rust connection workflow', async () => {
  const { manager, transport } = await createManager()

  const connected = await manager.connect({ expectedSerialNumber: 'GDPPSBZJN6' })

  assert.deepEqual(connected, {
    id: 'browser-peripheral-1',
    name: 'Bota Pin',
    serialNumber: 'GDPPSBZJN6',
  })
  assert.deepEqual(transport.calls, [
    'request_device',
    'connect:browser-peripheral-1',
    'discover:browser-peripheral-1',
    'read:browser-peripheral-1:180A:2A25',
  ])
  assert.deepEqual(manager.connectedDevice, connected)
})

test('a verified picker connection durably saves its exact browser identity', async () => {
  const storage = memoryStorage()
  const { manager, transport } = await createManager(
    new FakeBrowserBluetoothTransport(),
    storage,
  )

  await manager.connect({ expectedSerialNumber: 'GDPPSBZJN6' })

  assert.equal(
    transport.calls.indexOf('read:browser-peripheral-1:180A:2A25')
      < transport.calls.length,
    true,
  )
  assert.deepEqual(storage.savedHints.map(({ updatedAtEpochMs: _, ...hint }) => hint), [
    {
      schemaVersion: 1,
      serialNumber: 'GDPPSBZJN6',
      browserDeviceId: 'browser-peripheral-1',
      name: 'Bota Pin',
    },
  ])
})

test('the public client composes picker persistence through the shared runtime', async () => {
  const wasm = await readFile(
    new URL('../generated/bota_device_sdk_core_bg.wasm', import.meta.url),
  )
  const core = await createWasmCore(wasm)
  const storage = memoryStorage()
  const transport = new FakeBrowserBluetoothTransport()
  const client = await BotaDeviceClient.create({
    coreLoader: async () => core,
    transport,
    storageNamespace: storage.namespace,
    storage,
  })

  await client.devices.connect({ expectedSerialNumber: 'GDPPSBZJN6' })

  assert.equal(storage.savedHints.at(-1)?.browserDeviceId, transport.device.id)
  await client.destroy()
})

test('reconnect enumerates authorized devices and selects only the persisted browser ID', async () => {
  const storage = memoryStorage({
    schemaVersion: 1,
    serialNumber: 'GDPPSBZJN6',
    browserDeviceId: 'browser-peripheral-1',
    name: 'Bota Pin',
    updatedAtEpochMs: 1,
  })
  const transport = new FakeBrowserBluetoothTransport()
  const sameName = { id: 'browser-peripheral-2', name: 'Bota Pin' }
  transport.authorizedDevices = [sameName, transport.device]
  transport.serialNumbers.set(sameName.id, 'GDPPSBZJN6')
  const { manager } = await createManager(transport, storage)

  const connected = await manager.reconnect({
    expectedSerialNumber: 'GDPPSBZJN6',
  })

  assert.deepEqual(connected, {
    id: 'browser-peripheral-1',
    name: 'Bota Pin',
    serialNumber: 'GDPPSBZJN6',
  })
  assert.equal(transport.calls[0], 'get_authorized_devices')
  assert.equal(transport.calls.includes('request_device'), false)
  assert.equal(
    transport.calls.includes('connect:browser-peripheral-2'),
    false,
  )
  assert.ok(
    transport.calls.includes('read:browser-peripheral-1:180A:2A25'),
  )
  assert.equal(storage.savedHints.at(-1)?.browserDeviceId, 'browser-peripheral-1')
})

test('destroyed reconnect waits for the exact late connection cleanup before rejecting', async () => {
  const storage = memoryStorage({
    schemaVersion: 1,
    serialNumber: 'GDPPSBZJN6',
    browserDeviceId: 'browser-peripheral-1',
    name: 'Bota Pin',
    updatedAtEpochMs: 1,
  })
  const transport = new FakeBrowserBluetoothTransport()
  let connectStarted!: () => void
  const atConnect = new Promise<void>((resolve) => {
    connectStarted = resolve
  })
  let releaseConnect!: () => void
  transport.connectGate = new Promise<void>((resolve) => {
    releaseConnect = resolve
  })
  transport.onConnect = connectStarted
  let disconnected!: () => void
  const atDisconnect = new Promise<void>((resolve) => {
    disconnected = resolve
  })
  transport.onDisconnect = disconnected
  const { manager } = await createManager(transport, storage)
  let reconnectSettled = false
  const reconnecting = manager.reconnect({
    expectedSerialNumber: 'GDPPSBZJN6',
  }).then(
    () => {
      reconnectSettled = true
      return null
    },
    (error: unknown) => {
      reconnectSettled = true
      return error
    },
  )
  await atConnect

  let destroySettled = false
  const destroying = manager.destroy().then(() => {
    destroySettled = true
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  const settledBeforeRelease = reconnectSettled
  assert.equal(destroySettled, false)
  releaseConnect()
  await settleWithWatchdog(destroying, 'manager destruction')
  const error = await settleWithWatchdog(reconnecting, 'reconnect rejection')
  await settleWithWatchdog(atDisconnect, 'late reconnect disconnect')

  assert.equal(settledBeforeRelease, false)
  assert.ok(error instanceof BotaSDKError)
  assert.equal(error.code, 'cancelled')
  assert.equal(error.operation, 'reconnect')
  assert.deepEqual(transport.calls, [
    'get_authorized_devices',
    'connect:browser-peripheral-1',
    'disconnect:browser-peripheral-1',
  ])
  assert.equal(manager.connectedDevice, null)
})

test('reconnect without getDevices requires the picker without opening it', async () => {
  const storage = memoryStorage({
    schemaVersion: 1,
    serialNumber: 'GDPPSBZJN6',
    browserDeviceId: 'browser-peripheral-1',
    name: 'Bota Pin',
    updatedAtEpochMs: 1,
  })
  const transport = new FakeBrowserBluetoothTransport()
  transport.supportsAuthorizedDevices = false
  const { manager } = await createManager(transport, storage)

  await assert.rejects(
    manager.reconnect({ expectedSerialNumber: 'GDPPSBZJN6' }),
    (error: unknown) => {
      assert.ok(error instanceof BotaSDKError)
      assert.equal(error.code, 'picker_required')
      assert.equal(error.operation, 'reconnect')
      return true
    },
  )
  assert.deepEqual(transport.calls, [])
})

test('reconnect never probes an authorized same-name device with another browser ID', async () => {
  const storage = memoryStorage({
    schemaVersion: 1,
    serialNumber: 'GDPPSBZJN6',
    browserDeviceId: 'browser-peripheral-1',
    name: 'Bota Pin',
    updatedAtEpochMs: 1,
  })
  const transport = new FakeBrowserBluetoothTransport()
  transport.authorizedDevices = [{
    id: 'browser-peripheral-2',
    name: 'Bota Pin',
  }]
  const { manager } = await createManager(transport, storage)

  await assert.rejects(
    manager.reconnect({ expectedSerialNumber: 'GDPPSBZJN6' }),
    (error: unknown) => {
      assert.ok(error instanceof BotaSDKError)
      assert.equal(error.code, 'connection_failed')
      assert.equal(error.operation, 'reconnect')
      return true
    },
  )
  assert.deepEqual(transport.calls, ['get_authorized_devices'])
})

test('reconnect rejects a wrong serial without falling back to a same-name browser ID', async () => {
  const storage = memoryStorage({
    schemaVersion: 1,
    serialNumber: 'GDPPSBZJN6',
    browserDeviceId: 'browser-peripheral-1',
    name: 'Bota Pin',
    updatedAtEpochMs: 1,
  })
  const transport = new FakeBrowserBluetoothTransport()
  const sameName = { id: 'browser-peripheral-2', name: 'Bota Pin' }
  transport.authorizedDevices = [transport.device, sameName]
  transport.serialNumbers.set(transport.device.id, 'OTHERDEVICE1')
  transport.serialNumbers.set(sameName.id, 'GDPPSBZJN6')
  const { manager } = await createManager(transport, storage)

  await assert.rejects(
    manager.reconnect({ expectedSerialNumber: 'GDPPSBZJN6' }),
    (error: unknown) => {
      assert.ok(error instanceof BotaSDKError)
      assert.equal(error.code, 'connection_failed')
      assert.equal(error.operation, 'reconnect')
      return true
    },
  )
  assert.ok(
    transport.calls.includes('read:browser-peripheral-1:180A:2A25'),
  )
  assert.equal(
    transport.calls.includes('connect:browser-peripheral-2'),
    false,
  )
})

test('identity mismatch disconnects the selected device before rejection', async () => {
  const { manager, transport } = await createManager()
  transport.serialNumber = 'OTHERDEVICE1'

  await assert.rejects(
    manager.connect({ expectedSerialNumber: 'GDPPSBZJN6' }),
    (error: unknown) => {
      assert.ok(error instanceof BotaSDKError)
      assert.equal(error.code, 'identity_mismatch')
      return true
    },
  )
  assert.equal(
    transport.calls.at(-1),
    'disconnect:browser-peripheral-1',
  )
  assert.equal(manager.connectedDevice, null)
})

test('identity mismatch remains stable when disconnect emits its browser event', async () => {
  const transport = new FakeBrowserBluetoothTransport()
  transport.serialNumber = 'OTHERDEVICE1'
  transport.emitDisconnectedOnDisconnect = true
  const { manager } = await createManager(transport)

  await assert.rejects(
    manager.connect({ expectedSerialNumber: 'GDPPSBZJN6' }),
    (error: unknown) => {
      assert.ok(error instanceof BotaSDKError)
      assert.equal(error.code, 'identity_mismatch')
      return true
    },
  )
  assert.equal(manager.connectedDevice, null)
})

test('a second connection cannot replace the active owner', async () => {
  const transport = new FakeBrowserBluetoothTransport()
  let releaseConnect!: () => void
  transport.connectGate = new Promise<void>((resolve) => {
    releaseConnect = resolve
  })
  const { manager } = await createManager(transport)
  const first = manager.connect({ expectedSerialNumber: 'GDPPSBZJN6' })
  await new Promise<void>((resolve) => setTimeout(resolve, 0))

  await assert.rejects(
    manager.connect({ expectedSerialNumber: 'GDPPSBZJN6' }),
    (error: unknown) => {
      assert.ok(error instanceof BotaSDKError)
      assert.equal(error.code, 'operation_in_progress')
      return true
    },
  )

  releaseConnect()
  await first
})

test('destroy while GATT connect is pending disconnects the late connection', async () => {
  const transport = new FakeBrowserBluetoothTransport()
  let releaseConnect!: () => void
  transport.connectGate = new Promise<void>((resolve) => {
    releaseConnect = resolve
  })
  const { manager } = await createManager(transport)
  const connecting = manager.connect({ expectedSerialNumber: 'GDPPSBZJN6' })
  await new Promise<void>((resolve) => setTimeout(resolve, 0))

  assert.deepEqual(transport.calls, [
    'request_device',
    'connect:browser-peripheral-1',
  ])

  const rejection = assert.rejects(connecting, (error: unknown) => {
    assert.ok(error instanceof BotaSDKError)
    assert.equal(error.code, 'cancelled')
    assert.equal(error.operation, 'connect')
    return true
  })
  let destroySettled = false
  const destroying = manager.destroy().then(() => {
    destroySettled = true
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(destroySettled, false)
  releaseConnect()
  await settleWithWatchdog(destroying, 'manager destruction')
  await rejection

  assert.deepEqual(transport.calls, [
    'request_device',
    'connect:browser-peripheral-1',
    'disconnect:browser-peripheral-1',
  ])
  assert.equal(manager.connectedDevice, null)
})

test('destroy during connection workflow cannot publish a late device', async () => {
  const transport = new FakeBrowserBluetoothTransport()
  let releaseDiscovery!: () => void
  transport.discoverGate = new Promise<void>((resolve) => {
    releaseDiscovery = resolve
  })
  const { manager } = await createManager(transport)
  const connecting = manager.connect({ expectedSerialNumber: 'GDPPSBZJN6' })
  await new Promise<void>((resolve) => setTimeout(resolve, 0))

  assert.deepEqual(transport.calls, [
    'request_device',
    'connect:browser-peripheral-1',
    'discover:browser-peripheral-1',
  ])
  const rejection = assert.rejects(connecting, (error: unknown) => {
    assert.ok(error instanceof BotaSDKError)
    assert.equal(error.code, 'cancelled')
    assert.equal(error.operation, 'connect')
    return true
  })
  let destroySettled = false
  const destroying = manager.destroy().then(() => {
    destroySettled = true
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(destroySettled, false)
  releaseDiscovery()
  await settleWithWatchdog(destroying, 'manager destruction')
  await rejection

  assert.equal(
    transport.calls.filter((call) => call === 'disconnect:browser-peripheral-1')
      .length,
    1,
  )
  assert.equal(manager.connectedDevice, null)
})

test('browser disconnect and destroy clear connection ownership', async () => {
  const { manager, transport } = await createManager()
  await manager.connect({ expectedSerialNumber: 'GDPPSBZJN6' })

  transport.emitDisconnected()
  assert.equal(manager.connectedDevice, null)

  await manager.destroy()
  await assert.rejects(
    manager.connect({ expectedSerialNumber: 'GDPPSBZJN6' }),
    (error: unknown) => {
      assert.ok(error instanceof BotaSDKError)
      assert.equal(error.code, 'cancelled')
      return true
    },
  )
})

test('explicit disconnect is idempotent', async () => {
  const { manager, transport } = await createManager()
  await manager.connect({ expectedSerialNumber: 'GDPPSBZJN6' })

  await manager.disconnect()
  await manager.disconnect()

  assert.equal(manager.connectedDevice, null)
  assert.equal(
    transport.calls.filter((call) => call === 'disconnect:browser-peripheral-1').length,
    1,
  )
})
