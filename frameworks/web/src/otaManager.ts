import type {
  CoreBridge,
  CoreEffectEnvelope,
  CoreHostEvent,
  CoreIntegrityHasher,
  CoreWorkflowCheckpoint,
} from './core.ts'
import {
  verifyActiveDeviceSerial,
  type DeviceManager,
} from './deviceManager.ts'
import {
  BotaSDKError,
  normalizeCoreError,
  type BotaSDKErrorCode,
} from './errors.ts'
import type {
  FirmwareImageDescriptor,
  FirmwareUpdateOptions,
  FirmwareUpdateProgress,
} from './models.ts'
import type { FirmwareDownloadProvider } from './providers.ts'
import {
  BrowserStorageError,
  type BrowserSdkStorage,
  type FirmwareJournal,
  type VerifiedDeviceHint,
} from './storage.ts'
import {
  BrowserTransportError,
  type BrowserBluetoothTransport,
} from './transport.ts'
import {
  BrowserWorkflowRuntime,
  createBrowserPersistenceHost,
  type WorkflowEffectContext,
  type WorkflowEffectHost,
} from './workflowRuntime.ts'

type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

interface OTAManagerOptions {
  core: CoreBridge
  transport: BrowserBluetoothTransport
  runtime: BrowserWorkflowRuntime
  devices: DeviceManager
  storage?: BrowserSdkStorage | null
  provider?: FirmwareDownloadProvider | null
  fetcher?: Fetcher
  now?: () => number
}

interface ActiveFirmwareOperation {
  controller: AbortController
  settled: Promise<void>
  settle(): void
  removeExternalAbort(): void
}

interface DeferredVoid {
  promise: Promise<void>
  resolve(): void
}

const MAX_DOWNLOAD_WRITE_BYTES = 64 * 1024
const MAX_FIRMWARE_SIZE = 0xffff_ffff
const FIRMWARE_CHUNK_SIZE = 500
const CONNECTION_TIMEOUT_MS = 15_000n
const IDENTIFIER_PATTERN = /^\S(?:[\s\S]*\S)?$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/

export class OTAManager {
  private readonly core: CoreBridge
  private readonly transport: BrowserBluetoothTransport
  private readonly runtime: BrowserWorkflowRuntime
  private readonly devices: DeviceManager
  private readonly storage: BrowserSdkStorage | null
  private readonly provider: FirmwareDownloadProvider | null
  private readonly fetcher: Fetcher
  private readonly now: () => number
  private readonly activeOperations = new Map<
    string,
    ActiveFirmwareOperation
  >()
  private destroyed = false
  private destroyPromise: Promise<void> | null = null

  constructor(options: OTAManagerOptions) {
    this.core = options.core
    this.transport = options.transport
    this.runtime = options.runtime
    this.devices = options.devices
    this.storage = options.storage ?? null
    this.provider = options.provider ?? null
    this.fetcher = options.fetcher
      ?? ((input, init) => globalThis.fetch(input, init))
    this.now = options.now ?? Date.now
  }

  async updateFirmware(
    image: FirmwareImageDescriptor,
    options: FirmwareUpdateOptions = {},
  ): Promise<void> {
    this.ensureFirmwareCapability(options.signal)
    validateImage(image)
    const operationId = options.operationId ?? createOperationId()
    validateOperationId(operationId)
    const storage = this.requireStorage()
    this.requireProvider()

    await this.runManagedOperation(
      operationId,
      options.signal,
      async (signal) => {
        const [existingJournal, existingCheckpoint] = await Promise.all([
          storage.loadFirmwareJournal(operationId),
          storage.loadWorkflowCheckpoint(operationId),
        ])
        if (existingJournal || existingCheckpoint) {
          throw new BotaSDKError('resume_rejected', 'update_firmware')
        }
        throwIfAborted(signal)
        const connected = await verifyActiveDeviceSerial(
          this.devices,
          'update_firmware',
        )
        const hint = await this.loadReconnectHint(connected.serialNumber)
        if (hint.browserDeviceId !== connected.id) {
          throw new BotaSDKError('resume_rejected', 'update_firmware')
        }
        const journal = createJournal(
          operationId,
          connected.serialNumber,
          image,
          this.now,
        )
        await storage.saveFirmwareJournal(journal)
        throwIfAborted(signal)
        await this.runFirmwareWorkflow(
          journal,
          hint,
          signal,
          options.onProgress,
        )
      },
    )
  }

