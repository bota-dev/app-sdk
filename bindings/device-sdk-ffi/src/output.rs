use crate::{BotaDeviceSdkPacketV1, error, field_id, packet_kind};
use bota_device_sdk_core::{
    engine::{
        BleEffect, Effect, EffectRequest, FirmwareBlobEffect, HostMaterialEffect, NetworkEffect,
        PersistenceEffect, ProgressEffect, RecordingSinkEffect, SecureStorageEffect, TimerEffect,
        UploadSource, WorkflowCheckpoint, WorkflowKind, WorkflowNotification,
    },
    error::{DeviceSdkError, ErrorCode, Operation},
    model::{
        ConnectionMode, DeviceCandidate, DeviceSerialNumber, FirmwareUpdatePhase, RecordingUuid,
    },
};

pub(crate) fn packet_from_effect_request(
    request: EffectRequest,
) -> Result<BotaDeviceSdkPacketV1, DeviceSdkError> {
    let cancellation = request.cancellation_id.as_bytes();
    let high = u64::from_be_bytes(cancellation[..8].try_into().expect("fixed cancellation ID"));
    let low = u64::from_be_bytes(cancellation[8..].try_into().expect("fixed cancellation ID"));
    let packet = BotaDeviceSdkPacketV1::new(kind(&request.effect))
        .with_operation(error::operation_code(request.operation))
        .with_request_id(request.request_id.as_u64())
        .with_cancellation_id(high, low);

    match request.effect {
        Effect::Timer(effect) => Ok(timer(packet, effect)),
        Effect::Persistence(effect) => persistence(packet, effect),
        Effect::SecureStorage(effect) => Ok(secure_storage(packet, effect)),
        Effect::Ble(effect) => Ok(ble(packet, effect)),
        Effect::Network(effect) => Ok(network(packet, effect)),
        Effect::Progress(effect) => Ok(progress(packet, effect)),
        Effect::Notify(value) => Ok(notification(packet, value)),
        Effect::HostMaterial(effect) => Ok(host_material(packet, effect)),
        Effect::RecordingSink(effect) => Ok(recording_sink(packet, effect)),
        Effect::FirmwareBlob(effect) => Ok(firmware_blob(packet, effect)),
    }
}

fn kind(effect: &Effect) -> u32 {
    match effect {
        Effect::Timer(TimerEffect::Schedule { .. }) => packet_kind::HOST_EFFECT_TIMER_SCHEDULE,
        Effect::Timer(TimerEffect::Cancel { .. }) => packet_kind::HOST_EFFECT_TIMER_CANCEL,
        Effect::Persistence(PersistenceEffect::LoadCheckpoint) => {
            packet_kind::HOST_EFFECT_PERSISTENCE_LOAD_CHECKPOINT
        }
        Effect::Persistence(PersistenceEffect::SaveCheckpoint { .. }) => {
            packet_kind::HOST_EFFECT_PERSISTENCE_SAVE_CHECKPOINT
        }
        Effect::Persistence(PersistenceEffect::DeleteCheckpoint) => {
            packet_kind::HOST_EFFECT_PERSISTENCE_DELETE_CHECKPOINT
        }
        Effect::Persistence(PersistenceEffect::SaveConnectionIdentity { .. }) => {
            packet_kind::HOST_EFFECT_PERSISTENCE_SAVE_CONNECTION_IDENTITY
        }
        Effect::Persistence(PersistenceEffect::SaveFactoryResetResult { .. }) => {
            packet_kind::HOST_EFFECT_PERSISTENCE_SAVE_FACTORY_RESET_RESULT
        }
        Effect::Persistence(PersistenceEffect::DeleteFactoryResetResult { .. }) => {
            packet_kind::HOST_EFFECT_PERSISTENCE_DELETE_FACTORY_RESET_RESULT
        }
        Effect::SecureStorage(SecureStorageEffect::Read { .. }) => {
            packet_kind::HOST_EFFECT_SECURE_STORAGE_READ
        }
        Effect::SecureStorage(SecureStorageEffect::Write { .. }) => {
            packet_kind::HOST_EFFECT_SECURE_STORAGE_WRITE
        }
        Effect::SecureStorage(SecureStorageEffect::Delete { .. }) => {
            packet_kind::HOST_EFFECT_SECURE_STORAGE_DELETE
        }
        Effect::Ble(BleEffect::StartScan { .. }) => packet_kind::HOST_EFFECT_BLE_START_SCAN,
        Effect::Ble(BleEffect::StopScan) => packet_kind::HOST_EFFECT_BLE_STOP_SCAN,
        Effect::Ble(BleEffect::Connect { .. }) => packet_kind::HOST_EFFECT_BLE_CONNECT,
        Effect::Ble(BleEffect::DiscoverServices { .. }) => {
            packet_kind::HOST_EFFECT_BLE_DISCOVER_SERVICES
        }
        Effect::Ble(BleEffect::Disconnect { .. }) => packet_kind::HOST_EFFECT_BLE_DISCONNECT,
        Effect::Ble(BleEffect::Read { .. }) => packet_kind::HOST_EFFECT_BLE_READ,
        Effect::Ble(BleEffect::Write { .. }) => packet_kind::HOST_EFFECT_BLE_WRITE,
        Effect::Ble(BleEffect::Subscribe { .. }) => packet_kind::HOST_EFFECT_BLE_SUBSCRIBE,
        Effect::Ble(BleEffect::Unsubscribe { .. }) => packet_kind::HOST_EFFECT_BLE_UNSUBSCRIBE,
        Effect::Network(NetworkEffect::Download { .. }) => {
            packet_kind::HOST_EFFECT_NETWORK_DOWNLOAD
        }
        Effect::Network(NetworkEffect::Upload { .. }) => packet_kind::HOST_EFFECT_NETWORK_UPLOAD,
        Effect::Progress(_) => packet_kind::HOST_EFFECT_PROGRESS,
        Effect::Notify(notification) => notification_kind(notification),
        Effect::HostMaterial(HostMaterialEffect::PrepareProvisioning { .. }) => {
            packet_kind::HOST_EFFECT_PREPARE_PROVISIONING
        }
        Effect::HostMaterial(HostMaterialEffect::PrepareFactoryResetGrant { .. }) => {
            packet_kind::HOST_EFFECT_PREPARE_FACTORY_RESET_GRANT
        }
        Effect::RecordingSink(RecordingSinkEffect::Truncate { .. }) => {
            packet_kind::HOST_EFFECT_RECORDING_SINK_TRUNCATE
        }
        Effect::RecordingSink(RecordingSinkEffect::Append { .. }) => {
            packet_kind::HOST_EFFECT_RECORDING_SINK_APPEND
        }
        Effect::RecordingSink(RecordingSinkEffect::Finalize { .. }) => {
            packet_kind::HOST_EFFECT_RECORDING_SINK_FINALIZE
        }
        Effect::RecordingSink(RecordingSinkEffect::Discard { .. }) => {
            packet_kind::HOST_EFFECT_RECORDING_SINK_DISCARD
        }
        Effect::RecordingSink(RecordingSinkEffect::AppendStreamingPlaintext { .. }) => {
            packet_kind::HOST_EFFECT_STREAMING_SINK_APPEND_PLAINTEXT
        }
        Effect::RecordingSink(RecordingSinkEffect::BeginStreamingEncrypted { .. }) => {
            packet_kind::HOST_EFFECT_STREAMING_SINK_BEGIN_ENCRYPTED
        }
        Effect::RecordingSink(RecordingSinkEffect::AppendStreamingEncrypted { .. }) => {
            packet_kind::HOST_EFFECT_STREAMING_SINK_APPEND_ENCRYPTED
        }
        Effect::RecordingSink(RecordingSinkEffect::FinalizeStreaming { .. }) => {
            packet_kind::HOST_EFFECT_STREAMING_SINK_FINALIZE
        }
        Effect::RecordingSink(RecordingSinkEffect::DiscardStreaming { .. }) => {
            packet_kind::HOST_EFFECT_STREAMING_SINK_DISCARD
        }
        Effect::FirmwareBlob(_) => packet_kind::HOST_EFFECT_FIRMWARE_BLOB_READ,
    }
}

