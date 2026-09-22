import type { CoreBridge, CoreNotification } from './core.ts'
import {
  DeviceManager,
  verifyActiveDeviceSerial,
} from './deviceManager.ts'
import { BotaSDKError, normalizeCoreError } from './errors.ts'
import {
  BOTA_DIAGNOSTICS_SERVICE,
  DEVICE_LOG_DATA_CHARACTERISTIC,
} from './gatt.ts'
import type { DeviceLogLine, DeviceLogSubscription } from './models.ts'
import {
  BrowserWorkflowRuntime,
  createBrowserPersistenceHost,
  type CharacteristicLease,
  type WorkflowResult,
} from './workflowRuntime.ts'

interface LogManagerOptions {
  core: CoreBridge
  runtime: BrowserWorkflowRuntime
  devices: DeviceManager
}

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
}

type WorkflowOutcome =
  | { kind: 'completed'; result: WorkflowResult }
  | { kind: 'failed'; error: BotaSDKError }

interface LogOwner {
  operationId: string
  cancellationId: Uint8Array
  lease: CharacteristicLease
  listener: ((line: DeviceLogLine) => void) | null
  ready: Deferred<void>
  outcome: Promise<WorkflowOutcome>
  settled: Promise<void>
  closing: boolean
  closed: boolean
  terminalError: BotaSDKError | null
  closePromise: Promise<void> | null
}

export class LogManager {
  private readonly core: CoreBridge
  private readonly runtime: BrowserWorkflowRuntime
  private readonly devices: DeviceManager
  private activeOwner: LogOwner | null = null
  private destroyed = false
  private destroyPromise: Promise<void> | null = null

  constructor(options: LogManagerOptions) {
    this.core = options.core
    this.runtime = options.runtime
    this.devices = options.devices
  }

  async subscribe(
    listener: (line: DeviceLogLine) => void,
  ): Promise<DeviceLogSubscription> {
    if (this.destroyed) {
      throw new BotaSDKError('cancelled', 'read_device_logs')
    }
    if (typeof listener !== 'function') {
      throw new BotaSDKError('invalid_input', 'read_device_logs')
    }
    if (this.activeOwner) {
      throw new BotaSDKError('operation_in_progress', 'read_device_logs')
    }

    const connected = await verifyActiveDeviceSerial(
      this.devices,
      'read_device_logs',
    )
    const device = this.runtime.connectedDeviceHandle
    if (!device || connected.id !== device.id) {
      throw new BotaSDKError('device_disconnected', 'read_device_logs')
    }

    let lease: CharacteristicLease
    try {
      lease = this.runtime.claimCharacteristicLease(
        'read_device_logs',
        device,
        BOTA_DIAGNOSTICS_SERVICE,
        DEVICE_LOG_DATA_CHARACTERISTIC,
      )
    } catch (error) {
      throw managerError(error)
    }

    const cancellationId = randomBytes(16)
    const operationId = `read_device_logs:${bytesHex(cancellationId)}`
    const owner = {
      operationId,
      cancellationId,
      lease,
      listener,
      ready: deferred<void>(),
      outcome: Promise.resolve({
        kind: 'failed',
        error: new BotaSDKError('internal_error', 'read_device_logs'),
      } as WorkflowOutcome),
      settled: Promise.resolve(),
      closing: false,
      closed: false,
      terminalError: null,
      closePromise: null,
    } satisfies LogOwner
    this.activeOwner = owner

    const workflow = this.runtime.run(
      operationId,
      cancellationId,
      () => this.core.startDeviceLogs({
        serialNumber: connected.serialNumber,
        cancellationId: cancellationId.slice(),
      }),
      { persistence: createBrowserPersistenceHost(null) },
      {
        onNotification: (notification) => this.deliver(owner, notification),
        onRunning: () => owner.ready.resolve(undefined),
      },
    )
    owner.outcome = workflow.then<WorkflowOutcome, WorkflowOutcome>(
      (result) => ({ kind: 'completed', result }),
      (error: unknown) => ({ kind: 'failed', error: managerError(error) }),
    )
    owner.settled = owner.outcome.then((outcome) => {
      this.finishOwner(owner, outcome)
    })

    try {
      await Promise.race([
        owner.ready.promise,
        owner.outcome.then((outcome) => {
          if (outcome.kind === 'failed') throw outcome.error
          throw unexpectedStreamEnd()
        }),
      ])
      if (this.destroyed || owner.closing || owner.closed) {
        await this.closeOwner(owner)
        throw owner.terminalError
          ?? new BotaSDKError('cancelled', 'read_device_logs')
      }
      return {
        remove: async () => await this.closeOwner(owner),
      }
    } catch (error) {
      if (!owner.closed) {
        await this.closeOwner(owner).catch(() => undefined)
      }
      throw managerError(error)
    }
  }

  destroy(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise
    this.destroyed = true
    const owner = this.activeOwner
    this.destroyPromise = owner
      ? this.closeOwner(owner).catch(() => undefined)
      : Promise.resolve()
    return this.destroyPromise
  }

  private deliver(owner: LogOwner, notification: CoreNotification): void {
    if (
      notification.kind !== 'device_log'
      || owner.closing
      || owner.closed
      || this.activeOwner !== owner
    ) return
    if (
      typeof notification.message !== 'string'
      || typeof notification.isBacklog !== 'boolean'
    ) {
      owner.terminalError ??= new BotaSDKError(
        'protocol_error',
        'read_device_logs',
      )
      void this.closeOwner(owner).catch(() => undefined)
      return
    }
    const listener = owner.listener
    if (!listener) return
    try {
      const completion = (listener as (line: DeviceLogLine) => unknown)({
        message: notification.message,
        isBacklog: notification.isBacklog,
      })
      if (isPromiseLike(completion)) {
        void Promise.resolve(completion).catch(() => {
          void this.closeOwner(owner).catch(() => undefined)
        })
      }
    } catch {
      void this.closeOwner(owner).catch(() => undefined)
    }
  }

  private closeOwner(owner: LogOwner): Promise<void> {
    if (owner.closePromise) return owner.closePromise
    owner.closing = true
    owner.listener = null
    owner.closePromise = (async () => {
      let cancellationError: BotaSDKError | null = null
      if (!owner.closed) {
        try {
          await this.runtime.cancel(owner.operationId)
        } catch (error) {
          cancellationError = managerError(error)
        }
        await owner.settled
      }
      if (owner.terminalError) throw owner.terminalError
      if (cancellationError) throw cancellationError
    })()
    return owner.closePromise
  }

  private finishOwner(owner: LogOwner, outcome: WorkflowOutcome): void {
    if (owner.closed) return
    owner.closed = true
    owner.listener = null
    if (!owner.closing) {
      owner.terminalError = outcome.kind === 'failed'
        ? outcome.error
        : unexpectedStreamEnd()
    } else if (
      outcome.kind === 'failed'
      && outcome.error.code !== 'cancelled'
      && owner.terminalError === null
    ) {
      owner.terminalError = outcome.error
    }
    owner.cancellationId.fill(0)
    owner.lease.release()
    if (this.activeOwner === owner) this.activeOwner = null
  }
}

function unexpectedStreamEnd(): BotaSDKError {
  return new BotaSDKError('connection_failed', 'read_device_logs', {
    retryable: true,
  })
}

function managerError(error: unknown): BotaSDKError {
  return normalizeCoreError(error, 'read_device_logs')
}

function randomBytes(length: number): Uint8Array {
  const value = new Uint8Array(length)
  globalThis.crypto.getRandomValues(value)
  return value
}

function bytesHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { then?: unknown }).then === 'function'
}
