import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import type { CoreBridge } from '../core.ts'
import { DeviceManager } from '../deviceManager.ts'
import {
  BOTA_STORAGE_SERVICE,
  ENCRYPTED_UPLOAD_V2_CAPABILITY_CHARACTERISTIC,
  RECORDING_LIST_CHARACTERISTIC,
  RECORDING_LIST_V2_CHARACTERISTIC,
  RECORDING_TRANSFER_V2_CHARACTERISTIC,
  TRANSFER_CONTROL_V2_CHARACTERISTIC,
  TRANSFER_SIGNED_BLOB_V2_CHARACTERISTIC,
} from '../gatt.ts'
import type { DeviceRecording } from '../models.ts'
import type {
  EncryptedUploadV2Evidence,
  EncryptedUploadV2Material,
  UploadRequestTemplate,
} from '../providers.ts'
import { RecordingManager } from '../recordingManager.ts'
import { BotaSDKError } from '../errors.ts'
import {
  parsePersistedEncryptedUploadV2State,
  type PersistedEncryptedUploadV2State,
} from '../encryptedUploadV2Host.ts'
import { BrowserStorageError, type RecordingJournal } from '../storage.ts'
import { createWasmCore } from '../wasmCore.ts'
import { BrowserWorkflowRuntime } from '../workflowRuntime.ts'
import { BrowserTransportError } from '../transport.ts'
import { FakeBrowserBluetoothTransport } from './fakeBluetooth.ts'
import {
  deferred,
  FakeRecordingStorage,
  FakeRecordingUploadProvider,
} from './fakeProviders.ts'

interface VectorCase {
  name: string
  inputHex: string
}

const SERIAL = 'GDPPSBZJN6'
const OPERATION_ID = 'encrypted-upload-v2-test'
const RECORDING_UUID = '00112233-4455-6677-8899-aabbccddeeff'
const UPLOAD_SESSION_UUID = '10111213-1415-1617-1819-1a1b1c1d1e1f'
const CAPABILITY = bytes('010218007f00000000040004f40010000800000010000000')
const CIPHERTEXT_SHA256 = bytes(
  '287ad0258b5465b48757afe5f6980b7089fea7cb7520dc2db6d2fc9fd4fbfd1b',
)
const EMPTY_SHA256 = bytes(
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
)
const wasmBytes = readFile(
  new URL('../generated/bota_device_sdk_core_bg.wasm', import.meta.url),
)

test('v2 list reads a fresh capability and returns exact generation and ciphertext evidence', async () => {
  const harness = await createHarness()
  const canonicalEntry = bytes((await vector('ble-recording-entry')).inputHex)
  const canonicalEnd = bytes((await vector('ble-recording-list-end')).inputHex)

  const first = harness.manager.list()
  await waitForWriteType(harness.transport, 0x25)
  const firstSession = latestSession(harness.transport, 0x25)
  const firstFrames = listFrames(
    harness.core,
    canonicalEntry,
    canonicalEnd,
    firstSession,
  )
  emitTransfer(harness.transport, RECORDING_LIST_V2_CHARACTERISTIC, firstFrames.entry)
  emitTransfer(harness.transport, RECORDING_LIST_V2_CHARACTERISTIC, firstFrames.end)
  assert.deepEqual(await first, [recording()])

  const firstCapabilityReads = capabilityReadCount(harness.transport)
  harness.transport.writes.length = 0
  const second = harness.manager.list()
  await waitForWriteType(harness.transport, 0x25)
  const secondFrames = listFrames(
    harness.core,
    canonicalEntry,
    canonicalEnd,
    latestSession(harness.transport, 0x25),
  )
  emitTransfer(harness.transport, RECORDING_LIST_V2_CHARACTERISTIC, secondFrames.entry)
  emitTransfer(harness.transport, RECORDING_LIST_V2_CHARACTERISTIC, secondFrames.end)
  await second
  assert.equal(capabilityReadCount(harness.transport), firstCapabilityReads + 1)
})

test('v2 capability transport failure never falls back to legacy LIST', async () => {
  const harness = await createHarness()
  harness.transport.failRead(
    BOTA_STORAGE_SERVICE,
    ENCRYPTED_UPLOAD_V2_CAPABILITY_CHARACTERISTIC,
    new BrowserTransportError('disconnected'),
  )

  await assert.rejects(harness.manager.list(), (error: unknown) =>
    error instanceof BotaSDKError && error.code === 'device_disconnected'
  )
  assert.equal(harness.transport.writes.length, 0)
})

test('LIST selects v2 only after the Rust capability probe accepts the exact contract', async () => {
  for (const flags of [0, 0x01, 0x3f]) {
    const harness = await createHarness()
    const capability = CAPABILITY.slice()
    u32(capability, 4, flags)
    harness.transport.setRead(
      BOTA_STORAGE_SERVICE,
      ENCRYPTED_UPLOAD_V2_CAPABILITY_CHARACTERISTIC,
      capability,
    )

    const pending = harness.manager.list()
    await waitForAnyWrite(harness.transport)
    const first = harness.transport.writes[0]?.value
    if (first?.[0] === 0x25) {
      const session = latestSession(harness.transport, 0x25)
      const frames = listFrames(
        harness.core,
        bytes((await vector('ble-recording-entry')).inputHex),
        bytes((await vector('ble-recording-list-end')).inputHex),
        session,
      )
      emitTransfer(
        harness.transport,
        RECORDING_LIST_V2_CHARACTERISTIC,
        frames.entry,
      )
      emitTransfer(
        harness.transport,
        RECORDING_LIST_V2_CHARACTERISTIC,
        frames.end,
      )
    } else {
      emitTransfer(
        harness.transport,
        RECORDING_LIST_CHARACTERISTIC,
        bytes('a1b2c3d401000000000000000000000000f153650c000400'),
      )
    }
    const listed = await pending
    assert.deepEqual(first, harness.core.encodeRecordingListCommand())
    assert.equal(listed[0]?.encryptedUploadV2, null)
  }
})

test('uncertain v2 LIST cleanup poisons shared BLE ownership', async () => {
  const harness = await createHarness()
  const canonicalEntry = bytes((await vector('ble-recording-entry')).inputHex)
  const canonicalEnd = bytes((await vector('ble-recording-list-end')).inputHex)
  let rejectUnsubscribe!: (error: unknown) => void
  harness.transport.unsubscribeGate = new Promise<void>((_resolve, reject) => {
    rejectUnsubscribe = reject
  })
  harness.transport.onUnsubscribe = () => {
    rejectUnsubscribe(new Error('uncertain LIST cleanup'))
  }
  const pending = harness.manager.list()
  await waitForWriteType(harness.transport, 0x25)
  const frames = listFrames(
    harness.core,
    canonicalEntry,
    canonicalEnd,
    latestSession(harness.transport, 0x25),
  )
  emitTransfer(harness.transport, RECORDING_LIST_V2_CHARACTERISTIC, frames.entry)
  emitTransfer(harness.transport, RECORDING_LIST_V2_CHARACTERISTIC, frames.end)

  await assert.rejects(pending, (error: unknown) =>
    error instanceof BotaSDKError && error.code === 'integrity_failed'
  )
  await assert.rejects(
    harness.runtime.runExclusive('read_snapshot', async () => undefined),
    (error: unknown) =>
      error instanceof BotaSDKError && error.code === 'operation_in_progress',
  )
})