  async resumeFirmwareUpdate(
    operationId: string,
    options: Pick<FirmwareUpdateOptions, 'signal' | 'onProgress'> = {},
  ): Promise<void> {
    this.ensureFirmwareCapability(options.signal)
    validateOperationId(operationId)
    const storage = this.requireStorage()

    await this.runManagedOperation(
      operationId,
      options.signal,
      async (signal) => {
        const journal = await storage.loadFirmwareJournal(operationId)
        if (!journal) {
          throw new BotaSDKError('resume_rejected', 'update_firmware')
        }
        validateJournal(journal, operationId)
        const checkpoint = await storage.loadWorkflowCheckpoint(operationId)
        validateCheckpoint(checkpoint, journal)
        throwIfAborted(signal)
        if (firmwareJournalState(journal) === 'cleanup_only') {
          await this.finishFirmwareCleanup(journal)
          return
        }
        if (!journal.verified) this.requireProvider()
        const artifact = this.createArtifactHost(journal)
        if (journal.verified && !(await artifact.hasCompatibleVerifiedBlob())) {
          throw new BotaSDKError('resume_rejected', 'update_firmware')
        }
        const hint = await this.loadReconnectHint(journal.serialNumber)
        const reconnecting = checkpointPhase(checkpoint) === 'reconnecting'
        if (reconnecting) {
          this.runtime.registerDevice({
            id: hint.browserDeviceId,
            name: hint.name,
          })
        } else {
          let connected: { id: string; serialNumber: string }
          if (
            !this.devices.connectedDevice
            && !this.runtime.connectedDeviceHandle
          ) {
            connected = await this.recoverExactConnection(
              journal,
              hint,
              signal,
            )
          } else {
            connected = await verifyActiveDeviceSerial(
              this.devices,
              'update_firmware',
            )
          }
          if (
            connected.serialNumber !== journal.serialNumber
            || connected.id !== hint.browserDeviceId
          ) {
            throw new BotaSDKError('resume_rejected', 'update_firmware')
          }
        }

        throwIfAborted(signal)
        await this.runFirmwareWorkflow(
          journal,
          hint,
          signal,
          options.onProgress,
          artifact,
        )
      },
    )
  }

