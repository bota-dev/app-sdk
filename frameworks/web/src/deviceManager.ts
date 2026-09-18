import type { CoreBridge, CoreEffectEnvelope, CoreHostEvent } from './core.ts'
import { BotaSDKError, normalizeCoreError } from './errors.ts'
import type {
  ConnectOptions,
  ConnectedDevice,
  DeviceSnapshot,
  EncryptedUploadV2Capabilities,
} from './models.ts'
import {
  BrowserTransportError,
  type BrowserBluetoothTransport,
  type BrowserDeviceHandle,
} from './transport.ts'

const SERIAL_PATTERN = /^[A-Za-z0-9]{1,64}$/
const DEVICE_INFORMATION_SERVICE = '180A'
const SERIAL_NUMBER = '2A25'
const MODEL_NUMBER = '2A24'
const HARDWARE_REVISION = '2A27'
const FIRMWARE_REVISION = '2A26'
const CONTROL_SERVICE = 'B07A0002-0000-1000-8000-00805F9B34FB'
const DEVICE_STATUS = 'B07A0002-0001-1000-8000-00805F9B34FB'
const STORAGE_SERVICE = 'B07A0004-0000-1000-8000-00805F9B34FB'
const V2_CAPABILITIES = 'B07A0004-0006-1000-8000-00805F9B34FB'

export class DeviceManager {
  private readonly core: CoreBridge
  private readonly transport: BrowserBluetoothTransport
  private activeDevice: BrowserDeviceHandle | null = null
  private verifiedDevice: ConnectedDevice | null = null
  private removeDisconnectListener: (() => void) | null = null
  private operationActive = false
  private destroyed = false
  private transportConnected = false
  private readonly timers = new Map<bigint, ReturnType<typeof setTimeout>>()
  private coreDispatchTail: Promise<void> = Promise.resolve()

  constructor(core: CoreBridge, transport: BrowserBluetoothTransport) {
    this.core = core
    this.transport = transport
  }

  get isSupported(): boolean {
    return this.transport.isSupported
  }

  get connectedDevice(): ConnectedDevice | null {
    return this.verifiedDevice
  }

  async connect(options: ConnectOptions): Promise<ConnectedDevice> {
    if (this.destroyed) throw new BotaSDKError('cancelled', 'connect')
    if (!SERIAL_PATTERN.test(options.expectedSerialNumber)) {
      throw new BotaSDKError('invalid_input', 'connect')
    }
    if (!this.isSupported) throw new BotaSDKError('unsupported_browser', 'connect')
    if (this.operationActive || this.activeDevice) {
      throw new BotaSDKError('operation_in_progress', 'connect')
    }

    this.operationActive = true
    let selected: BrowserDeviceHandle | null = null
    try {
      selected = await this.transport.requestDevice().catch((error: unknown) => {
        throw pickerError(error)
      })
      if (this.destroyed) throw new BotaSDKError('cancelled', 'connect')
      this.activeDevice = selected
      this.removeDisconnectListener = this.transport.onDisconnected(selected, () => {
        this.transportConnected = false
        this.clearConnection()
      })
      const cancellationId = new Uint8Array(16)
      globalThis.crypto.getRandomValues(cancellationId)
      const effects = this.core.startExactConnection({
        expectedSerialNumber: options.expectedSerialNumber,
        peripheralId: selected.id,
        name: selected.name,
        cancellationId,
      })
      await this.executeEffects(effects)
      if (this.destroyed || this.activeDevice !== selected) {
        throw new BotaSDKError('cancelled', 'connect')
      }
      if (!this.verifiedDevice) throw new BotaSDKError('internal_error', 'connect')
      return this.verifiedDevice
    } catch (error) {
      const lifecycleCancelled = this.destroyed
      await this.cleanupFailedConnection()
      if (lifecycleCancelled) {
        throw new BotaSDKError('cancelled', 'connect', { cause: error })
      }
      throw normalizeCoreError(error, 'connect')
    } finally {
      this.operationActive = false
    }
  }

  async disconnect(): Promise<void> {
    const device = this.activeDevice
    this.clearTimers()
    this.clearConnection()
    if (!device || !this.transportConnected) return
    this.transportConnected = false
    try {
      await this.transport.disconnect(device)
    } catch (error) {
      throw normalizeCoreError(error, 'disconnect')
    }
  }

