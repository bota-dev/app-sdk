import type { CoreBridge, CoreEffectEnvelope } from './core.ts'
import { detectBrowserCapabilities } from './capabilities.ts'
import { BotaSDKError, normalizeCoreError, type BotaOperation } from './errors.ts'
import {
  BOTA_CONTROL_SERVICE,
  BOTA_STORAGE_SERVICE,
  DEVICE_INFORMATION_SERVICE,
  DEVICE_STATUS_CHARACTERISTIC,
  FIRMWARE_REVISION_CHARACTERISTIC,
  HARDWARE_REVISION_CHARACTERISTIC,
  MODEL_NUMBER_CHARACTERISTIC,
  SERIAL_NUMBER_CHARACTERISTIC,
  STORAGE_TRANSFER_CAPABILITIES_V2_CHARACTERISTIC,
} from './gatt.ts'
import type {
  BrowserCapabilities,
  ConnectOptions,
  ConnectedDevice,
  DeviceSnapshot,
  EncryptedUploadV2Capabilities,
  ReconnectOptions,
} from './models.ts'
import {
  BrowserStorageError,
  type BrowserSdkStorage,
} from './storage.ts'
import {
  BrowserTransportError,
  type BrowserBluetoothTransport,
  type BrowserDeviceHandle,
} from './transport.ts'
import {
  BrowserWorkflowRuntime,
  createBrowserPersistenceHost,
  type WorkflowResult,
} from './workflowRuntime.ts'

const SERIAL_PATTERN = /^[A-Za-z0-9]{1,64}$/
const CONNECTION_TIMEOUT_MS = 15_000n

interface DeviceManagerOptions {
  runtime?: BrowserWorkflowRuntime
  storage?: BrowserSdkStorage | null
}

type DirectStepResult<T> =
  | { kind: 'completed'; value: T }
  | { kind: 'failed'; error: unknown }
  | { kind: 'cancelled' }

export class DeviceManager {
  private readonly core: CoreBridge
  private readonly transport: BrowserBluetoothTransport
  private readonly runtime: BrowserWorkflowRuntime
  private readonly storage: BrowserSdkStorage | null
  private readonly capabilities: BrowserCapabilities
  private readonly persistenceHost: ReturnType<typeof createBrowserPersistenceHost>
  private activeDevice: BrowserDeviceHandle | null = null
  private verifiedDevice: ConnectedDevice | null = null
  private removeDisconnectListener: (() => void) | null = null
  private operationActive = false
  private destroyed = false
  private destroyPromise: Promise<void> | null = null

  constructor(
    core: CoreBridge,
    transport: BrowserBluetoothTransport,
    options: DeviceManagerOptions = {},
  ) {
    this.core = core
    this.transport = transport
    this.runtime = options.runtime ?? new BrowserWorkflowRuntime(core, transport)
    this.storage = options.storage ?? null
    this.capabilities = detectBrowserCapabilities(transport)
    this.persistenceHost = createBrowserPersistenceHost(this.storage)
  }

  get isSupported(): boolean {
    return this.transport.isSupported
  }

  get connectedDevice(): ConnectedDevice | null {
    return this.verifiedDevice
  }

  getCapabilities(): BrowserCapabilities {
    return this.capabilities
  }

  async connect(options: ConnectOptions): Promise<ConnectedDevice> {
    this.validateConnectionRequest(options.expectedSerialNumber, 'connect')
    if (!this.isSupported) {
      throw new BotaSDKError('unsupported_browser', 'connect')
    }
    this.claimConnectionStart('connect')

    try {
      const selected = await this.transport.requestDevice().catch(
        (error: unknown) => {
          throw pickerError(error)
        },
      )
      if (this.destroyed) throw new BotaSDKError('cancelled', 'connect')

      this.runtime.registerDevice(selected)
      this.installActiveDevice(selected)
      const cancellationId = randomCancellationId()
      const result = await this.runtime.run(
        operationId('connect', cancellationId),
        cancellationId,
        () => this.core.startExactConnection({
          expectedSerialNumber: options.expectedSerialNumber,
          peripheralId: selected.id,
          name: selected.name,
          cancellationId,
        }),
        { persistence: this.persistenceHost },
      )
      return this.publishConnectedDevice(
        result,
        options.expectedSerialNumber,
        'connect',
      )
    } catch (error) {
      const lifecycleCancelled = this.destroyed
      if (lifecycleCancelled && this.activeDevice) {
        await this.runtime.waitForPendingConnection(this.activeDevice.id)
      }
      await this.cleanupFailedConnection()
      if (lifecycleCancelled) {
        throw new BotaSDKError('cancelled', 'connect', { cause: error })
      }
      throw normalizeManagerError(error, 'connect')
    } finally {
      this.operationActive = false
    }
  }

