import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  CoreBridge,
  CoreEffect,
  CoreEffectEnvelope,
  CoreHostEvent,
  CoreOperation,
  CoreWorkflowCheckpoint,
} from '../core.ts'
import { BotaSDKError, normalizeCoreError } from '../errors.ts'
import {
  BrowserWorkflowRuntime,
  type WorkflowEffectHost,
} from '../workflowRuntime.ts'
import { FakeBrowserBluetoothTransport } from './fakeBluetooth.ts'

const CANCELLATION_ID = new Uint8Array(16).fill(0x11)
const OTHER_CANCELLATION_ID = new Uint8Array(16).fill(0x22)
const SERVICE_UUID = '180A'
const CHARACTERISTIC_UUID = '2A25'

const CHECKPOINT: CoreWorkflowCheckpoint = {
  workflow: 'connection',
  operation: 'reconnect',
  serialNumber: 'GDPPSBZJN6',
  recordingUuid: null,
  phase: 'reconnecting',
  completedUnits: 0n,
  retryCount: 0,
  lastSequence: null,
  firmwareVersion: null,
}

function envelope(
  requestId: bigint,
  effect: CoreEffect,
  cancellationId = CANCELLATION_ID,
  operation: CoreOperation = 'reconnect',
): CoreEffectEnvelope {
  return {
    requestId,
    operation,
    cancellationId: cancellationId.slice(),
    effect,
  }
}

function scriptedCore(options: {
  dispatch?: (event: CoreHostEvent) => CoreEffectEnvelope[]
  cancel?: (cancellationId: Uint8Array) => CoreEffectEnvelope[]
} = {}): CoreBridge {
  return {
    dispatch: options.dispatch ?? (() => []),
    cancel: options.cancel ?? (() => []),
    status: () => ({ kind: 'idle' }),
  } as unknown as CoreBridge
}

function noOpHost(): WorkflowEffectHost {
  return {
    execute: async () => null,
    cancel: async () => undefined,
  }
}

function errorWith(
  code: BotaSDKError['code'],
  operation?: BotaSDKError['operation'],
): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof BotaSDKError)
    assert.equal(error.code, code)
    if (operation) assert.equal(error.operation, operation)
    return true
  }
}

