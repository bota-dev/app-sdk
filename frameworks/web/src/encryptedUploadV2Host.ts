import type {
  CoreBridge,
  CoreEffectEnvelope,
  CoreEncryptedUploadV2Checkpoint,
  CoreEncryptedUploadV2Evidence,
  CoreEncryptedUploadV2OutboundTransferFrame,
  CoreEncryptedUploadV2TransferFrame,
  CoreHostEvent,
} from './core.ts'
import { BotaSDKError } from './errors.ts'
import {
  BOTA_STORAGE_SERVICE,
  RECORDING_LIST_V2_CHARACTERISTIC,
  RECORDING_TRANSFER_V2_CHARACTERISTIC,
  TRANSFER_CONTROL_V2_CHARACTERISTIC,
  TRANSFER_SIGNED_BLOB_V2_CHARACTERISTIC,
} from './gatt.ts'
import type {
  EncryptedUploadV2Material,
  EncryptedUploadV2Recording,
  UploadRequestTemplate,
} from './providers.ts'
import {
  BrowserStorageError,
  type BrowserBlobHandle,
  type BrowserSdkStorage,
} from './storage.ts'
import {
  BrowserTransportError,
  type BrowserBluetoothTransport,
  type BrowserDeviceHandle,
  type BrowserSubscription,
} from './transport.ts'
import type {
  WorkflowEffectContext,
  WorkflowEffectHost,
} from './workflowRuntime.ts'

type SignedBlobKind = 'authorization' | 'receipt'
type DataFrame = Extract<CoreEncryptedUploadV2TransferFrame, { kind: 'data' }>
type WindowEndFrame = Extract<
  CoreEncryptedUploadV2TransferFrame,
  { kind: 'window_end' }
>

export interface EncryptedUploadV2ListResult {
  entries: Array<Extract<
    CoreEncryptedUploadV2TransferFrame,
    { kind: 'recording_entry' }
  >>
  listRevision: number
}

export interface EncryptedUploadV2TransferRequest {
  transportSessionId: bigint
  uploadSessionUuid: string
  recordingUuid: string
  recordingGeneration: number
  authorizationSha256: Uint8Array
  expectedCiphertextLength: bigint
  expectedCiphertextSha256: Uint8Array
  expectedCheckpointIntervalBlocks: number
  windowPackets: number
  dataPayloadBytes: number
}

export type EncryptedUploadV2TransferContinuation =
  | { kind: 'window' }
  | { kind: 'manifest' }
  | { kind: 'repair'; missingSequences: number[] }

export type EncryptedUploadV2OpenResult =
  | {
      kind: 'opened'
      notifications: AsyncIterable<CoreEncryptedUploadV2TransferFrame>
    }
  | { kind: 'resume_rejected' }

export interface EncryptedUploadV2NativeCheckpoint {
  revision: number
  nextCiphertextOffset: bigint
  prefixSha256: Uint8Array
  highestContiguousSequence: number | null
}

export type EncryptedUploadV2ReceiverEvent =
  | {
      kind: 'window_staged'
      checkpoint: EncryptedUploadV2NativeCheckpoint
      missingSequences: number[]
    }
  | {
      kind: 'completed'
      manifest: Uint8Array
      evidence: CoreEncryptedUploadV2Evidence
    }

interface TransferReceiverOptions {
  transportSessionId: bigint
  expectedCiphertextLength: bigint
  expectedCiphertextSha256: Uint8Array
  maximumDataPayloadBytes: number
  maximumWindowPackets: number
  maximumMissingSequences: number
  checkpoint: EncryptedUploadV2NativeCheckpoint
}

interface PendingWindow {
  boundary: WindowEndFrame
  checkpoint: EncryptedUploadV2NativeCheckpoint
  missingSequences: number[]
  highestContiguousSequence: number
  contiguousOffset: bigint
  contiguousSha256: Uint8Array
  persisted: boolean
}

interface PacketMetadata {
  offset: bigint
  bytes: Uint8Array
  sha256: Uint8Array
}

const MAXIMUM_FRAME_BYTES = 512
const MAXIMUM_QUEUED_BYTES = 1024 * 1024
const MANIFEST_LENGTH = 580
const EMPTY_SHA256_HEX =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

export class EncryptedUploadV2SignedBlobWriter {
  private readonly core: CoreBridge
  private readonly transport: BrowserBluetoothTransport
  private readonly device: BrowserDeviceHandle
  private readonly onOwnershipUncertain: () => void
  private active = false
  private activeAbort: AbortController | null = null
  private cancelled = false

  constructor(
    core: CoreBridge,
    transport: BrowserBluetoothTransport,
    device: BrowserDeviceHandle,
    onOwnershipUncertain: () => void = () => undefined,
  ) {
    this.core = core
    this.transport = transport
    this.device = device
    this.onOwnershipUncertain = onOwnershipUncertain
  }

  async send(
    blobKind: SignedBlobKind,
    writeId: number,
    value: Uint8Array,
    maximumBlobBytes: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.active) throw operationInProgress()
    if (
      this.cancelled
      || signal?.aborted
      || !isUint32(writeId)
      || writeId === 0
      || value.byteLength === 0
      || value.byteLength > maximumBlobBytes
      || value.byteLength > 0xffff
    ) {
      throw this.cancelled || signal?.aborted
        ? cancelled()
        : protocolFailure()
    }
    this.active = true
    const ownedAbort = new AbortController()
    this.activeAbort = ownedAbort
    const activeSignal = signal
      ? AbortSignal.any([signal, ownedAbort.signal])
      : ownedAbort.signal
    let subscription: BrowserSubscription | null = null
    let began = false
    let terminalResultReceived = false
    let primary: unknown = null
    const result = deferred<void>()
    let unmatchedResults = 0
    let unmatchedBytes = 0
    try {
      subscription = await this.transport.subscribe(
        this.device,
        BOTA_STORAGE_SERVICE,
        TRANSFER_SIGNED_BLOB_V2_CHARACTERISTIC,
        ({ characteristicUuid, value: notification }) => {
          if (characteristicUuid.toLowerCase()
            !== TRANSFER_SIGNED_BLOB_V2_CHARACTERISTIC) return
          try {
            const decoded = this.core.decodeEncryptedUploadV2SignedBlobResult(
              notification,
            )
            if (decoded.blobKind === blobKind && decoded.writeId === writeId) {
              terminalResultReceived = true
              if (decoded.result === 0) result.resolve(undefined)
              else result.reject(new BotaSDKError(
                'protocol_error',
                'transfer_recording',
                { protocolStatus: decoded.result },
              ))
              return
            }
            unmatchedResults += 1
            unmatchedBytes += notification.byteLength
            if (unmatchedResults > 64 || unmatchedBytes > 32 * 1024) {
              result.reject(protocolFailure())
            }
          } catch (error) {
            result.reject(protocolFailure(error))
          }
        },
      )
      throwIfCancelled(this.cancelled, activeSignal)
      const frameLimit = Math.min(
        this.transport.maximumWriteValueLength,
        MAXIMUM_FRAME_BYTES,
      )
      if (frameLimit < 64) throw protocolFailure()
      const digest = sha256(this.core, value)
      began = true
      await this.write(this.core.encodeEncryptedUploadV2SignedBlob({
        kind: 'begin',
        blobKind,
        writeId,
        totalLength: value.byteLength,
        sha256: digest,
      }), frameLimit)
      for (let offset = 0; offset < value.byteLength;) {
        throwIfCancelled(this.cancelled, activeSignal)
        const length = this.largestChunk(
          blobKind,
          writeId,
          offset,
          value,
          frameLimit,
        )
        await this.write(this.core.encodeEncryptedUploadV2SignedBlob({
          kind: 'data',
          blobKind,
          writeId,
          offset,
          data: value.slice(offset, offset + length),
        }), frameLimit)
        offset += length
      }
      await this.write(this.core.encodeEncryptedUploadV2SignedBlob({
        kind: 'commit',
        blobKind,
        writeId,
      }), frameLimit)
      await abortable(result.promise, activeSignal)
    } catch (error) {
      primary = error
    } finally {
      let cleanupError: unknown = null
      if (primary !== null && began && !terminalResultReceived) {
        try {
          const frameLimit = Math.min(
            this.transport.maximumWriteValueLength,
            MAXIMUM_FRAME_BYTES,
          )
          await this.write(this.core.encodeEncryptedUploadV2SignedBlob({
            kind: 'abort',
            blobKind,
            writeId,
          }), frameLimit)
        } catch (error) {
          cleanupError = error
        }
      }
      try {
        await subscription?.remove()
      } catch (error) {
        cleanupError ??= error
      }
      this.active = false
      if (this.activeAbort === ownedAbort) this.activeAbort = null
      if (cleanupError !== null) this.onOwnershipUncertain()
      if (primary !== null) throw normalizeHostError(primary)
      if (cleanupError !== null) throw ownershipUnknown(cleanupError)
    }
  }

  async cancel(): Promise<void> {
    this.cancelled = true
    this.activeAbort?.abort()
  }

  private largestChunk(
    blobKind: SignedBlobKind,
    writeId: number,
    offset: number,
    value: Uint8Array,
    frameLimit: number,
  ): number {
    let low = 1
    let high = Math.min(value.byteLength - offset, 0xffff - offset)
    let best = 0
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      const frame = this.core.encodeEncryptedUploadV2SignedBlob({
        kind: 'data',
        blobKind,
        writeId,
        offset,
        data: value.slice(offset, offset + middle),
      })
      if (frame.byteLength <= frameLimit) {
        best = middle
        low = middle + 1
      } else {
        high = middle - 1
      }
    }
    if (best === 0) throw protocolFailure()
    return best
  }

  private async write(frame: Uint8Array, frameLimit: number): Promise<void> {
    if (frame.byteLength > frameLimit) throw protocolFailure()
    await this.transport.write(
      this.device,
      BOTA_STORAGE_SERVICE,
      TRANSFER_SIGNED_BLOB_V2_CHARACTERISTIC,
      frame,
      true,
    )
  }
}

export class EncryptedUploadV2TransferControl {
  private readonly core: CoreBridge
  private readonly transport: BrowserBluetoothTransport
  private readonly device: BrowserDeviceHandle
  private readonly onOwnershipUncertain: () => void
  private active = false
  private session: TransferSession | null = null

  constructor(
    core: CoreBridge,
    transport: BrowserBluetoothTransport,
    device: BrowserDeviceHandle,
    onOwnershipUncertain: () => void = () => undefined,
  ) {
    this.core = core
    this.transport = transport
    this.device = device
    this.onOwnershipUncertain = onOwnershipUncertain
  }

