import assert from 'node:assert/strict'
import test from 'node:test'

import {
  detectBrowserCapabilities,
  detectBrowserStorageSupport,
} from '../capabilities.ts'
import {
  BOTA_CONTROL_SERVICE,
  DEVICE_INFORMATION_SERVICE,
  DEVICE_STATUS_CHARACTERISTIC,
  FOREGROUND_GATT_SERVICES,
} from '../gatt.ts'
import {
  BrowserTransportError,
  type BrowserBluetoothTransport,
} from '../transport.ts'
import { WebBluetoothTransport } from '../webBluetoothTransport.ts'

test('missing Web Bluetooth disables only Bluetooth-dependent capabilities', () => {
  const restore = installNavigator({ storage: { getDirectory: async () => ({}) } })
  try {
    const capabilities = detectBrowserCapabilities(
      new WebBluetoothTransport(),
      { indexedDB: true, opfs: true },
    )

    assert.deepEqual(capabilities, {
      bluetooth: false,
      authorizedDeviceReconnect: false,
      durableStorage: true,
      largeRecordingSync: false,
      firmwareUpdate: false,
    })
    assert.equal(Object.isFrozen(capabilities), true)
  } finally {
    restore()
  }
})

test('picker support does not imply authorized-device reconnect support', () => {
  const restore = installNavigator({
    bluetooth: { requestDevice: async () => new FakeDevice('picker') },
  })
  try {
    const transport = new WebBluetoothTransport()
    assert.deepEqual(
      detectBrowserCapabilities(transport, { indexedDB: true, opfs: true }),
      {
        bluetooth: true,
        authorizedDeviceReconnect: false,
        durableStorage: true,
        largeRecordingSync: true,
        firmwareUpdate: true,
      },
    )
  } finally {
    restore()
  }
})

test('IndexedDB and OPFS are each required for durable workflows', () => {
  const transport = capabilityTransport()

  for (const storage of [
    { indexedDB: false, opfs: true },
    { indexedDB: true, opfs: false },
  ]) {
    assert.deepEqual(detectBrowserCapabilities(transport, storage), {
      bluetooth: true,
      authorizedDeviceReconnect: true,
      durableStorage: false,
      largeRecordingSync: false,
      firmwareUpdate: false,
    })
  }
})

test('browser storage detection requires both IndexedDB and OPFS', () => {
  const indexedDBDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')
  const restoreNavigator = installNavigator({ storage: {} })
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: {},
  })

  try {
    assert.deepEqual(detectBrowserStorageSupport(), {
      indexedDB: true,
      opfs: false,
    })
  } finally {
    restoreProperty(globalThis, 'indexedDB', indexedDBDescriptor)
    restoreNavigator()
  }
})

test('picker requests every service used by foreground managers', async () => {
  const fixture = createBluetoothFixture()
  const restore = installNavigator({ bluetooth: fixture.bluetooth })

  try {
    await new WebBluetoothTransport().requestDevice()

    assert.equal(fixture.requestDeviceCalls, 1)
    assert.deepEqual(fixture.requestedOptions, {
      filters: [{ namePrefix: 'Bota' }],
      optionalServices: [...FOREGROUND_GATT_SERVICES],
    })
    assert.equal(FOREGROUND_GATT_SERVICES.includes(DEVICE_INFORMATION_SERVICE), true)
    assert.equal(FOREGROUND_GATT_SERVICES.length, 7)
  } finally {
    restore()
  }
})

test('authorized-device enumeration never opens the picker', async () => {
  const fixture = createBluetoothFixture()
  const secondDevice = new FakeDevice('authorized-2')
  fixture.authorizedDevices = [fixture.device, secondDevice]
  const restore = installNavigator({ bluetooth: fixture.bluetooth })

  try {
    const transport = new WebBluetoothTransport()
    const devices = await transport.getAuthorizedDevices()

    assert.equal(fixture.requestDeviceCalls, 0)
    assert.equal(fixture.getDevicesCalls, 1)
    assert.deepEqual(
      devices.map(({ id, name }) => ({ id, name })),
      [
        { id: 'browser-peripheral-1', name: 'Bota Pin' },
        { id: 'authorized-2', name: 'Bota Pin' },
      ],
    )
  } finally {
    restore()
  }
})

