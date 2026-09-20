import type {
  EncryptedUploadV2CheckpointRecord,
  FirmwareJournal,
  ProvisioningJournal,
  RecordingJournal,
  RecordingJournalPhase,
  VerifiedDeviceHint,
  WorkflowCheckpointRecord,
} from './storage.ts'

export type BrowserStorageErrorCode =
  | 'invalid_input'
  | 'storage_unavailable'
  | 'storage_quota_exceeded'
  | 'resume_rejected'

const ERROR_MESSAGES: Record<BrowserStorageErrorCode, string> = {
  invalid_input: 'The storage operation contains invalid input.',
  storage_unavailable: 'Durable browser storage is unavailable.',
  storage_quota_exceeded: 'Durable browser storage quota was exceeded.',
  resume_rejected: 'Persisted workflow state is incompatible.',
}

export class BrowserStorageError extends Error {
  readonly code: BrowserStorageErrorCode

  constructor(code: BrowserStorageErrorCode, options: { cause?: unknown } = {}) {
    super(ERROR_MESSAGES[code], { cause: options.cause })
    this.name = 'BrowserStorageError'
    this.code = code
  }
}

export function mapBrowserStorageError(error: unknown): BrowserStorageError {
  if (error instanceof BrowserStorageError) return error
  if (domExceptionName(error) === 'QuotaExceededError') {
    return new BrowserStorageError('storage_quota_exceeded', { cause: error })
  }
  if (domExceptionName(error) === 'VersionError') return resumeRejected()
  return new BrowserStorageError('storage_unavailable', { cause: error })
}

export function validateStorageNamespace(namespace: string): void {
  if (
    typeof namespace !== 'string'
    || namespace.trim().length === 0
    || namespace.length > 256
    || !isWellFormedUtf16(namespace)
  ) {
    throw new BrowserStorageError('invalid_input')
  }
}

export function validateStorageIdentifier(value: string): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || !isWellFormedUtf16(value)
  ) {
    throw new BrowserStorageError('invalid_input')
  }
  return value
}

const DATABASE_NAME = 'bota-app-sdk'
const DATABASE_VERSION = 1
const STORE_NAMES = [
  'verified_devices',
  'workflow_checkpoints',
  'encrypted_upload_v2_checkpoints',
  'recording_journals',
  'provisioning_journals',
  'firmware_journals',
] as const

type StoreName = typeof STORE_NAMES[number]
type UnknownRecord = Record<string, unknown>

const RECORDING_PHASES: readonly RecordingJournalPhase[] = [
  'prepared',
  'transferring',
  'staged',
  'uploading',
  'cloud_completed',
  'confirmed',
]

export class IndexedDbWorkflowStore {
  readonly namespace: string

  private readonly indexedDB: IDBFactory
  private readonly keyRange: typeof IDBKeyRange
  private readonly namespacePrefix: string
  private databasePromise: Promise<IDBDatabase> | null = null
  private databaseInvalidated = false

  constructor(
    namespace: string,
    indexedDB: IDBFactory,
    keyRange: typeof IDBKeyRange,
  ) {
    validateStorageNamespace(namespace)
    this.namespace = namespace
    this.indexedDB = indexedDB
    this.keyRange = keyRange
    this.namespacePrefix = `v1:${encodeKeyPart(namespace)}:`
  }

  async loadVerifiedDevice(
    serialNumber: string,
  ): Promise<VerifiedDeviceHint | null> {
    const value = await this.get('verified_devices', serialNumber)
    if (value === undefined) return null
    const hint = verifiedDevice(value)
    if (hint.serialNumber !== serialNumber) throw resumeRejected()
    return hint
  }

  async saveVerifiedDevice(value: VerifiedDeviceHint): Promise<void> {
    const sanitized = verifiedDevice(value)
    await this.put('verified_devices', sanitized.serialNumber, sanitized)
  }

  async deleteVerifiedDevice(serialNumber: string): Promise<void> {
    await this.delete('verified_devices', serialNumber)
  }