  async open(
    request: EncryptedUploadV2TransferRequest,
    checkpoint: EncryptedUploadV2NativeCheckpoint | null,
    signal?: AbortSignal,
  ): Promise<EncryptedUploadV2OpenResult> {
    if (this.session) throw operationInProgress()
    validateTransferRequest(request)
    throwIfCancelled(false, signal)
    const queue = new BoundedFrameQueue()
    const control = deferred<CoreEncryptedUploadV2TransferFrame>()
    const session: TransferSession = {
      request: copyTransferRequest(request),
      subscription: null,
      queue,
      phase: 'awaiting_control',
      pendingNotifications: [],
      pendingNotificationBytes: 0,
      repairSequences: null,
      confirmationAttempted: false,
      confirmationSucceeded: false,
    }
    this.session = session
    let writeAttempted = false
    try {
      session.subscription = await this.transport.subscribe(
        this.device,
        BOTA_STORAGE_SERVICE,
        RECORDING_TRANSFER_V2_CHARACTERISTIC,
        ({ characteristicUuid, value }) => {
          if (characteristicUuid.toLowerCase()
            !== RECORDING_TRANSFER_V2_CHARACTERISTIC) return
          try {
            const frame = this.core.decodeEncryptedUploadV2Transfer(value)
            if (frame.transportSessionId !== request.transportSessionId) {
              throw identityFailure()
            }
            if (session.phase === 'awaiting_control') {
              session.phase = 'control_pending'
              control.resolve(frame)
              return
            }
            if (session.phase === 'control_pending') {
              if (
                session.pendingNotificationBytes + value.byteLength
                > MAXIMUM_QUEUED_BYTES
              ) throw protocolFailure()
              session.pendingNotificationBytes += value.byteLength
              session.pendingNotifications.push({
                frame,
                rawLength: value.byteLength,
              })
              return
            }
            this.acceptTransferFrame(session, frame, value.byteLength)
          } catch (error) {
            const normalized = normalizeHostError(error)
            control.reject(normalized)
            queue.fail(normalized)
          }
        },
      )
      throwIfCancelled(false, signal)
      const frame = checkpoint
        ? this.core.encodeEncryptedUploadV2Transfer({
            kind: 'resume_request',
            flags: 0,
            transportSessionId: request.transportSessionId,
            uploadSessionUuid: request.uploadSessionUuid,
            recordingUuid: request.recordingUuid,
            recordingGeneration: request.recordingGeneration,
            checkpointRevision: checkpoint.revision,
            nextCiphertextOffset: checkpoint.nextCiphertextOffset,
            prefixSha256: checkpoint.prefixSha256,
            windowPackets: request.windowPackets,
            dataPayloadBytes: request.dataPayloadBytes,
          })
        : this.core.encodeEncryptedUploadV2Transfer({
            kind: 'start',
            flags: 0,
            transportSessionId: request.transportSessionId,
            uploadSessionUuid: request.uploadSessionUuid,
            recordingUuid: request.recordingUuid,
            recordingGeneration: request.recordingGeneration,
            authorizationSha256: request.authorizationSha256,
            checkpointRevision: 0,
            nextCiphertextOffset: 0n,
            prefixSha256: initialEncryptedUploadV2Checkpoint().prefixSha256,
            windowPackets: request.windowPackets,
            dataPayloadBytes: request.dataPayloadBytes,
          })
      session.phase = 'awaiting_control'
      writeAttempted = true
      await this.writeControl(frame)
      const response = await abortable(control.promise, signal)
      if (response.kind === 'resume_reject') {
        if (
          !checkpoint
          || response.reason === 0
          || response.checkpointRevision !== checkpoint.revision
          || response.nextCiphertextOffset !== checkpoint.nextCiphertextOffset
          || !equalBytes(response.prefixSha256, checkpoint.prefixSha256)
        ) throw identityFailure()
        await this.release(false)
        return { kind: 'resume_rejected' }
      }
      if (response.kind === 'error') {
        const expectedType = checkpoint ? 0x22 : 0x20
        if (response.result === 0 || response.failedMessageType !== expectedType) {
          throw identityFailure()
        }
        const rejection = new BotaSDKError(
          'protocol_error',
          'transfer_recording',
          { protocolStatus: response.result },
        )
        await this.release(false)
        throw rejection
      }
      if (checkpoint) {
        if (response.kind !== 'resume_accept') throw identityFailure()
        validateResumeAcknowledgement(request, checkpoint, response)
      } else {
        if (response.kind !== 'start_ack') throw identityFailure()
        validateStartAcknowledgement(request, response)
      }
      session.phase = checkpoint?.nextCiphertextOffset
        === request.expectedCiphertextLength
        ? 'manifest'
        : 'window'
      for (const pending of session.pendingNotifications.splice(0)) {
        this.acceptTransferFrame(
          session,
          pending.frame,
          pending.rawLength,
        )
      }
      session.pendingNotificationBytes = 0
      return { kind: 'opened', notifications: queue }
    } catch (error) {
      await this.release(writeAttempted).catch(() => undefined)
      throw normalizeHostError(error)
    }
  }

  async sendActiveFrame(
    frame: Extract<
      CoreEncryptedUploadV2OutboundTransferFrame,
      { kind: 'window_ack' }
    >,
    continuation: EncryptedUploadV2TransferContinuation,
  ): Promise<void> {
    const session = this.requireSession(frame.transportSessionId)
    if (session.phase !== 'paused') throw protocolFailure()
    session.phase = continuation.kind
    session.repairSequences = continuation.kind === 'repair'
      ? new Set(continuation.missingSequences)
      : null
    try {
      await this.writeControl(this.core.encodeEncryptedUploadV2Transfer(frame))
    } catch (error) {
      this.onOwnershipUncertain()
      session.queue.fail(ownershipUnknown(error))
      throw ownershipUnknown(error)
    }
  }

  async confirm(
    frame: Extract<
      CoreEncryptedUploadV2OutboundTransferFrame,
      { kind: 'confirm' }
    >,
    writeSucceeded: () => Promise<void>,
  ): Promise<void> {
    const session = this.requireSession(frame.transportSessionId)
    if (session.phase !== 'paused' && session.phase !== 'terminal') {
      throw protocolFailure()
    }
    session.phase = 'confirming'
    session.confirmationAttempted = true
    try {
      await this.writeControl(this.core.encodeEncryptedUploadV2Transfer(frame))
      session.confirmationSucceeded = true
      await writeSucceeded()
      session.phase = 'confirmed'
      await this.release(false, true)
    } catch (error) {
      this.onOwnershipUncertain()
      throw ownershipUnknown(error)
    }
  }

  async confirmationAttemptedOrClaimCancellation(): Promise<boolean> {
    const session = this.session
    if (!session) return false
    if (
      session.confirmationAttempted
      || session.phase === 'confirming'
      || session.phase === 'confirmed'
    ) return true
    session.phase = 'cleaning'
    return false
  }

  async abort(reason = 0x00ff): Promise<void> {
    await this.release(true, false, reason)
  }

  async cancel(): Promise<void> {
    await this.abort()
  }

  private acceptTransferFrame(
    session: TransferSession,
    frame: CoreEncryptedUploadV2TransferFrame,
    rawLength: number,
  ): void {
    if (frame.kind === 'error') {
      session.phase = 'terminal'
      session.queue.push(frame, rawLength)
      return
    }
    switch (session.phase) {
      case 'window':
        if (frame.kind !== 'data' && frame.kind !== 'window_end') {
          throw protocolFailure()
        }
        if (frame.kind === 'window_end') session.phase = 'paused'
        break
      case 'manifest':
        if (frame.kind !== 'manifest_chunk' && frame.kind !== 'eof') {
          throw protocolFailure()
        }
        if (frame.kind === 'eof') session.phase = 'terminal'
        break
      case 'repair':
        if (frame.kind === 'data') {
          if (!session.repairSequences?.delete(frame.sequence)) {
            throw protocolFailure()
          }
        } else if (frame.kind === 'window_end') {
          if (session.repairSequences && session.repairSequences.size > 0) {
            throw protocolFailure()
          }
          session.phase = 'paused'
        } else {
          throw protocolFailure()
        }
        break
      default:
        throw protocolFailure()
    }
    session.queue.push(frame, rawLength)
  }

  private requireSession(transportSessionId: bigint): TransferSession {
    const session = this.session
    if (!session || session.request.transportSessionId !== transportSessionId) {
      throw identityFailure()
    }
    return session
  }

  private async release(
    abort: boolean,
    confirmed = false,
    reason = 0x00ff,
  ): Promise<void> {
    const session = this.session
    if (!session) return
    if (
      !confirmed
      && (session.phase === 'confirming' || session.phase === 'confirmed')
    ) throw ownershipUnknown()
    let failure: unknown = null
    if (abort) {
      try {
        await this.writeControl(this.core.encodeEncryptedUploadV2Transfer({
          kind: 'abort',
          flags: 0,
          transportSessionId: session.request.transportSessionId,
          reason,
        }))
      } catch (error) {
        failure = error
      }
    }
    try {
      await session.subscription?.remove()
    } catch (error) {
      failure ??= error
    }
    session.queue.close()
    if (this.session === session && failure === null) this.session = null
    if (failure !== null) {
      this.onOwnershipUncertain()
      throw ownershipUnknown(failure)
    }
  }