test('read and both write modes use the connected characteristic', async () => {
  const fixture = createBluetoothFixture()
  const restore = installNavigator({ bluetooth: fixture.bluetooth })
  const transport = new WebBluetoothTransport()
  const handle = await transport.requestDevice()

  try {
    assert.equal(transport.maximumWriteValueLength, 128)
    await transport.connect(handle)
    await transport.discoverServices(handle)

    fixture.characteristic.readBytes = Uint8Array.of(0xaa, 0xbb, 0xcc)
    const value = await transport.read(
      handle,
      BOTA_CONTROL_SERVICE,
      DEVICE_STATUS_CHARACTERISTIC,
    )
    fixture.characteristic.readBytes[0] = 0

    await transport.write(
      handle,
      BOTA_CONTROL_SERVICE,
      DEVICE_STATUS_CHARACTERISTIC,
      Uint8Array.of(1, 2),
      true,
    )
    await transport.write(
      handle,
      BOTA_CONTROL_SERVICE,
      DEVICE_STATUS_CHARACTERISTIC,
      Uint8Array.of(3, 4),
      false,
    )

    assert.deepEqual(value, Uint8Array.of(0xaa, 0xbb, 0xcc))
    assert.notEqual(value.buffer, fixture.characteristic.lastReadView?.buffer)
    assert.deepEqual(fixture.characteristic.writesWithResponse, [Uint8Array.of(1, 2)])
    assert.deepEqual(fixture.characteristic.writesWithoutResponse, [Uint8Array.of(3, 4)])
  } finally {
    await transport.disconnect(handle)
    restore()
  }
})

test('notifications are copied and removal is exact and idempotent', async () => {
  const fixture = createBluetoothFixture()
  const restore = installNavigator({ bluetooth: fixture.bluetooth })
  const transport = new WebBluetoothTransport()
  const handle = await transport.requestDevice()
  const notifications: Array<{ characteristicUuid: string; value: Uint8Array }> = []

  try {
    await transport.connect(handle)
    const subscription = await transport.subscribe(
      handle,
      BOTA_CONTROL_SERVICE,
      DEVICE_STATUS_CHARACTERISTIC,
      (notification) => notifications.push(notification),
    )

    const source = Uint8Array.of(5, 6, 7)
    fixture.characteristic.emitValue(source)
    const emittedView = fixture.characteristic.value
    assert.ok(emittedView)
    new Uint8Array(emittedView.buffer, emittedView.byteOffset, emittedView.byteLength)[0] = 0

    await subscription.remove()
    await subscription.remove()
    fixture.characteristic.emitValue(Uint8Array.of(8))

    assert.deepEqual(notifications, [
      {
        characteristicUuid: DEVICE_STATUS_CHARACTERISTIC,
        value: Uint8Array.of(5, 6, 7),
      },
    ])
    assert.notEqual(notifications[0]?.value.buffer, emittedView.buffer)
    assert.equal(fixture.characteristic.startNotificationsCalls, 1)
    assert.equal(fixture.characteristic.stopNotificationsCalls, 1)
    assert.equal(fixture.characteristic.listenerCount, 0)
  } finally {
    await transport.disconnect(handle)
    restore()
  }
})

test('disconnect invalidates cached characteristics and rejects late callbacks', async () => {
  const fixture = createBluetoothFixture()
  const restore = installNavigator({ bluetooth: fixture.bluetooth })
  const transport = new WebBluetoothTransport()
  const handle = await transport.requestDevice()
  const received: Uint8Array[] = []

  try {
    await transport.connect(handle)
    const subscription = await transport.subscribe(
      handle,
      BOTA_CONTROL_SERVICE,
      DEVICE_STATUS_CHARACTERISTIC,
      ({ value }) => received.push(value),
    )
    const staleCharacteristic = fixture.characteristic

    await transport.disconnect(handle)
    staleCharacteristic.emitValue(Uint8Array.of(1))
    await subscription.remove()

    const replacement = new FakeCharacteristic(DEVICE_STATUS_CHARACTERISTIC)
    replacement.readBytes = Uint8Array.of(9)
    fixture.device.replaceServer(
      new FakeServer(
        new FakeService(BOTA_CONTROL_SERVICE, replacement),
      ),
    )
    await transport.connect(handle)
    const value = await transport.read(
      handle,
      BOTA_CONTROL_SERVICE,
      DEVICE_STATUS_CHARACTERISTIC,
    )

    assert.deepEqual(received, [])
    assert.equal(staleCharacteristic.listenerCount, 0)
    assert.equal(staleCharacteristic.stopNotificationsCalls, 1)
    assert.deepEqual(value, Uint8Array.of(9))
    assert.equal(replacement.readCalls, 1)
  } finally {
    await transport.disconnect(handle)
    restore()
  }
})

