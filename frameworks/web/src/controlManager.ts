import type { CoreBridge, CoreOperationResult } from './core.ts'
import { DeviceManager } from './deviceManager.ts'
import {
  BotaSDKError,
  normalizeCoreError,
  type BotaOperation,
} from './errors.ts'
import {
  BOTA_CONTROL_SERVICE,
  DEVICE_COMMAND_CHARACTERISTIC,
  DEVICE_INFORMATION_SERVICE,
  RECORDING_CONTROL_CHARACTERISTIC,
  RECORDING_STATUS_CHARACTERISTIC,
  SERIAL_NUMBER_CHARACTERISTIC,
  canonicalGattUuid,
} from './gatt.ts'
import type {
  RecordingControlRequest,
  RecordingControlResult,
} from './models.ts'
import type { RecordingControlProvider } from './providers.ts'
import {
  BrowserTransportError,
  type BrowserBluetoothTransport,
  type BrowserDeviceHandle,
  type BrowserNotification,
} from './transport.ts'
import { withSubscription } from './wifiManager.ts'
import { BrowserWorkflowRuntime } from './workflowRuntime.ts'

const DEFAULT_RESULT_TIMEOUT_MS = 30_000
const STOP_SEQUENCE_DELAY_MS = 50

interface ControlManagerOptions {
  core: CoreBridge
  transport: BrowserBluetoothTransport
  runtime: BrowserWorkflowRuntime
  devices: DeviceManager
  provider?: RecordingControlProvider | null | undefined
  resultTimeoutMs?: number | undefined
  delay?: ((milliseconds: number) => Promise<void>) | undefined
}

interface ActiveControl {
  controller: AbortController
  settled: Promise<void>
  settle(): void
}

export class ControlManager {
  private readonly core: CoreBridge
  private readonly transport: BrowserBluetoothTransport
  private readonly runtime: BrowserWorkflowRuntime
  private readonly devices: DeviceManager
  private readonly provider: RecordingControlProvider | null
  private readonly resultTimeoutMs: number
  private readonly delay: (milliseconds: number) => Promise<void>
  private activeControl: ActiveControl | null = null
  private destroyed = false
  private destroyPromise: Promise<void> | null = null

  constructor(options: ControlManagerOptions) {
    this.core = options.core
    this.transport = options.transport
    this.runtime = options.runtime
    this.devices = options.devices
    this.provider = options.provider ?? null
    this.resultTimeoutMs = options.resultTimeoutMs ?? DEFAULT_RESULT_TIMEOUT_MS
    this.delay = options.delay ?? delay
  }

  startRecording(
    request: RecordingControlRequest,
  ): Promise<RecordingControlResult> {
    return this.recordingControl('start', request)
  }

  stopRecording(
    request: RecordingControlRequest,
  ): Promise<RecordingControlResult> {
    return this.recordingControl('stop', request)
  }

  destroy(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise
    this.destroyed = true
    const active = this.activeControl
    active?.controller.abort()
    this.destroyPromise = active?.settled ?? Promise.resolve()
    return this.destroyPromise
  }

  private async recordingControl(
    action: 'start' | 'stop',
    request: RecordingControlRequest,
  ): Promise<RecordingControlResult> {
    const operationId = this.validateRequest(request)
    if (!this.provider) {
      throw new BotaSDKError('unsupported_capability', 'recording_control')
    }
    let command: Uint8Array
    try {
      command = this.core.encodeRecordingControlCommand(action)
    } catch (error) {
      throw managerError(error, 'recording_control')
    }

    try {
      return await this.runManaged(request.signal, async (signal) => {
        const { device, serialNumber } = await this.verifyConnectedDevice(signal)
        let grant: Uint8Array | null = null
        try {
          const prepared = await settled(this.provider!.prepare({
            operationId,
            serialNumber,
            action,
            authorityId: request.authorityId,
          }))
          if (prepared.kind === 'failed') {
            if (
              prepared.error instanceof BotaSDKError
              && prepared.error.code === 'authorization_expired'
            ) {
              throw new BotaSDKError(
                'authorization_expired',
                'recording_control',
              )
            }
            throw new BotaSDKError('internal_error', 'recording_control')
          }
          if (
            !(prepared.value.grant instanceof Uint8Array)
            || prepared.value.grant.byteLength === 0
          ) {
            throw new BotaSDKError('internal_error', 'recording_control')
          }
          grant = prepared.value.grant
          throwIfAborted(signal)

          return await this.executeControl(
            action,
            device,
            grant,
            command,
            signal,
          )
        } finally {
          grant?.fill(0)
        }
      })
    } catch (error) {
      const normalized = managerError(error, 'recording_control')
      if (normalized.code === 'identity_mismatch') {
        await this.devices.disconnect().catch(() => undefined)
      }
      throw normalized
    } finally {
      command.fill(0)
    }
  }

