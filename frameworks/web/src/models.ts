import type { RecordingJournalPhase } from './storage.ts'

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

export interface ReconnectOptions {
  expectedSerialNumber: string
}

export interface ProvisionRequest {
  attemptId: string
  signal?: AbortSignal
}

export interface DeprovisionRequest {
  grant: Uint8Array
  signal?: AbortSignal
}

export interface DeprovisionResult {
  success: boolean
  error?:
    | 'invalid_token'
    | 'storage_error'
    | 'chunk_error'
    | 'already_paired'
    | 'unknown'
  errorRaw?: number
}

export interface DeviceConnectionSettings {
  enabledConnections: {
    wifi: boolean
    cellular: boolean
  }
  heartbeatEnabledConnections: {
    wifi: boolean
    cellular: boolean
  }
  uploadNetworkPreference: Array<'wifi' | 'ble' | 'cellular'>
  powerManagement: {
    cellularIdleTimeoutSeconds: number
    wifiIdleTimeoutSeconds: number
  }
  streamingEnabled: boolean
  streamingFlushIntervalSeconds: number
}

export interface WiFiCredentials {
  ssid: string
  password: string
}

export interface WiFiScanNetwork {
  ssid: string
  quality: number
  isCurrent: boolean
  isOpen: boolean
}

export interface WiFiScanResult {
  networks: WiFiScanNetwork[]
  currentSsid: string | null
}

export interface WiFiStatusInfo {
  status:
    | 'idle'
    | 'connecting'
    | 'connected'
    | 'failed'
    | 'disconnected'
    | 'unknown'
  statusRaw: number
  signalStrength?: number
  ssid?: string
  lastError?: string
}

export type WiFiConfigResult =
  | { success: true }
  | {
      success: false
      error:
        | 'invalid_grant'
        | 'grant_expired'
        | 'decryption_error'
        | 'storage_error'
        | 'unknown'
      errorRaw?: number
    }

export interface WiFiStatusSubscription {
  remove(): Promise<void>
}

export interface DeviceLogLine {
  message: string
  isBacklog: boolean
}

export interface DeviceLogSubscription {
  remove(): Promise<void>
}

export interface RecordingControlRequest {
  authorityId: string
  operationId?: string
  signal?: AbortSignal
}

export type RecordingControlResult =
  | { success: true }
  | {
      success: false
      error:
        | 'already_recording'
        | 'not_recording'
        | 'invalid_grant'
        | 'invalid_state'
        | 'invalid_response'
        | 'unknown_error'
      errorRaw?: number
    }

export interface BrowserCapabilities {
  readonly bluetooth: boolean
  readonly authorizedDeviceReconnect: boolean
  readonly durableStorage: boolean
  readonly largeRecordingSync: boolean
  readonly firmwareUpdate: boolean
}

export interface FirmwareImageDescriptor {
  imageId: string
  version: string
  sizeBytes: number
  crc32: number
  sha256Hex: string
}

export interface FirmwareUpdateOptions {
  operationId?: string
  signal?: AbortSignal
  onProgress?: (progress: FirmwareUpdateProgress) => void
}

export interface FirmwareUpdateProgress {
  phase:
    | 'downloading'
    | 'awaiting_device'
    | 'transferring'
    | 'verifying'
    | 'rebooting'
    | 'reconnecting'
    | 'complete'
  completedBytes: bigint
  totalBytes: bigint
}

export interface DeviceRecording {
  uuid: string
  startedAtTimestampSeconds: number
  durationMilliseconds: bigint
  fileSizeBytes: bigint
  codec: 'pcm_16k' | 'pcm_8k' | 'opus_16k' | 'opus_8k' | 'unknown'
  codecRaw?: number
  encrypted: boolean
  encryptedUploadV2: {
    generation: number
    storageFormat: number
    plaintextLength: bigint
    ciphertextLength: bigint
    ciphertextSha256: Uint8Array
  } | null
}

export interface RecordingSyncProgress {
  phase: RecordingJournalPhase
  completedBytes: bigint
  totalBytes: bigint
}

export interface RecordingSyncResult {
  operationId: string
  recordingUuid: string
  profile: 'legacy' | 'encrypted_upload_v2'
  cloudCompletionId: string
}

export interface RecordingSyncOptions {
  profile: 'legacy' | 'encrypted_upload_v2'
  operationId?: string
  signal?: AbortSignal
  onProgress?: (progress: RecordingSyncProgress) => void
}

export interface RecordingJournalSummary {
  operationId: string
  serialNumber: string
  recordingUuid: string
  profile: 'legacy' | 'encrypted_upload_v2'
  phase: RecordingJournalPhase
  updatedAtEpochMs: number
}
