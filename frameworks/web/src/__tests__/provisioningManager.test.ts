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
import { WebCoreBridge as GeneratedWebCoreBridge } from '../generated/bota_device_sdk_core.js'
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
import type { BrowserSdkStorage, ProvisioningJournal } from '../storage.ts'
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
  snapshot: Omit<ProvisioningPrepareContext, 'signal'>
  references: ProvisioningPrepareContext
  signal: AbortSignal
}

interface ProviderAbortRecord {
  attemptId: string
  serialNumber: string
  reason: BotaSDKErrorCode
}

type ProviderConfirmContext = Parameters<ProvisioningProvider['confirm']>[0]
type ProviderAbortContext = Parameters<ProvisioningProvider['abort']>[0]

class FakeProvisioningProvider implements ProvisioningProvider {
  readonly events: string[]
  readonly prepares: ProviderPrepareRecord[] = []
  readonly materials: ProvisioningMaterial[] = []
  readonly confirms: Array<{ attemptId: string; serialNumber: string }> = []
  readonly aborts: ProviderAbortRecord[] = []
  readonly confirmSignals: AbortSignal[] = []
  readonly abortSignals: AbortSignal[] = []
  prepareHandler: (
    context: ProvisioningPrepareContext,
  ) => Promise<ProvisioningMaterial> = async (context) =>
    materialFor(context.materialId)
  confirmHandler: (
    context: ProviderConfirmContext,
  ) => Promise<void> = async () => undefined
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
        materialId: context.materialId,
        serialNumber: context.serialNumber,
        nonce: context.nonce.slice(),
        devicePublicKey: context.devicePublicKey.slice(),
      },
      references: context,
      signal: context.signal,
    })
    const material = await this.prepareHandler(context)
    this.materials.push(material)
    return material
  }

  async confirm(context: ProviderConfirmContext): Promise<void> {
    this.events.push(`provider:confirm:${context.attemptId}`)
    this.confirms.push({
      attemptId: context.attemptId,
      serialNumber: context.serialNumber,
    })
    this.confirmSignals.push(context.signal)
    await this.confirmHandler(context)
    if (this.confirmFailuresRemaining > 0) {
      this.confirmFailuresRemaining -= 1
      throw this.confirmError
    }
  }

  async abort(context: ProviderAbortContext): Promise<void> {
    this.events.push(`provider:abort:${context.attemptId}:${context.reason}`)
    this.aborts.push({
      attemptId: context.attemptId,
      serialNumber: context.serialNumber,
      reason: context.reason,
    })
    this.abortSignals.push(context.signal)
  }
}

test('destroy aborts and stops waiting for a never-settling confirm provider', async () => {
  const harness = await createHarness()
  const attemptId = 'never-settling-confirm-attempt'
  const entered = deferred<void>()
  harness.provider.confirmHandler = async () => {
    entered.resolve(undefined)
    return await new Promise<never>(() => undefined)
  }
  harness.storage.provisioningJournals.set(attemptId, {
    schemaVersion: 1,
    attemptId,
    materialId: `material-${attemptId}`,
    serialNumber: SERIAL,
    phase: 'device_applied',
    updatedAtEpochMs: 1_700_000_000_000,
  })
  const provisioning = harness.manager.provision({ attemptId })
  void provisioning.catch(() => undefined)
  await entered.promise

  await settleWithWatchdog(
    harness.manager.destroy(),
    'never-settling provisioning confirm destruction',
  )
  await assert.rejects(provisioning, cancelled('provision'))
  assert.equal(harness.provider.confirmSignals[0]?.aborted, true)
  assert.equal(
    harness.storage.provisioningJournals.get(attemptId)?.phase,
    'device_applied',
  )
})

class FakeProvisioningStorage extends FakeRecordingStorage {
  readonly provisioningJournals = new Map<string, ProvisioningJournal>()
  onSaveProvisioningJournal: (
    (journal: ProvisioningJournal) => Promise<void> | void
  ) | null = null

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
    await this.onSaveProvisioningJournal?.(journal)
    this.provisioningJournals.set(journal.attemptId, { ...journal })
  }

  async listProvisioningJournals(): Promise<ProvisioningJournal[]> {
    return [...this.provisioningJournals.values()].map((journal) => ({ ...journal }))
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
  const prepared = harness.provider.prepares[0]?.snapshot
  assert.ok(prepared)
  assert.match(prepared.materialId, /^web-[0-9a-f]{32}$/)
  assert.equal(
    harness.provider.materials[0]?.materialId,
    prepared.materialId,
  )
  assert.deepEqual({
    attemptId: prepared.attemptId,
    serialNumber: prepared.serialNumber,
    nonce: prepared.nonce,
    devicePublicKey: prepared.devicePublicKey,
  }, {
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
    materialId: prepared.materialId,
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
    [
      'attemptId',
      'materialId',
      'phase',
      'schemaVersion',
      'serialNumber',
      'updatedAtEpochMs',
    ],
  )
})

