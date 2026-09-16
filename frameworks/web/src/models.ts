export type DeviceState =
  | 'idle'
  | 'recording'
  | 'syncing'
  | 'uploading'
  | 'charging'
  | 'low_battery'
  | 'storage_full'
  | 'error'
  | 'unknown'

export interface DeviceFlags {
  charging: boolean
  lowBattery: boolean
  storageFull: boolean
  wifiConnected: boolean
  lteConnected: boolean
  syncActive: boolean
}

export interface ModemInfo {
  imei: string | null
  iccid: string | null
  operator: string | null
  rat: string | null
  band: string | null
  apn: string | null
  simStatus: string | null
  csq: number | null
  ipAddress: string | null
  voltageMillivolts: number | null
  firmware: string | null
  roaming: boolean | null
}

export interface DeviceStatus {
  batteryPercent: number
  batteryMillivolts: number | null
  storageTotalMb: number
  storageUsedMb: number
  state: DeviceState
  stateRaw?: number
  pendingRecordings: number
  lastTimeSyncTimestamp: number
  flags: DeviceFlags
  lteStatusRaw: number
  lteSignalQuality: number | null
  wifiStatusRaw: number | null
  modemInfo: ModemInfo | null
}

export interface EncryptedUploadV2Capabilities {
  flags: number
  maximumSignedBlobBytes: number
  maximumManifestBytes: number
  maximumDataPayloadBytes: number
  maximumWindowPackets: number
  durableCheckpointIntervalBlocks: number
  maximumMissingSequences: number
}

export interface ConnectedDevice {
  id: string
  name: string | null
  serialNumber: string
}

export interface DeviceSnapshot {
  identity: {
    serialNumber: string
    modelNumber: string | null
    hardwareRevision: string | null
    firmwareRevision: string | null
  }
  status: DeviceStatus
  capabilities: {
    encryptedUploadV2: EncryptedUploadV2Capabilities | null
  }
  capturedAt: Date
}

export interface ConnectOptions {
  expectedSerialNumber: string
}
