import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { BotaDeviceClient } from '../client.ts'
import { ControlManager } from '../controlManager.ts'
import type { CoreBridge } from '../core.ts'
import { DeviceManager } from '../deviceManager.ts'
import { BotaSDKError } from '../errors.ts'
import {
  BOTA_CONTROL_SERVICE,
  BOTA_WIFI_CONFIG_SERVICE,
  DEVICE_COMMAND_CHARACTERISTIC,
} from '../gatt.ts'
import type { RecordingControlProvider } from '../providers.ts'
import { createWasmCore } from '../wasmCore.ts'
import { WiFiManager } from '../wifiManager.ts'
import { BrowserWorkflowRuntime } from '../workflowRuntime.ts'
import { FakeBrowserBluetoothTransport } from './fakeBluetooth.ts'
import { deferred } from './fakeProviders.ts'

const SERIAL = 'GDPPSBZJN6'
const RECORDING_CONTROL_CHARACTERISTIC =
  'b07a0002-0002-1000-8000-00805f9b34fb'
const RECORDING_STATUS_CHARACTERISTIC =
  'b07a0002-0003-1000-8000-00805f9b34fb'
const WIFI_GRANT_CHARACTERISTIC =
  'b07a0006-0001-1000-8000-00805f9b34fb'

const wasmBytes = readFile(
  new URL('../generated/bota_device_sdk_core_bg.wasm', import.meta.url),
)

type ProviderContext = Parameters<RecordingControlProvider['prepare']>[0]

interface ProviderCall {
  operationId: string
  serialNumber: string
  action: 'start' | 'stop'
  authorityId: string
}

class FakeRecordingControlProvider implements RecordingControlProvider {
  readonly calls: ProviderCall[] = []
  readonly grants: Uint8Array[] = []
  readonly signals: AbortSignal[] = []
  prepareHandler: (
    context: ProviderContext,
  ) => Promise<{ grant: Uint8Array }> = async () => ({
    grant: Uint8Array.of(0x91, 0x92, 0x93),
  })

  async prepare(context: ProviderContext): Promise<{ grant: Uint8Array }> {
    const { signal: _signal, ...snapshot } = context
    this.calls.push(snapshot)
    this.signals.push(context.signal)
    const prepared = await this.prepareHandler(context)
    this.grants.push(prepared.grant)
    return prepared
  }
}

test('destroy aborts and stops waiting for a never-settling grant provider', async () => {
  const provider = new FakeRecordingControlProvider()
  const entered = deferred<void>()
  provider.prepareHandler = async () => {
    entered.resolve(undefined)
    return await new Promise<never>(() => undefined)
  }
  const harness = await createHarness({ provider })
  const started = harness.controls.startRecording({
    operationId: 'never-settling-control-provider',
    authorityId: 'authority-never-settles',
  })
  void started.catch(() => undefined)
  await entered.promise

  await settleWithWatchdog(
    harness.controls.destroy(),
    'never-settling recording-control provider destruction',
  )
  await assert.rejects(started, (error: unknown) =>
    error instanceof BotaSDKError && error.code === 'cancelled')
  assert.equal(provider.signals[0]?.aborted, true)
})

interface Harness {
  controls: ControlManager
  core: CoreBridge
  devices: DeviceManager
  events: string[]
  provider: FakeRecordingControlProvider
  runtime: BrowserWorkflowRuntime
  transport: FakeBrowserBluetoothTransport
  wifi: WiFiManager
}

async function createHarness(options: {
  provider?: FakeRecordingControlProvider
  resultTimeoutMs?: number
  delay?: (milliseconds: number) => Promise<void>
} = {}): Promise<Harness> {
  const events: string[] = []
  const core = await createWasmCore(await wasmBytes)
  const transport = new FakeBrowserBluetoothTransport()
  transport.eventLog = events
  const runtime = new BrowserWorkflowRuntime(core, transport)
  const devices = new DeviceManager(core, transport, { runtime })
  const provider = options.provider ?? new FakeRecordingControlProvider()
  const controls = new ControlManager({
    core,
    transport,
    runtime,
    devices,
    provider,
    resultTimeoutMs: options.resultTimeoutMs,
    delay: options.delay,
  })
  const wifi = new WiFiManager({
    core,
    transport,
    runtime,
    devices,
    operationTimeoutMs: 30_000,
  })
  await devices.connect({ expectedSerialNumber: SERIAL })
  events.length = 0
  transport.calls.length = 0
  transport.writes.length = 0
  return {
    controls,
    core,
    devices,
    events,
    provider,
    runtime,
    transport,
    wifi,
  }
}