  private async executeControl(
    action: 'start' | 'stop',
    device: BrowserDeviceHandle,
    grant: Uint8Array,
    command: Uint8Array,
    signal: AbortSignal,
  ): Promise<RecordingControlResult> {
    const result = deferred<RecordingControlResult>()
    let resultWindowOpen = false
    let resultReceived = false
    return await withSubscription({
      runtime: this.runtime,
      transport: this.transport,
      device,
      serviceUuid: BOTA_CONTROL_SERVICE,
      characteristicUuid: RECORDING_STATUS_CHARACTERISTIC,
      operation: 'recording_control',
      signal,
      beforeSubscribe: async () => {
        await gattStep(
          this.transport.write(
            device,
            BOTA_CONTROL_SERVICE,
            DEVICE_COMMAND_CHARACTERISTIC,
            grant,
            true,
          ),
          signal,
        )
        if (action === 'stop') await this.controlDelay(signal)
      },
      listener: (notification) => {
        if (
          !resultWindowOpen
          || resultReceived
          || !isCharacteristic(notification, RECORDING_STATUS_CHARACTERISTIC)
        ) return
        try {
          const decoded = publicControlResult(
            this.core.decodeRecordingControlResult(notification.value),
          )
          resultReceived = true
          result.resolve(decoded)
        } catch (error) {
          resultReceived = true
          result.reject(error)
        }
      },
      body: async () => {
        if (action === 'stop') await this.controlDelay(signal)
        await gattStep(
          this.transport.write(
            device,
            BOTA_CONTROL_SERVICE,
            RECORDING_CONTROL_CHARACTERISTIC,
            command,
            true,
          ),
          signal,
        )
        resultWindowOpen = true
        return await resultWithDeadline(
          result.promise,
          signal,
          this.resultTimeoutMs,
        )
      },
    })
  }

  private async controlDelay(signal: AbortSignal): Promise<void> {
    await this.delay(STOP_SEQUENCE_DELAY_MS)
    throwIfAborted(signal)
  }

  private async runManaged<T>(
    requestSignal: AbortSignal | undefined,
    body: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.activeControl) {
      throw new BotaSDKError('operation_in_progress', 'recording_control')
    }
    let settle!: () => void
    const active: ActiveControl = {
      controller: new AbortController(),
      settled: new Promise<void>((resolve) => {
        settle = resolve
      }),
      settle: () => settle(),
    }
    this.activeControl = active
    const abort = () => active.controller.abort()
    requestSignal?.addEventListener('abort', abort, { once: true })
    if (requestSignal?.aborted) abort()
    try {
      return await this.runtime.runExclusive(
        'recording_control',
        async (runtimeSignal) => await withCombinedSignal(
          runtimeSignal,
          active.controller.signal,
          body,
        ),
      )
    } finally {
      requestSignal?.removeEventListener('abort', abort)
      if (this.activeControl === active) this.activeControl = null
      active.settle()
    }
  }

  private async verifyConnectedDevice(signal: AbortSignal): Promise<{
    device: BrowserDeviceHandle
    serialNumber: string
  }> {
    const connected = this.devices.connectedDevice
    const device = this.runtime.connectedDeviceHandle
    if (!connected || !device || connected.id !== device.id) {
      throw new BotaSDKError('device_disconnected', 'recording_control')
    }
    const encoded = await gattStep(
      this.transport.read(
        device,
        DEVICE_INFORMATION_SERVICE,
        SERIAL_NUMBER_CHARACTERISTIC,
      ),
      signal,
    )
    const serialNumber = decodeSerial(encoded)
    if (serialNumber !== connected.serialNumber) {
      throw new BotaSDKError('identity_mismatch', 'recording_control')
    }
    return { device, serialNumber }
  }

  private validateRequest(request: RecordingControlRequest): string {
    if (this.destroyed) {
      throw new BotaSDKError('cancelled', 'recording_control')
    }
    if (
      !request
      || typeof request.authorityId !== 'string'
      || request.authorityId.length === 0
      || (request.operationId !== undefined
        && (typeof request.operationId !== 'string'
          || request.operationId.length === 0))
    ) {
      throw new BotaSDKError('invalid_input', 'recording_control')
    }
    if (request.signal?.aborted) {
      throw new BotaSDKError('cancelled', 'recording_control')
    }
    return request.operationId ?? `recording_control:${crypto.randomUUID()}`
  }
}

