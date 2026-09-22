import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { BotaDeviceClient } from '../client.ts'
import type { CoreBridge } from '../core.ts'
import { DeviceManager } from '../deviceManager.ts'
import { BotaSDKError } from '../errors.ts'
import {
  BOTA_STORAGE_SERVICE,
  RECORDING_LIST_CHARACTERISTIC,
  RECORDING_TRANSFER_CHARACTERISTIC,
  TRANSFER_CONTROL_CHARACTERISTIC,
} from '../gatt.ts'
import type { DeviceRecording } from '../models.ts'
import type { UploadRequestTemplate } from '../providers.ts'
import { RecordingManager } from '../recordingManager.ts'
import type { RecordingJournal, RecordingJournalPhase } from '../storage.ts'
import { BrowserStorageError } from '../storage.ts'
import { createWasmCore } from '../wasmCore.ts'
import { BrowserWorkflowRuntime } from '../workflowRuntime.ts'
import { FakeBrowserBluetoothTransport } from './fakeBluetooth.ts'
import {
  deferred,
  FakeRecordingStorage,
  FakeRecordingUploadProvider,
} from './fakeProviders.ts'

const SERIAL = 'GDPPSBZJN6'
const RECORDING_UUID = 'a1b2c3d4-0000-0000-0000-000000000000'
const OPERATION_ID = 'legacy-operation-1'
const SINK_ID = `recording:${OPERATION_ID}`
const PAYLOAD = new TextEncoder().encode('123456789')
const DATA_PACKET = Uint8Array.of(0x01, 0x00, 0x00, 0x09, 0x00, ...PAYLOAD)
const GOOD_EOF_PACKET = Uint8Array.of(0x02, 0x01, 0x00, 0x26, 0x39, 0xf4, 0xcb)
const BAD_EOF_PACKET = Uint8Array.of(0x02, 0x01, 0x00, 0, 0, 0, 0)
const SHA256_PACKET = Uint8Array.of(
  0x04,
  ...Array.from({ length: 32 }, (_, index) => index),
)
const ENCRYPTED_START_PACKET = Uint8Array.of(
  0x05,
  ...Array.from({ length: 32 }, (_, index) => 0x20 + index),
  0xaa,
  0xbb,
  0xcc,
  0xdd,
)
const ENCRYPTED_CHUNK = Uint8Array.of(
  ...Array.from({ length: 17 }, (_, index) => 0x80 + index),
)
const ENCRYPTED_DATA_PACKET = Uint8Array.of(
  0x81,
  0x00,
  0x00,
  ENCRYPTED_CHUNK.byteLength,
  0x00,
  ...ENCRYPTED_CHUNK,
)
const ENCRYPTED_EOF_PACKET = Uint8Array.of(0x82, 0x01, 0x00, 0, 0, 0, 0)
const ENCRYPTED_STAGED_BODY = Uint8Array.of(
  ...ENCRYPTED_START_PACKET.slice(1),
  0x00,
  0x01,
  ...ENCRYPTED_CHUNK,
)

const wasmBytes = readFile(
  new URL('../generated/bota_device_sdk_core_bg.wasm', import.meta.url),
)

interface Harness {
  core: CoreBridge
  devices: DeviceManager
  events: string[]
  manager: RecordingManager
  provider: FakeRecordingUploadProvider
  runtime: BrowserWorkflowRuntime
  storage: FakeRecordingStorage
  transport: FakeBrowserBluetoothTransport
  fetchCalls: number
  setFetch(
    fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  ): void
}

async function createHarness(): Promise<Harness> {
  const events: string[] = []
  const core = await createWasmCore(await wasmBytes)
  const transport = new FakeBrowserBluetoothTransport()
  transport.eventLog = events
  const storage = new FakeRecordingStorage(undefined, events)
  const provider = new FakeRecordingUploadProvider(events)
  const runtime = new BrowserWorkflowRuntime(core, transport)
  const devices = new DeviceManager(core, transport, { runtime, storage })
  let fetchCalls = 0
  let fetchImplementation = streamingFetch(events)
  const manager = new RecordingManager(
    core,
    transport,
    runtime,
    devices,
    storage,
    provider,
    async (input, init) => {
      fetchCalls += 1
      return await fetchImplementation(input, init)
    },
    () => 1_700_000_000_000 + events.length,
  )
  await devices.connect({ expectedSerialNumber: SERIAL })
  events.length = 0
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
    get fetchCalls() {
      return fetchCalls
    },
    setFetch(fetcher) {
      fetchImplementation = fetcher
    },
  }
}

test('LIST subscribes before its write, decodes one list, and always unsubscribes', async () => {
  const harness = await createHarness()
  const listBytes = await recordingListFixture()
  const listCommand = await transferFixture('list-command')

  const success = harness.manager.list()
  await waitForWrite(harness.transport, listCommand)
  harness.transport.emitNotification(
    harness.transport.device,
    BOTA_STORAGE_SERVICE,
    RECORDING_LIST_CHARACTERISTIC,
    listBytes,
  )
  assert.deepEqual(await success, [recording(4_096n, true)])

  const subscribe = harness.events.findIndex((event) =>
    event.startsWith('subscribe:') && event.includes(RECORDING_LIST_CHARACTERISTIC)
  )
  const write = harness.events.findIndex((event) => event.startsWith('write:'))
  const unsubscribe = harness.events.findIndex((event) =>
    event.startsWith('unsubscribe:') && event.includes(RECORDING_LIST_CHARACTERISTIC)
  )
  assert.ok(subscribe >= 0 && subscribe < write)
  assert.ok(write < unsubscribe)

  harness.events.length = 0
  harness.transport.writes.length = 0
  harness.transport.onWrite = () => {
    throw new Error('write failed')
  }
  const failed = assert.rejects(harness.manager.list())
  await waitForWrite(harness.transport, listCommand)
  await failed
  assert.ok(harness.events.some((event) =>
    event.startsWith('unsubscribe:') && event.includes(RECORDING_LIST_CHARACTERISTIC)
  ))
})

