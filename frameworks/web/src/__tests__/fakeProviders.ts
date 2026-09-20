import type {
  EncryptedUploadV2Material,
  EncryptedUploadV2ProviderContext,
  LegacyUploadContext,
  RecordingUploadProvider,
  UploadRequestTemplate,
} from '../providers.ts'
import type {
  BrowserBlobHandle,
  BrowserSdkStorage,
  FirmwareJournal,
  ProvisioningJournal,
  RecordingJournal,
  VerifiedDeviceHint,
} from '../storage.ts'

export interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

export class FakeRecordingUploadProvider implements RecordingUploadProvider {
  readonly prepared: LegacyUploadContext[] = []
  readonly completed: Array<LegacyUploadContext & { uploadId: string }> = []
  readonly reconciled: Array<LegacyUploadContext & { uploadId: string }> = []
  readonly events: string[]
  request: UploadRequestTemplate = {
    method: 'PUT',
    url: 'https://upload-secret.example.invalid/recording',
    headers: { Authorization: 'Bearer upload-secret' },
  }
  nextUploadId = 1
  cloudCompletionId = 'cloud-completion-1'
  reconcileResult:
    | { state: 'not_uploaded' }
    | { state: 'cloud_completed'; cloudCompletionId: string } = {
      state: 'not_uploaded',
    }
  prepareError: unknown = null
  completeError: unknown = null
  reconcileError: unknown = null

  constructor(events: string[] = []) {
    this.events = events
  }

  async prepareLegacyUpload(context: LegacyUploadContext): Promise<{
    uploadId: string
    request: UploadRequestTemplate
  }> {
    this.events.push('provider:prepare')
    this.prepared.push(context)
    if (this.prepareError) throw this.prepareError
    return {
      uploadId: `upload-${this.nextUploadId++}`,
      request: {
        method: this.request.method,
        url: this.request.url,
        headers: { ...this.request.headers },
      },
    }
  }

  async completeLegacyUpload(
    context: LegacyUploadContext & { uploadId: string },
  ): Promise<{ cloudCompletionId: string }> {
    this.events.push('provider:complete')
    this.completed.push(context)
    if (this.completeError) throw this.completeError
    return { cloudCompletionId: this.cloudCompletionId }
  }

  async reconcileLegacyUpload(
    context: LegacyUploadContext & { uploadId: string },
  ): Promise<
    | { state: 'not_uploaded' }
    | { state: 'cloud_completed'; cloudCompletionId: string }
  > {
    this.events.push('provider:reconcile')
    this.reconciled.push(context)
    if (this.reconcileError) throw this.reconcileError
    return this.reconcileResult
  }

  async prepareEncryptedUploadV2(
    _context: EncryptedUploadV2ProviderContext,
  ): Promise<EncryptedUploadV2Material> {
    throw new Error('Encrypted Upload v2 belongs to Task 7.')
  }
}

export class FakeRecordingStorage implements BrowserSdkStorage {
  readonly namespace: string
  readonly events: string[]
  readonly blobs = new Map<string, FakeRecordingBlob>()
  readonly workflowCheckpoints = new Map<string, unknown>()
  readonly recordingJournals = new Map<string, RecordingJournal>()
  readonly verifiedDevices = new Map<string, VerifiedDeviceHint>()
  onSaveRecordingJournal: ((journal: RecordingJournal) => void) | null = null
  openBlobCalls = 0

  constructor(
    namespace = 'organization:project:user',
    events: string[] = [],
  ) {
    this.namespace = namespace
    this.events = events
  }

  async loadVerifiedDevice(serialNumber: string): Promise<VerifiedDeviceHint | null> {
    const hint = this.verifiedDevices.get(serialNumber)
    return hint ? { ...hint } : null
  }

  async saveVerifiedDevice(value: VerifiedDeviceHint): Promise<void> {
    this.verifiedDevices.set(value.serialNumber, { ...value })
  }

  async deleteVerifiedDevice(serialNumber: string): Promise<void> {
    this.verifiedDevices.delete(serialNumber)
  }

  async loadWorkflowCheckpoint(operationId: string): Promise<unknown | null> {
    this.events.push('workflow:load')
    return this.workflowCheckpoints.get(operationId) ?? null
  }

  async saveWorkflowCheckpoint(
    operationId: string,
    checkpoint: unknown,
  ): Promise<void> {
    this.events.push('workflow:save')
    this.workflowCheckpoints.set(operationId, checkpoint)
  }

  async deleteWorkflowCheckpoint(operationId: string): Promise<void> {
    this.events.push('workflow:delete')
    this.workflowCheckpoints.delete(operationId)
  }

