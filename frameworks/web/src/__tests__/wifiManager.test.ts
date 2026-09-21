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

test('configure validates malformed credentials and NUL before any side effect', async (t) => {
  const invalidCredentials: unknown[] = [
    null,
    {},
    { ssid: 42, password: 'secret' },
    { ssid: 'Bota', password: false },
    { ssid: '', password: 'not-empty' },
    { ssid: 'Bota\0Guest', password: 'secret' },
    { ssid: 'Bota', password: 'sec\0ret' },
    { ssid: 'x'.repeat(33), password: '' },
    { ssid: 'Bota', password: 'x'.repeat(65) },
  ]

  for (const credentials of invalidCredentials) {
    await t.test(JSON.stringify(credentials), async () => {
      const harness = await createHarness()
      await assert.rejects(
        harness.manager.configure(
          credentials as { ssid: string; password: string },
          'grant.test',
        ),
        (error: unknown) =>
          error instanceof BotaSDKError
            && error.code === 'invalid_input'
            && error.operation === 'wifi',
      )
      assert.deepEqual(harness.transport.calls, [])
      assert.deepEqual(harness.transport.writes, [])
    })
  }
})

test('configure zeroes encoded credentials when grant encoding fails', async () => {
  const harness = await createHarness()
  const encodeCredentials = harness.core.encodeWiFiCredentials.bind(harness.core)
  let encodedCredentials: Uint8Array | null = null
  harness.core.encodeWiFiCredentials = (ssid, password) => {
    encodedCredentials = encodeCredentials(ssid, password)
    return encodedCredentials
  }

  await assert.rejects(
    harness.manager.configure(
      { ssid: 'Bota', password: 'secret' },
      'x'.repeat(harness.transport.maximumWriteValueLength + 1),
    ),
    (error: unknown) =>
      error instanceof BotaSDKError
        && error.code === 'invalid_input'
        && error.operation === 'wifi',
  )

  assert.ok(encodedCredentials)
  assertZeroed(encodedCredentials)
  assert.deepEqual(harness.transport.calls, [])
  assert.deepEqual(harness.transport.writes, [])
})

test('configure writes grant, subscribes status, then writes only Rust credentials and ignores stale results', async () => {
  const harness = await createHarness()
  const credentials = { ssid: 'Bota', password: 'secret' }
  const expectedGrant = harness.core.encodeWiFiGrant(
    'grant.test',
    harness.transport.maximumWriteValueLength,
  )
  const expectedCredentials = harness.core.encodeWiFiCredentials(
    credentials.ssid,
    credentials.password,
  )
  const expired = await provisioningPacket('wifi-config-expired')
  const credentialWrite = deferred<void>()
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
    if (characteristicUuid === WIFI_CREDENTIAL_CHARACTERISTIC) {
      harness.transport.writeGate = credentialWrite.promise
      harness.transport.onWrite = () => {
        harness.transport.emitNotification(
          device,
          BOTA_WIFI_CONFIG_SERVICE,
          WIFI_STATUS_CHARACTERISTIC,
          expired,
        )
      }
    }
    await write(device, serviceUuid, characteristicUuid, value, withResponse)
  }

  const configured = harness.manager.configure(credentials, 'grant.test')
  await waitForWrite(harness.transport, WIFI_CREDENTIAL_CHARACTERISTIC)
  assert.equal(await promiseSettled(configured), false)
  credentialWrite.resolve()
  await waitForEvent(harness.events, `write_settled:${hex(expectedCredentials)}`)
  assert.equal(await promiseSettled(configured), false)

  harness.transport.emitNotification(
    harness.transport.device,
    BOTA_WIFI_CONFIG_SERVICE,
    WIFI_STATUS_CHARACTERISTIC,
    expired,
  )
  assert.deepEqual(await configured, {
    success: false,
    error: 'grant_expired',
  })

  assert.deepEqual(
    harness.transport.writes.map(({ characteristicUuid, value, withResponse }) => ({
      characteristicUuid,
      value,
      withResponse,
    })),
    [
      {
        characteristicUuid: WIFI_GRANT_CHARACTERISTIC,
        value: expectedGrant,
        withResponse: true,
      },
      {
        characteristicUuid: WIFI_CREDENTIAL_CHARACTERISTIC,
        value: expectedCredentials,
        withResponse: true,
      },
    ],
  )
  assert.ok(
    eventPrefixIndex(harness.events, `write:${harness.transport.device.id}:${BOTA_WIFI_CONFIG_SERVICE}:${WIFI_GRANT_CHARACTERISTIC}:true`)
      < eventPrefixIndex(harness.events, `subscribe:${harness.transport.device.id}:${BOTA_WIFI_CONFIG_SERVICE}:${WIFI_STATUS_CHARACTERISTIC}`),
  )
  assert.ok(
    eventPrefixIndex(harness.events, `subscribe:${harness.transport.device.id}:${BOTA_WIFI_CONFIG_SERVICE}:${WIFI_STATUS_CHARACTERISTIC}`)
      < eventPrefixIndex(harness.events, `write:${harness.transport.device.id}:${BOTA_WIFI_CONFIG_SERVICE}:${WIFI_CREDENTIAL_CHARACTERISTIC}:true`),
  )
  assert.equal(unsubscribeCount(harness, WIFI_STATUS_CHARACTERISTIC), 1)
  for (const value of passedValues) assertZeroed(value)
})

