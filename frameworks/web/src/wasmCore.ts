import initWasm, {
  WebCoreBridge as GeneratedWebCoreBridge,
  decodeDeviceStatus as decodeGeneratedDeviceStatus,
  decodeEncryptedUploadV2Capabilities as decodeGeneratedCapabilities,
} from './generated/bota_device_sdk_core.js'

import type {
  CoreBridge,
  CoreCheckpointPhase,
  CoreDeviceCandidate,
  CoreEffect,
  CoreEffectEnvelope,
  CoreEncryptedUploadV2Checkpoint,
  CoreEncryptedUploadV2Evidence,
  CoreEncryptedUploadV2Input,
  CoreHostEvent,
  CoreNotification,
  CoreOperation,
  CoreWorkflowCheckpoint,
  CoreWorkflowKind,
  CoreWorkflowStatus,
} from './core.ts'
import { createCoreLoader } from './core.ts'
import {
  BotaSDKError,
  normalizeCoreError,
  normalizePrivateCoreError,
} from './errors.ts'
import type {
  DeviceState,
  DeviceStatus,
  EncryptedUploadV2Capabilities,
  ModemInfo,
} from './models.ts'

type UnknownRecord = Record<string, unknown>

export async function createWasmCore(moduleInput?: unknown): Promise<CoreBridge> {
  try {
    if (moduleInput === undefined) {
      await initWasm()
    } else {
      await initWasm({ module_or_path: moduleInput as WebAssembly.Module })
    }
    return new WasmCoreAdapter(new GeneratedWebCoreBridge())
  } catch (error) {
    throw normalizeCoreError(error, 'initialize')
  }
}

export const loadDefaultCore = createCoreLoader(() => createWasmCore())

class WasmCoreAdapter implements CoreBridge {
  private readonly generated: GeneratedWebCoreBridge

  constructor(generated: GeneratedWebCoreBridge) {
    this.generated = generated
  }

  startExactConnection(
    input: Parameters<CoreBridge['startExactConnection']>[0],
  ): CoreEffectEnvelope[] {
    try {
      return normalizeEffects(this.generated.startExactConnection(
        input.expectedSerialNumber,
        input.peripheralId,
        input.name,
        input.cancellationId,
      ))
    } catch (error) {
      throw normalizeCoreError(error, 'connect')
    }
  }

  startReconnect(
    input: Parameters<CoreBridge['startReconnect']>[0],
  ): CoreEffectEnvelope[] {
    try {
      return normalizeEffects(this.generated.startReconnect({
        expected_serial: input.expectedSerialNumber,
        hint: rawReconnectHint(input.hint),
        cancellation_id: rawBytes(input.cancellationId),
      }))
    } catch (error) {
      throw normalizePrivateCoreError(error, 'reconnect')
    }
  }

  startProvisioning(
    input: Parameters<CoreBridge['startProvisioning']>[0],
  ): CoreEffectEnvelope[] {
    try {
      return normalizeEffects(this.generated.startProvisioning({
        serial_number: input.serialNumber,
        material_id: input.materialId,
        cancellation_id: rawBytes(input.cancellationId),
      }))
    } catch (error) {
      throw normalizePrivateCoreError(error, 'provision')
    }
  }

  startRecordingTransfer(
    input: Parameters<CoreBridge['startRecordingTransfer']>[0],
  ): CoreEffectEnvelope[] {
    try {
      return normalizeEffects(this.generated.startRecordingTransfer({
        serial_number: input.serialNumber,
        recording_uuid: input.recordingUuid,
        sink_id: input.sinkId,
        total_units: input.totalUnits,
        cancellation_id: rawBytes(input.cancellationId),
      }))
    } catch (error) {
      throw normalizePrivateCoreError(error, 'transfer_recording')
    }
  }

  startEncryptedUploadV2(
    input: CoreEncryptedUploadV2Input,
  ): CoreEffectEnvelope[] {
    try {
      return normalizeEffects(this.generated.startEncryptedUploadV2({
        serial_number: input.serialNumber,
        recording_uuid: input.recordingUuid,
        recording_generation: input.recordingGeneration,
        storage_format: input.storageFormat,
        upload_session_id: input.uploadSessionId,
        owner_revision: input.ownerRevision,
        transport_session_id: input.transportSessionId,
        material_id: input.materialId,
        sink_id: input.sinkId,
        policy: rawUploadPolicy(input.policy),
        capabilities: rawCapabilities(input.capabilities),
        window_packets: input.windowPackets,
        data_payload_bytes: input.dataPayloadBytes,
        ciphertext_length: input.ciphertextLength,
        ciphertext_sha256: rawBytes(input.ciphertextSha256),
        cancellation_id: rawBytes(input.cancellationId),
      }))
    } catch (error) {
      throw normalizePrivateCoreError(error, 'transfer_recording')
    }
  }

  startFirmwareUpdate(
    input: Parameters<CoreBridge['startFirmwareUpdate']>[0],
  ): CoreEffectEnvelope[] {
    try {
      return normalizeEffects(this.generated.startFirmwareUpdate({
        serial_number: input.serialNumber,
        version: input.version,
        size_bytes: input.sizeBytes,
        crc32: input.crc32,
        download_id: input.downloadId,
        reconnect_hint: rawReconnectHint(input.reconnectHint),
        cancellation_id: rawBytes(input.cancellationId),
      }))
    } catch (error) {
      throw normalizePrivateCoreError(error, 'update_firmware')
    }
  }