  async list(
    transportSessionId: bigint,
    signal?: AbortSignal,
  ): Promise<EncryptedUploadV2ListResult> {
    if (this.active) throw operationInProgress()
    if (transportSessionId <= 0n || signal?.aborted) {
      throw signal?.aborted ? cancelled() : protocolFailure()
    }
    this.active = true
    let listSubscription: BrowserSubscription | null = null
    let errorSubscription: BrowserSubscription | null = null
    const completed = deferred<EncryptedUploadV2ListResult>()
    const entries: EncryptedUploadV2ListResult['entries'] = []
    const digest = this.core.createIntegrityHasher()
    let queuedBytes = 0
    let result: EncryptedUploadV2ListResult | null = null
    let primary: unknown = null
    try {
      listSubscription = await this.transport.subscribe(
        this.device,
        BOTA_STORAGE_SERVICE,
        RECORDING_LIST_V2_CHARACTERISTIC,
        ({ characteristicUuid, value }) => {
          if (characteristicUuid.toLowerCase()
            !== RECORDING_LIST_V2_CHARACTERISTIC) return
          try {
            queuedBytes += value.byteLength
            if (queuedBytes > MAXIMUM_QUEUED_BYTES) throw protocolFailure()
            const frame = this.core.decodeEncryptedUploadV2Transfer(value)
            if (frame.transportSessionId !== transportSessionId) {
              throw identityFailure()
            }
            if (frame.kind === 'recording_entry') {
              if (frame.completionState !== 1) throw protocolFailure()
              digest.update(value.slice(12))
              entries.push(copyRecordingEntry(frame))
              return
            }
            if (frame.kind !== 'recording_list_end') throw protocolFailure()
            if (
              frame.count !== entries.length
              || frame.listRevision === 0
              || !equalBytes(frame.listSha256, digest.sha256Snapshot())
            ) throw integrityFailure()
            completed.resolve({
              entries: entries.map(copyRecordingEntry),
              listRevision: frame.listRevision,
            })
          } catch (error) {
            completed.reject(normalizeHostError(error))
          }
        },
      )
      throwIfCancelled(false, signal)
      errorSubscription = await this.transport.subscribe(
        this.device,
        BOTA_STORAGE_SERVICE,
        RECORDING_TRANSFER_V2_CHARACTERISTIC,
        ({ characteristicUuid, value }) => {
          if (characteristicUuid.toLowerCase()
            !== RECORDING_TRANSFER_V2_CHARACTERISTIC) return
          try {
            queuedBytes += value.byteLength
            if (queuedBytes > MAXIMUM_QUEUED_BYTES) throw protocolFailure()
            const frame = this.core.decodeEncryptedUploadV2Transfer(value)
            if (frame.transportSessionId !== transportSessionId) return
            if (
              frame.kind !== 'error'
              || frame.result === 0
              || frame.failedMessageType !== 0x25
            ) throw protocolFailure()
            completed.reject(new BotaSDKError(
              'protocol_error',
              'transfer_recording',
              { protocolStatus: frame.result },
            ))
          } catch (error) {
            completed.reject(normalizeHostError(error))
          }
        },
      )
      throwIfCancelled(false, signal)
      const request = this.core.encodeEncryptedUploadV2Transfer({
        kind: 'list',
        flags: 0,
        transportSessionId,
      })
      await this.writeControl(request)
      result = await abortable(completed.promise, signal)
    } catch (error) {
      primary = error
    }
    let cleanupError: unknown = null
    for (const subscription of [errorSubscription, listSubscription]) {
      try {
        await subscription?.remove()
      } catch (error) {
        cleanupError ??= error
      }
    }
    this.active = false
    if (cleanupError !== null) this.onOwnershipUncertain()
    if (primary !== null) throw normalizeHostError(primary)
    if (cleanupError !== null) throw ownershipUnknown(cleanupError)
    if (!result) throw protocolFailure()
    return result
  }

  private async writeControl(frame: Uint8Array): Promise<void> {
    if (frame.byteLength > Math.min(
      this.transport.maximumWriteValueLength,
      MAXIMUM_FRAME_BYTES,
    )) throw protocolFailure()
    await this.transport.write(
      this.device,
      BOTA_STORAGE_SERVICE,
      TRANSFER_CONTROL_V2_CHARACTERISTIC,
      frame,
      true,
    )
  }
}

type TransferPhase =
  | 'awaiting_control'
  | 'control_pending'
  | 'window'
  | 'paused'
  | 'repair'
  | 'manifest'
  | 'terminal'
  | 'cleaning'
  | 'confirming'
  | 'confirmed'

interface TransferSession {
  request: EncryptedUploadV2TransferRequest
  subscription: BrowserSubscription | null
  queue: BoundedFrameQueue
  phase: TransferPhase
  pendingNotifications: Array<{
    frame: CoreEncryptedUploadV2TransferFrame
    rawLength: number
  }>
  pendingNotificationBytes: number
  repairSequences: Set<number> | null
  confirmationAttempted: boolean
  confirmationSucceeded: boolean
}

class BoundedFrameQueue implements AsyncIterable<CoreEncryptedUploadV2TransferFrame> {
  private readonly values: Array<{
    frame: CoreEncryptedUploadV2TransferFrame
    rawLength: number
  }> = []
  private readonly waiters: Array<{
    resolve(value: IteratorResult<CoreEncryptedUploadV2TransferFrame>): void
    reject(error: unknown): void
  }> = []
  private bufferedBytes = 0
  private terminalError: unknown = null
  private closed = false

  push(frame: CoreEncryptedUploadV2TransferFrame, rawLength: number): void {
    if (this.closed || this.terminalError !== null) throw protocolFailure()
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter.resolve({ done: false, value: frame })
      return
    }
    if (this.bufferedBytes + rawLength > MAXIMUM_QUEUED_BYTES) {
      const error = protocolFailure()
      this.fail(error)
      throw error
    }
    this.bufferedBytes += rawLength
    this.values.push({ frame, rawLength })
  }

  fail(error: unknown): void {
    if (this.terminalError !== null || this.closed) return
    this.terminalError = error
    this.values.length = 0
    this.bufferedBytes = 0
    for (const waiter of this.waiters.splice(0)) waiter.reject(error)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.values.length = 0
    this.bufferedBytes = 0
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<CoreEncryptedUploadV2TransferFrame> {
    return {
      next: async () => {
        const value = this.values.shift()
        if (value) {
          this.bufferedBytes -= value.rawLength
          return { done: false, value: value.frame }
        }
        if (this.terminalError !== null) throw this.terminalError
        if (this.closed) return { done: true, value: undefined }
        return await new Promise<IteratorResult<CoreEncryptedUploadV2TransferFrame>>(
          (resolve, reject) => this.waiters.push({ resolve, reject }),
        )
      },
    }
  }
}

export interface PersistedEncryptedUploadV2State {
  schemaVersion: 1
  operationId: string
  serialNumber: string
  recording: EncryptedUploadV2Recording
  materialId: string
  recordingId: string
  uploadSessionId: string
  ownerRevision: number
  policy: 'legacy_allowed' | 'v2_preferred' | 'v2_required'
  transportSessionId: bigint
  sinkId: string
  windowPackets: number
  dataPayloadBytes: number
  maximumSignedBlobBytes: number
  maximumMissingSequences: number
  checkpointIntervalBlocks: number
  capabilitySha256Hex: string
  coreCheckpoint: CoreEncryptedUploadV2Checkpoint | null
  highestContiguousSequence: number | null
  evidence: CoreEncryptedUploadV2Evidence | null
}

export interface EncryptedUploadV2HostCallbacks {
  transferCompleted(evidence: CoreEncryptedUploadV2Evidence): Promise<void>
  uploading(): Promise<void>
  cloudCompleted(receiptSha256: Uint8Array): Promise<void>
  confirmed(): Promise<void>
}

export interface EncryptedUploadV2HostOptions {
  core: CoreBridge
  transport: BrowserBluetoothTransport
  device: BrowserDeviceHandle
  storage: BrowserSdkStorage
  blob: BrowserBlobHandle
  material: EncryptedUploadV2Material
  state: PersistedEncryptedUploadV2State
  fetcher: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>
  callbacks: EncryptedUploadV2HostCallbacks
  recoveryPhase: 'prepared' | 'transferring' | 'staged' | 'uploading' | 'cloud_completed'
  expectedReceiptSha256Hex: string | null
  onOwnershipUncertain(): void
}

type BoundaryEvent =
  | {
      kind: 'encrypted_upload_v2_window_staged'
      checkpoint: CoreEncryptedUploadV2Checkpoint
      missingSequences: number[]
    }
  | {
      kind: 'encrypted_upload_v2_transfer_completed'
      evidence: CoreEncryptedUploadV2Evidence
    }
  | { kind: 'encrypted_upload_v2_mixed_profile' }
  | { kind: 'encrypted_upload_v2_failed'; error: unknown }

export class EncryptedUploadV2Host implements WorkflowEffectHost {
  private readonly core: CoreBridge
  private readonly storage: BrowserSdkStorage
  private readonly blob: BrowserBlobHandle
  private readonly material: EncryptedUploadV2Material
  private readonly state: PersistedEncryptedUploadV2State
  private readonly fetcher: EncryptedUploadV2HostOptions['fetcher']
  private readonly callbacks: EncryptedUploadV2HostCallbacks
  private readonly recoveryPhase: EncryptedUploadV2HostOptions['recoveryPhase']
  private readonly expectedReceiptSha256Hex: string | null
  private readonly signedWriter: EncryptedUploadV2SignedBlobWriter
  private readonly transferControl: EncryptedUploadV2TransferControl
  private readonly uploadAbort = new AbortController()
  private receiver: EncryptedUploadV2TransferReceiver | null = null
  private pendingNativeCheckpoint: EncryptedUploadV2NativeCheckpoint | null = null
  private persistedCoreCheckpoint: CoreEncryptedUploadV2Checkpoint | null = null
  private completedManifest: Uint8Array | null = null
  private completedEvidence: CoreEncryptedUploadV2Evidence | null = null
  private acceptedReceipt: Uint8Array | null = null
  private acceptedReceiptSha256: Uint8Array | null = null
  private boundaryTarget: ((event: BoundaryEvent) => Promise<void>) | null = null
  private boundaryGate: ReturnType<typeof deferred<void>> | null = null
  private startBoundaryTarget: ((event: BoundaryEvent) => Promise<void>) | null = null
  private pumpPromise: Promise<void> | null = null
  private preparedAuthorizationSha256: Uint8Array | null = null
  private nextWriteIdValue = 1
  private cancelledValue = false

  constructor(options: EncryptedUploadV2HostOptions) {
    this.core = options.core
    this.storage = options.storage
    this.blob = options.blob
    this.material = options.material
    this.state = copyPersistedState(options.state)
    this.fetcher = options.fetcher
    this.callbacks = options.callbacks
    this.recoveryPhase = options.recoveryPhase
    this.expectedReceiptSha256Hex = options.expectedReceiptSha256Hex
    this.signedWriter = new EncryptedUploadV2SignedBlobWriter(
      options.core,
      options.transport,
      options.device,
      options.onOwnershipUncertain,
    )
    this.transferControl = new EncryptedUploadV2TransferControl(
      options.core,
      options.transport,
      options.device,
      options.onOwnershipUncertain,
    )
  }

