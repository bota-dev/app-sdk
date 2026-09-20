import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { BotaDeviceClient } from '../client.ts'
import type {
  CoreBridge,
  CoreConnectionSettings,
  CoreDeviceModel,
} from '../core.ts'
import { DeviceManager } from '../deviceManager.ts'
import { BotaSDKError, type BotaSDKErrorCode } from '../errors.ts'
import {
  API_ENDPOINT_CHARACTERISTIC,
  AUTH_NONCE_CHARACTERISTIC,
  BOTA_AUTH_SERVICE,
  BOTA_PROVISIONING_SERVICE,
  DEVICE_COMMAND_CHARACTERISTIC,
  DEVICE_INFORMATION_SERVICE,
  DEVICE_PUBLIC_KEY_CHARACTERISTIC,
  DEVICE_SETTINGS_CHARACTERISTIC,
  DEVICE_TOKEN_CHARACTERISTIC,
  MODEL_NUMBER_CHARACTERISTIC,
  PROVISIONING_RESULT_CHARACTERISTIC,
  SERIAL_NUMBER_CHARACTERISTIC,
  canonicalGattUuid,
} from '../gatt.ts'
import type { DeviceConnectionSettings } from '../models.ts'
import type {
  ProvisioningMaterial,
  ProvisioningPrepareContext,
  ProvisioningProvider,
} from '../providers.ts'
import { ProvisioningManager } from '../provisioningManager.ts'
import type { ProvisioningJournal } from '../storage.ts'
import { createWasmCore } from '../wasmCore.ts'
import { BrowserWorkflowRuntime } from '../workflowRuntime.ts'
import { FakeBrowserBluetoothTransport } from './fakeBluetooth.ts'
import { deferred, FakeRecordingStorage } from './fakeProviders.ts'

const SERIAL = 'GDPPSBZJN6'
const OTHER_SERIAL = 'OTHER123'
const NONCE = Uint8Array.from({ length: 16 }, (_, index) => index + 1)
const DEVICE_PUBLIC_KEY = Uint8Array.from(
  { length: 64 },
  (_, index) => 0x40 + index,
)

const wasmBytes = readFile(
  new URL('../generated/bota_device_sdk_core_bg.wasm', import.meta.url),
)

interface ProviderPrepareRecord {
  snapshot: ProvisioningPrepareContext
  references: ProvisioningPrepareContext
}

interface ProviderAbortRecord {
  attemptId: string
  serialNumber: string
  reason: BotaSDKErrorCode
}

class FakeProvisioningProvider implements ProvisioningProvider {
  readonly events: string[]
  readonly prepares: ProviderPrepareRecord[] = []
  readonly materials: ProvisioningMaterial[] = []
  readonly confirms: Array<{ attemptId: string; serialNumber: string }> = []
  readonly aborts: ProviderAbortRecord[] = []
  prepareHandler: (
    context: ProvisioningPrepareContext,
  ) => Promise<ProvisioningMaterial> = async (context) =>
    materialFor(context.attemptId)
  confirmFailuresRemaining = 0
  confirmError: unknown = new Error(
    'https://secret.example.invalid token=raw-device-token',
  )

  constructor(events: string[] = []) {
    this.events = events
  }

  async prepare(
    context: ProvisioningPrepareContext,
  ): Promise<ProvisioningMaterial> {
    this.events.push(`provider:prepare:${context.attemptId}`)
    this.prepares.push({
      snapshot: {
        attemptId: context.attemptId,
        serialNumber: context.serialNumber,
        nonce: context.nonce.slice(),
        devicePublicKey: context.devicePublicKey.slice(),
      },
      references: context,
    })
    const material = await this.prepareHandler(context)
    this.materials.push(material)
    return material
  }

  async confirm(context: {
    attemptId: string
    serialNumber: string
  }): Promise<void> {
    this.events.push(`provider:confirm:${context.attemptId}`)
    this.confirms.push({ ...context })
    if (this.confirmFailuresRemaining > 0) {
      this.confirmFailuresRemaining -= 1
      throw this.confirmError
    }
  }

  async abort(context: ProviderAbortRecord): Promise<void> {
    this.events.push(`provider:abort:${context.attemptId}:${context.reason}`)
    this.aborts.push({ ...context })
  }
}