test('provision rejects a cross-material prepare result before any sensitive device write', async () => {
  const harness = await createHarness()
  const returned: { value: ProvisioningMaterial | null } = { value: null }
  harness.provider.prepareHandler = async (context) => {
    returned.value = materialFor(`${context.materialId}-stale`, 0x61, 0xe1)
    return returned.value
  }

  let operationSettled = false
  const operation = harness.manager.provision({
    attemptId: 'material-mismatch-attempt',
  }).finally(() => {
    operationSettled = true
  })
  const rejected = assert.rejects(
    operation,
    (error: unknown) => error instanceof BotaSDKError
      && error.code === 'internal_error'
      && error.operation === 'provision'
      && error.retryable,
  )
  for (let attempt = 0; attempt < 200 && !operationSettled; attempt += 1) {
    if (harness.transport.writes.some((write) =>
      canonicalGattUuid(write.characteristicUuid)
        === canonicalGattUuid(DEVICE_TOKEN_CHARACTERISTIC)
    )) {
      await completePhysicalProvisioning(harness)
      break
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  await rejected

  assert.ok(returned.value)
  assert.ok(allZero(returned.value.apiEndpoint))
  assert.ok(allZero(returned.value.deviceToken))
  assert.equal(harness.transport.writes.some((write) => {
    const characteristic = canonicalGattUuid(write.characteristicUuid)
    return characteristic === canonicalGattUuid(API_ENDPOINT_CHARACTERISTIC)
      || characteristic === canonicalGattUuid(DEVICE_TOKEN_CHARACTERISTIC)
  }), false)
  assert.equal(
    harness.storage.provisioningJournals.has('material-mismatch-attempt'),
    false,
  )
  assert.deepEqual(harness.provider.aborts, [{
    attemptId: 'material-mismatch-attempt',
    serialNumber: SERIAL,
    reason: 'internal_error',
  }])
})

test('provisioning zeroes transient WASM bridge byte copies after synchronous bridge calls', async () => {
  const prototype = GeneratedWebCoreBridge.prototype as unknown as {
    dispatch(this: GeneratedWebCoreBridge, event: unknown): unknown
  }
  const originalDispatch = prototype.dispatch
  const bridgeCopies: Array<Uint8Array | number[]> = []
  prototype.dispatch = function (event: unknown): unknown {
    collectBridgeByteArrays(event, bridgeCopies)
    const effects = originalDispatch.call(this, event)
    collectBridgeByteArrays(effects, bridgeCopies)
    return effects
  }

  try {
    const harness = await createHarness()
    const provision = harness.manager.provision({ attemptId: 'bridge-scrub-attempt' })
    await completePhysicalProvisioning(harness)
    await provision
  } finally {
    prototype.dispatch = originalDispatch
  }

  assert.ok(bridgeCopies.length > 0)
  assert.ok(bridgeCopies.every((value) => value.every((byte) => byte === 0)))
})

test('backend prepare alone never completes binding and cancellation requests abort without overclaiming it', async () => {
  const harness = await createHarness()
  const attemptId = 'prepared-only-attempt'
  const controller = new AbortController()
  const blockedWrite = deferred<void>()
  harness.transport.writeGate = blockedWrite.promise

  const provision = harness.manager.provision({
    attemptId,
    signal: controller.signal,
  })
  let operationSettled = false
  const rejected = assert.rejects(provision.finally(() => {
    operationSettled = true
  }), cancelled('provision'))
  await eventually(() =>
    harness.storage.provisioningJournals.get(attemptId)?.phase === 'prepared'
  )

  assert.equal(harness.provider.confirms.length, 0)
  assert.equal(
    harness.storage.provisioningJournals.get(attemptId)?.phase,
    'prepared',
  )
  controller.abort()
  await settleReducer()
  assert.equal(operationSettled, false)
  blockedWrite.resolve(undefined)
  await settleWithWatchdog(rejected, 'prepared provisioning cancellation')

  assert.equal(harness.provider.aborts.length, 1)
  assert.equal(harness.provider.aborts[0]?.reason, 'cancelled')
  assert.equal(harness.provider.abortSignals[0]?.aborted, true)
  assert.equal(
    harness.storage.provisioningJournals.get(attemptId)?.phase,
    'prepared',
  )
})

test('cancel and destroy join a blocked provisioning write before releasing ownership or scrubbing its bytes', async () => {
  const harness = await createHarness()
  harness.transport.setRead(
    BOTA_PROVISIONING_SERVICE,
    DEVICE_SETTINGS_CHARACTERISTIC,
    Uint8Array.of(0x03, 0, 0, 0, 0, 0, 0, 0),
  )
  const writeGate = deferred<void>()
  const writeEntered = deferred<void>()
  const transportWrite = harness.transport.write.bind(harness.transport)
  let inFlightToken: Uint8Array | null = null
  harness.transport.write = async (
    device,
    serviceUuid,
    characteristicUuid,
    value,
    withResponse,
  ) => {
    if (
      canonicalGattUuid(characteristicUuid)
        === canonicalGattUuid(DEVICE_TOKEN_CHARACTERISTIC)
    ) {
      inFlightToken = value
      harness.transport.writeGate = writeGate.promise
      writeEntered.resolve(undefined)
    }
    await transportWrite(device, serviceUuid, characteristicUuid, value, withResponse)
  }
  const sibling = new ProvisioningManager({
    core: harness.core,
    transport: harness.transport,
    runtime: harness.runtime,
    devices: harness.devices,
    storage: harness.storage,
    provider: harness.provider,
  })
  const controller = new AbortController()
  const provision = harness.manager.provision({
    attemptId: 'blocked-token-write',
    signal: controller.signal,
  })
  const rejected = assert.rejects(provision, cancelled('provision'))
  await settleWithWatchdog(writeEntered.promise, 'provisioning token write start')

  controller.abort()
  let destroySettled = false
  const destroying = harness.manager.destroy().then(() => {
    destroySettled = true
  })
  await settleReducer()
  assert.equal(destroySettled, false)
  assert.ok(inFlightToken)
  assert.equal(allZero(inFlightToken), false)
  await assert.rejects(
    sibling.readConnectionSettings(),
    operationInProgress('settings'),
  )

  writeGate.resolve(undefined)
  await settleWithWatchdog(destroying, 'blocked provisioning destroy')
  await settleWithWatchdog(rejected, 'blocked provisioning cancellation')
  assert.ok(inFlightToken)
  assert.ok(allZero(inFlightToken))
  assert.ok(harness.provider.materials.every((material) =>
    allZero(material.apiEndpoint) && allZero(material.deviceToken)
  ))
  const writesAfterSettlement = harness.transport.writes.length
  await settleReducer()
  assert.equal(harness.transport.writes.length, writesAfterSettlement)
  await sibling.readConnectionSettings()
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

test('cleanup failure after physical success never aborts or records the attempt as aborted', async () => {
  const harness = await createHarness()
  const subscribe = harness.transport.subscribe.bind(harness.transport)
  harness.transport.subscribe = async (...args) => {
    const subscription = await subscribe(...args)
    return {
      remove: async () => {
        await subscription.remove()
        throw new Error('cleanup failed with token=raw-device-token')
      },
    }
  }

  const provision = harness.manager.provision({
    attemptId: 'post-success-cleanup-failure',
  })
  await completePhysicalProvisioning(harness)
  await assert.rejects(provision, (error: unknown) => {
    assert.ok(error instanceof BotaSDKError)
    assert.equal(error.code, 'internal_error')
    assert.equal(error.operation, 'provision')
    assert.equal(String(error).includes('raw-device-token'), false)
    return true
  })

  assert.deepEqual(harness.provider.aborts, [])
  assert.equal(
    harness.storage.provisioningJournals.get('post-success-cleanup-failure')?.phase,
    'backend_confirmed',
  )
})

test('physical success retains the shared owner through device_applied durability and confirm', async () => {
  const harness = await createHarness({ deprovisionTimeoutMs: 20 })
  const saveEntered = deferred<void>()
  const saveGate = deferred<void>()
  harness.storage.onSaveProvisioningJournal = async (journal) => {
    if (journal.phase !== 'device_applied') return
    saveEntered.resolve(undefined)
    await saveGate.promise
  }
  const sibling = new ProvisioningManager({
    core: harness.core,
    transport: harness.transport,
    runtime: harness.runtime,
    devices: harness.devices,
    storage: harness.storage,
    provider: harness.provider,
  })

  const provision = harness.manager.provision({
    attemptId: 'blocked-device-applied-save',
  })
  await completePhysicalProvisioning(harness)
  await settleWithWatchdog(saveEntered.promise, 'device_applied save start')

  await assert.rejects(
    sibling.deprovision({ grant: Uint8Array.of(0x71) }),
    operationInProgress('deprovision'),
  )
  await assert.rejects(
    sibling.readConnectionSettings(),
    operationInProgress('settings'),
  )
  await assert.rejects(
    sibling.provision({ attemptId: 'new-attempt-during-save' }),
    operationInProgress('provision'),
  )
  assert.equal(harness.provider.confirms.length, 0)

  saveGate.resolve(undefined)
  await settleWithWatchdog(provision, 'provisioning durable handoff')
  assert.equal(
    harness.storage.provisioningJournals.get('blocked-device-applied-save')?.phase,
    'backend_confirmed',
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

test('prepared recovery is a typed fail-closed reconciliation state for the exact material', async () => {
  const harness = await createHarness()
  const journal: ProvisioningJournal = {
    schemaVersion: 1,
    attemptId: 'ambiguous-prepared-attempt',
    materialId: 'web-11111111111111111111111111111111',
    serialNumber: SERIAL,
    phase: 'prepared',
    updatedAtEpochMs: 1_700_000_000_000,
  }
  harness.storage.provisioningJournals.set(journal.attemptId, journal)

  await assert.rejects(
    harness.manager.provision({ attemptId: journal.attemptId }),
    (error: unknown) => error instanceof BotaSDKError
      && error.code === 'reconciliation_required'
      && error.operation === 'provision'
      && error.retryable,
  )

  assert.deepEqual(harness.storage.provisioningJournals.get(journal.attemptId), journal)
  assert.deepEqual(harness.provider.prepares, [])
  assert.deepEqual(harness.provider.confirms, [])
  assert.deepEqual(harness.provider.aborts, [])
  assert.deepEqual(harness.transport.writes, [])
  assert.ok(harness.transport.calls.some((call) =>
    call.includes(SERIAL_NUMBER_CHARACTERISTIC)
  ))

  const crossAttemptController = new AbortController()
  let crossAttemptSettled = false
  const crossAttempt = harness.manager.provision({
    attemptId: 'unrelated-attempt',
    signal: crossAttemptController.signal,
  }).finally(() => {
    crossAttemptSettled = true
  })
  const crossAttemptRejected = assert.rejects(
    crossAttempt,
    (error: unknown) => error instanceof BotaSDKError
      && error.code === 'reconciliation_required'
      && error.operation === 'provision'
      && error.retryable,
  )
  await settleReducer()
  if (!crossAttemptSettled) crossAttemptController.abort()
  await crossAttemptRejected
  assert.deepEqual(harness.provider.prepares, [])
})

test('a pre-material prepared journal retains typed fail-closed recovery', async () => {
  const harness = await createHarness()
  const journal: ProvisioningJournal = {
    schemaVersion: 1,
    attemptId: 'legacy-ambiguous-attempt',
    materialId: null,
    serialNumber: SERIAL,
    phase: 'prepared',
    updatedAtEpochMs: 1_700_000_000_000,
  }
  harness.storage.provisioningJournals.set(journal.attemptId, journal)

  await assert.rejects(
    harness.manager.provision({ attemptId: journal.attemptId }),
    (error: unknown) => error instanceof BotaSDKError
      && error.code === 'reconciliation_required'
      && error.operation === 'provision'
      && error.retryable,
  )

  assert.deepEqual(harness.storage.provisioningJournals.get(journal.attemptId), journal)
  assert.deepEqual(harness.provider.prepares, [])
  assert.deepEqual(harness.provider.confirms, [])
  assert.deepEqual(harness.provider.aborts, [])
  assert.deepEqual(harness.transport.writes, [])
})

test('exact-attempt recovery supports a base custom storage adapter without journal listing', async () => {
  const harness = await createHarness()
  const attemptId = 'base-storage-confirm-recovery'
  harness.storage.provisioningJournals.set(attemptId, {
    schemaVersion: 1,
    attemptId,
    materialId: 'material-base-storage-confirm-recovery',
    serialNumber: SERIAL,
    phase: 'device_applied',
    updatedAtEpochMs: 1_700_000_000_000,
  })
  const storage = new Proxy(harness.storage, {
    get(target, property) {
      if (property === 'listProvisioningJournals') return undefined
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as BrowserSdkStorage
  const manager = new ProvisioningManager({
    core: harness.core,
    transport: harness.transport,
    runtime: harness.runtime,
    devices: harness.devices,
    storage,
    provider: harness.provider,
  })

  await manager.provision({ attemptId })

  assert.deepEqual(harness.provider.prepares, [])
  assert.deepEqual(harness.provider.confirms, [{
    attemptId,
    serialNumber: SERIAL,
  }])
  assert.equal(
    harness.storage.provisioningJournals.get(attemptId)?.phase,
    'backend_confirmed',
  )
  assert.deepEqual(harness.transport.writes, [])
})

test('prepared recovery identity mismatch disconnects stale state and permits reconnect', async () => {
  const harness = await createHarness()
  const attemptId = 'prepared-identity-mismatch'
  harness.storage.provisioningJournals.set(attemptId, {
    schemaVersion: 1,
    attemptId,
    materialId: 'web-22222222222222222222222222222222',
    serialNumber: SERIAL,
    phase: 'prepared',
    updatedAtEpochMs: 1_700_000_000_000,
  })
  harness.transport.serialNumber = OTHER_SERIAL

  await assert.rejects(
    harness.manager.provision({ attemptId }),
    (error: unknown) => error instanceof BotaSDKError
      && error.code === 'identity_mismatch'
      && error.operation === 'provision',
  )

  assert.equal(
    harness.transport.calls.filter((call) => call.startsWith('disconnect:')).length,
    1,
  )
  assert.equal(harness.devices.connectedDevice, null)
  assert.equal(harness.runtime.connectedDeviceHandle, null)
  await assert.rejects(
    harness.manager.readConnectionSettings(),
    (error: unknown) => error instanceof BotaSDKError
      && error.code === 'device_disconnected'
      && error.operation === 'settings',
  )

  harness.transport.serialNumber = SERIAL
  const reconnected = await harness.devices.reconnect({
    expectedSerialNumber: SERIAL,
  })
  assert.equal(reconnected.serialNumber, SERIAL)
  assert.equal(
    (harness.devices.connectedDevice as { serialNumber: string } | null)
      ?.serialNumber,
    SERIAL,
  )
})

test('cancelled confirm releases SDK ownership and ignores late provider success', async () => {
  const harness = await createHarness()
  const oldConfirmEntered = deferred<void>()
  const oldConfirmGate = deferred<void>()
  let confirmsInFlight = 0
  let maximumConfirmsInFlight = 0
  harness.provider.confirmHandler = async (context) => {
    confirmsInFlight += 1
    maximumConfirmsInFlight = Math.max(maximumConfirmsInFlight, confirmsInFlight)
    try {
      if (context.attemptId === 'old-confirm-attempt') {
        oldConfirmEntered.resolve(undefined)
        await oldConfirmGate.promise
      }
    } finally {
      confirmsInFlight -= 1
    }
  }
  for (const attemptId of ['old-confirm-attempt', 'new-confirm-attempt']) {
    harness.storage.provisioningJournals.set(attemptId, {
      schemaVersion: 1,
      attemptId,
      materialId: `material-${attemptId}`,
      serialNumber: SERIAL,
      phase: 'device_applied',
      updatedAtEpochMs: 1_700_000_000_000,
    })
  }
  const sibling = new ProvisioningManager({
    core: harness.core,
    transport: harness.transport,
    runtime: harness.runtime,
    devices: harness.devices,
    storage: harness.storage,
    provider: harness.provider,
  })
  const controller = new AbortController()
  const old = harness.manager.provision({
    attemptId: 'old-confirm-attempt',
    signal: controller.signal,
  })
  const oldRejected = assert.rejects(old, cancelled('provision'))
  await settleWithWatchdog(oldConfirmEntered.promise, 'old confirm start')

  controller.abort()
  await settleWithWatchdog(
    harness.manager.destroy(),
    'confirming manager destroy',
  )
  await settleWithWatchdog(oldRejected, 'cancelled old confirm')
  assert.equal(harness.provider.confirmSignals[0]?.aborted, true)
  assert.equal(
    harness.storage.provisioningJournals.get('old-confirm-attempt')?.phase,
    'device_applied',
  )

  await sibling.provision({ attemptId: 'new-confirm-attempt' })
  assert.equal(maximumConfirmsInFlight, 2)
  assert.equal(
    harness.storage.provisioningJournals.get('new-confirm-attempt')?.phase,
    'backend_confirmed',
  )

  oldConfirmGate.resolve(undefined)
  await settleReducer()
  assert.equal(
    harness.storage.provisioningJournals.get('old-confirm-attempt')?.phase,
    'device_applied',
  )
})

test('cancellation scrubs provider prepare inputs and ignores late material', async () => {
  const events: string[] = []
  const provider = new FakeProvisioningProvider(events)
  const prepareGate = deferred<void>()
  let observedNonce: Uint8Array | null = null
  let observedDevicePublicKey: Uint8Array | null = null
  let lateMaterial: ProvisioningMaterial | null = null
  provider.prepareHandler = async (context) => {
    if (context.attemptId === 'old-attempt') {
      events.push('provider:prepare:waiting')
      await prepareGate.promise
      observedNonce = context.nonce.slice()
      observedDevicePublicKey = context.devicePublicKey.slice()
      lateMaterial = materialFor(context.materialId, 0x22, 0xee)
      events.push('provider:prepare:settled')
      return lateMaterial
    }
    return materialFor(
      context.materialId,
      0x31,
      0xb1,
    )
  }
  const harness = await createHarness({ provider })
  const sibling = new ProvisioningManager({
    core: harness.core,
    transport: harness.transport,
    runtime: harness.runtime,
    devices: harness.devices,
    storage: harness.storage,
    provider,
  })
  const controller = new AbortController()

  const oldProvision = harness.manager.provision({
    attemptId: 'old-attempt',
    signal: controller.signal,
  })
  const oldRejected = assert.rejects(oldProvision, cancelled('provision'))
  await eventually(() => provider.prepares.length === 1)
  const prepare = provider.prepares[0]
  assert.ok(prepare)
  controller.abort()
  await settleWithWatchdog(
    harness.manager.destroy(),
    'prepare provider manager destroy',
  )
  await settleWithWatchdog(oldRejected, 'old provisioning cancellation')
  assert.equal(prepare.signal.aborted, true)
  assertBufferWasScrubbed(prepare.references.nonce, 'cancelled provider nonce')
  assertBufferWasScrubbed(
    prepare.references.devicePublicKey,
    'cancelled provider public key',
  )
  assert.equal(provider.aborts.filter((call) =>
    call.attemptId === 'old-attempt'
  ).length, 1)

  prepareGate.resolve(undefined)
  await settleReducer()
  assert.ok(observedNonce && allZero(observedNonce))
  assert.ok(observedDevicePublicKey && allZero(observedDevicePublicKey))
  const settledMaterial = lateMaterial as ProvisioningMaterial | null
  assert.ok(settledMaterial)
  assert.ok(allZero(settledMaterial.apiEndpoint))
  assert.ok(allZero(settledMaterial.deviceToken))
  assert.ok(
    eventIndex(events, 'provider:abort:old-attempt:cancelled')
      < eventIndex(events, 'provider:prepare:settled'),
  )

  const newProvision = sibling.provision({ attemptId: 'new-attempt' })
  await eventually(() => provider.prepares.length === 2)
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
  assert.equal(provider.prepares[1]?.snapshot.attemptId, 'new-attempt')
})

test('malformed late provisioning material after cancellation is ignored', async () => {
  const provider = new FakeProvisioningProvider()
  const lateResult = deferred<unknown>()
  provider.prepareHandler = async () =>
    await lateResult.promise as ProvisioningMaterial
  const harness = await createHarness({ provider })
  const provision = harness.manager.provision({
    attemptId: 'malformed-late-material',
  })
  void provision.catch(() => undefined)
  await eventually(() => provider.prepares.length === 1)

  await settleWithWatchdog(
    harness.manager.destroy(),
    'malformed late provisioning provider destruction',
  )
  await assert.rejects(provision, cancelled('provision'))
  lateResult.resolve(undefined)
  await settleReducer()
})

test('client destruction scrubs provider prepare without waiting for late material', async () => {
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
  const prepareGate = deferred<void>()
  let observedNonce: Uint8Array | null = null
  let observedDevicePublicKey: Uint8Array | null = null
  let lateMaterial: ProvisioningMaterial | null = null
  provider.prepareHandler = async (context) => {
    await prepareGate.promise
    observedNonce = context.nonce.slice()
    observedDevicePublicKey = context.devicePublicKey.slice()
    lateMaterial = materialFor(context.materialId, 0x44, 0xdd)
    return lateMaterial
  }
  const client = await BotaDeviceClient.create({
    coreLoader: async () => core,
    transport,
    storageNamespace: storage.namespace,
    storage,
    providers: { provisioning: provider },
  })
  await client.devices.connect({ expectedSerialNumber: SERIAL })

  const provision = client.provisioning.provision({
    attemptId: 'destroyed-attempt',
  })
  const rejected = assert.rejects(provision, cancelled('provision'))
  await eventually(() => provider.prepares.length === 1)
  const prepare = provider.prepares[0]
  assert.ok(prepare)
  await settleWithWatchdog(client.destroy(), 'client destruction')
  await rejected
  assert.equal(prepare.signal.aborted, true)
  assertBufferWasScrubbed(
    prepare.references.nonce,
    'destroyed provider nonce',
  )
  assertBufferWasScrubbed(
    prepare.references.devicePublicKey,
    'destroyed provider public key',
  )
  assert.equal(provider.aborts.filter((call) =>
    call.attemptId === 'destroyed-attempt'
  ).length, 1)

  prepareGate.resolve(undefined)
  await settleReducer()
  assert.ok(observedNonce && allZero(observedNonce))
  assert.ok(observedDevicePublicKey && allZero(observedDevicePublicKey))
  const settledMaterial = lateMaterial as ProvisioningMaterial | null
  assert.ok(settledMaterial)
  assert.ok(allZero(settledMaterial.apiEndpoint))
  assert.ok(allZero(settledMaterial.deviceToken))
  assert.equal(
    storage.provisioningJournals.has('destroyed-attempt'),
    false,
  )
})

test('deprovision ignores stale success until the Rust opcode write has settled', async () => {
  const harness = await createHarness()
  const grant = Uint8Array.of(0xaa, 0xbb, 0xcc)
  const commandWriteEntered = deferred<void>()
  const commandWriteGate = deferred<void>()
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
      harness.transport.writeGate = commandWriteGate.promise
      commandWriteEntered.resolve(undefined)
      harness.transport.emitNotification(
        harness.transport.device,
        BOTA_PROVISIONING_SERVICE,
        PROVISIONING_RESULT_CHARACTERISTIC,
        Uint8Array.of(0x04),
      )
    }
  }

  let operationSettled = false
  const operation = harness.manager.deprovision({ grant }).finally(() => {
    operationSettled = true
  })
  await settleWithWatchdog(commandWriteEntered.promise, 'deprovision command write')
  await settleReducer()
  assert.equal(operationSettled, false)

  commandWriteGate.resolve(undefined)
  await eventually(() => harness.events.includes('write_settled:05'))
  harness.transport.emitNotification(
    harness.transport.device,
    BOTA_PROVISIONING_SERVICE,
    PROVISIONING_RESULT_CHARACTERISTIC,
    Uint8Array.of(0x00),
  )
  const result = await operation

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
  materialId: string,
  endpoint = 0x21,
  token = 0xd1,
): ProvisioningMaterial {
  return {
    materialId,
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

function operationInProgress(operation: 'provision' | 'deprovision' | 'settings') {
  return (error: unknown): boolean =>
    error instanceof BotaSDKError
      && error.code === 'operation_in_progress'
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

function collectBridgeByteArrays(
  value: unknown,
  destination: Array<Uint8Array | number[]>,
  seen: Set<object> = new Set(),
): void {
  if (value instanceof Uint8Array) {
    if (value.byteLength > 0) destination.push(value)
    return
  }
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every((item) => typeof item === 'number')) {
      destination.push(value as number[])
      return
    }
    for (const item of value) collectBridgeByteArrays(item, destination, seen)
    return
  }
  if (typeof value !== 'object' || value === null || seen.has(value)) return
  seen.add(value)
  for (const item of Object.values(value)) {
    collectBridgeByteArrays(item, destination, seen)
  }
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
