import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import type { CoreBridge, CoreEncryptedUploadV2TransferFrame } from '../core.ts'
import {
  EncryptedUploadV2SignedBlobWriter,
  EncryptedUploadV2TransferControl,
  EncryptedUploadV2TransferReceiver,
  parsePersistedEncryptedUploadV2State,
  type EncryptedUploadV2TransferRequest,
  type PersistedEncryptedUploadV2State,
} from '../encryptedUploadV2Host.ts'
import { BotaSDKError } from '../errors.ts'
import {
  BOTA_STORAGE_SERVICE,
  RECORDING_LIST_V2_CHARACTERISTIC,
  RECORDING_TRANSFER_V2_CHARACTERISTIC,
  TRANSFER_CONTROL_V2_CHARACTERISTIC,
  TRANSFER_SIGNED_BLOB_V2_CHARACTERISTIC,
} from '../gatt.ts'
import { BrowserStorageError } from '../storage.ts'
import { createWasmCore } from '../wasmCore.ts'
import { FakeBrowserBluetoothTransport } from './fakeBluetooth.ts'
import { FakeRecordingBlob } from './fakeProviders.ts'

interface VectorCase {
  name: string
  inputHex: string
}

const TRANSPORT_SESSION_ID = 18_838_586_676_582n
const EMPTY_SHA256 = bytes(
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
)
const CIPHERTEXT_SHA256 = bytes(
  '287ad0258b5465b48757afe5f6980b7089fea7cb7520dc2db6d2fc9fd4fbfd1b',
)
const wasmBytes = readFile(
  new URL('../generated/bota_device_sdk_core_bg.wasm', import.meta.url),
)
const core = wasmBytes.then(createWasmCore)

test('signed-document writer subscribes before Rust frames and waits for its exact result', async () => {
  const bridge = await core
  const transport = new FakeBrowserBluetoothTransport()
  const events: string[] = []
  transport.eventLog = events
  const writer = new EncryptedUploadV2SignedBlobWriter(
    bridge,
    transport,
    transport.device,
  )
  const authorization = bytes(
    (await vector('authorization-development')).inputHex,
  )
  const exact = bytes((await vector('ble-blob-result')).inputHex)
  const foreign = exact.slice()
  foreign[4] = 0x05

  let settled = false
  const pending = writer.send(
    'authorization',
    0x01020304,
    authorization,
    408,
  ).then(() => {
    settled = true
  })
  await waitForWrites(transport, 6)
  transport.emitNotification(
    transport.device,
    BOTA_STORAGE_SERVICE,
    TRANSFER_SIGNED_BLOB_V2_CHARACTERISTIC,
    foreign,
  )
  await Promise.resolve()
  assert.equal(settled, false)
  transport.emitNotification(
    transport.device,
    BOTA_STORAGE_SERVICE,
    TRANSFER_SIGNED_BLOB_V2_CHARACTERISTIC,
    exact,
  )
  await pending

  const subscribe = events.findIndex((event) => event.startsWith('subscribe:'))
  const firstWrite = events.findIndex((event) => event.startsWith('write:'))
  assert.ok(subscribe >= 0 && subscribe < firstWrite)
  const expected = [
    bridge.encodeEncryptedUploadV2SignedBlob({
        kind: 'begin',
        blobKind: 'authorization',
        writeId: 0x01020304,
        totalLength: authorization.byteLength,
        sha256: sha256(bridge, authorization),
      }),
  ]
  for (let offset = 0; offset < authorization.byteLength; offset += 116) {
    expected.push(bridge.encodeEncryptedUploadV2SignedBlob({
        kind: 'data',
        blobKind: 'authorization',
        writeId: 0x01020304,
        offset,
        data: authorization.slice(offset, offset + 116),
      }))
  }
  expected.push(bridge.encodeEncryptedUploadV2SignedBlob({
        kind: 'commit',
        blobKind: 'authorization',
        writeId: 0x01020304,
      }))
  assert.deepEqual(transport.writes.map(({ value }) => value), expected)
})

test('signed-document cancellation aborts the exact write and releases its subscription', async () => {
  const bridge = await core
  const transport = new FakeBrowserBluetoothTransport()
  const events: string[] = []
  transport.eventLog = events
  const writer = new EncryptedUploadV2SignedBlobWriter(
    bridge,
    transport,
    transport.device,
  )
  const authorization = bytes(
    (await vector('authorization-development')).inputHex,
  )

  const pending = writer.send(
    'authorization',
    0x01020304,
    authorization,
    408,
  )
  await waitForWrites(transport, 6)
  await writer.cancel()

  await assert.rejects(withWatchdog(pending), (error: unknown) =>
    error instanceof BotaSDKError && error.code === 'cancelled'
  )
  assert.equal(transport.writes.at(-1)?.value[0], 0x63)
  const abortWrite = events.findIndex((event) =>
    event.startsWith('write:') && event.split(':').at(-1)?.startsWith('63')
  )
  const unsubscribe = events.findIndex((event) =>
    event.startsWith('unsubscribe:')
  )
  assert.ok(abortWrite >= 0 && abortWrite < unsubscribe)
})

test('signed-document cancellation joins a blocked BEGIN before ABORT and terminal zero-fill', async () => {
  const bridge = await core
  const transport = new FakeBrowserBluetoothTransport()
  const events: string[] = []
  transport.eventLog = events
  const beginGate = deferred<void>()
  transport.writeGate = beginGate.promise
  const writer = new EncryptedUploadV2SignedBlobWriter(
    bridge,
    transport,
    transport.device,
  )
  const authorization = bytes(
    (await vector('authorization-development')).inputHex,
  )
  const pending = writer.send(
    'authorization',
    0x01020304,
    authorization,
    408,
    undefined,
    () => authorization.fill(0),
  )
  await waitForWrites(transport, 1)

  let cancellationSettled = false
  const cancellation = writer.cancel().then(() => {
    cancellationSettled = true
  })
  await settleAsyncWork()

  assert.equal(cancellationSettled, false)
  assert.equal(transport.writes.length, 1)
  assert.ok(authorization.some((value) => value !== 0))

  beginGate.resolve(undefined)
  await withWatchdog(cancellation)
  await assert.rejects(withWatchdog(pending), (error: unknown) =>
    error instanceof BotaSDKError && error.code === 'cancelled'
  )

  assert.deepEqual(transport.writes.map(({ value }) => value[0]), [0x60, 0x63])
  assert.ok(authorization.every((value) => value === 0))
  const beginSettled = events.findIndex((event) =>
    event.startsWith('write_settled:60')
  )
  const abortWrite = events.findIndex((event) =>
    event.startsWith('write:') && event.split(':').at(-1)?.startsWith('63')
  )
  assert.ok(beginSettled >= 0 && beginSettled < abortWrite)
})