  async loadWorkflowCheckpoint(operationId: string): Promise<unknown | null> {
    const value = await this.get('workflow_checkpoints', operationId)
    if (value === undefined) return null
    return workflowCheckpoint(value, operationId).checkpoint
  }

  async saveWorkflowCheckpoint(
    operationId: string,
    checkpoint: unknown,
  ): Promise<void> {
    const record: WorkflowCheckpointRecord = {
      schemaVersion: 1,
      operationId: validIdentifier(operationId),
      checkpoint,
    }
    await this.put('workflow_checkpoints', operationId, record)
  }

  async deleteWorkflowCheckpoint(operationId: string): Promise<void> {
    await this.delete('workflow_checkpoints', operationId)
  }

  async loadEncryptedUploadV2Checkpoint(
    operationId: string,
  ): Promise<unknown | null> {
    const value = await this.get('encrypted_upload_v2_checkpoints', operationId)
    if (value === undefined) return null
    return encryptedUploadV2Checkpoint(value, operationId).checkpoint
  }

  async saveEncryptedUploadV2Checkpoint(
    operationId: string,
    checkpoint: unknown,
  ): Promise<void> {
    const record: EncryptedUploadV2CheckpointRecord = {
      schemaVersion: 1,
      operationId: validIdentifier(operationId),
      checkpoint,
    }
    await this.put('encrypted_upload_v2_checkpoints', operationId, record)
  }

  async deleteEncryptedUploadV2Checkpoint(operationId: string): Promise<void> {
    await this.delete('encrypted_upload_v2_checkpoints', operationId)
  }

  async loadRecordingJournal(
    operationId: string,
  ): Promise<RecordingJournal | null> {
    const value = await this.get('recording_journals', operationId)
    if (value === undefined) return null
    const journal = recordingJournal(value)
    if (journal.operationId !== operationId) throw resumeRejected()
    return journal
  }

  async saveRecordingJournal(journal: RecordingJournal): Promise<void> {
    const sanitized = recordingJournal(journal)
    await this.saveMonotonicJournal(
      'recording_journals',
      sanitized.operationId,
      sanitized,
      (existing) => {
        const previous = recordingJournal(existing)
        if (
          previous.operationId !== sanitized.operationId
          || previous.serialNumber !== sanitized.serialNumber
          || previous.recordingUuid !== sanitized.recordingUuid
          || previous.profile !== sanitized.profile
          || previous.sinkId !== sanitized.sinkId
        ) {
          throw resumeRejected()
        }
        assertNondecreasingTimestamp(previous, sanitized)
        const reconciledNotUploaded =
          previous.profile === 'legacy'
          && previous.phase === 'uploading'
          && sanitized.phase === 'staged'
          && sanitized.uploadId === null
          && sanitized.cloudCompletionId === null
          && sanitized.confirmationDigestHex === null
        if (!reconciledNotUploaded) {
          assertEstablishedEvidence(previous.uploadId, sanitized.uploadId)
        }
        assertEstablishedEvidence(
          previous.cloudCompletionId,
          sanitized.cloudCompletionId,
        )
        assertEstablishedEvidence(
          previous.confirmationDigestHex,
          sanitized.confirmationDigestHex,
        )
        if (
          RECORDING_PHASES.indexOf(previous.phase)
            >= RECORDING_PHASES.indexOf('staged')
          && previous.devicePlaintextSha256Hex
            !== sanitized.devicePlaintextSha256Hex
        ) {
          throw resumeRejected()
        }
        if (!reconciledNotUploaded) {
          assertNextPhase(RECORDING_PHASES, previous.phase, sanitized.phase)
        }
      },
      () => {
        if (sanitized.phase !== 'prepared') throw resumeRejected()
      },
    )
  }

  async listRecordingJournals(): Promise<RecordingJournal[]> {
    const entries = await this.getAll('recording_journals')
    return entries
      .map(({ key, value }) => {
        const journal = recordingJournal(value)
        if (key !== this.key(journal.operationId)) throw resumeRejected()
        return journal
      })
      .sort((left, right) => left.operationId.localeCompare(right.operationId))
  }

  async deleteRecordingJournal(operationId: string): Promise<void> {
    await this.delete('recording_journals', operationId)
  }