  startDeviceLogs(
    input: Parameters<CoreBridge['startDeviceLogs']>[0],
  ): CoreEffectEnvelope[] {
    try {
      return normalizeEffects(this.generated.startDeviceLogs({
        serial_number: input.serialNumber,
        cancellation_id: rawBytes(input.cancellationId),
      }))
    } catch (error) {
      throw normalizePrivateCoreError(error, 'read_device_logs')
    }
  }

  cancel(cancellationId: Uint8Array): CoreEffectEnvelope[] {
    try {
      return normalizeEffects(this.generated.cancel(cancellationId))
    } catch (error) {
      throw normalizePrivateCoreError(error, 'unknown')
    }
  }

  dispatch(event: CoreHostEvent): CoreEffectEnvelope[] {
    try {
      return normalizeEffects(this.generated.dispatch(rawHostEvent(event)))
    } catch (error) {
      throw normalizePrivateCoreError(error, 'unknown')
    }
  }

  status(): CoreWorkflowStatus {
    try {
      return normalizeStatus(this.generated.status())
    } catch (error) {
      throw normalizePrivateCoreError(error, 'unknown')
    }
  }

  decodeDeviceStatus(bytes: Uint8Array): DeviceStatus {
    try {
      return normalizeDeviceStatus(decodeGeneratedDeviceStatus(bytes))
    } catch (error) {
      throw normalizeCoreError(error, 'read_snapshot')
    }
  }

  decodeEncryptedUploadV2Capabilities(
    bytes: Uint8Array,
  ): EncryptedUploadV2Capabilities {
    try {
      return normalizeCapabilities(decodeGeneratedCapabilities(bytes))
    } catch (error) {
      throw normalizeCoreError(error, 'read_snapshot')
    }
  }
}

function rawReconnectHint(
  hint: Parameters<CoreBridge['startReconnect']>[0]['hint'],
): UnknownRecord {
  return {
    stored_peripheral_id: hint.storedPeripheralId ?? undefined,
    advertised_address: hint.advertisedAddress ?? undefined,
    stored_name: hint.storedName ?? undefined,
    scan_timeout_ms: hint.scanTimeoutMs,
    connection_timeout_ms: hint.connectionTimeoutMs,
  }
}

function rawCapabilities(capabilities: EncryptedUploadV2Capabilities): UnknownRecord {
  return {
    flags: capabilities.flags,
    maximum_signed_blob_bytes: capabilities.maximumSignedBlobBytes,
    maximum_manifest_bytes: capabilities.maximumManifestBytes,
    maximum_data_payload_bytes: capabilities.maximumDataPayloadBytes,
    maximum_window_packets: capabilities.maximumWindowPackets,
    durable_checkpoint_interval_blocks: capabilities.durableCheckpointIntervalBlocks,
    maximum_missing_sequences: capabilities.maximumMissingSequences,
  }
}

function rawUploadPolicy(policy: CoreEncryptedUploadV2Input['policy']): string {
  switch (policy) {
    case 'legacy_allowed': return 'LegacyAllowed'
    case 'v2_preferred': return 'V2Preferred'
    case 'v2_required': return 'V2Required'
    default: throw internalBridgeError()
  }
}

function normalizeEffects(value: unknown): CoreEffectEnvelope[] {
  if (!Array.isArray(value)) throw internalBridgeError()
  return value.map((item) => {
    const request = record(item)
    return {
      requestId: bigint(request.request_id),
      operation: normalizeOperation(request.operation),
      cancellationId: bytes(request.cancellation_id, 16),
      effect: normalizeEffect(request.effect),
    }
  })
}

function normalizeEffect(value: unknown): CoreEffect {
  const effect = record(value)
  if ('Notify' in effect) {
    return { kind: 'notify', notification: normalizeNotification(effect.Notify) }
  }

  if ('Ble' in effect) return normalizeBleEffect(effect.Ble)

  if ('Timer' in effect) {
    const timer = record(effect.Timer)
    if ('Schedule' in timer) {
      const schedule = record(timer.Schedule)
      return {
        kind: 'timer_schedule',
        timerId: bigint(schedule.timer_id),
        delayMs: bigint(schedule.delay_ms),
      }
    }
    if ('Cancel' in timer) {
      return {
        kind: 'timer_cancel',
        timerId: bigint(record(timer.Cancel).timer_id),
      }
    }
  }

  if ('Persistence' in effect) return normalizePersistenceEffect(effect.Persistence)

  if ('Network' in effect) {
    const network = record(effect.Network)
    if ('Download' in network) {
      return {
        kind: 'network_download',
        downloadId: bigint(record(network.Download).download_id),
      }
    }
  }

  if ('Progress' in effect) {
    const progress = record(effect.Progress)
    return {
      kind: 'progress',
      completedUnits: bigint(progress.completed_units),
      totalUnits: bigint(progress.total_units),
    }
  }

  if ('HostMaterial' in effect) {
    const host = record(effect.HostMaterial)
    if ('PrepareProvisioning' in host) {
      const prepare = record(host.PrepareProvisioning)
      return {
        kind: 'host_material_prepare_provisioning',
        materialId: string(prepare.material_id),
        serialNumber: string(prepare.device),
        nonce: bytes(prepare.nonce, 16),
        devicePublicKey: bytes(prepare.device_public_key),
      }
    }
  }

  if ('RecordingSink' in effect) return normalizeRecordingSinkEffect(effect.RecordingSink)

  if ('FirmwareBlob' in effect) {
    const firmware = record(effect.FirmwareBlob)
    if ('ReadChunk' in firmware) {
      const chunk = record(firmware.ReadChunk)
      return {
        kind: 'firmware_blob_read_chunk',
        downloadId: bigint(chunk.download_id),
        offset: bigint(chunk.offset),
        maxLength: number(chunk.max_length),
      }
    }
  }

  if ('EncryptedUploadV2' in effect) {
    return normalizeEncryptedUploadV2Effect(effect.EncryptedUploadV2)
  }

  throw internalBridgeError()
}