test('an unjoined signed BEGIN poisons ownership and defers zero-fill until cleanup settles', async () => {
  const bridge = await core
  const transport = new FakeBrowserBluetoothTransport()
  const beginGate = deferred<void>()
  transport.writeGate = beginGate.promise
  let poisonCalls = 0
  const writer = new EncryptedUploadV2SignedBlobWriter(
    bridge,
    transport,
    transport.device,
    () => { poisonCalls += 1 },
    { cleanupTimeoutMs: 10 },
  )
  const authorization = bytes(
    (await vector('authorization-development')).inputHex,
  )
  const pending = writer.send(
    'authorization',
    0x01020304,
    authorization,
    408,
    undefined,
    () => authorization.fill(0),
  )
  const rejected = assert.rejects(pending, (error: unknown) =>
    error instanceof BotaSDKError && error.code === 'cancelled'
  )
  await waitForWrites(transport, 1)

  await assert.rejects(withWatchdog(writer.cancel()), (error: unknown) =>
    error instanceof BotaSDKError && error.code === 'integrity_failed'
  )
  assert.equal(poisonCalls, 1)
  assert.ok(authorization.some((value) => value !== 0))
  await assert.rejects(
    writer.send('authorization', 0x01020305, authorization, 408),
    (error: unknown) =>
      error instanceof BotaSDKError && error.code === 'operation_in_progress',
  )

  beginGate.resolve(undefined)
  await withWatchdog(rejected)
  await settleAsyncWork()
  assert.ok(authorization.every((value) => value === 0))
  assert.deepEqual(transport.writes.map(({ value }) => value[0]), [0x60, 0x63])
})

test('a signed RESULT before COMMIT is stale and cannot pre-satisfy the owner', async () => {
  const bridge = await core
  const transport = new FakeBrowserBluetoothTransport()
  const beginGate = deferred<void>()
  transport.writeGate = beginGate.promise
  const writer = new EncryptedUploadV2SignedBlobWriter(
    bridge,
    transport,
    transport.device,
  )
  const authorization = bytes(
    (await vector('authorization-development')).inputHex,
  )
  const exact = bytes((await vector('ble-blob-result')).inputHex)
  let settled = false
  const pending = writer.send(
    'authorization',
    0x01020304,
    authorization,
    408,
  ).then(() => {
    settled = true
  })
  await waitForWrites(transport, 1)

  transport.emitNotification(
    transport.device,
    BOTA_STORAGE_SERVICE,
    TRANSFER_SIGNED_BLOB_V2_CHARACTERISTIC,
    exact,
  )
  beginGate.resolve(undefined)
  await waitForWrites(transport, 6)
  await settleAsyncWork()

  assert.equal(settled, false)
  transport.emitNotification(
    transport.device,
    BOTA_STORAGE_SERVICE,
    TRANSFER_SIGNED_BLOB_V2_CHARACTERISTIC,
    exact,
  )
  await withWatchdog(pending)
})

test('a matching signed RESULT racing the COMMIT write is accepted', async () => {
  const bridge = await core
  const transport = new FakeBrowserBluetoothTransport()
  const writer = new EncryptedUploadV2SignedBlobWriter(
    bridge,
    transport,
    transport.device,
  )
  const authorization = bytes(
    (await vector('authorization-development')).inputHex,
  )
  const exact = bytes((await vector('ble-blob-result')).inputHex)
  transport.onWrite = () => {
    if (transport.writes.at(-1)?.value[0] === 0x62) {
      transport.emitNotification(
        transport.device,
        BOTA_STORAGE_SERVICE,
        TRANSFER_SIGNED_BLOB_V2_CHARACTERISTIC,
        exact,
      )
    }
  }

  await withWatchdog(writer.send(
    'authorization',
    0x01020304,
    authorization,
    408,
  ))
})

test('receipt bytes stay intact until a blocked COMMIT and its cleanup are joined', async () => {
  const bridge = await core
  const transport = new FakeBrowserBluetoothTransport()
  const commitEntered = deferred<void>()
  const commitGate = deferred<void>()
  transport.onWrite = () => {
    if (transport.writes.at(-1)?.value[0] === 0x62) {
      transport.writeGate = commitGate.promise
      commitEntered.resolve(undefined)
    }
  }
  const writer = new EncryptedUploadV2SignedBlobWriter(
    bridge,
    transport,
    transport.device,
  )
  const receipt = bytes((await vector('completion-receipt')).inputHex)
  const pending = writer.send(
    'receipt',
    0x01020306,
    receipt,
    1024,
    undefined,
    () => receipt.fill(0),
  )
  const rejected = assert.rejects(pending, (error: unknown) =>
    error instanceof BotaSDKError && error.code === 'cancelled'
  )
  await commitEntered.promise

  let cancellationSettled = false
  const cancellation = writer.cancel().then(() => {
    cancellationSettled = true
  })
  await settleAsyncWork()
  assert.equal(cancellationSettled, false)
  assert.ok(receipt.some((value) => value !== 0))

  commitGate.resolve(undefined)
  await withWatchdog(cancellation)
  await withWatchdog(rejected)
  assert.ok(receipt.every((value) => value === 0))
  assert.equal(transport.writes.at(-1)?.value[0], 0x63)
})