class FakeProvisioningStorage extends FakeRecordingStorage {
  readonly provisioningJournals = new Map<string, ProvisioningJournal>()

  override async loadProvisioningJournal(
    attemptId: string,
  ): Promise<ProvisioningJournal | null> {
    const journal = this.provisioningJournals.get(attemptId)
    return journal ? { ...journal } : null
  }

  override async saveProvisioningJournal(
    journal: ProvisioningJournal,
  ): Promise<void> {
    this.events.push(`journal:${journal.attemptId}:${journal.phase}`)
    this.provisioningJournals.set(journal.attemptId, { ...journal })
  }

  override async deleteProvisioningJournal(attemptId: string): Promise<void> {
    this.provisioningJournals.delete(attemptId)
  }

  override async clear(): Promise<void> {
    await super.clear()
    this.provisioningJournals.clear()
  }
}

interface Harness {
  core: CoreBridge
  devices: DeviceManager
  events: string[]
  manager: ProvisioningManager
  provider: FakeProvisioningProvider
  runtime: BrowserWorkflowRuntime
  storage: FakeProvisioningStorage
  transport: FakeBrowserBluetoothTransport
}

async function createHarness(options: {
  deprovisionTimeoutMs?: number
  provider?: FakeProvisioningProvider
} = {}): Promise<Harness> {
  const events: string[] = []
  const core = await createWasmCore(await wasmBytes)
  const transport = new FakeBrowserBluetoothTransport()
  transport.eventLog = events
  transport.setRead(BOTA_AUTH_SERVICE, AUTH_NONCE_CHARACTERISTIC, NONCE)
  transport.setRead(
    BOTA_AUTH_SERVICE,
    DEVICE_PUBLIC_KEY_CHARACTERISTIC,
    DEVICE_PUBLIC_KEY,
  )
  transport.setRead(
    DEVICE_INFORMATION_SERVICE,
    MODEL_NUMBER_CHARACTERISTIC,
    new TextEncoder().encode('Bota Pin'),
  )
  const storage = new FakeProvisioningStorage(undefined, events)
  const provider = options.provider ?? new FakeProvisioningProvider(events)
  const runtime = new BrowserWorkflowRuntime(core, transport)
  const devices = new DeviceManager(core, transport, { runtime, storage })
  let now = 1_700_000_000_000
  const manager = new ProvisioningManager({
    core,
    transport,
    runtime,
    devices,
    storage,
    provider,
    now: () => ++now,
    deprovisionTimeoutMs: options.deprovisionTimeoutMs,
  })
  await devices.connect({ expectedSerialNumber: SERIAL })
  events.length = 0
  transport.calls.length = 0
  transport.writes.length = 0
  return {
    core,
    devices,
    events,
    manager,
    provider,
    runtime,
    storage,
    transport,
  }
}