function normalizeBleEffect(value: unknown): CoreEffect {
  if (value === 'StopScan') return { kind: 'ble_stop_scan' }
  const ble = record(value)
  if ('StartScan' in ble) {
    return {
      kind: 'ble_start_scan',
      allowDuplicates: boolean(record(ble.StartScan).allow_duplicates),
    }
  }
  if ('Connect' in ble) {
    return {
      kind: 'ble_connect',
      peripheralId: string(record(ble.Connect).peripheral_id),
    }
  }
  if ('DiscoverServices' in ble) {
    return {
      kind: 'ble_discover_services',
      peripheralId: string(record(ble.DiscoverServices).peripheral_id),
    }
  }
  if ('Disconnect' in ble) {
    return {
      kind: 'ble_disconnect',
      peripheralId: string(record(ble.Disconnect).peripheral_id),
    }
  }
  if ('Read' in ble) {
    const read = record(ble.Read)
    return {
      kind: 'ble_read',
      serviceUuid: string(read.service_uuid),
      characteristicUuid: string(read.characteristic_uuid),
    }
  }
  if ('Write' in ble) {
    const write = record(ble.Write)
    return {
      kind: 'ble_write',
      serviceUuid: string(write.service_uuid),
      characteristicUuid: string(write.characteristic_uuid),
      payload: bytes(write.payload),
      withResponse: boolean(write.with_response),
    }
  }
  if ('Subscribe' in ble) {
    const subscribe = record(ble.Subscribe)
    return {
      kind: 'ble_subscribe',
      serviceUuid: string(subscribe.service_uuid),
      characteristicUuid: string(subscribe.characteristic_uuid),
    }
  }
  if ('Unsubscribe' in ble) {
    const unsubscribe = record(ble.Unsubscribe)
    return {
      kind: 'ble_unsubscribe',
      serviceUuid: string(unsubscribe.service_uuid),
      characteristicUuid: string(unsubscribe.characteristic_uuid),
    }
  }
  throw internalBridgeError()
}

function normalizePersistenceEffect(value: unknown): CoreEffect {
  if (value === 'LoadCheckpoint') return { kind: 'persistence_load_checkpoint' }
  if (value === 'DeleteCheckpoint') return { kind: 'persistence_delete_checkpoint' }
  const persistence = record(value)
  if ('SaveCheckpoint' in persistence) {
    return {
      kind: 'persistence_save_checkpoint',
      checkpoint: normalizeWorkflowCheckpoint(record(persistence.SaveCheckpoint).checkpoint),
    }
  }
  if ('SaveConnectionIdentity' in persistence) {
    const save = record(persistence.SaveConnectionIdentity)
    return {
      kind: 'persistence_save_connection_identity',
      serialNumber: string(save.device),
      candidate: normalizeCandidate(save.candidate),
    }
  }
  throw internalBridgeError()
}

function normalizeRecordingSinkEffect(value: unknown): CoreEffect {
  const sink = record(value)
  if ('Truncate' in sink) {
    const truncate = record(sink.Truncate)
    return {
      kind: 'recording_sink_truncate',
      sinkId: string(truncate.sink_id),
      completedUnits: bigint(truncate.completed_units),
    }
  }
  if ('Append' in sink) {
    const append = record(sink.Append)
    return {
      kind: 'recording_sink_append',
      sinkId: string(append.sink_id),
      sequence: number(append.sequence),
      payload: bytes(append.payload),
    }
  }
  if ('Finalize' in sink) {
    const finalize = record(sink.Finalize)
    return {
      kind: 'recording_sink_finalize',
      sinkId: string(finalize.sink_id),
      expectedCrc32: optionalNumber(finalize.expected_crc32),
    }
  }
  if ('Discard' in sink) {
    return {
      kind: 'recording_sink_discard',
      sinkId: string(record(sink.Discard).sink_id),
    }
  }
  throw internalBridgeError()
}

