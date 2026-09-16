export interface BrowserDeviceHandle {
  readonly id: string
  readonly name: string | null
  readonly nativeValue?: unknown
}

export interface BrowserBluetoothTransport {
  readonly isSupported: boolean
  requestDevice(): Promise<BrowserDeviceHandle>
  connect(device: BrowserDeviceHandle): Promise<void>
  discoverServices(device: BrowserDeviceHandle): Promise<void>
  read(
    device: BrowserDeviceHandle,
    serviceUuid: string,
    characteristicUuid: string,
  ): Promise<Uint8Array>
  disconnect(device: BrowserDeviceHandle): Promise<void>
  onDisconnected(device: BrowserDeviceHandle, listener: () => void): () => void
}

export type BrowserTransportErrorCode =
  | 'characteristic_not_found'
  | 'disconnected'
  | 'unavailable'

export class BrowserTransportError extends Error {
  readonly code: BrowserTransportErrorCode

  constructor(code: BrowserTransportErrorCode, options: { cause?: unknown } = {}) {
    super(code, { cause: options.cause })
    this.name = 'BrowserTransportError'
    this.code = code
  }
}