test('disconnect after the LIST write aborts the direct owner, unsubscribes, and permits reconnect', async () => {
  const harness = await createHarness()
  const list = harness.manager.list()
  const rejected = assert.rejects(list, (error: unknown) =>
    error instanceof BotaSDKError && error.code === 'device_disconnected'
  )
  await waitForWrite(
    harness.transport,
    await transferFixture('list-command'),
  )

  harness.transport.emitDisconnected()
  await settleWithWatchdog(rejected, 'LIST disconnect cleanup')

  assert.ok(harness.events.some((event) =>
    event.startsWith('unsubscribe:')
      && event.includes(RECORDING_LIST_CHARACTERISTIC)
  ))
  const reconnected = await settleWithWatchdog(
    harness.devices.reconnect({ expectedSerialNumber: SERIAL }),
    'authorized reconnect after LIST disconnect',
  )
  assert.equal(reconnected.serialNumber, SERIAL)
})

test('legacy sync durably stages before upload and persists cloud completion before CONFIRM', async () => {
  const harness = await createHarness()
  const writeGate = deferred<void>()
  const startCommand = await transferFixture('start-command')
  const confirmCommand = await transferFixture('confirm-command')

  const sync = harness.manager.sync(recording(9n), {
    profile: 'legacy',
    operationId: OPERATION_ID,
  })
  await waitForWrite(harness.transport, startCommand)
  await settleReducer()

  assert.ok(indexOf(harness.events, 'journal:prepared') < writeIndex(
    harness.transport,
    startCommand,
    harness.events,
  ))
  const blob = harness.storage.blobs.get(SINK_ID)
  assert.ok(blob)
  blob.writeGate = writeGate.promise
  harness.transport.emitNotification(
    harness.transport.device,
    BOTA_STORAGE_SERVICE,
    RECORDING_TRANSFER_CHARACTERISTIC,
    DATA_PACKET,
  )
  await eventually(() => harness.events.includes('blob:write_begin:0:9'))
  assert.equal(harness.events.includes('workflow:save'), false)

  writeGate.resolve(undefined)
  await eventually(() => harness.events.includes('workflow:save'))
  assert.ok(
    indexOf(harness.events, 'blob:write_durable:9')
      < indexOf(harness.events, 'workflow:save'),
  )
  await finishTransfer(harness)

  const result = await sync
  assert.deepEqual(result, {
    operationId: OPERATION_ID,
    recordingUuid: RECORDING_UUID,
    profile: 'legacy',
    cloudCompletionId: 'cloud-completion-1',
  })
  assert.ok(
    indexOf(harness.events, 'journal:staged')
      < indexOf(harness.events, 'provider:prepare'),
  )
  assert.ok(
    indexOf(harness.events, 'journal:cloud_completed')
      < writeIndex(harness.transport, confirmCommand, harness.events),
  )
  assert.ok(harness.events.includes('blob:stream'))
  assert.ok(harness.events.filter((event) =>
    event.startsWith('blob:stream_chunk:')
  ).length > 1)
  assert.equal(harness.storage.recordingJournals.has(OPERATION_ID), false)
  assert.equal(blob.deleteCalls, 1)
  assert.equal(harness.provider.prepared.length, 1)
  assert.equal(harness.provider.completed.length, 1)
})

test('encrypted legacy sync preserves the device plaintext digest separately from staged wire integrity', async () => {
  const harness = await createHarness()
  const prepareEntered = deferred<void>()
  const prepareGate = deferred<void>()
  harness.provider.prepareLegacyUpload = async (context) => {
    harness.events.push('provider:prepare')
    harness.provider.prepared.push(context)
    prepareEntered.resolve(undefined)
    await prepareGate.promise
    return {
      uploadId: 'upload-encrypted',
      request: { ...harness.provider.request },
    }
  }
  const stagedHasher = harness.core.createIntegrityHasher()
  stagedHasher.update(ENCRYPTED_STAGED_BODY)
  const expectedPlaintextSha256Hex = bytesHex(SHA256_PACKET.slice(1))
  const expectedStagedBodySha256Hex = bytesHex(stagedHasher.sha256Snapshot())
  assert.notEqual(expectedPlaintextSha256Hex, expectedStagedBodySha256Hex)
  harness.setFetch(async (_input, init) => {
    assert.ok(init?.body instanceof ReadableStream)
    const reader = init.body.getReader()
    let uploadedBytes = 0
    while (true) {
      const next = await reader.read()
      if (next.done) break
      uploadedBytes += next.value.byteLength
    }
    assert.equal(uploadedBytes, ENCRYPTED_STAGED_BODY.byteLength)
    return new Response(null, { status: 200 })
  })

  const sync = harness.manager.sync(
    recording(BigInt(ENCRYPTED_STAGED_BODY.byteLength), true),
    { profile: 'legacy', operationId: OPERATION_ID },
  )
  await waitForWrite(harness.transport, await transferFixture('start-command'))
  await settleReducer()
  harness.transport.emitNotification(
    harness.transport.device,
    BOTA_STORAGE_SERVICE,
    RECORDING_TRANSFER_CHARACTERISTIC,
    ENCRYPTED_START_PACKET,
  )
  await eventually(() => harness.events.includes('blob:write_durable:36'))
  harness.transport.emitNotification(
    harness.transport.device,
    BOTA_STORAGE_SERVICE,
    RECORDING_TRANSFER_CHARACTERISTIC,
    ENCRYPTED_DATA_PACKET,
  )
  await eventually(() => harness.events.includes(
    `blob:write_durable:${ENCRYPTED_STAGED_BODY.byteLength}`,
  ))
  harness.transport.emitNotification(
    harness.transport.device,
    BOTA_STORAGE_SERVICE,
    RECORDING_TRANSFER_CHARACTERISTIC,
    ENCRYPTED_EOF_PACKET,
  )
  harness.transport.emitNotification(
    harness.transport.device,
    BOTA_STORAGE_SERVICE,
    RECORDING_TRANSFER_CHARACTERISTIC,
    SHA256_PACKET,
  )
  await prepareEntered.promise

  const staged = await harness.storage.loadRecordingJournal(OPERATION_ID)
  assert.equal(staged?.phase, 'staged')
  assert.equal(
    staged?.devicePlaintextSha256Hex,
    expectedPlaintextSha256Hex,
  )
  assert.equal(
    harness.provider.prepared[0]?.plaintextSha256Hex,
    expectedPlaintextSha256Hex,
  )
  assert.equal(
    harness.provider.prepared[0]?.stagedBodySha256Hex,
    expectedStagedBodySha256Hex,
  )
  assert.equal('sha256Hex' in (harness.provider.prepared[0] ?? {}), false)

  prepareGate.resolve(undefined)
  await sync
  assert.equal(
    harness.provider.completed[0]?.plaintextSha256Hex,
    expectedPlaintextSha256Hex,
  )
  assert.equal(
    harness.provider.completed[0]?.stagedBodySha256Hex,
    expectedStagedBodySha256Hex,
  )
})