  async cancelFirmwareUpdate(operationId: string): Promise<void> {
    if (this.destroyed) {
      throw new BotaSDKError('cancelled', 'update_firmware')
    }
    validateOperationId(operationId)
    const active = this.activeOperations.get(operationId)
    if (active) {
      active.controller.abort()
      await this.runtime.cancel(operationId)
      await active.settled
      return
    }

    const storage = this.requireStorage()
    const journal = await storage.loadFirmwareJournal(operationId)
    if (!journal) return
    validateJournal(journal, operationId)
    if (firmwareJournalState(journal) === 'cleanup_only') {
      await this.finishFirmwareCleanup(journal)
      return
    }
    const artifact = this.createArtifactHost(journal)
    if (!journal.verified || !(await artifact.hasCompatibleVerifiedBlob())) {
      await artifact.deleteBlob()
    }
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
      await Promise.all(active.map(([, operation]) => operation.settled))
    })()
    return this.destroyPromise
  }

  private async runFirmwareWorkflow(
    journal: FirmwareJournal,
    hint: VerifiedDeviceHint,
    signal: AbortSignal,
    onProgress?: (progress: FirmwareUpdateProgress) => void,
    existingArtifact?: FirmwareArtifactHost,
  ): Promise<void> {
    const artifact = existingArtifact ?? this.createArtifactHost(journal)
    const cancellationId = randomBytes(16)
    throwIfAborted(signal)

    try {
      await this.runtime.run(
        journal.operationId,
        cancellationId,
        () => this.core.startFirmwareUpdate({
          serialNumber: journal.serialNumber,
          version: journal.version,
          sizeBytes: journal.sizeBytes,
          crc32: journal.crc32,
          downloadId: journal.downloadId,
          reconnectHint: {
            storedPeripheralId: hint.browserDeviceId,
            advertisedAddress: null,
            storedName: hint.name,
            scanTimeoutMs: CONNECTION_TIMEOUT_MS,
            connectionTimeoutMs: CONNECTION_TIMEOUT_MS,
          },
          cancellationId: cancellationId.slice(),
        }),
        {
          persistence: this.createFirmwarePersistenceHost(journal),
          network: artifact,
          firmwareBlob: artifact,
        },
        {
          onNotification: (notification) => {
            if (notification.kind !== 'firmware_progress') return
            onProgress?.({
              phase: notification.phase,
              completedBytes: notification.completedBytes,
              totalBytes: notification.totalBytes,
            })
          },
        },
        async (result) => {
          this.devices.adoptWorkflowConnection(result, journal.serialNumber)
          await this.finishFirmwareCleanup(journal)
        },
      )
    } catch (error) {
      const normalized = otaError(error)
      if (normalized.code === 'integrity_failed') {
        await this.deleteLatestBlob(journal).catch(() => undefined)
      }
      throw normalized
    }
  }

  private createArtifactHost(journal: FirmwareJournal): FirmwareArtifactHost {
    return new FirmwareArtifactHost({
      core: this.core,
      storage: this.requireStorage(),
      provider: this.provider,
      fetcher: this.fetcher,
      journal,
      now: this.now,
    })
  }

  private createFirmwarePersistenceHost(
    expected: FirmwareJournal,
  ): WorkflowEffectHost {
    const storage = this.requireStorage()
    const base = createBrowserPersistenceHost(storage, this.now)
    return {
      execute: async (envelope, context) => {
        if (envelope.effect.kind !== 'persistence_delete_checkpoint') {
          return await base.execute(envelope, context)
        }
        const latest = await storage.loadFirmwareJournal(expected.operationId)
        if (!latest) {
          throw new BotaSDKError('resume_rejected', 'update_firmware')
        }
        validateCompatibleJournal(latest, expected)
        if (firmwareJournalState(latest) !== 'cleanup_only') {
          await storage.saveFirmwareJournal({
            ...latest,
            state: 'cleanup_only',
            updatedAtEpochMs: Math.max(latest.updatedAtEpochMs, this.now()),
          })
        }
        await storage.deleteWorkflowCheckpoint(expected.operationId)
        return null
      },
      cancel: async () => {
        await base.cancel()
      },
    }
  }

  private async finishFirmwareCleanup(expected: FirmwareJournal): Promise<void> {
    const storage = this.requireStorage()
    const latest = await storage.loadFirmwareJournal(expected.operationId)
    if (!latest) return
    validateCompatibleJournal(latest, expected)
    if (firmwareJournalState(latest) !== 'cleanup_only') {
      throw new BotaSDKError('resume_rejected', 'update_firmware')
    }
    await storage.deleteWorkflowCheckpoint(expected.operationId)
    await (await storage.openBlob(latest.blobId)).delete()
    await storage.deleteFirmwareJournal(expected.operationId)
  }

  private async recoverExactConnection(
    journal: FirmwareJournal,
    hint: VerifiedDeviceHint,
    signal: AbortSignal,
  ): Promise<{ id: string; serialNumber: string }> {
    throwIfAborted(signal)
    let authorized: Awaited<ReturnType<BrowserBluetoothTransport['getAuthorizedDevices']>>
    try {
      authorized = await this.transport.getAuthorizedDevices()
    } catch (error) {
      throw asFirmwareError(error)
    }
    throwIfAborted(signal)
    const exact = authorized.find((device) => device.id === hint.browserDeviceId)
    if (!exact) throw new BotaSDKError('picker_required', 'update_firmware')

    this.runtime.registerDevice(exact)
    const cancellationId = randomBytes(16)
    const connectionOperationId = `connect:${bytesHex(cancellationId)}`
    const cancel = (): void => {
      void this.runtime.cancel(connectionOperationId).catch(() => undefined)
    }
    const running = this.runtime.run(
      connectionOperationId,
      cancellationId,
      () => this.core.startExactConnection({
        expectedSerialNumber: journal.serialNumber,
        peripheralId: exact.id,
        name: exact.name,
        cancellationId: cancellationId.slice(),
      }),
      { persistence: createBrowserPersistenceHost(this.requireStorage(), this.now) },
    )
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
    try {
      const result = await running
      const connected = this.devices.adoptWorkflowConnection(
        result,
        journal.serialNumber,
      )
      return { id: connected.id, serialNumber: connected.serialNumber }
    } catch (error) {
      throw asFirmwareError(error)
    } finally {
      signal.removeEventListener('abort', cancel)
    }
  }

  private async deleteLatestBlob(expected: FirmwareJournal): Promise<void> {
    const storage = this.requireStorage()
    const latest = await storage.loadFirmwareJournal(expected.operationId)
    if (!latest) return
    validateCompatibleJournal(latest, expected)
    await (await storage.openBlob(latest.blobId)).delete()
  }

  private async loadReconnectHint(
    serialNumber: string,
  ): Promise<VerifiedDeviceHint> {
    const hint = await this.requireStorage().loadVerifiedDevice(serialNumber)
    if (!hint || hint.serialNumber !== serialNumber) {
      throw new BotaSDKError('picker_required', 'update_firmware')
    }
    return hint
  }

  private requireConnectedDevice(): {
    id: string
    serialNumber: string
  } {
    const connected = this.devices.connectedDevice
    const runtimeDevice = this.runtime.connectedDeviceHandle
    if (!connected || !runtimeDevice || connected.id !== runtimeDevice.id) {
      throw new BotaSDKError('device_disconnected', 'update_firmware')
    }
    return { id: connected.id, serialNumber: connected.serialNumber }
  }

  private async runManagedOperation(
    operationId: string,
    externalSignal: AbortSignal | undefined,
    body: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    if (this.activeOperations.has(operationId)) {
      throw new BotaSDKError('operation_in_progress', 'update_firmware')
    }
    throwIfAborted(externalSignal)
    const controller = new AbortController()
    const settled = deferredVoid()
    const abort = (): void => controller.abort()
    const cancelRuntime = (): void => {
      void this.runtime.cancel(operationId).catch(() => undefined)
    }
    externalSignal?.addEventListener('abort', abort, { once: true })
    controller.signal.addEventListener('abort', cancelRuntime, { once: true })
    if (externalSignal?.aborted) controller.abort()
    const active: ActiveFirmwareOperation = {
      controller,
      settled: settled.promise,
      settle: settled.resolve,
      removeExternalAbort: () => {
        externalSignal?.removeEventListener('abort', abort)
      },
    }
    this.activeOperations.set(operationId, active)
    try {
      await body(controller.signal)
    } catch (error) {
      throw otaError(error)
    } finally {
      active.removeExternalAbort()
      controller.signal.removeEventListener('abort', cancelRuntime)
      if (this.activeOperations.get(operationId) === active) {
        this.activeOperations.delete(operationId)
      }
      active.settle()
    }
  }

  private ensureFirmwareCapability(signal?: AbortSignal): void {
    if (this.destroyed || signal?.aborted) {
      throw new BotaSDKError('cancelled', 'update_firmware')
    }
    if (!this.devices.getCapabilities().firmwareUpdate) {
      throw new BotaSDKError('unsupported_capability', 'update_firmware')
    }
  }

  private requireStorage(): BrowserSdkStorage {
    if (!this.storage) {
      throw new BotaSDKError('storage_unavailable', 'update_firmware')
    }
    return this.storage
  }

  private requireProvider(): FirmwareDownloadProvider {
    if (!this.provider) {
      throw new BotaSDKError('unsupported_capability', 'update_firmware')
    }
    return this.provider
  }
}

