import type {
  CoreBridge,
  CoreDeviceRecording,
  CoreHostEvent,
  CoreIntegrityHasher,
} from './core.ts'
import type { DeviceManager } from './deviceManager.ts'
import {
  BotaSDKError,
  normalizeCoreError,
  type BotaOperation,
} from './errors.ts'
import {
  BOTA_STORAGE_SERVICE,
  DEVICE_INFORMATION_SERVICE,
  RECORDING_LIST_CHARACTERISTIC,
  SERIAL_NUMBER_CHARACTERISTIC,
  TRANSFER_CONTROL_CHARACTERISTIC,
} from './gatt.ts'
import type {
  DeviceRecording,
  RecordingJournalSummary,
  RecordingSyncOptions,
  RecordingSyncProgress,
  RecordingSyncResult,
} from './models.ts'
import type {
  LegacyUploadContext,
  RecordingUploadProvider,
  UploadRequestTemplate,
} from './providers.ts'
import {
  BrowserStorageError,
  type BrowserBlobHandle,
  type BrowserSdkStorage,
  type RecordingJournal,
  type RecordingJournalPhase,
} from './storage.ts'
import {
  BrowserTransportError,
  type BrowserBluetoothTransport,
  type BrowserDeviceHandle,
  type BrowserSubscription,
} from './transport.ts'
import {
  BrowserWorkflowRuntime,
  createBrowserPersistenceHost,
  type WorkflowEffectHost,
} from './workflowRuntime.ts'

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
}

interface ActiveRecordingOperation {
  controller: AbortController
  settled: Deferred<void>
  removeExternalAbort: () => void
}

interface ConnectedRecordingDevice {
  device: BrowserDeviceHandle
  serialNumber: string
}

interface RecordingSinkState {
  hasher: CoreIntegrityHasher
  finalized: boolean
}

const OPFS_STREAM_CHUNK_SIZE = 64 * 1024

export class RecordingManager {
  private readonly core: CoreBridge
  private readonly transport: BrowserBluetoothTransport
  private readonly runtime: BrowserWorkflowRuntime
  private readonly devices: DeviceManager
  private readonly storage: BrowserSdkStorage | null
  private readonly uploadProvider: RecordingUploadProvider | null
  private readonly fetcher: Fetcher
  private readonly now: () => number
  private readonly activeOperations = new Map<string, ActiveRecordingOperation>()
  private destroyed = false
  private destroyPromise: Promise<void> | null = null

  constructor(
    core: CoreBridge,
    transport: BrowserBluetoothTransport,
    runtime: BrowserWorkflowRuntime,
    devices: DeviceManager,
    storage: BrowserSdkStorage | null,
    uploadProvider: RecordingUploadProvider | null,
    fetcher: Fetcher = globalThis.fetch.bind(globalThis),
    now: () => number = Date.now,
  ) {
    this.core = core
    this.transport = transport
    this.runtime = runtime
    this.devices = devices
    this.storage = storage
    this.uploadProvider = uploadProvider
    this.fetcher = fetcher
    this.now = now
  }

  async list(): Promise<DeviceRecording[]> {
    this.ensureAvailable('transfer_recording')
    return await this.withVerifiedConnection(
      'transfer_recording',
      async ({ device }, signal) => {
        let subscription: BrowserSubscription | null = null
        const notification = deferred<Uint8Array>()
        let received = false
        try {
          subscription = await this.transport.subscribe(
            device,
            BOTA_STORAGE_SERVICE,
            RECORDING_LIST_CHARACTERISTIC,
            ({ characteristicUuid, value }) => {
              if (
                received
                || characteristicUuid.toLowerCase()
                  !== RECORDING_LIST_CHARACTERISTIC
              ) {
                return
              }
              received = true
              notification.resolve(value.slice())
            },
          )
          throwIfAborted(signal, 'transfer_recording')
          await awaitWithSignal(
            this.transport.write(
              device,
              BOTA_STORAGE_SERVICE,
              TRANSFER_CONTROL_CHARACTERISTIC,
              this.core.encodeRecordingListCommand(),
              true,
            ),
            signal,
            'transfer_recording',
          )
          const bytes = await awaitWithSignal(
            notification.promise,
            signal,
            'transfer_recording',
          )
          try {
            return this.core.decodeRecordingList(bytes).map(deviceRecording)
          } catch {
            throw new BotaSDKError('protocol_error', 'transfer_recording')
          }
        } finally {
          await subscription?.remove()
        }
      },
    )
  }

