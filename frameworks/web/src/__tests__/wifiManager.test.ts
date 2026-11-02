import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import type { CoreBridge } from '../core.ts'
import { DeviceManager } from '../deviceManager.ts'
import { BotaSDKError } from '../errors.ts'
import {
  BOTA_WIFI_CONFIG_SERVICE,
  DEVICE_INFORMATION_SERVICE,
  SERIAL_NUMBER_CHARACTERISTIC,
} from '../gatt.ts'
import { BrowserTransportError } from '../transport.ts'
import { createWasmCore } from '../wasmCore.ts'
import { WiFiManager } from '../wifiManager.ts'
import { BrowserWorkflowRuntime } from '../workflowRuntime.ts'
import { FakeBrowserBluetoothTransport } from './fakeBluetooth.ts'
import { deferred } from './fakeProviders.ts'

const SERIAL = 'GDPPSBZJN6'
const WIFI_GRANT_CHARACTERISTIC =
  'b07a0006-0001-1000-8000-00805f9b34fb'
const WIFI_CREDENTIAL_CHARACTERISTIC =
  'b07a0006-0002-1000-8000-00805f9b34fb'
const WIFI_STATUS_CHARACTERISTIC =
  'b07a0006-0003-1000-8000-00805f9b34fb'
const WIFI_SCAN_CHARACTERISTIC =
  'b07a0006-0004-1000-8000-00805f9b34fb'

const wasmBytes = readFile(
  new URL('../generated/bota_device_sdk_core_bg.wasm', import.meta.url),
)

interface Harness {
  core: CoreBridge
  devices: DeviceManager
  events: string[]
  manager: WiFiManager
  runtime: BrowserWorkflowRuntime
  transport: FakeBrowserBluetoothTransport
}

async function createHarness(
  operationTimeoutMs = 30_000,
): Promise<Harness> {
  const events: string[] = []
  const core = await createWasmCore(await wasmBytes)
  const transport = new FakeBrowserBluetoothTransport()
  transport.eventLog = events
  const runtime = new BrowserWorkflowRuntime(core, transport)
  const devices = new DeviceManager(core, transport, { runtime })
  const manager = new WiFiManager({
    core,
    transport,
    runtime,
    devices,
    operationTimeoutMs,
  })
  await devices.connect({ expectedSerialNumber: SERIAL })
  events.length = 0
  transport.calls.length = 0
  transport.writes.length = 0
  return { core, devices, events, manager, runtime, transport }
}

test('scan subscribes before START, ignores pending, returns Rust DONE, and removes one lease', async () => {
  const harness = await createHarness()
  const pending = await provisioningPacket('wifi-scan-scanning')
  const done = await provisioningPacket('wifi-scan-done')
  const expectedCommand = harness.core.encodeWiFiScanCommand()

  const scan = harness.manager.scanNetworks()
  await waitForWrite(harness.transport, WIFI_SCAN_CHARACTERISTIC)
  assert.deepEqual(harness.transport.writes[0]?.value, expectedCommand)

  const subscribeIndex = eventPrefixIndex(harness.events, `subscribe:${harness.transport.device.id}:${BOTA_WIFI_CONFIG_SERVICE}:${WIFI_SCAN_CHARACTERISTIC}`)
  const writeIndex = eventPrefixIndex(harness.events, `write:${harness.transport.device.id}:${BOTA_WIFI_CONFIG_SERVICE}:${WIFI_SCAN_CHARACTERISTIC}:true`)
  assert.ok(subscribeIndex >= 0 && subscribeIndex < writeIndex)

  harness.transport.emitNotification(
    harness.transport.device,
    BOTA_WIFI_CONFIG_SERVICE,
    WIFI_SCAN_CHARACTERISTIC,
    pending,
  )
  assert.equal(await promiseSettled(scan), false)

  harness.transport.emitNotification(
    harness.transport.device,
    BOTA_WIFI_CONFIG_SERVICE,
    WIFI_SCAN_CHARACTERISTIC,
    done,
  )
  assert.deepEqual(await scan, {
    networks: [
      { ssid: 'Bota', quality: 100, isCurrent: true, isOpen: true },
      { ssid: 'Guest', quality: 50, isCurrent: false, isOpen: true },
    ],
    currentSsid: 'Bota',
  })
  assert.equal(unsubscribeCount(harness, WIFI_SCAN_CHARACTERISTIC), 1)
})

