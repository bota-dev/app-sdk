import type {
  CoreBridge,
  CoreOperationResult,
  CoreWiFiScanUpdate,
  CoreWiFiStatusInfo,
} from './core.ts'
import { DeviceManager } from './deviceManager.ts'
import {
  BotaSDKError,
  CoreBridgeError,
  normalizeCoreError,
  type BotaOperation,
} from './errors.ts'
import {
  BOTA_WIFI_CONFIG_SERVICE,
  DEVICE_INFORMATION_SERVICE,
  SERIAL_NUMBER_CHARACTERISTIC,
  WIFI_CREDENTIAL_CHARACTERISTIC,
  WIFI_GRANT_CHARACTERISTIC,
  WIFI_SCAN_CHARACTERISTIC,
  WIFI_STATUS_CHARACTERISTIC,
  canonicalGattUuid,
} from './gatt.ts'
import type {
  WiFiConfigResult,
  WiFiCredentials,
  WiFiScanResult,
  WiFiStatusInfo,
  WiFiStatusSubscription,
} from './models.ts'
import {
  BrowserTransportError,
  type BrowserBluetoothTransport,
  type BrowserDeviceHandle,
  type BrowserNotification,
  type BrowserSubscription,
} from './transport.ts'
import {
  BrowserWorkflowRuntime,
  type CharacteristicLease,
} from './workflowRuntime.ts'

const DEFAULT_OPERATION_TIMEOUT_MS = 30_000

interface WiFiManagerOptions {
  core: CoreBridge
  transport: BrowserBluetoothTransport
  runtime: BrowserWorkflowRuntime
  devices: DeviceManager
  operationTimeoutMs?: number | undefined
}

interface ManagedOperation {
  controller: AbortController
  settled: Promise<void>
  settle(): void
}

interface PassiveStatusOwner {
  deviceId: string
  lease: CharacteristicLease
  subscriptionPromise: Promise<BrowserSubscription>
  closing: boolean
  closePromise: Promise<void> | null
}

interface SubscriptionOptions<T> {
  runtime: BrowserWorkflowRuntime
  transport: BrowserBluetoothTransport
  device: BrowserDeviceHandle
  serviceUuid: string
  characteristicUuid: string
  operation: BotaOperation
  signal: AbortSignal
  listener(notification: BrowserNotification): void
  beforeSubscribe?: (() => Promise<void>) | undefined
  body(): Promise<T>
}

export class WiFiManager {
  private readonly core: CoreBridge
  private readonly transport: BrowserBluetoothTransport
  private readonly runtime: BrowserWorkflowRuntime
  private readonly devices: DeviceManager
  private readonly operationTimeoutMs: number
  private readonly removeDisconnectListener: () => void
  private activeOperation: ManagedOperation | null = null
  private statusOwner: PassiveStatusOwner | null = null
  private destroyed = false
  private destroyPromise: Promise<void> | null = null

  constructor(options: WiFiManagerOptions) {
    this.core = options.core
    this.transport = options.transport
    this.runtime = options.runtime
    this.devices = options.devices
    this.operationTimeoutMs =
      options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS
    this.removeDisconnectListener = this.runtime.onDeviceDisconnected(
      (deviceId) => {
        const owner = this.statusOwner
        if (owner?.deviceId === deviceId) {
          void this.closeStatusOwner(owner)
        }
      },
    )
  }

  async scanNetworks(): Promise<WiFiScanResult> {
    this.requireUsable()
    let command: Uint8Array
    try {
      command = this.core.encodeWiFiScanCommand()
    } catch (error) {
      throw managerError(error, 'wifi')
    }

    try {
      return await this.runManaged(async (signal) => {
        const device = await this.verifyConnectedDevice(signal)
        const result = deferred<WiFiScanResult>()
        let resultWindowOpen = false
        let resultReceived = false
        return await withSubscription({
          runtime: this.runtime,
          transport: this.transport,
          device,
          serviceUuid: BOTA_WIFI_CONFIG_SERVICE,
          characteristicUuid: WIFI_SCAN_CHARACTERISTIC,
          operation: 'wifi',
          signal,
          listener: (notification) => {
            if (
              !resultWindowOpen
              || resultReceived
              || !isCharacteristic(notification, WIFI_SCAN_CHARACTERISTIC)
            ) return
            try {
              const update = this.core.decodeWiFiScanUpdate(notification.value)
              if (update.kind === 'pending') return
              resultReceived = true
              result.resolve(publicScanResult(update))
            } catch (error) {
              resultReceived = true
              result.reject(error)
            }
          },
          body: async () => {
            await gattStep(
              this.transport.write(
                device,
                BOTA_WIFI_CONFIG_SERVICE,
                WIFI_SCAN_CHARACTERISTIC,
                command,
                true,
              ),
              signal,
              'wifi',
            )
            resultWindowOpen = true
            return await resultWithDeadline(
              result.promise,
              signal,
              this.operationTimeoutMs,
              'wifi',
            )
          },
        })
      })
    } catch (error) {
      throw await this.normalizeFailure(error)
    } finally {
      command.fill(0)
    }
  }