fn timer(packet: BotaDeviceSdkPacketV1, effect: TimerEffect) -> BotaDeviceSdkPacketV1 {
    match effect {
        TimerEffect::Schedule { timer_id, delay_ms } => packet
            .with_u64(field_id::TIMER_ID, timer_id)
            .with_u64(field_id::DELAY_MS, delay_ms),
        TimerEffect::Cancel { timer_id } => packet.with_u64(field_id::TIMER_ID, timer_id),
    }
}

fn persistence(
    packet: BotaDeviceSdkPacketV1,
    effect: PersistenceEffect,
) -> Result<BotaDeviceSdkPacketV1, DeviceSdkError> {
    match effect {
        PersistenceEffect::LoadCheckpoint | PersistenceEffect::DeleteCheckpoint => Ok(packet),
        PersistenceEffect::SaveCheckpoint { checkpoint } => {
            Ok(packet.with_bytes(field_id::CHECKPOINT, encode_checkpoint(&checkpoint)?))
        }
        PersistenceEffect::SaveConnectionIdentity { device, candidate } => Ok(candidate_fields(
            packet.with_text(field_id::SERIAL_NUMBER, device.as_str()),
            candidate,
        )),
        PersistenceEffect::SaveFactoryResetResult { result } => Ok(packet
            .with_text(field_id::COMMAND_ID, result.command_id.as_str())
            .with_u64(field_id::RESULT_CODE, u64::from(result.result.result_code))
            .with_u64(
                field_id::DELETED_RECORDING_COUNT,
                u64::from(result.result.deleted_recording_count),
            )),
        PersistenceEffect::DeleteFactoryResetResult { command_id } => {
            Ok(packet.with_text(field_id::COMMAND_ID, command_id.as_str()))
        }
    }
}

fn secure_storage(
    packet: BotaDeviceSdkPacketV1,
    effect: SecureStorageEffect,
) -> BotaDeviceSdkPacketV1 {
    match effect {
        SecureStorageEffect::Read { key } | SecureStorageEffect::Delete { key } => {
            packet.with_text(field_id::KEY, key)
        }
        SecureStorageEffect::Write { key, value } => packet
            .with_text(field_id::KEY, key)
            .with_bytes(field_id::VALUE, value),
    }
}

fn ble(packet: BotaDeviceSdkPacketV1, effect: BleEffect) -> BotaDeviceSdkPacketV1 {
    match effect {
        BleEffect::StartScan { allow_duplicates } => {
            packet.with_bool(field_id::ALLOW_DUPLICATES, allow_duplicates)
        }
        BleEffect::StopScan => packet,
        BleEffect::Connect { peripheral_id }
        | BleEffect::DiscoverServices { peripheral_id }
        | BleEffect::Disconnect { peripheral_id } => {
            packet.with_text(field_id::PERIPHERAL_ID, peripheral_id)
        }
        BleEffect::Read {
            service_uuid,
            characteristic_uuid,
        }
        | BleEffect::Subscribe {
            service_uuid,
            characteristic_uuid,
        }
        | BleEffect::Unsubscribe {
            service_uuid,
            characteristic_uuid,
        } => packet
            .with_text(field_id::SERVICE_UUID, service_uuid)
            .with_text(field_id::CHARACTERISTIC_UUID, characteristic_uuid),
        BleEffect::Write {
            service_uuid,
            characteristic_uuid,
            payload,
            with_response,
        } => packet
            .with_text(field_id::SERVICE_UUID, service_uuid)
            .with_text(field_id::CHARACTERISTIC_UUID, characteristic_uuid)
            .with_bytes(field_id::PAYLOAD, payload)
            .with_bool(field_id::WITH_RESPONSE, with_response),
    }
}

