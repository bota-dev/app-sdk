import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  CoreBridge,
  CoreEffect,
  CoreEffectEnvelope,
  CoreHostEvent,
  CoreOperation,
  CoreWorkflowCheckpoint,
  CoreWorkflowStatus,
} from '../core.ts'
import { BotaSDKError, normalizeCoreError } from '../errors.ts'
import { BrowserStorageError } from '../storage.ts'
import {
  BrowserWorkflowRuntime,
  type WorkflowEffectHost,
} from '../workflowRuntime.ts'
import { FakeBrowserBluetoothTransport } from './fakeBluetooth.ts'
import { deferred } from './fakeProviders.ts'

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
  status?: () => CoreWorkflowStatus
} = {}): CoreBridge {
  return {
    dispatch: options.dispatch ?? (() => []),
    cancel: options.cancel ?? (() => []),
    status: options.status ?? (() => ({ kind: 'idle' })),
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

test('workflow cancellation joins an initiated GATT write before owner release and byte scrubbing', async () => {
  const transport = new FakeBrowserBluetoothTransport()
  const writeEntered = deferred<void>()
  const writeGate = deferred<void>()
  const originalWrite = transport.write.bind(transport)
  let transportReference: Uint8Array | null = null
  transport.write = async (
    device,
    serviceUuid,
    characteristicUuid,
    value,
    withResponse,
  ) => {
    transportReference = value
    transport.writeGate = writeGate.promise
    writeEntered.resolve(undefined)
    await originalWrite(device, serviceUuid, characteristicUuid, value, withResponse)
  }
  const payload = Uint8Array.of(0x91, 0x92, 0x93)
  const core = scriptedCore({
    dispatch: (event) => {
      if (event.kind === 'ble_connected') {
        return [envelope(2n, {
          kind: 'ble_write',
          serviceUuid: SERVICE_UUID,
          characteristicUuid: CHARACTERISTIC_UUID,
          payload,
          withResponse: true,
        })]
      }
      return []
    },
    cancel: () => [envelope(3n, {
      kind: 'notify',
      notification: { kind: 'cancelled', operation: 'reconnect' },
    })],
    status: () => ({
      kind: 'running',
      operation: 'reconnect',
      cancellationId: CANCELLATION_ID.slice(),
    }),
  })
  const runtime = new BrowserWorkflowRuntime(core, transport)
  runtime.registerDevice(transport.device)
  const running = runtime.run(
    'reconnect:blocked-write',
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
  await settleWithWatchdog(writeEntered.promise, 'workflow write start')

  let cancellationSettled = false
  const cancelling = runtime.cancel('reconnect:blocked-write').then(() => {
    cancellationSettled = true
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(cancellationSettled, false)
  const capturedTransportReference = transportReference as unknown as Uint8Array
  assert.ok(capturedTransportReference)
  assert.equal(capturedTransportReference.every((byte) => byte === 0), false)
  await assert.rejects(
    runtime.runExclusive('settings', async () => undefined),
    errorWith('operation_in_progress', 'settings'),
  )

  writeGate.resolve(undefined)
  await settleWithWatchdog(cancelling, 'workflow write cancellation')
  const result = await settleWithWatchdog(running, 'cancelled write workflow')
  assert.ok(result instanceof BotaSDKError)
  assert.equal(result.code, 'cancelled')
  assert.ok(capturedTransportReference.every((byte) => byte === 0))
  assert.ok(payload.every((byte) => byte === 0))

  let nextOwnerRan = false
  await runtime.runExclusive('settings', async () => {
    nextOwnerRan = true
  })
  assert.equal(nextOwnerRan, true)
})

test('cancellation retains ownership until pending subscription setup is removed', async () => {
  const transport = new FakeBrowserBluetoothTransport()
  let subscriptionStarted!: () => void
  const atSubscription = new Promise<void>((resolve) => {
    subscriptionStarted = resolve
  })
  let releaseSubscription!: () => void
  transport.subscribeGate = new Promise<void>((resolve) => {
    releaseSubscription = resolve
  })
  transport.onSubscribe = subscriptionStarted
  let unsubscribeStarted!: () => void
  const atUnsubscribe = new Promise<void>((resolve) => {
    unsubscribeStarted = resolve
  })
  let releaseUnsubscribe!: () => void
  transport.unsubscribeGate = new Promise<void>((resolve) => {
    releaseUnsubscribe = resolve
  })
  transport.onUnsubscribe = unsubscribeStarted
  const core = scriptedCore({
    dispatch: (event) => {
      if (event.kind === 'ble_connected') {
        return [envelope(2n, {
          kind: 'ble_subscribe',
          serviceUuid: SERVICE_UUID,
          characteristicUuid: CHARACTERISTIC_UUID,
        })]
      }
      throw new Error(`unexpected event ${event.kind}`)
    },
    cancel: () => [envelope(3n, {
      kind: 'notify',
      notification: { kind: 'cancelled', operation: 'reconnect' },
    })],
  })
  const runtime = new BrowserWorkflowRuntime(core, transport)
  runtime.registerDevice(transport.device)
  const running = runtime.run(
    'reconnect:gated-subscription',
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
  await atSubscription

  let cancellationSettled = false
  const cancelling = runtime.cancel('reconnect:gated-subscription').then(() => {
    cancellationSettled = true
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  const settledBeforeRelease = cancellationSettled
  const secondOwner = await runtime.runExclusive('settings', async () => {
    await transport.write(
      transport.device,
      SERVICE_UUID,
      CHARACTERISTIC_UUID,
      Uint8Array.of(0xff),
      true,
    )
  }).then(
    () => null,
    (error: unknown) => error,
  )
  const callsBeforeRelease = [...transport.calls]

  releaseSubscription()
  await settleWithWatchdog(atUnsubscribe, 'late subscription cleanup start')
  await new Promise<void>((resolve) => setImmediate(resolve))
  const settledDuringCleanup = cancellationSettled
  releaseUnsubscribe()
  await settleWithWatchdog(cancelling, 'subscription cancellation')
  const runError = await settleWithWatchdog(running, 'cancelled workflow')

  assert.equal(settledBeforeRelease, false)
  assert.equal(settledDuringCleanup, false)
  assert.ok(secondOwner instanceof BotaSDKError)
  assert.equal(secondOwner.code, 'operation_in_progress')
  assert.equal(
    callsBeforeRelease.some((call) => call.startsWith('write:')),
    false,
  )
  assert.ok(
    transport.calls.includes(
      'unsubscribe:browser-peripheral-1:180A:2A25',
    ),
  )
  assert.ok(runError instanceof BotaSDKError)
  assert.equal(runError.code, 'cancelled')
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

test('host failure executes core cancellation effects before releasing ownership', async () => {
  const transport = new FakeBrowserBluetoothTransport()
  let writeStarted!: () => void
  const atWrite = new Promise<void>((resolve) => {
    writeStarted = resolve
  })
  let releaseWrite!: () => void
  transport.writeGate = new Promise<void>((resolve) => {
    releaseWrite = resolve
  })
  transport.onWrite = writeStarted
  const cancellationSequence: string[] = []
  let cancelCalls = 0
  const core = scriptedCore({
    dispatch: (event) => {
      if (event.kind === 'ble_connected') {
        return [envelope(2n, {
          kind: 'persistence_save_checkpoint',
          checkpoint: CHECKPOINT,
        })]
      }
      if (event.kind === 'ble_write_completed') {
        cancellationSequence.push('ble_abort_completed')
        return []
      }
      throw new Error(`unexpected event ${event.kind}`)
    },
    cancel: () => {
      cancelCalls += 1
      cancellationSequence.push('core_cancelled')
      return [
        envelope(3n, {
          kind: 'ble_write',
          serviceUuid: SERVICE_UUID,
          characteristicUuid: CHARACTERISTIC_UUID,
          payload: Uint8Array.of(0xab, 0x0f),
          withResponse: true,
        }),
        envelope(4n, {
          kind: 'notify',
          notification: { kind: 'cancelled', operation: 'reconnect' },
        }),
      ]
    },
  })
  const persistence: WorkflowEffectHost = {
    execute: async () => {
      throw new BrowserStorageError('storage_quota_exceeded')
    },
    cancel: async () => {
      cancellationSequence.push('persistence_cancelled')
    },
  }
  const runtime = new BrowserWorkflowRuntime(core, transport)
  runtime.registerDevice(transport.device)

  let workflowSettled = false
  const running = runtime.run(
    'reconnect:quota-failure',
    CANCELLATION_ID,
    () => [envelope(1n, {
      kind: 'ble_connect',
      peripheralId: transport.device.id,
    })],
    { persistence },
    {
      onNotification: (notification) => {
        if (notification.kind === 'cancelled') {
          cancellationSequence.push('cancelled_notification')
        }
      },
    },
  ).then(
    () => {
      workflowSettled = true
      return null
    },
    (reason: unknown) => {
      workflowSettled = true
      return reason
    },
  )
  await settleWithWatchdog(atWrite, 'cancellation BLE abort start')
  await new Promise<void>((resolve) => setImmediate(resolve))
  const settledDuringAbort = workflowSettled
  let secondBodyCalls = 0
  const secondOwner = await runtime.runExclusive('settings', async () => {
    secondBodyCalls += 1
  }).then(
    () => null,
    (reason: unknown) => reason,
  )
  releaseWrite()
  const error = await settleWithWatchdog(running, 'failed workflow cleanup')

  assert.equal(settledDuringAbort, false)
  assert.ok(secondOwner instanceof BotaSDKError)
  assert.equal(secondOwner.code, 'operation_in_progress')
  assert.equal(secondBodyCalls, 0)
  assert.ok(error instanceof BotaSDKError)
  assert.equal(error.code, 'storage_quota_exceeded')
  assert.equal(error.operation, 'reconnect')
  assert.equal(cancelCalls, 1)
  assert.ok(
    transport.calls.includes(
      'write:browser-peripheral-1:180A:2A25:true',
    ),
  )
  assert.deepEqual(cancellationSequence, [
    'persistence_cancelled',
    'core_cancelled',
    'ble_abort_completed',
    'cancelled_notification',
  ])
})

test('failure cancellation drains later effects after one cleanup effect rejects', async () => {
  const transport = new FakeBrowserBluetoothTransport()
  const cancellationSequence: string[] = []
  let discardCalls = 0
  let deleteCalls = 0
  let notificationCalls = 0
  let cancelCalls = 0
  let deleteStarted!: () => void
  const atDelete = new Promise<void>((resolve) => {
    deleteStarted = resolve
  })
  let releaseDelete!: () => void
  const deleteGate = new Promise<void>((resolve) => {
    releaseDelete = resolve
  })
  const core = scriptedCore({
    dispatch: (event) => {
      if (event.kind === 'ble_connected') {
        return [envelope(2n, {
          kind: 'persistence_save_checkpoint',
          checkpoint: CHECKPOINT,
        })]
      }
      throw new Error(`unexpected event ${event.kind}`)
    },
    cancel: () => {
      cancelCalls += 1
      return [
        envelope(3n, {
          kind: 'recording_sink_discard',
          sinkId: 'recording-sink-1',
        }),
        envelope(4n, { kind: 'persistence_delete_checkpoint' }),
        envelope(5n, {
          kind: 'notify',
          notification: { kind: 'cancelled', operation: 'reconnect' },
        }),
      ]
    },
  })
  const persistence: WorkflowEffectHost = {
    execute: async (effect) => {
      if (effect.effect.kind === 'persistence_save_checkpoint') {
        throw new BrowserStorageError('storage_quota_exceeded')
      }
      assert.equal(effect.effect.kind, 'persistence_delete_checkpoint')
      deleteCalls += 1
      cancellationSequence.push('checkpoint_delete_started')
      deleteStarted()
      await deleteGate
      cancellationSequence.push('checkpoint_delete_settled')
      return null
    },
    cancel: async () => undefined,
  }
  const recordingSink: WorkflowEffectHost = {
    execute: async (effect) => {
      assert.equal(effect.effect.kind, 'recording_sink_discard')
      discardCalls += 1
      cancellationSequence.push('sink_discard_rejected')
      throw new Error('private cleanup failure')
    },
    cancel: async () => undefined,
  }
  const runtime = new BrowserWorkflowRuntime(core, transport)
  runtime.registerDevice(transport.device)

  let workflowSettled = false
  const running = runtime.run(
    'reconnect:drain-cancellation-effects',
    CANCELLATION_ID,
    () => [envelope(1n, {
      kind: 'ble_connect',
      peripheralId: transport.device.id,
    })],
    { persistence, recordingSink },
    {
      onNotification: (notification) => {
        if (notification.kind === 'cancelled') {
          notificationCalls += 1
          cancellationSequence.push('cancelled_notification')
        }
      },
    },
  ).then(
    () => {
      workflowSettled = true
      return null
    },
    (reason: unknown) => {
      workflowSettled = true
      return reason
    },
  )

  await settleWithWatchdog(atDelete, 'cancellation checkpoint deletion start')
  try {
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(workflowSettled, false)
    let secondBodyCalls = 0
    const secondOwner = await runtime.runExclusive('settings', async () => {
      secondBodyCalls += 1
    }).then(
      () => null,
      (reason: unknown) => reason,
    )
    assert.ok(secondOwner instanceof BotaSDKError)
    assert.equal(secondOwner.code, 'operation_in_progress')
    assert.equal(secondBodyCalls, 0)
  } finally {
    releaseDelete()
  }

  const error = await settleWithWatchdog(running, 'failed workflow cleanup')
  assert.ok(error instanceof BotaSDKError)
  assert.equal(error.code, 'storage_quota_exceeded')
  assert.equal(error.operation, 'reconnect')
  assert.doesNotMatch(error.message, /private cleanup failure/)
  assert.equal(cancelCalls, 1)
  assert.equal(discardCalls, 1)
  assert.equal(deleteCalls, 1)
  assert.equal(notificationCalls, 1)
  assert.deepEqual(cancellationSequence, [
    'sink_discard_rejected',
    'checkpoint_delete_started',
    'checkpoint_delete_settled',
    'cancelled_notification',
  ])
})

test('failure cleanup shares one cancellation entry with cancel and destroy', async (t) => {
  for (const entryPoint of ['cancel', 'destroy'] as const) {
    await t.test(entryPoint, async () => {
      const transport = new FakeBrowserBluetoothTransport()
      const operationId = `reconnect:shared-${entryPoint}`
      const cancellationSequence: string[] = []
      let cancelCalls = 0
      let discardCalls = 0
      let gatedCalls = 0
      let deleteCalls = 0
      let notificationCalls = 0
      let gateStarted!: () => void
      const atGate = new Promise<void>((resolve) => {
        gateStarted = resolve
      })
      let releaseGate!: () => void
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve
      })
      let gatedSignal: AbortSignal | undefined
      const core = scriptedCore({
        dispatch: (event) => {
          if (event.kind === 'ble_connected') {
            return [envelope(2n, {
              kind: 'persistence_save_checkpoint',
              checkpoint: CHECKPOINT,
            })]
          }
          throw new Error(`unexpected event ${event.kind}`)
        },
        cancel: () => {
          cancelCalls += 1
          if (cancelCalls > 1) return []
          return [
            envelope(3n, {
              kind: 'recording_sink_discard',
              sinkId: 'recording-sink-1',
            }),
            envelope(4n, { kind: 'network_download', downloadId: 7n }),
            envelope(5n, { kind: 'persistence_delete_checkpoint' }),
            envelope(6n, {
              kind: 'notify',
              notification: { kind: 'cancelled', operation: 'reconnect' },
            }),
          ]
        },
      })
      const persistence: WorkflowEffectHost = {
        execute: async (effect) => {
          if (effect.effect.kind === 'persistence_save_checkpoint') {
            throw new BrowserStorageError('storage_quota_exceeded')
          }
          assert.equal(effect.effect.kind, 'persistence_delete_checkpoint')
          deleteCalls += 1
          cancellationSequence.push('checkpoint_deleted')
          return null
        },
        cancel: async () => undefined,
      }
      const recordingSink: WorkflowEffectHost = {
        execute: async (effect) => {
          assert.equal(effect.effect.kind, 'recording_sink_discard')
          discardCalls += 1
          cancellationSequence.push('sink_discard_rejected')
          throw new Error('private cleanup failure')
        },
        cancel: async () => undefined,
      }
      const network: WorkflowEffectHost = {
        execute: async (effect, context) => {
          assert.equal(effect.effect.kind, 'network_download')
          gatedCalls += 1
          gatedSignal = context.signal
          cancellationSequence.push('gated_cleanup_started')
          gateStarted()
          await gate
          cancellationSequence.push('gated_cleanup_settled')
          return null
        },
        cancel: async () => undefined,
      }
      const runtime = new BrowserWorkflowRuntime(core, transport)
      runtime.registerDevice(transport.device)

      let workflowSettled = false
      const running = runtime.run(
        operationId,
        CANCELLATION_ID,
        () => [envelope(1n, {
          kind: 'ble_connect',
          peripheralId: transport.device.id,
        })],
        { persistence, recordingSink, network },
        {
          onNotification: (notification) => {
            if (notification.kind === 'cancelled') {
              notificationCalls += 1
              cancellationSequence.push('cancelled_notification')
            }
          },
        },
      ).then(
        () => {
          workflowSettled = true
          return null
        },
        (reason: unknown) => {
          workflowSettled = true
          return reason
        },
      )
      await settleWithWatchdog(atGate, `${entryPoint} cleanup gate start`)

      let entrySettled = false
      const entry = (
        entryPoint === 'cancel'
          ? runtime.cancel(operationId)
          : runtime.destroy()
      ).then(
        () => {
          entrySettled = true
          cancellationSequence.push('entry_settled')
          return null
        },
        (reason: unknown) => {
          entrySettled = true
          cancellationSequence.push('entry_settled')
          return reason
        },
      )
      await new Promise<void>((resolve) => setImmediate(resolve))
      const entrySettledBeforeRelease = entrySettled
      const workflowSettledBeforeRelease = workflowSettled
      const signalAbortedBeforeRelease = gatedSignal?.aborted
      const cancelCallsBeforeRelease = cancelCalls
      let secondBodyCalls = 0
      const secondOwner = await runtime.runExclusive('settings', async () => {
        secondBodyCalls += 1
      }).then(
        () => null,
        (reason: unknown) => reason,
      )

      releaseGate()
      const [entryResult, workflowError] = await Promise.all([
        settleWithWatchdog(entry, `${entryPoint} failure cleanup`),
        settleWithWatchdog(running, `${entryPoint} failed workflow`),
      ])

      assert.equal(entrySettledBeforeRelease, false)
      assert.equal(workflowSettledBeforeRelease, false)
      assert.equal(signalAbortedBeforeRelease, false)
      assert.equal(cancelCallsBeforeRelease, 1)
      assert.ok(secondOwner instanceof BotaSDKError)
      assert.equal(
        secondOwner.code,
        entryPoint === 'cancel' ? 'operation_in_progress' : 'cancelled',
      )
      assert.equal(secondBodyCalls, 0)
      assert.equal(entryResult, null)
      assert.ok(workflowError instanceof BotaSDKError)
      assert.equal(workflowError.code, 'storage_quota_exceeded')
      assert.equal(workflowError.operation, 'reconnect')
      assert.equal(cancelCalls, 1)
      assert.equal(discardCalls, 1)
      assert.equal(gatedCalls, 1)
      assert.equal(deleteCalls, 1)
      assert.equal(notificationCalls, 1)
      assert.deepEqual(cancellationSequence, [
        'sink_discard_rejected',
        'gated_cleanup_started',
        'gated_cleanup_settled',
        'checkpoint_deleted',
        'cancelled_notification',
        'entry_settled',
      ])
    })
  }
})

test('firmware progress allows canonical phase resets', async () => {
  const progress: Array<[bigint, bigint]> = []
  const runtime = new BrowserWorkflowRuntime(
    scriptedCore(),
    new FakeBrowserBluetoothTransport(),
  )

  await runtime.run(
    'update_firmware:phase-transition',
    CANCELLATION_ID,
    () => [
      envelope(1n, {
        kind: 'notify',
        notification: {
          kind: 'firmware_progress',
          phase: 'downloading',
          completedBytes: 20n,
          totalBytes: 20n,
        },
      }, CANCELLATION_ID, 'update_firmware'),
      envelope(2n, {
        kind: 'notify',
        notification: {
          kind: 'firmware_progress',
          phase: 'awaiting_device',
          completedBytes: 0n,
          totalBytes: 20n,
        },
      }, CANCELLATION_ID, 'update_firmware'),
      envelope(3n, {
        kind: 'notify',
        notification: { kind: 'completed', operation: 'update_firmware' },
      }, CANCELLATION_ID, 'update_firmware'),
    ],
    { persistence: noOpHost() },
    { onProgress: (completed, total) => progress.push([completed, total]) },
  )

  assert.deepEqual(progress, [[20n, 20n], [0n, 20n]])
})

test('firmware progress still rejects a regression within one phase', async () => {
  const runtime = new BrowserWorkflowRuntime(
    scriptedCore(),
    new FakeBrowserBluetoothTransport(),
  )

  await assert.rejects(
    runtime.run(
      'update_firmware:phase-regression',
      CANCELLATION_ID,
      () => [
        envelope(1n, {
          kind: 'notify',
          notification: {
            kind: 'firmware_progress',
            phase: 'transferring',
            completedBytes: 10n,
            totalBytes: 20n,
          },
        }, CANCELLATION_ID, 'update_firmware'),
        envelope(2n, {
          kind: 'notify',
          notification: {
            kind: 'firmware_progress',
            phase: 'transferring',
            completedBytes: 9n,
            totalBytes: 20n,
          },
        }, CANCELLATION_ID, 'update_firmware'),
      ],
      { persistence: noOpHost() },
    ),
    errorWith('protocol_error', 'update_firmware'),
  )
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