test('explicit v2 sync binds fresh capability, stages ciphertext, persists receipt evidence, and confirms', async () => {
  const harness = await createHarness()
  const authorization = bytes(
    (await vector('authorization-development')).inputHex,
  )
  const receipt = bytes((await vector('completion-receipt')).inputHex)
  const deliveredReceipt = receipt.slice()
  const ciphertext = bytes((await vector('storage-partial-block')).inputHex)
  const manifest = bytes((await vector('manifest-hpke')).inputHex)
  assert.equal(ciphertext.byteLength, 330)
  assert.equal(manifest.byteLength, 580)
  const manifestSha256 = sha256(harness.core, manifest)
  const receiptSha256 = sha256(harness.core, receipt)
  const authorizationSha256 = sha256(harness.core, authorization)
  const savedJournals: RecordingJournal[] = []
  harness.storage.onSaveRecordingJournal = (journal) => {
    savedJournals.push(journal)
  }
  const callbackEvidence: EncryptedUploadV2Evidence[] = []
  let submittedManifest: Uint8Array | null = null
  let uploaded = new Uint8Array()
  const request: UploadRequestTemplate = {
    method: 'PUT',
    url: 'https://upload-secret.example.invalid/v2',
    headers: { Authorization: 'Bearer v2-secret' },
  }
  harness.provider.encryptedUploadV2Material = {
    materialId: 'material-v2-1',
    recordingId: 'cloud-recording-v2-1',
    uploadSessionId: UPLOAD_SESSION_UUID,
    ownerRevision: 3,
    policy: 'v2_required',
    authorization,
    stagingRequest: async (evidence) => {
      harness.events.push('provider:v2:staging_request')
      callbackEvidence.push(copyEvidence(evidence))
      return request
    },
    submitManifest: async (value, evidence) => {
      harness.events.push('provider:v2:submit_manifest')
      submittedManifest = value.slice()
      callbackEvidence.push(copyEvidence(evidence))
    },
    finalize: async (evidence) => {
      harness.events.push('provider:v2:finalize')
      callbackEvidence.push(copyEvidence(evidence))
    },
    completionReceipt: async (evidence) => {
      harness.events.push('provider:v2:receipt')
      callbackEvidence.push(copyEvidence(evidence))
      return deliveredReceipt
    },
    cancel: async () => {
      harness.events.push('provider:v2:cancel')
    },
  }
  harness.setFetch(async (_input, init) => {
    harness.events.push('fetch:v2')
    assert.equal(init?.redirect, 'error')
    uploaded = new Uint8Array(await new Response(init?.body).arrayBuffer())
    return new Response(null, { status: 200 })
  })
  installSuccessfulDeviceFlow(
    harness,
    ciphertext,
    manifest,
    manifestSha256,
  )

  const result = await withWatchdog(harness.manager.sync(recording(), {
    profile: 'encrypted_upload_v2',
    operationId: OPERATION_ID,
  }))

  assert.deepEqual(result, {
    operationId: OPERATION_ID,
    recordingUuid: RECORDING_UUID,
    profile: 'encrypted_upload_v2',
    cloudCompletionId: 'cloud-recording-v2-1',
  })
  assert.equal(harness.provider.prepared.length, 0)
  assert.equal(harness.provider.encryptedUploadV2Prepared.length, 1)
  const context = harness.provider.encryptedUploadV2Prepared[0]
  assert.ok(context)
  assert.deepEqual(context.capability.rawValue, CAPABILITY)
  assert.deepEqual(context.capability.sha256, sha256(harness.core, CAPABILITY))
  assert.deepEqual(context.capability.decoded, {
    flags: 127,
    maximumSignedBlobBytes: 1024,
    maximumManifestBytes: 1024,
    maximumDataPayloadBytes: 244,
    maximumWindowPackets: 16,
    durableCheckpointIntervalBlocks: 8,
    maximumMissingSequences: 16,
  })
  assert.equal(context.checkpoint, null)
  assert.deepEqual(uploaded, ciphertext)
  assert.deepEqual(submittedManifest, manifest)
  assert.ok(authorization.every((value) => value === 0))
  assert.ok(deliveredReceipt.every((value) => value === 0))
  assert.ok(callbackEvidence.every((evidence) =>
    evidence.ciphertextLength === 330n
      && equalBytes(evidence.ciphertextSha256, CIPHERTEXT_SHA256)
      && evidence.manifestLength === 580
      && equalBytes(evidence.manifestSha256, manifestSha256)
      && evidence.blockCount === 1
  ))
  assert.deepEqual(
    savedJournals.map(({ phase }) => phase),
    ['prepared', 'transferring', 'staged', 'uploading', 'cloud_completed', 'confirmed'],
  )
  const cloudCompleted = savedJournals.find(({ phase }) =>
    phase === 'cloud_completed'
  )
  assert.equal(cloudCompleted?.confirmationDigestHex, hexString(receiptSha256))
  assert.ok(!JSON.stringify(savedJournals).includes(hexString(receipt)))
  assert.ok(indexOf(harness.events, 'journal:cloud_completed')
    < writeEventIndex(harness.events, 0x23))
  const start = writeForType(harness.transport, 0x20)
  const transportSessionId = new DataView(
    start.buffer,
    start.byteOffset,
    start.byteLength,
  ).getBigUint64(4, true)
  assert.deepEqual(start, harness.core.encodeEncryptedUploadV2Transfer({
    kind: 'start',
    flags: 0,
    transportSessionId,
    uploadSessionUuid: UPLOAD_SESSION_UUID,
    recordingUuid: RECORDING_UUID,
    recordingGeneration: 9,
    authorizationSha256,
    checkpointRevision: 0,
    nextCiphertextOffset: 0n,
    prefixSha256: EMPTY_SHA256,
    windowPackets: 15,
    dataPayloadBytes: 100,
  }))
  assert.deepEqual(
    writeForType(harness.transport, 0x21),
    harness.core.encodeEncryptedUploadV2Transfer({
      kind: 'window_ack',
      flags: 0,
      transportSessionId,
      windowIndex: 0,
      highestContiguousSequence: 3,
      nextCiphertextOffset: 330n,
      prefixSha256: CIPHERTEXT_SHA256,
      checkpointRevision: 1,
      missingSequences: [],
    }),
  )
  assert.deepEqual(
    writeForType(harness.transport, 0x23),
    harness.core.encodeEncryptedUploadV2Transfer({
      kind: 'confirm',
      flags: 0,
      transportSessionId,
      uploadSessionUuid: UPLOAD_SESSION_UUID,
      recordingUuid: RECORDING_UUID,
      recordingGeneration: 9,
      ownerRevision: 3,
      receiptSha256,
    }),
  )
  assert.ok(harness.transport.writes.every(({ value }) =>
    value.byteLength <= 128
  ))
  const transferSubscribe = harness.events.findIndex((event) =>
    event.startsWith('subscribe:')
      && event.includes(RECORDING_TRANSFER_V2_CHARACTERISTIC)
  )
  const startWrite = writeEventIndex(harness.events, 0x20)
  assert.ok(transferSubscribe >= 0 && transferSubscribe < startWrite)
  assert.equal(harness.storage.recordingJournals.size, 0)
  assert.equal(harness.storage.encryptedUploadV2Checkpoints.size, 0)
})

test('signed-document correlation IDs do not repeat across v2 host instances', async () => {
  const harness = await createHarness()
  const ciphertext = bytes((await vector('storage-partial-block')).inputHex)
  const manifest = bytes((await vector('manifest-hpke')).inputHex)
  harness.setFetch(async () => new Response(null, { status: 200 }))

  for (const suffix of [1, 2]) {
    const authorization = bytes(
      (await vector('authorization-development')).inputHex,
    )
    harness.provider.encryptedUploadV2Material = inertMaterial(
      authorization,
      () => undefined,
    )
    installSuccessfulDeviceFlow(
      harness,
      ciphertext,
      manifest,
      sha256(harness.core, manifest),
    )
    await withWatchdog(harness.manager.sync(recording(), {
      profile: 'encrypted_upload_v2',
      operationId: `v2-correlation-${suffix}`,
    }))
  }

  const writeIds = harness.transport.writes
    .filter(({ characteristicUuid, value }) =>
      characteristicUuid === TRANSFER_SIGNED_BLOB_V2_CHARACTERISTIC
        && value[0] === 0x60
    )
    .map(({ value }) => new DataView(
      value.buffer,
      value.byteOffset,
      value.byteLength,
    ).getUint32(4, true))
  assert.equal(writeIds.length, 4)
  assert.equal(new Set(writeIds).size, writeIds.length)
  assert.ok(writeIds.every((writeId) => writeId !== 0))
})