test('disconnect stops notifications that finish starting after teardown', async () => {
  const fixture = createBluetoothFixture()
  const restore = installNavigator({ bluetooth: fixture.bluetooth })
  const transport = new WebBluetoothTransport()
  const handle = await transport.requestDevice()
  let releaseStart!: () => void
  fixture.characteristic.startGate = new Promise<void>((resolve) => {
    releaseStart = resolve
  })

  try {
    await transport.connect(handle)
    const subscribing = transport.subscribe(
      handle,
      BOTA_CONTROL_SERVICE,
      DEVICE_STATUS_CHARACTERISTIC,
      () => undefined,
    )
    await fixture.characteristic.startEntered

    const rejection = assert.rejects(
      subscribing,
      (error: unknown) => {
        assert.ok(error instanceof BrowserTransportError)
        assert.equal(error.code, 'disconnected')
        return true
      },
    )
    const disconnecting = transport.disconnect(handle)
    releaseStart()

    await disconnecting
    await rejection
    assert.equal(fixture.characteristic.listenerCount, 0)
    assert.equal(fixture.characteristic.stopNotificationsCalls, 1)
  } finally {
    releaseStart()
    await transport.disconnect(handle)
    restore()
  }
})

test('known picker DOM failures are sanitized with the original private cause', async () => {
  const privateError = new DOMException('private browser detail', 'NotAllowedError')
  const restore = installNavigator({
    bluetooth: {
      requestDevice: async () => {
        throw privateError
      },
    },
  })

  try {
    await assert.rejects(
      new WebBluetoothTransport().requestDevice(),
      (error: unknown) => {
        assert.ok(error instanceof BrowserTransportError)
        assert.equal(error.code, 'permission_denied')
        assert.equal(error.message, 'permission_denied')
        assert.equal(error.cause, privateError)
        assert.doesNotMatch(error.message, /private browser detail/)
        return true
      },
    )
  } finally {
    restore()
  }
})

function capabilityTransport(): BrowserBluetoothTransport {
  return {
    isSupported: true,
    supportsAuthorizedDevices: true,
    maximumWriteValueLength: 128,
  } as BrowserBluetoothTransport
}

function createBluetoothFixture(): BluetoothFixture {
  const characteristic = new FakeCharacteristic(DEVICE_STATUS_CHARACTERISTIC)
  const service = new FakeService(BOTA_CONTROL_SERVICE, characteristic)
  const device = new FakeDevice('browser-peripheral-1', new FakeServer(service))
  let requestedOptions: RequestDeviceOptions | undefined
  let requestDeviceCalls = 0
  let getDevicesCalls = 0

  const fixture: BluetoothFixture = {
    device,
    characteristic,
    authorizedDevices: [device],
    get requestDeviceCalls() {
      return requestDeviceCalls
    },
    get getDevicesCalls() {
      return getDevicesCalls
    },
    get requestedOptions() {
      return requestedOptions
    },
    bluetooth: {
      requestDevice: async (options?: RequestDeviceOptions) => {
        requestDeviceCalls += 1
        requestedOptions = options
        return device as unknown as BluetoothDevice
      },
      getDevices: async () => {
        getDevicesCalls += 1
        return fixture.authorizedDevices as unknown as BluetoothDevice[]
      },
    },
  }
  return fixture
}

interface BluetoothFixture {
  readonly bluetooth: Partial<Bluetooth>
  readonly device: FakeDevice
  readonly characteristic: FakeCharacteristic
  authorizedDevices: FakeDevice[]
  readonly requestDeviceCalls: number
  readonly getDevicesCalls: number
  readonly requestedOptions: RequestDeviceOptions | undefined
}

class FakeDevice extends EventTarget {
  readonly id: string
  readonly name = 'Bota Pin'
  readonly gatt: BluetoothRemoteGATTServer
  private server: FakeServer

  constructor(
    id: string,
    server = new FakeServer(
      new FakeService(
        BOTA_CONTROL_SERVICE,
        new FakeCharacteristic(DEVICE_STATUS_CHARACTERISTIC),
      ),
    ),
  ) {
    super()
    this.id = id
    this.server = server
    const device = this
    this.gatt = {
      get connected() {
        return device.server.connected
      },
      device: this as unknown as BluetoothDevice,
      connect: async () => {
        device.server.connected = true
        return this.gatt
      },
      disconnect: () => {
        device.server.connected = false
      },
      getPrimaryService: async (uuid: BluetoothServiceUUID) =>
        device.server.getPrimaryService(uuid),
      getPrimaryServices: async (uuid?: BluetoothServiceUUID) =>
        device.server.getPrimaryServices(uuid),
    }
  }