  async loadProvisioningJournal(
    attemptId: string,
  ): Promise<ProvisioningJournal | null> {
    const value = await this.get('provisioning_journals', attemptId)
    if (value === undefined) return null
    const journal = provisioningJournal(value)
    if (journal.attemptId !== attemptId) throw resumeRejected()
    return journal
  }

  async saveProvisioningJournal(journal: ProvisioningJournal): Promise<void> {
    const sanitized = provisioningJournal(journal)
    await this.saveMonotonicJournal(
      'provisioning_journals',
      sanitized.attemptId,
      sanitized,
      (existing) => {
        const previous = provisioningJournal(existing)
        if (
          previous.attemptId !== sanitized.attemptId
          || previous.serialNumber !== sanitized.serialNumber
        ) {
          throw resumeRejected()
        }
        assertNondecreasingTimestamp(previous, sanitized)
        if (previous.phase === sanitized.phase) return
        const permitted =
          (previous.phase === 'prepared'
            && (sanitized.phase === 'device_applied' || sanitized.phase === 'aborted'))
          || (previous.phase === 'device_applied'
            && sanitized.phase === 'backend_confirmed')
        if (!permitted) throw resumeRejected()
      },
      () => {
        if (sanitized.phase !== 'prepared') throw resumeRejected()
      },
    )
  }

  async deleteProvisioningJournal(attemptId: string): Promise<void> {
    await this.delete('provisioning_journals', attemptId)
  }

  async loadFirmwareJournal(operationId: string): Promise<FirmwareJournal | null> {
    const value = await this.get('firmware_journals', operationId)
    if (value === undefined) return null
    const journal = firmwareJournal(value)
    if (journal.operationId !== operationId) throw resumeRejected()
    return journal
  }

  async saveFirmwareJournal(journal: FirmwareJournal): Promise<void> {
    const sanitized = firmwareJournal(journal)
    await this.saveMonotonicJournal(
      'firmware_journals',
      sanitized.operationId,
      sanitized,
      (value) => {
        const existing = firmwareJournal(value)
        if (
          existing.operationId !== sanitized.operationId
          || existing.serialNumber !== sanitized.serialNumber
          || existing.imageId !== sanitized.imageId
          || existing.downloadId !== sanitized.downloadId
          || existing.version !== sanitized.version
          || existing.sizeBytes !== sanitized.sizeBytes
          || existing.crc32 !== sanitized.crc32
          || existing.sha256Hex !== sanitized.sha256Hex
          || existing.blobId !== sanitized.blobId
          || sanitized.downloadedBytes < existing.downloadedBytes
          || (existing.verified && !sanitized.verified)
        ) {
          throw resumeRejected()
        }
        assertNondecreasingTimestamp(existing, sanitized)
      },
      () => undefined,
    )
  }

  async deleteFirmwareJournal(operationId: string): Promise<void> {
    await this.delete('firmware_journals', operationId)
  }

  async clear(): Promise<void> {
    try {
      const database = await this.database()
      const transaction = database.transaction([...STORE_NAMES], 'readwrite')
      const completion = transactionCompletion(transaction)
      const range = this.namespaceRange()
      for (const storeName of STORE_NAMES) {
        transaction.objectStore(storeName).delete(range)
      }
      await completion
    } catch (error) {
      throw mapBrowserStorageError(error)
    }
  }

  private async get(storeName: StoreName, id: string): Promise<unknown | undefined> {
    const key = this.key(id)
    try {
      const database = await this.database()
      const transaction = database.transaction(storeName, 'readonly')
      const completion = transactionCompletion(transaction)
      const request = requestResult(transaction.objectStore(storeName).get(key))
      const [value] = await Promise.all([request, completion])
      return value
    } catch (error) {
      throw mapBrowserStorageError(error)
    }
  }

