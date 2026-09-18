import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { BotaSDKError } from '../errors.ts'
import { DeviceManager } from '../deviceManager.ts'
import { FOREGROUND_GATT_SERVICES } from '../gatt.ts'
import { createWasmCore } from '../wasmCore.ts'
import { WebBluetoothTransport } from '../webBluetoothTransport.ts'
import { FakeBrowserBluetoothTransport } from './fakeBluetooth.ts'

async function createManager(
  transport = new FakeBrowserBluetoothTransport(),
): Promise<{ manager: DeviceManager; transport: FakeBrowserBluetoothTransport }> {
  const wasm = await readFile(
    new URL('../generated/bota_device_sdk_core_bg.wasm', import.meta.url),
  )
  const core = await createWasmCore(wasm)
  return { manager: new DeviceManager(core, transport), transport }
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
  await manager.destroy()

  const rejection = assert.rejects(connecting, (error: unknown) => {
    assert.ok(error instanceof BotaSDKError)
    assert.equal(error.code, 'cancelled')
    assert.equal(error.operation, 'connect')
    return true
  })
  releaseConnect()
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
  await manager.destroy()

  const rejection = assert.rejects(connecting, (error: unknown) => {
    assert.ok(error instanceof BotaSDKError)
    assert.equal(error.code, 'cancelled')
    assert.equal(error.operation, 'connect')
    return true
  })
  releaseDiscovery()
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