  async reconnect(options: ReconnectOptions): Promise<ConnectedDevice> {
    this.validateConnectionRequest(options.expectedSerialNumber, 'reconnect')
    if (!this.isSupported) {
      throw new BotaSDKError('unsupported_browser', 'reconnect')
    }
    if (!this.transport.supportsAuthorizedDevices) {
      throw new BotaSDKError('picker_required', 'reconnect')
    }
    if (!this.storage) throw new BotaSDKError('picker_required', 'reconnect')
    this.claimConnectionStart('reconnect')
    let attemptedDeviceId: string | null = null

    try {
      const hint = await this.storage.loadVerifiedDevice(
        options.expectedSerialNumber,
      )
      if (!hint) throw new BotaSDKError('picker_required', 'reconnect')
      if (this.destroyed) throw new BotaSDKError('cancelled', 'reconnect')

      const hintedDevice: BrowserDeviceHandle = {
        id: hint.browserDeviceId,
        name: hint.name,
      }
      attemptedDeviceId = hintedDevice.id
      this.activeDevice = hintedDevice
      this.runtime.registerDevice(hintedDevice)
      const cancellationId = randomCancellationId()
      const result = await this.runtime.run(
        operationId('reconnect', cancellationId),
        cancellationId,
        () => this.core.startReconnect({
          expectedSerialNumber: options.expectedSerialNumber,
          hint: {
            storedPeripheralId: hint.browserDeviceId,
            advertisedAddress: null,
            storedName: hint.name,
            scanTimeoutMs: CONNECTION_TIMEOUT_MS,
            connectionTimeoutMs: CONNECTION_TIMEOUT_MS,
          },
          cancellationId,
        }),
        { persistence: this.persistenceHost },
      )
      return this.publishConnectedDevice(
        result,
        options.expectedSerialNumber,
        'reconnect',
      )
    } catch (error) {
      const lifecycleCancelled = this.destroyed
      if (lifecycleCancelled && attemptedDeviceId) {
        await this.runtime.waitForPendingConnection(attemptedDeviceId)
      }
      await this.cleanupFailedConnection()
      if (lifecycleCancelled) {
        throw new BotaSDKError('cancelled', 'reconnect', { cause: error })
      }
      throw normalizeManagerError(error, 'reconnect')
    } finally {
      this.operationActive = false
    }
  }

  async disconnect(): Promise<void> {
    if (this.destroyed) return
    if (this.operationActive) {
      throw new BotaSDKError('operation_in_progress', 'disconnect')
    }
    const device = this.runtime.connectedDeviceHandle ?? this.activeDevice
    if (!device) {
      this.clearConnection()
      return
    }

    try {
      await this.runtime.runExclusive('disconnect', async (signal) => {
        this.runtime.markDeviceDisconnected(device.id)
        this.clearConnection()
        await awaitDirectStep(
          this.transport.disconnect(device),
          signal,
          'disconnect',
        )
      })
    } catch (error) {
      throw normalizeManagerError(error, 'disconnect')
    }
  }

  async readSnapshot(): Promise<DeviceSnapshot> {
    if (this.destroyed) {
      throw new BotaSDKError('cancelled', 'read_snapshot')
    }
    if (this.operationActive) {
      throw new BotaSDKError('operation_in_progress', 'read_snapshot')
    }
    const device = this.activeDevice
    const connected = this.verifiedDevice
    if (
      !device
      || !connected
      || this.runtime.connectedDeviceHandle?.id !== device.id
    ) {
      throw new BotaSDKError('device_disconnected', 'read_snapshot')
    }

    try {
      return await this.runtime.runExclusive(
        'read_snapshot',
        async (signal) => {
          const serialNumber = await this.readRequiredText(
            device,
            DEVICE_INFORMATION_SERVICE,
            SERIAL_NUMBER_CHARACTERISTIC,
            signal,
          )
          if (serialNumber !== connected.serialNumber) {
            await this.disconnectForIdentityMismatch(device)
            throw new BotaSDKError('identity_mismatch', 'read_snapshot')
          }

          const modelNumber = await this.readOptionalText(
            device,
            DEVICE_INFORMATION_SERVICE,
            MODEL_NUMBER_CHARACTERISTIC,
            signal,
          )
          const hardwareRevision = await this.readOptionalText(
            device,
            DEVICE_INFORMATION_SERVICE,
            HARDWARE_REVISION_CHARACTERISTIC,
            signal,
          )
          const firmwareRevision = await this.readOptionalText(
            device,
            DEVICE_INFORMATION_SERVICE,
            FIRMWARE_REVISION_CHARACTERISTIC,
            signal,
          )
          const statusBytes = await this.read(
            device,
            BOTA_CONTROL_SERVICE,
            DEVICE_STATUS_CHARACTERISTIC,
            signal,
          )
          const status = this.core.decodeDeviceStatus(statusBytes)
          const encryptedUploadV2 = await this.readCapabilities(device, signal)

          return {
            identity: {
              serialNumber,
              modelNumber,
              hardwareRevision,
              firmwareRevision,
            },
            status,
            capabilities: { encryptedUploadV2 },
            capturedAt: new Date(),
          }
        },
      )
    } catch (error) {
      throw snapshotError(error)
    }
  }

