import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  IDBDatabase as FakeIDBDatabase,
  IDBFactory as FakeIDBFactory,
  IDBKeyRange as FakeIDBKeyRange,
} from 'fake-indexeddb'

import type { CoreBridge } from '../core.ts'
import {
  BrowserStorageError,
  createDefaultBrowserStorage,
  type BrowserSdkStorage,
  type FirmwareJournal,
  type ProvisioningJournal,
  type RecordingJournal,
  type VerifiedDeviceHint,
} from '../storage.ts'
import { createWasmCore } from '../wasmCore.ts'
import { FakeOpfs } from './fakeOpfs.ts'

const wasm = readFile(
  new URL('../generated/bota_device_sdk_core_bg.wasm', import.meta.url),
)
const core = wasm.then(async (bytes) => await createWasmCore(bytes))

const FIXED_MESSAGES = {
  invalid_input: 'The storage operation contains invalid input.',
  resume_rejected: 'Persisted workflow state is incompatible.',
  storage_quota_exceeded: 'Durable browser storage quota was exceeded.',
  storage_unavailable: 'Durable browser storage is unavailable.',
} as const

interface StorageFixture {
  indexedDB: IDBFactory
  opfs: FakeOpfs
  open(namespace: string): Promise<BrowserSdkStorage>
}

async function storageFixture(): Promise<StorageFixture> {
  const indexedDB = new FakeIDBFactory()
  const opfs = new FakeOpfs()
  const bridge = await core
  return {
    indexedDB,
    opfs,
    open: async (namespace) => await createDefaultBrowserStorage(namespace, {
      indexedDB,
      keyRange: FakeIDBKeyRange,
      opfsRoot: opfs.root,
      createIntegrityHasher: () => bridge.createIntegrityHasher(),
    }),
  }
}

function recordingJournal(
  operationId: string,
  phase: RecordingJournal['phase'] = 'prepared',
): RecordingJournal {
  return {
    schemaVersion: 1,
    operationId,
    serialNumber: 'EVFXXW67KP',
    recordingUuid: '22222222-2222-2222-2222-222222222222',
    profile: 'legacy',
    phase,
    sinkId: `sink-${operationId}`,
    uploadId: null,
    cloudCompletionId: null,
    confirmationDigestHex: null,
    updatedAtEpochMs: 1_789_000_000_000,
  }
}

function verifiedDevice(): VerifiedDeviceHint {
  return {
    schemaVersion: 1,
    serialNumber: 'EVFXXW67KP',
    browserDeviceId: 'browser-device-1',
    name: 'Bota Pin',
    updatedAtEpochMs: 1_789_000_000_000,
  }
}

function provisioningJournal(): ProvisioningJournal {
  return {
    schemaVersion: 1,
    attemptId: 'provisioning-attempt-1',
    serialNumber: 'EVFXXW67KP',
    phase: 'prepared',
    updatedAtEpochMs: 1_789_000_000_000,
  }
}

function firmwareJournal(): FirmwareJournal {
  return {
    schemaVersion: 1,
    operationId: 'firmware-operation-1',
    serialNumber: 'EVFXXW67KP',
    imageId: 'firmware-image-1',
    downloadId: 9_007_199_254_740_993n,
    version: '1.0.18',
    sizeBytes: 5,
    crc32: 0x1234_5678,
    sha256Hex: '11'.repeat(32),
    blobId: 'firmware-blob-1',
    downloadedBytes: 5,
    verified: true,
    updatedAtEpochMs: 1_789_000_000_000,
  }
}

async function expectStorageError(
  action: Promise<unknown>,
  code: keyof typeof FIXED_MESSAGES,
): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.equal(error instanceof BrowserStorageError, true)
    assert.equal((error as BrowserStorageError).code, code)
    assert.equal((error as Error).message, FIXED_MESSAGES[code])
    assert.equal(String(error).includes('private quota detail'), false)
    return true
  })
}

test('storage namespaces reject empty, whitespace-only, and overlong values', async () => {
  const fixture = await storageFixture()

  for (const namespace of ['', ' \t\n ', 'x'.repeat(257)]) {
    await expectStorageError(fixture.open(namespace), 'invalid_input')
  }

  const maximum = await fixture.open('x'.repeat(256))
  assert.equal(maximum.namespace, 'x'.repeat(256))
})

test('missing IndexedDB or OPFS maps to fixed storage_unavailable errors', async () => {
  const bridge = await core
  const dependencies = {
    keyRange: FakeIDBKeyRange,
    createIntegrityHasher: () => bridge.createIntegrityHasher(),
  }

  await expectStorageError(
    createDefaultBrowserStorage('tenant', {
      ...dependencies,
      indexedDB: null,
      opfsRoot: new FakeOpfs().root,
    }),
    'storage_unavailable',
  )
  await expectStorageError(
    createDefaultBrowserStorage('tenant', {
      ...dependencies,
      indexedDB: new FakeIDBFactory(),
      opfsRoot: null,
    }),
    'storage_unavailable',
  )
})