  async execute(
    envelope: CoreEffectEnvelope,
    context: WorkflowEffectContext,
  ): Promise<CoreHostEvent | readonly CoreHostEvent[] | null> {
    const effect = envelope.effect
    switch (effect.kind) {
      case 'encrypted_upload_v2_load_checkpoint': {
        this.validateCheckpointOwner(
          effect.serialNumber,
          uuidString(effect.recordingUuid),
          effect.recordingGeneration,
          uuidString(effect.uploadSessionId),
          effect.ownerRevision,
        )
        return {
          requestId: envelope.requestId,
          kind: 'encrypted_upload_v2_checkpoint_loaded',
          checkpoint: this.state.coreCheckpoint
            ? copyCoreCheckpoint(this.state.coreCheckpoint)
            : null,
        }
      }
      case 'encrypted_upload_v2_delete_checkpoint':
        if (uuidString(effect.uploadSessionId) !== this.state.uploadSessionId) {
          throw identityFailure()
        }
        this.state.coreCheckpoint = null
        this.state.highestContiguousSequence = null
        await this.storage.deleteEncryptedUploadV2Checkpoint(
          this.state.operationId,
        )
        return null
      case 'encrypted_upload_v2_truncate_sink': {
        if (effect.sinkId !== this.state.sinkId) throw identityFailure()
        const offset = safeNumber(effect.nextCiphertextOffset)
        const size = await this.blob.size()
        if (size < offset) throw integrityFailure()
        if (size > offset) await this.blob.truncate(offset)
        return {
          requestId: envelope.requestId,
          kind: 'encrypted_upload_v2_sink_truncated',
        }
      }
      case 'encrypted_upload_v2_prepare_session': {
        if (effect.materialId !== this.state.materialId) throw identityFailure()
        const source = this.material.authorization
        if (source.byteLength !== 408) throw protocolFailure()
        const authorization = source.slice()
        source.fill(0)
        try {
          const digest = sha256(this.core, authorization)
          await this.signedWriter.send(
            'authorization',
            this.nextWriteId(),
            authorization,
            this.state.maximumSignedBlobBytes,
            context.signal,
          )
          this.preparedAuthorizationSha256 = digest
          return {
            requestId: envelope.requestId,
            kind: 'encrypted_upload_v2_session_prepared',
            authorizationSha256: digest.slice(),
          }
        } finally {
          authorization.fill(0)
        }
      }
      case 'encrypted_upload_v2_start_transfer':
        return await this.startTransfer(
          envelope.requestId,
          effect,
          context,
        )
      case 'encrypted_upload_v2_repair_window':
        return await this.repairWindow(
          envelope.requestId,
          effect.missingSequences,
        )
      case 'encrypted_upload_v2_save_checkpoint':
        return await this.saveCheckpoint(envelope.requestId, effect.checkpoint)
      case 'encrypted_upload_v2_acknowledge_window':
        return await this.acknowledgeWindow(
          envelope.requestId,
          effect.checkpoint,
          context,
        )
      case 'encrypted_upload_v2_stage_artifacts':
        return await this.stageArtifacts(
          envelope.requestId,
          effect.sinkId,
          effect.materialId,
          effect.evidence,
          context.signal,
        )
      case 'encrypted_upload_v2_await_completion_receipt':
        return await this.awaitReceipt(
          envelope.requestId,
          effect.materialId,
          effect.evidence,
          context.signal,
        )
      case 'encrypted_upload_v2_confirm_with_receipt':
        return await this.confirm(
          envelope.requestId,
          envelope.cancellationId,
          effect.materialId,
          effect.receiptSha256,
        )
      case 'encrypted_upload_v2_abort':
        if (effect.materialId !== this.state.materialId) throw identityFailure()
        await this.abortState()
        return null
      default:
        throw new BotaSDKError('internal_error', 'transfer_recording')
    }
  }

  async confirmationAttemptedOrClaimCancellation(): Promise<boolean> {
    return await this.transferControl.confirmationAttemptedOrClaimCancellation()
  }

  async cancel(): Promise<void> {
    await this.abortState()
  }

  private async startTransfer(
    requestId: bigint,
    effect: Extract<
      CoreEffectEnvelope['effect'],
      { kind: 'encrypted_upload_v2_start_transfer' }
    >,
    context: WorkflowEffectContext,
  ): Promise<null> {
    this.validateStartEffect(effect)
    const nativeCheckpoint = effect.checkpoint
      ? {
          revision: effect.checkpoint.checkpointRevision,
          nextCiphertextOffset: effect.checkpoint.nextCiphertextOffset,
          prefixSha256: effect.checkpoint.prefixSha256.slice(),
          highestContiguousSequence: this.state.highestContiguousSequence,
        }
      : initialEncryptedUploadV2Checkpoint()
    this.receiver = new EncryptedUploadV2TransferReceiver(
      this.core,
      this.blob,
      {
        transportSessionId: this.state.transportSessionId,
        expectedCiphertextLength: this.state.recording.ciphertextLength,
        expectedCiphertextSha256: this.state.recording.ciphertextSha256,
        maximumDataPayloadBytes: this.state.dataPayloadBytes,
        maximumWindowPackets: this.state.windowPackets,
        maximumMissingSequences: this.state.maximumMissingSequences,
        checkpoint: nativeCheckpoint,
      },
    )
    await this.receiver.prepare()
    const opened = await this.transferControl.open({
      transportSessionId: this.state.transportSessionId,
      uploadSessionUuid: this.state.uploadSessionId,
      recordingUuid: this.state.recording.uuid,
      recordingGeneration: this.state.recording.generation,
      authorizationSha256: effect.authorizationSha256,
      expectedCiphertextLength: this.state.recording.ciphertextLength,
      expectedCiphertextSha256: this.state.recording.ciphertextSha256,
      expectedCheckpointIntervalBlocks: this.state.checkpointIntervalBlocks,
      windowPackets: this.state.windowPackets,
      dataPayloadBytes: this.state.dataPayloadBytes,
    }, effect.checkpoint ? nativeCheckpoint : null, context.signal)
    if (opened.kind === 'resume_rejected') {
      await context.dispatch({
        requestId,
        kind: 'encrypted_upload_v2_resume_rejected',
      })
      return null
    }
    const target = this.dispatchTarget(requestId, context)
    this.startBoundaryTarget = target
    this.boundaryTarget = target
    await context.dispatch({
      requestId,
      kind: 'encrypted_upload_v2_transfer_started',
    })
    this.pumpPromise = this.pump(opened.notifications)
    void this.pumpPromise.catch(() => undefined)
    return null
  }

  private async repairWindow(
    requestId: bigint,
    missingSequences: number[],
  ): Promise<CoreHostEvent> {
    const receiver = this.requireReceiver()
    const frame = receiver.repairAcknowledgement(missingSequences)
    const boundary = deferred<BoundaryEvent>()
    this.boundaryTarget = async (event) => boundary.resolve(event)
    const gate = this.boundaryGate
    if (!gate) throw protocolFailure()
    await this.transferControl.sendActiveFrame(frame, {
      kind: 'repair',
      missingSequences,
    })
    gate.resolve(undefined)
    return boundaryHostEvent(requestId, await boundary.promise)
  }

  private async saveCheckpoint(
    requestId: bigint,
    checkpoint: CoreEncryptedUploadV2Checkpoint,
  ): Promise<CoreHostEvent> {
    const native = this.pendingNativeCheckpoint
    if (!native || !sameCoreAndNativeCheckpoint(checkpoint, native, this.state)) {
      throw integrityFailure()
    }
    this.state.coreCheckpoint = copyCoreCheckpoint(checkpoint)
    this.state.highestContiguousSequence = native.highestContiguousSequence
    await this.storage.saveEncryptedUploadV2Checkpoint(
      this.state.operationId,
      copyPersistedState(this.state),
    )
    this.requireReceiver().checkpointDidPersist(native)
    this.persistedCoreCheckpoint = copyCoreCheckpoint(checkpoint)
    return {
      requestId,
      kind: 'encrypted_upload_v2_checkpoint_saved',
    }
  }

  private async acknowledgeWindow(
    requestId: bigint,
    checkpoint: CoreEncryptedUploadV2Checkpoint,
    context: WorkflowEffectContext,
  ): Promise<null> {
    if (
      !this.persistedCoreCheckpoint
      || !sameCoreCheckpoint(this.persistedCoreCheckpoint, checkpoint)
      || !this.pendingNativeCheckpoint
    ) throw integrityFailure()
    const frame = this.requireReceiver().windowAcknowledgement(
      this.pendingNativeCheckpoint,
    )
    this.boundaryTarget = this.startBoundaryTarget
    const gate = this.boundaryGate
    if (!gate || !this.boundaryTarget) throw protocolFailure()
    await this.transferControl.sendActiveFrame(
      frame,
      checkpoint.nextCiphertextOffset === this.state.recording.ciphertextLength
        ? { kind: 'manifest' }
        : { kind: 'window' },
    )
    this.pendingNativeCheckpoint = null
    this.persistedCoreCheckpoint = null
    this.boundaryGate = null
    await context.dispatch({
      requestId,
      kind: 'encrypted_upload_v2_window_acknowledged',
      checkpoint: copyCoreCheckpoint(checkpoint),
    })
    gate.resolve(undefined)
    return null
  }

  private async stageArtifacts(
    requestId: bigint,
    sinkId: string,
    materialId: string,
    evidence: CoreEncryptedUploadV2Evidence,
    signal: AbortSignal,
  ): Promise<CoreHostEvent> {
    this.validateCompletion(sinkId, materialId, evidence)
    if (this.recoveryPhase !== 'cloud_completed') {
      throwIfCancelled(this.cancelledValue, signal)
      await this.callbacks.uploading()
      throwIfCancelled(this.cancelledValue, signal)
      const request = await abortable(
        this.material.stagingRequest(providerEvidence(evidence)),
        signal,
      )
      validateUploadRequest(request)
      await this.uploadCiphertext(request, signal)
      throwIfCancelled(this.cancelledValue, signal)
      await abortable(this.material.submitManifest(
        this.requireCompletedManifest().slice(),
        providerEvidence(evidence),
      ), signal)
    }
    return {
      requestId,
      kind: 'encrypted_upload_v2_artifacts_staged',
    }
  }

  private async awaitReceipt(
    requestId: bigint,
    materialId: string,
    evidence: CoreEncryptedUploadV2Evidence,
    signal: AbortSignal,
  ): Promise<CoreHostEvent> {
    this.validateCompletion(this.state.sinkId, materialId, evidence)
    if (this.recoveryPhase !== 'cloud_completed') {
      throwIfCancelled(this.cancelledValue, signal)
      await abortable(
        this.material.finalize(providerEvidence(evidence)),
        signal,
      )
    }
    throwIfCancelled(this.cancelledValue, signal)
    const pendingReceipt = this.material.completionReceipt(
      providerEvidence(evidence),
    )
    let receipt: Uint8Array
    try {
      receipt = await abortable(pendingReceipt, signal)
    } catch (error) {
      void pendingReceipt.then(
        (lateReceipt) => {
          if (lateReceipt instanceof Uint8Array) lateReceipt.fill(0)
        },
        () => undefined,
      )
      throw error
    }
    if (this.cancelledValue || signal.aborted) {
      receipt.fill(0)
      throw cancelled()
    }
    if (!(receipt instanceof Uint8Array)) throw integrityFailure()
    if (receipt.byteLength !== 336) {
      receipt.fill(0)
      throw integrityFailure()
    }
    const digest = sha256(this.core, receipt)
    if (
      this.expectedReceiptSha256Hex !== null
      && hexString(digest) !== this.expectedReceiptSha256Hex
    ) {
      receipt.fill(0)
      throw integrityFailure()
    }
    this.acceptedReceipt = receipt.slice()
    receipt.fill(0)
    this.acceptedReceiptSha256 = digest
    await this.callbacks.cloudCompleted(digest.slice())
    return {
      requestId,
      kind: 'encrypted_upload_v2_completion_receipt_accepted',
      receiptSha256: digest.slice(),
    }
  }