test('a foreign signed RESULT cannot stop the bounded post-COMMIT timeout or teardown', async () => {
  const bridge = await core
  const transport = new FakeBrowserBluetoothTransport()
  const events: string[] = []
  transport.eventLog = events
  const writer = new EncryptedUploadV2SignedBlobWriter(
    bridge,
    transport,
    transport.device,
    () => undefined,
    { resultTimeoutMs: 10 },
  )
  const authorization = bytes(
    (await vector('authorization-development')).inputHex,
  )
  const foreign = bytes((await vector('ble-blob-result')).inputHex)
  foreign[4] = 0x05
  const pending = writer.send(
    'authorization',
    0x01020304,
    authorization,
    408,
  )
  await waitForWrites(transport, 6)
  transport.emitNotification(
    transport.device,
    BOTA_STORAGE_SERVICE,
    TRANSFER_SIGNED_BLOB_V2_CHARACTERISTIC,
    foreign,
  )

  await assert.rejects(withWatchdog(pending), (error: unknown) =>
    error instanceof BotaSDKError
      && error.code === 'connection_failed'
      && error.retryable
  )
  assert.equal(transport.writes.at(-1)?.value[0], 0x63)
  const abortSettled = events.findIndex((event) =>
    event.startsWith('write_settled:63')
  )
  const unsubscribe = events.findIndex((event) =>
    event.startsWith('unsubscribe:')
  )
  assert.ok(abortSettled >= 0 && abortSettled < unsubscribe)
})

test('a failed signed BEGIN write still sends the Rust ABORT before release', async () => {
  const bridge = await core
  const transport = new FakeBrowserBluetoothTransport()
  const writer = new EncryptedUploadV2SignedBlobWriter(
    bridge,
    transport,
    transport.device,
  )
  const authorization = bytes(
    (await vector('authorization-development')).inputHex,
  )
  transport.onWrite = () => {
    transport.writeGate = transport.writes.length === 1
      ? Promise.reject(new Error('uncertain BEGIN write'))
      : null
  }

  await assert.rejects(
    writer.send('authorization', 0x01020304, authorization, 408),
    (error: unknown) =>
      error instanceof BotaSDKError && error.code === 'protocol_error',
  )

  assert.deepEqual(
    transport.writes.map(({ value }) => value),
    [
      bridge.encodeEncryptedUploadV2SignedBlob({
        kind: 'begin',
        blobKind: 'authorization',
        writeId: 0x01020304,
        totalLength: authorization.byteLength,
        sha256: sha256(bridge, authorization),
      }),
      bridge.encodeEncryptedUploadV2SignedBlob({
        kind: 'abort',
        blobKind: 'authorization',
        writeId: 0x01020304,
      }),
    ],
  )
})

test('an exact signed-document rejection is terminal and sends no second ABORT', async () => {
  const bridge = await core
  const transport = new FakeBrowserBluetoothTransport()
  const writer = new EncryptedUploadV2SignedBlobWriter(
    bridge,
    transport,
    transport.device,
  )
  const authorization = bytes(
    (await vector('authorization-development')).inputHex,
  )
  const rejectedResult = bytes((await vector('ble-blob-result')).inputHex)
  new DataView(rejectedResult.buffer).setUint16(8, 5, true)
  const pending = writer.send(
    'authorization',
    0x01020304,
    authorization,
    408,
  )
  await waitForWrites(transport, 6)
  transport.emitNotification(
    transport.device,
    BOTA_STORAGE_SERVICE,
    TRANSFER_SIGNED_BLOB_V2_CHARACTERISTIC,
    rejectedResult,
  )

  await assert.rejects(pending, (error: unknown) =>
    error instanceof BotaSDKError
      && error.code === 'protocol_error'
      && error.protocolStatus === 5
  )
  assert.equal(transport.writes.at(-1)?.value[0], 0x62)
  assert.equal(transport.writes.some(({ value }) => value[0] === 0x63), false)
})

test('uncertain signed-document cleanup poisons BLE ownership', async () => {
  const bridge = await core
  const transport = new FakeBrowserBluetoothTransport()
  let rejectUnsubscribe!: (error: unknown) => void
  transport.unsubscribeGate = new Promise<void>((_resolve, reject) => {
    rejectUnsubscribe = reject
  })
  transport.onUnsubscribe = () => {
    rejectUnsubscribe(new Error('uncertain unsubscribe'))
  }
  let poisonCalls = 0
  const writer = new EncryptedUploadV2SignedBlobWriter(
    bridge,
    transport,
    transport.device,
    () => { poisonCalls += 1 },
  )
  const authorization = bytes(
    (await vector('authorization-development')).inputHex,
  )
  const pending = writer.send(
    'authorization',
    0x01020304,
    authorization,
    408,
  )
  await waitForWrites(transport, 6)
  transport.emitNotification(
    transport.device,
    BOTA_STORAGE_SERVICE,
    TRANSFER_SIGNED_BLOB_V2_CHARACTERISTIC,
    bytes((await vector('ble-blob-result')).inputHex),
  )

  await assert.rejects(pending, (error: unknown) =>
    error instanceof BotaSDKError && error.code === 'integrity_failed'
  )
  assert.equal(poisonCalls, 1)
})