test('provision passes fresh exact context, scrubs material, and closes the backend loop in order', async () => {
  const harness = await createHarness()
  const attemptId = 'caller attempt/1+opaque'
  const transientWrites: Array<{
    characteristicUuid: string
    value: Uint8Array
  }> = []
  const write = harness.transport.write.bind(harness.transport)
  harness.transport.write = async (
    device,
    serviceUuid,
    characteristicUuid,
    value,
    withResponse,
  ) => {
    transientWrites.push({ characteristicUuid, value })
    await write(device, serviceUuid, characteristicUuid, value, withResponse)
  }

  const provision = harness.manager.provision({ attemptId })
  await completePhysicalProvisioning(harness)
  assert.equal(await provision, undefined)

  assert.equal(harness.provider.prepares.length, 1)
  assert.deepEqual(harness.provider.prepares[0]?.snapshot, {
    attemptId,
    serialNumber: SERIAL,
    nonce: NONCE,
    devicePublicKey: DEVICE_PUBLIC_KEY,
  })
  assert.ok(harness.transport.calls.some((call) =>
    call.includes(SERIAL_NUMBER_CHARACTERISTIC)
  ))
  assert.deepEqual(harness.provider.confirms, [{
    attemptId,
    serialNumber: SERIAL,
  }])
  assert.deepEqual(harness.provider.aborts, [])
  assert.deepEqual(harness.storage.provisioningJournals.get(attemptId), {
    schemaVersion: 1,
    attemptId,
    serialNumber: SERIAL,
    phase: 'backend_confirmed',
    updatedAtEpochMs: 1_700_000_000_003,
  })
  assert.ok(
    eventIndex(harness.events, `journal:${attemptId}:device_applied`)
      < eventIndex(harness.events, `provider:confirm:${attemptId}`),
  )
  assert.ok(
    eventIndex(harness.events, `provider:confirm:${attemptId}`)
      < eventIndex(harness.events, `journal:${attemptId}:backend_confirmed`),
  )
  assertBufferWasScrubbed(
    harness.provider.prepares[0]?.references.nonce,
    'provider nonce',
  )
  assertBufferWasScrubbed(
    harness.provider.prepares[0]?.references.devicePublicKey,
    'provider device public key',
  )
  assertBufferWasScrubbed(
    harness.provider.materials[0]?.apiEndpoint,
    'provider API endpoint',
  )
  assertBufferWasScrubbed(
    harness.provider.materials[0]?.deviceToken,
    'provider device token',
  )
  const sensitiveWrites = transientWrites.filter((entry) => {
    const characteristic = canonicalGattUuid(entry.characteristicUuid)
    return characteristic === canonicalGattUuid(API_ENDPOINT_CHARACTERISTIC)
      || characteristic === canonicalGattUuid(DEVICE_TOKEN_CHARACTERISTIC)
  })
  assert.ok(sensitiveWrites.length > 0)
  assert.ok(sensitiveWrites.every((entry) => allZero(entry.value)))
  assert.deepEqual(
    Object.keys(harness.storage.provisioningJournals.get(attemptId) ?? {}).sort(),
    ['attemptId', 'phase', 'schemaVersion', 'serialNumber', 'updatedAtEpochMs'],
  )
})

test('backend prepare alone never completes binding and cancellation aborts it', async () => {
  const harness = await createHarness()
  const attemptId = 'prepared-only-attempt'
  const controller = new AbortController()
  const blockedWrite = deferred<void>()
  harness.transport.writeGate = blockedWrite.promise

  const provision = harness.manager.provision({
    attemptId,
    signal: controller.signal,
  })
  const rejected = assert.rejects(provision, cancelled('provision'))
  await eventually(() =>
    harness.storage.provisioningJournals.get(attemptId)?.phase === 'prepared'
  )

  assert.equal(harness.provider.confirms.length, 0)
  assert.equal(
    harness.storage.provisioningJournals.get(attemptId)?.phase,
    'prepared',
  )
  controller.abort()
  await settleWithWatchdog(rejected, 'prepared provisioning cancellation')
  blockedWrite.resolve(undefined)

  assert.equal(harness.provider.aborts.length, 1)
  assert.equal(harness.provider.aborts[0]?.reason, 'cancelled')
  assert.equal(
    harness.storage.provisioningJournals.get(attemptId)?.phase,
    'aborted',
  )
})

test('physical provisioning rejection aborts the backend and leaves no confirmed bind', async () => {
  const harness = await createHarness()
  const attemptId = 'physical-rejection-attempt'

  const provision = harness.manager.provision({ attemptId })
  const rejected = assert.rejects(provision, (error: unknown) =>
    error instanceof BotaSDKError
      && error.code === 'protocol_error'
      && error.operation === 'provision'
  )
  await completePhysicalProvisioning(harness, 0x04)
  await rejected

  assert.deepEqual(harness.provider.confirms, [])
  assert.deepEqual(harness.provider.aborts, [{
    attemptId,
    serialNumber: SERIAL,
    reason: 'protocol_error',
  }])
  assert.equal(
    harness.storage.provisioningJournals.get(attemptId)?.phase,
    'aborted',
  )
  assert.ok(
    eventIndex(harness.events, `provider:abort:${attemptId}:protocol_error`)
      < eventIndex(harness.events, `journal:${attemptId}:aborted`),
  )
})