  private async confirm(
    requestId: bigint,
    _cancellationId: Uint8Array,
    materialId: string,
    receiptSha256: Uint8Array,
  ): Promise<CoreHostEvent> {
    if (
      materialId !== this.state.materialId
      || !this.acceptedReceipt
      || !this.acceptedReceiptSha256
      || !equalBytes(receiptSha256, this.acceptedReceiptSha256)
    ) throw integrityFailure()
    const receipt = this.acceptedReceipt
    try {
      await this.signedWriter.send(
        'receipt',
        this.nextWriteId(),
        receipt,
        this.state.maximumSignedBlobBytes,
      )
    } finally {
      receipt.fill(0)
      this.acceptedReceipt = null
    }
    const frame: Extract<
      CoreEncryptedUploadV2OutboundTransferFrame,
      { kind: 'confirm' }
    > = {
      kind: 'confirm',
      flags: 0,
      transportSessionId: this.state.transportSessionId,
      uploadSessionUuid: this.state.uploadSessionId,
      recordingUuid: this.state.recording.uuid,
      recordingGeneration: this.state.recording.generation,
      ownerRevision: this.state.ownerRevision,
      receiptSha256: receiptSha256.slice(),
    }
    await this.transferControl.confirm(frame, async () => {
      await this.callbacks.confirmed()
    })
    return {
      requestId,
      kind: 'encrypted_upload_v2_recording_confirmed',
    }
  }

  private async pump(
    notifications: AsyncIterable<CoreEncryptedUploadV2TransferFrame>,
  ): Promise<void> {
    try {
      for await (const frame of notifications) {
        const event = await this.requireReceiver().receive(frame)
        if (!event) continue
        const target = this.boundaryTarget
        if (!target) throw protocolFailure()
        if (event.kind === 'window_staged') {
          this.pendingNativeCheckpoint = copyNativeCheckpoint(event.checkpoint)
          const checkpoint = coreCheckpoint(
            this.state.serialNumber,
            uuidBytes(this.state.recording.uuid),
            this.state.recording.generation,
            uuidBytes(this.state.uploadSessionId),
            this.state.ownerRevision,
            this.state.transportSessionId,
            event.checkpoint,
            this.state.windowPackets,
            this.state.dataPayloadBytes,
          )
          const gate = deferred<void>()
          this.boundaryGate = gate
          await target({
            kind: 'encrypted_upload_v2_window_staged',
            checkpoint,
            missingSequences: [...event.missingSequences],
          })
          await gate.promise
          continue
        }
        this.completedManifest = event.manifest.slice()
        this.completedEvidence = copyEvidence(event.evidence)
        this.state.evidence = copyEvidence(event.evidence)
        await this.storage.saveEncryptedUploadV2Checkpoint(
          this.state.operationId,
          copyPersistedState(this.state),
        )
        if (this.recoveryPhase !== 'cloud_completed') {
          await this.callbacks.transferCompleted(copyEvidence(event.evidence))
        }
        await target({
          kind: 'encrypted_upload_v2_transfer_completed',
          evidence: copyEvidence(event.evidence),
        })
        return
      }
      throw protocolFailure()
    } catch (error) {
      if (this.cancelledValue) return
      const target = this.boundaryTarget
      if (target) {
        await target({
          kind: 'encrypted_upload_v2_failed',
          error: coreProtocolError(error),
        }).catch(() => undefined)
      }
      throw error
    }
  }

  private dispatchTarget(
    requestId: bigint,
    context: WorkflowEffectContext,
  ): (event: BoundaryEvent) => Promise<void> {
    return async (event) => await context.dispatch(
      boundaryHostEvent(requestId, event),
    )
  }

  private validateCheckpointOwner(
    serialNumber: string,
    recordingUuid: string,
    recordingGeneration: number,
    uploadSessionId: string,
    ownerRevision: number,
  ): void {
    if (
      serialNumber !== this.state.serialNumber
      || recordingUuid !== this.state.recording.uuid
      || recordingGeneration !== this.state.recording.generation
      || uploadSessionId !== this.state.uploadSessionId
      || ownerRevision !== this.state.ownerRevision
    ) throw identityFailure()
  }

  private validateStartEffect(
    effect: Extract<
      CoreEffectEnvelope['effect'],
      { kind: 'encrypted_upload_v2_start_transfer' }
    >,
  ): void {
    this.validateCheckpointOwner(
      effect.serialNumber,
      uuidString(effect.recordingUuid),
      effect.recordingGeneration,
      uuidString(effect.uploadSessionId),
      effect.ownerRevision,
    )
    if (
      effect.storageFormat !== this.state.recording.storageFormat
      || effect.transportSessionId !== this.state.transportSessionId
      || effect.materialId !== this.state.materialId
      || effect.sinkId !== this.state.sinkId
      || effect.policy !== this.state.policy
      || effect.windowPackets !== this.state.windowPackets
      || effect.dataPayloadBytes !== this.state.dataPayloadBytes
      || effect.ciphertextLength !== this.state.recording.ciphertextLength
      || !equalBytes(
        effect.ciphertextSha256,
        this.state.recording.ciphertextSha256,
      )
      || !this.preparedAuthorizationSha256
      || !equalBytes(
        effect.authorizationSha256,
        this.preparedAuthorizationSha256,
      )
      || !sameOptionalCoreCheckpoint(
        effect.checkpoint,
        this.state.coreCheckpoint,
      )
    ) throw integrityFailure()
  }

  private validateCompletion(
    sinkId: string,
    materialId: string,
    evidence: CoreEncryptedUploadV2Evidence,
  ): void {
    if (
      sinkId !== this.state.sinkId
      || materialId !== this.state.materialId
      || !this.completedEvidence
      || !sameEvidence(evidence, this.completedEvidence)
    ) throw integrityFailure()
  }

  private requireReceiver(): EncryptedUploadV2TransferReceiver {
    if (!this.receiver) throw protocolFailure()
    return this.receiver
  }

  private requireCompletedManifest(): Uint8Array {
    if (!this.completedManifest) throw protocolFailure()
    return this.completedManifest
  }

  private async uploadCiphertext(
    request: UploadRequestTemplate,
    signal: AbortSignal,
  ): Promise<void> {
    const combinedSignal = AbortSignal.any([
      signal,
      this.uploadAbort.signal,
    ])
    const body = blobReadableStream(this.blob, combinedSignal)
    const init: RequestInit & { duplex?: 'half' } = {
      method: 'PUT',
      headers: { ...request.headers },
      body,
      signal: combinedSignal,
      duplex: 'half',
    }
    const pendingResponse = this.fetcher(request.url, init)
    let response: Response
    try {
      response = await abortable(pendingResponse, combinedSignal)
    } catch (error) {
      if (combinedSignal.aborted) {
        void pendingResponse.then(
          async (lateResponse) => {
            await lateResponse.body?.cancel().catch(() => undefined)
          },
          () => undefined,
        )
      }
      throw error
    }
    throwIfCancelled(this.cancelledValue, combinedSignal)
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new BotaSDKError('upload_failed', 'upload', { retryable: true })
    }
  }

  private async abortState(): Promise<void> {
    if (this.cancelledValue) return
    this.cancelledValue = true
    this.uploadAbort.abort()
    this.boundaryGate?.resolve(undefined)
    this.material.authorization.fill(0)
    this.acceptedReceipt?.fill(0)
    this.acceptedReceipt = null
    await this.signedWriter.cancel().catch(() => undefined)
    let failure: unknown = null
    try {
      await this.transferControl.abort()
    } catch (error) {
      failure = error
    }
    try {
      await this.material.cancel()
    } catch (error) {
      failure ??= error
    }
    if (failure !== null) throw normalizeHostError(failure)
  }

  private nextWriteId(): number {
    const value = this.nextWriteIdValue
    this.nextWriteIdValue = value === 0xffffffff ? 1 : value + 1
    return value
  }
}

export class EncryptedUploadV2TransferReceiver {
  private readonly core: CoreBridge
  private readonly blob: BrowserBlobHandle
  private readonly options: TransferReceiverOptions
  private checkpoint: EncryptedUploadV2NativeCheckpoint
  private readonly packets = new Map<number, PacketMetadata>()
  private pendingWindow: PendingWindow | null = null
  private readonly manifest = new Uint8Array(MANIFEST_LENGTH)
  private readonly manifestPresent = new Uint8Array(MANIFEST_LENGTH)
  private manifestSha256: Uint8Array | null = null
  private prepared = false
  private terminal = false
  private completed = false
  private bufferedBytes = 0

  constructor(
    core: CoreBridge,
    blob: BrowserBlobHandle,
    options: TransferReceiverOptions,
  ) {
    this.core = core
    this.blob = blob
    this.options = {
      ...options,
      expectedCiphertextSha256: options.expectedCiphertextSha256.slice(),
      checkpoint: copyNativeCheckpoint(options.checkpoint),
    }
    this.checkpoint = copyNativeCheckpoint(options.checkpoint)
    if (
      options.transportSessionId <= 0n
      || options.expectedCiphertextLength <= 0n
      || options.expectedCiphertextLength > BigInt(Number.MAX_SAFE_INTEGER)
      || options.expectedCiphertextSha256.byteLength !== 32
      || options.maximumDataPayloadBytes <= 0
      || options.maximumWindowPackets <= 0
      || options.maximumMissingSequences <= 0
      || options.checkpoint.nextCiphertextOffset < 0n
      || options.checkpoint.nextCiphertextOffset > options.expectedCiphertextLength
      || options.checkpoint.prefixSha256.byteLength !== 32
      || ((options.checkpoint.nextCiphertextOffset === 0n)
        !== (options.checkpoint.highestContiguousSequence === null))
    ) throw protocolFailure()
  }

  async prepare(): Promise<void> {
    const checkpointOffset = safeNumber(this.checkpoint.nextCiphertextOffset)
    const size = await this.blob.size()
    if (size < checkpointOffset) throw integrityFailure()
    if (size !== checkpointOffset) await this.blob.truncate(checkpointOffset)
    const digest = await hashBlobPrefix(this.core, this.blob, checkpointOffset)
    if (!equalBytes(digest, this.checkpoint.prefixSha256)) {
      throw integrityFailure()
    }
    this.prepared = true
  }

  async receive(
    frame: CoreEncryptedUploadV2TransferFrame,
  ): Promise<EncryptedUploadV2ReceiverEvent | null> {
    if (!this.prepared || this.terminal || this.completed) throw protocolFailure()
    if (frame.transportSessionId !== this.options.transportSessionId) {
      this.terminal = true
      throw identityFailure()
    }
    try {
      switch (frame.kind) {
        case 'data':
          this.receiveData(frame)
          return null
        case 'window_end':
          return await this.receiveWindowEnd(frame)
        case 'manifest_chunk':
          this.receiveManifest(frame)
          return null
        case 'eof': {
          const completed = await this.receiveEof(frame)
          this.completed = true
          return completed
        }
        case 'error':
          throw new BotaSDKError(
            'protocol_error',
            'transfer_recording',
            { protocolStatus: frame.result },
          )
        default:
          throw protocolFailure()
      }
    } catch (error) {
      this.terminal = true
      throw normalizeHostError(error)
    }
  }