  destroy(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise
    this.destroyed = true
    this.destroyPromise = (async () => {
      await this.runtime.destroy()
      const connected = this.runtime.connectedDeviceHandle
      if (connected) {
        this.runtime.markDeviceDisconnected(connected.id)
        this.clearConnection()
        await this.transport.disconnect(connected).catch(() => undefined)
      } else {
        this.clearConnection()
      }
    })()
    return this.destroyPromise
  }

  private validateConnectionRequest(
    expectedSerialNumber: string,
    operation: 'connect' | 'reconnect',
  ): void {
    if (this.destroyed) throw new BotaSDKError('cancelled', operation)
    if (!SERIAL_PATTERN.test(expectedSerialNumber)) {
      throw new BotaSDKError('invalid_input', operation)
    }
  }

  private claimConnectionStart(operation: 'connect' | 'reconnect'): void {
    if (this.operationActive || this.activeDevice) {
      throw new BotaSDKError('operation_in_progress', operation)
    }
    this.operationActive = true
  }

  private publishConnectedDevice(
    result: WorkflowResult,
    expectedSerialNumber: string,
    operation: 'connect' | 'reconnect',
  ): ConnectedDevice {
    if (this.destroyed) throw new BotaSDKError('cancelled', operation)
    const established = [...result.notifications].reverse().find(
      (notification) => notification.kind === 'connection_established',
    )
    if (!established || established.kind !== 'connection_established') {
      throw new BotaSDKError('internal_error', operation)
    }
    if (established.serialNumber !== expectedSerialNumber) {
      throw new BotaSDKError('identity_mismatch', operation)
    }
    const device = this.runtime.registeredDevice(
      established.candidate.peripheralId,
    )
    if (!device || this.runtime.connectedDeviceHandle?.id !== device.id) {
      throw new BotaSDKError('internal_error', operation)
    }

    this.installActiveDevice(device)
    this.verifiedDevice = {
      id: device.id,
      name: device.name,
      serialNumber: established.serialNumber,
    }
    return this.verifiedDevice
  }

  private installActiveDevice(device: BrowserDeviceHandle): void {
    this.removeDisconnectListener?.()
    this.activeDevice = device
    this.removeDisconnectListener = this.transport.onDisconnected(device, () => {
      if (this.activeDevice?.id !== device.id) return
      this.runtime.markDeviceDisconnected(device.id)
      this.clearConnection()
    })
  }

  private async cleanupFailedConnection(): Promise<void> {
    const connected = this.runtime.connectedDeviceHandle
    if (connected) {
      this.runtime.markDeviceDisconnected(connected.id)
      await this.transport.disconnect(connected).catch(() => undefined)
    }
    this.clearConnection()
  }

  private async disconnectForIdentityMismatch(
    device: BrowserDeviceHandle,
  ): Promise<void> {
    this.runtime.markDeviceDisconnected(device.id)
    this.clearConnection()
    await this.transport.disconnect(device).catch(() => undefined)
  }

  private clearConnection(): void {
    const deviceId = this.activeDevice?.id
    this.removeDisconnectListener?.()
    this.removeDisconnectListener = null
    this.activeDevice = null
    this.verifiedDevice = null
    if (deviceId) this.runtime.unregisterDevice(deviceId)
  }

  private async read(
    device: BrowserDeviceHandle,
    serviceUuid: string,
    characteristicUuid: string,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    try {
      return await awaitDirectStep(
        this.transport.read(device, serviceUuid, characteristicUuid),
        signal,
        'read_snapshot',
      )
    } catch (error) {
      if (
        error instanceof BrowserTransportError
        && error.code === 'disconnected'
      ) {
        this.runtime.markDeviceDisconnected(device.id)
        this.clearConnection()
      }
      throw error
    }
  }