test('tenant namespaces cannot enumerate or open each other records and blobs', async () => {
  const fixture = await storageFixture()
  const alpha = await fixture.open('organization-a:project:user')
  const beta = await fixture.open('organization-b:project:user')

  await alpha.saveRecordingJournal(recordingJournal('alpha-operation'))
  await beta.saveRecordingJournal(recordingJournal('beta-operation'))

  assert.deepEqual(
    (await alpha.listRecordingJournals()).map(({ operationId }) => operationId),
    ['alpha-operation'],
  )
  assert.deepEqual(
    (await beta.listRecordingJournals()).map(({ operationId }) => operationId),
    ['beta-operation'],
  )
  assert.equal(await beta.loadRecordingJournal('alpha-operation'), null)

  const alphaBlob = await alpha.openBlob('shared-logical-blob')
  const betaBlob = await beta.openBlob('shared-logical-blob')
  await alphaBlob.write(0, Uint8Array.of(1, 2, 3))
  assert.equal(await alphaBlob.size(), 3)
  assert.equal(await betaBlob.size(), 0)
  assert.deepEqual(await betaBlob.read(0, 8), new Uint8Array())
})

test('checkpoint saves acknowledge only after their IndexedDB transaction completes', async () => {
  const original = FakeIDBDatabase.prototype.transaction
  let transactionCompleted = false
  Object.defineProperty(FakeIDBDatabase.prototype, 'transaction', {
    configurable: true,
    value: function transaction(
      this: IDBDatabase,
      storeNames: string | string[],
      mode?: IDBTransactionMode,
      options?: IDBTransactionOptions,
    ): IDBTransaction {
      const result = original.call(this, storeNames, mode, options)
      if (mode === 'readwrite') {
        result.addEventListener('complete', () => {
          transactionCompleted = true
        })
      }
      return result
    },
  })

  try {
    const storage = await (await storageFixture()).open('transaction-tenant')
    let resolvedBeforeCompletion = false
    await storage.saveWorkflowCheckpoint('operation-1', { phase: 'transferring' })
      .then(() => {
        resolvedBeforeCompletion = !transactionCompleted
      })

    assert.equal(resolvedBeforeCompletion, false)
    assert.equal(transactionCompleted, true)
  } finally {
    Object.defineProperty(FakeIDBDatabase.prototype, 'transaction', {
      configurable: true,
      value: original,
    })
  }
})

test('recording journals follow only the exact monotonic phase state machine', async () => {
  const storage = await (await storageFixture()).open('phase-tenant')
  const prepared = recordingJournal('recording-operation')

  await storage.saveRecordingJournal(prepared)
  await storage.saveRecordingJournal({ ...prepared, phase: 'transferring' })
  await storage.saveRecordingJournal({ ...prepared, phase: 'transferring' })

  await expectStorageError(
    storage.saveRecordingJournal({ ...prepared, phase: 'prepared' }),
    'resume_rejected',
  )
  await expectStorageError(
    storage.saveRecordingJournal({ ...prepared, phase: 'uploading' }),
    'resume_rejected',
  )
})

test('unknown durable-record schema versions fail closed as resume_rejected', async () => {
  const fixture = await storageFixture()
  const storage = await fixture.open('schema-tenant')
  const unknown = {
    ...recordingJournal('future-operation'),
    schemaVersion: 2,
  } as unknown as RecordingJournal

  await expectStorageError(
    storage.saveRecordingJournal(unknown),
    'resume_rejected',
  )
  await expectStorageError(
    storage.saveVerifiedDevice({ ...verifiedDevice(), schemaVersion: 2 } as unknown as VerifiedDeviceHint),
    'resume_rejected',
  )

  const persisted = recordingJournal('persisted-future-operation')
  await storage.saveRecordingJournal(persisted)
  await replaceFirstRecord(
    fixture.indexedDB,
    'recording_journals',
    (value) => ({ ...recordValue(value), schemaVersion: 2 }),
  )
  await expectStorageError(
    storage.loadRecordingJournal(persisted.operationId),
    'resume_rejected',
  )
})

test('verified-device hints preserve an empty browser display name', async () => {
  const storage = await (await storageFixture()).open('empty-name-tenant')
  const hint = { ...verifiedDevice(), name: '' }

  await storage.saveVerifiedDevice(hint)

  assert.deepEqual(await storage.loadVerifiedDevice(hint.serialNumber), hint)
})