test('start passes exact authority context and uses grant, subscribe, Rust command sequencing', async () => {
  const harness = await createHarness()
  const successResult = await recordingControlPacket('recording-control-success')
  const command = harness.core.encodeRecordingControlCommand('start')
  const commandWrite = deferred<void>()
  const passedValues: Uint8Array[] = []
  const write = harness.transport.write.bind(harness.transport)
  harness.transport.write = async (
    device,
    serviceUuid,
    characteristicUuid,
    value,
    withResponse,
  ) => {
    passedValues.push(value)
    if (characteristicUuid === RECORDING_CONTROL_CHARACTERISTIC) {
      harness.transport.writeGate = commandWrite.promise
      harness.transport.onWrite = () => {
        harness.transport.emitNotification(
          device,
          BOTA_CONTROL_SERVICE,
          RECORDING_STATUS_CHARACTERISTIC,
          successResult,
        )
      }
    }
    await write(device, serviceUuid, characteristicUuid, value, withResponse)
  }

  const started = harness.controls.startRecording({
    operationId: 'caller-operation-1',
    authorityId: 'authority-1',
  })
  await waitForWrite(harness.transport, RECORDING_CONTROL_CHARACTERISTIC)
  assert.equal(await promiseSettled(started), false)
  commandWrite.resolve()
  await waitForEvent(harness.events, `write_settled:${hex(command)}`)
  assert.equal(await promiseSettled(started), false)
  harness.transport.emitNotification(
    harness.transport.device,
    BOTA_CONTROL_SERVICE,
    RECORDING_STATUS_CHARACTERISTIC,
    successResult,
  )
  assert.deepEqual(await started, { success: true })

  assert.deepEqual(harness.provider.calls, [{
    operationId: 'caller-operation-1',
    serialNumber: SERIAL,
    action: 'start',
    authorityId: 'authority-1',
  }])
  assert.equal(harness.transport.writes.length, 2)
  assert.deepEqual(
    harness.transport.writes.map(({ characteristicUuid, withResponse }) => ({
      characteristicUuid,
      withResponse,
    })),
    [
      { characteristicUuid: DEVICE_COMMAND_CHARACTERISTIC, withResponse: true },
      { characteristicUuid: RECORDING_CONTROL_CHARACTERISTIC, withResponse: true },
    ],
  )
  assert.deepEqual(harness.transport.writes[1]?.value, command)
  assert.ok(
    eventIndex(harness.events, DEVICE_COMMAND_CHARACTERISTIC, 'write')
      < eventIndex(harness.events, RECORDING_STATUS_CHARACTERISTIC, 'subscribe'),
  )
  assert.ok(
    eventIndex(harness.events, RECORDING_STATUS_CHARACTERISTIC, 'subscribe')
      < eventIndex(harness.events, RECORDING_CONTROL_CHARACTERISTIC, 'write'),
  )
  assert.equal(unsubscribeCount(harness), 1)
  assertZeroed(harness.provider.grants[0])
  for (const value of passedValues) assertZeroed(value)
})

test('stop preserves both released 50 ms pacing points around result subscription', async () => {
  const sequence: string[] = []
  const harness = await createHarness({
    delay: async (milliseconds) => {
      sequence.push(`delay:${milliseconds}`)
    },
  })
  harness.transport.eventLog = sequence
  const successResult = await recordingControlPacket('recording-control-success')

  const stopped = harness.controls.stopRecording({
    operationId: 'caller-operation-stop',
    authorityId: 'authority-stop',
  })
  await waitForWrite(harness.transport, RECORDING_CONTROL_CHARACTERISTIC)
  harness.transport.emitNotification(
    harness.transport.device,
    BOTA_CONTROL_SERVICE,
    RECORDING_STATUS_CHARACTERISTIC,
    successResult,
  )
  assert.deepEqual(await stopped, { success: true })

  const grantWrite = eventIndex(sequence, DEVICE_COMMAND_CHARACTERISTIC, 'write')
  const subscribe = eventIndex(sequence, RECORDING_STATUS_CHARACTERISTIC, 'subscribe')
  const commandWrite = eventIndex(sequence, RECORDING_CONTROL_CHARACTERISTIC, 'write')
  assert.deepEqual(
    sequence.filter((event) => event === 'delay:50'),
    ['delay:50', 'delay:50'],
  )
  const firstDelay = sequence.indexOf('delay:50')
  const secondDelay = sequence.indexOf('delay:50', firstDelay + 1)
  assert.ok(grantWrite < firstDelay && firstDelay < subscribe)
  assert.ok(subscribe < secondDelay && secondDelay < commandWrite)
})