function normalizeEncryptedUploadV2Effect(value: unknown): CoreEffect {
  const encrypted = record(value)
  if ('LoadCheckpoint' in encrypted) {
    const load = record(encrypted.LoadCheckpoint)
    return {
      kind: 'encrypted_upload_v2_load_checkpoint',
      serialNumber: string(load.device),
      recordingUuid: bytes(load.recording, 16),
      recordingGeneration: number(load.recording_generation),
      uploadSessionId: bytes(load.upload_session_uuid, 16),
      ownerRevision: number(load.owner_revision),
    }
  }
  if ('DeleteCheckpoint' in encrypted) {
    return {
      kind: 'encrypted_upload_v2_delete_checkpoint',
      uploadSessionId: bytes(record(encrypted.DeleteCheckpoint).upload_session_uuid, 16),
    }
  }
  if ('TruncateSink' in encrypted) {
    const truncate = record(encrypted.TruncateSink)
    return {
      kind: 'encrypted_upload_v2_truncate_sink',
      sinkId: string(truncate.sink_id),
      nextCiphertextOffset: bigint(truncate.next_ciphertext_offset),
    }
  }
  if ('PrepareSession' in encrypted) {
    return {
      kind: 'encrypted_upload_v2_prepare_session',
      materialId: string(record(encrypted.PrepareSession).material_id),
    }
  }
  if ('StartTransfer' in encrypted) {
    const start = record(encrypted.StartTransfer)
    const request = record(start.request)
    const selection = record(request.selection)
    if (selection.profile !== 'EncryptedUploadV2') throw internalBridgeError()
    return {
      kind: 'encrypted_upload_v2_start_transfer',
      serialNumber: string(request.device),
      recordingUuid: bytes(request.recording, 16),
      recordingGeneration: number(request.recording_generation),
      storageFormat: number(request.storage_format),
      uploadSessionId: bytes(request.upload_session_uuid, 16),
      ownerRevision: number(request.owner_revision),
      transportSessionId: bigint(request.transport_session_id),
      materialId: string(request.material_id),
      sinkId: string(request.sink_id),
      policy: normalizeUploadPolicy(selection.policy),
      capabilities: normalizeCapabilities(request.capabilities),
      windowPackets: number(request.window_packets),
      dataPayloadBytes: number(request.data_payload_bytes),
      ciphertextLength: bigint(request.ciphertext_length),
      ciphertextSha256: bytes(request.ciphertext_sha256, 32),
      checkpoint: optionalEncryptedCheckpoint(start.checkpoint),
      authorizationSha256: bytes(start.authorization_sha256, 32),
    }
  }
  if ('RepairWindow' in encrypted) {
    return {
      kind: 'encrypted_upload_v2_repair_window',
      missingSequences: numbers(record(encrypted.RepairWindow).missing_sequences),
    }
  }
  if ('SaveCheckpoint' in encrypted) {
    return {
      kind: 'encrypted_upload_v2_save_checkpoint',
      checkpoint: normalizeEncryptedCheckpoint(record(encrypted.SaveCheckpoint).checkpoint),
    }
  }
  if ('AcknowledgeWindow' in encrypted) {
    return {
      kind: 'encrypted_upload_v2_acknowledge_window',
      checkpoint: normalizeEncryptedCheckpoint(record(encrypted.AcknowledgeWindow).checkpoint),
    }
  }
  if ('StageArtifacts' in encrypted) {
    const stage = record(encrypted.StageArtifacts)
    return {
      kind: 'encrypted_upload_v2_stage_artifacts',
      sinkId: string(stage.sink_id),
      materialId: string(stage.material_id),
      evidence: normalizeEncryptedEvidence(stage.evidence),
    }
  }
  if ('AwaitCompletionReceipt' in encrypted) {
    const awaitReceipt = record(encrypted.AwaitCompletionReceipt)
    return {
      kind: 'encrypted_upload_v2_await_completion_receipt',
      materialId: string(awaitReceipt.material_id),
      evidence: normalizeEncryptedEvidence(awaitReceipt.evidence),
    }
  }
  if ('ConfirmWithReceipt' in encrypted) {
    const confirm = record(encrypted.ConfirmWithReceipt)
    return {
      kind: 'encrypted_upload_v2_confirm_with_receipt',
      materialId: string(confirm.material_id),
      receiptSha256: bytes(confirm.receipt_sha256, 32),
    }
  }
  if ('AbortV2' in encrypted) {
    return {
      kind: 'encrypted_upload_v2_abort',
      materialId: string(record(encrypted.AbortV2).material_id),
    }
  }
  throw internalBridgeError()
}

function normalizeNotification(value: unknown): CoreNotification {
  const notification = record(value)
  if ('Started' in notification) {
    return {
      kind: 'started',
      operation: normalizeOperation(record(notification.Started).operation),
    }
  }
  if ('ConnectionEstablished' in notification) {
    const established = record(notification.ConnectionEstablished)
    return {
      kind: 'connection_established',
      serialNumber: string(established.device),
      candidate: normalizeCandidate(established.candidate),
      mode: enumValue(established.mode, { Manual: 'manual', Reconnect: 'reconnect' }),
    }
  }
  if ('Progress' in notification) {
    const progress = record(notification.Progress)
    return {
      kind: 'progress',
      operation: normalizeOperation(progress.operation),
      completedUnits: bigint(progress.completed_units),
      totalUnits: bigint(progress.total_units),
    }
  }
  if ('Retrying' in notification) {
    const retrying = record(notification.Retrying)
    return {
      kind: 'retrying',
      operation: normalizeOperation(retrying.operation),
      attempt: number(retrying.attempt),
    }
  }
  if ('FirmwareProgress' in notification) {
    const progress = record(record(notification.FirmwareProgress).progress)
    return {
      kind: 'firmware_progress',
      phase: enumValue(progress.phase, {
        Downloading: 'downloading',
        AwaitingDevice: 'awaiting_device',
        Transferring: 'transferring',
        Verifying: 'verifying',
        Rebooting: 'rebooting',
        Reconnecting: 'reconnecting',
        Complete: 'complete',
      }),
      completedBytes: bigint(progress.completed_bytes),
      totalBytes: bigint(progress.total_bytes),
    }
  }
  if ('DeviceLog' in notification) {
    const event = record(record(notification.DeviceLog).event)
    return {
      kind: 'device_log',
      message: string(event.message),
      isBacklog: boolean(event.is_backlog),
    }
  }
  if ('RecordingTransferCompleted' in notification) {
    const completed = record(notification.RecordingTransferCompleted)
    return {
      kind: 'recording_transfer_completed',
      encrypted: boolean(completed.encrypted),
      sha256: optionalBytes(completed.sha256, 32),
    }
  }
  if ('EncryptedUploadV2Staged' in notification) {
    const staged = record(notification.EncryptedUploadV2Staged)
    return {
      kind: 'encrypted_upload_v2_staged',
      uploadSessionId: bytes(staged.upload_session_uuid, 16),
      ownerRevision: number(staged.owner_revision),
      ciphertextLength: bigint(staged.ciphertext_length),
      ciphertextSha256: bytes(staged.ciphertext_sha256, 32),
      manifestLength: number(staged.manifest_length),
      manifestSha256: bytes(staged.manifest_sha256, 32),
    }
  }
  if ('Completed' in notification) {
    return {
      kind: 'completed',
      operation: normalizeOperation(record(notification.Completed).operation),
    }
  }
  if ('Cancelled' in notification) {
    return {
      kind: 'cancelled',
      operation: normalizeOperation(record(notification.Cancelled).operation),
    }
  }
  if ('Failed' in notification) {
    return {
      kind: 'failed',
      error: record(notification.Failed).error,
    }
  }
  throw internalBridgeError()
}

