import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  BotaDeviceClient,
  BotaSDKError,
  ControlManager,
  DeviceManager,
  LogManager,
  OTAManager,
  ProvisioningManager,
  RecordingManager,
  WiFiManager,
} from '../index.ts'
import * as publicApi from '../index.ts'
import { createWasmCore } from '../wasmCore.ts'
import { FakeBrowserBluetoothTransport } from './fakeBluetooth.ts'
import {
  deferred,
  FakeRecordingStorage,
} from './fakeProviders.ts'

const SERIAL = 'GDPPSBZJN6'
const NAMESPACE = 'organization:project:user'
const wasmBytes = readFile(
  new URL('../generated/bota_device_sdk_core_bg.wasm', import.meta.url),
)

class ObservedStorage extends FakeRecordingStorage {
  clearCalls = 0
  clearGate: Promise<void> | null = null

  override async clear(): Promise<void> {
    this.clearCalls += 1
    if (this.clearGate) await this.clearGate
    await super.clear()
  }
}

async function createClient(options: {
  storageNamespace?: string
  storage?: ObservedStorage
  transport?: FakeBrowserBluetoothTransport
} = {}): Promise<{
  client: BotaDeviceClient
  storage: ObservedStorage | undefined
  transport: FakeBrowserBluetoothTransport
}> {
  const core = await createWasmCore(await wasmBytes)
  const transport = options.transport ?? new FakeBrowserBluetoothTransport()
  const client = await BotaDeviceClient.create({
    coreLoader: async () => core,
    transport,
    ...(options.storageNamespace === undefined
      ? {}
      : { storageNamespace: options.storageNamespace }),
    ...(options.storage === undefined ? {} : { storage: options.storage }),
  })
  return { client, storage: options.storage, transport }
}

test('the root module exports only the approved browser runtime values', () => {
  assert.deepEqual(Object.keys(publicApi).sort(), [
    'BotaDeviceClient',
    'BotaSDKError',
    'ControlManager',
    'DeviceManager',
    'LogManager',
    'OTAManager',
    'ProvisioningManager',
    'RecordingManager',
    'WiFiManager',
  ])
})

test('read-only construction needs neither durable storage nor providers', async () => {
  const { client, transport } = await createClient()

  assert.ok(client.devices instanceof DeviceManager)
  assert.ok(client.recordings instanceof RecordingManager)
  assert.ok(client.provisioning instanceof ProvisioningManager)
  assert.ok(client.wifi instanceof WiFiManager)
  assert.ok(client.controls instanceof ControlManager)
  assert.ok(client.ota instanceof OTAManager)
  assert.ok(client.logs instanceof LogManager)
  assert.strictEqual(client.devices, client.devices)
  assert.strictEqual(client.recordings, client.recordings)
  assert.deepEqual(transport.calls, [])

  await assert.rejects(
    client.recordings.listPendingOperations(),
    isSdkError('storage_unavailable'),
  )
  await assert.rejects(
    client.provisioning.provision({ attemptId: 'attempt-without-provider' }),
    isSdkError('unsupported_capability'),
  )
  await assert.rejects(
    client.devices.reconnect({ expectedSerialNumber: SERIAL }),
    isSdkError('picker_required'),
  )
  await assert.rejects(
    client.controls.startRecording({ authorityId: 'authority-without-provider' }),
    isSdkError('unsupported_capability'),
  )
  assert.deepEqual(transport.calls, [])

  await client.destroy()
})

test('caller storage requires the exact requested tenant namespace', async () => {
  const storage = new ObservedStorage('organization:project:other-user')
  const core = await createWasmCore(await wasmBytes)
  const transport = new FakeBrowserBluetoothTransport()

  await assert.rejects(
    BotaDeviceClient.create({
      coreLoader: async () => core,
      transport,
      storageNamespace: NAMESPACE,
      storage,
    }),
    isSdkError('invalid_input'),
  )
  await assert.rejects(
    BotaDeviceClient.create({
      coreLoader: async () => core,
      transport,
      storage,
    }),
    isSdkError('invalid_input'),
  )
  const emptyStorage = new ObservedStorage(' ')
  await assert.rejects(
    BotaDeviceClient.create({
      coreLoader: async () => core,
      transport,
      storageNamespace: ' ',
      storage: emptyStorage,
    }),
    isSdkError('invalid_input'),
  )
  assert.equal(storage.clearCalls, 0)
  assert.deepEqual(transport.calls, [])
})

test('clearPersistedData is tenant-local, BLE-free, and repeatable after destroy', async () => {
  const storage = new ObservedStorage(NAMESPACE)
  const otherTenant = new ObservedStorage('organization:project:other-user')
  storage.verifiedDevices.set(SERIAL, verifiedHint(SERIAL))
  otherTenant.verifiedDevices.set('OTHERDEVICE1', verifiedHint('OTHERDEVICE1'))
  const { client, transport } = await createClient({
    storageNamespace: NAMESPACE,
    storage,
  })

  await client.destroy()
  const callsAfterDestroy = [...transport.calls]
  await client.clearPersistedData()
  await client.clearPersistedData()

  assert.equal(storage.clearCalls, 2)
  assert.equal(storage.verifiedDevices.size, 0)
  assert.equal(otherTenant.clearCalls, 0)
  assert.equal(otherTenant.verifiedDevices.has('OTHERDEVICE1'), true)
  assert.deepEqual(transport.calls, callsAfterDestroy)
})

