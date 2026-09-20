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

const DATABASE_NAME = 'bota-app-sdk'
const REQUIRED_STORE_NAMES = [
  'verified_devices',
  'workflow_checkpoints',
  'encrypted_upload_v2_checkpoints',
  'recording_journals',
  'provisioning_journals',
  'firmware_journals',
] as const

interface StorageFixture {
  indexedDB: IDBFactory
  opfs: FakeOpfs
  open(namespace: string): Promise<BrowserSdkStorage>
}

async function storageFixture(
  indexedDB: IDBFactory = new FakeIDBFactory(),
  opfs: FakeOpfs = new FakeOpfs(),
): Promise<StorageFixture> {
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
    devicePlaintextSha256Hex: null,
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
    materialId: 'web-11111111111111111111111111111111',
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

test('ill-formed UTF-16 cannot alias tenant namespaces or durable object IDs', async (t) => {
  const replacement = '\ufffd'
  const loneSurrogates = ['\ud800', '\udc00']

  await t.test('tenant namespace', async () => {
    const fixture = await storageFixture()
    const valid = await fixture.open(`tenant-${replacement}`)
    await valid.saveWorkflowCheckpoint('operation-1', { owner: 'valid-tenant' })

    for (const loneSurrogate of loneSurrogates) {
      await expectStorageError(
        fixture.open(`tenant-${loneSurrogate}`),
        'invalid_input',
      )
    }
    assert.deepEqual(
      await valid.loadWorkflowCheckpoint('operation-1'),
      { owner: 'valid-tenant' },
    )
  })

  await t.test('IndexedDB logical ID', async () => {
    const storage = await (await storageFixture()).open('unicode-id-tenant')
    const validId = `operation-${replacement}`
    await storage.saveWorkflowCheckpoint(validId, { owner: 'valid-object' })

    for (const loneSurrogate of loneSurrogates) {
      const malformedId = `operation-${loneSurrogate}`
      await expectStorageError(
        storage.saveWorkflowCheckpoint(malformedId, { owner: 'malformed-object' }),
        'invalid_input',
      )
      await expectStorageError(
        storage.loadWorkflowCheckpoint(malformedId),
        'invalid_input',
      )
    }
    assert.deepEqual(
      await storage.loadWorkflowCheckpoint(validId),
      { owner: 'valid-object' },
    )
  })

  await t.test('OPFS logical ID', async () => {
    const storage = await (await storageFixture()).open('unicode-blob-tenant')
    const validBlob = await storage.openBlob(`blob-${replacement}`)
    await validBlob.write(0, Uint8Array.of(1, 2, 3))

    for (const loneSurrogate of loneSurrogates) {
      await expectStorageError(
        storage.openBlob(`blob-${loneSurrogate}`),
        'invalid_input',
      )
    }
    assert.deepEqual(await validBlob.read(0, 8), Uint8Array.of(1, 2, 3))
  })
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

test('a reconciled not-uploaded legacy operation may return to staged exactly once', async () => {
  const storage = await (await storageFixture()).open('upload-recovery-tenant')
  const prepared = recordingJournal('upload-recovery-operation')

  await storage.saveRecordingJournal(prepared)
  await storage.saveRecordingJournal({ ...prepared, phase: 'transferring' })
  await storage.saveRecordingJournal({ ...prepared, phase: 'staged' })
  await storage.saveRecordingJournal({
    ...prepared,
    phase: 'uploading',
    uploadId: 'ambiguous-upload-1',
  })
  await storage.saveRecordingJournal({
    ...prepared,
    phase: 'staged',
    uploadId: null,
  })

  assert.deepEqual(
    await storage.loadRecordingJournal(prepared.operationId),
    { ...prepared, phase: 'staged', uploadId: null },
  )
})

test('schema v1 recording journals without a plaintext digest remain resumable', async (t) => {
  const phases = [
    'prepared',
    'transferring',
    'staged',
    'uploading',
    'cloud_completed',
  ] as const

  for (const phase of phases) {
    await t.test(phase, async () => {
      const fixture = await storageFixture()
      const storage = await fixture.open(`legacy-schema-${phase}-tenant`)
      const operationId = `legacy-schema-${phase}-operation`
      const seed = recordingJournal(operationId)
      await storage.saveRecordingJournal(seed)
      await replaceFirstRecord(
        fixture.indexedDB,
        'recording_journals',
        (value) => {
          const oldShape: Record<string, unknown> = {
            ...recordValue(value),
            phase,
            uploadId: phase === 'uploading' || phase === 'cloud_completed'
              ? `upload-${phase}`
              : null,
            cloudCompletionId: phase === 'cloud_completed'
              ? 'cloud-completion-1'
              : null,
          }
          delete oldShape.devicePlaintextSha256Hex
          return oldShape
        },
      )

      const loaded = await storage.loadRecordingJournal(operationId)
      assert.deepEqual(loaded, {
        ...seed,
        phase,
        uploadId: phase === 'uploading' || phase === 'cloud_completed'
          ? `upload-${phase}`
          : null,
        cloudCompletionId: phase === 'cloud_completed'
          ? 'cloud-completion-1'
          : null,
        devicePlaintextSha256Hex: null,
      })

      if (phase === 'uploading') {
        assert.ok(loaded)
        await storage.saveRecordingJournal({
          ...loaded,
          phase: 'staged',
          uploadId: null,
          updatedAtEpochMs: loaded.updatedAtEpochMs + 1,
        })
        assert.equal(
          (await storage.loadRecordingJournal(operationId))?.phase,
          'staged',
        )
      }

      if (phase === 'cloud_completed') {
        assert.ok(loaded)
        await storage.saveRecordingJournal({
          ...loaded,
          phase: 'confirmed',
          updatedAtEpochMs: loaded.updatedAtEpochMs + 1,
        })
        assert.equal(
          (await storage.loadRecordingJournal(operationId))?.phase,
          'confirmed',
        )
      }
    })
  }
})

test('schema v1 recording journals reject an explicitly undefined plaintext digest', async () => {
  const fixture = await storageFixture()
  const storage = await fixture.open('undefined-digest-tenant')
  const operationId = 'undefined-digest-operation'
  await storage.saveRecordingJournal(recordingJournal(operationId))
  await replaceFirstRecord(
    fixture.indexedDB,
    'recording_journals',
    (value) => ({
      ...recordValue(value),
      devicePlaintextSha256Hex: undefined,
    }),
  )

  await expectStorageError(
    storage.loadRecordingJournal(operationId),
    'resume_rejected',
  )
})

test('journal timestamps cannot regress', async (t) => {
  await t.test('recording journal', async () => {
    const storage = await (await storageFixture()).open('recording-time-tenant')
    const journal = recordingJournal('recording-time-operation')
    await storage.saveRecordingJournal(journal)

    await expectStorageError(
      storage.saveRecordingJournal({
        ...journal,
        updatedAtEpochMs: journal.updatedAtEpochMs - 1,
      }),
      'resume_rejected',
    )
  })

  await t.test('provisioning journal', async () => {
    const storage = await (await storageFixture()).open('provisioning-time-tenant')
    const journal = provisioningJournal()
    await storage.saveProvisioningJournal(journal)

    await expectStorageError(
      storage.saveProvisioningJournal({
        ...journal,
        updatedAtEpochMs: journal.updatedAtEpochMs - 1,
      }),
      'resume_rejected',
    )
    await expectStorageError(
      storage.saveProvisioningJournal({
        ...journal,
        materialId: 'web-22222222222222222222222222222222',
        phase: 'device_applied',
        updatedAtEpochMs: journal.updatedAtEpochMs + 1,
      }),
      'resume_rejected',
    )
  })

  await t.test('firmware journal', async () => {
    const storage = await (await storageFixture()).open('firmware-time-tenant')
    const journal = firmwareJournal()
    await storage.saveFirmwareJournal(journal)

    await expectStorageError(
      storage.saveFirmwareJournal({
        ...journal,
        updatedAtEpochMs: journal.updatedAtEpochMs - 1,
      }),
      'resume_rejected',
    )
  })
})

test('pre-material provisioning journals preserve an explicitly unknown identity', async () => {
  const fixture = await storageFixture()
  const storage = await fixture.open('legacy-provisioning-material-tenant')
  const journal = provisioningJournal()
  await storage.saveProvisioningJournal(journal)
  await replaceFirstRecord(
    fixture.indexedDB,
    'provisioning_journals',
    (value) => {
      const { materialId: _materialId, ...legacy } = recordValue(value)
      return legacy
    },
  )

  assert.deepEqual(
    await storage.loadProvisioningJournal(journal.attemptId),
    { ...journal, materialId: null },
  )
  assert.deepEqual(
    await storage.listProvisioningJournals(),
    [{ ...journal, materialId: null }],
  )
})

test('recording evidence is phase-bound, immutable, and same-phase idempotent', async (t) => {
  await t.test('device plaintext digest begins at staging and is immutable', async () => {
    const storage = await (await storageFixture()).open('legacy-digest-tenant')
    const prepared = recordingJournal('legacy-digest-operation')
    await expectStorageError(
      storage.saveRecordingJournal({
        ...prepared,
        devicePlaintextSha256Hex: '55'.repeat(32),
      }),
      'resume_rejected',
    )
    await storage.saveRecordingJournal(prepared)
    await storage.saveRecordingJournal({
      ...prepared,
      phase: 'transferring',
      updatedAtEpochMs: prepared.updatedAtEpochMs + 1,
    })
    const staged: RecordingJournal = {
      ...prepared,
      phase: 'staged',
      devicePlaintextSha256Hex: '55'.repeat(32),
      updatedAtEpochMs: prepared.updatedAtEpochMs + 2,
    }
    await storage.saveRecordingJournal(staged)
    await storage.saveRecordingJournal({
      ...staged,
      updatedAtEpochMs: prepared.updatedAtEpochMs + 3,
    })
    await expectStorageError(
      storage.saveRecordingJournal({
        ...staged,
        devicePlaintextSha256Hex: null,
        updatedAtEpochMs: prepared.updatedAtEpochMs + 4,
      }),
      'resume_rejected',
    )
    await expectStorageError(
      storage.saveRecordingJournal({
        ...staged,
        devicePlaintextSha256Hex: '66'.repeat(32),
        updatedAtEpochMs: prepared.updatedAtEpochMs + 4,
      }),
      'resume_rejected',
    )
  })

  await t.test('a null plaintext digest is immutable once staging records it', async () => {
    const storage = await (await storageFixture()).open('null-digest-tenant')
    const prepared = recordingJournal('null-digest-operation')
    const transferring: RecordingJournal = {
      ...prepared,
      phase: 'transferring',
      updatedAtEpochMs: prepared.updatedAtEpochMs + 1,
    }
    const staged: RecordingJournal = {
      ...transferring,
      phase: 'staged',
      updatedAtEpochMs: prepared.updatedAtEpochMs + 2,
    }
    await storage.saveRecordingJournal(prepared)
    await storage.saveRecordingJournal(transferring)
    await storage.saveRecordingJournal(staged)

    await expectStorageError(
      storage.saveRecordingJournal({
        ...staged,
        devicePlaintextSha256Hex: '77'.repeat(32),
        updatedAtEpochMs: prepared.updatedAtEpochMs + 3,
      }),
      'resume_rejected',
    )

    const uploading: RecordingJournal = {
      ...staged,
      phase: 'uploading',
      uploadId: 'null-digest-upload',
      updatedAtEpochMs: prepared.updatedAtEpochMs + 3,
    }
    await storage.saveRecordingJournal(uploading)
    await expectStorageError(
      storage.saveRecordingJournal({
        ...uploading,
        devicePlaintextSha256Hex: '77'.repeat(32),
        updatedAtEpochMs: prepared.updatedAtEpochMs + 4,
      }),
      'resume_rejected',
    )
  })

  await t.test('the transfer result may establish a digest when staging begins', async () => {
    const storage = await (await storageFixture()).open('new-digest-tenant')
    const prepared = recordingJournal('new-digest-operation')
    await storage.saveRecordingJournal(prepared)
    await storage.saveRecordingJournal({
      ...prepared,
      phase: 'transferring',
      updatedAtEpochMs: prepared.updatedAtEpochMs + 1,
    })
    await storage.saveRecordingJournal({
      ...prepared,
      phase: 'staged',
      devicePlaintextSha256Hex: '88'.repeat(32),
      updatedAtEpochMs: prepared.updatedAtEpochMs + 2,
    })

    assert.equal(
      (await storage.loadRecordingJournal(prepared.operationId))
        ?.devicePlaintextSha256Hex,
      '88'.repeat(32),
    )
  })

  await t.test('legacy upload and cloud evidence are required at their phases', async () => {
    const storage = await (await storageFixture()).open('legacy-evidence-tenant')
    const prepared = recordingJournal('legacy-evidence-operation')
    await storage.saveRecordingJournal(prepared)
    await storage.saveRecordingJournal({
      ...prepared,
      phase: 'transferring',
      updatedAtEpochMs: prepared.updatedAtEpochMs + 1,
    })
    await storage.saveRecordingJournal({
      ...prepared,
      phase: 'staged',
      updatedAtEpochMs: prepared.updatedAtEpochMs + 2,
    })

    await expectStorageError(
      storage.saveRecordingJournal({
        ...prepared,
        phase: 'uploading',
        updatedAtEpochMs: prepared.updatedAtEpochMs + 3,
      }),
      'resume_rejected',
    )

    const uploading = {
      ...prepared,
      phase: 'uploading' as const,
      uploadId: 'upload-1',
      updatedAtEpochMs: prepared.updatedAtEpochMs + 3,
    }
    await storage.saveRecordingJournal(uploading)
    await expectStorageError(
      storage.saveRecordingJournal({
        ...uploading,
        phase: 'cloud_completed',
        updatedAtEpochMs: prepared.updatedAtEpochMs + 4,
      }),
      'resume_rejected',
    )
    await expectStorageError(
      storage.saveRecordingJournal({
        ...uploading,
        phase: 'cloud_completed',
        cloudCompletionId: 'cloud-1',
        confirmationDigestHex: '11'.repeat(32),
        updatedAtEpochMs: prepared.updatedAtEpochMs + 4,
      }),
      'resume_rejected',
    )
  })

  await t.test('v2 confirmation evidence appears only after cloud completion', async () => {
    const storage = await (await storageFixture()).open('v2-evidence-tenant')
    const prepared = {
      ...recordingJournal('v2-evidence-operation'),
      profile: 'encrypted_upload_v2' as const,
    }

    await expectStorageError(
      storage.saveRecordingJournal({
        ...prepared,
        confirmationDigestHex: '22'.repeat(32),
      }),
      'resume_rejected',
    )

    await storage.saveRecordingJournal(prepared)
    await storage.saveRecordingJournal({
      ...prepared,
      phase: 'transferring',
      updatedAtEpochMs: prepared.updatedAtEpochMs + 1,
    })
    await storage.saveRecordingJournal({
      ...prepared,
      phase: 'staged',
      updatedAtEpochMs: prepared.updatedAtEpochMs + 2,
    })
    await storage.saveRecordingJournal({
      ...prepared,
      phase: 'uploading',
      updatedAtEpochMs: prepared.updatedAtEpochMs + 3,
    })
    await expectStorageError(
      storage.saveRecordingJournal({
        ...prepared,
        phase: 'cloud_completed',
        updatedAtEpochMs: prepared.updatedAtEpochMs + 4,
      }),
      'resume_rejected',
    )
  })

  for (const evidence of [
    { key: 'uploadId', phase: 'uploading', value: 'upload-1', replacement: 'upload-2' },
    {
      key: 'cloudCompletionId',
      phase: 'cloud_completed',
      value: 'cloud-1',
      replacement: 'cloud-2',
    },
    {
      key: 'confirmationDigestHex',
      phase: 'cloud_completed',
      value: '33'.repeat(32),
      replacement: '44'.repeat(32),
    },
  ] as const) {
    await t.test(`${evidence.key} cannot be cleared or changed`, async () => {
      const storage = await (await storageFixture()).open(`${evidence.key}-tenant`)
      const profile: RecordingJournal['profile'] = evidence.key === 'confirmationDigestHex'
        ? 'encrypted_upload_v2'
        : 'legacy'
      const prepared: RecordingJournal = {
        ...recordingJournal(`${evidence.key}-operation`),
        profile,
      }
      const transferring: RecordingJournal = {
        ...prepared,
        phase: 'transferring' as const,
        updatedAtEpochMs: prepared.updatedAtEpochMs + 1,
      }
      const staged: RecordingJournal = {
        ...prepared,
        phase: 'staged' as const,
        updatedAtEpochMs: prepared.updatedAtEpochMs + 2,
      }
      const uploading: RecordingJournal = {
        ...prepared,
        phase: 'uploading' as const,
        uploadId: profile === 'legacy' ? 'upload-1' : null,
        updatedAtEpochMs: prepared.updatedAtEpochMs + 3,
      }
      const cloudCompleted: RecordingJournal = {
        ...uploading,
        phase: 'cloud_completed' as const,
        cloudCompletionId: profile === 'legacy' ? 'cloud-1' : null,
        confirmationDigestHex: profile === 'encrypted_upload_v2'
          ? '33'.repeat(32)
          : null,
        updatedAtEpochMs: prepared.updatedAtEpochMs + 4,
      }

      await storage.saveRecordingJournal(prepared)
      await storage.saveRecordingJournal(transferring)
      await storage.saveRecordingJournal(staged)
      await storage.saveRecordingJournal(uploading)
      if (evidence.phase === 'cloud_completed') {
        await storage.saveRecordingJournal(cloudCompleted)
      }
      const established: RecordingJournal = evidence.phase === 'uploading'
        ? uploading
        : cloudCompleted

      await storage.saveRecordingJournal({
        ...established,
        updatedAtEpochMs: established.updatedAtEpochMs + 1,
      })
      await expectStorageError(
        storage.saveRecordingJournal({
          ...established,
          [evidence.key]: null,
          updatedAtEpochMs: established.updatedAtEpochMs + 2,
        }),
        'resume_rejected',
      )
      await expectStorageError(
        storage.saveRecordingJournal({
          ...established,
          [evidence.key]: evidence.replacement,
          updatedAtEpochMs: established.updatedAtEpochMs + 2,
        }),
        'resume_rejected',
      )
    })
  }
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

test('concurrent same-offset OPFS appends commit one complete suffix without losing the prefix', async () => {
  const fixture = await storageFixture()
  const firstStorage = await fixture.open('concurrent-blob-tenant')
  const secondStorage = await fixture.open('concurrent-blob-tenant')
  const first = await firstStorage.openBlob('shared-blob')
  const second = await secondStorage.openBlob('shared-blob')
  const prefix = Uint8Array.of(1, 2, 3)
  const firstSuffix = Uint8Array.of(4, 5)
  const secondSuffix = Uint8Array.of(6, 7)
  await first.write(0, prefix)

  const results = await Promise.allSettled([
    first.write(prefix.byteLength, firstSuffix),
    second.write(prefix.byteLength, secondSuffix),
  ])

  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1)
  assert.equal(results.filter(({ status }) => status === 'rejected').length, 1)
  const rejection = results.find(({ status }) => status === 'rejected')
  assert.ok(rejection && rejection.status === 'rejected')
  assert.equal(rejection.reason instanceof BrowserStorageError, true)
  assert.equal((rejection.reason as BrowserStorageError).code, 'resume_rejected')
  const bytes = await first.read(0, 16)
  assert.equal(
    [
      Uint8Array.of(...prefix, ...firstSuffix),
      Uint8Array.of(...prefix, ...secondSuffix),
    ].some((expected) => Buffer.from(expected).equals(Buffer.from(bytes))),
    true,
  )
})

test('OPFS mutations use one deterministic hashed Web Lock name when available', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis.navigator, 'locks')
  const lockNames: string[] = []
  const lockManager = {
    request: async (
      name: string,
      callback: (lock: null) => unknown,
    ): Promise<unknown> => {
      lockNames.push(name)
      return await callback(null)
    },
  } as unknown as LockManager
  Object.defineProperty(globalThis.navigator, 'locks', {
    configurable: true,
    value: lockManager,
  })

  try {
    const namespace = 'web-lock-tenant'
    const blobId = 'web-lock-blob'
    const storage = await (await storageFixture()).open(namespace)
    const first = await storage.openBlob(blobId)
    const second = await storage.openBlob(blobId)

    await first.write(0, Uint8Array.of(1))
    await second.write(1, Uint8Array.of(2))
    await first.truncate(1)
    await second.delete()

    assert.equal(lockNames.length, 4)
    assert.equal(new Set(lockNames).size, 1)
    assert.match(
      lockNames[0] ?? '',
      /^bota-app-sdk:v1:[0-9a-f]{64}:[0-9a-f]{64}$/,
    )
    assert.equal(lockNames[0]?.includes(namespace), false)
    assert.equal(lockNames[0]?.includes(blobId), false)
  } finally {
    if (original) {
      Object.defineProperty(globalThis.navigator, 'locks', original)
    } else {
      Reflect.deleteProperty(globalThis.navigator, 'locks')
    }
  }
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

test('OPFS rejects unsafe file sizes and range arithmetic', async (t) => {
  for (const reportedSize of [-1, Number.MAX_SAFE_INTEGER + 1]) {
    await t.test(`reported file size ${reportedSize}`, async () => {
      const fixture = await storageFixture()
      const blob = await (await fixture.open('file-size-tenant')).openBlob('body')
      fixture.opfs.reportNextFileSize(reportedSize)

      await expectStorageError(blob.size(), 'resume_rejected')
    })
  }

  await t.test('read offset plus maximum length overflow', async () => {
    const fixture = await storageFixture()
    const blob = await (await fixture.open('read-range-tenant')).openBlob('body')

    await expectStorageError(
      blob.read(Number.MAX_SAFE_INTEGER, 1),
      'invalid_input',
    )
    assert.deepEqual(fixture.opfs.paths(), [])
  })

  await t.test('write offset plus byte length overflow', async () => {
    const fixture = await storageFixture()
    const blob = await (await fixture.open('write-range-tenant')).openBlob('body')

    await expectStorageError(
      blob.write(Number.MAX_SAFE_INTEGER, Uint8Array.of(1)),
      'invalid_input',
    )
    assert.deepEqual(fixture.opfs.paths(), [])
  })
})

test('a live IndexedDB version change invalidates the cached connection', async () => {
  const fixture = await storageFixture()
  const storage = await fixture.open('live-version-change-tenant')
  const operationId = 'live-version-change-operation'
  await storage.saveWorkflowCheckpoint(operationId, { phase: 'prepared' })

  await createDatabase(fixture.indexedDB, 2, () => undefined)

  await expectStorageError(
    storage.loadWorkflowCheckpoint(operationId),
    'resume_rejected',
  )
})

test('incompatible IndexedDB versions and store shapes fail closed', async (t) => {
  await t.test('newer database version', async () => {
    const indexedDB = new FakeIDBFactory()
    await createDatabase(indexedDB, 2, (database) => {
      for (const storeName of REQUIRED_STORE_NAMES) database.createObjectStore(storeName)
    })
    const storage = await (await storageFixture(indexedDB)).open('newer-schema-tenant')

    await expectStorageError(
      storage.loadWorkflowCheckpoint('operation-1'),
      'resume_rejected',
    )
  })

  const malformedSchemas = [
    {
      name: 'missing required store',
      configure(database: IDBDatabase): void {
        for (const storeName of REQUIRED_STORE_NAMES.slice(1)) {
          database.createObjectStore(storeName)
        }
      },
    },
    {
      name: 'extra store',
      configure(database: IDBDatabase): void {
        for (const storeName of REQUIRED_STORE_NAMES) database.createObjectStore(storeName)
        database.createObjectStore('unexpected_store')
      },
    },
    {
      name: 'required store with an inline key',
      configure(database: IDBDatabase): void {
        for (const storeName of REQUIRED_STORE_NAMES) {
          database.createObjectStore(
            storeName,
            storeName === 'workflow_checkpoints' ? { keyPath: 'id' } : undefined,
          )
        }
      },
    },
    {
      name: 'required store with an index',
      configure(database: IDBDatabase, transaction: IDBTransaction): void {
        for (const storeName of REQUIRED_STORE_NAMES) database.createObjectStore(storeName)
        transaction.objectStore('workflow_checkpoints').createIndex('by_id', 'operationId')
      },
    },
  ] as const

  for (const schema of malformedSchemas) {
    await t.test(schema.name, async () => {
      const indexedDB = new FakeIDBFactory()
      await createDatabase(indexedDB, 1, schema.configure)
      const storage = await (await storageFixture(indexedDB)).open('malformed-schema-tenant')

      await expectStorageError(
        storage.loadWorkflowCheckpoint('operation-1'),
        'resume_rejected',
      )
    })
  }
})

test('loaded structured identities must match their requested durable keys', async (t) => {
  const cases = [
    {
      name: 'verified-device serial',
      storeName: 'verified_devices',
      save: async (storage: BrowserSdkStorage) => await storage.saveVerifiedDevice(verifiedDevice()),
      corrupt: (value: unknown) => ({ ...recordValue(value), serialNumber: 'OTHER-SERIAL' }),
      load: async (storage: BrowserSdkStorage) =>
        await storage.loadVerifiedDevice(verifiedDevice().serialNumber),
    },
    {
      name: 'workflow operation ID',
      storeName: 'workflow_checkpoints',
      save: async (storage: BrowserSdkStorage) =>
        await storage.saveWorkflowCheckpoint('workflow-operation', { phase: 'prepared' }),
      corrupt: (value: unknown) => ({ ...recordValue(value), operationId: 'other-operation' }),
      load: async (storage: BrowserSdkStorage) =>
        await storage.loadWorkflowCheckpoint('workflow-operation'),
    },
    {
      name: 'encrypted-upload operation ID',
      storeName: 'encrypted_upload_v2_checkpoints',
      save: async (storage: BrowserSdkStorage) =>
        await storage.saveEncryptedUploadV2Checkpoint('v2-operation', { phase: 'prepared' }),
      corrupt: (value: unknown) => ({ ...recordValue(value), operationId: 'other-operation' }),
      load: async (storage: BrowserSdkStorage) =>
        await storage.loadEncryptedUploadV2Checkpoint('v2-operation'),
    },
    {
      name: 'recording operation ID',
      storeName: 'recording_journals',
      save: async (storage: BrowserSdkStorage) =>
        await storage.saveRecordingJournal(recordingJournal('recording-operation')),
      corrupt: (value: unknown) => ({ ...recordValue(value), operationId: 'other-operation' }),
      load: async (storage: BrowserSdkStorage) =>
        await storage.loadRecordingJournal('recording-operation'),
    },
    {
      name: 'provisioning attempt ID',
      storeName: 'provisioning_journals',
      save: async (storage: BrowserSdkStorage) =>
        await storage.saveProvisioningJournal(provisioningJournal()),
      corrupt: (value: unknown) => ({ ...recordValue(value), attemptId: 'other-attempt' }),
      load: async (storage: BrowserSdkStorage) =>
        await storage.loadProvisioningJournal(provisioningJournal().attemptId),
    },
    {
      name: 'firmware operation ID',
      storeName: 'firmware_journals',
      save: async (storage: BrowserSdkStorage) =>
        await storage.saveFirmwareJournal(firmwareJournal()),
      corrupt: (value: unknown) => ({ ...recordValue(value), operationId: 'other-operation' }),
      load: async (storage: BrowserSdkStorage) =>
        await storage.loadFirmwareJournal(firmwareJournal().operationId),
    },
  ] as const

  for (const identityCase of cases) {
    await t.test(identityCase.name, async () => {
      const fixture = await storageFixture()
      const storage = await fixture.open(`${identityCase.storeName}-identity-tenant`)
      await identityCase.save(storage)
      await replaceFirstRecord(
        fixture.indexedDB,
        identityCase.storeName,
        identityCase.corrupt,
      )

      await expectStorageError(identityCase.load(storage), 'resume_rejected')
    })
  }

  await t.test('recording enumeration binds each value to its durable key', async () => {
    const fixture = await storageFixture()
    const storage = await fixture.open('recording-list-identity-tenant')
    await storage.saveRecordingJournal(recordingJournal('recording-operation'))
    await replaceFirstRecord(
      fixture.indexedDB,
      'recording_journals',
      (value) => ({ ...recordValue(value), operationId: 'other-operation' }),
    )

    await expectStorageError(storage.listRecordingJournals(), 'resume_rejected')
  })
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
  assert.deepEqual(await reopened.listProvisioningJournals(), [provisioning])
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

test('encrypted upload v2 operation metadata and journal commit and delete atomically', async () => {
  const fixture = await storageFixture()
  const storage = await fixture.open('v2-atomic-operation')
  const operationId = 'v2-atomic-operation-1'
  const checkpoint = {
    operationId,
    materialId: 'material-v2-1',
    coreCheckpoint: null,
  }
  const journal: RecordingJournal = {
    ...recordingJournal(operationId),
    profile: 'encrypted_upload_v2',
  }

  await storage.saveEncryptedUploadV2Operation(
    operationId,
    checkpoint,
    journal,
  )
  assert.deepEqual(
    await storage.loadEncryptedUploadV2Checkpoint(operationId),
    checkpoint,
  )
  assert.deepEqual(await storage.loadRecordingJournal(operationId), journal)

  await storage.deleteEncryptedUploadV2Operation(operationId)
  assert.equal(
    await storage.loadEncryptedUploadV2Checkpoint(operationId),
    null,
  )
  assert.equal(await storage.loadRecordingJournal(operationId), null)

  const invalidOperationId = 'v2-invalid-atomic-operation'
  await assert.rejects(
    storage.saveEncryptedUploadV2Operation(
      invalidOperationId,
      checkpoint,
      { ...journal, operationId: 'different-operation' },
    ),
    (error: unknown) =>
      error instanceof BrowserStorageError && error.code === 'resume_rejected',
  )
  assert.equal(
    await storage.loadEncryptedUploadV2Checkpoint(invalidOperationId),
    null,
  )
  assert.equal(await storage.loadRecordingJournal(invalidOperationId), null)
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

async function createDatabase(
  indexedDB: IDBFactory,
  version: number,
  configure: (database: IDBDatabase, transaction: IDBTransaction) => void,
): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, version)
    request.addEventListener('upgradeneeded', () => {
      assert.ok(request.transaction)
      configure(request.result, request.transaction)
    })
    request.addEventListener('success', () => resolve(request.result), { once: true })
    request.addEventListener('error', () => reject(request.error), { once: true })
  })
  database.close()
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