  async sync(
    recording: DeviceRecording,
    options: RecordingSyncOptions,
  ): Promise<RecordingSyncResult> {
    this.ensureAvailable('transfer_recording')
    if (options.profile === 'encrypted_upload_v2') {
      throw new BotaSDKError('unsupported_capability', 'transfer_recording')
    }
    if (options.profile !== 'legacy') {
      throw new BotaSDKError('invalid_input', 'transfer_recording')
    }
    validateRecording(recording)
    const storage = this.requireStorage()
    this.requireUploadProvider()
    throwIfAborted(options.signal, 'transfer_recording')
    const operationId = options.operationId ?? createOperationId()
    validateOperationId(operationId)
    return await this.runManagedOperation(
      operationId,
      options.signal,
      async (signal) => {
        if (await storage.loadRecordingJournal(operationId)) {
          throw new BotaSDKError('resume_rejected', 'transfer_recording')
        }
        const connection = await this.verifyConnection(signal)
        const prepared: RecordingJournal = {
          schemaVersion: 1,
          operationId,
          serialNumber: connection.serialNumber,
          recordingUuid: recording.uuid,
          profile: 'legacy',
          phase: 'prepared',
          sinkId: sinkId(operationId),
          uploadId: null,
          cloudCompletionId: null,
          confirmationDigestHex: null,
          updatedAtEpochMs: this.now(),
        }
        try {
          await storage.saveRecordingJournal(prepared)
          return await this.transferLegacy(
            prepared,
            recording,
            signal,
            options.onProgress,
          )
        } catch (error) {
          const normalized = recordingError(error, 'transfer_recording')
          if (normalized.code === 'cancelled') {
            const current = await storage.loadRecordingJournal(operationId)
              .catch(() => null)
            if (current) {
              await this.deleteUnverifiedState(current).catch(() => undefined)
            }
          }
          throw normalized
        }
      },
    )
  }

  async resume(
    operationId: string,
    options: Pick<RecordingSyncOptions, 'signal' | 'onProgress'> = {},
  ): Promise<RecordingSyncResult> {
    this.ensureAvailable('transfer_recording')
    validateOperationId(operationId)
    const storage = this.requireStorage()
    this.requireUploadProvider()
    throwIfAborted(options.signal, 'transfer_recording')
    const journal = await storage.loadRecordingJournal(operationId)
    if (!journal) throw new BotaSDKError('resume_rejected', 'transfer_recording')
    if (journal.profile !== 'legacy') {
      throw new BotaSDKError('unsupported_capability', 'transfer_recording')
    }

    if (journal.phase === 'confirmed') {
      return await this.finishConfirmedJournal(journal)
    }
    if (journal.phase === 'cloud_completed') {
      return await this.runManagedOperation(
        operationId,
        options.signal,
        async (signal) => await this.confirmJournal(journal, signal),
      )
    }

    const connected = this.requireConnectedDevice()
    if (connected.serialNumber !== journal.serialNumber) {
      throw new BotaSDKError('identity_mismatch', 'transfer_recording')
    }
    const recordings = await this.list()
    const recording = recordings.find(({ uuid }) => uuid === journal.recordingUuid)
    if (!recording) throw new BotaSDKError('resume_rejected', 'transfer_recording')
    validateRecording(recording)

    return await this.runManagedOperation(
      operationId,
      options.signal,
      async (signal) => {
        switch (journal.phase) {
          case 'prepared':
          case 'transferring':
            return await this.transferLegacy(
              journal,
              recording,
              signal,
              options.onProgress,
            )
          case 'staged':
            return await this.uploadStaged(journal, recording, signal)
          case 'uploading':
            return await this.reconcileUpload(journal, recording, signal)
          case 'cloud_completed':
            return await this.confirmJournal(journal, signal)
          case 'confirmed':
            return await this.finishConfirmedJournal(journal)
        }
      },
    )
  }