  async configure(
    credentials: WiFiCredentials,
    grant: string,
  ): Promise<WiFiConfigResult> {
    this.requireUsable()
    if (
      typeof credentials !== 'object'
      || credentials === null
      || typeof credentials.ssid !== 'string'
      || typeof credentials.password !== 'string'
      || typeof grant !== 'string'
    ) {
      throw new BotaSDKError('invalid_input', 'wifi')
    }
    let encodedGrant: Uint8Array | null = null
    let encodedCredentials: Uint8Array | null = null
    try {
      try {
        encodedCredentials = this.core.encodeWiFiCredentials(
          credentials.ssid,
          credentials.password,
        )
        encodedGrant = this.core.encodeWiFiGrant(
          grant,
          this.transport.maximumWriteValueLength,
        )
      } catch (error) {
        throw managerError(error, 'wifi')
      }
      if (!encodedCredentials || !encodedGrant) {
        throw new BotaSDKError('internal_error', 'wifi')
      }
      const operationCredentials = encodedCredentials
      const operationGrant = encodedGrant

      try {
        return await this.runManaged(async (signal) => {
          const device = await this.verifyConnectedDevice(signal)
          return await this.configureWithSubscription(
            device,
            operationCredentials,
            signal,
            async () => {
              await gattStep(
                this.transport.write(
                  device,
                  BOTA_WIFI_CONFIG_SERVICE,
                  WIFI_GRANT_CHARACTERISTIC,
                  operationGrant,
                  true,
                ),
                signal,
                'wifi',
              )
            },
          )
        })
      } catch (error) {
        throw await this.normalizeFailure(error)
      }
    } finally {
      encodedGrant?.fill(0)
      encodedCredentials?.fill(0)
    }
  }

  async disconnect(): Promise<WiFiConfigResult> {
    this.requireUsable()
    let command: Uint8Array
    try {
      command = this.core.encodeWiFiCredentials('', '')
    } catch (error) {
      throw managerError(error, 'wifi')
    }

    try {
      return await this.runManaged(async (signal) => {
        const device = await this.verifyConnectedDevice(signal)
        return await this.configureWithSubscription(
          device,
          command,
          signal,
        )
      })
    } catch (error) {
      throw await this.normalizeFailure(error)
    } finally {
      command.fill(0)
    }
  }

  async readStatus(): Promise<WiFiStatusInfo> {
    this.requireUsable()
    try {
      return await this.runManaged(async (signal) => {
        const device = await this.verifyConnectedDevice(signal)
        const encoded = await gattStep(
          this.transport.read(
            device,
            BOTA_WIFI_CONFIG_SERVICE,
            WIFI_STATUS_CHARACTERISTIC,
          ),
          signal,
          'wifi',
        )
        return publicStatus(this.core.decodeWiFiStatus(encoded))
      })
    } catch (error) {
      throw await this.normalizeFailure(error)
    }
  }