test('v2 provider failure leaves no orphaned state and never falls back to legacy', async () => {
  const harness = await createHarness()
  const capabilityReads = capabilityReadCount(harness.transport)

  for (const operationId of ['v2-provider-failure-1', 'v2-provider-failure-2']) {
    await assert.rejects(
      harness.manager.sync(recording(), {
        profile: 'encrypted_upload_v2',
        operationId,
      }),
      (error: unknown) =>
        error instanceof BotaSDKError && error.code === 'upload_failed',
    )
  }

  assert.equal(capabilityReadCount(harness.transport), capabilityReads + 2)
  assert.equal(harness.provider.prepared.length, 0)
  assert.equal(harness.transport.writes.length, 0)
  assert.equal(harness.storage.recordingJournals.size, 0)
  assert.equal(harness.storage.encryptedUploadV2Checkpoints.size, 0)
})

test('Rust profile validation rejects invalid capability flags before provider or durable state', async () => {
  for (const flags of [0, 0x01, 0x3f]) {
    const harness = await createHarness()
    const capability = CAPABILITY.slice()
    u32(capability, 4, flags)
    harness.transport.setRead(
      BOTA_STORAGE_SERVICE,
      ENCRYPTED_UPLOAD_V2_CAPABILITY_CHARACTERISTIC,
      capability,
    )

    await assert.rejects(
      harness.manager.sync(recording(), {
        profile: 'encrypted_upload_v2',
        operationId: `v2-invalid-flags-${flags}`,
      }),
      (error: unknown) =>
        error instanceof BotaSDKError
          && error.code === 'unsupported_capability',
    )

    assert.equal(harness.provider.encryptedUploadV2Prepared.length, 0)
    assert.equal(harness.storage.recordingJournals.size, 0)
    assert.equal(harness.storage.encryptedUploadV2Checkpoints.size, 0)
    assert.equal(harness.storage.blobs.size, 0)
  }
})

test('Rust profile validation rejects a wrong storage format before provider or durable state', async () => {
  const harness = await createHarness()
  const wrongFormat = recording()
  assert.ok(wrongFormat.encryptedUploadV2)
  wrongFormat.encryptedUploadV2.storageFormat = 1

  await assert.rejects(
    harness.manager.sync(wrongFormat, {
      profile: 'encrypted_upload_v2',
      operationId: 'v2-wrong-storage-format',
    }),
    (error: unknown) =>
      error instanceof BotaSDKError && error.code === 'unsupported_capability',
  )

  assert.equal(harness.provider.encryptedUploadV2Prepared.length, 0)
  assert.equal(harness.storage.recordingJournals.size, 0)
  assert.equal(harness.storage.encryptedUploadV2Checkpoints.size, 0)
  assert.equal(harness.storage.blobs.size, 0)
})

test('poisoned v2 BLE ownership blocks work until confirmed disconnect', async () => {
  const harness = await createHarness()
  const deviceId = harness.transport.device.id
  harness.runtime.poisonBleOwnership(deviceId)

  await assert.rejects(
    harness.runtime.runExclusive('read_snapshot', async () => 'blocked'),
    (error: unknown) =>
      error instanceof BotaSDKError && error.code === 'operation_in_progress',
  )
  await harness.runtime.runExclusive('disconnect', async () => {
    harness.runtime.markDeviceDisconnected(deviceId)
  })

  assert.equal(
    await harness.runtime.runExclusive('read_snapshot', async () => 'ready'),
    'ready',
  )
})

test('cancellation after provider material prevents START and destroys unowned material', async () => {
  const harness = await createHarness()
  const authorization = bytes(
    (await vector('authorization-development')).inputHex,
  )
  let cancelCalls = 0
  harness.provider.encryptedUploadV2Material = inertMaterial(
    authorization,
    () => { cancelCalls += 1 },
  )
  const entered = deferred<void>()
  const release = deferred<void>()
  const saveOperation = harness.storage.saveEncryptedUploadV2Operation
    .bind(harness.storage)
  harness.storage.saveEncryptedUploadV2Operation = async (
    operationId,
    checkpoint,
    journal,
  ) => {
    entered.resolve(undefined)
    await release.promise
    await saveOperation(operationId, checkpoint, journal)
  }
  const controller = new AbortController()
  const sync = harness.manager.sync(recording(), {
    profile: 'encrypted_upload_v2',
    operationId: 'v2-cancel-after-provider',
    signal: controller.signal,
  })
  await entered.promise

  controller.abort()
  release.resolve(undefined)

  await assert.rejects(withWatchdog(sync), (error: unknown) =>
    error instanceof BotaSDKError && error.code === 'cancelled'
  )
  assert.equal(harness.transport.writes.length, 0)
  assert.equal(cancelCalls, 1)
  assert.ok(authorization.every((value) => value === 0))
  assert.equal(harness.storage.recordingJournals.size, 0)
  assert.equal(harness.storage.encryptedUploadV2Checkpoints.size, 0)
})

test('late provider material after cancellation is zero-filled and cancelled once', async () => {
  const harness = await createHarness()
  const authorization = bytes(
    (await vector('authorization-development')).inputHex,
  )
  let cancelCalls = 0
  const material = inertMaterial(authorization, () => { cancelCalls += 1 })
  const entered = deferred<void>()
  const providerResult = deferred<EncryptedUploadV2Material>()
  harness.provider.prepareEncryptedUploadV2 = async () => {
    entered.resolve(undefined)
    return await providerResult.promise
  }
  const controller = new AbortController()
  const sync = harness.manager.sync(recording(), {
    profile: 'encrypted_upload_v2',
    operationId: 'v2-late-provider',
    signal: controller.signal,
  })
  await entered.promise

  controller.abort()
  await assert.rejects(withWatchdog(sync), (error: unknown) =>
    error instanceof BotaSDKError && error.code === 'cancelled'
  )
  providerResult.resolve(material)
  await settleAsyncWork()

  assert.equal(cancelCalls, 1)
  assert.ok(authorization.every((value) => value === 0))
  assert.equal(harness.storage.recordingJournals.size, 0)
  assert.equal(harness.storage.encryptedUploadV2Checkpoints.size, 0)
})

test('late receipt after cancellation cannot persist cloud completion or send CONFIRM', async () => {
  const harness = await createHarness()
  const authorization = bytes(
    (await vector('authorization-development')).inputHex,
  )
  const ciphertext = bytes((await vector('storage-partial-block')).inputHex)
  const manifest = bytes((await vector('manifest-hpke')).inputHex)
  const receipt = bytes((await vector('completion-receipt')).inputHex)
  const receiptResult = deferred<Uint8Array>()
  let cancelCalls = 0
  harness.provider.encryptedUploadV2Material = {
    ...inertMaterial(authorization, () => { cancelCalls += 1 }),
    stagingRequest: async () => ({
      method: 'PUT',
      url: 'https://upload-secret.example.invalid/v2-cancel',
      headers: {},
    }),
    completionReceipt: async () => {
      harness.events.push('provider:v2:receipt-pending')
      return await receiptResult.promise
    },
  }
  harness.setFetch(async () => new Response(null, { status: 200 }))
  installSuccessfulDeviceFlow(
    harness,
    ciphertext,
    manifest,
    sha256(harness.core, manifest),
  )
  const controller = new AbortController()
  const sync = harness.manager.sync(recording(), {
    profile: 'encrypted_upload_v2',
    operationId: 'v2-cancel-receipt',
    signal: controller.signal,
  })
  await waitForEvent(harness.events, 'provider:v2:receipt-pending')

  controller.abort()
  await assert.rejects(withWatchdog(sync), (error: unknown) =>
    error instanceof BotaSDKError && error.code === 'cancelled'
  )
  receiptResult.resolve(receipt)
  await settleAsyncWork()

  assert.equal(cancelCalls, 1)
  assert.ok(receipt.every((value) => value === 0))
  assert.equal(
    [...harness.storage.recordingJournals.values()].some(
      ({ phase }) => phase === 'cloud_completed' || phase === 'confirmed',
    ),
    false,
  )
  assert.equal(hasWriteType(harness.transport, 0x23), false)
  assert.equal(harness.provider.prepared.length, 0)
})