function rawHostEvent(event: CoreHostEvent): UnknownRecord {
  const request_id = event.requestId
  switch (event.kind) {
    case 'ble_scan_result':
      return { request_id, kind: { Ble: { ScanResult: { candidate: rawCandidate(event.candidate) } } } }
    case 'ble_scan_stopped':
      return { request_id, kind: { Ble: 'ScanStopped' } }
    case 'ble_connected':
      return { request_id, kind: { Ble: { Connected: { peripheral_id: event.peripheralId } } } }
    case 'ble_services_discovered':
      return { request_id, kind: { Ble: { ServicesDiscovered: { peripheral_id: event.peripheralId } } } }
    case 'ble_subscribed':
      return { request_id, kind: { Ble: { Subscribed: { characteristic_uuid: event.characteristicUuid } } } }
    case 'ble_disconnected':
      return {
        request_id,
        kind: { Ble: { Disconnected: {
          peripheral_id: event.peripheralId,
          reason_code: event.reasonCode ?? undefined,
        } } },
      }
    case 'ble_read_completed':
      return { request_id, kind: { Ble: { ReadCompleted: { value: rawBytes(event.value) } } } }
    case 'ble_write_completed':
      return { request_id, kind: { Ble: 'WriteCompleted' } }
    case 'ble_notification':
      return { request_id, kind: { Ble: { Notification: {
        characteristic_uuid: event.characteristicUuid,
        value: rawBytes(event.value),
      } } } }
    case 'ble_failed':
      return { request_id, kind: { Ble: { Failed: { platform_code: event.platformCode ?? undefined } } } }
    case 'timer_fired':
      return { request_id, kind: { TimerFired: { timer_id: event.timerId } } }
    case 'checkpoint_loaded':
      return { request_id, kind: { CheckpointLoaded: {
        checkpoint: event.checkpoint ? rawWorkflowCheckpoint(event.checkpoint) : undefined,
      } } }
    case 'checkpoint_saved':
      return { request_id, kind: 'CheckpointSaved' }
    case 'connection_identity_saved':
      return { request_id, kind: 'ConnectionIdentitySaved' }
    case 'persistence_failed':
      return { request_id, kind: { PersistenceFailed: {
        platform_code: event.platformCode ?? undefined,
      } } }
    case 'provisioning_material_prepared':
      return { request_id, kind: { ProvisioningMaterialPrepared: { material: {
        api_endpoint: rawBytes(event.apiEndpoint),
        device_token: rawBytes(event.deviceToken),
        mtu: event.mtu,
      } } } }
    case 'host_material_failed':
      return { request_id, kind: { HostMaterialFailed: {
        platform_code: event.platformCode ?? undefined,
      } } }
    case 'recording_sink_truncated':
      return { request_id, kind: 'RecordingSinkTruncated' }
    case 'recording_sink_append_completed':
      return { request_id, kind: { RecordingSinkAppendCompleted: {
        durable_units: event.durableUnits,
      } } }
    case 'recording_sink_finalized':
      return { request_id, kind: { RecordingSinkFinalized: {
        durable_units: event.durableUnits,
      } } }
    case 'recording_sink_integrity_failed':
      return { request_id, kind: 'RecordingSinkIntegrityFailed' }
    case 'recording_sink_failed':
      return { request_id, kind: { RecordingSinkFailed: {
        platform_code: event.platformCode ?? undefined,
      } } }
    case 'firmware_chunk_read':
      return { request_id, kind: { FirmwareChunkRead: {
        download_id: event.downloadId,
        offset: event.offset,
        bytes: rawBytes(event.bytes),
      } } }
    case 'firmware_blob_failed':
      return { request_id, kind: { FirmwareBlobFailed: {
        platform_code: event.platformCode ?? undefined,
      } } }
    case 'network_download_progress':
      return { request_id, kind: { Network: { DownloadProgress: {
        download_id: event.downloadId,
        completed_bytes: event.completedBytes,
        total_bytes: event.totalBytes ?? undefined,
      } } } }
    case 'network_download_completed':
      return { request_id, kind: { Network: { DownloadCompleted: {
        download_id: event.downloadId,
        crc32: event.crc32,
      } } } }
    case 'network_failed':
      return { request_id, kind: { Network: { Failed: {
        transfer_id: event.transferId,
        status_code: event.statusCode ?? undefined,
      } } } }
    case 'encrypted_upload_v2_checkpoint_loaded':
      return { request_id, kind: { EncryptedUploadV2: {
        CheckpointLoaded: event.checkpoint ? rawEncryptedCheckpoint(event.checkpoint) : null,
      } } }
    case 'encrypted_upload_v2_sink_truncated':
      return { request_id, kind: { EncryptedUploadV2: 'SinkTruncated' } }
    case 'encrypted_upload_v2_session_prepared':
      return { request_id, kind: { EncryptedUploadV2: { SessionPrepared: {
        authorization_sha256: rawBytes(event.authorizationSha256),
      } } } }
    case 'encrypted_upload_v2_transfer_started':
      return { request_id, kind: { EncryptedUploadV2: 'TransferStarted' } }
    case 'encrypted_upload_v2_resume_rejected':
      return { request_id, kind: { EncryptedUploadV2: 'ResumeRejected' } }
    case 'encrypted_upload_v2_window_staged':
      return { request_id, kind: { EncryptedUploadV2: { WindowStaged: {
        checkpoint: rawEncryptedCheckpoint(event.checkpoint),
        missing_sequences: event.missingSequences,
      } } } }
    case 'encrypted_upload_v2_checkpoint_saved':
      return { request_id, kind: { EncryptedUploadV2: 'CheckpointSaved' } }
    case 'encrypted_upload_v2_window_acknowledged':
      return { request_id, kind: { EncryptedUploadV2: { WindowAcknowledged: {
        checkpoint: rawEncryptedCheckpoint(event.checkpoint),
      } } } }
    case 'encrypted_upload_v2_transfer_completed':
      return { request_id, kind: { EncryptedUploadV2: {
        TransferCompleted: rawEncryptedEvidence(event.evidence),
      } } }
    case 'encrypted_upload_v2_artifacts_staged':
      return { request_id, kind: { EncryptedUploadV2: 'ArtifactsStaged' } }
    case 'encrypted_upload_v2_completion_receipt_accepted':
      return { request_id, kind: { EncryptedUploadV2: { CompletionReceiptAccepted: {
        receipt_sha256: rawBytes(event.receiptSha256),
      } } } }
    case 'encrypted_upload_v2_recording_confirmed':
      return { request_id, kind: { EncryptedUploadV2: 'RecordingConfirmed' } }
    case 'encrypted_upload_v2_mixed_profile':
      return { request_id, kind: { EncryptedUploadV2: 'MixedProfile' } }
    case 'encrypted_upload_v2_failed':
      return { request_id, kind: { EncryptedUploadV2: { Failed: { error: event.error } } } }
    default:
      throw internalBridgeError()
  }
}

