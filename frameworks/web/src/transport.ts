export interface BrowserDeviceHandle {
  readonly id: string
  readonly name: string | null
  readonly nativeValue?: unknown
}

export interface BrowserNotification {
  characteristicUuid: string
  value: Uint8Array
}

export interface BrowserSubscription {
  remove(): Promise<void>
}

export interface BrowserBluetoothTransport {
  readonly isSupported: boolean
  readonly supportsAuthorizedDevices: boolean
  readonly maximumWriteValueLength: number
  requestDevice(): Promise<BrowserDeviceHandle>
  getAuthorizedDevices(): Promise<BrowserDeviceHandle[]>
  connect(device: BrowserDeviceHandle): Promise<void>
  discoverServices(device: BrowserDeviceHandle): Promise<void>
  read(
    device: BrowserDeviceHandle,
    serviceUuid: string,
    characteristicUuid: string,
  ): Promise<Uint8Array>
  write(
    device: BrowserDeviceHandle,
    serviceUuid: string,
    characteristicUuid: string,
    value: Uint8Array,
    withResponse: boolean,
  ): Promise<void>
  subscribe(
    device: BrowserDeviceHandle,
    serviceUuid: string,
    characteristicUuid: string,
    listener: (notification: BrowserNotification) => void,
  ): Promise<BrowserSubscription>
  disconnect(device: BrowserDeviceHandle): Promise<void>
  onDisconnected(device: BrowserDeviceHandle, listener: () => void): () => void
}

export type BrowserTransportErrorCode =
  | 'characteristic_not_found'
  | 'disconnected'
  | 'permission_denied'
  | 'picker_cancelled'
  | 'unavailable'

export class BrowserTransportError extends Error {
  readonly code: BrowserTransportErrorCode

  constructor(code: BrowserTransportErrorCode, options: { cause?: unknown } = {}) {
    super(code, { cause: options.cause })
    this.name = 'BrowserTransportError'
    this.code = code
  }
}