  async cancel(operationId: string): Promise<void> {
    validateOperationId(operationId)
    const active = this.activeOperations.get(operationId)
    if (active) {
      active.controller.abort()
      await this.runtime.cancel(operationId)
      await active.settled.promise
      return
    }

    const storage = this.requireStorage()
    const journal = await storage.loadRecordingJournal(operationId)
    if (!journal) return
    if (journal.phase === 'prepared' || journal.phase === 'transferring') {
      await this.deleteUnverifiedState(journal)
    }
  }

  async confirm(operationId: string): Promise<void> {
    this.ensureAvailable('upload')
    validateOperationId(operationId)
    const journal = await this.requireStorage().loadRecordingJournal(operationId)
    if (!journal) throw new BotaSDKError('resume_rejected', 'upload')
    if (journal.profile !== 'legacy') {
      throw new BotaSDKError('unsupported_capability', 'upload')
    }
    if (journal.phase === 'confirmed') {
      await this.finishConfirmedJournal(journal)
      return
    }
    if (journal.phase !== 'cloud_completed') {
      throw new BotaSDKError('resume_rejected', 'upload')
    }
    await this.confirmJournal(journal)
  }

  async listPendingOperations(): Promise<RecordingJournalSummary[]> {
    this.ensureAvailable('upload')
    return (await this.requireStorage().listRecordingJournals()).map((journal) => ({
      operationId: journal.operationId,
      serialNumber: journal.serialNumber,
      recordingUuid: journal.recordingUuid,
      profile: journal.profile,
      phase: journal.phase,
      updatedAtEpochMs: journal.updatedAtEpochMs,
    }))
  }

  destroy(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise
    this.destroyed = true
    this.destroyPromise = (async () => {
      const active = [...this.activeOperations.entries()]
      for (const [operationId, operation] of active) {
        operation.controller.abort()
        await this.runtime.cancel(operationId)
      }
      await Promise.all(active.map(([, operation]) => operation.settled.promise))
    })()
    return this.destroyPromise
  }

  private async transferLegacy(
    journal: RecordingJournal,
    recording: DeviceRecording,
    signal: AbortSignal,
    onProgress?: (progress: RecordingSyncProgress) => void,
  ): Promise<RecordingSyncResult> {
    const storage = this.requireStorage()
    throwIfAborted(signal, 'transfer_recording')
    await storage.deleteWorkflowCheckpoint(journal.operationId)
    const blob = await storage.openBlob(journal.sinkId)
    const currentSize = safeBrowserNumber(await blob.size(), 'transfer_recording')
    if (currentSize > 0) await blob.truncate(0)
    const transferring = await this.saveJournal(journal, {
      phase: 'transferring',
      uploadId: null,
      cloudCompletionId: null,
    })
    const sink = createRecordingSinkHost(
      journal.sinkId,
      blob,
      () => this.core.createIntegrityHasher(),
    )
    const cancellationId = randomCancellationId()
    const cancelRuntime = (): void => {
      void this.runtime.cancel(journal.operationId)
    }
    signal.addEventListener('abort', cancelRuntime, { once: true })

    try {
      const result = await this.runtime.run(
        journal.operationId,
        cancellationId,
        () => this.core.startRecordingTransfer({
          serialNumber: journal.serialNumber,
          recordingUuid: journal.recordingUuid,
          sinkId: journal.sinkId,
          totalUnits: recording.fileSizeBytes,
          cancellationId,
        }),
        {
          persistence: createBrowserPersistenceHost(storage),
          recordingSink: sink.host,
        },
        {
          onProgress: (completedBytes, totalBytes) => {
            onProgress?.({
              phase: 'transferring',
              completedBytes,
              totalBytes,
            })
          },
        },
      )
      const completed = [...result.notifications].reverse().find(
        (notification) => notification.kind === 'recording_transfer_completed',
      )
      if (
        !completed
        || completed.kind !== 'recording_transfer_completed'
        || !sink.state.finalized
      ) {
        throw new BotaSDKError('internal_error', 'transfer_recording')
      }
      const staged = await this.saveJournal(transferring, { phase: 'staged' })
      onProgress?.({
        phase: 'staged',
        completedBytes: BigInt(safeBrowserNumber(
          await blob.size(),
          'transfer_recording',
        )),
        totalBytes: recording.fileSizeBytes,
      })
      return await this.uploadStaged(
        staged,
        { ...recording, encrypted: completed.encrypted },
        signal,
      )
    } catch (error) {
      const normalized = recordingError(error, 'transfer_recording')
      if (normalized.code === 'cancelled' || normalized.code === 'integrity_failed') {
        await this.deleteUnverifiedState(transferring).catch(() => undefined)
      }
      throw normalized
    } finally {
      signal.removeEventListener('abort', cancelRuntime)
    }
  }