  private async readRequiredText(
    device: BrowserDeviceHandle,
    serviceUuid: string,
    characteristicUuid: string,
    signal: AbortSignal,
  ): Promise<string> {
    const value = await this.read(
      device,
      serviceUuid,
      characteristicUuid,
      signal,
    )
    try {
      const decoded = new TextDecoder('utf-8', { fatal: true })
        .decode(value)
        .replace(/^[\0\s]+|[\0\s]+$/g, '')
      if (!decoded) throw new Error('empty')
      return decoded
    } catch (error) {
      throw new BotaSDKError('protocol_error', 'read_snapshot', { cause: error })
    }
  }

  private async readOptionalText(
    device: BrowserDeviceHandle,
    serviceUuid: string,
    characteristicUuid: string,
    signal: AbortSignal,
  ): Promise<string | null> {
    try {
      return await this.readRequiredText(
        device,
        serviceUuid,
        characteristicUuid,
        signal,
      )
    } catch (error) {
      if (
        error instanceof BrowserTransportError
        && error.code === 'characteristic_not_found'
      ) {
        return null
      }
      throw error
    }
  }

  private async readCapabilities(
    device: BrowserDeviceHandle,
    signal: AbortSignal,
  ): Promise<EncryptedUploadV2Capabilities | null> {
    try {
      const bytes = await this.read(
        device,
        BOTA_STORAGE_SERVICE,
        STORAGE_TRANSFER_CAPABILITIES_V2_CHARACTERISTIC,
        signal,
      )
      return this.core.decodeEncryptedUploadV2Capabilities(bytes)
    } catch (error) {
      if (
        error instanceof BrowserTransportError
        && error.code === 'characteristic_not_found'
      ) {
        return null
      }
      throw error
    }
  }
}

function randomCancellationId(): Uint8Array {
  const cancellationId = new Uint8Array(16)
  globalThis.crypto.getRandomValues(cancellationId)
  return cancellationId
}

function operationId(operation: string, cancellationId: Uint8Array): string {
  const suffix = [...cancellationId]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
  return `${operation}:${suffix}`
}

async function awaitDirectStep<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  operation: BotaOperation,
): Promise<T> {
  const settled = promise.then<DirectStepResult<T>, DirectStepResult<T>>(
    (value) => ({ kind: 'completed', value }),
    (error: unknown) => ({ kind: 'failed', error }),
  )
  if (signal.aborted) throw new BotaSDKError('cancelled', operation)

  let resolveCancellation!: () => void
  const cancellation = new Promise<DirectStepResult<T>>((resolve) => {
    resolveCancellation = () => resolve({ kind: 'cancelled' })
  })
  signal.addEventListener('abort', resolveCancellation, { once: true })
  const result = await Promise.race([settled, cancellation])
  signal.removeEventListener('abort', resolveCancellation)
  if (result.kind === 'cancelled') {
    throw new BotaSDKError('cancelled', operation)
  }
  if (result.kind === 'failed') throw result.error
  return result.value
}

function pickerError(error: unknown): BotaSDKError {
  if (error instanceof BrowserTransportError) {
    if (error.code === 'picker_cancelled') {
      return new BotaSDKError('picker_cancelled', 'connect', { cause: error })
    }
    if (error.code === 'permission_denied') {
      return new BotaSDKError('permission_denied', 'connect', { cause: error })
    }
  }
  const name = typeof error === 'object' && error !== null && 'name' in error
    ? String(error.name)
    : ''
  if (name === 'NotFoundError' || name === 'AbortError') {
    return new BotaSDKError('picker_cancelled', 'connect', { cause: error })
  }
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new BotaSDKError('permission_denied', 'connect', { cause: error })
  }
  return new BotaSDKError('bluetooth_unavailable', 'connect', { cause: error })
}

function normalizeManagerError(
  error: unknown,
  operation: BotaOperation,
): BotaSDKError {
  if (error instanceof BotaSDKError) return error
  if (error instanceof BrowserStorageError) {
    return new BotaSDKError(error.code, operation, { cause: error })
  }
  if (error instanceof BrowserTransportError) {
    const code = error.code === 'disconnected'
      ? 'device_disconnected'
      : error.code === 'permission_denied'
        ? 'permission_denied'
        : 'bluetooth_unavailable'
    return new BotaSDKError(code, operation, { cause: error })
  }
  return normalizeCoreError(error, operation)
}

function snapshotError(error: unknown): BotaSDKError {
  if (error instanceof BotaSDKError) return error
  if (error instanceof BrowserTransportError) {
    if (error.code === 'disconnected') {
      return new BotaSDKError('device_disconnected', 'read_snapshot', {
        cause: error,
      })
    }
    if (error.code === 'unavailable') {
      return new BotaSDKError('bluetooth_unavailable', 'read_snapshot', {
        cause: error,
      })
    }
  }
  return normalizeCoreError(error, 'read_snapshot')
}