test('grant expiration maps to authorization_expired without retry or authority widening', async () => {
  const harness = await createHarness()
  const expired = Uint8Array.of(0, 0, 0, 0, 0, 5)
  const started = harness.controls.startRecording({
    operationId: 'expired-operation',
    authorityId: 'exact-authority',
  })
  await waitForWrite(harness.transport, RECORDING_CONTROL_CHARACTERISTIC)
  harness.transport.emitNotification(
    harness.transport.device,
    BOTA_CONTROL_SERVICE,
    RECORDING_STATUS_CHARACTERISTIC,
    expired,
  )
  await assert.rejects(started, (error: unknown) =>
    error instanceof BotaSDKError
      && error.code === 'authorization_expired'
      && error.operation === 'recording_control'
      && !error.retryable,
  )
  assert.deepEqual(harness.provider.calls, [{
    operationId: 'expired-operation',
    serialNumber: SERIAL,
    action: 'start',
    authorityId: 'exact-authority',
  }])
  assert.equal(harness.transport.writes.length, 2)
  assertZeroed(harness.provider.grants[0])
})

test('provider expiration is terminal before GATT and secret-bearing causes are not retained', async (t) => {
  await t.test('authorization expiration', async () => {
    const provider = new FakeRecordingControlProvider()
    provider.prepareHandler = async () => {
      throw new BotaSDKError('authorization_expired', 'recording_control')
    }
    const harness = await createHarness({ provider })
    await assert.rejects(
      harness.controls.startRecording({ authorityId: 'expired-authority' }),
      (error: unknown) =>
        error instanceof BotaSDKError
          && error.code === 'authorization_expired'
          && !error.retryable,
    )
    assert.equal(provider.calls.length, 1)
    assert.deepEqual(harness.transport.writes, [])
  })

  await t.test('redacted provider failure', async () => {
    const provider = new FakeRecordingControlProvider()
    provider.prepareHandler = async () => {
      throw new Error('grant=secret https://authority.example.invalid')
    }
    const harness = await createHarness({ provider })
    const error = await harness.controls.startRecording({
      authorityId: 'authority-secret',
    }).then(
      () => null,
      (reason: unknown) => reason,
    )
    assert.ok(error instanceof BotaSDKError)
    assert.equal(error.code, 'internal_error')
    assert.equal('cause' in error, false)
    assert.doesNotMatch(error.message, /secret|https:/)
  })
})

test('destroy joins an initiated grant write before zeroing authority and releasing ownership', async () => {
  const harness = await createHarness()
  const grantWrite = deferred<void>()
  harness.transport.writeGate = grantWrite.promise

  const started = harness.controls.startRecording({
    operationId: 'blocked-grant-operation',
    authorityId: 'blocked-authority',
  })
  await waitForWrite(harness.transport, DEVICE_COMMAND_CHARACTERISTIC)
  const grant = harness.provider.grants[0]
  assert.ok(grant?.some((byte) => byte !== 0))

  const destroyed = harness.controls.destroy()
  assert.equal(await promiseSettled(destroyed), false)
  assert.ok(grant?.some((byte) => byte !== 0))
  grantWrite.resolve()
  await destroyed
  await assert.rejects(started, (error: unknown) =>
    error instanceof BotaSDKError && error.code === 'cancelled')
  assertZeroed(grant)
  assert.equal(
    harness.transport.writes.some(({ characteristicUuid }) =>
      characteristicUuid === RECORDING_CONTROL_CHARACTERISTIC),
    false,
  )
})

test('request cancellation retains a pending control subscription through exact removal', async () => {
  await assertBlockedControlSubscriptionCleanup('signal')
})

test('destroy retains a pending control subscription and ownership through exact removal', async () => {
  await assertBlockedControlSubscriptionCleanup('destroy')
})

