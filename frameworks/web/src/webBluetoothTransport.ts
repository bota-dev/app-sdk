import {
  canonicalGattUuid,
  FOREGROUND_GATT_SERVICES,
} from './gatt.ts'
import {
  BrowserTransportError,
  type BrowserBluetoothTransport,
  type BrowserDeviceHandle,
  type BrowserNotification,
  type BrowserSubscription,
} from './transport.ts'

const MAXIMUM_WRITE_VALUE_LENGTH = 128

interface ConnectedDeviceCache {
  readonly native: BluetoothDevice
  readonly server: BluetoothRemoteGATTServer
  readonly services: Map<string, BluetoothRemoteGATTService>
  readonly characteristics: Map<string, BluetoothRemoteGATTCharacteristic>
  readonly subscriptions: Set<WebBluetoothSubscription>
  readonly disconnectedListener: EventListener
}

export class WebBluetoothTransport implements BrowserBluetoothTransport {
  readonly maximumWriteValueLength = MAXIMUM_WRITE_VALUE_LENGTH
  private readonly connections = new Map<string, ConnectedDeviceCache>()

  get isSupported(): boolean {
    return typeof browserBluetooth()?.requestDevice === 'function'
  }

  get supportsAuthorizedDevices(): boolean {
    return this.isSupported && typeof browserBluetooth()?.getDevices === 'function'
  }

  async requestDevice(): Promise<BrowserDeviceHandle> {
    const bluetooth = browserBluetooth()
    if (!bluetooth || typeof bluetooth.requestDevice !== 'function') {
      throw new BrowserTransportError('unavailable')
    }

    try {
      return deviceHandle(await bluetooth.requestDevice({
        filters: [{ namePrefix: 'Bota' }],
        optionalServices: [...FOREGROUND_GATT_SERVICES],
      }))
    } catch (error) {
      throw sanitizeDomError(error, 'picker')
    }
  }

  async getAuthorizedDevices(): Promise<BrowserDeviceHandle[]> {
    const bluetooth = browserBluetooth()
    if (!bluetooth || typeof bluetooth.getDevices !== 'function') {
      throw new BrowserTransportError('unavailable')
    }

    try {
      return (await bluetooth.getDevices()).map(deviceHandle)
    } catch (error) {
      throw sanitizeDomError(error, 'availability')
    }
  }

  async connect(device: BrowserDeviceHandle): Promise<void> {
    const native = nativeDevice(device)
    if (!native.gatt) throw new BrowserTransportError('unavailable')

    try {
      const server = await native.gatt.connect()
      if (!server.connected) throw new BrowserTransportError('disconnected')

      this.invalidateConnection(device.id)
      let cache!: ConnectedDeviceCache
      const disconnectedListener: EventListener = () => {
        if (this.connections.get(device.id) === cache) {
          this.invalidateConnection(device.id)
        }
      }
      cache = {
        native,
        server,
        services: new Map(),
        characteristics: new Map(),
        subscriptions: new Set(),
        disconnectedListener,
      }
      this.connections.set(device.id, cache)
      native.addEventListener('gattserverdisconnected', disconnectedListener)
    } catch (error) {
      throw sanitizeDomError(error, 'gatt')
    }
  }

  async discoverServices(device: BrowserDeviceHandle): Promise<void> {
    const cache = this.connection(device)
    try {
      const services = await cache.server.getPrimaryServices()
      this.assertCurrent(device.id, cache)
      for (const service of services) {
        cache.services.set(canonicalGattUuid(service.uuid), service)
      }
    } catch (error) {
      throw sanitizeDomError(error, 'gatt')
    }
  }

  async read(
    device: BrowserDeviceHandle,
    serviceUuid: string,
    characteristicUuid: string,
  ): Promise<Uint8Array> {
    try {
      const characteristic = await this.characteristic(
        device,
        serviceUuid,
        characteristicUuid,
      )
      return cloneDataView(await characteristic.readValue())
    } catch (error) {
      throw sanitizeDomError(error, 'characteristic')
    }
  }

  async write(
    device: BrowserDeviceHandle,
    serviceUuid: string,
    characteristicUuid: string,
    value: Uint8Array,
    withResponse: boolean,
  ): Promise<void> {
    try {
      const characteristic = await this.characteristic(
        device,
        serviceUuid,
        characteristicUuid,
      )
      const ownedValue = Uint8Array.from(value)
      if (withResponse) {
        await characteristic.writeValueWithResponse(ownedValue)
      } else {
        await characteristic.writeValueWithoutResponse(ownedValue)
      }
    } catch (error) {
      throw sanitizeDomError(error, 'characteristic')
    }
  }

  async subscribe(
    device: BrowserDeviceHandle,
    serviceUuid: string,
    characteristicUuid: string,
    listener: (notification: BrowserNotification) => void,
  ): Promise<BrowserSubscription> {
    const cache = this.connection(device)
    let subscription: WebBluetoothSubscription | null = null
    try {
      const characteristic = await this.characteristic(
        device,
        serviceUuid,
        characteristicUuid,
      )
      this.assertCurrent(device.id, cache)
      subscription = new WebBluetoothSubscription(
        characteristic,
        listener,
        () => cache.subscriptions.delete(subscription!),
      )
      cache.subscriptions.add(subscription)
      await subscription.start()
      this.assertCurrent(device.id, cache)
      return subscription
    } catch (error) {
      subscription?.invalidate()
      throw sanitizeDomError(error, 'characteristic')
    }
  }

  async disconnect(device: BrowserDeviceHandle): Promise<void> {
    const native = nativeDevice(device)
    const cache = this.connections.get(device.id)
    const subscriptions = cache ? this.detachConnection(device.id, cache) : []

    await Promise.allSettled(subscriptions.map((subscription) => subscription.stop()))
    native.gatt?.disconnect()
  }