  async readSnapshot(): Promise<DeviceSnapshot> {
    if (this.destroyed) throw new BotaSDKError('cancelled', 'read_snapshot')
    const device = this.activeDevice
    const connected = this.verifiedDevice
    if (!device || !connected || !this.transportConnected) {
      throw new BotaSDKError('device_disconnected', 'read_snapshot')
    }
    if (this.operationActive) {
      throw new BotaSDKError('operation_in_progress', 'read_snapshot')
    }

    this.operationActive = true
    try {
      const serialNumber = await this.readRequiredText(
        device,
        DEVICE_INFORMATION_SERVICE,
        SERIAL_NUMBER,
      )
      if (serialNumber !== connected.serialNumber) {
        await this.disconnect()
        throw new BotaSDKError('identity_mismatch', 'read_snapshot')
      }

      const modelNumber = await this.readOptionalText(
        device,
        DEVICE_INFORMATION_SERVICE,
        MODEL_NUMBER,
      )
      const hardwareRevision = await this.readOptionalText(
        device,
        DEVICE_INFORMATION_SERVICE,
        HARDWARE_REVISION,
      )
      const firmwareRevision = await this.readOptionalText(
        device,
        DEVICE_INFORMATION_SERVICE,
        FIRMWARE_REVISION,
      )
      const statusBytes = await this.read(device, CONTROL_SERVICE, DEVICE_STATUS)
      const status = this.core.decodeDeviceStatus(statusBytes)
      const encryptedUploadV2 = await this.readCapabilities(device)

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
    } catch (error) {
      throw snapshotError(error)
    } finally {
      this.operationActive = false
    }
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return
    this.destroyed = true
    await this.disconnect()
  }

  private async executeEffects(initial: CoreEffectEnvelope[]): Promise<void> {
    const queue = [...initial]
    while (queue.length > 0) {
      const effect = queue.shift()
      if (!effect) continue
      const next = await this.executeEffect(effect)
      queue.push(...next)
    }
  }

  private async read(
    device: BrowserDeviceHandle,
    serviceUuid: string,
    characteristicUuid: string,
  ): Promise<Uint8Array> {
    try {
      return await this.transport.read(device, serviceUuid, characteristicUuid)
    } catch (error) {
      if (error instanceof BrowserTransportError && error.code === 'disconnected') {
        this.transportConnected = false
        this.clearConnection()
      }
      throw error
    }
  }

  private async readRequiredText(
    device: BrowserDeviceHandle,
    serviceUuid: string,
    characteristicUuid: string,
  ): Promise<string> {
    const value = await this.read(device, serviceUuid, characteristicUuid)
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
  ): Promise<string | null> {
    try {
      return await this.readRequiredText(device, serviceUuid, characteristicUuid)
    } catch (error) {
      if (
        error instanceof BrowserTransportError &&
        error.code === 'characteristic_not_found'
      ) {
        return null
      }
      throw error
    }
  }

  private async readCapabilities(
    device: BrowserDeviceHandle,
  ): Promise<EncryptedUploadV2Capabilities | null> {
    try {
      const bytes = await this.read(device, STORAGE_SERVICE, V2_CAPABILITIES)
      return this.core.decodeEncryptedUploadV2Capabilities(bytes)
    } catch (error) {
      if (
        error instanceof BrowserTransportError &&
        error.code === 'characteristic_not_found'
      ) {
        return null
      }
      throw error
    }
  }