class FirmwareArtifactHost implements WorkflowEffectHost {
  private readonly core: CoreBridge
  private readonly storage: BrowserSdkStorage
  private readonly provider: FirmwareDownloadProvider | null
  private readonly fetcher: Fetcher
  private readonly journal: FirmwareJournal
  private readonly now: () => number
  private readonly fetchAbortController = new AbortController()
  private readonly pending = new Set<Promise<void>>()
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private cancelled = false

  constructor(options: {
    core: CoreBridge
    storage: BrowserSdkStorage
    provider: FirmwareDownloadProvider | null
    fetcher: Fetcher
    journal: FirmwareJournal
    now: () => number
  }) {
    this.core = options.core
    this.storage = options.storage
    this.provider = options.provider
    this.fetcher = options.fetcher
    this.journal = { ...options.journal }
    this.now = options.now
  }

  async execute(
    envelope: CoreEffectEnvelope,
    context: WorkflowEffectContext,
  ): Promise<CoreHostEvent | readonly CoreHostEvent[] | null> {
    switch (envelope.effect.kind) {
      case 'network_download':
        return await this.download(envelope, context)
      case 'firmware_blob_read_chunk':
        return await this.readChunk(envelope, context)
      default:
        throw new BotaSDKError('internal_error', 'update_firmware')
    }
  }

  async cancel(): Promise<void> {
    this.cancelled = true
    this.fetchAbortController.abort()
    const reader = this.reader
    if (reader) {
      await this.track(reader.cancel()).catch(() => undefined)
    }
    await this.awaitPending()

    const latest = await this.track(
      this.storage.loadFirmwareJournal(this.journal.operationId),
    ).catch(() => null)
    if (!latest) return
    try {
      validateCompatibleJournal(latest, this.journal)
    } catch {
      return
    }
    if (
      latest.verified
      && await this.hasCompatibleVerifiedBlob(latest, true)
    ) return
    await this.deleteBlob(latest).catch(() => undefined)
  }