  repairAcknowledgement(
    missingSequences: number[],
  ): Extract<CoreEncryptedUploadV2OutboundTransferFrame, { kind: 'window_ack' }> {
    const pending = this.pendingWindow
    if (
      !pending
      || pending.missingSequences.length === 0
      || !equalNumbers(pending.missingSequences, missingSequences)
    ) throw protocolFailure()
    return this.acknowledgement(
      pending,
      pending.highestContiguousSequence,
      pending.contiguousOffset,
      pending.contiguousSha256,
      this.checkpoint.revision,
      missingSequences,
    )
  }

  checkpointDidPersist(checkpoint: EncryptedUploadV2NativeCheckpoint): void {
    const pending = this.pendingWindow
    if (
      !pending
      || pending.missingSequences.length !== 0
      || !sameCheckpoint(pending.checkpoint, checkpoint)
    ) throw protocolFailure()
    pending.persisted = true
  }

  windowAcknowledgement(
    checkpoint: EncryptedUploadV2NativeCheckpoint,
  ): Extract<CoreEncryptedUploadV2OutboundTransferFrame, { kind: 'window_ack' }> {
    const pending = this.pendingWindow
    if (
      !pending
      || pending.missingSequences.length !== 0
      || !sameCheckpoint(pending.checkpoint, checkpoint)
      || !pending.persisted
    ) throw protocolFailure()
    const acknowledgement = this.acknowledgement(
      pending,
      pending.boundary.lastSequence,
      checkpoint.nextCiphertextOffset,
      checkpoint.prefixSha256,
      checkpoint.revision,
      [],
    )
    this.checkpoint = copyNativeCheckpoint(checkpoint)
    this.packets.clear()
    this.bufferedBytes = 0
    this.pendingWindow = null
    return acknowledgement
  }

  private receiveData(frame: DataFrame): void {
    const end = frame.offset + BigInt(frame.data.byteLength)
    const repair = this.pendingWindow?.missingSequences ?? null
    if (
      frame.data.byteLength === 0
      || frame.data.byteLength > this.options.maximumDataPayloadBytes
      || frame.offset < this.checkpoint.nextCiphertextOffset
      || end > this.options.expectedCiphertextLength
      || (repair !== null && !repair.includes(frame.sequence))
    ) throw protocolFailure()
    const metadata: PacketMetadata = {
      offset: frame.offset,
      bytes: frame.data.slice(),
      sha256: sha256(this.core, frame.data),
    }
    const existing = this.packets.get(frame.sequence)
    if (existing) {
      if (
        existing.offset !== metadata.offset
        || existing.bytes.byteLength !== metadata.bytes.byteLength
        || !equalBytes(existing.sha256, metadata.sha256)
        || !equalBytes(existing.bytes, metadata.bytes)
      ) throw integrityFailure()
      return
    }
    if (
      this.packets.size >= this.options.maximumWindowPackets
      || [...this.packets.values()].some((candidate) => overlaps(candidate, metadata))
      || this.bufferedBytes + metadata.bytes.byteLength + 80 > MAXIMUM_QUEUED_BYTES
    ) throw protocolFailure()
    this.packets.set(frame.sequence, metadata)
    this.bufferedBytes += metadata.bytes.byteLength + 80
  }

  private async receiveWindowEnd(
    frame: WindowEndFrame,
  ): Promise<EncryptedUploadV2ReceiverEvent> {
    if (this.pendingWindow && !sameWindow(this.pendingWindow.boundary, frame)) {
      throw protocolFailure()
    }
    const previous = this.checkpoint.highestContiguousSequence
    const follows = previous === null
      || (previous < 0xffffffff && frame.firstSequence === previous + 1)
    const span = frame.lastSequence - frame.firstSequence
    if (
      frame.firstSequence > frame.lastSequence
      || !follows
      || frame.checkpointRevision <= this.checkpoint.revision
      || frame.nextCiphertextOffset <= this.checkpoint.nextCiphertextOffset
      || frame.nextCiphertextOffset > this.options.expectedCiphertextLength
      || frame.prefixSha256.byteLength !== 32
      || span >= this.options.maximumWindowPackets
      || [...this.packets.keys()].some((sequence) =>
        sequence < frame.firstSequence || sequence > frame.lastSequence)
    ) throw protocolFailure()
    const missing: number[] = []
    for (let sequence = frame.firstSequence; sequence <= frame.lastSequence; sequence += 1) {
      if (!this.packets.has(sequence)) missing.push(sequence)
    }
    if (missing.length > this.options.maximumMissingSequences) {
      throw protocolFailure()
    }
    let contiguousOffset = this.checkpoint.nextCiphertextOffset
    let highest = frame.firstSequence === 0 ? 0 : frame.firstSequence - 1
    for (let sequence = frame.firstSequence; sequence <= frame.lastSequence; sequence += 1) {
      const packet = this.packets.get(sequence)
      if (!packet) break
      if (packet.offset !== contiguousOffset) throw integrityFailure()
      contiguousOffset += BigInt(packet.bytes.byteLength)
      highest = sequence
    }
    const contiguousSha256 = await this.hashProspectivePrefix(
      frame.firstSequence,
      highest,
    )
    const checkpoint: EncryptedUploadV2NativeCheckpoint = {
      revision: frame.checkpointRevision,
      nextCiphertextOffset: frame.nextCiphertextOffset,
      prefixSha256: frame.prefixSha256.slice(),
      highestContiguousSequence: frame.lastSequence,
    }
    if (missing.length === 0) {
      if (
        contiguousOffset !== frame.nextCiphertextOffset
        || !equalBytes(contiguousSha256, frame.prefixSha256)
      ) throw integrityFailure()
      await this.flushWindow(frame.firstSequence, frame.lastSequence)
    }
    this.pendingWindow = {
      boundary: copyWindow(frame),
      checkpoint,
      missingSequences: missing,
      highestContiguousSequence: highest,
      contiguousOffset,
      contiguousSha256,
      persisted: false,
    }
    return {
      kind: 'window_staged',
      checkpoint: copyNativeCheckpoint(checkpoint),
      missingSequences: [...missing],
    }
  }

  private receiveManifest(
    frame: Extract<
      CoreEncryptedUploadV2TransferFrame,
      { kind: 'manifest_chunk' }
    >,
  ): void {
    const end = frame.chunkOffset + frame.chunk.byteLength
    if (
      this.pendingWindow !== null
      || frame.totalManifestLength !== MANIFEST_LENGTH
      || frame.manifestSha256.byteLength !== 32
      || frame.chunk.byteLength === 0
      || end > MANIFEST_LENGTH
      || (this.manifestSha256 !== null
        && !equalBytes(this.manifestSha256, frame.manifestSha256))
    ) throw protocolFailure()
    for (let relative = 0; relative < frame.chunk.byteLength; relative += 1) {
      const index = frame.chunkOffset + relative
      if (this.manifestPresent[index] && this.manifest[index] !== frame.chunk[relative]) {
        throw integrityFailure()
      }
      this.manifest[index] = frame.chunk[relative] ?? 0
      this.manifestPresent[index] = 1
    }
    this.manifestSha256 = frame.manifestSha256.slice()
  }

  private async receiveEof(
    frame: Extract<CoreEncryptedUploadV2TransferFrame, { kind: 'eof' }>,
  ): Promise<Extract<EncryptedUploadV2ReceiverEvent, { kind: 'completed' }>> {
    const size = await this.blob.size()
    const digest = await hashBlobPrefix(this.core, this.blob, size)
    if (
      this.pendingWindow !== null
      || this.packets.size !== 0
      || this.checkpoint.highestContiguousSequence !== frame.finalSequence
      || frame.blockCount === 0
      || frame.ciphertextLength !== this.options.expectedCiphertextLength
      || !equalBytes(frame.ciphertextSha256, this.options.expectedCiphertextSha256)
      || this.manifestSha256 === null
      || !equalBytes(frame.manifestSha256, this.manifestSha256)
      || this.manifestPresent.some((present) => present !== 1)
      || !equalBytes(sha256(this.core, this.manifest), frame.manifestSha256)
      || BigInt(size) !== this.options.expectedCiphertextLength
      || !equalBytes(digest, this.options.expectedCiphertextSha256)
    ) throw integrityFailure()
    return {
      kind: 'completed',
      manifest: this.manifest.slice(),
      evidence: {
        ciphertextLength: frame.ciphertextLength,
        ciphertextSha256: frame.ciphertextSha256.slice(),
        manifestLength: MANIFEST_LENGTH,
        manifestSha256: frame.manifestSha256.slice(),
        blockCount: frame.blockCount,
      },
    }
  }

  private async flushWindow(firstSequence: number, lastSequence: number): Promise<void> {
    let offset = safeNumber(this.checkpoint.nextCiphertextOffset)
    for (let sequence = firstSequence; sequence <= lastSequence; sequence += 1) {
      const packet = this.packets.get(sequence)
      if (!packet || safeNumber(packet.offset) !== offset) throw integrityFailure()
      await this.blob.write(offset, packet.bytes)
      offset += packet.bytes.byteLength
    }
  }

  private async hashProspectivePrefix(
    firstSequence: number,
    highestSequence: number,
  ): Promise<Uint8Array> {
    const hasher = this.core.createIntegrityHasher()
    const prefixLength = safeNumber(this.checkpoint.nextCiphertextOffset)
    for await (const chunk of this.blob.stream(64 * 1024)) {
      if (hasher.length() + BigInt(chunk.byteLength) > BigInt(prefixLength)) {
        const remaining = prefixLength - safeNumber(hasher.length())
        if (remaining > 0) hasher.update(chunk.slice(0, remaining))
        break
      }
      hasher.update(chunk)
    }
    if (hasher.length() !== BigInt(prefixLength)) throw integrityFailure()
    for (let sequence = firstSequence; sequence <= highestSequence; sequence += 1) {
      const packet = this.packets.get(sequence)
      if (!packet) break
      hasher.update(packet.bytes)
    }
    return hasher.sha256Snapshot()
  }

  private acknowledgement(
    pending: PendingWindow,
    highestContiguousSequence: number,
    nextCiphertextOffset: bigint,
    prefixSha256: Uint8Array,
    checkpointRevision: number,
    missingSequences: number[],
  ): Extract<CoreEncryptedUploadV2OutboundTransferFrame, { kind: 'window_ack' }> {
    return {
      kind: 'window_ack',
      flags: 0,
      transportSessionId: this.options.transportSessionId,
      windowIndex: pending.boundary.windowIndex,
      highestContiguousSequence,
      nextCiphertextOffset,
      prefixSha256: prefixSha256.slice(),
      checkpointRevision,
      missingSequences: [...missingSequences],
    }
  }
}

export function initialEncryptedUploadV2Checkpoint(): EncryptedUploadV2NativeCheckpoint {
  return {
    revision: 0,
    nextCiphertextOffset: 0n,
    prefixSha256: hexBytes(EMPTY_SHA256_HEX),
    highestContiguousSequence: null,
  }
}