  async loadEncryptedUploadV2Checkpoint(_operationId: string): Promise<unknown | null> {
    return null
  }

  async saveEncryptedUploadV2Checkpoint(
    _operationId: string,
    _checkpoint: unknown,
  ): Promise<void> {}

  async deleteEncryptedUploadV2Checkpoint(_operationId: string): Promise<void> {}

  async loadRecordingJournal(operationId: string): Promise<RecordingJournal | null> {
    const journal = this.recordingJournals.get(operationId)
    return journal ? { ...journal } : null
  }

  async saveRecordingJournal(journal: RecordingJournal): Promise<void> {
    this.events.push(`journal:${journal.phase}`)
    this.recordingJournals.set(journal.operationId, { ...journal })
    this.onSaveRecordingJournal?.({ ...journal })
  }

  async listRecordingJournals(): Promise<RecordingJournal[]> {
    return [...this.recordingJournals.values()].map((journal) => ({ ...journal }))
  }

  async deleteRecordingJournal(operationId: string): Promise<void> {
    this.events.push('journal:delete')
    this.recordingJournals.delete(operationId)
  }

  async loadProvisioningJournal(_attemptId: string): Promise<ProvisioningJournal | null> {
    return null
  }

  async saveProvisioningJournal(_journal: ProvisioningJournal): Promise<void> {}

  async deleteProvisioningJournal(_attemptId: string): Promise<void> {}

  async loadFirmwareJournal(_operationId: string): Promise<FirmwareJournal | null> {
    return null
  }

  async saveFirmwareJournal(_journal: FirmwareJournal): Promise<void> {}

  async deleteFirmwareJournal(_operationId: string): Promise<void> {}

  async openBlob(blobId: string): Promise<FakeRecordingBlob> {
    this.openBlobCalls += 1
    this.events.push(`blob:open:${blobId}`)
    let blob = this.blobs.get(blobId)
    if (!blob) {
      blob = new FakeRecordingBlob(blobId, this.events)
      this.blobs.set(blobId, blob)
    }
    return blob
  }

  async clear(): Promise<void> {
    this.verifiedDevices.clear()
    this.workflowCheckpoints.clear()
    this.recordingJournals.clear()
    this.blobs.clear()
  }
}

export class FakeRecordingBlob implements BrowserBlobHandle {
  readonly id: string
  readonly events: string[]
  writeGate: Promise<void> | null = null
  writeError: unknown = null
  reportedSize: number | null = null
  writeCalls = 0
  deleteCalls = 0
  private bytes = new Uint8Array()

  constructor(id: string, events: string[] = []) {
    this.id = id
    this.events = events
  }

  seed(bytes: Uint8Array): void {
    this.bytes = bytes.slice()
  }

  snapshot(): Uint8Array {
    return this.bytes.slice()
  }

  async size(): Promise<number> {
    return this.reportedSize ?? this.bytes.byteLength
  }

  async truncate(size: number): Promise<void> {
    this.events.push(`blob:truncate:${size}`)
    if (!Number.isSafeInteger(size) || size < 0 || size > this.bytes.byteLength) {
      throw new Error('unsafe fake blob truncate')
    }
    this.bytes = this.bytes.slice(0, size)
  }

  async write(offset: number, bytes: Uint8Array): Promise<void> {
    this.writeCalls += 1
    this.events.push(`blob:write_begin:${offset}:${bytes.byteLength}`)
    if (this.writeGate) await this.writeGate
    if (this.writeError) throw this.writeError
    if (offset !== this.bytes.byteLength) throw new Error('non-append fake write')
    const next = new Uint8Array(offset + bytes.byteLength)
    next.set(this.bytes)
    next.set(bytes, offset)
    this.bytes = next
    this.events.push(`blob:write_durable:${this.bytes.byteLength}`)
  }

  async read(offset: number, maximumLength: number): Promise<Uint8Array> {
    return this.bytes.slice(offset, offset + maximumLength)
  }

  async *stream(chunkSize = 4): AsyncIterable<Uint8Array> {
    this.events.push('blob:stream')
    for (let offset = 0; offset < this.bytes.byteLength; offset += chunkSize) {
      const chunk = this.bytes.slice(offset, offset + chunkSize)
      this.events.push(`blob:stream_chunk:${chunk.byteLength}`)
      yield chunk
    }
  }

  async delete(): Promise<void> {
    this.deleteCalls += 1
    this.events.push('blob:delete')
    this.bytes = new Uint8Array()
  }
}