test('v2 LIST uses Rust framing and verifies exact session, count, revision, and digest', async () => {
  const bridge = await core
  const transport = new FakeBrowserBluetoothTransport()
  const events: string[] = []
  transport.eventLog = events
  const control = new EncryptedUploadV2TransferControl(
    bridge,
    transport,
    transport.device,
  )
  const entryBytes = bytes((await vector('ble-recording-entry')).inputHex)
  const endBytes = bytes((await vector('ble-recording-list-end')).inputHex)

  const pending = control.list(TRANSPORT_SESSION_ID)
  await waitForWrites(transport, 1)
  assert.deepEqual(
    transport.writes[0]?.value,
    bridge.encodeEncryptedUploadV2Transfer({
      kind: 'list',
      flags: 0,
      transportSessionId: TRANSPORT_SESSION_ID,
    }),
  )
  transport.emitNotification(
    transport.device,
    BOTA_STORAGE_SERVICE,
    RECORDING_LIST_V2_CHARACTERISTIC,
    entryBytes,
  )
  transport.emitNotification(
    transport.device,
    BOTA_STORAGE_SERVICE,
    RECORDING_LIST_V2_CHARACTERISTIC,
    endBytes,
  )
  const result = await pending

  assert.equal(result.listRevision, 17)
  assert.equal(result.entries.length, 1)
  assert.equal(result.entries[0]?.recordingGeneration, 9)
  assert.deepEqual(result.entries[0]?.ciphertextSha256, CIPHERTEXT_SHA256)
  const subscribe = events.findIndex((event) => event.startsWith('subscribe:'))
  const write = events.findIndex((event) => event.startsWith('write:'))
  assert.ok(subscribe >= 0 && subscribe < write)

  const wrongSession = entryBytes.slice()
  wrongSession[4] = (wrongSession[4] ?? 0) ^ 0xff
  const rejected = control.list(TRANSPORT_SESSION_ID)
  await waitForWrites(transport, 2)
  transport.emitNotification(
    transport.device,
    BOTA_STORAGE_SERVICE,
    RECORDING_LIST_V2_CHARACTERISTIC,
    wrongSession,
  )
  await assert.rejects(rejected)

  for (const mutate of [
    (end: Uint8Array) => new DataView(end.buffer).setUint32(12, 2, true),
    (end: Uint8Array) => new DataView(end.buffer).setUint32(16, 0, true),
    (end: Uint8Array) => { end[20] = (end[20] ?? 0) ^ 0xff },
  ]) {
    const invalidEnd = endBytes.slice()
    mutate(invalidEnd)
    const invalid = control.list(TRANSPORT_SESSION_ID)
    await waitForWrites(transport, transport.writes.length + 1)
    transport.emitNotification(
      transport.device,
      BOTA_STORAGE_SERVICE,
      RECORDING_LIST_V2_CHARACTERISTIC,
      entryBytes,
    )
    transport.emitNotification(
      transport.device,
      BOTA_STORAGE_SERVICE,
      RECORDING_LIST_V2_CHARACTERISTIC,
      invalidEnd,
    )
    await assert.rejects(invalid, (error: unknown) =>
      error instanceof BotaSDKError && error.code === 'integrity_failed'
    )
  }
})

test('v2 LIST subscribes to its exact 0409 rejection before the Rust request', async () => {
  const bridge = await core
  const transport = new FakeBrowserBluetoothTransport()
  const events: string[] = []
  transport.eventLog = events
  const control = new EncryptedUploadV2TransferControl(
    bridge,
    transport,
    transport.device,
  )
  const pending = control.list(TRANSPORT_SESSION_ID)
  await waitForWrites(transport, 1)
  const deviceError = bytes((await vector('ble-error')).inputHex)
  deviceError[14] = 0x25
  transport.emitNotification(
    transport.device,
    BOTA_STORAGE_SERVICE,
    RECORDING_TRANSFER_V2_CHARACTERISTIC,
    deviceError,
  )

  await assert.rejects(withWatchdog(pending), (error: unknown) =>
    error instanceof BotaSDKError
      && error.code === 'protocol_error'
      && error.protocolStatus === 15
  )
  const listSubscribe = events.findIndex((event) =>
    event.startsWith('subscribe:')
      && event.includes(RECORDING_LIST_V2_CHARACTERISTIC)
  )
  const errorSubscribe = events.findIndex((event) =>
    event.startsWith('subscribe:')
      && event.includes(RECORDING_TRANSFER_V2_CHARACTERISTIC)
  )
  const write = events.findIndex((event) => event.startsWith('write:'))
  assert.ok(listSubscribe >= 0 && listSubscribe < write)
  assert.ok(errorSubscribe >= 0 && errorSubscribe < write)
  assert.equal(transport.writes.length, 1)
})

test('START subscribes first and rejects a mismatched recording identity with Rust ABORT', async () => {
  const bridge = await core
  const transport = new FakeBrowserBluetoothTransport()
  const events: string[] = []
  transport.eventLog = events
  const control = new EncryptedUploadV2TransferControl(
    bridge,
    transport,
    transport.device,
  )
  const authorizationSha256 = new Uint8Array(32).fill(0x55)
  const request = {
    transportSessionId: TRANSPORT_SESSION_ID,
    uploadSessionUuid: '10111213-1415-1617-1819-1a1b1c1d1e1f',
    recordingUuid: '00112233-4455-6677-8899-aabbccddeeff',
    recordingGeneration: 9,
    authorizationSha256,
    expectedCiphertextLength: 330n,
    expectedCiphertextSha256: CIPHERTEXT_SHA256,
    expectedCheckpointIntervalBlocks: 8,
    windowPackets: 16,
    dataPayloadBytes: 244,
  }
  const pending = control.open(request, null)
  await waitForWrites(transport, 1)
  assert.deepEqual(
    transport.writes[0]?.value,
    bridge.encodeEncryptedUploadV2Transfer({
      kind: 'start',
      flags: 0,
      transportSessionId: TRANSPORT_SESSION_ID,
      uploadSessionUuid: request.uploadSessionUuid,
      recordingUuid: request.recordingUuid,
      recordingGeneration: request.recordingGeneration,
      authorizationSha256,
      checkpointRevision: 0,
      nextCiphertextOffset: 0n,
      prefixSha256: EMPTY_SHA256,
      windowPackets: request.windowPackets,
      dataPayloadBytes: request.dataPayloadBytes,
    }),
  )
  const mismatched = bytes((await vector('ble-start-ack')).inputHex)
  new DataView(mismatched.buffer).setUint32(44, 10, true)
  transport.emitNotification(
    transport.device,
    BOTA_STORAGE_SERVICE,
    RECORDING_TRANSFER_V2_CHARACTERISTIC,
    mismatched,
  )

  await assert.rejects(pending, (error: unknown) =>
    error instanceof BotaSDKError && error.code === 'identity_mismatch'
  )
  assert.deepEqual(
    transport.writes.at(-1)?.value,
    bridge.encodeEncryptedUploadV2Transfer({
      kind: 'abort',
      flags: 0,
      transportSessionId: TRANSPORT_SESSION_ID,
      reason: 0x00ff,
    }),
  )
  const subscribe = events.findIndex((event) => event.startsWith('subscribe:'))
  const write = events.findIndex((event) => event.startsWith('write:'))
  assert.ok(subscribe >= 0 && subscribe < write)
})

