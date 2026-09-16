import type {
  BrowserBluetoothTransport,
  BrowserDeviceHandle,
} from '../transport.ts'

export class FakeBrowserBluetoothTransport implements BrowserBluetoothTransport {
  isSupported = true
  readonly calls: string[] = []
  readonly device: BrowserDeviceHandle = {
    id: 'browser-peripheral-1',
    name: 'Bota Pin',
  }
  pickerError: unknown = null
  connectGate: Promise<void> | null = null
  serialNumber = 'GDPPSBZJN6'
  private disconnectListeners = new Set<() => void>()

  async requestDevice(): Promise<BrowserDeviceHandle> {
    this.calls.push('request_device')
    if (this.pickerError) throw this.pickerError
    return this.device
  }

  async connect(device: BrowserDeviceHandle): Promise<void> {
    this.calls.push(`connect:${device.id}`)
    if (this.connectGate) await this.connectGate
  }

  async discoverServices(device: BrowserDeviceHandle): Promise<void> {
    this.calls.push(`discover:${device.id}`)
  }

  async read(
    device: BrowserDeviceHandle,
    serviceUuid: string,
    characteristicUuid: string,
  ): Promise<Uint8Array> {
    this.calls.push(`read:${device.id}:${serviceUuid}:${characteristicUuid}`)
    if (serviceUuid === '180A' && characteristicUuid === '2A25') {
      return new TextEncoder().encode(this.serialNumber)
    }
    throw new Error(`unexpected read ${serviceUuid}/${characteristicUuid}`)
  }

  async disconnect(device: BrowserDeviceHandle): Promise<void> {
    this.calls.push(`disconnect:${device.id}`)
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
}