  private async uploadStaged(
    journal: RecordingJournal,
    recording: DeviceRecording,
    signal: AbortSignal,
  ): Promise<RecordingSyncResult> {
    const storage = this.requireStorage()
    const provider = this.requireUploadProvider()
    const blob = await storage.openBlob(journal.sinkId)
    const context = await this.legacyContext(journal, recording, blob, signal)
    let prepared: Awaited<ReturnType<RecordingUploadProvider['prepareLegacyUpload']>>
    try {
      prepared = await awaitWithSignal(
        provider.prepareLegacyUpload(context),
        signal,
        'upload',
      )
    } catch (error) {
      throw uploadError(error, signal)
    }
    validateProviderIdentifier(prepared.uploadId)
    validateUploadRequest(prepared.request)
    const uploading = await this.saveJournal(journal, {
      phase: 'uploading',
      uploadId: prepared.uploadId,
    })

    try {
      await this.uploadBlob(prepared.request, blob, signal)
      const completion = await awaitWithSignal(
        provider.completeLegacyUpload({
          ...context,
          uploadId: prepared.uploadId,
        }),
        signal,
        'upload',
      )
      validateProviderIdentifier(completion.cloudCompletionId)
      const cloudCompleted = await this.saveJournal(uploading, {
        phase: 'cloud_completed',
        cloudCompletionId: completion.cloudCompletionId,
      })
      return await this.confirmJournal(cloudCompleted, signal)
    } catch (error) {
      throw uploadError(error, signal)
    }
  }

  private async reconcileUpload(
    journal: RecordingJournal,
    recording: DeviceRecording,
    signal: AbortSignal,
  ): Promise<RecordingSyncResult> {
    if (!journal.uploadId) throw new BotaSDKError('resume_rejected', 'upload')
    const provider = this.requireUploadProvider()
    const blob = await this.requireStorage().openBlob(journal.sinkId)
    const context = await this.legacyContext(journal, recording, blob, signal)
    let reconciliation: Awaited<ReturnType<
      RecordingUploadProvider['reconcileLegacyUpload']
    >>
    try {
      reconciliation = await awaitWithSignal(
        provider.reconcileLegacyUpload({
          ...context,
          uploadId: journal.uploadId,
        }),
        signal,
        'upload',
      )
    } catch (error) {
      throw uploadError(error, signal)
    }

    if (reconciliation.state === 'cloud_completed') {
      validateProviderIdentifier(reconciliation.cloudCompletionId)
      const cloudCompleted = await this.saveJournal(journal, {
        phase: 'cloud_completed',
        cloudCompletionId: reconciliation.cloudCompletionId,
      })
      return await this.confirmJournal(cloudCompleted, signal)
    }
    if (reconciliation.state !== 'not_uploaded') {
      throw new BotaSDKError('upload_failed', 'upload', { retryable: true })
    }
    const staged = await this.saveJournal(journal, {
      phase: 'staged',
      uploadId: null,
    })
    return await this.uploadStaged(staged, recording, signal)
  }

  private async confirmJournal(
    journal: RecordingJournal,
    signal?: AbortSignal,
  ): Promise<RecordingSyncResult> {
    if (
      journal.profile !== 'legacy'
      || journal.phase !== 'cloud_completed'
      || !journal.cloudCompletionId
    ) {
      throw new BotaSDKError('resume_rejected', 'upload')
    }
    throwIfAborted(signal, 'upload')
    await this.withVerifiedConnection(
      'upload',
      async ({ device, serialNumber }, runtimeSignal) => {
        if (serialNumber !== journal.serialNumber) {
          throw new BotaSDKError('identity_mismatch', 'upload')
        }
        const combined = combineSignals(signal, runtimeSignal)
        await awaitWithSignal(
          this.transport.write(
            device,
            BOTA_STORAGE_SERVICE,
            TRANSFER_CONTROL_CHARACTERISTIC,
            this.core.encodeRecordingConfirm(journal.recordingUuid),
            true,
          ),
          combined,
          'upload',
        )
      },
    )
    const confirmed = await this.saveJournal(journal, { phase: 'confirmed' })
    return await this.finishConfirmedJournal(confirmed)
  }