test('scan uses a bounded timeout and removes the exact subscription', async () => {
  const harness = await createHarness(10)
  const scan = harness.manager.scanNetworks()
  await waitForWrite(harness.transport, WIFI_SCAN_CHARACTERISTIC)
  await assert.rejects(scan, (error: unknown) =>
    error instanceof BotaSDKError
      && error.code === 'connection_failed'
      && error.operation === 'wifi'
      && error.retryable,
  )
  assert.equal(unsubscribeCount(harness, WIFI_SCAN_CHARACTERISTIC), 1)
})

test('legacy Web configure and disconnect reject before any BLE effect', async () => {
  const harness = await createHarness()
  for (const credentials of [{ssid:'Bota',password:'secret'},{ssid:'',password:''},{ssid:'Bota\0Guest',password:'secret'}]) {
    await assert.rejects(harness.manager.configure(credentials, 'grant.test'), (error: unknown) =>
      error instanceof BotaSDKError && error.code === 'unsupported_capability')
  }
  await assert.rejects(harness.manager.disconnect(), (error: unknown) =>
    error instanceof BotaSDKError && error.code === 'unsupported_capability')
  assert.deepEqual(harness.transport.calls, [])
  assert.deepEqual(harness.transport.writes, [])
})

test('readStatus returns only the Rust-decoded WiFi status', async () => {
  const harness = await createHarness()
  const encoded = await provisioningPacket('wifi-status-connected')
  harness.transport.setRead(
    BOTA_WIFI_CONFIG_SERVICE,
    WIFI_STATUS_CHARACTERISTIC,
    encoded,
  )

  assert.deepEqual(await harness.manager.readStatus(), {
    status: 'connected',
    statusRaw: 2,
    signalStrength: 87,
    ssid: 'Bota',
  })
  assert.ok(harness.transport.calls.some((call) =>
    call === `read:${harness.transport.device.id}:${DEVICE_INFORMATION_SERVICE}:${SERIAL_NUMBER_CHARACTERISTIC}`
  ))
})

test('passive status owns one exact lease and explicit removal is idempotent', async () => {
  const harness = await createHarness()
  const encoded = await provisioningPacket('wifi-status-connected')
  const statuses: unknown[] = []
  const subscription = await harness.manager.subscribeToStatus((status) => {
    statuses.push(status)
  })

  harness.transport.emitNotification(
    harness.transport.device,
    BOTA_WIFI_CONFIG_SERVICE,
    WIFI_STATUS_CHARACTERISTIC,
    encoded,
  )
  assert.deepEqual(statuses, [{
    status: 'connected',
    statusRaw: 2,
    signalStrength: 87,
    ssid: 'Bota',
  }])

  await assert.rejects(
    harness.manager.subscribeToStatus(() => undefined),
    (error: unknown) =>
      error instanceof BotaSDKError && error.code === 'operation_in_progress',
  )
  await subscription.remove()
  await subscription.remove()
  assert.equal(unsubscribeCount(harness, WIFI_STATUS_CHARACTERISTIC), 1)
})

test('passive status freshly rejects a changed serial before subscribing', async () => {
  const harness = await createHarness()
  harness.transport.serialNumber = 'OTHERDEVICE1'

  await assert.rejects(
    harness.manager.subscribeToStatus(() => undefined),
    (error: unknown) =>
      error instanceof BotaSDKError && error.code === 'identity_mismatch',
  )

  assert.equal(
    harness.transport.calls.some((call) => call.startsWith('subscribe:')),
    false,
  )
  assert.equal(harness.transport.calls.includes('request_device'), false)
  assert.equal(harness.transport.calls.includes('get_authorized_devices'), false)
  assert.deepEqual(harness.transport.writes, [])
  assert.equal(harness.devices.connectedDevice, null)
})

test('passive status delivers a notification emitted during subscription setup', async () => {
  const harness = await createHarness()
  const encoded = await provisioningPacket('wifi-status-connected')
  const statuses: unknown[] = []
  harness.transport.onSubscribe = () => {
    harness.transport.emitNotification(
      harness.transport.device,
      BOTA_WIFI_CONFIG_SERVICE,
      WIFI_STATUS_CHARACTERISTIC,
      encoded,
    )
  }

  const subscription = await harness.manager.subscribeToStatus((status) => {
    statuses.push(status)
  })

  assert.deepEqual(statuses, [{
    status: 'connected',
    statusRaw: 2,
    signalStrength: 87,
    ssid: 'Bota',
  }])
  await subscription.remove()
  assert.equal(unsubscribeCount(harness, WIFI_STATUS_CHARACTERISTIC), 1)
})