test('one shared coordinator rejects a second manager operation', async () => {
  const storage = new ObservedStorage(NAMESPACE)
  const transport = new FakeBrowserBluetoothTransport()
  const { client } = await createClient({
    storageNamespace: NAMESPACE,
    storage,
    transport,
  })
  await client.devices.connect({ expectedSerialNumber: SERIAL })
  transport.calls.length = 0
  const readEntered = deferred<void>()
  const releaseRead = deferred<void>()
  transport.onRead = () => readEntered.resolve(undefined)
  transport.readGate = releaseRead.promise

  const snapshot = client.devices.readSnapshot()
  await readEntered.promise
  await assert.rejects(client.wifi.readStatus(), isSdkError('operation_in_progress'))
  await assert.rejects(
    client.clearPersistedData(),
    isSdkError('operation_in_progress'),
  )
  assert.equal(storage.clearCalls, 0)

  const destroy = client.destroy()
  const clearAfterDestroy = client.clearPersistedData()
  assert.equal(await isSettled(destroy), false)
  assert.equal(await isSettled(clearAfterDestroy), false)
  assert.equal(storage.clearCalls, 0)
  assert.equal(transport.calls.some((call) => call.startsWith('disconnect:')), false)
  releaseRead.resolve(undefined)
  await assert.rejects(snapshot, isSdkError('cancelled'))
  await Promise.all([destroy, clearAfterDestroy])
  assert.equal(storage.clearCalls, 1)
  assert.equal(transport.calls.at(-1), 'disconnect:browser-peripheral-1')
})

test('destroy is immediately terminal across managers and joins workflow cleanup', async () => {
  const storage = new ObservedStorage(NAMESPACE)
  const transport = new FakeBrowserBluetoothTransport()
  const { client } = await createClient({
    storageNamespace: NAMESPACE,
    storage,
    transport,
  })
  await client.devices.connect({ expectedSerialNumber: SERIAL })
  transport.calls.length = 0
  const writeEntered = deferred<void>()
  const releaseWrite = deferred<void>()
  transport.onWrite = () => writeEntered.resolve(undefined)
  transport.writeGate = releaseWrite.promise
  const subscription = client.logs.subscribe(() => undefined)
  await writeEntered.promise

  const firstDestroy = client.destroy()
  const secondDestroy = client.destroy()
  await assert.rejects(client.devices.disconnect(), isSdkError('cancelled'))
  await assert.rejects(client.wifi.readStatus(), isSdkError('cancelled'))
  await assert.rejects(client.recordings.list(), isSdkError('cancelled'))
  await assert.rejects(
    client.recordings.cancel('transfer_recording:after-destroy'),
    isSdkError('cancelled'),
  )
  await assert.rejects(
    client.provisioning.readConnectionSettings(),
    isSdkError('cancelled'),
  )
  await assert.rejects(
    client.controls.startRecording({ authorityId: 'after-destroy' }),
    isSdkError('cancelled'),
  )
  await assert.rejects(client.logs.subscribe(() => undefined), isSdkError('cancelled'))
  await assert.rejects(
    client.ota.cancelFirmwareUpdate('update_firmware:after-destroy'),
    isSdkError('cancelled'),
  )
  assert.equal(await isSettled(firstDestroy), false)
  assert.equal(transport.calls.some((call) => call.startsWith('disconnect:')), false)

  releaseWrite.resolve(undefined)
  await assert.rejects(subscription, isSdkError('cancelled'))
  await Promise.all([firstDestroy, secondDestroy])
  assert.equal(
    transport.calls.filter((call) => call.startsWith('unsubscribe:')).length,
    1,
  )
  assert.equal(
    transport.calls.filter((call) => call === 'disconnect:browser-peripheral-1').length,
    1,
  )
})

test('logs reverify the exact active serial after reconnect without picker fallback', async () => {
  const storage = new ObservedStorage(NAMESPACE)
  const transport = new FakeBrowserBluetoothTransport()
  const { client } = await createClient({
    storageNamespace: NAMESPACE,
    storage,
    transport,
  })
  await client.devices.connect({ expectedSerialNumber: SERIAL })
  await client.devices.disconnect()
  await client.devices.reconnect({ expectedSerialNumber: SERIAL })
  transport.calls.length = 0
  transport.serialNumber = 'OTHERDEVICE1'

  try {
    await assert.rejects(
      client.logs.subscribe(() => undefined),
      isSdkError('identity_mismatch'),
    )
    assert.equal(transport.calls.includes('request_device'), false)
    assert.equal(transport.calls.includes('get_authorized_devices'), false)
    assert.equal(transport.calls.some((call) => call.startsWith('write:')), false)
  } finally {
    await client.destroy()
  }
})

function verifiedHint(serialNumber: string) {
  return {
    schemaVersion: 1 as const,
    serialNumber,
    browserDeviceId: 'browser-peripheral-1',
    name: 'Bota Pin',
    updatedAtEpochMs: 1_789_000_000_000,
  }
}

function isSdkError(code: BotaSDKError['code']): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof BotaSDKError)
    assert.equal(error.code, code)
    return true
  }
}

async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  const marker = Symbol('pending')
  return await Promise.race([
    promise.then(() => true, () => true),
    Promise.resolve(marker),
  ]) !== marker
}