  private async finishConfirmedJournal(
    journal: RecordingJournal,
  ): Promise<RecordingSyncResult> {
    if (journal.phase !== 'confirmed' || !journal.cloudCompletionId) {
      throw new BotaSDKError('resume_rejected', 'upload')
    }
    const storage = this.requireStorage()
    await (await storage.openBlob(journal.sinkId)).delete()
    await storage.deleteWorkflowCheckpoint(journal.operationId)
    await storage.deleteRecordingJournal(journal.operationId)
    return resultFromJournal(journal)
  }

  private async legacyContext(
    journal: RecordingJournal,
    recording: DeviceRecording,
    blob: BrowserBlobHandle,
    signal: AbortSignal,
  ): Promise<LegacyUploadContext> {
    const hasher = this.core.createIntegrityHasher()
    let streamedSize = 0
    for await (const chunk of blob.stream(OPFS_STREAM_CHUNK_SIZE)) {
      throwIfAborted(signal, 'upload')
      streamedSize = safeBrowserRange(
        streamedSize,
        chunk.byteLength,
        'upload',
      )
      hasher.update(chunk)
    }
    const reportedSize = safeBrowserNumber(await blob.size(), 'upload')
    if (reportedSize !== streamedSize) {
      throw new BotaSDKError('integrity_failed', 'upload')
    }
    return {
      operationId: journal.operationId,
      serialNumber: journal.serialNumber,
      recording,
      sizeBytes: BigInt(reportedSize),
      sha256Hex: hex(hasher.sha256Snapshot()),
      encrypted: recording.encrypted,
    }
  }