test('confirm failure is retryable and the same attempt resumes confirm without device I/O', async () => {
  const harness = await createHarness()
  const attemptId = 'confirm-retry-attempt'
  harness.provider.confirmFailuresRemaining = 1

  const first = harness.manager.provision({ attemptId })
  const failed = assert.rejects(first, (error: unknown) => {
    assert.ok(error instanceof BotaSDKError)
    assert.equal(error.code, 'internal_error')
    assert.equal(error.operation, 'provision')
    assert.equal(error.retryable, true)
    assert.equal(String(error).includes('secret.example.invalid'), false)
    assert.equal('cause' in error, false)
    return true
  })
  await completePhysicalProvisioning(harness)
  await failed

  assert.equal(
    harness.storage.provisioningJournals.get(attemptId)?.phase,
    'device_applied',
  )
  assert.equal(harness.provider.aborts.length, 0)
  harness.transport.calls.length = 0
  harness.transport.writes.length = 0

  await harness.manager.provision({ attemptId })

  assert.equal(harness.provider.prepares.length, 1)
  assert.equal(harness.provider.confirms.length, 2)
  assert.deepEqual(harness.transport.calls, [])
  assert.deepEqual(harness.transport.writes, [])
  assert.equal(
    harness.storage.provisioningJournals.get(attemptId)?.phase,
    'backend_confirmed',
  )
})

test('cancelled late prepare cannot dispatch into or mutate a newer attempt', async () => {
  const events: string[] = []
  const provider = new FakeProvisioningProvider(events)
  const latePrepare = deferred<ProvisioningMaterial>()
  provider.prepareHandler = async (context) => {
    if (context.attemptId === 'old-attempt') return await latePrepare.promise
    return materialFor(context.attemptId, 0x31, 0xb1)
  }
  const harness = await createHarness({ provider })
  provider.events.splice(0, provider.events.length, ...harness.events)
  const controller = new AbortController()

  const oldProvision = harness.manager.provision({
    attemptId: 'old-attempt',
    signal: controller.signal,
  })
  const oldRejected = assert.rejects(oldProvision, cancelled('provision'))
  await eventually(() => provider.prepares.length === 1)
  controller.abort()
  await settleWithWatchdog(oldRejected, 'old provisioning cancellation')

  const newProvision = harness.manager.provision({ attemptId: 'new-attempt' })
  await eventually(() => provider.prepares.length === 2)
  const staleMaterial = materialFor('old-attempt', 0x22, 0xee)
  latePrepare.resolve(staleMaterial)
  await eventually(() => allZero(staleMaterial.apiEndpoint)
    && allZero(staleMaterial.deviceToken))
  await completePhysicalProvisioning(harness)
  await newProvision

  assert.equal(
    harness.storage.provisioningJournals.has('old-attempt'),
    false,
  )
  assert.equal(
    harness.storage.provisioningJournals.get('new-attempt')?.phase,
    'backend_confirmed',
  )
  assert.equal(provider.aborts.filter((call) =>
    call.attemptId === 'old-attempt'
  ).length, 1)
})

test('client destruction cancels provisioning, scrubs inputs, and rejects a late provider result', async () => {
  const core = await createWasmCore(await wasmBytes)
  const transport = new FakeBrowserBluetoothTransport()
  transport.setRead(BOTA_AUTH_SERVICE, AUTH_NONCE_CHARACTERISTIC, NONCE)
  transport.setRead(
    BOTA_AUTH_SERVICE,
    DEVICE_PUBLIC_KEY_CHARACTERISTIC,
    DEVICE_PUBLIC_KEY,
  )
  transport.setRead(
    DEVICE_INFORMATION_SERVICE,
    MODEL_NUMBER_CHARACTERISTIC,
    new TextEncoder().encode('Bota Pin'),
  )
  const storage = new FakeProvisioningStorage()
  const provider = new FakeProvisioningProvider()
  const latePrepare = deferred<ProvisioningMaterial>()
  provider.prepareHandler = async () => await latePrepare.promise
  const client = await BotaDeviceClient.create({
    coreLoader: async () => core,
    transport,
    storage,
    providers: { provisioning: provider },
  })
  await client.devices.connect({ expectedSerialNumber: SERIAL })

  const provision = client.provisioning.provision({
    attemptId: 'destroyed-attempt',
  })
  const rejected = assert.rejects(provision, cancelled('provision'))
  await eventually(() => provider.prepares.length === 1)
  await settleWithWatchdog(client.destroy(), 'client destruction')
  await rejected

  assertBufferWasScrubbed(
    provider.prepares[0]?.references.nonce,
    'destroyed provider nonce',
  )
  assertBufferWasScrubbed(
    provider.prepares[0]?.references.devicePublicKey,
    'destroyed provider public key',
  )
  const staleMaterial = materialFor('destroyed-attempt', 0x44, 0xdd)
  latePrepare.resolve(staleMaterial)
  await eventually(() => allZero(staleMaterial.apiEndpoint)
    && allZero(staleMaterial.deviceToken))
  assert.equal(
    storage.provisioningJournals.has('destroyed-attempt'),
    false,
  )
})