test('CRC failure sends NACK, skips every upload destination, and preserves the device recording', async () => {
  const harness = await createHarness()
  const startCommand = await transferFixture('start-command')
  const confirmCommand = await transferFixture('confirm-command')

  const sync = harness.manager.sync(recording(9n), {
    profile: 'legacy',
    operationId: OPERATION_ID,
  })
  const rejected = assert.rejects(sync, (error: unknown) =>
    error instanceof BotaSDKError && error.code === 'integrity_failed'
  )
  await waitForWrite(harness.transport, startCommand)
  await settleReducer()
  await sendData(harness)
  harness.transport.emitNotification(
    harness.transport.device,
    BOTA_STORAGE_SERVICE,
    RECORDING_TRANSFER_CHARACTERISTIC,
    BAD_EOF_PACKET,
  )

  await rejected
  assert.ok(harness.transport.writes.some(({ value }) => value[0] === 0x11))
  assert.equal(harness.provider.prepared.length, 0)
  assert.equal(harness.fetchCalls, 0)
  assert.equal(hasWrite(harness.transport, confirmCommand), false)
})

test('an ambiguous upload reconciles before retry and never persists URL or headers', async () => {
  const harness = await createHarness()
  const startCommand = await transferFixture('start-command')
  let uploadAttempt = 0
  harness.setFetch(async (input, init) => {
    uploadAttempt += 1
    harness.events.push(`fetch:${uploadAttempt}`)
    if (uploadAttempt === 1) throw new TypeError('ambiguous network failure')
    return await streamingFetch(harness.events)(input, init)
  })

  const first = harness.manager.sync(recording(9n), {
    profile: 'legacy',
    operationId: OPERATION_ID,
  })
  const firstRejected = assert.rejects(first, (error: unknown) =>
    error instanceof BotaSDKError && error.code === 'upload_failed'
  )
  await waitForWrite(harness.transport, startCommand)
  await settleReducer()
  await sendData(harness)
  await finishTransfer(harness, false)
  await firstRejected

  const ambiguous = await harness.storage.loadRecordingJournal(OPERATION_ID)
  assert.equal(ambiguous?.phase, 'uploading')
  assert.equal(await (await harness.storage.openBlob(SINK_ID)).size(), 9)
  assert.equal(hasConfirmWrite(harness.transport), false)
  assert.equal(JSON.stringify(ambiguous).includes('upload-secret'), false)

  harness.events.length = 0
  harness.transport.writes.length = 0
  const resumed = harness.manager.resume(OPERATION_ID)
  await answerNextList(harness)
  await resumed

  assert.ok(
    indexOf(harness.events, 'provider:reconcile')
      < indexOf(harness.events, 'provider:prepare'),
  )
  assert.ok(
    indexOf(harness.events, 'provider:prepare')
      < indexOf(harness.events, 'fetch:2'),
  )
  assert.ok(harness.events.includes('journal:staged'))
})

test('cancellation after a successful fetch preserves ambiguous upload evidence for reconciliation', async () => {
  const harness = await createHarness()
  const completionEntered = deferred<void>()
  const completionGate = deferred<void>()
  harness.provider.completeLegacyUpload = async (context) => {
    harness.events.push('provider:complete')
    harness.provider.completed.push(context)
    completionEntered.resolve(undefined)
    await completionGate.promise
    return { cloudCompletionId: 'late-cloud-completion' }
  }

  const sync = harness.manager.sync(recording(9n), {
    profile: 'legacy',
    operationId: OPERATION_ID,
  })
  const rejected = assert.rejects(sync, (error: unknown) =>
    error instanceof BotaSDKError && error.code === 'cancelled'
  )
  await waitForWrite(harness.transport, await transferFixture('start-command'))
  await settleReducer()
  await sendData(harness)
  await finishTransfer(harness, false)
  await completionEntered.promise

  await harness.manager.cancel(OPERATION_ID)
  await rejected

  const ambiguous = await harness.storage.loadRecordingJournal(OPERATION_ID)
  assert.equal(ambiguous?.phase, 'uploading')
  assert.equal(ambiguous?.uploadId, 'upload-1')
  assert.equal(
    ambiguous?.devicePlaintextSha256Hex,
    bytesHex(SHA256_PACKET.slice(1)),
  )
  assert.equal(await (await harness.storage.openBlob(SINK_ID)).size(), 9)
  assert.equal(hasConfirmWrite(harness.transport), false)

  completionGate.resolve(undefined)
  harness.provider.reconcileResult = {
    state: 'cloud_completed',
    cloudCompletionId: 'reconciled-cloud-completion',
  }
  harness.events.length = 0
  harness.transport.writes.length = 0
  const resumed = harness.manager.resume(OPERATION_ID)
  await answerNextList(harness)
  const result = await resumed

  assert.equal(result.cloudCompletionId, 'reconciled-cloud-completion')
  assert.equal(
    harness.provider.reconciled[0]?.plaintextSha256Hex,
    bytesHex(SHA256_PACKET.slice(1)),
  )
  assert.ok(
    indexOf(harness.events, 'provider:reconcile')
      < writeIndex(
        harness.transport,
        await transferFixture('confirm-command'),
        harness.events,
      ),
  )
})