test('cloud-completed recovery reacquires exact material and rejects a changed receipt digest', async () => {
  const harness = await createHarness()
  const operationId = 'v2-cloud-recovery'
  const authorization = bytes(
    (await vector('authorization-development')).inputHex,
  )
  const expectedReceipt = bytes((await vector('completion-receipt')).inputHex)
  const changedReceipt = expectedReceipt.slice()
  changedReceipt[0] = (changedReceipt[0] ?? 0) ^ 0xff
  const ciphertext = bytes((await vector('storage-partial-block')).inputHex)
  const manifest = bytes((await vector('manifest-hpke')).inputHex)
  const manifestSha256 = sha256(harness.core, manifest)
  const transportSessionId = 18_838_586_676_582n
  const sinkId = `recording:${operationId}`
  const state: PersistedEncryptedUploadV2State = {
    schemaVersion: 1,
    operationId,
    serialNumber: SERIAL,
    recording: {
      uuid: RECORDING_UUID,
      generation: 9,
      storageFormat: 3,
      ciphertextLength: 330n,
      ciphertextSha256: CIPHERTEXT_SHA256.slice(),
    },
    materialId: 'material-v2-1',
    recordingId: 'cloud-recording-v2-1',
    uploadSessionId: UPLOAD_SESSION_UUID,
    ownerRevision: 3,
    policy: 'v2_required',
    transportSessionId,
    sinkId,
    windowPackets: 15,
    dataPayloadBytes: 100,
    maximumSignedBlobBytes: 1024,
    maximumMissingSequences: 15,
    checkpointIntervalBlocks: 8,
    capabilitySha256Hex: hexString(sha256(harness.core, CAPABILITY)),
    coreCheckpoint: {
      serialNumber: SERIAL,
      recordingUuid: uuidBytes(RECORDING_UUID),
      recordingGeneration: 9,
      uploadSessionId: uuidBytes(UPLOAD_SESSION_UUID),
      ownerRevision: 3,
      transportSessionId,
      checkpointRevision: 1,
      nextCiphertextOffset: 330n,
      prefixSha256: CIPHERTEXT_SHA256.slice(),
      windowPackets: 15,
      dataPayloadBytes: 100,
    },
    highestContiguousSequence: 3,
    evidence: {
      ciphertextLength: 330n,
      ciphertextSha256: CIPHERTEXT_SHA256.slice(),
      manifestLength: 580,
      manifestSha256: manifestSha256.slice(),
      blockCount: 1,
    },
  }
  await harness.storage.saveEncryptedUploadV2Checkpoint(operationId, state)
  await harness.storage.saveRecordingJournal({
    schemaVersion: 1,
    operationId,
    serialNumber: SERIAL,
    recordingUuid: RECORDING_UUID,
    profile: 'encrypted_upload_v2',
    phase: 'cloud_completed',
    sinkId,
    uploadId: state.materialId,
    cloudCompletionId: state.recordingId,
    confirmationDigestHex: hexString(sha256(harness.core, expectedReceipt)),
    devicePlaintextSha256Hex: null,
    updatedAtEpochMs: 1_700_000_000_000,
  })
  const recoveryBlob = await harness.storage.openBlob(sinkId)
  recoveryBlob.seed(ciphertext)
  let submitManifestCalls = 0
  let finalizeCalls = 0
  let cancelCalls = 0
  harness.provider.encryptedUploadV2Material = {
    ...inertMaterial(authorization, () => { cancelCalls += 1 }),
    submitManifest: async () => { submitManifestCalls += 1 },
    finalize: async () => { finalizeCalls += 1 },
    completionReceipt: async () => changedReceipt,
  }
  installRecoveryDeviceFlow(
    harness,
    transportSessionId,
    manifest,
    manifestSha256,
  )

  await assert.rejects(
    withWatchdog(harness.manager.confirm(operationId)),
    (error: unknown) =>
      error instanceof BotaSDKError && error.code === 'integrity_failed',
  )

  assert.equal(harness.provider.encryptedUploadV2Prepared.length, 1)
  assert.deepEqual(
    harness.provider.encryptedUploadV2Prepared[0]?.checkpoint,
    {
      uploadSessionId: UPLOAD_SESSION_UUID,
      ownerRevision: 3,
      checkpointRevision: 1,
      nextCiphertextOffset: 330n,
      prefixSha256: CIPHERTEXT_SHA256,
      transportSessionId,
      sinkId,
      windowPackets: 15,
      dataPayloadBytes: 100,
    },
  )
  assert.equal(submitManifestCalls, 0)
  assert.equal(finalizeCalls, 0)
  assert.equal(cancelCalls, 1)
  assert.equal(hasWriteType(harness.transport, 0x23), false)
  assert.ok(changedReceipt.every((value) => value === 0))
  assert.deepEqual(
    writeForType(harness.transport, 0x22),
    harness.core.encodeEncryptedUploadV2Transfer({
      kind: 'resume_request',
      flags: 0,
      transportSessionId,
      uploadSessionUuid: UPLOAD_SESSION_UUID,
      recordingUuid: RECORDING_UUID,
      recordingGeneration: 9,
      checkpointRevision: 1,
      nextCiphertextOffset: 330n,
      prefixSha256: CIPHERTEXT_SHA256,
      windowPackets: 15,
      dataPayloadBytes: 100,
    }),
  )
  const transferSubscribe = harness.events.findIndex((event) =>
    event.startsWith('subscribe:')
      && event.includes(RECORDING_TRANSFER_V2_CHARACTERISTIC)
  )
  assert.ok(
    transferSubscribe >= 0
      && transferSubscribe < writeEventIndex(harness.events, 0x22),
  )
  assert.equal(
    (await harness.storage.loadRecordingJournal(operationId))?.phase,
    'cloud_completed',
  )
})

test('cancellation after START aborts the v2 owner and never invokes legacy sync', async () => {
  const harness = await createHarness()
  const authorization = bytes(
    (await vector('authorization-development')).inputHex,
  )
  let cancelCalls = 0
  harness.provider.encryptedUploadV2Material = inertMaterial(
    authorization,
    () => { cancelCalls += 1 },
  )
  installStartOnlyDeviceFlow(harness)
  const operationId = 'v2-cancel-after-start'
  const sync = harness.manager.sync(recording(), {
    profile: 'encrypted_upload_v2',
    operationId,
  })
  await waitForWriteType(harness.transport, 0x20)

  await withWatchdog(harness.manager.cancel(operationId))
  await assert.rejects(withWatchdog(sync), (error: unknown) =>
    error instanceof BotaSDKError && error.code === 'cancelled'
  )

  assert.equal(cancelCalls, 1)
  assert.equal(hasWriteType(harness.transport, 0x24), true)
  assert.equal(hasWriteType(harness.transport, 0x23), false)
  assert.equal(harness.provider.prepared.length, 0)
  assert.equal(harness.storage.recordingJournals.size, 0)
  assert.equal(harness.storage.encryptedUploadV2Checkpoints.size, 0)
})