fn network(packet: BotaDeviceSdkPacketV1, effect: NetworkEffect) -> BotaDeviceSdkPacketV1 {
    match effect {
        NetworkEffect::Download { download_id } => {
            packet.with_u64(field_id::DOWNLOAD_ID, download_id)
        }
        NetworkEffect::Upload { upload_id, source } => packet
            .with_u64(field_id::UPLOAD_ID, upload_id)
            .with_u64(field_id::UPLOAD_SOURCE, upload_source(source)),
    }
}

fn progress(packet: BotaDeviceSdkPacketV1, effect: ProgressEffect) -> BotaDeviceSdkPacketV1 {
    packet
        .with_u64(field_id::COMPLETED_UNITS, effect.completed_units)
        .with_u64(field_id::TOTAL_UNITS, effect.total_units)
}

fn host_material(
    packet: BotaDeviceSdkPacketV1,
    effect: HostMaterialEffect,
) -> BotaDeviceSdkPacketV1 {
    match effect {
        HostMaterialEffect::PrepareProvisioning {
            material_id,
            device,
            nonce,
            device_public_key,
        } => packet
            .with_text(field_id::MATERIAL_ID, material_id.as_str())
            .with_text(field_id::SERIAL_NUMBER, device.as_str())
            .with_bytes(field_id::NONCE, nonce.0.to_vec())
            .with_bytes(field_id::DEVICE_PUBLIC_KEY, device_public_key.0),
        HostMaterialEffect::PrepareFactoryResetGrant {
            grant_id,
            device,
            nonce,
        } => packet
            .with_text(field_id::GRANT_ID, grant_id.as_str())
            .with_text(field_id::SERIAL_NUMBER, device.as_str())
            .with_bytes(field_id::NONCE, nonce.0.to_vec()),
    }
}

fn recording_sink(
    packet: BotaDeviceSdkPacketV1,
    effect: RecordingSinkEffect,
) -> BotaDeviceSdkPacketV1 {
    match effect {
        RecordingSinkEffect::Truncate {
            sink_id,
            completed_units,
        } => packet
            .with_text(field_id::SINK_ID, sink_id.as_str())
            .with_u64(field_id::COMPLETED_UNITS, completed_units),
        RecordingSinkEffect::Append {
            sink_id,
            sequence,
            payload,
        } => packet
            .with_text(field_id::SINK_ID, sink_id.as_str())
            .with_u64(field_id::SEQUENCE, u64::from(sequence))
            .with_bytes(field_id::PAYLOAD, payload),
        RecordingSinkEffect::Finalize {
            sink_id,
            expected_crc32,
        } => {
            let packet = packet.with_text(field_id::SINK_ID, sink_id.as_str());
            match expected_crc32 {
                Some(value) => packet.with_u64(field_id::EXPECTED_CRC32, u64::from(value)),
                None => packet,
            }
        }
        RecordingSinkEffect::Discard { sink_id } => {
            packet.with_text(field_id::SINK_ID, sink_id.as_str())
        }
        RecordingSinkEffect::AppendStreamingPlaintext {
            sink_id,
            sequence,
            payload,
        } => packet
            .with_text(field_id::SINK_ID, sink_id.as_str())
            .with_u64(field_id::SEQUENCE, u64::from(sequence))
            .with_bytes(field_id::PAYLOAD, payload),
        RecordingSinkEffect::BeginStreamingEncrypted {
            sink_id,
            ephemeral_public_key,
            salt,
        } => packet
            .with_text(field_id::SINK_ID, sink_id.as_str())
            .with_bytes(field_id::EPHEMERAL_PUBLIC_KEY, ephemeral_public_key)
            .with_bytes(field_id::SALT, salt),
        RecordingSinkEffect::AppendStreamingEncrypted {
            sink_id,
            sequence,
            payload,
        } => packet
            .with_text(field_id::SINK_ID, sink_id.as_str())
            .with_u64(field_id::SEQUENCE, u64::from(sequence))
            .with_bytes(field_id::PAYLOAD, payload),
        RecordingSinkEffect::FinalizeStreaming {
            sink_id,
            encrypted,
            expected_chunks,
            total_units,
        } => packet
            .with_text(field_id::SINK_ID, sink_id.as_str())
            .with_bool(field_id::ENCRYPTED, encrypted)
            .with_u64(field_id::EXPECTED_CHUNKS, u64::from(expected_chunks))
            .with_u64(field_id::TOTAL_UNITS, total_units),
        RecordingSinkEffect::DiscardStreaming { sink_id } => {
            packet.with_text(field_id::SINK_ID, sink_id.as_str())
        }
    }
}

fn firmware_blob(
    packet: BotaDeviceSdkPacketV1,
    effect: FirmwareBlobEffect,
) -> BotaDeviceSdkPacketV1 {
    match effect {
        FirmwareBlobEffect::ReadChunk {
            download_id,
            offset,
            max_length,
        } => packet
            .with_u64(field_id::DOWNLOAD_ID, download_id)
            .with_u64(field_id::OFFSET, offset)
            .with_u64(field_id::MAX_LENGTH, u64::from(max_length)),
    }
}