  onDisconnected(device: BrowserDeviceHandle, listener: () => void): () => void {
    const native = nativeDevice(device)
    native.addEventListener('gattserverdisconnected', listener)
    return () => native.removeEventListener('gattserverdisconnected', listener)
  }

  private connection(device: BrowserDeviceHandle): ConnectedDeviceCache {
    const cache = this.connections.get(device.id)
    if (!cache?.server.connected) {
      this.invalidateConnection(device.id)
      throw new BrowserTransportError('disconnected')
    }
    return cache
  }

  private assertCurrent(deviceId: string, cache: ConnectedDeviceCache): void {
    if (this.connections.get(deviceId) !== cache || !cache.server.connected) {
      throw new BrowserTransportError('disconnected')
    }
  }

  private async characteristic(
    device: BrowserDeviceHandle,
    serviceUuid: string,
    characteristicUuid: string,
  ): Promise<BluetoothRemoteGATTCharacteristic> {
    const cache = this.connection(device)
    const serviceKey = canonicalGattUuid(serviceUuid)
    const characteristicKey = `${serviceKey}:${canonicalGattUuid(characteristicUuid)}`
    const cached = cache.characteristics.get(characteristicKey)
    if (cached) return cached

    let service = cache.services.get(serviceKey)
    if (!service) {
      service = await cache.server.getPrimaryService(serviceUuid)
      this.assertCurrent(device.id, cache)
      cache.services.set(serviceKey, service)
    }

    const characteristic = await service.getCharacteristic(characteristicUuid)
    this.assertCurrent(device.id, cache)
    cache.characteristics.set(characteristicKey, characteristic)
    return characteristic
  }

  private invalidateConnection(deviceId: string): void {
    const cache = this.connections.get(deviceId)
    if (cache) this.detachConnection(deviceId, cache)
  }

  private detachConnection(
    deviceId: string,
    cache: ConnectedDeviceCache,
  ): WebBluetoothSubscription[] {
    if (this.connections.get(deviceId) !== cache) return []
    this.connections.delete(deviceId)
    cache.native.removeEventListener(
      'gattserverdisconnected',
      cache.disconnectedListener,
    )
    const subscriptions = [...cache.subscriptions]
    for (const subscription of subscriptions) subscription.invalidate()
    cache.subscriptions.clear()
    cache.characteristics.clear()
    cache.services.clear()
    return subscriptions
  }
}

class WebBluetoothSubscription implements BrowserSubscription {
  private readonly characteristic: BluetoothRemoteGATTCharacteristic
  private readonly onRemove: () => void
  private active = true
  private started = false
  private readonly eventListener: EventListener

  constructor(
    characteristic: BluetoothRemoteGATTCharacteristic,
    listener: (notification: BrowserNotification) => void,
    onRemove: () => void,
  ) {
    this.characteristic = characteristic
    this.onRemove = onRemove
    this.eventListener = () => {
      if (!this.active || !this.characteristic.value) return
      listener({
        characteristicUuid: this.characteristic.uuid,
        value: cloneDataView(this.characteristic.value),
      })
    }
    characteristic.addEventListener(
      'characteristicvaluechanged',
      this.eventListener,
    )
  }

  async start(): Promise<void> {
    await this.characteristic.startNotifications()
    this.started = true
    if (!this.active) await this.stop().catch(() => undefined)
  }

  async remove(): Promise<void> {
    if (!this.invalidate()) return
    try {
      await this.stop()
    } catch (error) {
      throw sanitizeDomError(error, 'gatt')
    }
  }

  invalidate(): boolean {
    if (!this.active) return false
    this.active = false
    this.characteristic.removeEventListener(
      'characteristicvaluechanged',
      this.eventListener,
    )
    this.onRemove()
    return true
  }

  async stop(): Promise<void> {
    if (!this.started) return
    this.started = false
    await this.characteristic.stopNotifications()
  }
}

function browserBluetooth(): Bluetooth | null {
  if (typeof navigator === 'undefined') return null
  return (navigator as Navigator & { bluetooth?: Bluetooth }).bluetooth ?? null
}

function deviceHandle(device: BluetoothDevice): BrowserDeviceHandle {
  return { id: device.id, name: device.name ?? null, nativeValue: device }
}

function nativeDevice(device: BrowserDeviceHandle): BluetoothDevice {
  if (!device.nativeValue) throw new BrowserTransportError('unavailable')
  return device.nativeValue as BluetoothDevice
}

function cloneDataView(value: DataView): Uint8Array {
  const copy = new Uint8Array(value.byteLength)
  copy.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
  return copy
}

type DomErrorContext = 'availability' | 'characteristic' | 'gatt' | 'picker'

function sanitizeDomError(error: unknown, context: DomErrorContext): unknown {
  if (error instanceof BrowserTransportError) return error
  const name = domErrorName(error)

  if (context === 'picker' && (name === 'AbortError' || name === 'NotFoundError')) {
    return new BrowserTransportError('picker_cancelled', { cause: error })
  }
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new BrowserTransportError('permission_denied', { cause: error })
  }
  if (context === 'characteristic' && name === 'NotFoundError') {
    return new BrowserTransportError('characteristic_not_found', { cause: error })
  }
  if (name === 'InvalidStateError' || name === 'NetworkError') {
    return new BrowserTransportError('disconnected', { cause: error })
  }
  if (name === 'NotReadableError' || name === 'NotSupportedError') {
    return new BrowserTransportError('unavailable', { cause: error })
  }
  return error
}

function domErrorName(error: unknown): string {
  return typeof error === 'object' && error !== null && 'name' in error
    ? String(error.name)
    : ''
}