test('cancellation after the START subscription but before its write only releases', async () => {
  const bridge = await core
  const transport = new FakeBrowserBluetoothTransport()
  let releaseSubscription!: () => void
  transport.subscribeGate = new Promise<void>((resolve) => {
    releaseSubscription = resolve
  })
  const subscribed = new Promise<void>((resolve) => {
    transport.onSubscribe = resolve
  })
  const control = new EncryptedUploadV2TransferControl(
    bridge,
    transport,
    transport.device,
  )
  const controller = new AbortController()
  const pending = control.open({
    transportSessionId: TRANSPORT_SESSION_ID,
    uploadSessionUuid: '10111213-1415-1617-1819-1a1b1c1d1e1f',
    recordingUuid: '00112233-4455-6677-8899-aabbccddeeff',
    recordingGeneration: 9,
    authorizationSha256: new Uint8Array(32).fill(0x55),
    expectedCiphertextLength: 330n,
    expectedCiphertextSha256: CIPHERTEXT_SHA256,
    expectedCheckpointIntervalBlocks: 8,
    windowPackets: 16,
    dataPayloadBytes: 244,
  }, null, controller.signal)
  await subscribed

  controller.abort()
  releaseSubscription()

  await assert.rejects(withWatchdog(pending), (error: unknown) =>
    error instanceof BotaSDKError && error.code === 'cancelled'
  )
  assert.equal(transport.writes.length, 0)
})

for (const blocked of [
  {
    name: 'START',
    checkpoint: null,
    messageType: 0x20,
  },
  {
    name: 'RESUME',
    checkpoint: {
      revision: 1,
      nextCiphertextOffset: 330n,
      prefixSha256: CIPHERTEXT_SHA256,
      highestContiguousSequence: 3,
    },
    messageType: 0x22,
  },
] as const) {
  test(`transfer cancellation joins a blocked ${blocked.name} before ABORT and unsubscribe`, async () => {
    const bridge = await core
    const transport = new FakeBrowserBluetoothTransport()
    const events: string[] = []
    transport.eventLog = events
    const writeGate = deferred<void>()
    transport.writeGate = writeGate.promise
    const control = new EncryptedUploadV2TransferControl(
      bridge,
      transport,
      transport.device,
    )
    const controller = new AbortController()
    const pending = control.open(
      transferRequest(),
      blocked.checkpoint,
      controller.signal,
    )
    await waitForWrites(transport, 1)

    controller.abort()
    let cancellationSettled = false
    const cancellation = control.cancel().then(() => {
      cancellationSettled = true
    })
    await settleAsyncWork()

    assert.equal(cancellationSettled, false)
    assert.equal(transport.writes.length, 1)
    assert.equal(transport.writes[0]?.value[0], blocked.messageType)

    writeGate.resolve(undefined)
    await withWatchdog(cancellation)
    await assert.rejects(withWatchdog(pending), (error: unknown) =>
      error instanceof BotaSDKError && error.code === 'cancelled'
    )

    assert.deepEqual(
      transport.writes.map(({ value }) => value[0]),
      [blocked.messageType, 0x24],
    )
    const initialSettled = events.findIndex((event) =>
      event.startsWith(`write_settled:${blocked.messageType.toString(16)}`)
    )
    const abortWrite = events.findIndex((event) =>
      event.startsWith('write:') && event.split(':').at(-1)?.startsWith('24')
    )
    const abortSettled = events.findIndex((event) =>
      event.startsWith('write_settled:24')
    )
    const unsubscribe = events.findIndex((event) =>
      event.startsWith('unsubscribe:')
    )
    assert.ok(initialSettled >= 0 && initialSettled < abortWrite)
    assert.ok(abortSettled >= 0 && abortSettled < unsubscribe)
  })
}

test('a blocked transfer write that cannot be joined poisons BLE ownership', async () => {
  const bridge = await core
  const transport = new FakeBrowserBluetoothTransport()
  const writeGate = deferred<void>()
  transport.writeGate = writeGate.promise
  let poisonCalls = 0
  const control = new EncryptedUploadV2TransferControl(
    bridge,
    transport,
    transport.device,
    () => { poisonCalls += 1 },
    { cleanupTimeoutMs: 10 },
  )
  const controller = new AbortController()
  const pending = control.open(transferRequest(), null, controller.signal)
  await waitForWrites(transport, 1)

  controller.abort()
  await assert.rejects(withWatchdog(control.cancel()), (error: unknown) =>
    error instanceof BotaSDKError && error.code === 'integrity_failed'
  )
  assert.equal(poisonCalls, 1)
  assert.equal(transport.writes.length, 1)
  await assert.rejects(
    control.open(transferRequest(), null),
    (error: unknown) =>
      error instanceof BotaSDKError && error.code === 'operation_in_progress',
  )

  writeGate.resolve(undefined)
  await assert.rejects(withWatchdog(pending), (error: unknown) =>
    error instanceof BotaSDKError && error.code === 'cancelled'
  )
  await settleAsyncWork()
  assert.deepEqual(transport.writes.map(({ value }) => value[0]), [0x20, 0x24])
})