test('common workflow effects preserve exact browser, persistence, timer, and progress order', async () => {
  const transport = new FakeBrowserBluetoothTransport()
  const events: string[] = []
  const progress: Array<[bigint, bigint]> = []
  let subscriptionReady!: () => void
  const subscribed = new Promise<void>((resolve) => {
    subscriptionReady = resolve
  })
  let persistenceStarted!: () => void
  const persistenceReached = new Promise<void>((resolve) => {
    persistenceStarted = resolve
  })
  let releasePersistence!: () => void
  const persistenceGate = new Promise<void>((resolve) => {
    releasePersistence = resolve
  })
  let timerFired!: () => void
  const timerReached = new Promise<void>((resolve) => {
    timerFired = resolve
  })

  const core = scriptedCore({
    dispatch: (event) => {
      events.push(`core:${event.kind}:${event.requestId}`)
      switch (event.kind) {
        case 'ble_scan_result':
          return [envelope(2n, { kind: 'ble_stop_scan' })]
        case 'ble_scan_stopped':
          return [envelope(3n, {
            kind: 'ble_connect',
            peripheralId: transport.device.id,
          })]
        case 'ble_connected':
          return [envelope(4n, {
            kind: 'ble_discover_services',
            peripheralId: transport.device.id,
          })]
        case 'ble_services_discovered':
          return [envelope(5n, {
            kind: 'ble_read',
            serviceUuid: SERVICE_UUID,
            characteristicUuid: CHARACTERISTIC_UUID,
          })]
        case 'ble_read_completed':
          return [envelope(6n, {
            kind: 'ble_write',
            serviceUuid: SERVICE_UUID,
            characteristicUuid: CHARACTERISTIC_UUID,
            payload: Uint8Array.of(0x01),
            withResponse: true,
          })]
        case 'ble_write_completed':
          return [envelope(7n, {
            kind: 'ble_subscribe',
            serviceUuid: SERVICE_UUID,
            characteristicUuid: CHARACTERISTIC_UUID,
          })]
        case 'ble_subscribed':
          subscriptionReady()
          return []
        case 'ble_notification':
          return [
            envelope(8n, {
              kind: 'ble_unsubscribe',
              serviceUuid: SERVICE_UUID,
              characteristicUuid: CHARACTERISTIC_UUID,
            }),
            envelope(9n, { kind: 'timer_schedule', timerId: 41n, delayMs: 0n }),
            envelope(10n, {
              kind: 'persistence_save_checkpoint',
              checkpoint: CHECKPOINT,
            }),
          ]
        case 'timer_fired':
          timerFired()
          return []
        case 'checkpoint_saved':
          return [
            envelope(11n, {
              kind: 'progress',
              completedUnits: 5n,
              totalUnits: 10n,
            }),
            envelope(12n, {
              kind: 'ble_disconnect',
              peripheralId: transport.device.id,
            }),
          ]
        case 'ble_disconnected':
          return [envelope(13n, {
            kind: 'notify',
            notification: { kind: 'completed', operation: 'reconnect' },
          })]
        default:
          throw new Error(`unexpected event ${event.kind}`)
      }
    },
  })
  const persistence: WorkflowEffectHost = {
    execute: async (effect) => {
      assert.equal(effect.effect.kind, 'persistence_save_checkpoint')
      events.push('persistence:started')
      persistenceStarted()
      await persistenceGate
      events.push('persistence:durable')
      return { requestId: effect.requestId, kind: 'checkpoint_saved' }
    },
    cancel: async () => undefined,
  }
  const runtime = new BrowserWorkflowRuntime(core, transport)
  runtime.registerDevice(transport.device)

  const running = runtime.run(
    'reconnect-operation-1',
    CANCELLATION_ID,
    () => [
      envelope(0n, {
        kind: 'notify',
        notification: { kind: 'started', operation: 'reconnect' },
      }),
      envelope(1n, { kind: 'ble_start_scan', allowDuplicates: false }),
    ],
    { persistence },
    { onProgress: (completed, total) => progress.push([completed, total]) },
  )

  await subscribed
  transport.emitNotification(
    transport.device,
    SERVICE_UUID,
    CHARACTERISTIC_UUID,
    Uint8Array.of(0x7f),
  )
  await persistenceReached
  await timerReached

  assert.equal(
    transport.calls.some((call) => call.startsWith('disconnect:')),
    false,
  )
  assert.equal(
    events.some((event) => event.startsWith('core:checkpoint_saved')),
    false,
  )

  releasePersistence()
  const result = await running

  assert.deepEqual(transport.calls, [
    'get_authorized_devices',
    'connect:browser-peripheral-1',
    'discover:browser-peripheral-1',
    'read:browser-peripheral-1:180A:2A25',
    'write:browser-peripheral-1:180A:2A25:true',
    'subscribe:browser-peripheral-1:180A:2A25',
    'unsubscribe:browser-peripheral-1:180A:2A25',
    'disconnect:browser-peripheral-1',
  ])
  assert.ok(
    events.indexOf('persistence:durable')
      < events.indexOf('core:checkpoint_saved:10'),
  )
  assert.deepEqual(progress, [[5n, 10n]])
  assert.deepEqual(
    result.notifications.map((notification) => notification.kind),
    ['started', 'completed'],
  )
})

test('a second workflow or direct owner fails before any second GATT call', async () => {
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
  const core = scriptedCore({
    cancel: (cancellationId) => {
      assert.deepEqual(cancellationId, CANCELLATION_ID)
      return [envelope(2n, {
        kind: 'notify',
        notification: { kind: 'cancelled', operation: 'reconnect' },
      })]
    },
  })
  const runtime = new BrowserWorkflowRuntime(core, transport)
  runtime.registerDevice(transport.device)
  const firstResult = runtime.run(
    'first',
    CANCELLATION_ID,
    () => [envelope(1n, {
      kind: 'ble_connect',
      peripheralId: transport.device.id,
    })],
    { persistence: noOpHost() },
  ).then(
    () => null,
    (error: unknown) => error,
  )
  await atConnect

  let secondStartCalls = 0
  await assert.rejects(
    runtime.run(
      'second',
      OTHER_CANCELLATION_ID,
      () => {
        secondStartCalls += 1
        return [envelope(3n, {
          kind: 'ble_write',
          serviceUuid: SERVICE_UUID,
          characteristicUuid: CHARACTERISTIC_UUID,
          payload: Uint8Array.of(1),
          withResponse: true,
        }, OTHER_CANCELLATION_ID)]
      },
      { persistence: noOpHost() },
    ),
    errorWith('operation_in_progress'),
  )
  let directBodyCalls = 0
  await assert.rejects(
    runtime.runExclusive('settings', async () => {
      directBodyCalls += 1
    }),
    errorWith('operation_in_progress', 'settings'),
  )

  assert.equal(secondStartCalls, 0)
  assert.equal(directBodyCalls, 0)
  assert.deepEqual(transport.calls, ['connect:browser-peripheral-1'])

  const cancelling = runtime.cancel('first')
  releaseConnect()
  await cancelling
  assert.ok(await firstResult instanceof BotaSDKError)
})

