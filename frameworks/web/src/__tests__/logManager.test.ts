import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { BotaDeviceClient } from '../client.ts'
import type {
  CoreBridge,
  CoreEffectEnvelope,
  CoreHostEvent,
} from '../core.ts'
import { DeviceManager } from '../deviceManager.ts'
import { BotaSDKError } from '../errors.ts'
import {
  BOTA_DIAGNOSTICS_SERVICE,
  DEVICE_LOG_CONTROL_CHARACTERISTIC as LOG_CONTROL_CHARACTERISTIC,
  DEVICE_LOG_DATA_CHARACTERISTIC as LOG_DATA_CHARACTERISTIC,
  canonicalGattUuid,
} from '../gatt.ts'
import { LogManager } from '../logManager.ts'
import { createWasmCore } from '../wasmCore.ts'
import { BrowserWorkflowRuntime } from '../workflowRuntime.ts'
import { FakeBrowserBluetoothTransport } from './fakeBluetooth.ts'
import { deferred } from './fakeProviders.ts'

const SERIAL = 'GDPPSBZJN6'
const wasmBytes = readFile(
  new URL('../generated/bota_device_sdk_core_bg.wasm', import.meta.url),
)

interface Harness {
  cancelledIds: Uint8Array[]
  core: CoreBridge
  devices: DeviceManager
  events: string[]
  manager: LogManager
  runtime: BrowserWorkflowRuntime
  startedIds: Uint8Array[]
  transport: FakeBrowserBluetoothTransport
}