test('deprovision writes grant, subscribes, then sends the Rust opcode and correlates only the post-command result', async () => {
  const harness = await createHarness()
  const grant = Uint8Array.of(0xaa, 0xbb, 0xcc)
  harness.transport.onSubscribe = () => {
    harness.transport.emitNotification(
      harness.transport.device,
      BOTA_PROVISIONING_SERVICE,
      PROVISIONING_RESULT_CHARACTERISTIC,
      Uint8Array.of(0x04),
    )
  }
  harness.transport.onWrite = () => {
    const write = harness.transport.writes.at(-1)
    if (write?.value.byteLength === 1 && write.value[0] === 0x05) {
      queueMicrotask(() => {
        harness.transport.emitNotification(
          harness.transport.device,
          BOTA_PROVISIONING_SERVICE,
          PROVISIONING_RESULT_CHARACTERISTIC,
          Uint8Array.of(0x00),
        )
      })
    }
  }

  const result = await harness.manager.deprovision({ grant })

  assert.deepEqual(result, { success: true })
  const grantWrite = writeEvent(harness.events, bytesHex(grant))
  const subscribe = eventIndex(harness.events, 'subscribe:')
  const commandWrite = writeEvent(harness.events, '05')
  const unsubscribe = eventIndex(harness.events, 'unsubscribe:')
  assert.ok(grantWrite < subscribe)
  assert.ok(subscribe < commandWrite)
  assert.ok(commandWrite < unsubscribe)
  assert.equal(harness.transport.writes.length, 2)
  assert.ok(harness.transport.writes.every((write) => write.withResponse))
  assert.equal(
    harness.transport.writes[1]?.characteristicUuid,
    DEVICE_COMMAND_CHARACTERISTIC,
  )
})

test('deprovision timeout is stable, non-reset, and always unsubscribes', async () => {
  const harness = await createHarness({ deprovisionTimeoutMs: 10 })

  await assert.rejects(
    harness.manager.deprovision({ grant: Uint8Array.of(0x91, 0x92) }),
    (error: unknown) => {
      assert.ok(error instanceof BotaSDKError)
      assert.equal(error.code, 'connection_failed')
      assert.equal(error.operation, 'deprovision')
      assert.equal(error.retryable, true)
      assert.equal(String(error).toLowerCase().includes('reset'), false)
      return true
    },
  )

  assert.ok(harness.events.some((event) => event.startsWith('unsubscribe:')))
})

test('deprovision cancellation waits for an in-flight command write before unsubscribe', async () => {
  const harness = await createHarness({ deprovisionTimeoutMs: 1_000 })
  const controller = new AbortController()
  const writeGate = deferred<void>()
  harness.transport.onWrite = () => {
    const write = harness.transport.writes.at(-1)
    if (write?.value.byteLength === 1 && write.value[0] === 0x05) {
      harness.transport.writeGate = writeGate.promise
    }
  }

  let settled = false
  const operation = harness.manager.deprovision({
    grant: Uint8Array.of(0x81, 0x82),
    signal: controller.signal,
  }).finally(() => {
    settled = true
  })
  const rejected = assert.rejects(operation, cancelled('deprovision'))
  await eventually(() => harness.transport.writes.some((write) =>
    write.value.byteLength === 1 && write.value[0] === 0x05
  ))

  controller.abort()
  await settleReducer()
  assert.equal(settled, false)
  assert.equal(
    harness.events.some((event) => event.startsWith('unsubscribe:')),
    false,
  )

  writeGate.resolve(undefined)
  await settleWithWatchdog(rejected, 'deprovision write cancellation')
  assert.ok(
    eventIndex(harness.events, 'write_settled:05')
      < eventIndex(harness.events, 'unsubscribe:'),
  )
})