fn notification_kind(notification: &WorkflowNotification) -> u32 {
    match notification {
        WorkflowNotification::Started { .. } => packet_kind::NOTIFICATION_STARTED,
        WorkflowNotification::DeviceDiscovered { .. } => {
            packet_kind::NOTIFICATION_DEVICE_DISCOVERED
        }
        WorkflowNotification::ConnectionEstablished { .. } => {
            packet_kind::NOTIFICATION_CONNECTION_ESTABLISHED
        }
        WorkflowNotification::Progress { .. } => packet_kind::NOTIFICATION_PROGRESS,
        WorkflowNotification::Retrying { .. } => packet_kind::NOTIFICATION_RETRYING,
        WorkflowNotification::DeviceUploadPreserved { .. } => {
            packet_kind::NOTIFICATION_DEVICE_UPLOAD_PRESERVED
        }
        WorkflowNotification::BleFallbackReady { .. } => {
            packet_kind::NOTIFICATION_BLE_FALLBACK_READY
        }
        WorkflowNotification::FirmwareProgress { .. } => {
            packet_kind::NOTIFICATION_FIRMWARE_PROGRESS
        }
        WorkflowNotification::DeviceLog { .. } => packet_kind::NOTIFICATION_DEVICE_LOG,
        WorkflowNotification::RecordingTransferCompleted { .. } => {
            packet_kind::NOTIFICATION_COMPLETED
        }
        WorkflowNotification::StreamingPaused { .. } => packet_kind::NOTIFICATION_STREAMING_PAUSED,
        WorkflowNotification::StreamingResumed => packet_kind::NOTIFICATION_STREAMING_RESUMED,
        WorkflowNotification::StreamingCompleted { .. } => {
            packet_kind::NOTIFICATION_STREAMING_COMPLETED
        }
        WorkflowNotification::Completed { .. } => packet_kind::NOTIFICATION_COMPLETED,
        WorkflowNotification::Cancelled { .. } => packet_kind::NOTIFICATION_CANCELLED,
        WorkflowNotification::Failed { .. } => packet_kind::NOTIFICATION_FAILED,
    }
}

fn notification(
    packet: BotaDeviceSdkPacketV1,
    notification: WorkflowNotification,
) -> BotaDeviceSdkPacketV1 {
    match notification {
        WorkflowNotification::Started { .. }
        | WorkflowNotification::Completed { .. }
        | WorkflowNotification::Cancelled { .. } => packet,
        WorkflowNotification::DeviceDiscovered { candidate } => candidate_fields(packet, candidate),
        WorkflowNotification::ConnectionEstablished {
            device,
            candidate,
            mode,
        } => candidate_fields(
            packet
                .with_text(field_id::SERIAL_NUMBER, device.as_str())
                .with_u64(field_id::CONNECTION_MODE, connection_mode(mode)),
            candidate,
        ),
        WorkflowNotification::Progress {
            completed_units,
            total_units,
            ..
        } => packet
            .with_u64(field_id::COMPLETED_UNITS, completed_units)
            .with_u64(field_id::TOTAL_UNITS, total_units),
        WorkflowNotification::Retrying { attempt, .. } => {
            packet.with_u64(field_id::ATTEMPT, u64::from(attempt))
        }
        WorkflowNotification::DeviceUploadPreserved { upload_id } => {
            packet.with_text(field_id::UPLOAD_ID, upload_id.as_str())
        }
        WorkflowNotification::BleFallbackReady {
            recording,
            upload_id,
            destination_id,
        } => packet
            .with_text(field_id::RECORDING_UUID, recording.to_string())
            .with_text(field_id::UPLOAD_ID, upload_id.as_str())
            .with_text(field_id::DESTINATION_ID, destination_id.as_str()),
        WorkflowNotification::FirmwareProgress { progress } => packet
            .with_u64(field_id::FIRMWARE_PHASE, firmware_phase(progress.phase))
            .with_u64(field_id::COMPLETED_UNITS, progress.completed_bytes)
            .with_u64(field_id::TOTAL_UNITS, progress.total_bytes),
        WorkflowNotification::DeviceLog { event } => packet
            .with_text(field_id::LOG_MESSAGE, event.message)
            .with_bool(field_id::IS_BACKLOG, event.is_backlog),
        WorkflowNotification::RecordingTransferCompleted { encrypted, sha256 } => {
            let packet = packet.with_bool(field_id::ENCRYPTED, encrypted);
            match sha256 {
                Some(value) => packet.with_bytes(field_id::CONTENT_SHA256, value),
                None => packet,
            }
        }
        WorkflowNotification::StreamingPaused { completed_units } => {
            packet.with_u64(field_id::COMPLETED_UNITS, completed_units)
        }
        WorkflowNotification::StreamingResumed => packet,
        WorkflowNotification::StreamingCompleted {
            total_units,
            uploaded_chunks,
            encrypted,
        } => packet
            .with_u64(field_id::TOTAL_UNITS, total_units)
            .with_u64(field_id::UPLOADED_CHUNKS, u64::from(uploaded_chunks))
            .with_bool(field_id::ENCRYPTED, encrypted),
        WorkflowNotification::Failed { error } => {
            let mut packet = packet
                .with_u64(
                    field_id::ERROR_CODE,
                    u64::from(error::error_code(error.code)),
                )
                .with_bool(field_id::RETRYABLE, error.retryable);
            if let Some(status) = error.protocol_status {
                packet = packet.with_u64(field_id::PROTOCOL_STATUS, u64::from(status));
            }
            if let Some(detail) = error.detail {
                packet = packet.with_text(field_id::ERROR_DETAIL, detail);
            }
            packet
        }
    }
}

fn candidate_fields(
    packet: BotaDeviceSdkPacketV1,
    candidate: DeviceCandidate,
) -> BotaDeviceSdkPacketV1 {
    let mut packet = packet
        .with_text(field_id::PERIPHERAL_ID, candidate.peripheral_id)
        .with_i64(field_id::RSSI, i64::from(candidate.rssi));
    if let Some(name) = candidate.name {
        packet = packet.with_text(field_id::NAME, name);
    }
    if let Some(address) = candidate.advertised_address {
        packet = packet.with_text(field_id::ADVERTISED_ADDRESS, address);
    }
    packet
}

const fn upload_source(source: UploadSource) -> u64 {
    match source {
        UploadSource::HostFile => 1,
        UploadSource::RecordingTransfer => 2,
    }
}

const fn connection_mode(mode: ConnectionMode) -> u64 {
    match mode {
        ConnectionMode::Manual => 1,
        ConnectionMode::Reconnect => 2,
    }
}