  async hasCompatibleVerifiedBlob(
    candidate: FirmwareJournal = this.journal,
    allowCancelled = false,
  ): Promise<boolean> {
    try {
      if (this.cancelled && !allowCancelled) return false
      validateCompatibleJournal(candidate, this.journal)
      if (!candidate.verified || candidate.downloadedBytes !== candidate.sizeBytes) {
        return false
      }
      const blob = await this.track(this.storage.openBlob(candidate.blobId))
      if (this.cancelled && !allowCancelled) return false
      const size = safeBrowserNumber(await this.track(blob.size()))
      if (this.cancelled && !allowCancelled) return false
      if (size !== candidate.sizeBytes) return false
      const hasher = this.core.createIntegrityHasher()
      let offset = 0
      while (offset < size) {
        const maximumLength = Math.min(MAX_DOWNLOAD_WRITE_BYTES, size - offset)
        const bytes = await this.track(blob.read(offset, maximumLength))
        if (this.cancelled && !allowCancelled) return false
        if (bytes.byteLength !== maximumLength) return false
        hasher.update(bytes)
        offset = safeBrowserRange(offset, bytes.byteLength)
      }
      return hasher.length() === BigInt(candidate.sizeBytes)
        && hasher.crc32() === candidate.crc32
        && bytesHex(hasher.sha256Snapshot()) === candidate.sha256Hex
    } catch (error) {
      if (error instanceof BrowserStorageError) throw error
      return false
    }
  }

  async deleteBlob(candidate: FirmwareJournal = this.journal): Promise<void> {
    const blob = await this.track(this.storage.openBlob(candidate.blobId))
    await this.track(blob.delete())
  }

  private async download(
    envelope: Extract<CoreEffectEnvelope, { effect: { kind: 'network_download' } }>
      | CoreEffectEnvelope,
    context: WorkflowEffectContext,
  ): Promise<CoreHostEvent> {
    if (envelope.effect.kind !== 'network_download') {
      throw new BotaSDKError('internal_error', 'update_firmware')
    }
    if (envelope.effect.downloadId !== this.journal.downloadId) {
      throw new BotaSDKError('resume_rejected', 'update_firmware')
    }
    this.throwIfCancelled(context.signal)
    if (await this.hasCompatibleVerifiedBlob()) {
      await context.dispatch({
        requestId: envelope.requestId,
        kind: 'network_download_progress',
        downloadId: this.journal.downloadId,
        completedBytes: BigInt(this.journal.sizeBytes),
        totalBytes: BigInt(this.journal.sizeBytes),
      })
      return {
        requestId: envelope.requestId,
        kind: 'network_download_completed',
        downloadId: this.journal.downloadId,
        crc32: this.journal.crc32,
      }
    }
    this.throwIfCancelled(context.signal)

    const blob = await this.track(this.storage.openBlob(this.journal.blobId))
    this.throwIfCancelled(context.signal)
    await this.track(blob.truncate(0))
    this.throwIfCancelled(context.signal)

    const provider = this.provider
    if (!provider) {
      throw new BotaSDKError('unsupported_capability', 'update_firmware')
    }
    let request: Awaited<ReturnType<FirmwareDownloadProvider['resolve']>>
    try {
      request = await this.track(provider.resolve({
        operationId: this.journal.operationId,
        serialNumber: this.journal.serialNumber,
        image: publicImage(this.journal),
      }))
      this.throwIfCancelled(context.signal)
      validateDownloadRequest(request)
    } catch (error) {
      if (isCancelled(error, context.signal, this.cancelled)) {
        throw new BotaSDKError('cancelled', 'update_firmware')
      }
      await this.track(blob.delete()).catch(() => undefined)
      throw new BotaSDKError('upload_failed', 'update_firmware')
    }

    let response: Response
    try {
      response = await this.track(this.fetcher(request.url, {
        method: 'GET',
        headers: { ...request.headers },
        signal: this.fetchAbortController.signal,
        redirect: 'error',
      }))
      this.throwIfCancelled(context.signal)
    } catch (error) {
      if (isCancelled(error, context.signal, this.cancelled)) {
        throw new BotaSDKError('cancelled', 'update_firmware')
      }
      await this.track(blob.delete()).catch(() => undefined)
      throw new BotaSDKError('upload_failed', 'update_firmware')
    }

    try {
      if (!response.ok) {
        throw new BotaSDKError('upload_failed', 'update_firmware')
      }
      if (response.url) validateDownloadUrl(response.url)
      validateContentLength(response.headers.get('Content-Length'), this.journal)
      if (!response.body) {
        throw new BotaSDKError('upload_failed', 'update_firmware')
      }
      const reader = response.body.getReader()
      this.reader = reader
      const hasher = this.core.createIntegrityHasher()
      let offset = 0
      while (true) {
        const next = await this.track(reader.read())
        this.throwIfCancelled(context.signal)
        if (next.done) break
        const value = next.value
        for (
          let chunkOffset = 0;
          chunkOffset < value.byteLength;
          chunkOffset += MAX_DOWNLOAD_WRITE_BYTES
        ) {
          const chunk = value.subarray(
            chunkOffset,
            Math.min(chunkOffset + MAX_DOWNLOAD_WRITE_BYTES, value.byteLength),
          )
          const durable = safeBrowserRange(offset, chunk.byteLength)
          if (durable > this.journal.sizeBytes) {
            throw new BotaSDKError('integrity_failed', 'update_firmware')
          }
          await this.track(blob.write(offset, chunk))
          hasher.update(chunk)
          offset = durable
          this.throwIfCancelled(context.signal)
          await context.dispatch({
            requestId: envelope.requestId,
            kind: 'network_download_progress',
            downloadId: this.journal.downloadId,
            completedBytes: BigInt(offset),
            totalBytes: BigInt(this.journal.sizeBytes),
          })
        }
      }
      this.reader = null
      validateDownloadedArtifact(hasher, offset, this.journal)
      const verified: FirmwareJournal = {
        ...this.journal,
        downloadedBytes: this.journal.sizeBytes,
        verified: true,
        updatedAtEpochMs: Math.max(this.journal.updatedAtEpochMs, this.now()),
      }
      await this.track(this.storage.saveFirmwareJournal(verified))
      this.throwIfCancelled(context.signal)
      return {
        requestId: envelope.requestId,
        kind: 'network_download_completed',
        downloadId: this.journal.downloadId,
        crc32: hasher.crc32(),
      }
    } catch (error) {
      this.reader = null
      if (isCancelled(error, context.signal, this.cancelled)) {
        throw new BotaSDKError('cancelled', 'update_firmware')
      }
      await this.track(blob.delete()).catch(() => undefined)
      if (error instanceof BotaSDKError) throw error
      throw otaError(error)
    }
  }