test('passive status redacts synchronous setup failure and releases its lease', async () => {
  const harness = await createHarness()
  const subscribe = harness.transport.subscribe.bind(harness.transport)
  harness.transport.subscribe = () => {
    throw new Error('subscription failed with password=secret')
  }

  const error = await harness.manager.subscribeToStatus(() => undefined).then(
    () => null,
    (reason: unknown) => reason,
  )
  assert.ok(error instanceof BotaSDKError)
  assert.equal(error.code, 'internal_error')
  assert.equal('cause' in error, false)
  assert.doesNotMatch(error.message, /secret|password/)

  harness.transport.subscribe = subscribe
  const subscription = await harness.manager.subscribeToStatus(() => undefined)
  await subscription.remove()
  assert.equal(unsubscribeCount(harness, WIFI_STATUS_CHARACTERISTIC), 1)
})

test('passive status removes its exact lease on listener failure, disconnect, and destroy', async (t) => {
  await t.test('listener failure', async () => {
    const harness = await createHarness()
    const encoded = await provisioningPacket('wifi-status-connected')
    await harness.manager.subscribeToStatus(() => {
      throw new Error('listener failed with password=secret')
    })
    harness.transport.emitNotification(
      harness.transport.device,
      BOTA_WIFI_CONFIG_SERVICE,
      WIFI_STATUS_CHARACTERISTIC,
      encoded,
    )
    await waitForUnsubscribe(harness, WIFI_STATUS_CHARACTERISTIC)
    assert.equal(unsubscribeCount(harness, WIFI_STATUS_CHARACTERISTIC), 1)
  })

  await t.test('disconnect', async () => {
    const harness = await createHarness()
    let calls = 0
    await harness.manager.subscribeToStatus(() => {
      calls += 1
    })
    harness.transport.emitDisconnected()
    await waitForUnsubscribe(harness, WIFI_STATUS_CHARACTERISTIC)
    harness.transport.emitLateNotification(
      harness.transport.device,
      BOTA_WIFI_CONFIG_SERVICE,
      WIFI_STATUS_CHARACTERISTIC,
      await provisioningPacket('wifi-status-connected'),
    )
    assert.equal(calls, 0)
    assert.equal(unsubscribeCount(harness, WIFI_STATUS_CHARACTERISTIC), 1)
  })

  await t.test('destroy', async () => {
    const harness = await createHarness()
    await harness.manager.subscribeToStatus(() => undefined)
    await harness.manager.destroy()
    assert.equal(unsubscribeCount(harness, WIFI_STATUS_CHARACTERISTIC), 1)
  })
})

async function provisioningPacket(name: string): Promise<Uint8Array> {
  const fixture = JSON.parse(await readFile(
    new URL('../../../../protocol/fixtures/provisioning.json', import.meta.url),
    'utf8',
  )) as {
    cases: Array<{ name: string; inputHex?: string; expectedHex?: string }>
  }
  const entry = fixture.cases.find((candidate) => candidate.name === name)
  const encoded = entry?.inputHex ?? entry?.expectedHex
  assert.ok(encoded, `missing provisioning fixture ${name}`)
  return fromHex(encoded)
}

function fromHex(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/g) ?? [], (byte) =>
    Number.parseInt(byte, 16))
}

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function eventPrefixIndex(events: readonly string[], prefix: string): number {
  return events.findIndex((event) => event.startsWith(prefix))
}

function unsubscribeCount(
  harness: Harness,
  characteristicUuid: string,
): number {
  return harness.events.filter((event) =>
    event.startsWith('unsubscribe:') && event.includes(characteristicUuid)
  ).length
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

async function waitForUnsubscribe(
  harness: Harness,
  characteristicUuid: string,
): Promise<void> {
  await waitFor(
    () => unsubscribeCount(harness, characteristicUuid) === 1,
    `unsubscribe ${characteristicUuid}`,
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