const fn firmware_phase(phase: FirmwareUpdatePhase) -> u64 {
    match phase {
        FirmwareUpdatePhase::Downloading => 1,
        FirmwareUpdatePhase::AwaitingDevice => 2,
        FirmwareUpdatePhase::Transferring => 3,
        FirmwareUpdatePhase::Verifying => 4,
        FirmwareUpdatePhase::Rebooting => 5,
        FirmwareUpdatePhase::Reconnecting => 6,
        FirmwareUpdatePhase::Complete => 7,
    }
}

pub(crate) fn encode_checkpoint(
    checkpoint: &WorkflowCheckpoint,
) -> Result<Vec<u8>, DeviceSdkError> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"BOTACKP1");
    bytes.push(workflow_kind(checkpoint.workflow));
    bytes.push(error::operation_code(checkpoint.operation) as u8);
    bytes.push(checkpoint_phase(checkpoint.phase));
    bytes.extend_from_slice(&checkpoint.completed_units.to_le_bytes());
    bytes.extend_from_slice(&checkpoint.retry_count.to_le_bytes());
    let mut flags = 0_u8;
    flags |= u8::from(checkpoint.recording.is_some());
    flags |= u8::from(checkpoint.last_sequence.is_some()) << 1;
    flags |= u8::from(checkpoint.firmware_version.is_some()) << 2;
    bytes.push(flags);
    push_bytes(&mut bytes, checkpoint.device.as_str().as_bytes())?;
    if let Some(recording) = checkpoint.recording {
        bytes.extend_from_slice(recording.as_bytes());
    }
    if let Some(sequence) = checkpoint.last_sequence {
        bytes.extend_from_slice(&sequence.to_le_bytes());
    }
    if let Some(version) = &checkpoint.firmware_version {
        push_bytes(&mut bytes, version.as_bytes())?;
    }
    Ok(bytes)
}

pub(crate) fn decode_checkpoint(bytes: &[u8]) -> Result<WorkflowCheckpoint, DeviceSdkError> {
    let mut cursor = CheckpointCursor::new(bytes);
    if cursor.take(8)? != b"BOTACKP1" {
        return Err(invalid_checkpoint("checkpoint magic or version is invalid"));
    }
    let workflow = match cursor.u8()? {
        1 => WorkflowKind::Discovery,
        2 => WorkflowKind::Connection,
        3 => WorkflowKind::Provisioning,
        4 => WorkflowKind::RecordingTransfer,
        5 => WorkflowKind::RecordingUpload,
        6 => WorkflowKind::FirmwareUpdate,
        7 => WorkflowKind::DeviceLogs,
        8 => WorkflowKind::FactoryReset,
        _ => return Err(invalid_checkpoint("checkpoint workflow kind is invalid")),
    };
    let operation = match cursor.u8()? {
        1 => Operation::Validate,
        2 => Operation::Decode,
        3 => Operation::Encode,
        4 => Operation::Discover,
        5 => Operation::Connect,
        6 => Operation::Reconnect,
        7 => Operation::Provision,
        8 => Operation::TransferRecording,
        9 => Operation::Upload,
        10 => Operation::UpdateFirmware,
        11 => Operation::ReadDeviceLogs,
        12 => Operation::FactoryReset,
        13 => Operation::Unknown,
        _ => return Err(invalid_checkpoint("checkpoint operation is invalid")),
    };
    let phase = match cursor.u8()? {
        1 => bota_device_sdk_core::engine::CheckpointPhase::Pending,
        2 => bota_device_sdk_core::engine::CheckpointPhase::Connecting,
        3 => bota_device_sdk_core::engine::CheckpointPhase::Transferring,
        4 => bota_device_sdk_core::engine::CheckpointPhase::Uploading,
        5 => bota_device_sdk_core::engine::CheckpointPhase::Verifying,
        6 => bota_device_sdk_core::engine::CheckpointPhase::Reconnecting,
        7 => bota_device_sdk_core::engine::CheckpointPhase::AwaitingReceipt,
        _ => return Err(invalid_checkpoint("checkpoint phase is invalid")),
    };
    let completed_units = cursor.u64()?;
    let retry_count = cursor.u16()?;
    let flags = cursor.u8()?;
    if flags & !0x07 != 0 {
        return Err(invalid_checkpoint("checkpoint flags are invalid"));
    }
    let device = DeviceSerialNumber::new(cursor.string()?)?;
    let recording = if flags & 0x01 != 0 {
        Some(RecordingUuid::from_bytes(
            cursor
                .take(16)?
                .try_into()
                .expect("checkpoint recording UUID is fixed width"),
        ))
    } else {
        None
    };
    let last_sequence = if flags & 0x02 != 0 {
        Some(cursor.u16()?)
    } else {
        None
    };
    let firmware_version = if flags & 0x04 != 0 {
        Some(cursor.string()?)
    } else {
        None
    };
    if !cursor.is_empty() {
        return Err(invalid_checkpoint("checkpoint has trailing bytes"));
    }

    Ok(WorkflowCheckpoint {
        workflow,
        operation,
        device,
        recording,
        phase,
        completed_units,
        retry_count,
        last_sequence,
        firmware_version,
    })
}

fn push_bytes(output: &mut Vec<u8>, value: &[u8]) -> Result<(), DeviceSdkError> {
    let length = u32::try_from(value.len()).map_err(|_| {
        DeviceSdkError::new(ErrorCode::PayloadTooLarge, Operation::Encode, false)
            .with_detail("checkpoint field exceeds 32-bit length")
    })?;
    output.extend_from_slice(&length.to_le_bytes());
    output.extend_from_slice(value);
    Ok(())
}

const fn workflow_kind(kind: bota_device_sdk_core::engine::WorkflowKind) -> u8 {
    use bota_device_sdk_core::engine::WorkflowKind;
    match kind {
        WorkflowKind::Discovery => 1,
        WorkflowKind::Connection => 2,
        WorkflowKind::Provisioning => 3,
        WorkflowKind::RecordingTransfer => 4,
        WorkflowKind::RecordingUpload => 5,
        WorkflowKind::FirmwareUpdate => 6,
        WorkflowKind::DeviceLogs => 7,
        WorkflowKind::FactoryReset => 8,
    }
}