  async subscribeToStatus(
    listener: (status: WiFiStatusInfo) => void,
  ): Promise<WiFiStatusSubscription> {
    this.requireUsable()
    if (typeof listener !== 'function') {
      throw new BotaSDKError('invalid_input', 'wifi')
    }
    const device = this.requireConnectedDevice()
    let lease: CharacteristicLease
    try {
      lease = this.runtime.claimCharacteristicLease(
        'wifi',
        device,
        BOTA_WIFI_CONFIG_SERVICE,
        WIFI_STATUS_CHARACTERISTIC,
      )
    } catch (error) {
      throw managerError(error, 'wifi')
    }

    let owner: PassiveStatusOwner | null = null
    const pendingNotifications: BrowserNotification[] = []
    const deliverNotification = (notification: BrowserNotification): void => {
      const currentOwner = owner
      if (!currentOwner) {
        pendingNotifications.push({
          characteristicUuid: notification.characteristicUuid,
          value: notification.value.slice(),
        })
        return
      }
      if (
        currentOwner.closing
        || this.destroyed
        || !isCharacteristic(notification, WIFI_STATUS_CHARACTERISTIC)
      ) return
      try {
        const status = publicStatus(this.core.decodeWiFiStatus(notification.value))
        const completion = (listener as (value: WiFiStatusInfo) => unknown)(status)
        if (isPromiseLike(completion)) {
          void Promise.resolve(completion).catch(() => {
            void this.closeStatusOwner(currentOwner)
          })
        }
      } catch {
        void this.closeStatusOwner(currentOwner)
      }
    }
    let subscriptionPromise: Promise<BrowserSubscription>
    try {
      subscriptionPromise = this.transport.subscribe(
        device,
        BOTA_WIFI_CONFIG_SERVICE,
        WIFI_STATUS_CHARACTERISTIC,
        deliverNotification,
      )
    } catch (error) {
      lease.release()
      throw managerError(error, 'wifi')
    }
    owner = {
      deviceId: device.id,
      lease,
      subscriptionPromise,
      closing: false,
      closePromise: null,
    }
    this.statusOwner = owner
    for (const notification of pendingNotifications.splice(0)) {
      deliverNotification(notification)
    }

    try {
      await subscriptionPromise
      if (this.destroyed || owner.closing) {
        await this.closeStatusOwner(owner)
        throw new BotaSDKError('cancelled', 'wifi')
      }
      return {
        remove: async () => await this.closeStatusOwner(owner),
      }
    } catch (error) {
      await this.closeStatusOwner(owner)
      throw managerError(error, 'wifi')
    }
  }

  destroy(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise
    this.destroyed = true
    this.removeDisconnectListener()
    const operation = this.activeOperation
    operation?.controller.abort()
    const statusOwner = this.statusOwner
    this.destroyPromise = Promise.all([
      operation?.settled ?? Promise.resolve(),
      statusOwner
        ? this.closeStatusOwner(statusOwner)
        : Promise.resolve(),
    ]).then(() => undefined)
    return this.destroyPromise
  }

  private async configureWithSubscription(
    device: BrowserDeviceHandle,
    credentials: Uint8Array,
    signal: AbortSignal,
    beforeSubscribe?: () => Promise<void>,
  ): Promise<WiFiConfigResult> {
    const result = deferred<WiFiConfigResult>()
    let resultWindowOpen = false
    let resultReceived = false
    return await withSubscription({
      runtime: this.runtime,
      transport: this.transport,
      device,
      serviceUuid: BOTA_WIFI_CONFIG_SERVICE,
      characteristicUuid: WIFI_STATUS_CHARACTERISTIC,
      operation: 'wifi',
      signal,
      beforeSubscribe,
      listener: (notification) => {
        if (
          !resultWindowOpen
          || resultReceived
          || !isCharacteristic(notification, WIFI_STATUS_CHARACTERISTIC)
        ) return
        try {
          resultReceived = true
          result.resolve(publicConfigResult(
            this.core.decodeWiFiConfigResult(notification.value),
          ))
        } catch (error) {
          resultReceived = true
          result.reject(error)
        }
      },
      body: async () => {
        await gattStep(
          this.transport.write(
            device,
            BOTA_WIFI_CONFIG_SERVICE,
            WIFI_CREDENTIAL_CHARACTERISTIC,
            credentials,
            true,
          ),
          signal,
          'wifi',
        )
        resultWindowOpen = true
        return await resultWithDeadline(
          result.promise,
          signal,
          this.operationTimeoutMs,
          'wifi',
        )
      },
    })
  }