  private async readChunk(
    envelope: CoreEffectEnvelope,
    context: WorkflowEffectContext,
  ): Promise<CoreHostEvent> {
    if (envelope.effect.kind !== 'firmware_blob_read_chunk') {
      throw new BotaSDKError('internal_error', 'update_firmware')
    }
    const effect = envelope.effect
    if (
      effect.downloadId !== this.journal.downloadId
      || !Number.isSafeInteger(effect.maxLength)
      || effect.maxLength <= 0
      || effect.maxLength > FIRMWARE_CHUNK_SIZE
    ) {
      throw new BotaSDKError('resume_rejected', 'update_firmware')
    }
    const latest = await this.track(
      this.storage.loadFirmwareJournal(this.journal.operationId),
    )
    if (!latest) throw new BotaSDKError('resume_rejected', 'update_firmware')
    validateCompatibleJournal(latest, this.journal)
    if (!latest.verified || latest.downloadedBytes !== latest.sizeBytes) {
      throw new BotaSDKError('resume_rejected', 'update_firmware')
    }
    const offset = safeBrowserBigint(effect.offset)
    const end = safeBrowserRange(offset, effect.maxLength)
    if (offset >= latest.sizeBytes || end > latest.sizeBytes) {
      throw new BotaSDKError('resume_rejected', 'update_firmware')
    }
    this.throwIfCancelled(context.signal)
    const blob = await this.track(this.storage.openBlob(latest.blobId))
    this.throwIfCancelled(context.signal)
    const bytes = await this.track(blob.read(offset, effect.maxLength))
    this.throwIfCancelled(context.signal)
    if (bytes.byteLength !== effect.maxLength) {
      throw new BotaSDKError('integrity_failed', 'update_firmware')
    }
    return {
      requestId: envelope.requestId,
      kind: 'firmware_chunk_read',
      downloadId: effect.downloadId,
      offset: effect.offset,
      bytes,
    }
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    let settlement!: Promise<void>
    settlement = promise.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      this.pending.delete(settlement)
    })
    this.pending.add(settlement)
    return promise
  }

  private async awaitPending(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending])
    }
  }

  private throwIfCancelled(signal: AbortSignal): void {
    if (this.cancelled || signal.aborted) {
      throw new BotaSDKError('cancelled', 'update_firmware')
    }
  }
}

function createJournal(
  operationId: string,
  serialNumber: string,
  image: FirmwareImageDescriptor,
  now: () => number,
): FirmwareJournal {
  const downloadId = randomDownloadId()
  return {
    schemaVersion: 1,
    operationId,
    serialNumber,
    imageId: image.imageId,
    downloadId,
    version: image.version,
    sizeBytes: image.sizeBytes,
    crc32: image.crc32,
    sha256Hex: image.sha256Hex,
    blobId: firmwareBlobId(operationId, image, downloadId),
    downloadedBytes: 0,
    verified: false,
    state: 'active',
    updatedAtEpochMs: now(),
  }
}