test('confirm rejects non-cloud phases and confirmed recovery only removes local state', async () => {
  const harness = await createHarness()
  const disallowed: RecordingJournalPhase[] = [
    'prepared',
    'transferring',
    'staged',
    'uploading',
  ]

  for (const phase of disallowed) {
    const operationId = `confirm-${phase}`
    harness.storage.recordingJournals.set(
      operationId,
      journal(operationId, phase, phase === 'uploading' ? 'upload-1' : null),
    )
    await assert.rejects(harness.manager.confirm(operationId), (error: unknown) =>
      error instanceof BotaSDKError && error.code === 'resume_rejected'
    )
  }
  assert.equal(hasConfirmWrite(harness.transport), false)

  const cloudCompletedOperation = 'cloud-completed-confirm'
  const cloudCompleted = journal(
    cloudCompletedOperation,
    'cloud_completed',
    'upload-cloud',
    'cloud-ready',
  )
  harness.storage.recordingJournals.set(cloudCompletedOperation, cloudCompleted)
  await harness.manager.confirm(cloudCompletedOperation)
  assert.equal(hasConfirmWrite(harness.transport), true)
  assert.equal(
    harness.storage.recordingJournals.has(cloudCompletedOperation),
    false,
  )

  const confirmedOperation = 'already-confirmed'
  const confirmed = journal(
    confirmedOperation,
    'confirmed',
    'upload-confirmed',
    'cloud-confirmed',
  )
  harness.storage.recordingJournals.set(confirmedOperation, confirmed)
  const confirmedBlob = await harness.storage.openBlob(confirmed.sinkId)
  confirmedBlob.seed(PAYLOAD)
  harness.transport.writes.length = 0

  await harness.manager.confirm(confirmedOperation)

  assert.equal(hasConfirmWrite(harness.transport), false)
  assert.equal(confirmedBlob.deleteCalls, 1)
  assert.equal(harness.storage.recordingJournals.has(confirmedOperation), false)
})

test('cancellation before CONFIRM starts prevents the destructive write', async () => {
  const harness = await createHarness()
  const operationId = 'confirm-cancel-before-write'
  const stored = journal(
    operationId,
    'cloud_completed',
    'upload-before-write',
    'cloud-before-write',
  )
  harness.storage.recordingJournals.set(operationId, stored)
  const readEntered = deferred<void>()
  const readGate = deferred<void>()
  const read = harness.transport.read.bind(harness.transport)
  harness.transport.read = async (...args) => {
    readEntered.resolve(undefined)
    await readGate.promise
    return await read(...args)
  }

  const confirmation = harness.manager.confirm(operationId)
  const rejected = assert.rejects(confirmation, (error: unknown) =>
    error instanceof BotaSDKError && error.code === 'cancelled'
  )
  await readEntered.promise
  const cancelled = harness.manager.cancel(operationId)
  readGate.resolve(undefined)

  await settleWithWatchdog(
    Promise.all([cancelled, rejected]).then(() => undefined),
    'pre-CONFIRM cancellation',
  )
  assert.equal(hasConfirmWrite(harness.transport), false)
  assert.equal(
    (await harness.storage.loadRecordingJournal(operationId))?.phase,
    'cloud_completed',
  )
})

test('cancel and destroy wait for an in-flight CONFIRM and retain its actual success', async (t) => {
  for (const mode of ['cancel', 'destroy'] as const) {
    await t.test(mode, async () => {
      const harness = await createHarness()
      const operationId = `confirm-in-flight-${mode}`
      const stored = journal(
        operationId,
        'cloud_completed',
        `upload-${mode}`,
        `cloud-${mode}`,
      )
      harness.storage.recordingJournals.set(operationId, stored)
      const blob = await harness.storage.openBlob(stored.sinkId)
      blob.seed(PAYLOAD)
      const writeGate = deferred<void>()
      harness.transport.writeGate = writeGate.promise
      const confirmation = harness.manager.confirm(operationId).then(
        () => 'confirmed' as const,
        (error: unknown) => error,
      )
      await eventually(() => hasConfirmWrite(harness.transport))

      let terminationSettled = false
      const termination = (
        mode === 'cancel'
          ? harness.manager.cancel(operationId)
          : harness.manager.destroy()
      ).then(() => {
        terminationSettled = true
        harness.events.push('manager:terminated')
      })
      await settleReducer()
      const settledBeforeWrite = terminationSettled
      writeGate.resolve(undefined)
      const [outcome] = await settleWithWatchdog(
        Promise.all([confirmation, termination]),
        `in-flight CONFIRM ${mode}`,
      )

      assert.equal(settledBeforeWrite, false)
      assert.equal(outcome, 'confirmed')
      assert.equal(
        harness.storage.recordingJournals.has(operationId),
        false,
      )
      assert.equal(blob.deleteCalls, 1)
      assert.ok(
        indexOf(
          harness.events,
          `write_settled:${bytesHex(await transferFixture('confirm-command'))}`,
        ) < indexOf(harness.events, 'manager:terminated'),
      )
      const writesAfterTermination = harness.transport.writes.length
      await settleReducer()
      assert.equal(harness.transport.writes.length, writesAfterTermination)
    })
  }
})

