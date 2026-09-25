import type {
  DeviceStatus,
  EncryptedUploadV2Capabilities,
} from './models.ts'
import { normalizeCoreError } from './errors.ts'

export type CoreOperation =
  | 'validate'
  | 'decode'
  | 'encode'
  | 'discover'
  | 'connect'
  | 'reconnect'
  | 'provision'
  | 'transfer_recording'
  | 'upload'
  | 'update_firmware'
  | 'read_device_logs'
  | 'factory_reset'
  | 'unknown'

export interface CoreConnectionInput {
  expectedSerialNumber: string
  peripheralId: string
  name: string | null
  cancellationId: Uint8Array
}

export interface CoreReconnectHint {
  storedPeripheralId: string | null
  advertisedAddress: string | null
  storedName: string | null
  scanTimeoutMs: bigint
  connectionTimeoutMs: bigint
}

export interface CoreReconnectInput {
  expectedSerialNumber: string
  hint: CoreReconnectHint
  cancellationId: Uint8Array
}

export interface CoreProvisioningInput {
  serialNumber: string
  materialId: string
  cancellationId: Uint8Array
}

export interface CoreRecordingTransferInput {
  serialNumber: string
  recordingUuid: string
  sinkId: string
  totalUnits: bigint
  cancellationId: Uint8Array
}

export interface CoreEncryptedUploadV2Input {
  serialNumber: string
  recordingUuid: string
  recordingGeneration: number
  storageFormat: number
  uploadSessionId: string
  ownerRevision: number
  transportSessionId: bigint
  materialId: string
  sinkId: string
  policy: 'legacy_allowed' | 'v2_preferred' | 'v2_required'
  capabilities: EncryptedUploadV2Capabilities
  windowPackets: number
  dataPayloadBytes: number
  ciphertextLength: bigint
  ciphertextSha256: Uint8Array
  cancellationId: Uint8Array
}

export interface CoreFirmwareUpdateInput {
  serialNumber: string
  version: string
  sizeBytes: number
  crc32: number
  downloadId: bigint
  reconnectHint: CoreReconnectHint
  cancellationId: Uint8Array
}

export interface CoreDeviceLogsInput {
  serialNumber: string
  cancellationId: Uint8Array
}

export interface CoreDeviceCandidate {
  peripheralId: string
  name: string | null
  advertisedAddress: string | null
  rssi: number
}

export type CoreWorkflowKind =
  | 'discovery'
  | 'connection'
  | 'provisioning'
  | 'recording_transfer'
  | 'recording_upload'
  | 'firmware_update'
  | 'device_logs'
  | 'factory_reset'

export type CoreCheckpointPhase =
  | 'pending'
  | 'connecting'
  | 'transferring'
  | 'uploading'
  | 'verifying'
  | 'reconnecting'
  | 'awaiting_receipt'

export interface CoreWorkflowCheckpoint {
  workflow: CoreWorkflowKind
  operation: CoreOperation
  serialNumber: string
  recordingUuid: Uint8Array | null
  phase: CoreCheckpointPhase
  completedUnits: bigint
  retryCount: number
  lastSequence: number | null
  firmwareVersion: string | null
}

export interface CoreEncryptedUploadV2Checkpoint {
  serialNumber: string
  recordingUuid: Uint8Array
  recordingGeneration: number
  uploadSessionId: Uint8Array
  ownerRevision: number
  transportSessionId: bigint
  checkpointRevision: number
  nextCiphertextOffset: bigint
  prefixSha256: Uint8Array
  windowPackets: number
  dataPayloadBytes: number
}

export interface CoreEncryptedUploadV2Evidence {
  ciphertextLength: bigint
  ciphertextSha256: Uint8Array
  manifestLength: number
  manifestSha256: Uint8Array
  blockCount: number
}