  private async uploadBlob(
    request: UploadRequestTemplate,
    blob: BrowserBlobHandle,
    signal: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal, 'upload')
    const body = blobReadableStream(blob, signal)
    const init: RequestInit & { duplex?: 'half' } = {
      method: 'PUT',
      headers: { ...request.headers },
      body,
      signal,
    }
    if (fetchRequiresDuplex()) init.duplex = 'half'
    const response = await awaitWithSignal(
      this.fetcher(request.url, init),
      signal,
      'upload',
    )
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new BotaSDKError('upload_failed', 'upload', { retryable: true })
    }
  }

  private async saveJournal(
    journal: RecordingJournal,
    update: {
      phase: RecordingJournalPhase
      uploadId?: string | null
      cloudCompletionId?: string | null
    },
  ): Promise<RecordingJournal> {
    const next: RecordingJournal = {
      ...journal,
      phase: update.phase,
      uploadId: update.uploadId === undefined
        ? journal.uploadId
        : update.uploadId,
      cloudCompletionId: update.cloudCompletionId === undefined
        ? journal.cloudCompletionId
        : update.cloudCompletionId,
      updatedAtEpochMs: Math.max(journal.updatedAtEpochMs, this.now()),
    }
    await this.requireStorage().saveRecordingJournal(next)
    return next
  }

  private async deleteUnverifiedState(journal: RecordingJournal): Promise<void> {
    if (journal.phase !== 'prepared' && journal.phase !== 'transferring') return
    const storage = this.requireStorage()
    await (await storage.openBlob(journal.sinkId)).delete()
    await storage.deleteWorkflowCheckpoint(journal.operationId)
    await storage.deleteRecordingJournal(journal.operationId)
  }

  private async verifyConnection(
    signal?: AbortSignal,
  ): Promise<ConnectedRecordingDevice> {
    throwIfAborted(signal, 'transfer_recording')
    return await this.withVerifiedConnection(
      'transfer_recording',
      async (connection, runtimeSignal) => {
        throwIfAborted(combineSignals(signal, runtimeSignal), 'transfer_recording')
        return connection
      },
    )
  }

  private async withVerifiedConnection<T>(
    operation: BotaOperation,
    body: (
      connection: ConnectedRecordingDevice,
      signal: AbortSignal,
    ) => Promise<T>,
  ): Promise<T> {
    const connection = this.requireConnectedDevice()
    try {
      return await this.runtime.runExclusive(operation, async (signal) => {
        const current = this.requireConnectedDevice()
        if (current.device.id !== connection.device.id) {
          throw new BotaSDKError('device_disconnected', operation)
        }
        const value = await awaitWithSignal(
          this.transport.read(
            current.device,
            DEVICE_INFORMATION_SERVICE,
            SERIAL_NUMBER_CHARACTERISTIC,
          ),
          signal,
          operation,
        )
        if (decodeSerial(value, operation) !== current.serialNumber) {
          throw new BotaSDKError('identity_mismatch', operation)
        }
        return await body(current, signal)
      })
    } catch (error) {
      const normalized = recordingError(error, operation)
      if (normalized.code === 'identity_mismatch') {
        await this.devices.disconnect().catch(() => undefined)
      }
      throw normalized
    }
  }

  private requireConnectedDevice(): ConnectedRecordingDevice {
    const connected = this.devices.connectedDevice
    const device = this.runtime.connectedDeviceHandle
    if (!connected || !device || connected.id !== device.id) {
      throw new BotaSDKError('device_disconnected', 'transfer_recording')
    }
    return { device, serialNumber: connected.serialNumber }
  }

  private async runManagedOperation<T>(
    operationId: string,
    externalSignal: AbortSignal | undefined,
    body: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    this.ensureAvailable('transfer_recording')
    if (this.activeOperations.has(operationId)) {
      throw new BotaSDKError('operation_in_progress', 'transfer_recording')
    }
    throwIfAborted(externalSignal, 'transfer_recording')
    const controller = new AbortController()
    const settled = deferred<void>()
    const abort = (): void => controller.abort()
    externalSignal?.addEventListener('abort', abort, { once: true })
    if (externalSignal?.aborted) controller.abort()
    const active: ActiveRecordingOperation = {
      controller,
      settled,
      removeExternalAbort: () => externalSignal?.removeEventListener('abort', abort),
    }
    this.activeOperations.set(operationId, active)
    try {
      return await body(controller.signal)
    } finally {
      active.removeExternalAbort()
      if (this.activeOperations.get(operationId) === active) {
        this.activeOperations.delete(operationId)
      }
      settled.resolve(undefined)
    }
  }

  private requireStorage(): BrowserSdkStorage {
    if (!this.storage) throw new BotaSDKError('storage_unavailable', 'upload')
    return this.storage
  }

  private requireUploadProvider(): RecordingUploadProvider {
    if (!this.uploadProvider) {
      throw new BotaSDKError('unsupported_capability', 'upload')
    }
    return this.uploadProvider
  }

  private ensureAvailable(operation: BotaOperation): void {
    if (this.destroyed) throw new BotaSDKError('cancelled', operation)
  }
}