test('WiFi and recording control share the mutating owner and cannot overlap', async () => {
  const harness = await createHarness()
  const wifiGrantWrite = deferred<void>()
  harness.transport.writeGate = wifiGrantWrite.promise

  const configuring = harness.wifi.configure(
    { ssid: 'Bota', password: 'secret' },
    'grant.test',
  )
  await waitForWrite(harness.transport, WIFI_GRANT_CHARACTERISTIC)
  await assert.rejects(
    harness.controls.startRecording({ authorityId: 'authority-overlap' }),
    (error: unknown) =>
      error instanceof BotaSDKError
        && error.code === 'operation_in_progress'
        && error.operation === 'recording_control',
  )
  assert.deepEqual(harness.provider.calls, [])
  wifiGrantWrite.resolve()
  await harness.wifi.destroy()
  await assert.rejects(configuring, (error: unknown) =>
    error instanceof BotaSDKError && error.code === 'cancelled')
})

test('public client composes WiFi and grant-bound controls without extra control state streams', async () => {
  const core = await createWasmCore(await wasmBytes)
  const transport = new FakeBrowserBluetoothTransport()
  const provider = new FakeRecordingControlProvider()
  const client = await BotaDeviceClient.create({
    coreLoader: async () => core,
    transport,
    providers: { recordingControl: provider },
  })
  assert.ok(client.wifi instanceof WiFiManager)
  assert.ok(client.controls instanceof ControlManager)
  assert.equal('readRecordingState' in client.controls, false)
  assert.equal('subscribeToRecordingState' in client.controls, false)
  await client.destroy()
})

async function recordingControlPacket(name: string): Promise<Uint8Array> {
  const fixture = JSON.parse(await readFile(
    new URL('../../../../protocol/fixtures/recording-control.json', import.meta.url),
    'utf8',
  )) as {
    cases: Array<{ name: string; inputHex?: string; expectedHex?: string }>
  }
  const entry = fixture.cases.find((candidate) => candidate.name === name)
  const encoded = entry?.inputHex ?? entry?.expectedHex
  assert.ok(encoded, `missing recording control fixture ${name}`)
  return Uint8Array.from(encoded.match(/.{2}/g) ?? [], (byte) =>
    Number.parseInt(byte, 16))
}

function eventIndex(
  events: readonly string[],
  characteristicUuid: string,
  operation: 'write' | 'subscribe',
): number {
  return events.findIndex((event) =>
    event.startsWith(`${operation}:`) && event.includes(characteristicUuid))
}

function unsubscribeCount(harness: Harness): number {
  return harness.events.filter((event) =>
    event.startsWith('unsubscribe:')
      && event.includes(RECORDING_STATUS_CHARACTERISTIC)
  ).length
}