test('pending operations expose journal summaries without upload or sink evidence', async () => {
  const harness = await createHarness()
  const stored = journal('pending-operation', 'uploading', 'private-upload-id')
  harness.storage.recordingJournals.set(stored.operationId, stored)

  assert.deepEqual(await harness.manager.listPendingOperations(), [{
    operationId: stored.operationId,
    serialNumber: stored.serialNumber,
    recordingUuid: stored.recordingUuid,
    profile: stored.profile,
    phase: stored.phase,
    updatedAtEpochMs: stored.updatedAtEpochMs,
  }])
})

test('cloud-completed resume confirms from its exact phase without LIST or upload', async () => {
  const harness = await createHarness()
  const operationId = 'cloud-completed-recovery'
  const stored = journal(
    operationId,
    'cloud_completed',
    'upload-complete',
    'cloud-complete',
  )
  harness.storage.recordingJournals.set(operationId, stored)
  const listCommand = await transferFixture('list-command')
  harness.transport.onWrite = () => {
    const write = harness.transport.writes.at(-1)
    if (!write || !equalBytes(write.value, listCommand)) return
    queueMicrotask(() => {
      void recordingListFixture().then((bytes) => {
        harness.transport.emitNotification(
          harness.transport.device,
          BOTA_STORAGE_SERVICE,
          RECORDING_LIST_CHARACTERISTIC,
          bytes,
        )
      })
    })
  }

  const result = await harness.manager.resume(operationId)

  assert.equal(hasWrite(harness.transport, listCommand), false)
  assert.equal(harness.provider.prepared.length, 0)
  assert.equal(harness.fetchCalls, 0)
  assert.equal(hasConfirmWrite(harness.transport), true)
  assert.equal(result.cloudCompletionId, 'cloud-complete')
})

test('staged resume streams bounded OPFS chunks without restarting BLE transfer', async () => {
  const harness = await createHarness()
  const operationId = 'staged-stream-recovery'
  const stored = journal(operationId, 'staged')
  harness.storage.recordingJournals.set(operationId, stored)
  const blob = await harness.storage.openBlob(stored.sinkId)
  blob.seed(new Uint8Array((64 * 1024 * 2) + 1))
  const chunkLengths: number[] = []
  harness.setFetch(async (_input, init) => {
    assert.ok(init?.body instanceof ReadableStream)
    const reader = init.body.getReader()
    while (true) {
      const next = await reader.read()
      if (next.done) break
      chunkLengths.push(next.value.byteLength)
    }
    return new Response(null, { status: 200 })
  })

  const resumed = harness.manager.resume(operationId)
  await answerNextList(harness)
  await resumed

  assert.deepEqual(chunkLengths, [64 * 1024, 64 * 1024, 1])
  assert.equal(
    hasWrite(harness.transport, await transferFixture('start-command')),
    false,
  )
})

test('transferring recovery truncates legacy state to zero before an explicit restart', async () => {
  const harness = await createHarness()
  const operationId = 'legacy-restart-operation'
  const stored = journal(operationId, 'transferring')
  harness.storage.recordingJournals.set(operationId, stored)
  harness.storage.workflowCheckpoints.set(operationId, {
    workflow: 'recording_transfer',
    operation: 'transfer_recording',
    serialNumber: SERIAL,
    recordingUuid: uuidBytes(RECORDING_UUID),
    phase: 'transferring',
    completedUnits: 4n,
    retryCount: 0,
    lastSequence: 0,
    firmwareVersion: null,
  })
  const blob = await harness.storage.openBlob(stored.sinkId)
  blob.seed(Uint8Array.of(1, 2, 3, 4))

  const resumed = harness.manager.resume(operationId)
  await answerNextList(harness)
  await waitForWrite(harness.transport, await transferFixture('start-command'))
  await settleReducer()

  assert.ok(
    indexOf(harness.events, 'blob:truncate:0')
      < writeIndex(
        harness.transport,
        await transferFixture('start-command'),
        harness.events,
      ),
  )
  assert.equal(harness.storage.workflowCheckpoints.has(operationId), false)
  await sendData(harness)
  await finishTransfer(harness, false)
  await resumed
})

test('cancellation owns recovery LIST before a resumed legacy START', async () => {
  const harness = await createHarness()
  const operationId = 'cancel-resume-list'
  const stored = journal(operationId, 'transferring')
  harness.storage.recordingJournals.set(operationId, stored)
  const blob = await harness.storage.openBlob(stored.sinkId)
  blob.seed(Uint8Array.of(1, 2, 3, 4))
  const resumed = harness.manager.resume(operationId)
  const rejected = assert.rejects(resumed, (error: unknown) =>
    error instanceof BotaSDKError && error.code === 'cancelled'
  )
  await waitForWrite(harness.transport, await transferFixture('list-command'))

  await settleWithWatchdog(
    Promise.all([
      harness.manager.cancel(operationId),
      rejected,
    ]).then(() => undefined),
    'recovery LIST cancellation',
  )

  assert.equal(
    hasWrite(harness.transport, await transferFixture('start-command')),
    false,
  )
  assert.ok(harness.events.some((event) =>
    event.startsWith('unsubscribe:')
      && event.includes(RECORDING_LIST_CHARACTERISTIC)
  ))
  assert.equal(harness.storage.recordingJournals.has(operationId), false)
})

test('cancellation aborts Rust transfer, removes only unverified state, and never confirms', async () => {
  const harness = await createHarness()
  const startCommand = await transferFixture('start-command')
  const sync = harness.manager.sync(recording(9n), {
    profile: 'legacy',
    operationId: OPERATION_ID,
  })
  const rejected = assert.rejects(sync, (error: unknown) =>
    error instanceof BotaSDKError && error.code === 'cancelled'
  )
  await waitForWrite(harness.transport, startCommand)
  await settleReducer()

  await harness.manager.cancel(OPERATION_ID)
  await rejected

  assert.ok(harness.transport.writes.some(({ value }) => value[0] === 0x12))
  assert.equal(hasConfirmWrite(harness.transport), false)
  assert.equal(harness.storage.recordingJournals.has(OPERATION_ID), false)
  assert.equal(harness.storage.workflowCheckpoints.has(OPERATION_ID), false)
  assert.ok((harness.storage.blobs.get(SINK_ID)?.deleteCalls ?? 0) >= 1)
})