const fn checkpoint_phase(phase: bota_device_sdk_core::engine::CheckpointPhase) -> u8 {
    use bota_device_sdk_core::engine::CheckpointPhase;
    match phase {
        CheckpointPhase::Pending => 1,
        CheckpointPhase::Connecting => 2,
        CheckpointPhase::Transferring => 3,
        CheckpointPhase::Uploading => 4,
        CheckpointPhase::Verifying => 5,
        CheckpointPhase::Reconnecting => 6,
        CheckpointPhase::AwaitingReceipt => 7,
    }
}

struct CheckpointCursor<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> CheckpointCursor<'a> {
    const fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8], DeviceSdkError> {
        let end = self
            .offset
            .checked_add(length)
            .ok_or_else(|| invalid_checkpoint("checkpoint length overflow"))?;
        let value = self
            .bytes
            .get(self.offset..end)
            .ok_or_else(|| invalid_checkpoint("checkpoint is truncated"))?;
        self.offset = end;
        Ok(value)
    }

    fn u8(&mut self) -> Result<u8, DeviceSdkError> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> Result<u16, DeviceSdkError> {
        Ok(u16::from_le_bytes(
            self.take(2)?
                .try_into()
                .expect("slice is exactly two bytes"),
        ))
    }

    fn u32(&mut self) -> Result<u32, DeviceSdkError> {
        Ok(u32::from_le_bytes(
            self.take(4)?
                .try_into()
                .expect("slice is exactly four bytes"),
        ))
    }

    fn u64(&mut self) -> Result<u64, DeviceSdkError> {
        Ok(u64::from_le_bytes(
            self.take(8)?
                .try_into()
                .expect("slice is exactly eight bytes"),
        ))
    }

    fn string(&mut self) -> Result<String, DeviceSdkError> {
        let length = usize::try_from(self.u32()?)
            .map_err(|_| invalid_checkpoint("checkpoint string length is too large"))?;
        let value = std::str::from_utf8(self.take(length)?)
            .map_err(|_| invalid_checkpoint("checkpoint string is not valid UTF-8"))?;
        Ok(value.to_owned())
    }

    fn is_empty(&self) -> bool {
        self.offset == self.bytes.len()
    }
}