  private async getAll(
    storeName: StoreName,
  ): Promise<Array<{ key: IDBValidKey, value: unknown }>> {
    try {
      const database = await this.database()
      const transaction = database.transaction(storeName, 'readonly')
      const completion = transactionCompletion(transaction)
      const store = transaction.objectStore(storeName)
      const range = this.namespaceRange()
      const [keys, values] = await Promise.all([
        requestResult(store.getAllKeys(range)),
        requestResult(store.getAll(range)),
        completion,
      ])
      if (keys.length !== values.length) throw resumeRejected()
      return values.map((value, index) => {
        const key = keys[index]
        if (key === undefined) throw resumeRejected()
        return { key, value }
      })
    } catch (error) {
      throw mapBrowserStorageError(error)
    }
  }

  private async put(storeName: StoreName, id: string, value: unknown): Promise<void> {
    const key = this.key(id)
    try {
      const database = await this.database()
      const transaction = database.transaction(storeName, 'readwrite')
      const completion = transactionCompletion(transaction)
      transaction.objectStore(storeName).put(value, key)
      await completion
    } catch (error) {
      throw mapBrowserStorageError(error)
    }
  }

  private async delete(storeName: StoreName, id: string): Promise<void> {
    const key = this.key(id)
    try {
      const database = await this.database()
      const transaction = database.transaction(storeName, 'readwrite')
      const completion = transactionCompletion(transaction)
      transaction.objectStore(storeName).delete(key)
      await completion
    } catch (error) {
      throw mapBrowserStorageError(error)
    }
  }

  private async saveMonotonicJournal<T>(
    storeName: StoreName,
    id: string,
    value: T,
    validateExisting: (existing: unknown) => void,
    validateInitial: () => void,
  ): Promise<void> {
    const key = this.key(id)
    try {
      const database = await this.database()
      const transaction = database.transaction(storeName, 'readwrite')
      const completion = transactionCompletion(transaction)
      const store = transaction.objectStore(storeName)
      try {
        const existing = await requestResult(store.get(key))
        if (existing === undefined) validateInitial()
        else validateExisting(existing)
        store.put(value, key)
      } catch (error) {
        await completion.catch(() => undefined)
        throw error
      }
      await completion
    } catch (error) {
      throw mapBrowserStorageError(error)
    }
  }

  private key(id: string): string {
    return `${this.namespacePrefix}${encodeKeyPart(validIdentifier(id))}`
  }

  private namespaceRange(): IDBKeyRange {
    return this.keyRange.bound(
      this.namespacePrefix,
      `${this.namespacePrefix}\uffff`,
    )
  }

  private async database(): Promise<IDBDatabase> {
    if (this.databaseInvalidated) throw resumeRejected()
    if (!this.databasePromise) {
      this.databasePromise = this.openDatabase().catch((error: unknown) => {
        this.databasePromise = null
        throw error
      })
    }
    const database = await this.databasePromise
    if (this.databaseInvalidated) throw resumeRejected()
    return database
  }

  private async openDatabase(): Promise<IDBDatabase> {
    try {
      return await new Promise<IDBDatabase>((resolve, reject) => {
        const request = this.indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
        request.addEventListener('upgradeneeded', () => {
          for (const storeName of STORE_NAMES) {
            if (!request.result.objectStoreNames.contains(storeName)) {
              request.result.createObjectStore(storeName)
            }
          }
        })
        request.addEventListener('success', () => {
          const database = request.result
          try {
            assertCompatibleDatabase(database)
            database.addEventListener('versionchange', () => {
              this.databaseInvalidated = true
              this.databasePromise = null
              database.close()
            })
            resolve(database)
          } catch (error) {
            database.close()
            reject(error)
          }
        }, { once: true })
        request.addEventListener('error', () => reject(request.error), { once: true })
        request.addEventListener('blocked', () => {
          reject(new BrowserStorageError('storage_unavailable'))
        }, { once: true })
      })
    } catch (error) {
      throw mapBrowserStorageError(error)
    }
  }
}

function assertCompatibleDatabase(database: IDBDatabase): void {
  const actualStoreNames = Array.from(database.objectStoreNames)
  if (
    database.version !== DATABASE_VERSION
    || actualStoreNames.length !== STORE_NAMES.length
    || STORE_NAMES.some((storeName) => !database.objectStoreNames.contains(storeName))
  ) {
    throw resumeRejected()
  }

  let transaction: IDBTransaction
  try {
    transaction = database.transaction([...STORE_NAMES], 'readonly')
  } catch {
    throw resumeRejected()
  }
  for (const storeName of STORE_NAMES) {
    const store = transaction.objectStore(storeName)
    if (
      store.name !== storeName
      || store.keyPath !== null
      || store.autoIncrement
      || store.indexNames.length !== 0
    ) {
      throw resumeRejected()
    }
  }
}