test('runtime cancellation joins a blocked signed BEGIN before owner release and zero-fill', async () => {
  const harness = await createHarness()
  const authorization = bytes(
    (await vector('authorization-development')).inputHex,
  )
  harness.provider.encryptedUploadV2Material = inertMaterial(
    authorization,
    () => undefined,
  )
  const beginEntered = deferred<void>()
  const beginGate = deferred<void>()
  harness.transport.onWrite = () => {
    const write = harness.transport.writes.at(-1)
    if (
      write?.characteristicUuid === TRANSFER_SIGNED_BLOB_V2_CHARACTERISTIC
      && write.value[0] === 0x60
    ) {
      harness.transport.writeGate = beginGate.promise
      beginEntered.resolve(undefined)
    }
  }
  const operationId = 'v2-cancel-blocked-begin'
  const sync = harness.manager.sync(recording(), {
    profile: 'encrypted_upload_v2',
    operationId,
  })
  const syncRejected = assert.rejects(sync, (error: unknown) =>
    error instanceof BotaSDKError && error.code === 'cancelled'
  )
  await beginEntered.promise

  let cancellationSettled = false
  const cancellation = harness.manager.cancel(operationId).then(() => {
    cancellationSettled = true
  })
  await settleAsyncWork()

  assert.equal(cancellationSettled, false)
  assert.ok(authorization.some((value) => value !== 0))
  await assert.rejects(
    harness.runtime.runExclusive('read_snapshot', async () => undefined),
    (error: unknown) =>
      error instanceof BotaSDKError && error.code === 'operation_in_progress',
  )

  beginGate.resolve(undefined)
  await withWatchdog(cancellation)
  await withWatchdog(syncRejected)
  assert.ok(authorization.every((value) => value === 0))
  assert.deepEqual(
    harness.transport.writes
      .filter(({ characteristicUuid }) =>
        characteristicUuid === TRANSFER_SIGNED_BLOB_V2_CHARACTERISTIC
      )
      .map(({ value }) => value[0]),
    [0x60, 0x63],
  )
})

test('resume cancellation removes v2 journal, metadata, checkpoint, and ciphertext together', async () => {
  const harness = await createHarness()
  const operationId = 'v2-resume-cancel'
  const state = persistedTransferState(harness, operationId, null)
  const journal = transferringV2Journal(operationId, state)
  await harness.storage.saveEncryptedUploadV2Checkpoint(operationId, state)
  await harness.storage.saveRecordingJournal(journal)
  const blob = await harness.storage.openBlob(state.sinkId)
  blob.seed(Uint8Array.of(1, 2, 3, 4))
  const providerEntered = deferred<void>()
  const providerResult = deferred<EncryptedUploadV2Material>()
  harness.provider.prepareEncryptedUploadV2 = async () => {
    providerEntered.resolve(undefined)
    return await providerResult.promise
  }
  const authorization = bytes(
    (await vector('authorization-development')).inputHex,
  )
  const controller = new AbortController()
  const resumed = harness.manager.resume(operationId, {
    signal: controller.signal,
  })
  const rejected = assert.rejects(resumed, (error: unknown) =>
    error instanceof BotaSDKError && error.code === 'cancelled'
  )
  await providerEntered.promise

  controller.abort()
  await withWatchdog(rejected)
  providerResult.resolve(inertMaterial(authorization, () => undefined))
  await settleAsyncWork()

  assert.equal(await harness.storage.loadRecordingJournal(operationId), null)
  assert.equal(
    await harness.storage.loadEncryptedUploadV2Checkpoint(operationId),
    null,
  )
  assert.equal(blob.snapshot().byteLength, 0)
  assert.ok(authorization.every((value) => value === 0))
})

test('inactive v2 cancellation removes the complete unconfirmed operation', async () => {
  const harness = await createHarness()
  const operationId = 'v2-inactive-cancel'
  const state = persistedTransferState(harness, operationId, null)
  const journal = transferringV2Journal(operationId, state)
  await harness.storage.saveEncryptedUploadV2Checkpoint(operationId, state)
  await harness.storage.saveRecordingJournal(journal)
  const blob = await harness.storage.openBlob(state.sinkId)
  blob.seed(Uint8Array.of(1, 2, 3, 4))

  await harness.manager.cancel(operationId)

  assert.equal(await harness.storage.loadRecordingJournal(operationId), null)
  assert.equal(
    await harness.storage.loadEncryptedUploadV2Checkpoint(operationId),
    null,
  )
  assert.equal(blob.snapshot().byteLength, 0)
})

test('ResumeRejected persists checkpoint removal before a crashing sink truncate', async () => {
  const harness = await createHarness()
  const operationId = 'v2-resume-rejected-crash'
  const ciphertext = bytes((await vector('storage-partial-block')).inputHex)
  const prefix = ciphertext.slice(0, 100)
  const checkpoint = {
    revision: 1,
    nextCiphertextOffset: 100n,
    prefixSha256: sha256(harness.core, prefix),
    highestContiguousSequence: 0,
  }
  const state = persistedTransferState(harness, operationId, checkpoint)
  const journal = transferringV2Journal(operationId, state)
  await harness.storage.saveEncryptedUploadV2Checkpoint(operationId, state)
  await harness.storage.saveRecordingJournal(journal)
  const blob = await harness.storage.openBlob(state.sinkId)
  blob.seed(ciphertext.slice(0, 120))
  const truncate = blob.truncate.bind(blob)
  blob.truncate = async (size) => {
    if (size === 0) throw new Error('simulated crash before restart truncate')
    await truncate(size)
  }
  const authorization = bytes(
    (await vector('authorization-development')).inputHex,
  )
  harness.provider.encryptedUploadV2Material = inertMaterial(
    authorization,
    () => undefined,
  )
  installResumeRejectDeviceFlow(harness, checkpoint)

  await assert.rejects(withWatchdog(harness.manager.resume(operationId)))

  const durable = harness.storage.encryptedUploadV2Checkpoints.get(operationId)
  assert.ok(durable)
  const parsed = parsePersistedEncryptedUploadV2State(durable)
  assert.equal(parsed.operationId, operationId)
  assert.equal(parsed.materialId, state.materialId)
  assert.equal(parsed.coreCheckpoint, null)
  assert.equal(parsed.highestContiguousSequence, null)
  assert.equal(
    (await harness.storage.loadRecordingJournal(operationId))?.phase,
    'transferring',
  )
  assert.equal(blob.snapshot().byteLength, 100)
})

test('ResumeRejected save failure retains the prior recoverable checkpoint pair', async () => {
  const harness = await createHarness()
  const operationId = 'v2-resume-rejected-save-failure'
  const ciphertext = bytes((await vector('storage-partial-block')).inputHex)
  const prefix = ciphertext.slice(0, 100)
  const checkpoint = {
    revision: 1,
    nextCiphertextOffset: 100n,
    prefixSha256: sha256(harness.core, prefix),
    highestContiguousSequence: 0,
  }
  const state = persistedTransferState(harness, operationId, checkpoint)
  const journal = transferringV2Journal(operationId, state)
  await harness.storage.saveEncryptedUploadV2Checkpoint(operationId, state)
  await harness.storage.saveRecordingJournal(journal)
  const blob = await harness.storage.openBlob(state.sinkId)
  blob.seed(ciphertext.slice(0, 120))
  const saveCheckpoint = harness.storage.saveEncryptedUploadV2Checkpoint
    .bind(harness.storage)
  harness.storage.saveEncryptedUploadV2Checkpoint = async (id, next) => {
    const parsed = parsePersistedEncryptedUploadV2State(next)
    if (parsed.coreCheckpoint === null) {
      throw new BrowserStorageError('storage_unavailable')
    }
    await saveCheckpoint(id, next)
  }
  const authorization = bytes(
    (await vector('authorization-development')).inputHex,
  )
  harness.provider.encryptedUploadV2Material = inertMaterial(
    authorization,
    () => undefined,
  )
  installResumeRejectDeviceFlow(harness, checkpoint)

  await assert.rejects(withWatchdog(harness.manager.resume(operationId)))

  const durable = harness.storage.encryptedUploadV2Checkpoints.get(operationId)
  assert.ok(durable)
  const parsed = parsePersistedEncryptedUploadV2State(durable)
  assert.equal(parsed.operationId, operationId)
  assert.equal(parsed.coreCheckpoint?.checkpointRevision, 1)
  assert.equal(parsed.coreCheckpoint?.nextCiphertextOffset, 100n)
  assert.equal(
    (await harness.storage.loadRecordingJournal(operationId))?.phase,
    'transferring',
  )
  assert.equal(blob.snapshot().byteLength, 100)
})