  private async runManaged<T>(
    body: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.activeOperation) {
      throw new BotaSDKError('operation_in_progress', 'wifi')
    }
    let settle!: () => void
    const active: ManagedOperation = {
      controller: new AbortController(),
      settled: new Promise<void>((resolve) => {
        settle = resolve
      }),
      settle: () => settle(),
    }
    this.activeOperation = active
    try {
      return await this.runtime.runExclusive('wifi', async (runtimeSignal) =>
        await withCombinedSignal(
          runtimeSignal,
          active.controller.signal,
          body,
        ))
    } finally {
      if (this.activeOperation === active) this.activeOperation = null
      active.settle()
    }
  }

  private async verifyConnectedDevice(
    signal: AbortSignal,
  ): Promise<BrowserDeviceHandle> {
    const connected = this.devices.connectedDevice
    const device = this.runtime.connectedDeviceHandle
    if (!connected || !device || connected.id !== device.id) {
      throw new BotaSDKError('device_disconnected', 'wifi')
    }
    const encoded = await gattStep(
      this.transport.read(
        device,
        DEVICE_INFORMATION_SERVICE,
        SERIAL_NUMBER_CHARACTERISTIC,
      ),
      signal,
      'wifi',
    )
    if (decodeSerial(encoded) !== connected.serialNumber) {
      throw new BotaSDKError('identity_mismatch', 'wifi')
    }
    return device
  }

  private requireConnectedDevice(): BrowserDeviceHandle {
    const connected = this.devices.connectedDevice
    const device = this.runtime.connectedDeviceHandle
    if (!connected || !device || connected.id !== device.id) {
      throw new BotaSDKError('device_disconnected', 'wifi')
    }
    return device
  }

  private async normalizeFailure(error: unknown): Promise<BotaSDKError> {
    const normalized = managerError(error, 'wifi')
    if (normalized.code === 'identity_mismatch') {
      await this.devices.disconnect().catch(() => undefined)
    }
    return normalized
  }

  private closeStatusOwner(owner: PassiveStatusOwner): Promise<void> {
    if (owner.closePromise) return owner.closePromise
    owner.closing = true
    owner.closePromise = (async () => {
      const subscription = await settled(owner.subscriptionPromise)
      if (subscription.kind === 'completed') {
        await subscription.value.remove().catch(() => undefined)
      }
      owner.lease.release()
      if (this.statusOwner === owner) this.statusOwner = null
    })()
    return owner.closePromise
  }

  private requireUsable(): void {
    if (this.destroyed) throw new BotaSDKError('cancelled', 'wifi')
  }
}

export async function withSubscription<T>(
  options: SubscriptionOptions<T>,
): Promise<T> {
  const lease = options.runtime.claimCharacteristicLease(
    options.operation,
    options.device,
    options.serviceUuid,
    options.characteristicUuid,
  )
  let subscription: BrowserSubscription | null = null
  try {
    await options.beforeSubscribe?.()
    throwIfAborted(options.signal, options.operation)
    const setup = await settled(options.transport.subscribe(
      options.device,
      options.serviceUuid,
      options.characteristicUuid,
      options.listener,
    ))
    if (setup.kind === 'failed') throw setup.error
    subscription = setup.value
    throwIfAborted(options.signal, options.operation)
    return await options.body()
  } finally {
    if (subscription) await subscription.remove().catch(() => undefined)
    lease.release()
  }
}

function publicScanResult(
  update: Extract<CoreWiFiScanUpdate, { kind: 'done' }>,
): WiFiScanResult {
  return {
    networks: update.networks.map((network) => ({ ...network })),
    currentSsid: update.currentSsid,
  }
}

function publicStatus(status: CoreWiFiStatusInfo): WiFiStatusInfo {
  return {
    status: status.status,
    statusRaw: status.statusRaw,
    ...(typeof status.signalStrength === 'number'
      ? { signalStrength: status.signalStrength }
      : {}),
    ...(typeof status.ssid === 'string' ? { ssid: status.ssid } : {}),
    ...(typeof status.lastError === 'string'
      ? { lastError: status.lastError }
      : {}),
  }
}

function publicConfigResult(result: CoreOperationResult): WiFiConfigResult {
  if (result.success) return { success: true }
  const error = result.error === 'invalid_grant'
    || result.error === 'grant_expired'
    || result.error === 'decryption_error'
    || result.error === 'storage_error'
    ? result.error
    : 'unknown'
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
  operation: BotaOperation,
): Promise<T> {
  const outcome = await settled(promise)
  if (outcome.kind === 'failed') throw outcome.error
  throwIfAborted(signal, operation)
  return outcome.value
}

async function resultWithDeadline<T>(
  result: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
  operation: BotaOperation,
): Promise<T> {
  throwIfAborted(signal, operation)
  let timer: ReturnType<typeof setTimeout> | null = null
  let cancel!: () => void
  const cancellation = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(new BotaSDKError('cancelled', operation))
  })
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new BotaSDKError('connection_failed', operation, {
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
  if (
    error instanceof CoreBridgeError
    && (error.code === 'invalid_input' || error.code === 'payload_too_large')
  ) {
    return new BotaSDKError('invalid_input', operation)
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
    throw new BotaSDKError('protocol_error', 'wifi')
  }
}

function isCharacteristic(
  notification: BrowserNotification,
  characteristicUuid: string,
): boolean {
  return canonicalGattUuid(notification.characteristicUuid)
    === canonicalGattUuid(characteristicUuid)
}

function throwIfAborted(signal: AbortSignal, operation: BotaOperation): void {
  if (signal.aborted) throw new BotaSDKError('cancelled', operation)
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

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { then?: unknown }).then === 'function'
}