function workflowCheckpoint(
  value: unknown,
  operationId: string,
): WorkflowCheckpointRecord {
  const record = versionedRecord(value)
  if (
    record.operationId !== operationId
    || !Object.hasOwn(record, 'checkpoint')
  ) {
    throw resumeRejected()
  }
  return {
    schemaVersion: 1,
    operationId,
    checkpoint: record.checkpoint,
  }
}

function encryptedUploadV2Checkpoint(
  value: unknown,
  operationId: string,
): EncryptedUploadV2CheckpointRecord {
  return workflowCheckpoint(value, operationId)
}

function verifiedDevice(value: unknown): VerifiedDeviceHint {
  const record = versionedRecord(value)
  return {
    schemaVersion: 1,
    serialNumber: recordString(record, 'serialNumber'),
    browserDeviceId: recordString(record, 'browserDeviceId'),
    name: nullableDisplayName(record.name),
    updatedAtEpochMs: safeNonnegativeInteger(record.updatedAtEpochMs),
  }
}

function recordingJournal(value: unknown): RecordingJournal {
  const record = versionedRecord(value)
  const phase = record.phase
  const profile = record.profile
  if (!RECORDING_PHASES.includes(phase as RecordingJournalPhase)) {
    throw resumeRejected()
  }
  if (profile !== 'legacy' && profile !== 'encrypted_upload_v2') {
    throw resumeRejected()
  }
  const journal: RecordingJournal = {
    schemaVersion: 1,
    operationId: recordString(record, 'operationId'),
    serialNumber: recordString(record, 'serialNumber'),
    recordingUuid: recordString(record, 'recordingUuid'),
    profile,
    phase: phase as RecordingJournalPhase,
    sinkId: recordString(record, 'sinkId'),
    uploadId: nullableIdentifier(record.uploadId),
    cloudCompletionId: nullableIdentifier(record.cloudCompletionId),
    confirmationDigestHex: nullableDigest(record.confirmationDigestHex),
    devicePlaintextSha256Hex: record.devicePlaintextSha256Hex === undefined
      ? null
      : nullableDigest(record.devicePlaintextSha256Hex),
    updatedAtEpochMs: safeNonnegativeInteger(record.updatedAtEpochMs),
  }
  assertRecordingEvidence(journal)
  return journal
}

function provisioningJournal(value: unknown): ProvisioningJournal {
  const record = versionedRecord(value)
  const phase = record.phase
  if (
    phase !== 'prepared'
    && phase !== 'device_applied'
    && phase !== 'backend_confirmed'
    && phase !== 'aborted'
  ) {
    throw resumeRejected()
  }
  return {
    schemaVersion: 1,
    attemptId: recordString(record, 'attemptId'),
    serialNumber: recordString(record, 'serialNumber'),
    phase,
    updatedAtEpochMs: safeNonnegativeInteger(record.updatedAtEpochMs),
  }
}

function firmwareJournal(value: unknown): FirmwareJournal {
  const record = versionedRecord(value)
  if (typeof record.downloadId !== 'bigint' || record.downloadId < 0n) {
    throw resumeRejected()
  }
  if (typeof record.verified !== 'boolean') throw resumeRejected()
  const sizeBytes = safeNonnegativeInteger(record.sizeBytes)
  const downloadedBytes = safeNonnegativeInteger(record.downloadedBytes)
  if (downloadedBytes > sizeBytes) throw resumeRejected()
  return {
    schemaVersion: 1,
    operationId: recordString(record, 'operationId'),
    serialNumber: recordString(record, 'serialNumber'),
    imageId: recordString(record, 'imageId'),
    downloadId: record.downloadId,
    version: recordString(record, 'version'),
    sizeBytes,
    crc32: unsigned32(record.crc32),
    sha256Hex: digest(record.sha256Hex),
    blobId: recordString(record, 'blobId'),
    downloadedBytes,
    verified: record.verified,
    updatedAtEpochMs: safeNonnegativeInteger(record.updatedAtEpochMs),
  }
}