export type CoreNotification =
  | { kind: 'started'; operation: CoreOperation }
  | {
      kind: 'connection_established'
      serialNumber: string
      candidate: CoreDeviceCandidate
      mode: 'manual' | 'reconnect'
    }
  | {
      kind: 'progress'
      operation: CoreOperation
      completedUnits: bigint
      totalUnits: bigint
    }
  | { kind: 'retrying'; operation: CoreOperation; attempt: number }
  | {
      kind: 'firmware_progress'
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
  | { kind: 'device_log'; message: string; isBacklog: boolean }
  | {
      kind: 'recording_transfer_completed'
      encrypted: boolean
      sha256: Uint8Array | null
    }
  | {
      kind: 'encrypted_upload_v2_staged'
      uploadSessionId: Uint8Array
      ownerRevision: number
      ciphertextLength: bigint
      ciphertextSha256: Uint8Array
      manifestLength: number
      manifestSha256: Uint8Array
    }
  | { kind: 'completed'; operation: CoreOperation }
  | { kind: 'cancelled'; operation: CoreOperation }
  | { kind: 'failed'; error: unknown }

export type CoreEffect =
  | { kind: 'notify'; notification: CoreNotification }
  | { kind: 'ble_start_scan'; allowDuplicates: boolean }
  | { kind: 'ble_stop_scan' }
  | { kind: 'ble_connect'; peripheralId: string }
  | { kind: 'ble_discover_services'; peripheralId: string }
  | { kind: 'ble_disconnect'; peripheralId: string }
  | { kind: 'ble_read'; serviceUuid: string; characteristicUuid: string }
  | {
      kind: 'ble_write'
      serviceUuid: string
      characteristicUuid: string
      payload: Uint8Array
      withResponse: boolean
    }
  | { kind: 'ble_subscribe'; serviceUuid: string; characteristicUuid: string }
  | { kind: 'ble_unsubscribe'; serviceUuid: string; characteristicUuid: string }
  | { kind: 'timer_schedule'; timerId: bigint; delayMs: bigint }
  | { kind: 'timer_cancel'; timerId: bigint }
  | { kind: 'persistence_load_checkpoint' }
  | { kind: 'persistence_save_checkpoint'; checkpoint: CoreWorkflowCheckpoint }
  | { kind: 'persistence_delete_checkpoint' }
  | {
      kind: 'persistence_save_connection_identity'
      serialNumber: string
      candidate: CoreDeviceCandidate
    }
  | {
      kind: 'host_material_prepare_provisioning'
      materialId: string
      serialNumber: string
      nonce: Uint8Array
      devicePublicKey: Uint8Array
    }
  | { kind: 'recording_sink_truncate'; sinkId: string; completedUnits: bigint }
  | {
      kind: 'recording_sink_append'
      sinkId: string
      sequence: number
      payload: Uint8Array
    }
  | {
      kind: 'recording_sink_finalize'
      sinkId: string
      expectedCrc32: number | null
    }
  | { kind: 'recording_sink_discard'; sinkId: string }
  | { kind: 'network_download'; downloadId: bigint }
  | { kind: 'progress'; completedUnits: bigint; totalUnits: bigint }
  | {
      kind: 'firmware_blob_read_chunk'
      downloadId: bigint
      offset: bigint
      maxLength: number
    }
  | {
      kind: 'encrypted_upload_v2_load_checkpoint'
      serialNumber: string
      recordingUuid: Uint8Array
      recordingGeneration: number
      uploadSessionId: Uint8Array
      ownerRevision: number
    }
  | { kind: 'encrypted_upload_v2_delete_checkpoint'; uploadSessionId: Uint8Array }
  | {
      kind: 'encrypted_upload_v2_truncate_sink'
      sinkId: string
      nextCiphertextOffset: bigint
    }
  | { kind: 'encrypted_upload_v2_prepare_session'; materialId: string }
  | {
      kind: 'encrypted_upload_v2_start_transfer'
      serialNumber: string
      recordingUuid: Uint8Array
      recordingGeneration: number
      storageFormat: number
      uploadSessionId: Uint8Array
      ownerRevision: number
      transportSessionId: bigint
      materialId: string
      sinkId: string
      policy: CoreEncryptedUploadV2Input['policy']
      capabilities: EncryptedUploadV2Capabilities
      windowPackets: number
      dataPayloadBytes: number
      ciphertextLength: bigint
      ciphertextSha256: Uint8Array
      checkpoint: CoreEncryptedUploadV2Checkpoint | null
      authorizationSha256: Uint8Array
    }
  | { kind: 'encrypted_upload_v2_repair_window'; missingSequences: number[] }
  | {
      kind: 'encrypted_upload_v2_save_checkpoint'
      checkpoint: CoreEncryptedUploadV2Checkpoint
    }
  | {
      kind: 'encrypted_upload_v2_acknowledge_window'
      checkpoint: CoreEncryptedUploadV2Checkpoint
    }
  | {
      kind: 'encrypted_upload_v2_stage_artifacts'
      sinkId: string
      materialId: string
      evidence: CoreEncryptedUploadV2Evidence
    }
  | {
      kind: 'encrypted_upload_v2_await_completion_receipt'
      materialId: string
      evidence: CoreEncryptedUploadV2Evidence
    }
  | {
      kind: 'encrypted_upload_v2_confirm_with_receipt'
      materialId: string
      receiptSha256: Uint8Array
    }
  | { kind: 'encrypted_upload_v2_abort'; materialId: string }

export interface CoreEffectEnvelope {
  requestId: bigint
  operation: CoreOperation
  cancellationId: Uint8Array
  effect: CoreEffect
}

interface CoreRequest {
  requestId: bigint
}

export type CoreHostEvent =
  | (CoreRequest & { kind: 'ble_scan_result'; candidate: CoreDeviceCandidate })
  | (CoreRequest & { kind: 'ble_scan_stopped' })
  | (CoreRequest & { kind: 'ble_connected'; peripheralId: string })
  | (CoreRequest & { kind: 'ble_services_discovered'; peripheralId: string })
  | (CoreRequest & { kind: 'ble_subscribed'; characteristicUuid: string })
  | (CoreRequest & {
      kind: 'ble_disconnected'
      peripheralId: string
      reasonCode: number | null
    })
  | (CoreRequest & { kind: 'ble_read_completed'; value: Uint8Array })
  | (CoreRequest & { kind: 'ble_write_completed' })
  | (CoreRequest & {
      kind: 'ble_notification'
      characteristicUuid: string
      value: Uint8Array
    })
  | (CoreRequest & { kind: 'ble_failed'; platformCode: number | null })
  | (CoreRequest & { kind: 'timer_fired'; timerId: bigint })
  | (CoreRequest & {
      kind: 'checkpoint_loaded'
      checkpoint: CoreWorkflowCheckpoint | null
    })
  | (CoreRequest & { kind: 'checkpoint_saved' })
  | (CoreRequest & { kind: 'connection_identity_saved' })
  | (CoreRequest & { kind: 'persistence_failed'; platformCode: bigint | null })
  | (CoreRequest & {
      kind: 'provisioning_material_prepared'
      apiEndpoint: Uint8Array
      deviceToken: Uint8Array
      mtu: number
    })
  | (CoreRequest & { kind: 'host_material_failed'; platformCode: bigint | null })
  | (CoreRequest & { kind: 'recording_sink_truncated' })
  | (CoreRequest & { kind: 'recording_sink_append_completed'; durableUnits: bigint })
  | (CoreRequest & { kind: 'recording_sink_finalized'; durableUnits: bigint })
  | (CoreRequest & { kind: 'recording_sink_integrity_failed' })
  | (CoreRequest & { kind: 'recording_sink_failed'; platformCode: bigint | null })
  | (CoreRequest & {
      kind: 'firmware_chunk_read'
      downloadId: bigint
      offset: bigint
      bytes: Uint8Array
    })
  | (CoreRequest & { kind: 'firmware_blob_failed'; platformCode: bigint | null })
  | (CoreRequest & {
      kind: 'network_download_progress'
      downloadId: bigint
      completedBytes: bigint
      totalBytes: bigint | null
    })
  | (CoreRequest & {
      kind: 'network_download_completed'
      downloadId: bigint
      crc32: number
    })
  | (CoreRequest & {
      kind: 'network_failed'
      transferId: bigint
      statusCode: number | null
    })
  | (CoreRequest & {
      kind: 'encrypted_upload_v2_checkpoint_loaded'
      checkpoint: CoreEncryptedUploadV2Checkpoint | null
    })
  | (CoreRequest & { kind: 'encrypted_upload_v2_sink_truncated' })
  | (CoreRequest & {
      kind: 'encrypted_upload_v2_session_prepared'
      authorizationSha256: Uint8Array
    })
  | (CoreRequest & { kind: 'encrypted_upload_v2_transfer_started' })
  | (CoreRequest & { kind: 'encrypted_upload_v2_resume_rejected' })
  | (CoreRequest & {
      kind: 'encrypted_upload_v2_window_staged'
      checkpoint: CoreEncryptedUploadV2Checkpoint
      missingSequences: number[]
    })
  | (CoreRequest & { kind: 'encrypted_upload_v2_checkpoint_saved' })
  | (CoreRequest & {
      kind: 'encrypted_upload_v2_window_acknowledged'
      checkpoint: CoreEncryptedUploadV2Checkpoint
    })
  | (CoreRequest & {
      kind: 'encrypted_upload_v2_transfer_completed'
      evidence: CoreEncryptedUploadV2Evidence
    })
  | (CoreRequest & { kind: 'encrypted_upload_v2_artifacts_staged' })
  | (CoreRequest & {
      kind: 'encrypted_upload_v2_completion_receipt_accepted'
      receiptSha256: Uint8Array
    })
  | (CoreRequest & { kind: 'encrypted_upload_v2_recording_confirmed' })
  | (CoreRequest & { kind: 'encrypted_upload_v2_mixed_profile' })
  | (CoreRequest & { kind: 'encrypted_upload_v2_failed'; error: unknown })

export type CoreWorkflowStatus =
  | { kind: 'idle' }
  | { kind: 'running'; operation: CoreOperation; cancellationId: Uint8Array }
  | { kind: 'completed'; operation: CoreOperation }
  | { kind: 'cancelled'; operation: CoreOperation }
  | { kind: 'failed'; error: unknown }

export interface CoreDeviceRecording {
  uuid: string
  startedAtTimestampSeconds: number
  durationMilliseconds: bigint
  fileSizeBytes: bigint
  codec: 'pcm_16k' | 'pcm_8k' | 'opus_16k' | 'opus_8k' | 'unknown'
  codecRaw?: number
  encrypted: boolean
}

export type CoreConnectionType = 'wifi' | 'ble' | 'cellular' | 'unknown'

export interface CoreConnectionSettings {
  enabledConnections: { wifi: boolean; cellular: boolean }
  heartbeatEnabledConnections: { wifi: boolean; cellular: boolean }
  uploadNetworkPreference: CoreConnectionType[]
  powerManagement: {
    cellularIdleTimeoutSeconds: number
    wifiIdleTimeoutSeconds: number
  }
  streamingEnabled: boolean
  streamingFlushIntervalSeconds: number
}

export interface CoreDecodedConnectionSettings extends CoreConnectionSettings {
  supportedVersion: boolean
}

export type CoreDeviceModel = 'pin' | 'pin_4g' | 'note'

export interface CoreOperationResult {
  success: boolean
  error?: string
  errorRaw?: number
}

export interface CoreWiFiStatusInfo {
  status: 'idle' | 'connecting' | 'connected' | 'failed' | 'disconnected' | 'unknown'
  statusRaw: number
  signalStrength?: number
  ssid?: string
  lastError?: string
}

export interface CoreWiFiScanNetwork {
  ssid: string
  quality: number
  isCurrent: boolean
  isOpen: boolean
}

export type CoreWiFiScanUpdate =
  | { kind: 'pending'; statusRaw: number }
  | {
      kind: 'done'
      networks: CoreWiFiScanNetwork[]
      currentSsid: string | null
    }

interface CoreEncryptedUploadV2Common {
  flags: number
  transportSessionId: bigint
}

interface CoreEncryptedUploadV2ResumeFrame extends CoreEncryptedUploadV2Common {
  uploadSessionUuid: string
  recordingUuid: string
  recordingGeneration: number
  checkpointRevision: number
  nextCiphertextOffset: bigint
  prefixSha256: Uint8Array
  windowPackets: number
  dataPayloadBytes: number
}

export type CoreEncryptedUploadV2TransferFrame =
  | (CoreEncryptedUploadV2Common & { kind: 'list' })
  | (CoreEncryptedUploadV2Common & {
      kind: 'recording_entry'
      recordingUuid: string
      recordingGeneration: number
      storageFormat: number
      completionState: number
      startedAt: bigint
      durationSeconds: number
      plaintextLength: bigint
      ciphertextLength: bigint
      ciphertextSha256: Uint8Array
    })
  | (CoreEncryptedUploadV2Common & {
      kind: 'recording_list_end'
      count: number
      listRevision: number
      listSha256: Uint8Array
    })
  | (CoreEncryptedUploadV2Common & {
      kind: 'start'
      uploadSessionUuid: string
      recordingUuid: string
      recordingGeneration: number
      authorizationSha256: Uint8Array
      checkpointRevision: number
      nextCiphertextOffset: bigint
      prefixSha256: Uint8Array
      windowPackets: number
      dataPayloadBytes: number
    })
  | (CoreEncryptedUploadV2Common & {
      kind: 'start_ack'
      uploadSessionUuid: string
      recordingUuid: string
      recordingGeneration: number
      ciphertextLength: bigint
      ciphertextSha256: Uint8Array
      windowPackets: number
      dataPayloadBytes: number
      checkpointIntervalBlocks: number
      checkpointRevision: number
      nextCiphertextOffset: bigint
      prefixSha256: Uint8Array
    })
  | (CoreEncryptedUploadV2Common & {
      kind: 'data'
      sequence: number
      offset: bigint
      data: Uint8Array
    })
  | (CoreEncryptedUploadV2Common & {
      kind: 'window_end'
      windowIndex: number
      firstSequence: number
      lastSequence: number
      nextCiphertextOffset: bigint
      prefixSha256: Uint8Array
      checkpointRevision: number
    })
  | (CoreEncryptedUploadV2Common & {
      kind: 'window_ack'
      windowIndex: number
      highestContiguousSequence: number
      nextCiphertextOffset: bigint
      prefixSha256: Uint8Array
      checkpointRevision: number
      missingSequences: number[]
    })
  | (CoreEncryptedUploadV2Common & {
      kind: 'manifest_chunk'
      totalManifestLength: number
      chunkOffset: number
      manifestSha256: Uint8Array
      chunk: Uint8Array
    })
  | (CoreEncryptedUploadV2Common & {
      kind: 'eof'
      finalSequence: number
      blockCount: number
      ciphertextLength: bigint
      ciphertextSha256: Uint8Array
      manifestSha256: Uint8Array
    })
  | (CoreEncryptedUploadV2ResumeFrame & { kind: 'resume_request' })
  | (CoreEncryptedUploadV2ResumeFrame & { kind: 'resume_accept' })
  | (CoreEncryptedUploadV2Common & {
      kind: 'resume_reject'
      reason: number
      checkpointRevision: number
      nextCiphertextOffset: bigint
      prefixSha256: Uint8Array
    })
  | (CoreEncryptedUploadV2Common & {
      kind: 'confirm'
      uploadSessionUuid: string
      recordingUuid: string
      recordingGeneration: number
      ownerRevision: number
      receiptSha256: Uint8Array
    })
  | (CoreEncryptedUploadV2Common & { kind: 'abort'; reason: number })
  | (CoreEncryptedUploadV2Common & {
      kind: 'error'
      result: number
      failedMessageType: number
      checkpointRevision: number
    })

export type CoreEncryptedUploadV2OutboundTransferFrame = Extract<
  CoreEncryptedUploadV2TransferFrame,
  { kind: 'list' | 'start' | 'window_ack' | 'resume_request' | 'confirm' | 'abort' }
>

export interface CoreEncryptedUploadV2Status {
  phase: number
  result: number
  transportSessionId: bigint
  durableCiphertextBytes: bigint
  progressPercent: number
  transportProfile: number
}

export type CoreEncryptedUploadV2SignedBlobFrame =
  | {
      kind: 'begin'
      blobKind: 'authorization' | 'receipt'
      writeId: number
      totalLength: number
      sha256: Uint8Array
    }
  | {
      kind: 'data'
      blobKind: 'authorization' | 'receipt'
      writeId: number
      offset: number
      data: Uint8Array
    }
  | {
      kind: 'commit' | 'abort'
      blobKind: 'authorization' | 'receipt'
      writeId: number
    }

export interface CoreEncryptedUploadV2SignedBlobResult {
  blobKind: 'authorization' | 'receipt'
  writeId: number
  result: number
}

export interface CoreIntegrityHasher {
  update(bytes: Uint8Array): void
  length(): bigint
  crc32(): number
  sha256Snapshot(): Uint8Array
}

export interface CoreBridge {
  startExactConnection(input: CoreConnectionInput): CoreEffectEnvelope[]
  startSelectedConnection(input: Omit<CoreConnectionInput, 'expectedSerialNumber'>): CoreEffectEnvelope[]
  startReconnect(input: CoreReconnectInput): CoreEffectEnvelope[]
  startProvisioning(input: CoreProvisioningInput): CoreEffectEnvelope[]
  startRecordingTransfer(input: CoreRecordingTransferInput): CoreEffectEnvelope[]
  startEncryptedUploadV2(input: CoreEncryptedUploadV2Input): CoreEffectEnvelope[]
  startFirmwareUpdate(input: CoreFirmwareUpdateInput): CoreEffectEnvelope[]
  startDeviceLogs(input: CoreDeviceLogsInput): CoreEffectEnvelope[]
  cancel(cancellationId: Uint8Array): CoreEffectEnvelope[]
  dispatch(event: CoreHostEvent): CoreEffectEnvelope[]
  status(): CoreWorkflowStatus
  decodeDeviceStatus(bytes: Uint8Array): DeviceStatus
  decodeEncryptedUploadV2Capabilities(
    bytes: Uint8Array,
  ): EncryptedUploadV2Capabilities
  supportsEncryptedUploadV2Batch(
    capabilities: EncryptedUploadV2Capabilities,
  ): boolean
  validateEncryptedUploadV2Profile(
    capabilities: EncryptedUploadV2Capabilities,
    recordingGeneration: number,
    storageFormat: number,
  ): void
  decodeRecordingList(bytes: Uint8Array): CoreDeviceRecording[]
  encodeRecordingListCommand(): Uint8Array
  encodeRecordingConfirm(recordingUuid: string): Uint8Array
  encodeDeprovisionCommand(): Uint8Array
  decodeDeprovisionResult(bytes: Uint8Array): CoreOperationResult
  decodeConnectionSettings(bytes: Uint8Array): CoreDecodedConnectionSettings
  encodeConnectionSettings(
    settings: CoreConnectionSettings,
    model: CoreDeviceModel,
  ): Uint8Array
  encodeWiFiGrant(grant: string, capacity: number): Uint8Array
  encodeWiFiCredentials(ssid: string, password: string): Uint8Array
  encodeWiFiScanCommand(): Uint8Array
  decodeWiFiConfigResult(bytes: Uint8Array): CoreOperationResult
  decodeWiFiStatus(bytes: Uint8Array): CoreWiFiStatusInfo
  decodeWiFiScanUpdate(bytes: Uint8Array): CoreWiFiScanUpdate
  encodeRecordingControlCommand(action: 'start' | 'stop'): Uint8Array
  decodeRecordingControlResult(bytes: Uint8Array): CoreOperationResult
  decodeEncryptedUploadV2Transfer(
    bytes: Uint8Array,
  ): CoreEncryptedUploadV2TransferFrame
  encodeEncryptedUploadV2Transfer(
    frame: CoreEncryptedUploadV2OutboundTransferFrame,
  ): Uint8Array
  decodeEncryptedUploadV2Status(bytes: Uint8Array): CoreEncryptedUploadV2Status
  encodeEncryptedUploadV2SignedBlob(
    frame: CoreEncryptedUploadV2SignedBlobFrame,
  ): Uint8Array
  decodeEncryptedUploadV2SignedBlobResult(
    bytes: Uint8Array,
  ): CoreEncryptedUploadV2SignedBlobResult
  createIntegrityHasher(): CoreIntegrityHasher
}

export type CoreLoader = () => Promise<CoreBridge>

export function createCoreLoader(importer: CoreLoader): CoreLoader {
  let pending: Promise<CoreBridge> | null = null

  return async () => {
    if (!pending) {
      pending = importer().catch((error: unknown) => {
        pending = null
        throw normalizeCoreError(error, 'initialize')
      })
    }
    return pending
  }
}