test('disconnect cancellation retains a pending WiFi subscription through exact removal', async () => {
  await assertBlockedWiFiSubscriptionCleanup('disconnect')
})

test('destroy retains a pending WiFi subscription and ownership through exact removal', async () => {
  await assertBlockedWiFiSubscriptionCleanup('destroy')
})

test('WiFi subscribe rejection is propagated without removing a nonexistent handle', async () => {
  const harness = await createHarness()
  const subscribeGate = deferred<void>()
  harness.transport.subscribe = async () => {
    harness.events.push('rejecting_subscribe_started')
    await subscribeGate.promise
    throw new BrowserTransportError('unavailable')
  }

  const configuring = harness.manager.configure(
    { ssid: 'Bota', password: 'secret' },
    'grant.test',
  )
  void configuring.catch(() => undefined)
  await waitForEvent(harness.events, 'rejecting_subscribe_started')
  const destroying = harness.manager.destroy()
  assert.equal(await promiseSettled(configuring), false)

  subscribeGate.resolve(undefined)
  await assert.rejects(
    configuring,
    (error: unknown) =>
      error instanceof BotaSDKError
        && error.code === 'bluetooth_unavailable'
        && error.operation === 'wifi',
  )
  await destroying
  assert.equal(unsubscribeCount(harness, WIFI_STATUS_CHARACTERISTIC), 0)

  const lease = harness.runtime.claimCharacteristicLease(
    'wifi',
    harness.transport.device,
    BOTA_WIFI_CONFIG_SERVICE,
    WIFI_STATUS_CHARACTERISTIC,
  )
  lease.release()
})