async function createHarness(options: {
  dispatch?: (
    event: CoreHostEvent,
    delegate: () => CoreEffectEnvelope[],
    cancellationId: Uint8Array,
  ) => CoreEffectEnvelope[]
} = {}): Promise<Harness> {
  const base = await createWasmCore(await wasmBytes)
  const startedIds: Uint8Array[] = []
  const cancelledIds: Uint8Array[] = []
  const core = new Proxy(base, {
    get(target, property) {
      if (property === 'startDeviceLogs') {
        return (input: Parameters<CoreBridge['startDeviceLogs']>[0]) => {
          startedIds.push(input.cancellationId.slice())
          return target.startDeviceLogs(input)
        }
      }
      if (property === 'cancel') {
        return (cancellationId: Uint8Array) => {
          cancelledIds.push(cancellationId.slice())
          return target.cancel(cancellationId)
        }
      }
      if (property === 'dispatch' && options.dispatch) {
        return (event: CoreHostEvent) => options.dispatch!(
          event,
          () => target.dispatch(event),
          startedIds.at(-1)?.slice() ?? new Uint8Array(0),
        )
      }
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as CoreBridge
  const events: string[] = []
  const transport = new FakeBrowserBluetoothTransport()
  transport.eventLog = events
  const runtime = new BrowserWorkflowRuntime(core, transport)
  const devices = new DeviceManager(core, transport, { runtime })
  const manager = new LogManager({ core, runtime, devices })
  await devices.connect({ expectedSerialNumber: SERIAL })
  events.length = 0
  transport.calls.length = 0
  transport.writes.length = 0
  return {
    cancelledIds,
    core,
    devices,
    events,
    manager,
    runtime,
    startedIds,
    transport,
  }
}

test('one owner subscribes before START and emits only Rust-decoded log lines', async () => {
  const harness = await createHarness()
  const lines: unknown[] = []
  const subscribing = harness.manager.subscribe((line) => lines.push(line))
  await waitForWrite(harness.transport, LOG_CONTROL_CHARACTERISTIC)
  const subscription = await subscribing

  assert.equal(harness.startedIds.length, 1)
  assert.equal(subscribeCount(harness), 1)
  assert.deepEqual(harness.transport.writes[0]?.value, new Uint8Array([0x01]))
  assert.ok(
    eventIndex(harness.events, 'subscribe', LOG_DATA_CHARACTERISTIC)
      < eventIndex(harness.events, 'write', LOG_CONTROL_CHARACTERISTIC),
  )

  harness.transport.emitNotification(
    harness.transport.device,
    BOTA_DIAGNOSTICS_SERVICE,
    LOG_DATA_CHARACTERISTIC,
    logPacket(7, true, 'backlog one\nbacklog two\n'),
  )
  await waitFor(() => lines.length === 2, 'decoded log lines')
  assert.deepEqual(lines, [
    { message: 'backlog one', isBacklog: true },
    { message: 'backlog two', isBacklog: true },
  ])
  assert.equal(Object.keys(lines[0] as object).sort().join(','), 'isBacklog,message')

  await subscription.remove()
})

test('malformed log input fails closed with no bytes or decoder detail', async () => {
  const secret = 'raw=deadbeef decoder=DeviceLogDecoder'
  const harness = await createHarness({
    dispatch: (event, delegate) => {
      if (event.kind === 'ble_notification' && event.value[0] === 0xde) {
        throw new Error(secret)
      }
      return delegate()
    },
  })
  const lines: unknown[] = []
  const subscription = await harness.manager.subscribe((line) => lines.push(line))
  await waitForWrite(harness.transport, LOG_CONTROL_CHARACTERISTIC)

  harness.transport.emitNotification(
    harness.transport.device,
    BOTA_DIAGNOSTICS_SERVICE,
    LOG_DATA_CHARACTERISTIC,
    new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
  )
  await waitForUnsubscribe(harness)

  const error = await subscription.remove().then(
    () => null,
    (reason: unknown) => reason,
  )
  assert.ok(error instanceof BotaSDKError)
  assert.equal(error.code, 'internal_error')
  assert.equal(error.operation, 'read_device_logs')
  assert.equal('cause' in error, false)
  assert.doesNotMatch(error.message, /deadbeef|decoder|DeviceLogDecoder/i)
  assert.deepEqual(lines, [])
  assert.equal(unsubscribeCount(harness), 1)
  assertLeaseAvailable(harness)
})

test('unexpected workflow completion closes with a retryable sanitized stream error', async () => {
  const harness = await createHarness({
    dispatch: (event, delegate, cancellationId) => {
      if (event.kind !== 'ble_notification' || event.value[0] !== 0xcc) {
        return delegate()
      }
      return [{
        requestId: 9_999n,
        operation: 'read_device_logs',
        cancellationId,
        effect: {
          kind: 'notify',
          notification: {
            kind: 'completed',
            operation: 'read_device_logs',
          },
        },
      }]
    },
  })
  const subscription = await harness.manager.subscribe(() => undefined)
  await waitForWrite(harness.transport, LOG_CONTROL_CHARACTERISTIC)

  harness.transport.emitNotification(
    harness.transport.device,
    BOTA_DIAGNOSTICS_SERVICE,
    LOG_DATA_CHARACTERISTIC,
    new Uint8Array([0xcc]),
  )
  await waitForUnsubscribe(harness)

  await assert.rejects(
    subscription.remove(),
    (error: unknown) => error instanceof BotaSDKError
      && error.code === 'connection_failed'
      && error.operation === 'read_device_logs'
      && error.retryable,
  )
  assertLeaseAvailable(harness)
})

test('a second log owner fails with operation_in_progress', async () => {
  const harness = await createHarness()
  const first = await harness.manager.subscribe(() => undefined)
  await waitForWrite(harness.transport, LOG_CONTROL_CHARACTERISTIC)
  const sibling = new LogManager({
    core: harness.core,
    runtime: harness.runtime,
    devices: harness.devices,
  })

  await assert.rejects(
    sibling.subscribe(() => undefined),
    (error: unknown) => error instanceof BotaSDKError
      && error.code === 'operation_in_progress'
      && error.operation === 'read_device_logs',
  )
  assert.equal(harness.startedIds.length, 1)
  assert.equal(subscribeCount(harness), 1)
  await first.remove()
  await sibling.destroy()
})

test('listener exceptions cancel the exact Rust workflow and remove its exact subscription', async () => {
  const harness = await createHarness()
  let calls = 0
  await harness.manager.subscribe(() => {
    calls += 1
    throw new Error('listener detail must not escape')
  })
  await waitForWrite(harness.transport, LOG_CONTROL_CHARACTERISTIC)

  harness.transport.emitNotification(
    harness.transport.device,
    BOTA_DIAGNOSTICS_SERVICE,
    LOG_DATA_CHARACTERISTIC,
    logPacket(1, false, 'line one\nline two\n'),
  )
  await waitForUnsubscribe(harness)

  assert.equal(calls, 1)
  assert.equal(harness.cancelledIds.length, 1)
  assert.deepEqual(harness.cancelledIds[0], harness.startedIds[0])
  assert.equal(unsubscribeCount(harness), 1)
  assertLeaseAvailable(harness)
})

test('explicit and repeated removal stop once, release ownership, and ignore late notifications', async () => {
  const harness = await createHarness()
  let calls = 0
  const subscription = await harness.manager.subscribe(() => {
    calls += 1
  })
  await waitForWrite(harness.transport, LOG_CONTROL_CHARACTERISTIC)

  const first = subscription.remove()
  const second = subscription.remove()
  await Promise.all([first, second])
  harness.transport.emitLateNotification(
    harness.transport.device,
    BOTA_DIAGNOSTICS_SERVICE,
    LOG_DATA_CHARACTERISTIC,
    logPacket(2, false, 'too late\n'),
  )
  await flushTasks()

  assert.equal(calls, 0)
  assert.equal(unsubscribeCount(harness), 1)
  assert.equal(stopWriteCount(harness), 1)
  assert.equal(harness.cancelledIds.length, 1)
  assertLeaseAvailable(harness)
})

test('BLE disconnect removes callbacks without attempting a STOP write', async () => {
  const harness = await createHarness()
  let calls = 0
  await harness.manager.subscribe(() => {
    calls += 1
  })
  await waitForWrite(harness.transport, LOG_CONTROL_CHARACTERISTIC)
  harness.transport.writes.length = 0

  harness.transport.emitDisconnected()
  await waitForUnsubscribe(harness)
  harness.transport.emitLateNotification(
    harness.transport.device,
    BOTA_DIAGNOSTICS_SERVICE,
    LOG_DATA_CHARACTERISTIC,
    logPacket(3, false, 'too late\n'),
  )
  await flushTasks()

  assert.equal(calls, 0)
  assert.equal(stopWriteCount(harness), 0)
  await harness.devices.connect({ expectedSerialNumber: SERIAL })
  assertLeaseAvailable(harness)
})

test('destroy joins pending subscription setup before releasing the log lease', async () => {
  const harness = await createHarness()
  const subscribeGate = deferred<void>()
  harness.transport.subscribeGate = subscribeGate.promise
  const subscribing = harness.manager.subscribe(() => undefined)
  void subscribing.catch(() => undefined)
  await waitFor(() => subscribeCount(harness) === 1, 'log subscription setup')

  const destroying = harness.manager.destroy()
  assert.equal(await promiseSettled(destroying), false)
  assert.throws(() => assertLeaseAvailable(harness), (error: unknown) =>
    error instanceof BotaSDKError && error.code === 'operation_in_progress')

  subscribeGate.resolve(undefined)
  await destroying
  await assert.rejects(subscribing, (error: unknown) =>
    error instanceof BotaSDKError && error.code === 'cancelled')
  assert.equal(unsubscribeCount(harness), 1)
  assertLeaseAvailable(harness)
})

test('destroy joins an initiated START write before releasing the log lease', async () => {
  const harness = await createHarness()
  const writeGate = deferred<void>()
  harness.transport.writeGate = writeGate.promise
  const subscribing = harness.manager.subscribe(() => undefined)
  void subscribing.catch(() => undefined)
  await waitForWrite(harness.transport, LOG_CONTROL_CHARACTERISTIC)

  const destroying = harness.manager.destroy()
  assert.equal(await promiseSettled(destroying), false)
  assert.throws(() => assertLeaseAvailable(harness), (error: unknown) =>
    error instanceof BotaSDKError && error.code === 'operation_in_progress')

  writeGate.resolve(undefined)
  await destroying
  await assert.rejects(subscribing, (error: unknown) =>
    error instanceof BotaSDKError && error.code === 'cancelled')
  assert.equal(unsubscribeCount(harness), 1)
  assertLeaseAvailable(harness)
})

test('the public client exposes logs and client destruction removes the live owner', async () => {
  const core = await createWasmCore(await wasmBytes)
  const transport = new FakeBrowserBluetoothTransport()
  const client = await BotaDeviceClient.create({
    coreLoader: async () => core,
    transport,
  })
  await client.devices.connect({ expectedSerialNumber: SERIAL })
  const subscription = await client.logs.subscribe(() => undefined)
  await waitForWrite(transport, LOG_CONTROL_CHARACTERISTIC)

  await client.destroy()
  await subscription.remove()

  assert.ok(client.logs instanceof LogManager)
  assert.equal(transport.calls.filter((call) =>
    call.startsWith('unsubscribe:')
    && call.toLowerCase().endsWith(LOG_DATA_CHARACTERISTIC)
  ).length, 1)
})

function logPacket(sequence: number, isBacklog: boolean, message: string): Uint8Array {
  const payload = new TextEncoder().encode(message)
  const packet = new Uint8Array(3 + payload.byteLength)
  packet[0] = sequence & 0xff
  packet[1] = (sequence >> 8) & 0xff
  packet[2] = isBacklog ? 0x01 : 0x00
  packet.set(payload, 3)
  return packet
}

function subscribeCount(harness: Harness): number {
  return harness.transport.calls.filter((call) =>
    call.startsWith('subscribe:')
    && call.toLowerCase().endsWith(LOG_DATA_CHARACTERISTIC)
  ).length
}

function unsubscribeCount(harness: Harness): number {
  return harness.transport.calls.filter((call) =>
    call.startsWith('unsubscribe:')
    && call.toLowerCase().endsWith(LOG_DATA_CHARACTERISTIC)
  ).length
}

function stopWriteCount(harness: Harness): number {
  return harness.transport.writes.filter(({ characteristicUuid, value }) =>
    canonicalGattUuid(characteristicUuid) === LOG_CONTROL_CHARACTERISTIC
    && value.byteLength === 1
    && value[0] === 0x00
  ).length
}

function eventIndex(
  events: readonly string[],
  operation: 'subscribe' | 'write',
  characteristicUuid: string,
): number {
  return events.findIndex((event) =>
    event.startsWith(`${operation}:`)
    && event.toLowerCase().includes(characteristicUuid))
}

function assertLeaseAvailable(harness: Harness): void {
  const lease = harness.runtime.claimCharacteristicLease(
    'read_device_logs',
    harness.transport.device,
    BOTA_DIAGNOSTICS_SERVICE,
    LOG_DATA_CHARACTERISTIC,
  )
  lease.release()
}

async function waitForWrite(
  transport: FakeBrowserBluetoothTransport,
  characteristicUuid: string,
): Promise<void> {
  await waitFor(
    () => transport.writes.some((write) =>
      canonicalGattUuid(write.characteristicUuid) === characteristicUuid),
    `write to ${characteristicUuid}`,
  )
}

async function waitForUnsubscribe(harness: Harness): Promise<void> {
  await waitFor(() => unsubscribeCount(harness) === 1, 'log unsubscribe')
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 5_000; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function promiseSettled(promise: Promise<unknown>): Promise<boolean> {
  return await Promise.race([
    promise.then(() => true, () => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 0)),
  ])
}

async function flushTasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}
