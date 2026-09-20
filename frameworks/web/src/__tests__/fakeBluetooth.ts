import type {
  BrowserBluetoothTransport,
  BrowserDeviceHandle,
  BrowserNotification,
  BrowserSubscription,
} from '../transport.ts'
import {
  canonicalGattUuid,
  DEVICE_INFORMATION_SERVICE,
  SERIAL_NUMBER_CHARACTERISTIC,
} from '../gatt.ts'

function readKey(serviceUuid: string, characteristicUuid: string): string {
  return `${canonicalGattUuid(serviceUuid)}:${canonicalGattUuid(characteristicUuid)}`
}

export class FakeBrowserBluetoothTransport implements BrowserBluetoothTransport {
  isSupported = true
  supportsAuthorizedDevices = true
  readonly maximumWriteValueLength = 128
  readonly calls: string[] = []
  readonly device: BrowserDeviceHandle = {
    id: 'browser-peripheral-1',
    name: 'Bota Pin',
  }
  authorizedDevices: BrowserDeviceHandle[] = [this.device]
  pickerError: unknown = null
  authorizedDevicesError: unknown = null
  pickerGate: Promise<void> | null = null
  authorizedDevicesGate: Promise<void> | null = null
  connectGate: Promise<void> | null = null
  discoverGate: Promise<void> | null = null
  subscribeGate: Promise<void> | null = null
  unsubscribeGate: Promise<void> | null = null
  writeGate: Promise<void> | null = null
  onConnect: (() => void) | null = null
  onDisconnect: (() => void) | null = null
  onSubscribe: (() => void) | null = null
  onUnsubscribe: (() => void) | null = null
  onWrite: (() => void) | null = null
  emitDisconnectedOnDisconnect = false
  serialNumber = 'GDPPSBZJN6'
  readonly serialNumbers = new Map<string, string>()
  readonly readValues = new Map<string, Uint8Array>()
  readonly readErrors = new Map<string, unknown>()
  private disconnectListeners = new Set<() => void>()
  private notificationListeners = new Map<
    string,
    Set<(notification: BrowserNotification) => void>
  >()
  private notificationListenerHistory = new Map<
    string,
    Array<(notification: BrowserNotification) => void>
  >()

  async requestDevice(): Promise<BrowserDeviceHandle> {
    this.calls.push('request_device')
    if (this.pickerGate) await this.pickerGate
    if (this.pickerError) throw this.pickerError
    return this.device
  }

  async getAuthorizedDevices(): Promise<BrowserDeviceHandle[]> {
    this.calls.push('get_authorized_devices')
    if (this.authorizedDevicesGate) await this.authorizedDevicesGate
    if (this.authorizedDevicesError) throw this.authorizedDevicesError
    return [...this.authorizedDevices]
  }

  async connect(device: BrowserDeviceHandle): Promise<void> {
    this.calls.push(`connect:${device.id}`)
    this.onConnect?.()
    if (this.connectGate) await this.connectGate
  }

  async discoverServices(device: BrowserDeviceHandle): Promise<void> {
    this.calls.push(`discover:${device.id}`)
    if (this.discoverGate) await this.discoverGate
  }

  async read(
    device: BrowserDeviceHandle,
    serviceUuid: string,
    characteristicUuid: string,
  ): Promise<Uint8Array> {
    this.calls.push(`read:${device.id}:${serviceUuid}:${characteristicUuid}`)
    const key = readKey(serviceUuid, characteristicUuid)
    const error = this.readErrors.get(key)
    if (error) throw error
    const value = this.readValues.get(key)
    if (value) return value.slice()
    if (
      canonicalGattUuid(serviceUuid) === DEVICE_INFORMATION_SERVICE &&
      canonicalGattUuid(characteristicUuid) === SERIAL_NUMBER_CHARACTERISTIC
    ) {
      return new TextEncoder().encode(
        this.serialNumbers.get(device.id) ?? this.serialNumber,
      )
    }
    throw new Error(`unexpected read ${serviceUuid}/${characteristicUuid}`)
  }

  async write(
    device: BrowserDeviceHandle,
    serviceUuid: string,
    characteristicUuid: string,
    _value: Uint8Array,
    withResponse: boolean,
  ): Promise<void> {
    this.calls.push(
      `write:${device.id}:${serviceUuid}:${characteristicUuid}:${withResponse}`,
    )
    this.onWrite?.()
    if (this.writeGate) await this.writeGate
  }

  async subscribe(
    device: BrowserDeviceHandle,
    serviceUuid: string,
    characteristicUuid: string,
    listener: (notification: BrowserNotification) => void,
  ): Promise<BrowserSubscription> {
    this.calls.push(`subscribe:${device.id}:${serviceUuid}:${characteristicUuid}`)
    const key = `${device.id}:${readKey(serviceUuid, characteristicUuid)}`
    const listeners = this.notificationListeners.get(key) ?? new Set()
    listeners.add(listener)
    this.notificationListeners.set(key, listeners)
    const history = this.notificationListenerHistory.get(key) ?? []
    history.push(listener)
    this.notificationListenerHistory.set(key, history)
    this.onSubscribe?.()
    if (this.subscribeGate) await this.subscribeGate
    let removed = false
    return {
      remove: async () => {
        if (removed) return
        removed = true
        this.onUnsubscribe?.()
        if (this.unsubscribeGate) await this.unsubscribeGate
        listeners.delete(listener)
        if (listeners.size === 0) this.notificationListeners.delete(key)
        this.calls.push(
          `unsubscribe:${device.id}:${serviceUuid}:${characteristicUuid}`,
        )
      },
    }
  }

  async disconnect(device: BrowserDeviceHandle): Promise<void> {
    this.calls.push(`disconnect:${device.id}`)
    this.onDisconnect?.()
    if (this.emitDisconnectedOnDisconnect) this.emitDisconnected()
  }

  onDisconnected(
    _device: BrowserDeviceHandle,
    listener: () => void,
  ): () => void {
    this.disconnectListeners.add(listener)
    return () => this.disconnectListeners.delete(listener)
  }

  emitDisconnected(): void {
    for (const listener of [...this.disconnectListeners]) listener()
  }

  setRead(
    serviceUuid: string,
    characteristicUuid: string,
    value: Uint8Array,
  ): void {
    this.readValues.set(readKey(serviceUuid, characteristicUuid), value)
  }

  failRead(
    serviceUuid: string,
    characteristicUuid: string,
    error: unknown,
  ): void {
    this.readErrors.set(readKey(serviceUuid, characteristicUuid), error)
  }

  emitNotification(
    device: BrowserDeviceHandle,
    serviceUuid: string,
    characteristicUuid: string,
    value: Uint8Array,
  ): void {
    const key = `${device.id}:${readKey(serviceUuid, characteristicUuid)}`
    for (const listener of this.notificationListeners.get(key) ?? []) {
      listener({ characteristicUuid, value: value.slice() })
    }
  }

  emitLateNotification(
    device: BrowserDeviceHandle,
    serviceUuid: string,
    characteristicUuid: string,
    value: Uint8Array,
  ): void {
    const key = `${device.id}:${readKey(serviceUuid, characteristicUuid)}`
    for (const listener of this.notificationListenerHistory.get(key) ?? []) {
      listener({ characteristicUuid, value: value.slice() })
    }
  }
}