export function coreCheckpoint(
  serialNumber: string,
  recordingUuid: Uint8Array,
  recordingGeneration: number,
  uploadSessionId: Uint8Array,
  ownerRevision: number,
  transportSessionId: bigint,
  checkpoint: EncryptedUploadV2NativeCheckpoint,
  windowPackets: number,
  dataPayloadBytes: number,
): CoreEncryptedUploadV2Checkpoint {
  return {
    serialNumber,
    recordingUuid: recordingUuid.slice(),
    recordingGeneration,
    uploadSessionId: uploadSessionId.slice(),
    ownerRevision,
    transportSessionId,
    checkpointRevision: checkpoint.revision,
    nextCiphertextOffset: checkpoint.nextCiphertextOffset,
    prefixSha256: checkpoint.prefixSha256.slice(),
    windowPackets,
    dataPayloadBytes,
  }
}

function copyRecordingEntry(
  frame: Extract<CoreEncryptedUploadV2TransferFrame, { kind: 'recording_entry' }>,
): Extract<CoreEncryptedUploadV2TransferFrame, { kind: 'recording_entry' }> {
  return { ...frame, ciphertextSha256: frame.ciphertextSha256.slice() }
}

function copyNativeCheckpoint(
  checkpoint: EncryptedUploadV2NativeCheckpoint,
): EncryptedUploadV2NativeCheckpoint {
  return { ...checkpoint, prefixSha256: checkpoint.prefixSha256.slice() }
}

function copyWindow(frame: WindowEndFrame): WindowEndFrame {
  return { ...frame, prefixSha256: frame.prefixSha256.slice() }
}

function copyTransferRequest(
  request: EncryptedUploadV2TransferRequest,
): EncryptedUploadV2TransferRequest {
  return {
    ...request,
    authorizationSha256: request.authorizationSha256.slice(),
    expectedCiphertextSha256: request.expectedCiphertextSha256.slice(),
  }
}

function validateTransferRequest(request: EncryptedUploadV2TransferRequest): void {
  if (
    request.transportSessionId <= 0n
    || request.authorizationSha256.byteLength !== 32
    || request.expectedCiphertextSha256.byteLength !== 32
    || request.expectedCiphertextLength <= 0n
    || !isUint32(request.recordingGeneration)
    || !isUint32(request.expectedCheckpointIntervalBlocks)
    || request.expectedCheckpointIntervalBlocks === 0
    || request.windowPackets <= 0
    || request.windowPackets > 0xffff
    || request.dataPayloadBytes <= 0
    || request.dataPayloadBytes > 0xffff
  ) throw protocolFailure()
}

function validateStartAcknowledgement(
  request: EncryptedUploadV2TransferRequest,
  response: Extract<CoreEncryptedUploadV2TransferFrame, { kind: 'start_ack' }>,
): void {
  if (
    response.uploadSessionUuid !== request.uploadSessionUuid
    || response.recordingUuid !== request.recordingUuid
    || response.recordingGeneration !== request.recordingGeneration
    || response.ciphertextLength !== request.expectedCiphertextLength
    || !equalBytes(
      response.ciphertextSha256,
      request.expectedCiphertextSha256,
    )
    || response.windowPackets !== request.windowPackets
    || response.dataPayloadBytes !== request.dataPayloadBytes
    || response.checkpointIntervalBlocks
      !== request.expectedCheckpointIntervalBlocks
    || response.checkpointRevision !== 0
    || response.nextCiphertextOffset !== 0n
    || !equalBytes(
      response.prefixSha256,
      initialEncryptedUploadV2Checkpoint().prefixSha256,
    )
  ) throw identityFailure()
}

function validateResumeAcknowledgement(
  request: EncryptedUploadV2TransferRequest,
  checkpoint: EncryptedUploadV2NativeCheckpoint,
  response: Extract<CoreEncryptedUploadV2TransferFrame, { kind: 'resume_accept' }>,
): void {
  if (
    response.uploadSessionUuid !== request.uploadSessionUuid
    || response.recordingUuid !== request.recordingUuid
    || response.recordingGeneration !== request.recordingGeneration
    || response.checkpointRevision !== checkpoint.revision
    || response.nextCiphertextOffset !== checkpoint.nextCiphertextOffset
    || !equalBytes(response.prefixSha256, checkpoint.prefixSha256)
    || response.windowPackets !== request.windowPackets
    || response.dataPayloadBytes !== request.dataPayloadBytes
  ) throw identityFailure()
}

function sameWindow(left: WindowEndFrame, right: WindowEndFrame): boolean {
  return left.transportSessionId === right.transportSessionId
    && left.windowIndex === right.windowIndex
    && left.firstSequence === right.firstSequence
    && left.lastSequence === right.lastSequence
    && left.nextCiphertextOffset === right.nextCiphertextOffset
    && left.checkpointRevision === right.checkpointRevision
    && equalBytes(left.prefixSha256, right.prefixSha256)
}

function sameCheckpoint(
  left: EncryptedUploadV2NativeCheckpoint,
  right: EncryptedUploadV2NativeCheckpoint,
): boolean {
  return left.revision === right.revision
    && left.nextCiphertextOffset === right.nextCiphertextOffset
    && left.highestContiguousSequence === right.highestContiguousSequence
    && equalBytes(left.prefixSha256, right.prefixSha256)
}

function overlaps(left: PacketMetadata, right: PacketMetadata): boolean {
  const leftEnd = left.offset + BigInt(left.bytes.byteLength)
  const rightEnd = right.offset + BigInt(right.bytes.byteLength)
  return left.offset < rightEnd && right.offset < leftEnd
}

async function hashBlobPrefix(
  core: CoreBridge,
  blob: BrowserBlobHandle,
  length: number,
): Promise<Uint8Array> {
  const hasher = core.createIntegrityHasher()
  for await (const chunk of blob.stream(64 * 1024)) {
    const remaining = length - safeNumber(hasher.length())
    if (remaining <= 0) break
    hasher.update(chunk.byteLength <= remaining ? chunk : chunk.slice(0, remaining))
  }
  if (hasher.length() !== BigInt(length)) throw integrityFailure()
  return hasher.sha256Snapshot()
}

function sha256(core: CoreBridge, value: Uint8Array): Uint8Array {
  const hasher = core.createIntegrityHasher()
  hasher.update(value)
  return hasher.sha256Snapshot()
}

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g) ?? [], (byte) =>
    Number.parseInt(byte, 16)
  )
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  let different = 0
  for (let index = 0; index < left.byteLength; index += 1) {
    different |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return different === 0
}

function equalNumbers(left: number[], right: number[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index])
}

function boundaryHostEvent(
  requestId: bigint,
  event: BoundaryEvent,
): CoreHostEvent {
  switch (event.kind) {
    case 'encrypted_upload_v2_window_staged':
      return { requestId, ...event }
    case 'encrypted_upload_v2_transfer_completed':
      return { requestId, ...event }
    case 'encrypted_upload_v2_mixed_profile':
      return { requestId, ...event }
    case 'encrypted_upload_v2_failed':
      return { requestId, ...event }
  }
}

function coreProtocolError(error: unknown): unknown {
  const normalized = normalizeHostError(error)
  return {
    code: normalized.code === 'integrity_failed'
      ? 'IntegrityFailed'
      : normalized.code === 'identity_mismatch'
      ? 'IdentityMismatch'
      : 'ProtocolRejected',
    operation: 'TransferRecording',
    retryable: normalized.retryable,
    protocol_status: normalized.protocolStatus ?? undefined,
    detail: 'encrypted_upload_v2_browser_host_failure',
  }
}

function sameEvidence(
  left: CoreEncryptedUploadV2Evidence,
  right: CoreEncryptedUploadV2Evidence,
): boolean {
  return left.ciphertextLength === right.ciphertextLength
    && equalBytes(left.ciphertextSha256, right.ciphertextSha256)
    && left.manifestLength === right.manifestLength
    && equalBytes(left.manifestSha256, right.manifestSha256)
    && left.blockCount === right.blockCount
}

function copyEvidence(
  evidence: CoreEncryptedUploadV2Evidence,
): CoreEncryptedUploadV2Evidence {
  return {
    ...evidence,
    ciphertextSha256: evidence.ciphertextSha256.slice(),
    manifestSha256: evidence.manifestSha256.slice(),
  }
}

function providerEvidence(
  evidence: CoreEncryptedUploadV2Evidence,
): import('./providers.ts').EncryptedUploadV2Evidence {
  return copyEvidence(evidence)
}

function copyCoreCheckpoint(
  checkpoint: CoreEncryptedUploadV2Checkpoint,
): CoreEncryptedUploadV2Checkpoint {
  return {
    ...checkpoint,
    recordingUuid: checkpoint.recordingUuid.slice(),
    uploadSessionId: checkpoint.uploadSessionId.slice(),
    prefixSha256: checkpoint.prefixSha256.slice(),
  }
}

function sameCoreCheckpoint(
  left: CoreEncryptedUploadV2Checkpoint,
  right: CoreEncryptedUploadV2Checkpoint,
): boolean {
  return left.serialNumber === right.serialNumber
    && equalBytes(left.recordingUuid, right.recordingUuid)
    && left.recordingGeneration === right.recordingGeneration
    && equalBytes(left.uploadSessionId, right.uploadSessionId)
    && left.ownerRevision === right.ownerRevision
    && left.transportSessionId === right.transportSessionId
    && left.checkpointRevision === right.checkpointRevision
    && left.nextCiphertextOffset === right.nextCiphertextOffset
    && equalBytes(left.prefixSha256, right.prefixSha256)
    && left.windowPackets === right.windowPackets
    && left.dataPayloadBytes === right.dataPayloadBytes
}

function sameOptionalCoreCheckpoint(
  left: CoreEncryptedUploadV2Checkpoint | null,
  right: CoreEncryptedUploadV2Checkpoint | null,
): boolean {
  return left === null || right === null
    ? left === right
    : sameCoreCheckpoint(left, right)
}

function sameCoreAndNativeCheckpoint(
  core: CoreEncryptedUploadV2Checkpoint,
  native: EncryptedUploadV2NativeCheckpoint,
  state: PersistedEncryptedUploadV2State,
): boolean {
  return core.serialNumber === state.serialNumber
    && uuidString(core.recordingUuid) === state.recording.uuid
    && core.recordingGeneration === state.recording.generation
    && uuidString(core.uploadSessionId) === state.uploadSessionId
    && core.ownerRevision === state.ownerRevision
    && core.transportSessionId === state.transportSessionId
    && core.checkpointRevision === native.revision
    && core.nextCiphertextOffset === native.nextCiphertextOffset
    && equalBytes(core.prefixSha256, native.prefixSha256)
    && core.windowPackets === state.windowPackets
    && core.dataPayloadBytes === state.dataPayloadBytes
}