test('late staging response after cancellation cannot submit or finalize artifacts', async () => {
  const harness = await createHarness()
  const authorization = bytes(
    (await vector('authorization-development')).inputHex,
  )
  const ciphertext = bytes((await vector('storage-partial-block')).inputHex)
  const manifest = bytes((await vector('manifest-hpke')).inputHex)
  const fetchEntered = deferred<void>()
  const fetchResult = deferred<Response>()
  let submitManifestCalls = 0
  let finalizeCalls = 0
  let cancelCalls = 0
  harness.provider.encryptedUploadV2Material = {
    ...inertMaterial(authorization, () => { cancelCalls += 1 }),
    submitManifest: async () => { submitManifestCalls += 1 },
    finalize: async () => { finalizeCalls += 1 },
  }
  harness.setFetch(async () => {
    fetchEntered.resolve(undefined)
    return await fetchResult.promise
  })
  installSuccessfulDeviceFlow(
    harness,
    ciphertext,
    manifest,
    sha256(harness.core, manifest),
  )
  const operationId = 'v2-cancel-staging'
  const sync = harness.manager.sync(recording(), {
    profile: 'encrypted_upload_v2',
    operationId,
  })
  await fetchEntered.promise

  await withWatchdog(harness.manager.cancel(operationId))
  await assert.rejects(withWatchdog(sync), (error: unknown) =>
    error instanceof BotaSDKError && error.code === 'cancelled'
  )
  fetchResult.resolve(new Response(null, { status: 200 }))
  await settleAsyncWork()

  assert.equal(submitManifestCalls, 0)
  assert.equal(finalizeCalls, 0)
  assert.equal(cancelCalls, 1)
  assert.equal(hasWriteType(harness.transport, 0x23), false)
})

test('cancellation during CONFIRM waits for its exact success and never sends ABORT', async () => {
  const harness = await createHarness()
  const authorization = bytes(
    (await vector('authorization-development')).inputHex,
  )
  const ciphertext = bytes((await vector('storage-partial-block')).inputHex)
  const manifest = bytes((await vector('manifest-hpke')).inputHex)
  let cancelCalls = 0
  harness.provider.encryptedUploadV2Material = inertMaterial(
    authorization,
    () => { cancelCalls += 1 },
  )
  harness.setFetch(async () => new Response(null, { status: 200 }))
  installSuccessfulDeviceFlow(
    harness,
    ciphertext,
    manifest,
    sha256(harness.core, manifest),
  )
  const confirmEntered = deferred<void>()
  const releaseConfirm = deferred<void>()
  const deviceWrite = harness.transport.onWrite
  harness.transport.onWrite = () => {
    deviceWrite?.()
    if (harness.transport.writes.at(-1)?.value[0] === 0x23) {
      harness.transport.writeGate = releaseConfirm.promise
      confirmEntered.resolve(undefined)
    }
  }
  const operationId = 'v2-cancel-confirm'
  const sync = harness.manager.sync(recording(), {
    profile: 'encrypted_upload_v2',
    operationId,
  })
  await confirmEntered.promise

  const cancellation = harness.manager.cancel(operationId)
  await settleAsyncWork()
  assert.equal(hasWriteType(harness.transport, 0x24), false)
  releaseConfirm.resolve(undefined)

  assert.deepEqual(await withWatchdog(sync), {
    operationId,
    recordingUuid: RECORDING_UUID,
    profile: 'encrypted_upload_v2',
    cloudCompletionId: 'cloud-recording-v2-1',
  })
  await withWatchdog(cancellation)
  assert.equal(cancelCalls, 0)
  assert.equal(hasWriteType(harness.transport, 0x24), false)
})

interface Harness {
  core: CoreBridge
  devices: DeviceManager
  events: string[]
  manager: RecordingManager
  provider: FakeRecordingUploadProvider
  runtime: BrowserWorkflowRuntime
  storage: FakeRecordingStorage
  transport: FakeBrowserBluetoothTransport
  setFetch(
    fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  ): void
}

async function createHarness(): Promise<Harness> {
  const events: string[] = []
  const core = await createWasmCore(await wasmBytes)
  const transport = new FakeBrowserBluetoothTransport()
  transport.eventLog = events
  transport.setRead(
    BOTA_STORAGE_SERVICE,
    ENCRYPTED_UPLOAD_V2_CAPABILITY_CHARACTERISTIC,
    CAPABILITY,
  )
  const storage = new FakeRecordingStorage(undefined, events)
  const provider = new FakeRecordingUploadProvider(events)
  const runtime = new BrowserWorkflowRuntime(core, transport)
  const devices = new DeviceManager(core, transport, { runtime, storage })
  let fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> =
    async () => new Response(null, { status: 200 })
  const manager = new RecordingManager(
    core,
    transport,
    runtime,
    devices,
    storage,
    provider,
    async (input, init) => await fetcher(input, init),
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
    setFetch(value) {
      fetcher = value
    },
  }
}

function installSuccessfulDeviceFlow(
  harness: Harness,
  ciphertext: Uint8Array,
  manifest: Uint8Array,
  manifestSha256: Uint8Array,
): void {
  let transportSessionId = 0n
  harness.transport.onWrite = () => {
    const write = harness.transport.writes.at(-1)
    if (!write) return
    const type = write.value[0]
    if (
      write.characteristicUuid === TRANSFER_SIGNED_BLOB_V2_CHARACTERISTIC
      && type === 0x62
    ) {
      queueMicrotask(() => emitTransfer(
        harness.transport,
        TRANSFER_SIGNED_BLOB_V2_CHARACTERISTIC,
        signedResult(write.value),
      ))
      return
    }
    if (
      write.characteristicUuid === TRANSFER_CONTROL_V2_CHARACTERISTIC
      && type === 0x20
    ) {
      transportSessionId = new DataView(
        write.value.buffer,
        write.value.byteOffset,
        write.value.byteLength,
      ).getBigUint64(4, true)
      queueMicrotask(() => {
        emitTransfer(
          harness.transport,
          RECORDING_TRANSFER_V2_CHARACTERISTIC,
          startAcknowledgement(transportSessionId),
        )
        const chunks = [
          ciphertext.slice(0, 100),
          ciphertext.slice(100, 200),
          ciphertext.slice(200, 300),
          ciphertext.slice(300),
        ]
        let offset = 0
        chunks.forEach((chunk, sequence) => {
          emitTransfer(
            harness.transport,
            RECORDING_TRANSFER_V2_CHARACTERISTIC,
            dataFrame(transportSessionId, sequence, offset, chunk),
          )
          offset += chunk.byteLength
        })
        emitTransfer(
          harness.transport,
          RECORDING_TRANSFER_V2_CHARACTERISTIC,
          windowEnd(
            transportSessionId,
            0,
            0,
            3,
            ciphertext.byteLength,
            CIPHERTEXT_SHA256,
            1,
          ),
        )
      })
      return
    }
    if (
      write.characteristicUuid === TRANSFER_CONTROL_V2_CHARACTERISTIC
      && type === 0x21
    ) {
      queueMicrotask(() => {
        for (let offset = 0; offset < manifest.byteLength; offset += 76) {
          emitTransfer(
            harness.transport,
            RECORDING_TRANSFER_V2_CHARACTERISTIC,
            manifestChunk(
              transportSessionId,
              offset,
              manifest.slice(offset, offset + 76),
              manifestSha256,
            ),
          )
        }
        emitTransfer(
          harness.transport,
          RECORDING_TRANSFER_V2_CHARACTERISTIC,
          eof(
            transportSessionId,
            3,
            1,
            CIPHERTEXT_SHA256,
            manifestSha256,
          ),
        )
      })
    }
  }
}