async function assertBlockedControlSubscriptionCleanup(
  cancellation: 'signal' | 'destroy',
): Promise<void> {
  const harness = await createHarness()
  const subscribeGate = deferred<void>()
  const unsubscribeGate = deferred<void>()
  const controller = new AbortController()
  const notification = await recordingControlPacket('recording-control-success')
  const decodeResult = harness.core.decodeRecordingControlResult.bind(harness.core)
  let decodeCalls = 0
  harness.core.decodeRecordingControlResult = (bytes) => {
    decodeCalls += 1
    return decodeResult(bytes)
  }
  harness.transport.subscribeGate = subscribeGate.promise
  harness.transport.unsubscribeGate = unsubscribeGate.promise
  harness.transport.onUnsubscribe = () => {
    harness.events.push('control_unsubscribe_started')
  }

  const started = harness.controls.startRecording({
    operationId: `blocked-subscribe-${cancellation}`,
    authorityId: 'blocked-subscribe-authority',
    signal: controller.signal,
  })
  void started.catch(() => undefined)
  let destroying: Promise<void> | null = null
  try {
    await waitForEvent(
      harness.events,
      `subscribe:${harness.transport.device.id}:${BOTA_CONTROL_SERVICE}:${RECORDING_STATUS_CHARACTERISTIC}`,
    )
    const grant = harness.provider.grants[0]
    assertNotZeroed(grant)
    if (cancellation === 'signal') {
      controller.abort()
    } else {
      destroying = harness.controls.destroy()
    }

    assert.equal(await promiseSettled(started), false)
    assertNotZeroed(grant)
    harness.transport.emitNotification(
      harness.transport.device,
      BOTA_CONTROL_SERVICE,
      RECORDING_STATUS_CHARACTERISTIC,
      notification,
    )
    assert.equal(decodeCalls, 0)

    subscribeGate.resolve(undefined)
    await waitForEvent(harness.events, 'control_unsubscribe_started')
    assert.equal(await promiseSettled(started), false)
    if (destroying) assert.equal(await promiseSettled(destroying), false)
    assert.equal(unsubscribeCount(harness), 0)
    assertNotZeroed(grant)

    harness.transport.emitNotification(
      harness.transport.device,
      BOTA_CONTROL_SERVICE,
      RECORDING_STATUS_CHARACTERISTIC,
      notification,
    )
    assert.equal(decodeCalls, 0)

    const writesBeforeCompetingOwner = harness.transport.writes.length
    const competingOwner = await runMutatingOwner(harness, 0xb1).then(
      () => null,
      (error: unknown) => error,
    )
    assert.ok(competingOwner instanceof BotaSDKError)
    assert.equal(competingOwner.code, 'operation_in_progress')
    assert.equal(harness.transport.writes.length, writesBeforeCompetingOwner)
    assert.throws(
      () => harness.runtime.claimCharacteristicLease(
        'recording_control',
        harness.transport.device,
        BOTA_CONTROL_SERVICE,
        RECORDING_STATUS_CHARACTERISTIC,
      ),
      (error: unknown) =>
        error instanceof BotaSDKError
          && error.code === 'operation_in_progress',
    )

    unsubscribeGate.resolve(undefined)
    if (destroying) await destroying
    await assert.rejects(started, (error: unknown) =>
      error instanceof BotaSDKError && error.code === 'cancelled')
    assert.equal(unsubscribeCount(harness), 1)
    assertZeroed(grant)
    assert.equal(
      harness.transport.writes.some(({ characteristicUuid }) =>
        characteristicUuid === RECORDING_CONTROL_CHARACTERISTIC),
      false,
    )

    harness.transport.emitLateNotification(
      harness.transport.device,
      BOTA_CONTROL_SERVICE,
      RECORDING_STATUS_CHARACTERISTIC,
      notification,
    )
    assert.equal(decodeCalls, 0)

    assert.equal(await runMutatingOwner(harness, 0xb2), undefined)
    const lease = harness.runtime.claimCharacteristicLease(
      'recording_control',
      harness.transport.device,
      BOTA_CONTROL_SERVICE,
      RECORDING_STATUS_CHARACTERISTIC,
    )
    lease.release()
  } finally {
    controller.abort()
    subscribeGate.resolve(undefined)
    unsubscribeGate.resolve(undefined)
    await Promise.allSettled([
      started,
      destroying ?? Promise.resolve(),
    ])
    await harness.controls.destroy()
    await harness.wifi.destroy()
  }
}

async function runMutatingOwner(
  harness: Harness,
  marker: number,
): Promise<void> {
  await harness.runtime.runExclusive('wifi', async () => {
    await harness.transport.write(
      harness.transport.device,
      BOTA_WIFI_CONFIG_SERVICE,
      WIFI_GRANT_CHARACTERISTIC,
      Uint8Array.of(marker),
      true,
    )
  })
}

async function waitForWrite(
  transport: FakeBrowserBluetoothTransport,
  characteristicUuid: string,
): Promise<void> {
  await waitFor(
    () => transport.writes.some((write) =>
      write.characteristicUuid === characteristicUuid),
    `write ${characteristicUuid}`,
  )
}

async function waitForEvent(events: readonly string[], expected: string): Promise<void> {
  await waitFor(() => events.includes(expected), expected)
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  assert.fail(`${label} did not occur`)
}

async function promiseSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false
  void promise.then(
    () => { settled = true },
    () => { settled = true },
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  return settled
}

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function assertZeroed(value: Uint8Array | undefined): void {
  assert.ok(value)
  assert.ok(value.every((byte) => byte === 0), `expected zeroed bytes, got ${hex(value)}`)
}

function assertNotZeroed(value: Uint8Array | undefined): void {
  assert.ok(value)
  assert.ok(value.some((byte) => byte !== 0), 'expected retained secret bytes')
}

async function settleWithWatchdog<T>(
  promise: Promise<T>,
  label: string,
): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`${label} did not settle`)), 250)
    }),
  ])
}