function createRecordingSinkHost(
  sinkId: string,
  blob: BrowserBlobHandle,
  createHasher: () => CoreIntegrityHasher,
): { host: WorkflowEffectHost; state: RecordingSinkState } {
  const state: RecordingSinkState = {
    hasher: createHasher(),
    finalized: false,
  }
  const host: WorkflowEffectHost = {
    execute: async (envelope) => {
      const effect = envelope.effect
      try {
        switch (effect.kind) {
          case 'recording_sink_truncate': {
            assertSink(effect.sinkId, sinkId)
            const size = safeBrowserBigint(effect.completedUnits, 'transfer_recording')
            await blob.truncate(size)
            state.hasher = createHasher()
            let restored = 0
            for await (const chunk of blob.stream(OPFS_STREAM_CHUNK_SIZE)) {
              restored = safeBrowserRange(
                restored,
                chunk.byteLength,
                'transfer_recording',
              )
              state.hasher.update(chunk)
            }
            if (restored !== size) {
              return sinkFailure(envelope.requestId)
            }
            return {
              requestId: envelope.requestId,
              kind: 'recording_sink_truncated',
            }
          }
          case 'recording_sink_append': {
            assertSink(effect.sinkId, sinkId)
            const offset = safeBrowserNumber(
              await blob.size(),
              'transfer_recording',
            )
            const durable = safeBrowserRange(
              offset,
              effect.payload.byteLength,
              'transfer_recording',
            )
            await blob.write(offset, effect.payload)
            state.hasher.update(effect.payload)
            return {
              requestId: envelope.requestId,
              kind: 'recording_sink_append_completed',
              durableUnits: BigInt(durable),
            }
          }
          case 'recording_sink_finalize': {
            assertSink(effect.sinkId, sinkId)
            const size = safeBrowserNumber(
              await blob.size(),
              'transfer_recording',
            )
            if (
              effect.expectedCrc32 !== null
              && state.hasher.crc32() !== effect.expectedCrc32
            ) {
              return {
                requestId: envelope.requestId,
                kind: 'recording_sink_integrity_failed',
              }
            }
            state.finalized = true
            return {
              requestId: envelope.requestId,
              kind: 'recording_sink_finalized',
              durableUnits: BigInt(size),
            }
          }
          case 'recording_sink_discard':
            assertSink(effect.sinkId, sinkId)
            await blob.delete()
            return null
          default:
            throw new BotaSDKError('internal_error', 'transfer_recording')
        }
      } catch (error) {
        if (error instanceof BotaSDKError || error instanceof BrowserStorageError) {
          throw error
        }
        return sinkFailure(envelope.requestId)
      }
    },
    cancel: async () => undefined,
  }
  return { host, state }
}

function sinkFailure(requestId: bigint): CoreHostEvent {
  return {
    requestId,
    kind: 'recording_sink_failed',
    platformCode: null,
  }
}

function assertSink(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new BotaSDKError('internal_error', 'transfer_recording')
  }
}

function deviceRecording(recording: CoreDeviceRecording): DeviceRecording {
  return {
    uuid: recording.uuid,
    startedAtTimestampSeconds: recording.startedAtTimestampSeconds,
    durationMilliseconds: recording.durationMilliseconds,
    fileSizeBytes: recording.fileSizeBytes,
    codec: recording.codec,
    ...(recording.codecRaw === undefined ? {} : { codecRaw: recording.codecRaw }),
    encrypted: recording.encrypted,
    encryptedUploadV2: null,
  }
}

function validateRecording(recording: DeviceRecording): void {
  if (
    !Number.isSafeInteger(recording.startedAtTimestampSeconds)
    || recording.startedAtTimestampSeconds < 0
    || recording.durationMilliseconds < 0n
    || recording.fileSizeBytes < 0n
    || recording.fileSizeBytes > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new BotaSDKError('invalid_input', 'transfer_recording')
  }
}

function validateOperationId(operationId: string): void {
  if (operationId.length === 0 || !isWellFormedUtf16(operationId)) {
    throw new BotaSDKError('invalid_input', 'transfer_recording')
  }
}

function validateProviderIdentifier(value: unknown): asserts value is string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || !isWellFormedUtf16(value)
  ) {
    throw new BotaSDKError('upload_failed', 'upload')
  }
}

function validateUploadRequest(
  request: unknown,
): asserts request is UploadRequestTemplate {
  if (typeof request !== 'object' || request === null) {
    throw new BotaSDKError('upload_failed', 'upload')
  }
  const candidate = request as {
    method?: unknown
    url?: unknown
    headers?: unknown
  }
  if (candidate.method !== 'PUT' || typeof candidate.url !== 'string') {
    throw new BotaSDKError('upload_failed', 'upload')
  }
  let url: URL
  try {
    url = new URL(candidate.url)
  } catch {
    throw new BotaSDKError('upload_failed', 'upload')
  }
  if (url.protocol !== 'https:') {
    throw new BotaSDKError('upload_failed', 'upload')
  }
  if (
    typeof candidate.headers !== 'object'
    || candidate.headers === null
    || Array.isArray(candidate.headers)
  ) {
    throw new BotaSDKError('upload_failed', 'upload')
  }
  for (const [name, value] of Object.entries(candidate.headers)) {
    if (
      !name
      || typeof value !== 'string'
      || /[\r\n]/.test(name)
      || /[\r\n]/.test(value)
    ) {
      throw new BotaSDKError('upload_failed', 'upload')
    }
  }
}