function installRecoveryDeviceFlow(
  harness: Harness,
  expectedTransportSessionId: bigint,
  manifest: Uint8Array,
  manifestSha256: Uint8Array,
): void {
  harness.transport.onWrite = () => {
    const write = harness.transport.writes.at(-1)
    if (!write) return
    const type = write.value[0]
    if (
      write.characteristicUuid === TRANSFER_SIGNED_BLOB_V2_CHARACTERISTIC
      && type === 0x62
    ) {
      queueMicrotask(() => emitTransfer(
        harness.transport,
        TRANSFER_SIGNED_BLOB_V2_CHARACTERISTIC,
        signedResult(write.value),
      ))
      return
    }
    if (
      write.characteristicUuid === TRANSFER_CONTROL_V2_CHARACTERISTIC
      && type === 0x22
    ) {
      const transportSessionId = new DataView(
        write.value.buffer,
        write.value.byteOffset,
        write.value.byteLength,
      ).getBigUint64(4, true)
      assert.equal(transportSessionId, expectedTransportSessionId)
      queueMicrotask(() => {
        emitTransfer(
          harness.transport,
          RECORDING_TRANSFER_V2_CHARACTERISTIC,
          resumeAcknowledgement(transportSessionId),
        )
        for (let offset = 0; offset < manifest.byteLength; offset += 76) {
          emitTransfer(
            harness.transport,
            RECORDING_TRANSFER_V2_CHARACTERISTIC,
            manifestChunk(
              transportSessionId,
              offset,
              manifest.slice(offset, offset + 76),
              manifestSha256,
            ),
          )
        }
        emitTransfer(
          harness.transport,
          RECORDING_TRANSFER_V2_CHARACTERISTIC,
          eof(
            transportSessionId,
            3,
            1,
            CIPHERTEXT_SHA256,
            manifestSha256,
          ),
        )
      })
    }
  }
}

function installStartOnlyDeviceFlow(harness: Harness): void {
  let transportSessionId = 0n
  harness.transport.onWrite = () => {
    const write = harness.transport.writes.at(-1)
    if (!write) return
    const type = write.value[0]
    if (
      write.characteristicUuid === TRANSFER_SIGNED_BLOB_V2_CHARACTERISTIC
      && type === 0x62
    ) {
      queueMicrotask(() => emitTransfer(
        harness.transport,
        TRANSFER_SIGNED_BLOB_V2_CHARACTERISTIC,
        signedResult(write.value),
      ))
      return
    }
    if (
      write.characteristicUuid === TRANSFER_CONTROL_V2_CHARACTERISTIC
      && type === 0x20
    ) {
      transportSessionId = new DataView(
        write.value.buffer,
        write.value.byteOffset,
        write.value.byteLength,
      ).getBigUint64(4, true)
      queueMicrotask(() => emitTransfer(
        harness.transport,
        RECORDING_TRANSFER_V2_CHARACTERISTIC,
        startAcknowledgement(transportSessionId),
      ))
    }
  }
}

function installResumeRejectDeviceFlow(
  harness: Harness,
  checkpoint: {
    revision: number
    nextCiphertextOffset: bigint
    prefixSha256: Uint8Array
  },
): void {
  harness.transport.onWrite = () => {
    const write = harness.transport.writes.at(-1)
    if (!write) return
    const type = write.value[0]
    if (
      write.characteristicUuid === TRANSFER_SIGNED_BLOB_V2_CHARACTERISTIC
      && type === 0x62
    ) {
      queueMicrotask(() => emitTransfer(
        harness.transport,
        TRANSFER_SIGNED_BLOB_V2_CHARACTERISTIC,
        signedResult(write.value),
      ))
      return
    }
    if (
      write.characteristicUuid === TRANSFER_CONTROL_V2_CHARACTERISTIC
      && type === 0x22
    ) {
      const transportSessionId = new DataView(
        write.value.buffer,
        write.value.byteOffset,
        write.value.byteLength,
      ).getBigUint64(4, true)
      const rejected = commonFrame(0x46, 60, transportSessionId)
      u16(rejected, 12, 15)
      u32(rejected, 16, checkpoint.revision)
      u64(rejected, 20, checkpoint.nextCiphertextOffset)
      rejected.set(checkpoint.prefixSha256, 28)
      queueMicrotask(() => emitTransfer(
        harness.transport,
        RECORDING_TRANSFER_V2_CHARACTERISTIC,
        rejected,
      ))
    }
  }
}

function recording(): DeviceRecording {
  return {
    uuid: RECORDING_UUID,
    startedAtTimestampSeconds: 1,
    durationMilliseconds: 37_000n,
    fileSizeBytes: 38n,
    codec: 'unknown',
    encrypted: true,
    encryptedUploadV2: {
      generation: 9,
      storageFormat: 3,
      plaintextLength: 38n,
      ciphertextLength: 330n,
      ciphertextSha256: CIPHERTEXT_SHA256.slice(),
    },
  }
}

function persistedTransferState(
  harness: Harness,
  operationId: string,
  checkpoint: {
    revision: number
    nextCiphertextOffset: bigint
    prefixSha256: Uint8Array
    highestContiguousSequence: number
  } | null,
): PersistedEncryptedUploadV2State {
  const transportSessionId = 18_838_586_676_582n
  return {
    schemaVersion: 1,
    operationId,
    serialNumber: SERIAL,
    recording: {
      uuid: RECORDING_UUID,
      generation: 9,
      storageFormat: 3,
      ciphertextLength: 330n,
      ciphertextSha256: CIPHERTEXT_SHA256.slice(),
    },
    materialId: 'material-v2-1',
    recordingId: 'cloud-recording-v2-1',
    uploadSessionId: UPLOAD_SESSION_UUID,
    ownerRevision: 3,
    policy: 'v2_required',
    transportSessionId,
    sinkId: `recording:${operationId}`,
    windowPackets: 15,
    dataPayloadBytes: 100,
    maximumSignedBlobBytes: 1024,
    maximumMissingSequences: 15,
    checkpointIntervalBlocks: 8,
    capabilitySha256Hex: hexString(sha256(harness.core, CAPABILITY)),
    coreCheckpoint: checkpoint
      ? {
          serialNumber: SERIAL,
          recordingUuid: uuidBytes(RECORDING_UUID),
          recordingGeneration: 9,
          uploadSessionId: uuidBytes(UPLOAD_SESSION_UUID),
          ownerRevision: 3,
          transportSessionId,
          checkpointRevision: checkpoint.revision,
          nextCiphertextOffset: checkpoint.nextCiphertextOffset,
          prefixSha256: checkpoint.prefixSha256.slice(),
          windowPackets: 15,
          dataPayloadBytes: 100,
        }
      : null,
    highestContiguousSequence: checkpoint?.highestContiguousSequence ?? null,
    evidence: null,
  }
}

function transferringV2Journal(
  operationId: string,
  state: PersistedEncryptedUploadV2State,
): RecordingJournal {
  return {
    schemaVersion: 1,
    operationId,
    serialNumber: state.serialNumber,
    recordingUuid: state.recording.uuid,
    profile: 'encrypted_upload_v2',
    phase: 'transferring',
    sinkId: state.sinkId,
    uploadId: null,
    cloudCompletionId: null,
    confirmationDigestHex: null,
    devicePlaintextSha256Hex: null,
    updatedAtEpochMs: 1_700_000_000_000,
  }
}

function startAcknowledgement(transportSessionId: bigint): Uint8Array {
  const frame = commonFrame(0x40, 140, transportSessionId)
  frame.set(uuidBytes(UPLOAD_SESSION_UUID), 12)
  frame.set(uuidBytes(RECORDING_UUID), 28)
  u32(frame, 44, 9)
  u64(frame, 48, 330n)
  frame.set(CIPHERTEXT_SHA256, 56)
  u16(frame, 88, 15)
  u16(frame, 90, 100)
  u32(frame, 92, 8)
  u32(frame, 96, 0)
  u64(frame, 100, 0n)
  frame.set(EMPTY_SHA256, 108)
  return frame
}

