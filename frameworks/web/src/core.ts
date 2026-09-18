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

export interface CoreBridge {
  startExactConnection(input: CoreConnectionInput): CoreEffectEnvelope[]
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