test('an exact device START error releases ownership without another terminal frame', async () => {
  const bridge = await core
  const transport = new FakeBrowserBluetoothTransport()
  const control = new EncryptedUploadV2TransferControl(
    bridge,
    transport,
    transport.device,
  )
  const pending = control.open({
    transportSessionId: TRANSPORT_SESSION_ID,
    uploadSessionUuid: '10111213-1415-1617-1819-1a1b1c1d1e1f',
    recordingUuid: '00112233-4455-6677-8899-aabbccddeeff',
    recordingGeneration: 9,
    authorizationSha256: new Uint8Array(32).fill(0x55),
    expectedCiphertextLength: 330n,
    expectedCiphertextSha256: CIPHERTEXT_SHA256,
    expectedCheckpointIntervalBlocks: 8,
    windowPackets: 16,
    dataPayloadBytes: 244,
  }, null)
  await waitForWrites(transport, 1)
  const deviceError = bytes((await vector('ble-error')).inputHex)
  deviceError[14] = 0x20
  transport.emitNotification(
    transport.device,
    BOTA_STORAGE_SERVICE,
    RECORDING_TRANSFER_V2_CHARACTERISTIC,
    deviceError,
  )

  await assert.rejects(pending, (error: unknown) =>
    error instanceof BotaSDKError
      && error.code === 'protocol_error'
      && error.protocolStatus === 15
  )
  assert.equal(transport.writes.length, 1)
  assert.equal(transport.writes[0]?.value[0], 0x20)
})

test('aborting a transfer discards ciphertext already queued behind START', async () => {
  const bridge = await core
  const transport = new FakeBrowserBluetoothTransport()
  const control = new EncryptedUploadV2TransferControl(
    bridge,
    transport,
    transport.device,
  )
  const pending = control.open({
    transportSessionId: TRANSPORT_SESSION_ID,
    uploadSessionUuid: '10111213-1415-1617-1819-1a1b1c1d1e1f',
    recordingUuid: '00112233-4455-6677-8899-aabbccddeeff',
    recordingGeneration: 9,
    authorizationSha256: new Uint8Array(32).fill(0x55),
    expectedCiphertextLength: 330n,
    expectedCiphertextSha256: CIPHERTEXT_SHA256,
    expectedCheckpointIntervalBlocks: 8,
    windowPackets: 16,
    dataPayloadBytes: 244,
  }, null)
  await waitForWrites(transport, 1)
  transport.emitNotification(
    transport.device,
    BOTA_STORAGE_SERVICE,
    RECORDING_TRANSFER_V2_CHARACTERISTIC,
    bytes((await vector('ble-start-ack')).inputHex),
  )
  transport.emitNotification(
    transport.device,
    BOTA_STORAGE_SERVICE,
    RECORDING_TRANSFER_V2_CHARACTERISTIC,
    bytes((await vector('ble-data')).inputHex),
  )
  const opened = await pending
  assert.equal(opened.kind, 'opened')
  if (opened.kind !== 'opened') return

  await control.abort()

  assert.deepEqual(
    await opened.notifications[Symbol.asyncIterator]().next(),
    { done: true, value: undefined },
  )
})

test('receiver repairs gaps and cannot acknowledge before durable checkpoint save', async () => {
  const bridge = await core
  const ciphertext = bytes((await vector('storage-partial-block')).inputHex)
  const blob = new FakeRecordingBlob('receiver-test')
  const receiver = new EncryptedUploadV2TransferReceiver(bridge, blob, {
    transportSessionId: TRANSPORT_SESSION_ID,
    expectedCiphertextLength: BigInt(ciphertext.byteLength),
    expectedCiphertextSha256: CIPHERTEXT_SHA256,
    maximumDataPayloadBytes: 100,
    maximumWindowPackets: 15,
    maximumMissingSequences: 15,
    checkpoint: {
      revision: 0,
      nextCiphertextOffset: 0n,
      prefixSha256: EMPTY_SHA256,
      highestContiguousSequence: null,
    },
  })
  await receiver.prepare()
  await receiver.receive(dataFrame(0, 0, ciphertext.slice(0, 100)))
  await receiver.receive(dataFrame(2, 200, ciphertext.slice(200, 300)))
  const firstBoundary = await receiver.receive(
    windowEnd(0, 0, 2, 300, sha256(bridge, ciphertext.slice(0, 300)), 1),
  )
  assert.deepEqual(firstBoundary, {
    kind: 'window_staged',
    checkpoint: {
      revision: 1,
      nextCiphertextOffset: 300n,
      prefixSha256: sha256(bridge, ciphertext.slice(0, 300)),
      highestContiguousSequence: 2,
    },
    missingSequences: [1],
  })
  assert.equal(await blob.size(), 0)

  const repair = receiver.repairAcknowledgement([1])
  assert.deepEqual(repair.missingSequences, [1])
  await receiver.receive(dataFrame(1, 100, ciphertext.slice(100, 200)))
  const cleanBoundary = await receiver.receive(
    windowEnd(0, 0, 2, 300, sha256(bridge, ciphertext.slice(0, 300)), 1),
  )
  assert.equal(cleanBoundary?.kind, 'window_staged')
  assert.equal(await blob.size(), 300)
  const checkpoint = cleanBoundary?.kind === 'window_staged'
    ? cleanBoundary.checkpoint
    : assert.fail('expected a clean window boundary')

  assert.throws(() => receiver.windowAcknowledgement(checkpoint))
  receiver.checkpointDidPersist(checkpoint)
  const acknowledged = receiver.windowAcknowledgement(checkpoint)
  assert.deepEqual(acknowledged.missingSequences, [])
  assert.equal(acknowledged.nextCiphertextOffset, 300n)
})

test('receiver preserves a durable OPFS quota failure', async () => {
  const bridge = await core
  const ciphertext = bytes((await vector('storage-partial-block')).inputHex)
  const blob = new FakeRecordingBlob('receiver-quota')
  const receiver = receiverFor(
    bridge,
    blob,
    ciphertext,
    {
      revision: 0,
      nextCiphertextOffset: 0n,
      prefixSha256: EMPTY_SHA256,
      highestContiguousSequence: null,
    },
  )
  await receiver.prepare()
  await receiver.receive(dataFrame(0, 0, ciphertext.slice(0, 100)))
  blob.writeError = new BrowserStorageError('storage_quota_exceeded')

  await assert.rejects(
    receiver.receive(windowEnd(
      0,
      0,
      0,
      100,
      sha256(bridge, ciphertext.slice(0, 100)),
      1,
    )),
    (error: unknown) =>
      error instanceof BotaSDKError
        && error.code === 'storage_quota_exceeded',
  )
})