test('abort immediately after prepared persistence removes unverified local state', async () => {
  const harness = await createHarness()
  const controller = new AbortController()
  harness.storage.onSaveRecordingJournal = (saved) => {
    if (saved.phase === 'prepared') controller.abort()
  }

  await assert.rejects(
    harness.manager.sync(recording(9n), {
      profile: 'legacy',
      operationId: OPERATION_ID,
      signal: controller.signal,
    }),
    (error: unknown) =>
      error instanceof BotaSDKError && error.code === 'cancelled',
  )

  assert.equal(harness.storage.recordingJournals.has(OPERATION_ID), false)
  assert.equal(hasConfirmWrite(harness.transport), false)
  assert.equal(harness.provider.prepared.length, 0)
})

test('manager cancellation at every pre-START await boundary settles without writing START', async (t) => {
  const cases: Array<{
    name: string
    arrange(
      harness: Harness,
      gate: ReturnType<typeof deferred<void>>,
      entered: ReturnType<typeof deferred<void>>,
    ): Promise<void> | void
  }> = [
    {
      name: 'journal lookup',
      arrange: (harness, gate, entered) => {
        const load = harness.storage.loadRecordingJournal.bind(harness.storage)
        harness.storage.loadRecordingJournal = async (operationId) => {
          entered.resolve(undefined)
          await gate.promise
          return await load(operationId)
        }
      },
    },
    {
      name: 'serial verification',
      arrange: (harness, gate, entered) => {
        const read = harness.transport.read.bind(harness.transport)
        harness.transport.read = async (...args) => {
          entered.resolve(undefined)
          await gate.promise
          return await read(...args)
        }
      },
    },
    {
      name: 'prepared journal save',
      arrange: (harness, gate, entered) => {
        const save = harness.storage.saveRecordingJournal.bind(harness.storage)
        harness.storage.saveRecordingJournal = async (value) => {
          if (value.phase === 'prepared') {
            entered.resolve(undefined)
            await gate.promise
          }
          await save(value)
        }
      },
    },
    {
      name: 'checkpoint deletion',
      arrange: (harness, gate, entered) => {
        const remove = harness.storage.deleteWorkflowCheckpoint.bind(
          harness.storage,
        )
        harness.storage.deleteWorkflowCheckpoint = async (operationId) => {
          entered.resolve(undefined)
          await gate.promise
          await remove(operationId)
        }
      },
    },
    {
      name: 'blob open',
      arrange: (harness, gate, entered) => {
        const open = harness.storage.openBlob.bind(harness.storage)
        harness.storage.openBlob = async (blobId) => {
          entered.resolve(undefined)
          await gate.promise
          return await open(blobId)
        }
      },
    },
    {
      name: 'blob size read',
      arrange: async (harness, gate, entered) => {
        const blob = await harness.storage.openBlob(SINK_ID)
        const size = blob.size.bind(blob)
        blob.size = async () => {
          entered.resolve(undefined)
          await gate.promise
          return await size()
        }
      },
    },
    {
      name: 'legacy zero truncate',
      arrange: async (harness, gate, entered) => {
        const blob = await harness.storage.openBlob(SINK_ID)
        blob.seed(Uint8Array.of(1))
        const truncate = blob.truncate.bind(blob)
        blob.truncate = async (size) => {
          entered.resolve(undefined)
          await gate.promise
          await truncate(size)
        }
      },
    },
    {
      name: 'transferring journal save',
      arrange: (harness, gate, entered) => {
        const save = harness.storage.saveRecordingJournal.bind(harness.storage)
        harness.storage.saveRecordingJournal = async (value) => {
          if (value.phase === 'transferring') {
            entered.resolve(undefined)
            await gate.promise
          }
          await save(value)
        }
      },
    },
  ]

  for (const boundary of cases) {
    await t.test(boundary.name, async () => {
      const harness = await createHarness()
      const gate = deferred<void>()
      const entered = deferred<void>()
      await boundary.arrange(harness, gate, entered)
      const sync = harness.manager.sync(recording(9n), {
        profile: 'legacy',
        operationId: OPERATION_ID,
      })
      const rejected = assert.rejects(sync, (error: unknown) =>
        error instanceof BotaSDKError && error.code === 'cancelled'
      )
      await entered.promise

      const cancelled = harness.manager.cancel(OPERATION_ID)
      gate.resolve(undefined)
      await settleWithWatchdog(
        Promise.all([cancelled, rejected]).then(() => undefined),
        `cancellation at ${boundary.name}`,
      )

      assert.equal(
        hasWrite(harness.transport, await transferFixture('start-command')),
        false,
      )
    })
  }
})

test('OPFS quota failure keeps the device recording and never starts upload', async () => {
  const harness = await createHarness()
  const sync = harness.manager.sync(recording(9n), {
    profile: 'legacy',
    operationId: OPERATION_ID,
  })
  const rejected = assert.rejects(sync, (error: unknown) =>
    error instanceof BotaSDKError && error.code === 'storage_quota_exceeded'
  )
  await waitForWrite(harness.transport, await transferFixture('start-command'))
  await settleReducer()
  const blob = harness.storage.blobs.get(SINK_ID)
  assert.ok(blob)
  blob.writeError = new BrowserStorageError('storage_quota_exceeded')

  harness.transport.emitNotification(
    harness.transport.device,
    BOTA_STORAGE_SERVICE,
    RECORDING_TRANSFER_CHARACTERISTIC,
    DATA_PACKET,
  )

  await rejected
  assert.equal(hasConfirmWrite(harness.transport), false)
  assert.equal(harness.provider.prepared.length, 0)
  assert.equal(harness.fetchCalls, 0)
})

