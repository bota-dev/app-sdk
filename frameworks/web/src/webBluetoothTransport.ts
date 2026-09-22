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
  readonly notificationSessions: Map<
    BluetoothRemoteGATTCharacteristic,
    WebBluetoothNotificationSession
  >
  readonly disconnectedListener: EventListener
}

export class WebBluetoothTransport implements BrowserBluetoothTransport {
  readonly maximumWriteValueLength = MAXIMUM_WRITE_VALUE_LENGTH
  private readonly connections = new Map<string, ConnectedDeviceCache>()
  private readonly connectionTeardowns = new Map<string, Promise<void>>()

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
      const existing = this.connections.get(device.id)
      if (existing) {
        await this.detachConnection(device.id, existing)
      } else {
        await this.connectionTeardowns.get(device.id)
      }
      const server = await native.gatt.connect()
      if (!server.connected) throw new BrowserTransportError('disconnected')

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
        notificationSessions: new Map(),
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
    let ownedValue: Uint8Array<ArrayBuffer> | null = null
    try {
      const characteristic = await this.characteristic(
        device,
        serviceUuid,
        characteristicUuid,
      )
      ownedValue = new Uint8Array(value.length)
      ownedValue.set(value)
      if (withResponse) {
        await characteristic.writeValueWithResponse(ownedValue)
      } else {
        await characteristic.writeValueWithoutResponse(ownedValue)
      }
    } catch (error) {
      throw sanitizeDomError(error, 'characteristic')
    } finally {
      ownedValue?.fill(0)
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
      let session = cache.notificationSessions.get(characteristic)
      if (session?.isStopping) {
        await session.teardown()
        this.assertCurrent(device.id, cache)
        session = cache.notificationSessions.get(characteristic)
      }
      if (!session) {
        let created!: WebBluetoothNotificationSession
        created = new WebBluetoothNotificationSession(characteristic, () => {
          if (cache.notificationSessions.get(characteristic) === created) {
            cache.notificationSessions.delete(characteristic)
          }
        })
        cache.notificationSessions.set(characteristic, created)
        session = created
      }
      subscription = session.add(listener)
      await session.start()
      this.assertCurrent(device.id, cache)
      return subscription
    } catch (error) {
      await subscription?.remove().catch(() => undefined)
      throw sanitizeDomError(error, 'characteristic')
    }
  }

  async disconnect(device: BrowserDeviceHandle): Promise<void> {
    const native = nativeDevice(device)
    const cache = this.connections.get(device.id)
    const teardown = cache
      ? this.detachConnection(device.id, cache)
      : this.connectionTeardowns.get(device.id)
    let teardownError: unknown = null
    try {
      await teardown
    } catch (error) {
      teardownError = error
    }

    try {
      native.gatt?.disconnect()
    } catch (error) {
      if (!teardownError) teardownError = sanitizeDomError(error, 'gatt')
    }
    if (teardownError) throw teardownError
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
    if (!cache) return
    void this.detachConnection(deviceId, cache).catch(() => undefined)
  }

  private detachConnection(
    deviceId: string,
    cache: ConnectedDeviceCache,
  ): Promise<void> {
    if (this.connections.get(deviceId) !== cache) {
      return this.connectionTeardowns.get(deviceId) ?? Promise.resolve()
    }
    this.connections.delete(deviceId)
    cache.native.removeEventListener(
      'gattserverdisconnected',
      cache.disconnectedListener,
    )
    const teardowns = [...cache.notificationSessions.values()].map((session) =>
      session.teardown()
    )
    const teardown = Promise.allSettled(teardowns).then((outcomes) => {
      const failure = outcomes.find((outcome) => outcome.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
    })
    this.connectionTeardowns.set(deviceId, teardown)
    void teardown.then(
      () => this.clearConnectionTeardown(deviceId, teardown),
      () => this.clearConnectionTeardown(deviceId, teardown),
    )
    cache.notificationSessions.clear()
    cache.characteristics.clear()
    cache.services.clear()
    return teardown
  }

  private clearConnectionTeardown(
    deviceId: string,
    teardown: Promise<void>,
  ): void {
    if (this.connectionTeardowns.get(deviceId) === teardown) {
      this.connectionTeardowns.delete(deviceId)
    }
  }
}

class WebBluetoothNotificationSession {
  private readonly characteristic: BluetoothRemoteGATTCharacteristic
  private readonly onStopped: () => void
  private readonly listeners = new Map<
    WebBluetoothSubscription,
    (notification: BrowserNotification) => void
  >()
  private readonly eventListener: EventListener
  private startPromise: Promise<void> | null = null
  private stopPromise: Promise<void> | null = null

  constructor(
    characteristic: BluetoothRemoteGATTCharacteristic,
    onStopped: () => void,
  ) {
    this.characteristic = characteristic
    this.onStopped = onStopped
    this.eventListener = () => {
      if (!this.characteristic.value) return
      for (const listener of [...this.listeners.values()]) {
        try {
          listener({
            characteristicUuid: this.characteristic.uuid,
            value: cloneDataView(this.characteristic.value),
          })
        } catch {
          // A consumer callback cannot block or escape the shared DOM listener.
        }
      }
    }
    characteristic.addEventListener(
      'characteristicvaluechanged',
      this.eventListener,
    )
  }

  get isStopping(): boolean {
    return this.stopPromise !== null
  }

  add(
    listener: (notification: BrowserNotification) => void,
  ): WebBluetoothSubscription {
    if (this.stopPromise) throw new BrowserTransportError('unavailable')
    const subscription = new WebBluetoothSubscription(this)
    this.listeners.set(subscription, listener)
    return subscription
  }

  start(): Promise<void> {
    this.startPromise ??= this.characteristic.startNotifications()
      .then(() => undefined)
      .catch((error: unknown) => {
        throw sanitizeDomError(error, 'characteristic')
      })
    return this.startPromise
  }

  remove(subscription: WebBluetoothSubscription): Promise<void> {
    this.listeners.delete(subscription)
    if (this.listeners.size > 0) return Promise.resolve()
    return this.teardown()
  }

  teardown(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.characteristic.removeEventListener(
      'characteristicvaluechanged',
      this.eventListener,
    )
    const stopping = this.startPromise
      ? this.startPromise.then(() => this.characteristic.stopNotifications())
      : Promise.resolve()
    this.stopPromise = stopping
      .then(() => undefined)
      .catch((error: unknown) => {
        throw sanitizeDomError(error, 'gatt')
      })
      .finally(this.onStopped)
    for (const subscription of this.listeners.keys()) {
      subscription.useTeardown(this.stopPromise)
    }
    this.listeners.clear()
    return this.stopPromise
  }
}

class WebBluetoothSubscription implements BrowserSubscription {
  private readonly session: WebBluetoothNotificationSession
  private removePromise: Promise<void> | null = null

  constructor(session: WebBluetoothNotificationSession) {
    this.session = session
  }

  remove(): Promise<void> {
    this.removePromise ??= this.session.remove(this)
    return this.removePromise
  }

  useTeardown(teardown: Promise<void>): void {
    this.removePromise ??= teardown
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
  return new BrowserTransportError('unavailable', { cause: error })
}

function domErrorName(error: unknown): string {
  return typeof error === 'object' && error !== null && 'name' in error
    ? String(error.name)
    : ''
}