test('receiver truncates an unproved resume tail and rejects a mismatched proven prefix', async () => {
  const bridge = await core
  const ciphertext = bytes((await vector('storage-partial-block')).inputHex)
  const proven = ciphertext.slice(0, 100)
  const checkpoint = {
    revision: 3,
    nextCiphertextOffset: 100n,
    prefixSha256: sha256(bridge, proven),
    highestContiguousSequence: 0,
  }
  const blob = new FakeRecordingBlob('resume-tail')
  blob.seed(Uint8Array.from([...proven, 0xde, 0xad, 0xbe, 0xef]))
  const receiver = receiverFor(bridge, blob, ciphertext, checkpoint)

  await receiver.prepare()
  assert.deepEqual(blob.snapshot(), proven)

  const corruptBlob = new FakeRecordingBlob('resume-corrupt')
  const corrupt = proven.slice()
  corrupt[0] = (corrupt[0] ?? 0) ^ 0xff
  corruptBlob.seed(corrupt)
  const corruptReceiver = receiverFor(
    bridge,
    corruptBlob,
    ciphertext,
    checkpoint,
  )
  await assert.rejects(corruptReceiver.prepare(), (error: unknown) =>
    error instanceof BotaSDKError && error.code === 'integrity_failed'
  )
})

test('receiver ignores only byte-identical duplicates and fails closed on conflicts', async () => {
  const bridge = await core
  const ciphertext = bytes((await vector('storage-partial-block')).inputHex)
  const duplicateBlob = new FakeRecordingBlob('duplicate')
  const duplicate = receiverFor(
    bridge,
    duplicateBlob,
    ciphertext,
    {
      revision: 0,
      nextCiphertextOffset: 0n,
      prefixSha256: EMPTY_SHA256,
      highestContiguousSequence: null,
    },
  )
  await duplicate.prepare()
  const first = dataFrame(0, 0, ciphertext.slice(0, 100))
  await duplicate.receive(first)
  await duplicate.receive(first)
  await assert.rejects(
    duplicate.receive(dataFrame(0, 0, Uint8Array.of(0xff))),
    (error: unknown) =>
      error instanceof BotaSDKError && error.code === 'integrity_failed',
  )

  const overlap = receiverFor(
    bridge,
    new FakeRecordingBlob('overlap'),
    ciphertext,
    {
      revision: 0,
      nextCiphertextOffset: 0n,
      prefixSha256: EMPTY_SHA256,
      highestContiguousSequence: null,
    },
  )
  await overlap.prepare()
  await overlap.receive(dataFrame(0, 0, ciphertext.slice(0, 100)))
  await assert.rejects(
    overlap.receive(dataFrame(1, 50, ciphertext.slice(100, 200))),
    (error: unknown) =>
      error instanceof BotaSDKError && error.code === 'protocol_error',
  )

  const foreign = receiverFor(
    bridge,
    new FakeRecordingBlob('foreign'),
    ciphertext,
    {
      revision: 0,
      nextCiphertextOffset: 0n,
      prefixSha256: EMPTY_SHA256,
      highestContiguousSequence: null,
    },
  )
  await foreign.prepare()
  await assert.rejects(
    foreign.receive({
      ...dataFrame(0, 0, ciphertext.slice(0, 100)),
      transportSessionId: TRANSPORT_SESSION_ID + 1n,
    }),
    (error: unknown) =>
      error instanceof BotaSDKError && error.code === 'identity_mismatch',
  )
})

test('receiver enforces the 580-byte manifest and exact EOF ciphertext evidence', async () => {
  const bridge = await core
  const ciphertext = bytes((await vector('storage-partial-block')).inputHex)
  const manifest = bytes((await vector('manifest-hpke')).inputHex)
  const manifestSha256 = sha256(bridge, manifest)
  const checkpoint = {
    revision: 1,
    nextCiphertextOffset: 330n,
    prefixSha256: CIPHERTEXT_SHA256,
    highestContiguousSequence: 3,
  }
  const oversizedBlob = new FakeRecordingBlob('oversized-manifest')
  oversizedBlob.seed(ciphertext)
  const oversized = receiverFor(
    bridge,
    oversizedBlob,
    ciphertext,
    checkpoint,
  )
  await oversized.prepare()
  await assert.rejects(
    oversized.receive({
      kind: 'manifest_chunk',
      flags: 0,
      transportSessionId: TRANSPORT_SESSION_ID,
      totalManifestLength: 581,
      chunkOffset: 0,
      manifestSha256,
      chunk: manifest.slice(0, 64),
    }),
    (error: unknown) =>
      error instanceof BotaSDKError && error.code === 'protocol_error',
  )

  const eofBlob = new FakeRecordingBlob('wrong-eof')
  eofBlob.seed(ciphertext)
  const eofReceiver = receiverFor(bridge, eofBlob, ciphertext, checkpoint)
  await eofReceiver.prepare()
  for (let offset = 0; offset < manifest.byteLength; offset += 76) {
    await eofReceiver.receive({
      kind: 'manifest_chunk',
      flags: 0,
      transportSessionId: TRANSPORT_SESSION_ID,
      totalManifestLength: 580,
      chunkOffset: offset,
      manifestSha256,
      chunk: manifest.slice(offset, offset + 76),
    })
  }
  await assert.rejects(
    eofReceiver.receive({
      kind: 'eof',
      flags: 0,
      transportSessionId: TRANSPORT_SESSION_ID,
      finalSequence: 3,
      blockCount: 1,
      ciphertextLength: 329n,
      ciphertextSha256: CIPHERTEXT_SHA256,
      manifestSha256,
    }),
    (error: unknown) =>
      error instanceof BotaSDKError && error.code === 'integrity_failed',
  )
})