function normalizeStatus(value: unknown): CoreWorkflowStatus {
  if (value === 'Idle') return { kind: 'idle' }
  const status = record(value)
  if ('Running' in status) {
    const running = record(status.Running)
    return {
      kind: 'running',
      operation: normalizeOperation(running.operation),
      cancellationId: bytes(running.cancellation_id, 16),
    }
  }
  if ('Completed' in status) {
    return {
      kind: 'completed',
      operation: normalizeOperation(record(status.Completed).operation),
    }
  }
  if ('Cancelled' in status) {
    return {
      kind: 'cancelled',
      operation: normalizeOperation(record(status.Cancelled).operation),
    }
  }
  if ('Failed' in status) return { kind: 'failed', error: record(status.Failed).error }
  throw internalBridgeError()
}

function normalizeCandidate(value: unknown): CoreDeviceCandidate {
  const candidate = record(value)
  return {
    peripheralId: string(candidate.peripheral_id),
    name: optionalString(candidate.name),
    advertisedAddress: optionalString(candidate.advertised_address),
    rssi: number(candidate.rssi),
  }
}

function rawCandidate(candidate: CoreDeviceCandidate): UnknownRecord {
  return {
    peripheral_id: candidate.peripheralId,
    name: candidate.name ?? undefined,
    advertised_address: candidate.advertisedAddress ?? undefined,
    rssi: candidate.rssi,
  }
}

function normalizeWorkflowCheckpoint(value: unknown): CoreWorkflowCheckpoint {
  const checkpoint = record(value)
  return {
    workflow: normalizeWorkflowKind(checkpoint.workflow),
    operation: normalizeOperation(checkpoint.operation),
    serialNumber: string(checkpoint.device),
    recordingUuid: optionalBytes(checkpoint.recording, 16),
    phase: normalizeCheckpointPhase(checkpoint.phase),
    completedUnits: bigint(checkpoint.completed_units),
    retryCount: number(checkpoint.retry_count),
    lastSequence: optionalNumber(checkpoint.last_sequence),
    firmwareVersion: optionalString(checkpoint.firmware_version),
  }
}

function rawWorkflowCheckpoint(checkpoint: CoreWorkflowCheckpoint): UnknownRecord {
  return {
    workflow: rawWorkflowKind(checkpoint.workflow),
    operation: rawOperation(checkpoint.operation),
    device: checkpoint.serialNumber,
    recording: checkpoint.recordingUuid ? rawBytes(checkpoint.recordingUuid) : undefined,
    phase: rawCheckpointPhase(checkpoint.phase),
    completed_units: checkpoint.completedUnits,
    retry_count: checkpoint.retryCount,
    last_sequence: checkpoint.lastSequence ?? undefined,
    firmware_version: checkpoint.firmwareVersion ?? undefined,
  }
}