test('disconnect during transfer preserves the device recording and skips upload', async () => {
  const harness = await createHarness()
  const sync = harness.manager.sync(recording(9n), {
    profile: 'legacy',
    operationId: OPERATION_ID,
  })
  const rejected = assert.rejects(sync, (error: unknown) =>
    error instanceof BotaSDKError && error.code === 'device_disconnected'
  )
  await waitForWrite(harness.transport, await transferFixture('start-command'))
  await settleReducer()

  harness.transport.emitDisconnected()

  await rejected
  assert.equal(hasConfirmWrite(harness.transport), false)
  assert.equal(harness.provider.prepared.length, 0)
  assert.equal(harness.fetchCalls, 0)
})

test('a disconnect during final-ACK subscription teardown retains transfer success and cloud phase', async () => {
  const harness = await createHarness()
  const unsubscribeEntered = deferred<void>()
  const unsubscribeGate = deferred<void>()
  harness.transport.onUnsubscribe = () => unsubscribeEntered.resolve(undefined)
  harness.transport.unsubscribeGate = unsubscribeGate.promise
  const sync = harness.manager.sync(recording(9n), {
    profile: 'legacy',
    operationId: OPERATION_ID,
  })
  const rejected = assert.rejects(sync, (error: unknown) =>
    error instanceof BotaSDKError && error.code === 'device_disconnected'
  )
  await waitForWrite(harness.transport, await transferFixture('start-command'))
  await settleReducer()
  await sendData(harness)
  await finishTransfer(harness, false)
  await unsubscribeEntered.promise
  assert.ok(harness.transport.writes.some(({ value }) => value[0] === 0x10))

  harness.transport.emitDisconnected()
  unsubscribeGate.resolve(undefined)
  await settleWithWatchdog(rejected, 'terminal disconnect race')

  const retained = await harness.storage.loadRecordingJournal(OPERATION_ID)
  assert.equal(retained?.phase, 'cloud_completed')
  assert.equal(retained?.cloudCompletionId, 'cloud-completion-1')
  assert.equal(harness.provider.completed.length, 1)
  assert.equal(await (await harness.storage.openBlob(SINK_ID)).size(), 9)
  assert.equal(hasConfirmWrite(harness.transport), false)
})

test('provider failure preserves the finalized staged body for recovery', async () => {
  const harness = await createHarness()
  harness.provider.prepareError = new Error('private provider failure')
  const sync = harness.manager.sync(recording(9n), {
    profile: 'legacy',
    operationId: OPERATION_ID,
  })
  const rejected = assert.rejects(sync, (error: unknown) =>
    error instanceof BotaSDKError && error.code === 'upload_failed'
  )
  await waitForWrite(harness.transport, await transferFixture('start-command'))
  await settleReducer()
  await sendData(harness)
  await finishTransfer(harness)

  await rejected
  assert.equal(
    (await harness.storage.loadRecordingJournal(OPERATION_ID))?.phase,
    'staged',
  )
  assert.equal(await (await harness.storage.openBlob(SINK_ID)).size(), 9)
  assert.equal(hasConfirmWrite(harness.transport), false)
  assert.equal(harness.fetchCalls, 0)
})

test('malformed provider material fails as a stable upload error', async () => {
  const harness = await createHarness()
  harness.provider.prepareLegacyUpload = async () => ({
    uploadId: 'malformed-provider-upload',
    request: undefined as unknown as UploadRequestTemplate,
  })
  const sync = harness.manager.sync(recording(9n), {
    profile: 'legacy',
    operationId: OPERATION_ID,
  })
  const rejected = assert.rejects(sync, (error: unknown) =>
    error instanceof BotaSDKError && error.code === 'upload_failed'
  )
  await waitForWrite(harness.transport, await transferFixture('start-command'))
  await settleReducer()
  await sendData(harness)
  await finishTransfer(harness, false)

  await rejected
  assert.equal(hasConfirmWrite(harness.transport), false)
  assert.equal(harness.fetchCalls, 0)
})

test('unsafe legacy sizes fail before OPFS or provider work', async () => {
  const harness = await createHarness()

  await assert.rejects(
    harness.manager.sync(recording(BigInt(Number.MAX_SAFE_INTEGER) + 1n), {
      profile: 'legacy',
      operationId: 'unsafe-size',
    }),
    (error: unknown) =>
      error instanceof BotaSDKError && error.code === 'invalid_input',
  )
  assert.equal(harness.storage.openBlobCalls, 0)
  assert.equal(harness.provider.prepared.length, 0)

  const offsetHarness = await createHarness()
  const unsafeOffset = offsetHarness.manager.sync(recording(9n), {
    profile: 'legacy',
    operationId: 'unsafe-offset',
  })
  const offsetRejected = assert.rejects(unsafeOffset, (error: unknown) =>
    error instanceof BotaSDKError && error.code === 'invalid_input'
  )
  await waitForWrite(
    offsetHarness.transport,
    await transferFixture('start-command'),
  )
  await settleReducer()
  const unsafeBlob = offsetHarness.storage.blobs.get('recording:unsafe-offset')
  assert.ok(unsafeBlob)
  unsafeBlob.reportedSize = Number.MAX_SAFE_INTEGER + 1
  offsetHarness.transport.emitNotification(
    offsetHarness.transport.device,
    BOTA_STORAGE_SERVICE,
    RECORDING_TRANSFER_CHARACTERISTIC,
    DATA_PACKET,
  )
  await offsetRejected
  assert.equal(unsafeBlob.writeCalls, 0)
})

test('the public client exposes one recording manager with its configured provider', async () => {
  const events: string[] = []
  const storage = new FakeRecordingStorage(undefined, events)
  const provider = new FakeRecordingUploadProvider(events)
  const transport = new FakeBrowserBluetoothTransport()
  const client = await BotaDeviceClient.create({
    coreLoader: async () => await createWasmCore(await wasmBytes),
    transport,
    storageNamespace: storage.namespace,
    storage,
    providers: { recordingUpload: provider },
  })

  assert.ok(client.recordings instanceof RecordingManager)
  await client.destroy()
})