test('settings reads use Rust defaults after fresh serial and model verification', async () => {
  const harness = await createHarness()
  harness.transport.setRead(
    DEVICE_INFORMATION_SERVICE,
    MODEL_NUMBER_CHARACTERISTIC,
    new TextEncoder().encode('Bota Note'),
  )
  harness.transport.setRead(
    BOTA_PROVISIONING_SERVICE,
    DEVICE_SETTINGS_CHARACTERISTIC,
    Uint8Array.of(0x03, 0, 0, 0, 0, 0, 0, 0),
  )

  const settings = await harness.manager.readConnectionSettings()

  assert.deepEqual(settings, {
    enabledConnections: { wifi: true, cellular: true },
    heartbeatEnabledConnections: { wifi: true, cellular: true },
    uploadNetworkPreference: ['wifi', 'ble', 'cellular'],
    powerManagement: {
      cellularIdleTimeoutSeconds: 180,
      wifiIdleTimeoutSeconds: 180,
    },
    streamingEnabled: true,
    streamingFlushIntervalSeconds: 60,
  })
  const serialRead = eventIndex(harness.events, `:${SERIAL_NUMBER_CHARACTERISTIC}`)
  const modelRead = eventIndex(harness.events, `:${MODEL_NUMBER_CHARACTERISTIC}`)
  const settingsRead = eventIndex(harness.events, `:${DEVICE_SETTINGS_CHARACTERISTIC}`)
  assert.ok(serialRead < modelRead)
  assert.ok(modelRead < settingsRead)
})

test('settings write passes the fresh Note model to Rust and performs one canonical v2 response write', async () => {
  const harness = await createHarness()
  harness.transport.setRead(
    DEVICE_INFORMATION_SERVICE,
    MODEL_NUMBER_CHARACTERISTIC,
    new TextEncoder().encode('Bota Note'),
  )
  const settings: DeviceConnectionSettings = {
    enabledConnections: { wifi: true, cellular: true },
    heartbeatEnabledConnections: { wifi: true, cellular: true },
    uploadNetworkPreference: ['cellular', 'wifi', 'ble'],
    powerManagement: {
      cellularIdleTimeoutSeconds: 180,
      wifiIdleTimeoutSeconds: 180,
    },
    streamingEnabled: true,
    streamingFlushIntervalSeconds: 60,
  }
  const originalEncoder = harness.core.encodeConnectionSettings.bind(harness.core)
  const encoderCalls: Array<{
    settings: CoreConnectionSettings
    model: CoreDeviceModel
  }> = []
  harness.core.encodeConnectionSettings = (value, model) => {
    encoderCalls.push({
      settings: structuredClone(value),
      model,
    })
    return originalEncoder(value, model)
  }
  const expected = originalEncoder({
    ...settings,
    enabledConnections: { wifi: true, cellular: false },
    heartbeatEnabledConnections: { wifi: true, cellular: false },
    uploadNetworkPreference: ['wifi', 'ble'],
  }, 'pin_4g')

  await harness.manager.writeConnectionSettings(settings)

  assert.deepEqual(encoderCalls, [{ settings, model: 'note' }])
  assert.deepEqual(settings.enabledConnections, { wifi: true, cellular: true })
  assert.deepEqual(settings.heartbeatEnabledConnections, {
    wifi: true,
    cellular: true,
  })
  const writes = harness.transport.writes.filter((write) =>
    canonicalGattUuid(write.characteristicUuid)
      === canonicalGattUuid(DEVICE_SETTINGS_CHARACTERISTIC)
  )
  assert.equal(writes.length, 1)
  assert.equal(writes[0]?.withResponse, true)
  assert.deepEqual(writes[0]?.value, expected)
  assert.equal(writes[0]?.value[0], 0x02)
  assert.equal(writes[0]?.value[9], 0x81)
})

