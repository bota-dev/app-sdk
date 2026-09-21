import type { BrowserCapabilities } from './models.ts'
import type { BrowserBluetoothTransport } from './transport.ts'

export interface BrowserStorageSupport {
  indexedDB: boolean
  opfs: boolean
}

export function detectBrowserStorageSupport(): BrowserStorageSupport {
  const storage = typeof navigator === 'undefined' ? undefined : navigator.storage
  return {
    indexedDB:
      typeof globalThis.indexedDB !== 'undefined' && globalThis.indexedDB !== null,
    opfs: typeof storage?.getDirectory === 'function',
  }
}

export function detectBrowserCapabilities(
  transport: BrowserBluetoothTransport,
  storage: BrowserStorageSupport = detectBrowserStorageSupport(),
): BrowserCapabilities {
  const bluetooth = transport.isSupported
  const durableStorage = storage.indexedDB && storage.opfs

  return Object.freeze({
    bluetooth,
    authorizedDeviceReconnect:
      bluetooth && transport.supportsAuthorizedDevices,
    durableStorage,
    largeRecordingSync: bluetooth && durableStorage,
    firmwareUpdate:
      bluetooth
      && transport.supportsAuthorizedDevices
      && durableStorage
      && typeof globalThis.fetch === 'function',
  })
}