  replaceServer(server: FakeServer): void {
    this.server = server
  }
}

class FakeServer {
  connected = false
  private readonly service: FakeService

  constructor(service: FakeService) {
    this.service = service
  }

  async getPrimaryService(uuid: BluetoothServiceUUID): Promise<BluetoothRemoteGATTService> {
    if (String(uuid).toLowerCase() !== this.service.uuid.toLowerCase()) {
      throw new DOMException('missing service', 'NotFoundError')
    }
    return this.service as unknown as BluetoothRemoteGATTService
  }

  async getPrimaryServices(
    uuid?: BluetoothServiceUUID,
  ): Promise<BluetoothRemoteGATTService[]> {
    if (uuid && String(uuid).toLowerCase() !== this.service.uuid.toLowerCase()) {
      return []
    }
    return [this.service as unknown as BluetoothRemoteGATTService]
  }
}

class FakeService {
  readonly uuid: string
  private readonly characteristic: FakeCharacteristic

  constructor(
    uuid: string,
    characteristic: FakeCharacteristic,
  ) {
    this.uuid = uuid
    this.characteristic = characteristic
  }

  async getCharacteristic(
    uuid: BluetoothCharacteristicUUID,
  ): Promise<BluetoothRemoteGATTCharacteristic> {
    if (String(uuid).toLowerCase() !== this.characteristic.uuid.toLowerCase()) {
      throw new DOMException('missing characteristic', 'NotFoundError')
    }
    return this.characteristic as unknown as BluetoothRemoteGATTCharacteristic
  }
}

class FakeCharacteristic extends EventTarget {
  readonly uuid: string
  readBytes = Uint8Array.of(0)
  lastReadView: DataView | null = null
  readCalls = 0
  startNotificationsCalls = 0
  stopNotificationsCalls = 0
  startGate: Promise<void> | null = null
  readonly startEntered: Promise<void>
  readonly writesWithResponse: Uint8Array[] = []
  readonly writesWithoutResponse: Uint8Array[] = []
  private listeners = new Set<EventListenerOrEventListenerObject>()
  private readonly markStartEntered: () => void
  value?: DataView

  constructor(uuid: string) {
    super()
    this.uuid = uuid
    let markStartEntered!: () => void
    this.startEntered = new Promise<void>((resolve) => {
      markStartEntered = resolve
    })
    this.markStartEntered = markStartEntered
  }

  get listenerCount(): number {
    return this.listeners.size
  }

  async readValue(): Promise<DataView> {
    this.readCalls += 1
    const padded = new Uint8Array(this.readBytes.length + 2)
    padded.set(this.readBytes, 1)
    this.lastReadView = new DataView(padded.buffer, 1, this.readBytes.length)
    return this.lastReadView
  }

  async writeValueWithResponse(value: BufferSource): Promise<void> {
    this.writesWithResponse.push(copyBufferSource(value))
  }

  async writeValueWithoutResponse(value: BufferSource): Promise<void> {
    this.writesWithoutResponse.push(copyBufferSource(value))
  }

  async startNotifications(): Promise<BluetoothRemoteGATTCharacteristic> {
    this.startNotificationsCalls += 1
    this.markStartEntered()
    if (this.startGate) await this.startGate
    return this as unknown as BluetoothRemoteGATTCharacteristic
  }

  async stopNotifications(): Promise<BluetoothRemoteGATTCharacteristic> {
    this.stopNotificationsCalls += 1
    return this as unknown as BluetoothRemoteGATTCharacteristic
  }

  override addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (type === 'characteristicvaluechanged' && callback) this.listeners.add(callback)
    super.addEventListener(type, callback, options)
  }

  override removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void {
    if (type === 'characteristicvaluechanged' && callback) this.listeners.delete(callback)
    super.removeEventListener(type, callback, options)
  }

  emitValue(value: Uint8Array): void {
    const copy = Uint8Array.from(value)
    this.value = new DataView(copy.buffer)
    this.dispatchEvent(new Event('characteristicvaluechanged'))
  }
}

function copyBufferSource(source: BufferSource): Uint8Array {
  if (source instanceof ArrayBuffer) return new Uint8Array(source.slice(0))
  return Uint8Array.from(
    new Uint8Array(source.buffer, source.byteOffset, source.byteLength),
  )
}

function installNavigator(value: object): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value,
  })
  return () => restoreProperty(globalThis, 'navigator', descriptor)
}

function restoreProperty(
  target: object,
  property: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(target, property, descriptor)
  } else {
    Reflect.deleteProperty(target, property)
  }
}