test('disconnect subscribes then writes the Rust empty-credential packet with no grant or password', async () => {
  const harness = await createHarness()
  const expected = harness.core.encodeWiFiCredentials('', '')
  const expired = await provisioningPacket('wifi-config-expired')

  const disconnected = harness.manager.disconnect()
  await waitForWrite(harness.transport, WIFI_CREDENTIAL_CHARACTERISTIC)
  harness.transport.emitNotification(
    harness.transport.device,
    BOTA_WIFI_CONFIG_SERVICE,
    WIFI_STATUS_CHARACTERISTIC,
    expired,
  )
  assert.deepEqual(await disconnected, {
    success: false,
    error: 'grant_expired',
  })
  assert.equal(harness.transport.writes.length, 1)
  assert.equal(
    harness.transport.writes[0]?.characteristicUuid,
    WIFI_CREDENTIAL_CHARACTERISTIC,
  )
  assert.deepEqual(harness.transport.writes[0]?.value, expected)
  assert.equal(harness.transport.writes[0]?.withResponse, true)
  assert.equal(
    harness.transport.writes.some(({ characteristicUuid }) =>
      characteristicUuid === WIFI_GRANT_CHARACTERISTIC),
    false,
  )
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

test('configure and passive status reject the conflicting characteristic owner before writes', async () => {
  const harness = await createHarness()
  const passive = await harness.manager.subscribeToStatus(() => undefined)
  await assert.rejects(
    harness.manager.configure(
      { ssid: 'Bota', password: 'secret' },
      'grant.test',
    ),
    (error: unknown) =>
      error instanceof BotaSDKError && error.code === 'operation_in_progress',
  )
  assert.deepEqual(harness.transport.writes, [])
  await passive.remove()
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

async function assertBlockedWiFiSubscriptionCleanup(
  cancellation: 'disconnect' | 'destroy',
): Promise<void> {
  const harness = await createHarness()
  const subscribeGate = deferred<void>()
  const unsubscribeGate = deferred<void>()
  const notification = await provisioningPacket('wifi-config-expired')
  const encodeCredentials = harness.core.encodeWiFiCredentials.bind(harness.core)
  const encodeGrant = harness.core.encodeWiFiGrant.bind(harness.core)
  const decodeResult = harness.core.decodeWiFiConfigResult.bind(harness.core)
  let encodedCredentials: Uint8Array | null = null
  let encodedGrant: Uint8Array | null = null
  let decodeCalls = 0
  harness.core.encodeWiFiCredentials = (ssid, password) => {
    encodedCredentials = encodeCredentials(ssid, password)
    return encodedCredentials
  }
  harness.core.encodeWiFiGrant = (grant, maximumWriteValueLength) => {
    encodedGrant = encodeGrant(grant, maximumWriteValueLength)
    return encodedGrant
  }
  harness.core.decodeWiFiConfigResult = (bytes) => {
    decodeCalls += 1
    return decodeResult(bytes)
  }
  harness.transport.subscribeGate = subscribeGate.promise
  harness.transport.unsubscribeGate = unsubscribeGate.promise
  harness.transport.onUnsubscribe = () => {
    harness.events.push('wifi_unsubscribe_started')
  }

  const configuring = harness.manager.configure(
    { ssid: 'Bota', password: 'secret' },
    'grant.test',
  )
  void configuring.catch(() => undefined)
  let destroying: Promise<void> | null = null
  try {
    await waitForEvent(
      harness.events,
      `subscribe:${harness.transport.device.id}:${BOTA_WIFI_CONFIG_SERVICE}:${WIFI_STATUS_CHARACTERISTIC}`,
    )
    if (cancellation === 'disconnect') {
      harness.transport.emitDisconnected()
    } else {
      destroying = harness.manager.destroy()
    }

    assert.equal(await promiseSettled(configuring), false)
    assertNotZeroed(encodedCredentials)
    assertNotZeroed(encodedGrant)
    harness.transport.emitNotification(
      harness.transport.device,
      BOTA_WIFI_CONFIG_SERVICE,
      WIFI_STATUS_CHARACTERISTIC,
      notification,
    )
    assert.equal(decodeCalls, 0)

    subscribeGate.resolve(undefined)
    await waitForEvent(harness.events, 'wifi_unsubscribe_started')
    assert.equal(await promiseSettled(configuring), false)
    if (destroying) assert.equal(await promiseSettled(destroying), false)
    assert.equal(unsubscribeCount(harness, WIFI_STATUS_CHARACTERISTIC), 0)
    assertNotZeroed(encodedCredentials)
    assertNotZeroed(encodedGrant)

    harness.transport.emitNotification(
      harness.transport.device,
      BOTA_WIFI_CONFIG_SERVICE,
      WIFI_STATUS_CHARACTERISTIC,
      notification,
    )
    assert.equal(decodeCalls, 0)

    const writesBeforeCompetingOwner = harness.transport.writes.length
    const competingOwner = await runMutatingOwner(harness, 0xa1).then(
      () => null,
      (error: unknown) => error,
    )
    assert.ok(competingOwner instanceof BotaSDKError)
    assert.equal(competingOwner.code, 'operation_in_progress')
    assert.equal(harness.transport.writes.length, writesBeforeCompetingOwner)

    if (cancellation === 'destroy') {
      assert.throws(
        () => harness.runtime.claimCharacteristicLease(
          'wifi',
          harness.transport.device,
          BOTA_WIFI_CONFIG_SERVICE,
          WIFI_STATUS_CHARACTERISTIC,
        ),
        (error: unknown) =>
          error instanceof BotaSDKError
            && error.code === 'operation_in_progress',
      )
    }

    unsubscribeGate.resolve(undefined)
    if (destroying) await destroying
    await assert.rejects(configuring, (error: unknown) =>
      error instanceof BotaSDKError
        && error.code === (
          cancellation === 'disconnect' ? 'device_disconnected' : 'cancelled'
        ))
    assert.equal(unsubscribeCount(harness, WIFI_STATUS_CHARACTERISTIC), 1)
    assertZeroed(encodedCredentials)
    assertZeroed(encodedGrant)

    harness.transport.emitLateNotification(
      harness.transport.device,
      BOTA_WIFI_CONFIG_SERVICE,
      WIFI_STATUS_CHARACTERISTIC,
      notification,
    )
    assert.equal(decodeCalls, 0)

    assert.equal(await runMutatingOwner(harness, 0xa2), undefined)
    if (cancellation === 'destroy') {
      const lease = harness.runtime.claimCharacteristicLease(
        'wifi',
        harness.transport.device,
        BOTA_WIFI_CONFIG_SERVICE,
        WIFI_STATUS_CHARACTERISTIC,
      )
      lease.release()
    }
  } finally {
    subscribeGate.resolve(undefined)
    unsubscribeGate.resolve(undefined)
    await Promise.allSettled([
      configuring,
      destroying ?? Promise.resolve(),
    ])
    await harness.manager.destroy()
  }
}

async function runMutatingOwner(
  harness: Harness,
  marker: number,
): Promise<void> {
  await harness.runtime.runExclusive('recording_control', async () => {
    await harness.transport.write(
      harness.transport.device,
      BOTA_WIFI_CONFIG_SERVICE,
      WIFI_CREDENTIAL_CHARACTERISTIC,
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

function assertNotZeroed(value: Uint8Array | null | undefined): void {
  assert.ok(value)
  assert.ok(value.some((byte) => byte !== 0), 'expected retained secret bytes')
}

function assertZeroed(value: Uint8Array | null | undefined): void {
  assert.ok(value)
  assert.ok(value.every((byte) => byte === 0), `expected zeroed bytes, got ${hex(value)}`)
}