test('concurrent firmware saves cannot replace newer durable progress', async () => {
  const storage = await (await storageFixture()).open('firmware-progress-tenant')
  const initial = { ...firmwareJournal(), downloadedBytes: 1, verified: false }
  await storage.saveFirmwareJournal(initial)

  const results = await Promise.allSettled([
    storage.saveFirmwareJournal({ ...initial, downloadedBytes: 5 }),
    storage.saveFirmwareJournal({ ...initial, downloadedBytes: 3 }),
  ])

  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1)
  assert.equal(results.filter(({ status }) => status === 'rejected').length, 1)
  assert.deepEqual(
    await storage.loadFirmwareJournal(initial.operationId),
    { ...initial, downloadedBytes: 5 },
  )
})

test('OPFS appends are offset-exact and reads, streams, truncation, and delete are bounded', async () => {
  const storage = await (await storageFixture()).open('blob-tenant')
  const blob = await storage.openBlob('recording-body')

  await blob.write(0, Uint8Array.of(1, 2, 3))
  await blob.write(3, Uint8Array.of(4, 5))
  await expectStorageError(blob.write(4, Uint8Array.of(9)), 'resume_rejected')

  assert.deepEqual(await blob.read(1, 2), Uint8Array.of(2, 3))
  assert.deepEqual(await blob.read(5, 100), new Uint8Array())
  const chunks: Uint8Array[] = []
  for await (const chunk of blob.stream(2)) chunks.push(chunk)
  assert.deepEqual(
    chunks,
    [Uint8Array.of(1, 2), Uint8Array.of(3, 4), Uint8Array.of(5)],
  )

  await blob.truncate(3)
  assert.equal(await blob.size(), 3)
  assert.deepEqual(await blob.read(0, 100), Uint8Array.of(1, 2, 3))

  await expectStorageError(blob.read(-1, 1), 'invalid_input')
  await expectStorageError(blob.read(0, Number.MAX_SAFE_INTEGER + 1), 'invalid_input')
  await expectStorageError(blob.truncate(4), 'resume_rejected')

  await blob.delete()
  await blob.delete()
})

test('quota failure preserves the existing checkpoint and committed blob prefix', async () => {
  const fixture = await storageFixture()
  const storage = await fixture.open('quota-tenant')
  const checkpoint = { phase: 'transferring', completedUnits: 3n }
  const blob = await storage.openBlob('quota-body')

  await storage.saveWorkflowCheckpoint('quota-operation', checkpoint)
  await blob.write(0, Uint8Array.of(1, 2, 3))
  fixture.opfs.failNextWriteWithQuota()

  await expectStorageError(
    blob.write(3, Uint8Array.of(4)),
    'storage_quota_exceeded',
  )
  assert.deepEqual(
    await storage.loadWorkflowCheckpoint('quota-operation'),
    checkpoint,
  )
  assert.deepEqual(await blob.read(0, 8), Uint8Array.of(1, 2, 3))
})

test('clear removes only the current namespace and performs no device work', async () => {
  const fixture = await storageFixture()
  const alpha = await fixture.open('clear-alpha')
  const beta = await fixture.open('clear-beta')
  let deviceConfirmations = 0
  const originalBluetooth = Reflect.get(globalThis.navigator, 'bluetooth')
  Object.defineProperty(globalThis.navigator, 'bluetooth', {
    configurable: true,
    value: {
      requestDevice: async () => {
        deviceConfirmations += 1
        throw new Error('device access is forbidden during clear')
      },
    },
  })

  try {
    await alpha.saveRecordingJournal(recordingJournal('alpha-clear'))
    await beta.saveRecordingJournal(recordingJournal('beta-keep'))
    await (await alpha.openBlob('alpha-body')).write(0, Uint8Array.of(1))
    await (await beta.openBlob('beta-body')).write(0, Uint8Array.of(2))

    await alpha.clear()

    assert.deepEqual(await alpha.listRecordingJournals(), [])
    assert.equal(await (await alpha.openBlob('alpha-body')).size(), 0)
    assert.deepEqual(
      (await beta.listRecordingJournals()).map(({ operationId }) => operationId),
      ['beta-keep'],
    )
    assert.deepEqual(
      await (await beta.openBlob('beta-body')).read(0, 8),
      Uint8Array.of(2),
    )
    assert.equal(deviceConfirmations, 0)
  } finally {
    Object.defineProperty(globalThis.navigator, 'bluetooth', {
      configurable: true,
      value: originalBluetooth,
    })
  }
})