function versionedRecord(value: unknown): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw resumeRejected()
  }
  const record = value as UnknownRecord
  if (record.schemaVersion !== 1) throw resumeRejected()
  return record
}

function recordString(record: UnknownRecord, key: string): string {
  return validPersistedIdentifier(record[key])
}

function validIdentifier(value: string): string {
  return validateStorageIdentifier(value)
}

function validPersistedIdentifier(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || !isWellFormedUtf16(value)
  ) {
    throw resumeRejected()
  }
  return value
}

function nullableIdentifier(value: unknown): string | null {
  if (value === null) return null
  return validPersistedIdentifier(value)
}

function nullableDisplayName(value: unknown): string | null {
  if (value === null || typeof value === 'string') return value
  throw resumeRejected()
}

function nullableDigest(value: unknown): string | null {
  return value === null ? null : digest(value)
}

function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw resumeRejected()
  }
  return value
}

function safeNonnegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw resumeRejected()
  }
  return value as number
}

function unsigned32(value: unknown): number {
  const result = safeNonnegativeInteger(value)
  if (result > 0xffff_ffff) throw resumeRejected()
  return result
}

function assertNextPhase<T extends string>(
  phases: readonly T[],
  previous: T,
  next: T,
): void {
  const previousIndex = phases.indexOf(previous)
  const nextIndex = phases.indexOf(next)
  if (nextIndex !== previousIndex && nextIndex !== previousIndex + 1) {
    throw resumeRejected()
  }
}

function assertNondecreasingTimestamp(
  previous: { updatedAtEpochMs: number },
  next: { updatedAtEpochMs: number },
): void {
  if (next.updatedAtEpochMs < previous.updatedAtEpochMs) throw resumeRejected()
}

function assertEstablishedEvidence(
  previous: string | null,
  next: string | null,
): void {
  if (previous !== null && previous !== next) throw resumeRejected()
}

function assertRecordingEvidence(journal: RecordingJournal): void {
  const phaseIndex = RECORDING_PHASES.indexOf(journal.phase)
  const uploadingIndex = RECORDING_PHASES.indexOf('uploading')
  const cloudCompletedIndex = RECORDING_PHASES.indexOf('cloud_completed')

  if (phaseIndex < uploadingIndex && journal.uploadId !== null) {
    throw resumeRejected()
  }
  if (
    phaseIndex < cloudCompletedIndex
    && (journal.cloudCompletionId !== null || journal.confirmationDigestHex !== null)
  ) {
    throw resumeRejected()
  }
  if (
    phaseIndex < RECORDING_PHASES.indexOf('staged')
    && journal.devicePlaintextSha256Hex !== null
  ) {
    throw resumeRejected()
  }

  if (journal.profile === 'legacy') {
    if (phaseIndex >= uploadingIndex && journal.uploadId === null) {
      throw resumeRejected()
    }
    if (phaseIndex >= cloudCompletedIndex && journal.cloudCompletionId === null) {
      throw resumeRejected()
    }
    if (journal.confirmationDigestHex !== null) throw resumeRejected()
    return
  }

  if (
    phaseIndex >= cloudCompletedIndex
    && journal.confirmationDigestHex === null
  ) {
    throw resumeRejected()
  }
}

function encodeKeyPart(value: string): string {
  if (!isWellFormedUtf16(value)) {
    throw new BrowserStorageError('invalid_input')
  }
  const bytes = new TextEncoder().encode(value)
  const hex = Array.from(
    bytes,
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('')
  return `${bytes.byteLength}:${hex}`
}

function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      index += 1
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false
    }
  }
  return true
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
  })
}

function resumeRejected(): BrowserStorageError {
  return new BrowserStorageError('resume_rejected')
}

function domExceptionName(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('name' in error)) return null
  return typeof error.name === 'string' ? error.name : null
}