function recording(
  fileSizeBytes: bigint,
  encrypted = false,
): DeviceRecording {
  return {
    uuid: RECORDING_UUID,
    startedAtTimestampSeconds: 1_700_000_000,
    durationMilliseconds: 12_000n,
    fileSizeBytes,
    codec: 'opus_16k',
    encrypted,
    encryptedUploadV2: null,
  }
}

function journal(
  operationId: string,
  phase: RecordingJournalPhase,
  uploadId: string | null = null,
  cloudCompletionId: string | null = null,
): RecordingJournal {
  return {
    schemaVersion: 1,
    operationId,
    serialNumber: SERIAL,
    recordingUuid: RECORDING_UUID,
    profile: 'legacy',
    phase,
    sinkId: `recording:${operationId}`,
    uploadId,
    cloudCompletionId,
    confirmationDigestHex: null,
    devicePlaintextSha256Hex: null,
    updatedAtEpochMs: 1_700_000_000_000,
  }
}

async function sendData(harness: Harness): Promise<void> {
  harness.transport.emitNotification(
    harness.transport.device,
    BOTA_STORAGE_SERVICE,
    RECORDING_TRANSFER_CHARACTERISTIC,
    DATA_PACKET,
  )
  await eventually(() => harness.events.some((event) =>
    event === 'blob:write_durable:9'
  ))
  await eventually(() => harness.events.includes('workflow:save'))
}

async function finishTransfer(
  harness: Harness,
  waitForResult = true,
): Promise<void> {
  harness.transport.emitNotification(
    harness.transport.device,
    BOTA_STORAGE_SERVICE,
    RECORDING_TRANSFER_CHARACTERISTIC,
    GOOD_EOF_PACKET,
  )
  harness.transport.emitNotification(
    harness.transport.device,
    BOTA_STORAGE_SERVICE,
    RECORDING_TRANSFER_CHARACTERISTIC,
    SHA256_PACKET,
  )
  await eventually(() => harness.transport.writes.some(({ value }) => value[0] === 0x10))
  if (waitForResult) {
    await eventually(() => harness.events.includes('provider:prepare'))
  }
}

async function answerNextList(harness: Harness): Promise<void> {
  const command = await transferFixture('list-command')
  await eventually(() => harness.transport.writes.some(({ value }) =>
    equalBytes(value, command)
  ))
  harness.transport.emitNotification(
    harness.transport.device,
    BOTA_STORAGE_SERVICE,
    RECORDING_LIST_CHARACTERISTIC,
    await recordingListFixture(),
  )
}

async function settleReducer(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

function streamingFetch(events: string[]): (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response> {
  return async (input, init) => {
    events.push('fetch:stream')
    assert.equal(String(input), 'https://upload-secret.example.invalid/recording')
    assert.equal(init?.method, 'PUT')
    assert.deepEqual(init?.headers, { Authorization: 'Bearer upload-secret' })
    assert.ok(init?.body instanceof ReadableStream)
    const reader = init.body.getReader()
    let total = 0
    while (true) {
      const next = await reader.read()
      if (next.done) break
      assert.ok(next.value instanceof Uint8Array)
      total += next.value.byteLength
    }
    assert.equal(total, 9)
    return new Response(null, { status: 200 })
  }
}

async function recordingListFixture(): Promise<Uint8Array> {
  const suite = JSON.parse(await readFile(
    new URL('../../../../protocol/fixtures/recording-list.json', import.meta.url),
    'utf8',
  )) as { cases: Array<{ name: string; inputHex: string }> }
  const fixture = suite.cases.find(({ name }) => name === 'encrypted-recording')
  assert.ok(fixture)
  return hex(fixture.inputHex)
}

async function transferFixture(name: string): Promise<Uint8Array> {
  const suite = JSON.parse(await readFile(
    new URL('../../../../protocol/fixtures/transfer-control.json', import.meta.url),
    'utf8',
  )) as { cases: Array<{ name: string; expectedHex?: string }> }
  const fixture = suite.cases.find((candidate) => candidate.name === name)
  assert.ok(fixture?.expectedHex)
  return hex(fixture.expectedHex)
}

function hex(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g) ?? [], (byte) =>
    Number.parseInt(byte, 16)
  )
}

function uuidBytes(uuid: string): Uint8Array {
  return hex(uuid.replaceAll('-', ''))
}

function hasWrite(
  transport: FakeBrowserBluetoothTransport,
  expected: Uint8Array,
): boolean {
  return transport.writes.some(({ value }) => equalBytes(value, expected))
}

function hasConfirmWrite(transport: FakeBrowserBluetoothTransport): boolean {
  return transport.writes.some(({ value }) => value[0] === 0x07)
}

async function waitForWrite(
  transport: FakeBrowserBluetoothTransport,
  expected: Uint8Array,
): Promise<void> {
  await eventually(() => hasWrite(transport, expected))
}

function writeIndex(
  transport: FakeBrowserBluetoothTransport,
  expected: Uint8Array,
  events: string[],
): number {
  const write = transport.writes.find(({ value }) => equalBytes(value, expected))
  assert.ok(write)
  return events.findIndex((event) =>
    event === `write:${write.deviceId}:${write.serviceUuid}:${write.characteristicUuid}:${write.withResponse}:${bytesHex(write.value)}`
  )
}

function bytesHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && left.every((byte, index) => byte === right[index])
}

function indexOf(events: string[], event: string): number {
  const index = events.indexOf(event)
  assert.notEqual(index, -1, `missing event ${event}`)
  return index
}

async function eventually(
  predicate: () => boolean,
  message = 'condition did not settle',
): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message)
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

async function settleWithWatchdog<T>(
  promise: Promise<T>,
  description: string,
): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${description} did not settle`))
        }, 5_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