test('reopening recovers every durable record and blob size without secret path names', async () => {
  const fixture = await storageFixture()
  const namespace = 'raw-tenant-name:project:user'
  const storage = await fixture.open(namespace)
  const hint = verifiedDevice()
  const recording = recordingJournal('recording-operation-1')
  const provisioning = provisioningJournal()
  const firmware = firmwareJournal()
  const workflowCheckpoint = {
    phase: 'transferring',
    completedUnits: 4n,
    digest: Uint8Array.of(1, 2, 3),
  }
  const encryptedCheckpoint = {
    checkpointRevision: 7,
    nextCiphertextOffset: 4n,
    prefixSha256: Uint8Array.of(4, 5, 6),
  }
  const blobId = 'raw-blob-name-that-must-not-be-a-path'

  await storage.saveVerifiedDevice(hint)
  await storage.saveWorkflowCheckpoint('workflow-operation-1', workflowCheckpoint)
  await storage.saveEncryptedUploadV2Checkpoint(
    'encrypted-operation-1',
    encryptedCheckpoint,
  )
  await storage.saveRecordingJournal(recording)
  await storage.saveProvisioningJournal(provisioning)
  await storage.saveFirmwareJournal(firmware)
  await (await storage.openBlob(blobId)).write(0, Uint8Array.of(1, 2, 3, 4))

  const reopened = await fixture.open(namespace)
  assert.deepEqual(await reopened.loadVerifiedDevice(hint.serialNumber), hint)
  assert.deepEqual(
    await reopened.loadWorkflowCheckpoint('workflow-operation-1'),
    workflowCheckpoint,
  )
  assert.deepEqual(
    await reopened.loadEncryptedUploadV2Checkpoint('encrypted-operation-1'),
    encryptedCheckpoint,
  )
  assert.deepEqual(await reopened.loadRecordingJournal(recording.operationId), recording)
  assert.deepEqual(
    await reopened.loadProvisioningJournal(provisioning.attemptId),
    provisioning,
  )
  assert.deepEqual(await reopened.loadFirmwareJournal(firmware.operationId), firmware)
  assert.equal(await (await reopened.openBlob(blobId)).size(), 4)

  const paths = fixture.opfs.paths()
  assert.equal(paths.some((path) => path.includes(namespace)), false)
  assert.equal(paths.some((path) => path.includes(blobId)), false)
  assert.equal(
    paths.some((path) => /^bota-app-sdk\/v1\/[0-9a-f]{64}\/[0-9a-f]{64}$/.test(path)),
    true,
  )
  const keys = await allIndexedDbKeys(fixture.indexedDB)
  assert.equal(keys.some((key) => key.includes(namespace)), false)
  assert.equal(keys.some((key) => key.includes('workflow-operation-1')), false)
})

async function allIndexedDbKeys(indexedDB: IDBFactory): Promise<string[]> {
  const database = await openOnlyDatabase(indexedDB)

  try {
    const transaction = database.transaction(
      Array.from(database.objectStoreNames),
      'readonly',
    )
    const keys = await Promise.all(
      Array.from(database.objectStoreNames, (storeName) =>
        requestResult(transaction.objectStore(storeName).getAllKeys())
      ),
    )
    await transactionCompletion(transaction)
    return keys.flat().map(String)
  } finally {
    database.close()
  }
}

async function replaceFirstRecord(
  indexedDB: IDBFactory,
  storeName: string,
  replace: (value: unknown) => unknown,
): Promise<void> {
  const database = await openOnlyDatabase(indexedDB)
  try {
    const transaction = database.transaction(storeName, 'readwrite')
    const store = transaction.objectStore(storeName)
    const [keys, values] = await Promise.all([
      requestResult(store.getAllKeys()),
      requestResult(store.getAll()),
    ])
    assert.ok(keys[0])
    store.put(replace(values[0]), keys[0])
    await transactionCompletion(transaction)
  } finally {
    database.close()
  }
}

async function openOnlyDatabase(indexedDB: IDBFactory): Promise<IDBDatabase> {
  const databases = await indexedDB.databases()
  const name = databases[0]?.name
  assert.ok(name)
  return await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name)
    request.addEventListener('success', () => resolve(request.result), { once: true })
    request.addEventListener('error', () => reject(request.error), { once: true })
  })
}

function recordValue(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, 'object')
  assert.notEqual(value, null)
  assert.equal(Array.isArray(value), false)
  return value as Record<string, unknown>
}

async function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result), { once: true })
    request.addEventListener('error', () => reject(request.error), { once: true })
  })
}

async function transactionCompletion(transaction: IDBTransaction): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve(), { once: true })
    transaction.addEventListener('abort', () => reject(transaction.error), { once: true })
    transaction.addEventListener('error', () => reject(transaction.error), { once: true })
  })
}