test('foreign request and cancellation identities cannot reach the core', async (t) => {
  await t.test('foreign request identity', async () => {
    let dispatchCalls = 0
    const core = scriptedCore({
      dispatch: () => {
        dispatchCalls += 1
        return []
      },
    })
    const runtime = new BrowserWorkflowRuntime(core, new FakeBrowserBluetoothTransport())
    const persistence: WorkflowEffectHost = {
      execute: async (effect) => ({
        requestId: effect.requestId + 1n,
        kind: 'checkpoint_saved',
      }),
      cancel: async () => undefined,
    }

    await assert.rejects(
      runtime.run(
        'foreign-request',
        CANCELLATION_ID,
        () => [envelope(1n, {
          kind: 'persistence_save_checkpoint',
          checkpoint: CHECKPOINT,
        })],
        { persistence },
      ),
      errorWith('internal_error', 'reconnect'),
    )
    assert.equal(dispatchCalls, 0)
  })

  await t.test('foreign cancellation identity', async () => {
    let dispatchCalls = 0
    const core = scriptedCore({
      dispatch: () => {
        dispatchCalls += 1
        return []
      },
    })
    const runtime = new BrowserWorkflowRuntime(core, new FakeBrowserBluetoothTransport())
    const persistence: WorkflowEffectHost = {
      execute: async (effect, context) => {
        context.cancellationId[0] = 0xff
        await context.dispatch({
          requestId: effect.requestId,
          kind: 'checkpoint_saved',
        })
        return null
      },
      cancel: async () => undefined,
    }

    await assert.rejects(
      runtime.run(
        'foreign-cancellation',
        CANCELLATION_ID,
        () => [envelope(1n, {
          kind: 'persistence_save_checkpoint',
          checkpoint: CHECKPOINT,
        })],
        { persistence },
      ),
      errorWith('internal_error', 'reconnect'),
    )
    assert.equal(dispatchCalls, 0)
  })
})

test('an unknown effect fails closed instead of reaching a later completion', async () => {
  const runtime = new BrowserWorkflowRuntime(
    scriptedCore(),
    new FakeBrowserBluetoothTransport(),
  )
  const unknownEffect = { kind: 'future_effect' } as unknown as CoreEffect

  await assert.rejects(
    runtime.run(
      'reconnect:unknown-effect',
      CANCELLATION_ID,
      () => [
        envelope(1n, unknownEffect),
        envelope(2n, {
          kind: 'notify',
          notification: { kind: 'completed', operation: 'reconnect' },
        }),
      ],
      { persistence: noOpHost() },
    ),
    errorWith('internal_error', 'reconnect'),
  )
})

test('cancellation removes subscriptions, cancels hosts, and ignores late completions', async () => {
  const transport = new FakeBrowserBluetoothTransport()
  const dispatched: string[] = []
  let networkStarted!: () => void
  const atNetwork = new Promise<void>((resolve) => {
    networkStarted = resolve
  })
  let releaseNetwork!: () => void
  const networkGate = new Promise<void>((resolve) => {
    releaseNetwork = resolve
  })
  let hostCancelled = false
  const core = scriptedCore({
    dispatch: (event) => {
      dispatched.push(event.kind)
      if (event.kind === 'ble_connected') {
        return [envelope(2n, {
          kind: 'ble_subscribe',
          serviceUuid: SERVICE_UUID,
          characteristicUuid: CHARACTERISTIC_UUID,
        })]
      }
      if (event.kind === 'ble_subscribed') {
        return [envelope(3n, { kind: 'network_download', downloadId: 9n })]
      }
      throw new Error(`late event reached core: ${event.kind}`)
    },
    cancel: (cancellationId) => {
      assert.deepEqual(cancellationId, CANCELLATION_ID)
      return [envelope(4n, {
        kind: 'notify',
        notification: { kind: 'cancelled', operation: 'reconnect' },
      })]
    },
  })
  const network: WorkflowEffectHost = {
    execute: async (effect) => {
      networkStarted()
      await networkGate
      return {
        requestId: effect.requestId,
        kind: 'network_download_completed',
        downloadId: 9n,
        crc32: 0x1234,
      }
    },
    cancel: async () => {
      hostCancelled = true
      releaseNetwork()
    },
  }
  const runtime = new BrowserWorkflowRuntime(core, transport)
  runtime.registerDevice(transport.device)
  const running = runtime.run(
    'cancel-me',
    CANCELLATION_ID,
    () => [envelope(1n, {
      kind: 'ble_connect',
      peripheralId: transport.device.id,
    })],
    { persistence: noOpHost(), network },
  ).then(
    () => null,
    (error: unknown) => error,
  )
  await atNetwork

  await runtime.cancel('cancel-me')
  const runError = await running

  assert.equal(hostCancelled, true)
  assert.ok(runError instanceof BotaSDKError)
  assert.equal(runError.code, 'cancelled')
  assert.ok(
    transport.calls.includes(
      'unsubscribe:browser-peripheral-1:180A:2A25',
    ),
  )
  assert.deepEqual(dispatched, ['ble_connected', 'ble_subscribed'])

  transport.emitLateNotification(
    transport.device,
    SERVICE_UUID,
    CHARACTERISTIC_UUID,
    Uint8Array.of(0x99),
  )
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(dispatched, ['ble_connected', 'ble_subscribed'])
})

