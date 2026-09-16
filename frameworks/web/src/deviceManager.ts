import type { CoreBridge, CoreEffect, CoreHostEvent } from './core.ts'
import { BotaSDKError, normalizeCoreError } from './errors.ts'
import type { ConnectOptions, ConnectedDevice } from './models.ts'
import type { BrowserBluetoothTransport, BrowserDeviceHandle } from './transport.ts'

const SERIAL_PATTERN = /^[A-Za-z0-9]{1,64}$/

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
    try {
      const selected = await this.transport.requestDevice().catch((error: unknown) => {
        throw pickerError(error)
      })
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
      if (!this.verifiedDevice) throw new BotaSDKError('internal_error', 'connect')
      return this.verifiedDevice
    } catch (error) {
      await this.cleanupFailedConnection()
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

  async destroy(): Promise<void> {
    if (this.destroyed) return
    this.destroyed = true
    await this.disconnect()
  }

  private async executeEffects(initial: CoreEffect[]): Promise<void> {
    const queue = [...initial]
    while (queue.length > 0) {
      const effect = queue.shift()
      if (!effect) continue
      const next = await this.executeEffect(effect)
      queue.push(...next)
    }
  }

  private async executeEffect(effect: CoreEffect): Promise<CoreEffect[]> {
    const device = this.activeDevice
    switch (effect.kind) {
      case 'notify':
        if (effect.notification.kind === 'failed') {
          throw normalizeCoreError(effect.notification.error, 'connect')
        }
        if (effect.notification.kind === 'connection_established') {
          this.verifiedDevice = {
            id: effect.notification.peripheralId,
            name: effect.notification.name,
            serialNumber: effect.notification.serialNumber,
          }
        }
        return []
      case 'ble_connect':
        if (!device || device.id !== effect.peripheralId) throw new BotaSDKError('internal_error', 'connect')
        try {
          await this.transport.connect(device)
          this.transportConnected = true
          return this.dispatchCore({
            requestId: effect.requestId,
            kind: 'ble_connected',
            peripheralId: device.id,
          })
        } catch (error) {
          return this.dispatchBleFailure(effect.requestId, error)
        }
      case 'ble_discover_services':
        if (!device || device.id !== effect.peripheralId) throw new BotaSDKError('internal_error', 'connect')
        try {
          await this.transport.discoverServices(device)
          return this.dispatchCore({
            requestId: effect.requestId,
            kind: 'ble_services_discovered',
            peripheralId: device.id,
          })
        } catch (error) {
          return this.dispatchBleFailure(effect.requestId, error)
        }
      case 'ble_read':
        if (!device) throw new BotaSDKError('device_disconnected', 'connect')
        try {
          const value = await this.transport.read(device, effect.serviceUuid, effect.characteristicUuid)
          return this.dispatchCore({
            requestId: effect.requestId,
            kind: 'ble_read_completed',
            value,
          })
        } catch (error) {
          return this.dispatchBleFailure(effect.requestId, error)
        }
      case 'ble_disconnect':
        if (!device || device.id !== effect.peripheralId) throw new BotaSDKError('internal_error', 'connect')
        await this.transport.disconnect(device)
        this.transportConnected = false
        return this.dispatchCore({
          requestId: effect.requestId,
          kind: 'ble_disconnected',
          peripheralId: device.id,
          reasonCode: null,
        })
      case 'timer_schedule': {
        const delay = Number(effect.delayMs)
        const timer = setTimeout(() => {
          this.timers.delete(effect.timerId)
          void this.executeDispatchedEvent({
            requestId: effect.requestId,
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
        if (!device || effect.peripheralId !== device.id) throw new BotaSDKError('internal_error', 'connect')
        return this.dispatchCore({
          requestId: effect.requestId,
          kind: 'connection_identity_saved',
        })
      case 'persistence_delete_checkpoint':
        return []
    }
  }

  private async dispatchBleFailure(requestId: bigint, error: unknown): Promise<CoreEffect[]> {
    return this.dispatchCore({
      requestId,
      kind: 'ble_failed',
      platformCode: platformCode(error),
    })
  }

  private async dispatchCore(event: CoreHostEvent): Promise<CoreEffect[]> {
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