function normalizeEncryptedCheckpoint(value: unknown): CoreEncryptedUploadV2Checkpoint {
  const checkpoint = record(value)
  return {
    serialNumber: string(checkpoint.device),
    recordingUuid: bytes(checkpoint.recording, 16),
    recordingGeneration: number(checkpoint.recording_generation),
    uploadSessionId: bytes(checkpoint.upload_session_uuid, 16),
    ownerRevision: number(checkpoint.owner_revision),
    transportSessionId: bigint(checkpoint.transport_session_id),
    checkpointRevision: number(checkpoint.checkpoint_revision),
    nextCiphertextOffset: bigint(checkpoint.next_ciphertext_offset),
    prefixSha256: bytes(checkpoint.prefix_sha256, 32),
    windowPackets: number(checkpoint.window_packets),
    dataPayloadBytes: number(checkpoint.data_payload_bytes),
  }
}

function optionalEncryptedCheckpoint(value: unknown): CoreEncryptedUploadV2Checkpoint | null {
  return value === undefined || value === null ? null : normalizeEncryptedCheckpoint(value)
}

function rawEncryptedCheckpoint(checkpoint: CoreEncryptedUploadV2Checkpoint): UnknownRecord {
  return {
    device: checkpoint.serialNumber,
    recording: rawBytes(checkpoint.recordingUuid),
    recording_generation: checkpoint.recordingGeneration,
    upload_session_uuid: rawBytes(checkpoint.uploadSessionId),
    owner_revision: checkpoint.ownerRevision,
    transport_session_id: checkpoint.transportSessionId,
    checkpoint_revision: checkpoint.checkpointRevision,
    next_ciphertext_offset: checkpoint.nextCiphertextOffset,
    prefix_sha256: rawBytes(checkpoint.prefixSha256),
    window_packets: checkpoint.windowPackets,
    data_payload_bytes: checkpoint.dataPayloadBytes,
  }
}

function normalizeEncryptedEvidence(value: unknown): CoreEncryptedUploadV2Evidence {
  const evidence = record(value)
  return {
    ciphertextLength: bigint(evidence.ciphertext_length),
    ciphertextSha256: bytes(evidence.ciphertext_sha256, 32),
    manifestLength: number(evidence.manifest_length),
    manifestSha256: bytes(evidence.manifest_sha256, 32),
    blockCount: number(evidence.block_count),
  }
}

function rawEncryptedEvidence(evidence: CoreEncryptedUploadV2Evidence): UnknownRecord {
  return {
    ciphertext_length: evidence.ciphertextLength,
    ciphertext_sha256: rawBytes(evidence.ciphertextSha256),
    manifest_length: evidence.manifestLength,
    manifest_sha256: rawBytes(evidence.manifestSha256),
    block_count: evidence.blockCount,
  }
}

function normalizeOperation(value: unknown): CoreOperation {
  return enumValue(value, {
    Validate: 'validate',
    Decode: 'decode',
    Encode: 'encode',
    Discover: 'discover',
    Connect: 'connect',
    Reconnect: 'reconnect',
    Provision: 'provision',
    TransferRecording: 'transfer_recording',
    Upload: 'upload',
    UpdateFirmware: 'update_firmware',
    ReadDeviceLogs: 'read_device_logs',
    FactoryReset: 'factory_reset',
    Unknown: 'unknown',
  })
}

function rawOperation(operation: CoreOperation): string {
  return reverseEnumValue(operation, {
    Validate: 'validate',
    Decode: 'decode',
    Encode: 'encode',
    Discover: 'discover',
    Connect: 'connect',
    Reconnect: 'reconnect',
    Provision: 'provision',
    TransferRecording: 'transfer_recording',
    Upload: 'upload',
    UpdateFirmware: 'update_firmware',
    ReadDeviceLogs: 'read_device_logs',
    FactoryReset: 'factory_reset',
    Unknown: 'unknown',
  })
}

function normalizeWorkflowKind(value: unknown): CoreWorkflowKind {
  return enumValue(value, {
    Discovery: 'discovery',
    Connection: 'connection',
    Provisioning: 'provisioning',
    RecordingTransfer: 'recording_transfer',
    RecordingUpload: 'recording_upload',
    FirmwareUpdate: 'firmware_update',
    DeviceLogs: 'device_logs',
    FactoryReset: 'factory_reset',
  })
}

function rawWorkflowKind(value: CoreWorkflowKind): string {
  return reverseEnumValue(value, {
    Discovery: 'discovery',
    Connection: 'connection',
    Provisioning: 'provisioning',
    RecordingTransfer: 'recording_transfer',
    RecordingUpload: 'recording_upload',
    FirmwareUpdate: 'firmware_update',
    DeviceLogs: 'device_logs',
    FactoryReset: 'factory_reset',
  })
}

function normalizeCheckpointPhase(value: unknown): CoreCheckpointPhase {
  return enumValue(value, {
    Pending: 'pending',
    Connecting: 'connecting',
    Transferring: 'transferring',
    Uploading: 'uploading',
    Verifying: 'verifying',
    Reconnecting: 'reconnecting',
    AwaitingReceipt: 'awaiting_receipt',
  })
}

function rawCheckpointPhase(value: CoreCheckpointPhase): string {
  return reverseEnumValue(value, {
    Pending: 'pending',
    Connecting: 'connecting',
    Transferring: 'transferring',
    Uploading: 'uploading',
    Verifying: 'verifying',
    Reconnecting: 'reconnecting',
    AwaitingReceipt: 'awaiting_receipt',
  })
}