test('cancellation settles before a provider that completes late', async () => {
  let providerStarted!: () => void
  const atProvider = new Promise<void>((resolve) => {
    providerStarted = resolve
  })
  let releaseProvider!: () => void
  const providerGate = new Promise<void>((resolve) => {
    releaseProvider = resolve
  })
  let hostCancelled = false
  let dispatchCalls = 0
  const core = scriptedCore({
    dispatch: () => {
      dispatchCalls += 1
      return []
    },
    cancel: () => [envelope(2n, {
      kind: 'notify',
      notification: { kind: 'cancelled', operation: 'reconnect' },
    })],
  })
  const network: WorkflowEffectHost = {
    execute: async (effect) => {
      providerStarted()
      await providerGate
      return {
        requestId: effect.requestId,
        kind: 'network_download_completed',
        downloadId: 9n,
        crc32: 0x1234,
      }
    },
    cancel: async () => {
      hostCancelled = true
    },
  }
  const runtime = new BrowserWorkflowRuntime(
    core,
    new FakeBrowserBluetoothTransport(),
  )
  const running = runtime.run(
    'reconnect:late-provider',
    CANCELLATION_ID,
    () => [envelope(1n, { kind: 'network_download', downloadId: 9n })],
    { persistence: noOpHost(), network },
  ).then(
    () => null,
    (error: unknown) => error,
  )
  await atProvider

  const cancelling = runtime.cancel('reconnect:late-provider')
  let watchdog: ReturnType<typeof setTimeout> | undefined
  const settled = await Promise.race([
    cancelling.then(() => true),
    new Promise<false>((resolve) => {
      watchdog = setTimeout(() => resolve(false), 5_000)
    }),
  ])
  if (watchdog) clearTimeout(watchdog)

  try {
    assert.equal(settled, true)
    assert.equal(hostCancelled, true)
    const runError = await running
    assert.ok(runError instanceof BotaSDKError)
    assert.equal(runError.code, 'cancelled')
  } finally {
    releaseProvider()
    await cancelling
  }

  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(dispatchCalls, 0)
})

test('destroy aborts a direct owner, waits for settlement, and is terminal', async () => {
  const runtime = new BrowserWorkflowRuntime(
    scriptedCore(),
    new FakeBrowserBluetoothTransport(),
  )
  let bodyStarted!: () => void
  const atBody = new Promise<void>((resolve) => {
    bodyStarted = resolve
  })
  const direct = runtime.runExclusive('settings', async (signal) => {
    bodyStarted()
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener(
        'abort',
        () => reject(new DOMException('private abort detail', 'AbortError')),
        { once: true },
      )
    })
  }).then(
    () => null,
    (error: unknown) => error,
  )
  await atBody

  await runtime.destroy()
  const error = await direct
  assert.ok(error instanceof BotaSDKError)
  assert.equal(error.code, 'cancelled')
  assert.equal(error.operation, 'settings')
  assert.doesNotMatch(error.message, /private abort detail/)

  let laterBodyCalled = false
  await assert.rejects(
    runtime.runExclusive('wifi', async () => {
      laterBodyCalled = true
    }),
    errorWith('cancelled', 'wifi'),
  )
  assert.equal(laterBodyCalled, false)
})

test('new core operations and errors retain stable public identities', () => {
  const cases = [
    ['UnsupportedCapability', 'Provision', 'unsupported_capability', 'provision'],
    ['DeviceNotFound', 'Reconnect', 'connection_failed', 'reconnect'],
    ['IntegrityFailed', 'TransferRecording', 'integrity_failed', 'transfer_recording'],
    ['DownloadFailed', 'Upload', 'upload_failed', 'upload'],
    ['ProtocolRejected', 'UpdateFirmware', 'firmware_rejected', 'update_firmware'],
    ['Cancelled', 'ReadDeviceLogs', 'cancelled', 'read_device_logs'],
  ] as const

  for (const [code, operation, expectedCode, expectedOperation] of cases) {
    const error = normalizeCoreError(
      {
        code,
        operation,
        retryable: true,
        detail: 'https://secret.example/token?credential=private',
      },
      'unknown',
    )
    assert.equal(error.code, expectedCode)
    assert.equal(error.operation, expectedOperation)
    assert.equal(error.retryable, true)
    assert.doesNotMatch(error.message, /secret|credential|https:/)
  }
})
