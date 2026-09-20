import type { CoreIntegrityHasher } from './core.ts'
import {
  BrowserStorageError,
  IndexedDbWorkflowStore,
  mapBrowserStorageError,
  validateStorageNamespace,
} from './indexedDbWorkflowStore.ts'
import { OpfsBlobStore } from './opfsBlobStore.ts'
import { loadDefaultCore } from './wasmCore.ts'

export { BrowserStorageError } from './indexedDbWorkflowStore.ts'
export type { BrowserStorageErrorCode } from './indexedDbWorkflowStore.ts'

export type RecordingJournalPhase =
  | 'prepared'
  | 'transferring'
  | 'staged'
  | 'uploading'
  | 'cloud_completed'
  | 'confirmed'

export interface RecordingJournal {
  schemaVersion: 1
  operationId: string
  serialNumber: string
  recordingUuid: string
  profile: 'legacy' | 'encrypted_upload_v2'
  phase: RecordingJournalPhase
  sinkId: string
  uploadId: string | null
  cloudCompletionId: string | null
  confirmationDigestHex: string | null
  devicePlaintextSha256Hex: string | null
  updatedAtEpochMs: number
}

export interface FirmwareJournal {
  schemaVersion: 1
  operationId: string
  serialNumber: string
  imageId: string
  downloadId: bigint
  version: string
  sizeBytes: number
  crc32: number
  sha256Hex: string
  blobId: string
  downloadedBytes: number
  verified: boolean
  updatedAtEpochMs: number
}

export interface VerifiedDeviceHint {
  schemaVersion: 1
  serialNumber: string
  browserDeviceId: string
  name: string | null
  updatedAtEpochMs: number
}

export interface WorkflowCheckpointRecord {
  schemaVersion: 1
  operationId: string
  checkpoint: unknown
}

export interface EncryptedUploadV2CheckpointRecord {
  schemaVersion: 1
  operationId: string
  checkpoint: unknown
}

export interface ProvisioningJournal {
  schemaVersion: 1
  attemptId: string
  serialNumber: string
  phase: 'prepared' | 'device_applied' | 'backend_confirmed' | 'aborted'
  updatedAtEpochMs: number
}

export interface BrowserBlobHandle {
  readonly id: string
  size(): Promise<number>
  truncate(size: number): Promise<void>
  write(offset: number, bytes: Uint8Array): Promise<void>
  read(offset: number, maximumLength: number): Promise<Uint8Array>
  stream(chunkSize?: number): AsyncIterable<Uint8Array>
  delete(): Promise<void>
}

export interface BrowserSdkStorage {
  readonly namespace: string
  loadVerifiedDevice(serialNumber: string): Promise<VerifiedDeviceHint | null>
  saveVerifiedDevice(value: VerifiedDeviceHint): Promise<void>
  deleteVerifiedDevice(serialNumber: string): Promise<void>
  loadWorkflowCheckpoint(operationId: string): Promise<unknown | null>
  saveWorkflowCheckpoint(operationId: string, checkpoint: unknown): Promise<void>
  deleteWorkflowCheckpoint(operationId: string): Promise<void>
  loadEncryptedUploadV2Checkpoint(operationId: string): Promise<unknown | null>
  saveEncryptedUploadV2Checkpoint(
    operationId: string,
    checkpoint: unknown,
  ): Promise<void>
  deleteEncryptedUploadV2Checkpoint(operationId: string): Promise<void>
  loadRecordingJournal(operationId: string): Promise<RecordingJournal | null>
  saveRecordingJournal(journal: RecordingJournal): Promise<void>
  listRecordingJournals(): Promise<RecordingJournal[]>
  deleteRecordingJournal(operationId: string): Promise<void>
  loadProvisioningJournal(attemptId: string): Promise<ProvisioningJournal | null>
  saveProvisioningJournal(journal: ProvisioningJournal): Promise<void>
  deleteProvisioningJournal(attemptId: string): Promise<void>
  loadFirmwareJournal(operationId: string): Promise<FirmwareJournal | null>
  saveFirmwareJournal(journal: FirmwareJournal): Promise<void>
  deleteFirmwareJournal(operationId: string): Promise<void>
  openBlob(blobId: string): Promise<BrowserBlobHandle>
  clear(): Promise<void>
}

export interface BrowserStorageDependencies {
  indexedDB?: IDBFactory | null
  keyRange?: typeof IDBKeyRange | null
  opfsRoot?: FileSystemDirectoryHandle | null
  createIntegrityHasher?: (() => CoreIntegrityHasher) | null
}

export async function createDefaultBrowserStorage(
  namespace: string,
  dependencies: BrowserStorageDependencies = {},
): Promise<BrowserSdkStorage> {
  validateStorageNamespace(namespace)

  const indexedDB = dependencies.indexedDB === undefined
    ? globalThis.indexedDB
    : dependencies.indexedDB
  const keyRange = dependencies.keyRange === undefined
    ? globalThis.IDBKeyRange
    : dependencies.keyRange
  if (!indexedDB || !keyRange) {
    throw new BrowserStorageError('storage_unavailable')
  }

  let opfsRoot = dependencies.opfsRoot
  if (opfsRoot === undefined) {
    const storage = typeof navigator === 'undefined' ? undefined : navigator.storage
    if (typeof storage?.getDirectory !== 'function') {
      throw new BrowserStorageError('storage_unavailable')
    }
    try {
      opfsRoot = await storage.getDirectory()
    } catch (error) {
      throw mapBrowserStorageError(error)
    }
  }
  if (!opfsRoot) throw new BrowserStorageError('storage_unavailable')

  let createIntegrityHasher = dependencies.createIntegrityHasher
  if (createIntegrityHasher === undefined) {
    try {
      const core = await loadDefaultCore()
      createIntegrityHasher = () => core.createIntegrityHasher()
    } catch (error) {
      throw mapBrowserStorageError(error)
    }
  }
  if (!createIntegrityHasher) {
    throw new BrowserStorageError('storage_unavailable')
  }

  const blobs = new OpfsBlobStore(
    namespace,
    opfsRoot,
    createIntegrityHasher,
  )
  return new DefaultBrowserStorage(
    namespace,
    indexedDB,
    keyRange,
    blobs,
  )
}

class DefaultBrowserStorage
  extends IndexedDbWorkflowStore
  implements BrowserSdkStorage {
  private readonly blobs: OpfsBlobStore

  constructor(
    namespace: string,
    indexedDB: IDBFactory,
    keyRange: typeof IDBKeyRange,
    blobs: OpfsBlobStore,
  ) {
    super(namespace, indexedDB, keyRange)
    this.blobs = blobs
  }

  async openBlob(blobId: string): Promise<BrowserBlobHandle> {
    return await this.blobs.open(blobId)
  }

  override async clear(): Promise<void> {
    await super.clear()
    await this.blobs.clear()
  }
}