function validateImage(image: FirmwareImageDescriptor): void {
  if (
    typeof image !== 'object'
    || image === null
    || !validIdentifier(image.imageId)
    || !validIdentifier(image.version)
    || !Number.isSafeInteger(image.sizeBytes)
    || image.sizeBytes <= 0
    || image.sizeBytes > MAX_FIRMWARE_SIZE
    || !Number.isInteger(image.crc32)
    || image.crc32 < 0
    || image.crc32 > 0xffff_ffff
    || !SHA256_PATTERN.test(image.sha256Hex)
  ) {
    throw new BotaSDKError('invalid_input', 'update_firmware')
  }
}

function validateJournal(journal: FirmwareJournal, operationId: string): void {
  const image = publicImage(journal)
  validateImage(image)
  if (
    journal.schemaVersion !== 1
    || journal.operationId !== operationId
    || !validIdentifier(journal.operationId)
    || !validIdentifier(journal.serialNumber)
    || typeof journal.downloadId !== 'bigint'
    || journal.downloadId < 0n
    || journal.downloadId > 0xffff_ffff_ffff_ffffn
    || journal.blobId !== firmwareBlobId(operationId, image, journal.downloadId)
    || !Number.isSafeInteger(journal.downloadedBytes)
    || journal.downloadedBytes < 0
    || journal.downloadedBytes > journal.sizeBytes
    || typeof journal.verified !== 'boolean'
    || (journal.state !== undefined
      && journal.state !== 'active'
      && journal.state !== 'cleanup_only')
    || !Number.isSafeInteger(journal.updatedAtEpochMs)
    || journal.updatedAtEpochMs < 0
    || (journal.verified && journal.downloadedBytes !== journal.sizeBytes)
    || (firmwareJournalState(journal) === 'cleanup_only'
      && (!journal.verified || journal.downloadedBytes !== journal.sizeBytes))
  ) {
    throw new BotaSDKError('resume_rejected', 'update_firmware')
  }
}

function firmwareJournalState(
  journal: FirmwareJournal,
): 'active' | 'cleanup_only' {
  return journal.state ?? 'active'
}

function validateCompatibleJournal(
  actual: FirmwareJournal,
  expected: FirmwareJournal,
): void {
  validateJournal(actual, expected.operationId)
  if (
    actual.serialNumber !== expected.serialNumber
    || actual.imageId !== expected.imageId
    || actual.downloadId !== expected.downloadId
    || actual.version !== expected.version
    || actual.sizeBytes !== expected.sizeBytes
    || actual.crc32 !== expected.crc32
    || actual.sha256Hex !== expected.sha256Hex
    || actual.blobId !== expected.blobId
  ) {
    throw new BotaSDKError('resume_rejected', 'update_firmware')
  }
}

function validateCheckpoint(
  checkpoint: unknown,
  journal: FirmwareJournal,
): void {
  if (checkpoint === null) return
  if (typeof checkpoint !== 'object' || checkpoint === null) {
    throw new BotaSDKError('resume_rejected', 'update_firmware')
  }
  const value = checkpoint as Partial<CoreWorkflowCheckpoint>
  if (
    value.workflow !== 'firmware_update'
    || value.operation !== 'update_firmware'
    || value.serialNumber !== journal.serialNumber
    || value.firmwareVersion !== journal.version
    || (value.phase !== 'transferring'
      && value.phase !== 'verifying'
      && value.phase !== 'reconnecting')
    || typeof value.completedUnits !== 'bigint'
    || value.completedUnits < 0n
    || value.completedUnits > BigInt(journal.sizeBytes)
  ) {
    throw new BotaSDKError('resume_rejected', 'update_firmware')
  }
  if (!journal.verified || journal.downloadedBytes !== journal.sizeBytes) {
    throw new BotaSDKError('resume_rejected', 'update_firmware')
  }
}

function checkpointPhase(checkpoint: unknown): string | null {
  if (typeof checkpoint !== 'object' || checkpoint === null) return null
  const phase = (checkpoint as { phase?: unknown }).phase
  return typeof phase === 'string' ? phase : null
}

function publicImage(journal: FirmwareJournal): FirmwareImageDescriptor {
  return {
    imageId: journal.imageId,
    version: journal.version,
    sizeBytes: journal.sizeBytes,
    crc32: journal.crc32,
    sha256Hex: journal.sha256Hex,
  }
}

function firmwareBlobId(
  operationId: string,
  image: FirmwareImageDescriptor,
  downloadId: bigint,
): string {
  return [
    'firmware',
    encodeURIComponent(operationId),
    encodeURIComponent(image.imageId),
    encodeURIComponent(image.version),
    image.sizeBytes,
    image.crc32,
    image.sha256Hex,
    downloadId.toString(16),
  ].join(':')
}