function resultFromJournal(journal: RecordingJournal): RecordingSyncResult {
  if (!journal.cloudCompletionId) {
    throw new BotaSDKError('resume_rejected', 'upload')
  }
  return {
    operationId: journal.operationId,
    recordingUuid: journal.recordingUuid,
    profile: journal.profile,
    cloudCompletionId: journal.cloudCompletionId,
  }
}

function sinkId(operationId: string): string {
  return `recording:${operationId}`
}

function createOperationId(): string {
  return `transfer_recording:${crypto.randomUUID()}`
}

function randomCancellationId(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16))
}

function decodeSerial(value: Uint8Array, operation: BotaOperation): string {
  try {
    const serial = new TextDecoder('utf-8', { fatal: true })
      .decode(value)
      .replace(/^[\0\s]+|[\0\s]+$/g, '')
    if (!serial) throw new Error('empty serial')
    return serial
  } catch {
    throw new BotaSDKError('protocol_error', operation)
  }
}

function safeBrowserBigint(value: bigint, operation: BotaOperation): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new BotaSDKError('invalid_input', operation)
  }
  return Number(value)
}

function safeBrowserNumber(value: number, operation: BotaOperation): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BotaSDKError('invalid_input', operation)
  }
  return value
}

function safeBrowserRange(
  offset: number,
  length: number,
  operation: BotaOperation,
): number {
  safeBrowserNumber(offset, operation)
  safeBrowserNumber(length, operation)
  if (length > Number.MAX_SAFE_INTEGER - offset) {
    throw new BotaSDKError('invalid_input', operation)
  }
  return offset + length
}

function blobReadableStream(
  blob: BrowserBlobHandle,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const iterator = blob.stream(OPFS_STREAM_CHUNK_SIZE)[Symbol.asyncIterator]()
  return new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      try {
        throwIfAborted(signal, 'upload')
        const next = await iterator.next()
        if (next.done) {
          controller.close()
        } else {
          controller.enqueue(next.value)
        }
      } catch (error) {
        controller.error(recordingError(error, 'upload'))
      }
    },
    cancel: async () => {
      await iterator.return?.()
    },
  })
}

let duplexRequired: boolean | null = null

function fetchRequiresDuplex(): boolean {
  if (duplexRequired !== null) return duplexRequired
  if (typeof Request !== 'function' || typeof ReadableStream !== 'function') {
    duplexRequired = false
    return duplexRequired
  }
  try {
    new Request('https://example.invalid', {
      method: 'PUT',
      body: new ReadableStream<Uint8Array>(),
    })
    duplexRequired = false
  } catch {
    duplexRequired = true
  }
  return duplexRequired
}

async function awaitWithSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  operation: BotaOperation,
): Promise<T> {
  throwIfAborted(signal, operation)
  let rejectAbort!: (error: unknown) => void
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject
  })
  const onAbort = (): void => {
    rejectAbort(new BotaSDKError('cancelled', operation))
  }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([promise, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

function throwIfAborted(
  signal: AbortSignal | undefined,
  operation: BotaOperation,
): void {
  if (signal?.aborted) throw new BotaSDKError('cancelled', operation)
}

function combineSignals(
  first: AbortSignal | undefined,
  second: AbortSignal,
): AbortSignal {
  if (!first) return second
  return AbortSignal.any([first, second])
}

function recordingError(
  error: unknown,
  operation: BotaOperation,
): BotaSDKError {
  if (error instanceof BotaSDKError) return error
  if (error instanceof BrowserStorageError) {
    return new BotaSDKError(error.code, operation)
  }
  if (error instanceof BrowserTransportError) {
    const code = error.code === 'disconnected'
      ? 'device_disconnected'
      : error.code === 'permission_denied'
        ? 'permission_denied'
        : 'bluetooth_unavailable'
    return new BotaSDKError(code, operation)
  }
  return normalizeCoreError(error, operation)
}

function uploadError(error: unknown, signal: AbortSignal): BotaSDKError {
  if (signal.aborted) return new BotaSDKError('cancelled', 'upload')
  if (error instanceof BotaSDKError) return error
  if (error instanceof BrowserStorageError) {
    return new BotaSDKError(error.code, 'upload')
  }
  return new BotaSDKError('upload_failed', 'upload', { retryable: true })
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')
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