  private async executeEffect(envelope: CoreEffectEnvelope): Promise<CoreEffectEnvelope[]> {
    const device = this.activeDevice
    const { effect, requestId } = envelope
    switch (effect.kind) {
      case 'notify':
        if (effect.notification.kind === 'failed') {
          throw normalizeCoreError(effect.notification.error, 'connect')
        }
        if (effect.notification.kind === 'connection_established') {
          this.verifiedDevice = {
            id: effect.notification.candidate.peripheralId,
            name: effect.notification.candidate.name,
            serialNumber: effect.notification.serialNumber,
          }
        }
        return []
      case 'ble_connect':
        if (!device || device.id !== effect.peripheralId) throw new BotaSDKError('internal_error', 'connect')
        try {
          await this.transport.connect(device)
        } catch (error) {
          return this.dispatchBleFailure(requestId, error)
        }
        if (this.destroyed || this.activeDevice !== device) {
          await this.transport.disconnect(device).catch(() => undefined)
          throw new BotaSDKError('cancelled', 'connect')
        }
        this.transportConnected = true
        return this.dispatchCore({
          requestId,
          kind: 'ble_connected',
          peripheralId: device.id,
        })
      case 'ble_discover_services':
        if (!device || device.id !== effect.peripheralId) throw new BotaSDKError('internal_error', 'connect')
        try {
          await this.transport.discoverServices(device)
          return this.dispatchCore({
            requestId,
            kind: 'ble_services_discovered',
            peripheralId: device.id,
          })
        } catch (error) {
          return this.dispatchBleFailure(requestId, error)
        }
      case 'ble_read':
        if (!device) throw new BotaSDKError('device_disconnected', 'connect')
        try {
          const value = await this.transport.read(device, effect.serviceUuid, effect.characteristicUuid)
          return this.dispatchCore({
            requestId,
            kind: 'ble_read_completed',
            value,
          })
        } catch (error) {
          return this.dispatchBleFailure(requestId, error)
        }
      case 'ble_disconnect':
        if (!device || device.id !== effect.peripheralId) throw new BotaSDKError('internal_error', 'connect')
        await this.transport.disconnect(device)
        this.transportConnected = false
        return this.dispatchCore({
          requestId,
          kind: 'ble_disconnected',
          peripheralId: device.id,
          reasonCode: null,
        })
      case 'timer_schedule': {
        const delay = Number(effect.delayMs)
        const timer = setTimeout(() => {
          this.timers.delete(effect.timerId)
          void this.executeDispatchedEvent({
            requestId,
            kind: 'timer_fired',
            timerId: effect.timerId,
          })
        }, delay)
        this.timers.set(effect.timerId, timer)
        return []
      }
      case 'timer_cancel': {
        const timer = this.timers.get(effect.timerId)
        if (timer) clearTimeout(timer)
        this.timers.delete(effect.timerId)
        return []
      }
      case 'persistence_save_checkpoint':
        // The browser facade does not persist resumable workflow checkpoints.
        // Treat this fire-and-forget host effect as completed locally; sending
        // a late acknowledgement after a terminal effect would address a
        // workflow that the shared core has already closed.
        return []
      case 'persistence_save_connection_identity':
        if (!device || effect.candidate.peripheralId !== device.id) throw new BotaSDKError('internal_error', 'connect')
        return this.dispatchCore({
          requestId,
          kind: 'connection_identity_saved',
        })
      case 'persistence_delete_checkpoint':
        return []
    }
    throw new BotaSDKError('internal_error', 'connect')
  }

  private async dispatchBleFailure(requestId: bigint, error: unknown): Promise<CoreEffectEnvelope[]> {
    return this.dispatchCore({
      requestId,
      kind: 'ble_failed',
      platformCode: platformCode(error),
    })
  }

  private async dispatchCore(event: CoreHostEvent): Promise<CoreEffectEnvelope[]> {
    const result = this.coreDispatchTail.then(() => this.core.dispatch(event))
    this.coreDispatchTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async executeDispatchedEvent(event: CoreHostEvent): Promise<void> {
    try {
      await this.executeEffects(await this.dispatchCore(event))
    } catch {
      await this.cleanupFailedConnection()
    }
  }

  private async cleanupFailedConnection(): Promise<void> {
    const device = this.activeDevice
    this.clearTimers()
    this.clearConnection()
    if (!device || !this.transportConnected) return
    this.transportConnected = false
    await this.transport.disconnect(device).catch(() => undefined)
  }

  private clearConnection(): void {
    this.removeDisconnectListener?.()
    this.removeDisconnectListener = null
    this.activeDevice = null
    this.verifiedDevice = null
  }

  private clearTimers(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }
}

function pickerError(error: unknown): BotaSDKError {
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

function platformCode(error: unknown): number | null {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'number') {
    return error.code
  }
  return null
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