function normalizeUploadPolicy(value: unknown): CoreEncryptedUploadV2Input['policy'] {
  return enumValue(value, {
    LegacyAllowed: 'legacy_allowed',
    V2Preferred: 'v2_preferred',
    V2Required: 'v2_required',
  })
}

function normalizeDeviceStatus(value: unknown): DeviceStatus {
  const status = record(value)
  const flags = record(status.flags)
  return {
    batteryPercent: number(status.battery_percent),
    batteryMillivolts: optionalNumber(status.battery_mv),
    storageTotalMb: number(status.storage_total_mb),
    storageUsedMb: number(status.storage_used_mb),
    ...normalizeDeviceState(status.state),
    pendingRecordings: number(status.pending_recordings),
    lastTimeSyncTimestamp: number(status.last_time_sync_timestamp),
    flags: {
      charging: boolean(flags.charging),
      lowBattery: boolean(flags.low_battery),
      storageFull: boolean(flags.storage_full),
      wifiConnected: boolean(flags.wifi_connected),
      lteConnected: boolean(flags.lte_connected),
      syncActive: boolean(flags.sync_active),
    },
    lteStatusRaw: number(status.lte_status_raw),
    lteSignalQuality: optionalNumber(status.lte_signal_quality),
    wifiStatusRaw: optionalNumber(status.wifi_status_raw),
    modemInfo: normalizeModemInfo(status.modem_info),
  }
}

function normalizeDeviceState(value: unknown): { state: DeviceState; stateRaw?: number } {
  if (typeof value === 'string') {
    const known: Record<string, DeviceState> = {
      Idle: 'idle',
      Recording: 'recording',
      Syncing: 'syncing',
      Uploading: 'uploading',
      Charging: 'charging',
      LowBattery: 'low_battery',
      StorageFull: 'storage_full',
      Error: 'error',
    }
    return { state: known[value] ?? 'unknown' }
  }
  return { state: 'unknown', stateRaw: number(record(value).Unknown) }
}

function normalizeModemInfo(value: unknown): ModemInfo | null {
  if (value === undefined || value === null) return null
  const modem = record(value)
  return {
    imei: optionalString(modem.imei),
    iccid: optionalString(modem.iccid),
    operator: optionalString(modem.operator),
    rat: optionalString(modem.rat),
    band: optionalString(modem.band),
    apn: optionalString(modem.apn),
    simStatus: optionalString(modem.sim_status),
    csq: optionalNumber(modem.csq),
    ipAddress: optionalString(modem.ip_address),
    voltageMillivolts: optionalNumber(modem.voltage_mv),
    firmware: optionalString(modem.firmware),
    roaming: optionalBoolean(modem.roaming),
  }
}

function normalizeCapabilities(value: unknown): EncryptedUploadV2Capabilities {
  const capabilities = record(value)
  return {
    flags: number(capabilities.flags),
    maximumSignedBlobBytes: number(capabilities.maximum_signed_blob_bytes),
    maximumManifestBytes: number(capabilities.maximum_manifest_bytes),
    maximumDataPayloadBytes: number(capabilities.maximum_data_payload_bytes),
    maximumWindowPackets: number(capabilities.maximum_window_packets),
    durableCheckpointIntervalBlocks: number(capabilities.durable_checkpoint_interval_blocks),
    maximumMissingSequences: number(capabilities.maximum_missing_sequences),
  }
}

function record(value: unknown): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw internalBridgeError()
  }
  return value as UnknownRecord
}

function string(value: unknown): string {
  if (typeof value !== 'string') throw internalBridgeError()
  return value
}

function optionalString(value: unknown): string | null {
  return value === undefined || value === null ? null : string(value)
}

function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw internalBridgeError()
  return value
}

function optionalNumber(value: unknown): number | null {
  return value === undefined || value === null ? null : number(value)
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw internalBridgeError()
  return value
}

function optionalBoolean(value: unknown): boolean | null {
  return value === undefined || value === null ? null : boolean(value)
}

function bigint(value: unknown): bigint {
  if (typeof value !== 'bigint') throw internalBridgeError()
  return value
}

function bytes(value: unknown, expectedLength?: number): Uint8Array {
  const result = value instanceof Uint8Array
    ? new Uint8Array(value)
    : Array.isArray(value)
      ? Uint8Array.from(value.map(byte))
      : null
  if (!result || (expectedLength !== undefined && result.length !== expectedLength)) {
    throw internalBridgeError()
  }
  return result
}

function optionalBytes(value: unknown, expectedLength?: number): Uint8Array | null {
  return value === undefined || value === null ? null : bytes(value, expectedLength)
}

function byte(value: unknown): number {
  const result = number(value)
  if (result < 0 || result > 255) throw internalBridgeError()
  return result
}

function numbers(value: unknown): number[] {
  if (!Array.isArray(value)) throw internalBridgeError()
  return value.map(number)
}

function rawBytes(value: Uint8Array): number[] {
  return [...value]
}

function enumValue<T extends string>(value: unknown, values: Record<string, T>): T {
  const key = string(value)
  const result = values[key]
  if (!result) throw internalBridgeError()
  return result
}

function reverseEnumValue<T extends string>(value: T, values: Record<string, T>): string {
  const entry = Object.entries(values).find(([, normalized]) => normalized === value)
  if (!entry) throw internalBridgeError()
  return entry[0]
}

function internalBridgeError(): BotaSDKError {
  return new BotaSDKError('internal_error', 'unknown')
}