function copyPersistedState(
  state: PersistedEncryptedUploadV2State,
): PersistedEncryptedUploadV2State {
  return {
    ...state,
    recording: {
      ...state.recording,
      ciphertextSha256: state.recording.ciphertextSha256.slice(),
    },
    coreCheckpoint: state.coreCheckpoint
      ? copyCoreCheckpoint(state.coreCheckpoint)
      : null,
    evidence: state.evidence ? copyEvidence(state.evidence) : null,
  }
}

export function parsePersistedEncryptedUploadV2State(
  value: unknown,
): PersistedEncryptedUploadV2State {
  if (!isRecord(value) || value.schemaVersion !== 1) throw integrityFailure()
  const recording = value.recording
  const coreCheckpointValue = value.coreCheckpoint
  const evidenceValue = value.evidence
  if (
    !isRecord(recording)
    || typeof recording.uuid !== 'string'
    || !isUuid(recording.uuid)
    || !isUint32(recording.generation)
    || typeof recording.storageFormat !== 'number'
    || !Number.isInteger(recording.storageFormat)
    || recording.storageFormat <= 0
    || recording.storageFormat > 0xff
    || typeof recording.ciphertextLength !== 'bigint'
    || recording.ciphertextLength <= 0n
    || recording.ciphertextLength > BigInt(Number.MAX_SAFE_INTEGER)
    || !(recording.ciphertextSha256 instanceof Uint8Array)
    || recording.ciphertextSha256.byteLength !== 32
    || typeof value.operationId !== 'string'
    || value.operationId.length === 0
    || typeof value.serialNumber !== 'string'
    || value.serialNumber.length === 0
    || typeof value.materialId !== 'string'
    || value.materialId.length === 0
    || typeof value.recordingId !== 'string'
    || value.recordingId.length === 0
    || typeof value.uploadSessionId !== 'string'
    || !isUuid(value.uploadSessionId)
    || !isUint32(value.ownerRevision)
    || value.ownerRevision === 0
    || !isUploadPolicy(value.policy)
    || typeof value.transportSessionId !== 'bigint'
    || value.transportSessionId <= 0n
    || typeof value.sinkId !== 'string'
    || value.sinkId.length === 0
    || !isPositiveU16(value.windowPackets)
    || !isPositiveU16(value.dataPayloadBytes)
    || !isPositiveU16(value.maximumSignedBlobBytes)
    || !isPositiveU16(value.maximumMissingSequences)
    || !isUint32(value.checkpointIntervalBlocks)
    || value.checkpointIntervalBlocks === 0
    || typeof value.capabilitySha256Hex !== 'string'
    || !/^[0-9a-f]{64}$/.test(value.capabilitySha256Hex)
    || (value.highestContiguousSequence !== null
      && !isUint32(value.highestContiguousSequence))
  ) throw integrityFailure()
  if (coreCheckpointValue !== null) validateCoreCheckpoint(coreCheckpointValue)
  if (evidenceValue !== null) validateEvidence(evidenceValue)
  const state: PersistedEncryptedUploadV2State = {
    schemaVersion: 1,
    operationId: value.operationId,
    serialNumber: value.serialNumber,
    recording: {
      uuid: recording.uuid,
      generation: recording.generation,
      storageFormat: recording.storageFormat,
      ciphertextLength: recording.ciphertextLength,
      ciphertextSha256: recording.ciphertextSha256.slice(),
    },
    materialId: value.materialId,
    recordingId: value.recordingId,
    uploadSessionId: value.uploadSessionId,
    ownerRevision: value.ownerRevision,
    policy: value.policy,
    transportSessionId: value.transportSessionId,
    sinkId: value.sinkId,
    windowPackets: value.windowPackets,
    dataPayloadBytes: value.dataPayloadBytes,
    maximumSignedBlobBytes: value.maximumSignedBlobBytes,
    maximumMissingSequences: value.maximumMissingSequences,
    checkpointIntervalBlocks: value.checkpointIntervalBlocks,
    capabilitySha256Hex: value.capabilitySha256Hex,
    coreCheckpoint: coreCheckpointValue === null
      ? null
      : copyCoreCheckpoint(
          coreCheckpointValue as unknown as CoreEncryptedUploadV2Checkpoint,
        ),
    highestContiguousSequence: value.highestContiguousSequence,
    evidence: evidenceValue === null
      ? null
      : copyEvidence(evidenceValue as unknown as CoreEncryptedUploadV2Evidence),
  }
  validatePersistedStateBindings(state)
  return state
}

function validatePersistedStateBindings(
  state: PersistedEncryptedUploadV2State,
): void {
  const checkpoint = state.coreCheckpoint
  if (!checkpoint) {
    if (state.highestContiguousSequence !== null || state.evidence !== null) {
      throw integrityFailure()
    }
    return
  }
  if (
    checkpoint.serialNumber !== state.serialNumber
    || uuidString(checkpoint.recordingUuid) !== state.recording.uuid
    || checkpoint.recordingGeneration !== state.recording.generation
    || uuidString(checkpoint.uploadSessionId) !== state.uploadSessionId
    || checkpoint.ownerRevision !== state.ownerRevision
    || checkpoint.transportSessionId !== state.transportSessionId
    || checkpoint.checkpointRevision === 0
    || checkpoint.nextCiphertextOffset <= 0n
    || checkpoint.nextCiphertextOffset > state.recording.ciphertextLength
    || checkpoint.windowPackets !== state.windowPackets
    || checkpoint.dataPayloadBytes !== state.dataPayloadBytes
    || state.highestContiguousSequence === null
  ) throw integrityFailure()
  const evidence = state.evidence
  if (
    evidence
    && (
      evidence.ciphertextLength !== state.recording.ciphertextLength
      || !equalBytes(
        evidence.ciphertextSha256,
        state.recording.ciphertextSha256,
      )
      || checkpoint.nextCiphertextOffset !== state.recording.ciphertextLength
      || !equalBytes(
        checkpoint.prefixSha256,
        state.recording.ciphertextSha256,
      )
    )
  ) throw integrityFailure()
}

function validateCoreCheckpoint(value: unknown): void {
  if (
    !isRecord(value)
    || typeof value.serialNumber !== 'string'
    || !(value.recordingUuid instanceof Uint8Array)
    || value.recordingUuid.byteLength !== 16
    || !isUint32(value.recordingGeneration)
    || !(value.uploadSessionId instanceof Uint8Array)
    || value.uploadSessionId.byteLength !== 16
    || !isUint32(value.ownerRevision)
    || typeof value.transportSessionId !== 'bigint'
    || !isUint32(value.checkpointRevision)
    || typeof value.nextCiphertextOffset !== 'bigint'
    || !(value.prefixSha256 instanceof Uint8Array)
    || value.prefixSha256.byteLength !== 32
    || !isPositiveU16(value.windowPackets)
    || !isPositiveU16(value.dataPayloadBytes)
  ) throw integrityFailure()
}

function validateEvidence(value: unknown): void {
  if (
    !isRecord(value)
    || typeof value.ciphertextLength !== 'bigint'
    || !(value.ciphertextSha256 instanceof Uint8Array)
    || value.ciphertextSha256.byteLength !== 32
    || value.manifestLength !== MANIFEST_LENGTH
    || !(value.manifestSha256 instanceof Uint8Array)
    || value.manifestSha256.byteLength !== 32
    || !isUint32(value.blockCount)
    || value.blockCount === 0
  ) throw integrityFailure()
}

function validateUploadRequest(
  request: unknown,
): asserts request is UploadRequestTemplate {
  if (!isRecord(request) || request.method !== 'PUT') {
    throw new BotaSDKError('upload_failed', 'upload')
  }
  if (typeof request.url !== 'string') {
    throw new BotaSDKError('upload_failed', 'upload')
  }
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    throw new BotaSDKError('upload_failed', 'upload')
  }
  if (url.protocol !== 'https:' || !isRecord(request.headers)) {
    throw new BotaSDKError('upload_failed', 'upload')
  }
  for (const [name, value] of Object.entries(request.headers)) {
    if (
      name.length === 0
      || typeof value !== 'string'
      || /[\r\n]/.test(name)
      || /[\r\n]/.test(value)
    ) throw new BotaSDKError('upload_failed', 'upload')
  }
}

function blobReadableStream(
  blob: BrowserBlobHandle,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const iterator = blob.stream(64 * 1024)[Symbol.asyncIterator]()
  return new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      try {
        if (signal.aborted) throw cancelled()
        const next = await iterator.next()
        if (next.done) controller.close()
        else controller.enqueue(next.value)
      } catch (error) {
        controller.error(error)
      }
    },
    cancel: async () => {
      await iterator.return?.()
    },
  })
}

function uuidBytes(value: string): Uint8Array {
  if (!isUuid(value)) {
    throw protocolFailure()
  }
  return hexBytes(value.replaceAll('-', ''))
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

function uuidString(value: Uint8Array): string {
  if (value.byteLength !== 16) throw protocolFailure()
  const hex = hexString(value)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function hexString(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPositiveU16(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value > 0
    && value <= 0xffff
}

function isUploadPolicy(
  value: unknown,
): value is PersistedEncryptedUploadV2State['policy'] {
  return value === 'legacy_allowed'
    || value === 'v2_preferred'
    || value === 'v2_required'
}

function safeNumber(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw protocolFailure()
  }
  return Number(value)
}

function isUint32(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= 0
    && value <= 0xffffffff
}

function throwIfCancelled(cancelledValue: boolean, signal?: AbortSignal): void {
  if (cancelledValue || signal?.aborted) throw cancelled()
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(cancelled())
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(cancelled())
    signal.addEventListener('abort', abort, { once: true })
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
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

function normalizeHostError(error: unknown): BotaSDKError {
  if (error instanceof BotaSDKError) return error
  if (error instanceof BrowserStorageError) {
    return new BotaSDKError(error.code, 'transfer_recording')
  }
  if (error instanceof BrowserTransportError) {
    const code = error.code === 'disconnected'
      ? 'device_disconnected'
      : error.code === 'permission_denied'
        ? 'permission_denied'
        : 'bluetooth_unavailable'
    return new BotaSDKError(code, 'transfer_recording')
  }
  return protocolFailure(error)
}

function protocolFailure(cause?: unknown): BotaSDKError {
  return new BotaSDKError('protocol_error', 'transfer_recording', { cause })
}

function identityFailure(): BotaSDKError {
  return new BotaSDKError('identity_mismatch', 'transfer_recording')
}

function integrityFailure(): BotaSDKError {
  return new BotaSDKError('integrity_failed', 'transfer_recording')
}

function cancelled(): BotaSDKError {
  return new BotaSDKError('cancelled', 'transfer_recording')
}

function operationInProgress(): BotaSDKError {
  return new BotaSDKError('operation_in_progress', 'transfer_recording')
}

function ownershipUnknown(cause?: unknown): BotaSDKError {
  return new BotaSDKError('integrity_failed', 'transfer_recording', { cause })
}
