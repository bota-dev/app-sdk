import {
  BrowserTransportError,
  type BrowserBluetoothTransport,
  type BrowserDeviceHandle,
} from './transport.ts'

const DEVICE_INFORMATION_SERVICE = '0000180a-0000-1000-8000-00805f9b34fb'
const BOTA_CONTROL_SERVICE = 'b07a0002-0000-1000-8000-00805f9b34fb'
const BOTA_STORAGE_SERVICE = 'b07a0004-0000-1000-8000-00805f9b34fb'

export class WebBluetoothTransport implements BrowserBluetoothTransport {
  private readonly servers = new Map<string, BluetoothRemoteGATTServer>()

  get isSupported(): boolean {
    return typeof navigator !== 'undefined' && 'bluetooth' in navigator
  }

  async requestDevice(): Promise<BrowserDeviceHandle> {
    if (!this.isSupported) throw new BrowserTransportError('unavailable')
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'Bota' }],
      optionalServices: [
        DEVICE_INFORMATION_SERVICE,
        BOTA_CONTROL_SERVICE,
        BOTA_STORAGE_SERVICE,
      ],
    })
    return { id: device.id, name: device.name ?? null, nativeValue: device }
  }

  async connect(device: BrowserDeviceHandle): Promise<void> {
    const native = nativeDevice(device)
    if (!native.gatt) throw new BrowserTransportError('unavailable')
    const server = await native.gatt.connect()
    this.servers.set(device.id, server)
  }

  async discoverServices(device: BrowserDeviceHandle): Promise<void> {
    const server = this.server(device)
    await server.getPrimaryServices()
  }

  async read(
    device: BrowserDeviceHandle,
    serviceUuid: string,
    characteristicUuid: string,
  ): Promise<Uint8Array> {
    try {
      const service = await this.server(device).getPrimaryService(serviceUuid)
      const characteristic = await service.getCharacteristic(characteristicUuid)
      const value = await characteristic.readValue()
      return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
    } catch (error) {
      if (isNotFound(error)) {
        throw new BrowserTransportError('characteristic_not_found', { cause: error })
      }
      throw error
    }
  }

  async disconnect(device: BrowserDeviceHandle): Promise<void> {
    const native = nativeDevice(device)
    this.servers.delete(device.id)
    native.gatt?.disconnect()
  }

  onDisconnected(device: BrowserDeviceHandle, listener: () => void): () => void {
    const native = nativeDevice(device)
    native.addEventListener('gattserverdisconnected', listener)
    return () => native.removeEventListener('gattserverdisconnected', listener)
  }

  private server(device: BrowserDeviceHandle): BluetoothRemoteGATTServer {
    const server = this.servers.get(device.id)
    if (!server?.connected) throw new BrowserTransportError('disconnected')
    return server
  }
}

function nativeDevice(device: BrowserDeviceHandle): BluetoothDevice {
  if (!device.nativeValue) throw new BrowserTransportError('unavailable')
  return device.nativeValue as BluetoothDevice
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'NotFoundError'
}