function resumeAcknowledgement(transportSessionId: bigint): Uint8Array {
  const frame = commonFrame(0x45, 96, transportSessionId)
  frame.set(uuidBytes(UPLOAD_SESSION_UUID), 12)
  frame.set(uuidBytes(RECORDING_UUID), 28)
  u32(frame, 44, 9)
  u32(frame, 48, 1)
  u64(frame, 52, 330n)
  frame.set(CIPHERTEXT_SHA256, 60)
  u16(frame, 92, 15)
  u16(frame, 94, 100)
  return frame
}

function dataFrame(
  transportSessionId: bigint,
  sequence: number,
  offset: number,
  data: Uint8Array,
): Uint8Array {
  const frame = commonFrame(0x41, 28 + data.byteLength, transportSessionId)
  u32(frame, 12, sequence)
  u64(frame, 16, BigInt(offset))
  u32(frame, 24, data.byteLength)
  frame.set(data, 28)
  return frame
}

function windowEnd(
  transportSessionId: bigint,
  windowIndex: number,
  firstSequence: number,
  lastSequence: number,
  nextOffset: number,
  prefixSha256: Uint8Array,
  revision: number,
): Uint8Array {
  const frame = commonFrame(0x42, 68, transportSessionId)
  u32(frame, 12, windowIndex)
  u32(frame, 16, firstSequence)
  u32(frame, 20, lastSequence)
  u64(frame, 24, BigInt(nextOffset))
  frame.set(prefixSha256, 32)
  u32(frame, 64, revision)
  return frame
}

function manifestChunk(
  transportSessionId: bigint,
  offset: number,
  chunk: Uint8Array,
  digest: Uint8Array,
): Uint8Array {
  const frame = commonFrame(0x43, 52 + chunk.byteLength, transportSessionId)
  u16(frame, 12, 580)
  u16(frame, 14, offset)
  u16(frame, 16, chunk.byteLength)
  frame.set(digest, 20)
  frame.set(chunk, 52)
  return frame
}

function eof(
  transportSessionId: bigint,
  finalSequence: number,
  blockCount: number,
  ciphertextSha256: Uint8Array,
  manifestSha256: Uint8Array,
): Uint8Array {
  const frame = commonFrame(0x44, 92, transportSessionId)
  u32(frame, 12, finalSequence)
  u32(frame, 16, blockCount)
  u64(frame, 20, 330n)
  frame.set(ciphertextSha256, 28)
  frame.set(manifestSha256, 60)
  return frame
}

function commonFrame(
  type: number,
  length: number,
  transportSessionId: bigint,
): Uint8Array {
  const frame = new Uint8Array(length)
  frame[0] = type
  frame[1] = 2
  u64(frame, 4, transportSessionId)
  return frame
}

function signedResult(commit: Uint8Array): Uint8Array {
  return Uint8Array.of(
    0x64,
    0x02,
    commit[2] ?? 0,
    0,
    commit[4] ?? 0,
    commit[5] ?? 0,
    commit[6] ?? 0,
    commit[7] ?? 0,
    0,
    0,
  )
}

function emitTransfer(
  transport: FakeBrowserBluetoothTransport,
  characteristic: string,
  frame: Uint8Array,
): void {
  transport.emitNotification(
    transport.device,
    BOTA_STORAGE_SERVICE,
    characteristic,
    frame,
  )
}

function u16(target: Uint8Array, offset: number, value: number): void {
  new DataView(target.buffer).setUint16(offset, value, true)
}

function u32(target: Uint8Array, offset: number, value: number): void {
  new DataView(target.buffer).setUint32(offset, value, true)
}

function u64(target: Uint8Array, offset: number, value: bigint): void {
  new DataView(target.buffer).setBigUint64(offset, value, true)
}

function uuidBytes(value: string): Uint8Array {
  return bytes(value.replaceAll('-', ''))
}

function copyEvidence(evidence: EncryptedUploadV2Evidence): EncryptedUploadV2Evidence {
  return {
    ...evidence,
    ciphertextSha256: evidence.ciphertextSha256.slice(),
    manifestSha256: evidence.manifestSha256.slice(),
  }
}

function inertMaterial(
  authorization: Uint8Array,
  cancel: () => void,
): EncryptedUploadV2Material {
  return {
    materialId: 'material-v2-1',
    recordingId: 'cloud-recording-v2-1',
    uploadSessionId: UPLOAD_SESSION_UUID,
    ownerRevision: 3,
    policy: 'v2_required',
    authorization,
    stagingRequest: async () => ({
      method: 'PUT',
      url: 'https://upload-secret.example.invalid/v2',
      headers: {},
    }),
    submitManifest: async () => undefined,
    finalize: async () => undefined,
    completionReceipt: async () => new Uint8Array(336),
    cancel: async () => cancel(),
  }
}

function sha256(core: CoreBridge, value: Uint8Array): Uint8Array {
  const hasher = core.createIntegrityHasher()
  hasher.update(value)
  return hasher.sha256Snapshot()
}

function capabilityReadCount(transport: FakeBrowserBluetoothTransport): number {
  return transport.calls.filter((call) =>
    call.includes(ENCRYPTED_UPLOAD_V2_CAPABILITY_CHARACTERISTIC)
  ).length
}

function listFrames(
  core: CoreBridge,
  canonicalEntry: Uint8Array,
  canonicalEnd: Uint8Array,
  transportSessionId: bigint,
): { entry: Uint8Array; end: Uint8Array } {
  const entry = canonicalEntry.slice()
  const end = canonicalEnd.slice()
  u64(entry, 4, transportSessionId)
  u64(entry, 36, 1n)
  u64(end, 4, transportSessionId)
  end.set(sha256(core, entry.slice(12)), 20)
  return { entry, end }
}

function latestSession(
  transport: FakeBrowserBluetoothTransport,
  type: number,
): bigint {
  const write = [...transport.writes].reverse().find(({ value }) =>
    value[0] === type
  )
  assert.ok(write)
  return new DataView(
    write.value.buffer,
    write.value.byteOffset,
    write.value.byteLength,
  ).getBigUint64(4, true)
}

async function waitForWriteType(
  transport: FakeBrowserBluetoothTransport,
  type: number,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (transport.writes.some(({ value }) => value[0] === type)) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  assert.fail(`timed out waiting for write type ${type}`)
}

async function waitForAnyWrite(
  transport: FakeBrowserBluetoothTransport,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (transport.writes.length > 0) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  assert.fail('timed out waiting for a write')
}

async function waitForEvent(events: string[], expected: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (events.includes(expected)) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  assert.fail(`timed out waiting for event ${expected}`)
}

async function withWatchdog<T>(promise: Promise<T>): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('test watchdog expired')), 500)
    }),
  ])
}

async function settleAsyncWork(): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function hasWriteType(
  transport: FakeBrowserBluetoothTransport,
  type: number,
): boolean {
  return transport.writes.some(({ value }) => value[0] === type)
}

function writeForType(
  transport: FakeBrowserBluetoothTransport,
  type: number,
): Uint8Array {
  const write = transport.writes.find(({ value }) => value[0] === type)
  assert.ok(write, `missing write type ${type.toString(16)}`)
  return write.value
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

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && left.every((value, index) => value === right[index])
}

function hexString(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function indexOf(values: string[], value: string): number {
  const index = values.indexOf(value)
  assert.ok(index >= 0, `missing event ${value}`)
  return index
}

function writeEventIndex(events: string[], type: number): number {
  const prefix = type.toString(16).padStart(2, '0')
  const index = events.findIndex((event) =>
    event.startsWith('write:') && event.split(':').at(-1)?.startsWith(prefix)
  )
  assert.ok(index >= 0, `missing write type ${prefix}`)
  return index
}