fn invalid_checkpoint(detail: impl Into<String>) -> DeviceSdkError {
    DeviceSdkError::new(ErrorCode::InvalidInput, Operation::Decode, false).with_detail(detail)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::field_type;
    use bota_device_sdk_core::{
        engine::{CancellationId, CheckpointPhase, RequestId, WorkflowKind, WorkflowNotification},
        error::{DeviceSdkError, ErrorCode},
        model::{
            DevicePublicKey, DeviceSerialNumber, DurableFactoryResetResult, FactoryResetCommandId,
            FactoryResetResult, FirmwareUpdateProgress, HostMaterialId, ProvisioningNonce,
            RecordingSinkId, RecordingUuid, UploadDestinationId, UploadSessionId,
        },
        protocol::DeviceLogEvent,
    };
    use std::slice;

    #[test]
    fn every_effect_and_notification_variant_has_a_stable_packet_kind() {
        let device = DeviceSerialNumber::new("ABC123").unwrap();
        let candidate = DeviceCandidate {
            peripheral_id: "peripheral-1".to_owned(),
            name: Some("Bota Note".to_owned()),
            advertised_address: Some("aabbccddeeff".to_owned()),
            rssi: -55,
        };
        let command_id = FactoryResetCommandId::new("reset-1").unwrap();
        let material_id = HostMaterialId::new("material-1").unwrap();
        let sink_id = RecordingSinkId::new("sink-1").unwrap();
        let recording = RecordingUuid::from_bytes([1; 16]);
        let upload_id = UploadSessionId::new("upload-1").unwrap();
        let destination_id = UploadDestinationId::new("destination-1").unwrap();
        let checkpoint = WorkflowCheckpoint {
            workflow: WorkflowKind::RecordingTransfer,
            operation: Operation::TransferRecording,
            device: device.clone(),
            recording: Some(recording),
            phase: CheckpointPhase::Transferring,
            completed_units: 10,
            retry_count: 1,
            last_sequence: Some(2),
            firmware_version: None,
        };
        let reset_result = DurableFactoryResetResult {
            command_id: command_id.clone(),
            result: FactoryResetResult {
                result_code: 0,
                deleted_recording_count: 4,
            },
        };

        let cases = vec![
            (
                Effect::Timer(TimerEffect::Schedule {
                    timer_id: 1,
                    delay_ms: 2,
                }),
                packet_kind::HOST_EFFECT_TIMER_SCHEDULE,
            ),
            (
                Effect::Timer(TimerEffect::Cancel { timer_id: 1 }),
                packet_kind::HOST_EFFECT_TIMER_CANCEL,
            ),
            (
                Effect::Persistence(PersistenceEffect::LoadCheckpoint),
                packet_kind::HOST_EFFECT_PERSISTENCE_LOAD_CHECKPOINT,
            ),
            (
                Effect::Persistence(PersistenceEffect::SaveCheckpoint {
                    checkpoint: checkpoint.clone(),
                }),
                packet_kind::HOST_EFFECT_PERSISTENCE_SAVE_CHECKPOINT,
            ),
            (
                Effect::Persistence(PersistenceEffect::DeleteCheckpoint),
                packet_kind::HOST_EFFECT_PERSISTENCE_DELETE_CHECKPOINT,
            ),
            (
                Effect::Persistence(PersistenceEffect::SaveConnectionIdentity {
                    device: device.clone(),
                    candidate: candidate.clone(),
                }),
                packet_kind::HOST_EFFECT_PERSISTENCE_SAVE_CONNECTION_IDENTITY,
            ),
            (
                Effect::Persistence(PersistenceEffect::SaveFactoryResetResult {
                    result: reset_result,
                }),
                packet_kind::HOST_EFFECT_PERSISTENCE_SAVE_FACTORY_RESET_RESULT,
            ),
            (
                Effect::Persistence(PersistenceEffect::DeleteFactoryResetResult { command_id }),
                packet_kind::HOST_EFFECT_PERSISTENCE_DELETE_FACTORY_RESET_RESULT,
            ),
            (
                Effect::SecureStorage(SecureStorageEffect::Read {
                    key: "key".to_owned(),
                }),
                packet_kind::HOST_EFFECT_SECURE_STORAGE_READ,
            ),
            (
                Effect::SecureStorage(SecureStorageEffect::Write {
                    key: "key".to_owned(),
                    value: vec![0, 1],
                }),
                packet_kind::HOST_EFFECT_SECURE_STORAGE_WRITE,
            ),
            (
                Effect::SecureStorage(SecureStorageEffect::Delete {
                    key: "key".to_owned(),
                }),
                packet_kind::HOST_EFFECT_SECURE_STORAGE_DELETE,
            ),
            (
                Effect::Ble(BleEffect::StartScan {
                    allow_duplicates: true,
                }),
                packet_kind::HOST_EFFECT_BLE_START_SCAN,
            ),
            (
                Effect::Ble(BleEffect::StopScan),
                packet_kind::HOST_EFFECT_BLE_STOP_SCAN,
            ),
            (
                Effect::Ble(BleEffect::Connect {
                    peripheral_id: "p".to_owned(),
                }),
                packet_kind::HOST_EFFECT_BLE_CONNECT,
            ),
            (
                Effect::Ble(BleEffect::DiscoverServices {
                    peripheral_id: "p".to_owned(),
                }),
                packet_kind::HOST_EFFECT_BLE_DISCOVER_SERVICES,
            ),
            (
                Effect::Ble(BleEffect::Disconnect {
                    peripheral_id: "p".to_owned(),
                }),
                packet_kind::HOST_EFFECT_BLE_DISCONNECT,
            ),
            (
                Effect::Ble(BleEffect::Read {
                    service_uuid: "s".to_owned(),
                    characteristic_uuid: "c".to_owned(),
                }),
                packet_kind::HOST_EFFECT_BLE_READ,
            ),
            (
                Effect::Ble(BleEffect::Write {
                    service_uuid: "s".to_owned(),
                    characteristic_uuid: "c".to_owned(),
                    payload: vec![0, 255],
                    with_response: true,
                }),
                packet_kind::HOST_EFFECT_BLE_WRITE,
            ),
            (
                Effect::Ble(BleEffect::Subscribe {
                    service_uuid: "s".to_owned(),
                    characteristic_uuid: "c".to_owned(),
                }),
                packet_kind::HOST_EFFECT_BLE_SUBSCRIBE,
            ),
            (
                Effect::Ble(BleEffect::Unsubscribe {
                    service_uuid: "s".to_owned(),
                    characteristic_uuid: "c".to_owned(),
                }),
                packet_kind::HOST_EFFECT_BLE_UNSUBSCRIBE,
            ),
            (
                Effect::Network(NetworkEffect::Download { download_id: 1 }),
                packet_kind::HOST_EFFECT_NETWORK_DOWNLOAD,
            ),
            (
                Effect::Network(NetworkEffect::Upload {
                    upload_id: 1,
                    source: UploadSource::HostFile,
                }),
                packet_kind::HOST_EFFECT_NETWORK_UPLOAD,
            ),
            (
                Effect::Progress(ProgressEffect {
                    completed_units: 1,
                    total_units: 2,
                }),
                packet_kind::HOST_EFFECT_PROGRESS,
            ),
            (
                Effect::HostMaterial(HostMaterialEffect::PrepareProvisioning {
                    material_id: material_id.clone(),
                    device: device.clone(),
                    nonce: ProvisioningNonce([1; 16]),
                    device_public_key: DevicePublicKey(vec![2; 64]),
                }),
                packet_kind::HOST_EFFECT_PREPARE_PROVISIONING,
            ),
            (
                Effect::HostMaterial(HostMaterialEffect::PrepareFactoryResetGrant {
                    grant_id: material_id,
                    device: device.clone(),
                    nonce: ProvisioningNonce([1; 16]),
                }),
                packet_kind::HOST_EFFECT_PREPARE_FACTORY_RESET_GRANT,
            ),
            (
                Effect::RecordingSink(RecordingSinkEffect::Truncate {
                    sink_id: sink_id.clone(),
                    completed_units: 1,
                }),
                packet_kind::HOST_EFFECT_RECORDING_SINK_TRUNCATE,
            ),
            (
                Effect::RecordingSink(RecordingSinkEffect::Append {
                    sink_id: sink_id.clone(),
                    sequence: 1,
                    payload: vec![0, 1],
                }),
                packet_kind::HOST_EFFECT_RECORDING_SINK_APPEND,
            ),
            (
                Effect::RecordingSink(RecordingSinkEffect::Finalize {
                    sink_id: sink_id.clone(),
                    expected_crc32: Some(1),
                }),
                packet_kind::HOST_EFFECT_RECORDING_SINK_FINALIZE,
            ),
            (
                Effect::RecordingSink(RecordingSinkEffect::Discard { sink_id }),
                packet_kind::HOST_EFFECT_RECORDING_SINK_DISCARD,
            ),
            (
                Effect::FirmwareBlob(FirmwareBlobEffect::ReadChunk {
                    download_id: 1,
                    offset: 2,
                    max_length: 3,
                }),
                packet_kind::HOST_EFFECT_FIRMWARE_BLOB_READ,
            ),
            (
                Effect::Notify(WorkflowNotification::Started {
                    operation: Operation::Discover,
                }),
                packet_kind::NOTIFICATION_STARTED,
            ),
            (
                Effect::Notify(WorkflowNotification::DeviceDiscovered {
                    candidate: candidate.clone(),
                }),
                packet_kind::NOTIFICATION_DEVICE_DISCOVERED,
            ),
            (
                Effect::Notify(WorkflowNotification::ConnectionEstablished {
                    device,
                    candidate,
                    mode: ConnectionMode::Manual,
                }),
                packet_kind::NOTIFICATION_CONNECTION_ESTABLISHED,
            ),
            (
                Effect::Notify(WorkflowNotification::Progress {
                    operation: Operation::Upload,
                    completed_units: 1,
                    total_units: 2,
                }),
                packet_kind::NOTIFICATION_PROGRESS,
            ),
            (
                Effect::Notify(WorkflowNotification::Retrying {
                    operation: Operation::Connect,
                    attempt: 2,
                }),
                packet_kind::NOTIFICATION_RETRYING,
            ),
            (
                Effect::Notify(WorkflowNotification::DeviceUploadPreserved {
                    upload_id: upload_id.clone(),
                }),
                packet_kind::NOTIFICATION_DEVICE_UPLOAD_PRESERVED,
            ),
            (
                Effect::Notify(WorkflowNotification::BleFallbackReady {
                    recording,
                    upload_id,
                    destination_id,
                }),
                packet_kind::NOTIFICATION_BLE_FALLBACK_READY,
            ),
            (
                Effect::Notify(WorkflowNotification::FirmwareProgress {
                    progress: FirmwareUpdateProgress {
                        phase: FirmwareUpdatePhase::Downloading,
                        completed_bytes: 1,
                        total_bytes: 2,
                    },
                }),
                packet_kind::NOTIFICATION_FIRMWARE_PROGRESS,
            ),
            (
                Effect::Notify(WorkflowNotification::DeviceLog {
                    event: DeviceLogEvent {
                        message: "line".to_owned(),
                        is_backlog: true,
                    },
                }),
                packet_kind::NOTIFICATION_DEVICE_LOG,
            ),
            (
                Effect::Notify(WorkflowNotification::RecordingTransferCompleted {
                    encrypted: true,
                    sha256: Some(vec![0x5a; 32]),
                }),
                packet_kind::NOTIFICATION_COMPLETED,
            ),
            (
                Effect::Notify(WorkflowNotification::Completed {
                    operation: Operation::Discover,
                }),
                packet_kind::NOTIFICATION_COMPLETED,
            ),
            (
                Effect::Notify(WorkflowNotification::Cancelled {
                    operation: Operation::Discover,
                }),
                packet_kind::NOTIFICATION_CANCELLED,
            ),
            (
                Effect::Notify(WorkflowNotification::Failed {
                    error: DeviceSdkError::new(ErrorCode::Timeout, Operation::Connect, true)
                        .with_protocol_status(9)
                        .with_detail("timed out"),
                }),
                packet_kind::NOTIFICATION_FAILED,
            ),
        ];

        for (index, (effect, expected_kind)) in cases.into_iter().enumerate() {
            let request = EffectRequest::new(
                RequestId::from_u64((index + 1) as u64),
                Operation::Discover,
                CancellationId::from_bytes([3; 16]),
                effect,
            );
            let packet = packet_from_effect_request(request).unwrap();
            let view = packet.view();
            assert_eq!(view.kind, expected_kind, "case {index}");
            assert_eq!(view.request_id, (index + 1) as u64);
        }
    }

    #[test]
    fn recording_completion_exposes_encryption_and_integrity_metadata() {
        let packet = packet_from_effect_request(EffectRequest::new(
            RequestId::from_u64(1),
            Operation::TransferRecording,
            CancellationId::from_bytes([3; 16]),
            Effect::Notify(WorkflowNotification::RecordingTransferCompleted {
                encrypted: true,
                sha256: Some(vec![0x5a; 32]),
            }),
        ))
        .unwrap();
        let view = packet.view();
        let fields = unsafe { slice::from_raw_parts(view.fields, view.field_count as usize) };
        let encrypted = fields
            .iter()
            .find(|field| field.field_id == field_id::ENCRYPTED)
            .expect("encrypted field");
        assert_eq!(encrypted.field_type, field_type::BOOL);
        assert_eq!(encrypted.unsigned_value, 1);
        let sha256 = fields
            .iter()
            .find(|field| field.field_id == field_id::CONTENT_SHA256)
            .expect("SHA-256 field");
        let bytes = unsafe { slice::from_raw_parts(sha256.data.data, sha256.data.len as usize) };
        assert_eq!(bytes, &[0x5a; 32]);
    }

    #[test]
    fn checkpoint_output_is_an_opaque_versioned_byte_field() {
        let checkpoint = WorkflowCheckpoint {
            workflow: WorkflowKind::Connection,
            operation: Operation::Reconnect,
            device: DeviceSerialNumber::new("ABC123").unwrap(),
            recording: None,
            phase: CheckpointPhase::Connecting,
            completed_units: 0,
            retry_count: 2,
            last_sequence: None,
            firmware_version: None,
        };
        let packet = packet_from_effect_request(EffectRequest::new(
            RequestId::from_u64(1),
            Operation::Reconnect,
            CancellationId::from_bytes([0; 16]),
            Effect::Persistence(PersistenceEffect::SaveCheckpoint { checkpoint }),
        ))
        .unwrap();
        let view = packet.view();
        let fields = unsafe { slice::from_raw_parts(view.fields, view.field_count as usize) };
        assert_eq!(fields.len(), 1);
        assert_eq!(fields[0].field_id, field_id::CHECKPOINT);
        assert_eq!(fields[0].field_type, field_type::BYTES);
        let bytes =
            unsafe { slice::from_raw_parts(fields[0].data.data, fields[0].data.len as usize) };
        assert!(bytes.starts_with(b"BOTACKP1"));
    }
}