function validateDownloadRequest(
  request: Awaited<ReturnType<FirmwareDownloadProvider['resolve']>>,
): void {
  if (
    typeof request !== 'object'
    || request === null
    || request.method !== 'GET'
    || typeof request.url !== 'string'
    || typeof request.headers !== 'object'
    || request.headers === null
  ) {
    throw new BotaSDKError('upload_failed', 'update_firmware')
  }
  validateDownloadUrl(request.url)
  try {
    const headers = new Headers()
    for (const [name, value] of Object.entries(request.headers)) {
      if (typeof value !== 'string' || /[\r\n]/.test(value)) {
        throw new Error('invalid header')
      }
      headers.set(name, value)
    }
  } catch {
    throw new BotaSDKError('upload_failed', 'update_firmware')
  }
}

function validateDownloadUrl(value: string): void {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new BotaSDKError('upload_failed', 'update_firmware')
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url))) {
    throw new BotaSDKError('upload_failed', 'update_firmware')
  }
}

function isLoopback(url: URL): boolean {
  const hostname = url.hostname.toLowerCase()
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '[::1]'
}

function validateContentLength(
  value: string | null,
  journal: FirmwareJournal,
): void {
  if (value === null) return
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new BotaSDKError('integrity_failed', 'update_firmware')
  }
  const length = Number(value)
  if (!Number.isSafeInteger(length) || length !== journal.sizeBytes) {
    throw new BotaSDKError('integrity_failed', 'update_firmware')
  }
}

function validateDownloadedArtifact(
  hasher: CoreIntegrityHasher,
  size: number,
  journal: FirmwareJournal,
): void {
  if (
    size !== journal.sizeBytes
    || hasher.length() !== BigInt(journal.sizeBytes)
    || hasher.crc32() !== journal.crc32
    || bytesHex(hasher.sha256Snapshot()) !== journal.sha256Hex
  ) {
    throw new BotaSDKError('integrity_failed', 'update_firmware')
  }
}

function createOperationId(): string {
  return `update_firmware:${bytesHex(randomBytes(16))}`
}

function randomDownloadId(): bigint {
  const bytes = randomBytes(8)
  let value = 0n
  for (const byte of bytes) value = (value << 8n) | BigInt(byte)
  return value
}

function randomBytes(length: number): Uint8Array {
  const value = new Uint8Array(length)
  globalThis.crypto.getRandomValues(value)
  return value
}

function validateOperationId(operationId: string): void {
  if (!validIdentifier(operationId)) {
    throw new BotaSDKError('invalid_input', 'update_firmware')
  }
}

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 1024
    && IDENTIFIER_PATTERN.test(value)
    && isWellFormedUtf16(value)
}

function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) return false
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false
    }
  }
  return true
}

function safeBrowserBigint(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new BotaSDKError('resume_rejected', 'update_firmware')
  }
  return Number(value)
}

function safeBrowserNumber(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BotaSDKError('resume_rejected', 'update_firmware')
  }
  return value
}

function safeBrowserRange(offset: number, length: number): number {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new BotaSDKError('resume_rejected', 'update_firmware')
  }
  return safeBrowserNumber(offset + length)
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new BotaSDKError('cancelled', 'update_firmware')
  }
}

function isCancelled(
  error: unknown,
  signal: AbortSignal,
  cancelled: boolean,
): boolean {
  return cancelled
    || signal.aborted
    || (error instanceof BotaSDKError && error.code === 'cancelled')
}

function otaError(error: unknown): BotaSDKError {
  if (error instanceof BotaSDKError) return error
  if (error instanceof BrowserStorageError) {
    return new BotaSDKError(error.code, 'update_firmware')
  }
  if (error instanceof BrowserTransportError) {
    const code: BotaSDKErrorCode = error.code === 'disconnected'
      ? 'device_disconnected'
      : error.code === 'permission_denied'
        ? 'permission_denied'
        : 'bluetooth_unavailable'
    return new BotaSDKError(code, 'update_firmware')
  }
  return normalizeCoreError(error, 'update_firmware')
}

function asFirmwareError(error: unknown): BotaSDKError {
  const normalized = otaError(error)
  if (normalized.operation === 'update_firmware') return normalized
  return new BotaSDKError(normalized.code, 'update_firmware', {
    retryable: normalized.retryable,
    protocolStatus: normalized.protocolStatus,
  })
}

function bytesHex(value: Uint8Array): string {
  return Array.from(
    value,
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('')
}

function deferredVoid(): DeferredVoid {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}