test('persisted v2 state binds its checkpoint exactly and drops unknown material', () => {
  const state = persistedState()
  const parsed = parsePersistedEncryptedUploadV2State({
    ...state,
    rawReceipt: new Uint8Array(336),
  })
  assert.equal('rawReceipt' in parsed, false)

  assert.throws(
    () => parsePersistedEncryptedUploadV2State({
      ...state,
      coreCheckpoint: {
        ...state.coreCheckpoint,
        recordingGeneration: state.recording.generation + 1,
      },
    }),
    (error: unknown) =>
      error instanceof BotaSDKError && error.code === 'integrity_failed',
  )

  const completedWithoutTransferCheckpoint = parsePersistedEncryptedUploadV2State({
    ...state,
    coreCheckpoint: null,
    highestContiguousSequence: null,
    evidence: {
      ciphertextLength: state.recording.ciphertextLength,
      ciphertextSha256: state.recording.ciphertextSha256.slice(),
      manifestLength: 580,
      manifestSha256: new Uint8Array(32).fill(0x44),
      blockCount: 1,
    },
  })
  assert.equal(completedWithoutTransferCheckpoint.coreCheckpoint, null)
  assert.equal(completedWithoutTransferCheckpoint.evidence?.manifestLength, 580)
})

function persistedState(): PersistedEncryptedUploadV2State {
  return {
    schemaVersion: 1,
    operationId: 'persisted-state-test',
    serialNumber: 'GDPPSBZJN6',
    recording: {
      uuid: '00112233-4455-6677-8899-aabbccddeeff',
      generation: 9,
      storageFormat: 3,
      ciphertextLength: 330n,
      ciphertextSha256: CIPHERTEXT_SHA256.slice(),
    },
    materialId: 'material-v2-1',
    recordingId: 'cloud-recording-v2-1',
    uploadSessionId: '10111213-1415-1617-1819-1a1b1c1d1e1f',
    ownerRevision: 3,
    policy: 'v2_required',
    transportSessionId: TRANSPORT_SESSION_ID,
    sinkId: 'recording:persisted-state-test',
    windowPackets: 15,
    dataPayloadBytes: 100,
    maximumSignedBlobBytes: 1024,
    maximumMissingSequences: 15,
    checkpointIntervalBlocks: 8,
    capabilitySha256Hex: '11'.repeat(32),
    coreCheckpoint: {
      serialNumber: 'GDPPSBZJN6',
      recordingUuid: bytes('00112233445566778899aabbccddeeff'),
      recordingGeneration: 9,
      uploadSessionId: bytes('101112131415161718191a1b1c1d1e1f'),
      ownerRevision: 3,
      transportSessionId: TRANSPORT_SESSION_ID,
      checkpointRevision: 1,
      nextCiphertextOffset: 330n,
      prefixSha256: CIPHERTEXT_SHA256.slice(),
      windowPackets: 15,
      dataPayloadBytes: 100,
    },
    highestContiguousSequence: 3,
    evidence: null,
  }
}

function transferRequest(): EncryptedUploadV2TransferRequest {
  return {
    transportSessionId: TRANSPORT_SESSION_ID,
    uploadSessionUuid: '10111213-1415-1617-1819-1a1b1c1d1e1f',
    recordingUuid: '00112233-4455-6677-8899-aabbccddeeff',
    recordingGeneration: 9,
    authorizationSha256: new Uint8Array(32).fill(0x55),
    expectedCiphertextLength: 330n,
    expectedCiphertextSha256: CIPHERTEXT_SHA256,
    expectedCheckpointIntervalBlocks: 8,
    windowPackets: 16,
    dataPayloadBytes: 100,
  }
}

function receiverFor(
  bridge: CoreBridge,
  blob: FakeRecordingBlob,
  ciphertext: Uint8Array,
  checkpoint: {
    revision: number
    nextCiphertextOffset: bigint
    prefixSha256: Uint8Array
    highestContiguousSequence: number | null
  },
): EncryptedUploadV2TransferReceiver {
  return new EncryptedUploadV2TransferReceiver(bridge, blob, {
    transportSessionId: TRANSPORT_SESSION_ID,
    expectedCiphertextLength: BigInt(ciphertext.byteLength),
    expectedCiphertextSha256: CIPHERTEXT_SHA256,
    maximumDataPayloadBytes: 100,
    maximumWindowPackets: 15,
    maximumMissingSequences: 15,
    checkpoint,
  })
}

function dataFrame(
  sequence: number,
  offset: number,
  data: Uint8Array,
): Extract<CoreEncryptedUploadV2TransferFrame, { kind: 'data' }> {
  return {
    kind: 'data',
    flags: 0,
    transportSessionId: TRANSPORT_SESSION_ID,
    sequence,
    offset: BigInt(offset),
    data,
  }
}

function windowEnd(
  windowIndex: number,
  firstSequence: number,
  lastSequence: number,
  nextOffset: number,
  prefixSha256: Uint8Array,
  checkpointRevision: number,
): Extract<CoreEncryptedUploadV2TransferFrame, { kind: 'window_end' }> {
  return {
    kind: 'window_end',
    flags: 0,
    transportSessionId: TRANSPORT_SESSION_ID,
    windowIndex,
    firstSequence,
    lastSequence,
    nextCiphertextOffset: BigInt(nextOffset),
    prefixSha256,
    checkpointRevision,
  }
}

async function vector(name: string): Promise<VectorCase> {
  const suite = JSON.parse(await readFile(
    new URL(
      '../../../../protocol/vectors/encrypted-upload-v2.json',
      import.meta.url,
    ),
    'utf8',
  )) as { cases: VectorCase[] }
  const found = suite.cases.find((candidate) => candidate.name === name)
  assert.ok(found, `missing encrypted-upload-v2 vector ${name}`)
  return found
}

function bytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g) ?? [], (byte) =>
    Number.parseInt(byte, 16)
  )
}

function sha256(bridge: CoreBridge, value: Uint8Array): Uint8Array {
  const hasher = bridge.createIntegrityHasher()
  hasher.update(value)
  return hasher.sha256Snapshot()
}

async function waitForWrites(
  transport: FakeBrowserBluetoothTransport,
  count: number,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (transport.writes.length >= count) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  assert.fail(`timed out waiting for ${count} writes`)
}

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function settleAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

async function withWatchdog<T>(promise: Promise<T>): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('test watchdog expired')), 250)
    }),
  ])
}