test('settings hold the shared runtime owner and reject a changed serial before settings I/O', async () => {
  const harness = await createHarness()
  harness.transport.setRead(
    DEVICE_INFORMATION_SERVICE,
    MODEL_NUMBER_CHARACTERISTIC,
    new TextEncoder().encode('Bota Pin'),
  )
  const settings: DeviceConnectionSettings = {
    enabledConnections: { wifi: true, cellular: true },
    heartbeatEnabledConnections: { wifi: true, cellular: true },
    uploadNetworkPreference: ['wifi', 'ble', 'cellular'],
    powerManagement: {
      cellularIdleTimeoutSeconds: 180,
      wifiIdleTimeoutSeconds: 180,
    },
    streamingEnabled: true,
    streamingFlushIntervalSeconds: 60,
  }
  const writeGate = deferred<void>()
  harness.transport.onWrite = () => {
    const write = harness.transport.writes.at(-1)
    if (
      write
      && canonicalGattUuid(write.characteristicUuid)
        === canonicalGattUuid(DEVICE_SETTINGS_CHARACTERISTIC)
    ) {
      harness.transport.writeGate = writeGate.promise
    }
  }

  const first = harness.manager.writeConnectionSettings(settings)
  await eventually(() => harness.transport.writes.some((write) =>
    canonicalGattUuid(write.characteristicUuid)
      === canonicalGattUuid(DEVICE_SETTINGS_CHARACTERISTIC)
  ))
  await assert.rejects(
    harness.manager.readConnectionSettings(),
    (error: unknown) => error instanceof BotaSDKError
      && error.code === 'operation_in_progress'
      && error.operation === 'settings',
  )
  writeGate.resolve(undefined)
  await first

  harness.transport.writes.length = 0
  harness.transport.calls.length = 0
  harness.transport.serialNumber = OTHER_SERIAL
  await assert.rejects(
    harness.manager.writeConnectionSettings(settings),
    (error: unknown) => error instanceof BotaSDKError
      && error.code === 'identity_mismatch'
      && error.operation === 'settings',
  )
  assert.equal(harness.transport.writes.length, 0)
  assert.equal(harness.transport.calls.some((call) =>
    call.includes(DEVICE_SETTINGS_CHARACTERISTIC)
  ), false)
})

function materialFor(
  attemptId: string,
  endpoint = 0x21,
  token = 0xd1,
): ProvisioningMaterial {
  return {
    materialId: `material-${attemptId}`,
    apiEndpoint: Uint8Array.of(endpoint),
    deviceToken: Uint8Array.of(token, token + 1, token + 2, token + 3),
    mtu: 64,
  }
}

async function completePhysicalProvisioning(
  harness: Harness,
  status = 0,
): Promise<void> {
  await eventually(() => harness.transport.writes.some((write) =>
    canonicalGattUuid(write.characteristicUuid)
      === canonicalGattUuid(DEVICE_TOKEN_CHARACTERISTIC)
  ))
  await settleReducer()
  harness.transport.emitNotification(
    harness.transport.device,
    BOTA_PROVISIONING_SERVICE,
    PROVISIONING_RESULT_CHARACTERISTIC,
    Uint8Array.of(status),
  )
}

function cancelled(operation: 'provision' | 'deprovision') {
  return (error: unknown): boolean =>
    error instanceof BotaSDKError
      && error.code === 'cancelled'
      && error.operation === operation
}

function eventIndex(events: readonly string[], fragment: string): number {
  const index = events.findIndex((event) => event.includes(fragment))
  assert.notEqual(index, -1, `missing event containing ${fragment}`)
  return index
}

function writeEvent(events: readonly string[], hex: string): number {
  return eventIndex(events, `:${true}:${hex}`)
}

function bytesHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function allZero(value: Uint8Array | undefined): boolean {
  return value !== undefined && value.every((byte) => byte === 0)
}

function assertBufferWasScrubbed(
  value: Uint8Array | undefined,
  label: string,
): void {
  assert.ok(value, `${label} was not captured`)
  assert.ok(allZero(value), `${label} was not scrubbed`)
}

async function eventually(
  predicate: () => boolean,
  message = 'condition did not become true',
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  assert.fail(message)
}

async function settleReducer(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))
}

async function settleWithWatchdog<T>(
  promise: Promise<T>,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle`)), 5_000)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