function publicControlResult(result: CoreOperationResult): RecordingControlResult {
  if (result.success) return { success: true }
  if (result.error === 'grant_expired') {
    throw new BotaSDKError('authorization_expired', 'recording_control')
  }
  const error = result.error === 'already_recording'
    || result.error === 'not_recording'
    || result.error === 'invalid_grant'
    || result.error === 'invalid_state'
    || result.error === 'invalid_response'
    ? result.error
    : 'unknown_error'
  return {
    success: false,
    error,
    ...(typeof result.errorRaw === 'number'
      ? { errorRaw: result.errorRaw }
      : {}),
  }
}

async function gattStep<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  const outcome = await settled(promise)
  if (outcome.kind === 'failed') throw outcome.error
  throwIfAborted(signal)
  return outcome.value
}

async function resultWithDeadline<T>(
  result: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<T> {
  throwIfAborted(signal)
  let timer: ReturnType<typeof setTimeout> | null = null
  let cancel!: () => void
  const cancellation = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(new BotaSDKError('cancelled', 'recording_control'))
  })
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new BotaSDKError('connection_failed', 'recording_control', {
        retryable: true,
      }))
    }, timeoutMs)
  })
  signal.addEventListener('abort', cancel, { once: true })
  try {
    return await Promise.race([result, cancellation, timeout])
  } finally {
    signal.removeEventListener('abort', cancel)
    if (timer) clearTimeout(timer)
  }
}

async function withCombinedSignal<T>(
  primary: AbortSignal,
  secondary: AbortSignal,
  body: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  primary.addEventListener('abort', abort, { once: true })
  secondary.addEventListener('abort', abort, { once: true })
  if (primary.aborted || secondary.aborted) controller.abort()
  try {
    return await body(controller.signal)
  } finally {
    primary.removeEventListener('abort', abort)
    secondary.removeEventListener('abort', abort)
  }
}

function managerError(error: unknown, operation: BotaOperation): BotaSDKError {
  if (error instanceof BotaSDKError) {
    return new BotaSDKError(error.code, operation, {
      retryable: error.retryable,
      protocolStatus: error.protocolStatus,
    })
  }
  if (error instanceof BrowserTransportError) {
    const code = error.code === 'disconnected'
      ? 'device_disconnected'
      : error.code === 'permission_denied'
        ? 'permission_denied'
        : 'bluetooth_unavailable'
    return new BotaSDKError(code, operation)
  }
  const normalized = normalizeCoreError(error, operation)
  return new BotaSDKError(normalized.code, operation, {
    retryable: normalized.retryable,
    protocolStatus: normalized.protocolStatus,
  })
}

function decodeSerial(value: Uint8Array): string {
  try {
    const serial = new TextDecoder('utf-8', { fatal: true })
      .decode(value)
      .replace(/^[\0\s]+|[\0\s]+$/g, '')
    if (!serial) throw new Error('empty')
    return serial
  } catch {
    throw new BotaSDKError('protocol_error', 'recording_control')
  }
}

function isCharacteristic(
  notification: BrowserNotification,
  characteristicUuid: string,
): boolean {
  return canonicalGattUuid(notification.characteristicUuid)
    === canonicalGattUuid(characteristicUuid)
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new BotaSDKError('cancelled', 'recording_control')
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
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

type Settled<T> =
  | { kind: 'completed'; value: T }
  | { kind: 'failed'; error: unknown }

async function settled<T>(promise: Promise<T>): Promise<Settled<T>> {
  return await promise.then<Settled<T>, Settled<T>>(
    (value) => ({ kind: 'completed', value }),
    (error: unknown) => ({ kind: 'failed', error }),
  )
}
