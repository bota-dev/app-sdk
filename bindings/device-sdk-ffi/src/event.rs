use crate::{
    ABI_VERSION, BotaDeviceSdkPacketViewV1, command::PacketFields, field_id, output, packet_kind,
};
use bota_device_sdk_core::{
    engine::{
        BleEvent, EncryptedUploadV2HostEvent, HostEvent, HostEventKind, NetworkEvent, RequestId,
    },
    error::{DeviceSdkError, ErrorCode, Operation},
    model::{DeviceCandidate, DeviceSerialNumber, ProvisioningMaterial, RecordingUuid},
    workflow::{EncryptedUploadV2Checkpoint, EncryptedUploadV2TransferEvidence},
};

pub(crate) unsafe fn host_event_from_packet(
    packet: &BotaDeviceSdkPacketViewV1,
) -> Result<HostEvent, DeviceSdkError> {
    if packet.abi_version != ABI_VERSION {
        return Err(invalid(format!(
            "unsupported ABI version {}",
            packet.abi_version
        )));
    }
    if packet.operation == 0 || packet.reserved != 0 || packet.request_id == 0 {
        return Err(invalid(
            "host event operation and request_id must be non-zero and reserved must be zero",
        ));
    }
    let fields = unsafe { PacketFields::new(packet.fields, packet.field_count)? };
    let kind = match packet.kind {
        packet_kind::HOST_EVENT_BLE_SCAN_RESULT => {
            fields.validate_allowed(&[
                field_id::PERIPHERAL_ID,
                field_id::NAME,
                field_id::ADVERTISED_ADDRESS,
                field_id::RSSI,
            ])?;
            HostEventKind::Ble(BleEvent::ScanResult {
                candidate: candidate(&fields)?,
            })
        }
        packet_kind::HOST_EVENT_BLE_SCAN_STOPPED => {
            fields.validate_allowed(&[])?;
            HostEventKind::Ble(BleEvent::ScanStopped)
        }
        packet_kind::HOST_EVENT_BLE_CONNECTED => {
            fields.validate_allowed(&[field_id::PERIPHERAL_ID])?;
            HostEventKind::Ble(BleEvent::Connected {
                peripheral_id: fields.required_text(field_id::PERIPHERAL_ID)?,
            })
        }
        packet_kind::HOST_EVENT_BLE_SERVICES_DISCOVERED => {
            fields.validate_allowed(&[field_id::PERIPHERAL_ID])?;
            HostEventKind::Ble(BleEvent::ServicesDiscovered {
                peripheral_id: fields.required_text(field_id::PERIPHERAL_ID)?,
            })
        }
        packet_kind::HOST_EVENT_BLE_SUBSCRIBED => {
            fields.validate_allowed(&[field_id::CHARACTERISTIC_UUID])?;
            HostEventKind::Ble(BleEvent::Subscribed {
                characteristic_uuid: fields.required_text(field_id::CHARACTERISTIC_UUID)?,
            })
        }
        packet_kind::HOST_EVENT_BLE_DISCONNECTED => {
            fields.validate_allowed(&[field_id::PERIPHERAL_ID, field_id::REASON_CODE])?;
            HostEventKind::Ble(BleEvent::Disconnected {
                peripheral_id: fields.required_text(field_id::PERIPHERAL_ID)?,
                reason_code: optional_u16(&fields, field_id::REASON_CODE)?,
            })
        }
        packet_kind::HOST_EVENT_BLE_READ_COMPLETED => {
            fields.validate_allowed(&[field_id::VALUE])?;
            HostEventKind::Ble(BleEvent::ReadCompleted {
                value: fields.required_bytes(field_id::VALUE)?,
            })
        }
        packet_kind::HOST_EVENT_BLE_WRITE_COMPLETED => {
            fields.validate_allowed(&[])?;
            HostEventKind::Ble(BleEvent::WriteCompleted)
        }
        packet_kind::HOST_EVENT_BLE_NOTIFICATION => {
            fields.validate_allowed(&[field_id::CHARACTERISTIC_UUID, field_id::VALUE])?;
            HostEventKind::Ble(BleEvent::Notification {
                characteristic_uuid: fields.required_text(field_id::CHARACTERISTIC_UUID)?,
                value: fields.required_bytes(field_id::VALUE)?,
            })
        }
        packet_kind::HOST_EVENT_BLE_FAILED => {
            fields.validate_allowed(&[field_id::PLATFORM_CODE])?;
            HostEventKind::Ble(BleEvent::Failed {
                platform_code: fields.optional_i64(field_id::PLATFORM_CODE)?,
            })
        }
        packet_kind::HOST_EVENT_TIMER_FIRED => {
            fields.validate_allowed(&[field_id::TIMER_ID])?;
            HostEventKind::TimerFired {
                timer_id: fields.required_u64(field_id::TIMER_ID)?,
            }
        }
        packet_kind::HOST_EVENT_CHECKPOINT_LOADED => {
            fields.validate_allowed(&[field_id::CHECKPOINT])?;
            HostEventKind::CheckpointLoaded {
                checkpoint: fields
                    .optional_bytes(field_id::CHECKPOINT)?
                    .as_deref()
                    .map(output::decode_checkpoint)
                    .transpose()?,
            }
        }
        packet_kind::HOST_EVENT_CHECKPOINT_SAVED => {
            fields.validate_allowed(&[])?;
            HostEventKind::CheckpointSaved
        }
        packet_kind::HOST_EVENT_CONNECTION_IDENTITY_SAVED => {
            fields.validate_allowed(&[])?;
            HostEventKind::ConnectionIdentitySaved
        }
        packet_kind::HOST_EVENT_FACTORY_RESET_RESULT_SAVED => {
            fields.validate_allowed(&[])?;
            HostEventKind::FactoryResetResultSaved
        }
        packet_kind::HOST_EVENT_FACTORY_RESET_RESULT_DELETED => {
            fields.validate_allowed(&[])?;
            HostEventKind::FactoryResetResultDeleted
        }
        packet_kind::HOST_EVENT_PERSISTENCE_FAILED => {
            fields.validate_allowed(&[field_id::PLATFORM_CODE])?;
            HostEventKind::PersistenceFailed {
                platform_code: fields.optional_i64(field_id::PLATFORM_CODE)?,
            }
        }
        packet_kind::HOST_EVENT_PROVISIONING_MATERIAL_PREPARED => {
            fields.validate_allowed(&[
                field_id::API_ENDPOINT,
                field_id::DEVICE_TOKEN,
                field_id::MTU,
            ])?;
            HostEventKind::ProvisioningMaterialPrepared {
                material: ProvisioningMaterial {
                    api_endpoint: fields.required_bytes(field_id::API_ENDPOINT)?,
                    device_token: fields.required_bytes(field_id::DEVICE_TOKEN)?,
                    mtu: fields
                        .required_u64(field_id::MTU)?
                        .try_into()
                        .map_err(|_| invalid("MTU does not fit on this platform"))?,
                },
            }
        }
        packet_kind::HOST_EVENT_FACTORY_RESET_GRANT_PREPARED => {
            fields.validate_allowed(&[field_id::GRANT])?;
            HostEventKind::FactoryResetGrantPrepared {
                grant: fields.required_bytes(field_id::GRANT)?,
            }
        }
        packet_kind::HOST_EVENT_HOST_MATERIAL_FAILED => {
            fields.validate_allowed(&[field_id::PLATFORM_CODE])?;
            HostEventKind::HostMaterialFailed {
                platform_code: fields.optional_i64(field_id::PLATFORM_CODE)?,
            }
        }
        packet_kind::HOST_EVENT_RECORDING_SINK_TRUNCATED => {
            fields.validate_allowed(&[])?;
            HostEventKind::RecordingSinkTruncated
        }
        packet_kind::HOST_EVENT_RECORDING_SINK_APPEND_COMPLETED => {
            fields.validate_allowed(&[field_id::DURABLE_UNITS])?;
            HostEventKind::RecordingSinkAppendCompleted {
                durable_units: fields.required_u64(field_id::DURABLE_UNITS)?,
            }
        }
        packet_kind::HOST_EVENT_RECORDING_SINK_FINALIZED => {
            fields.validate_allowed(&[field_id::DURABLE_UNITS])?;
            HostEventKind::RecordingSinkFinalized {
                durable_units: fields.required_u64(field_id::DURABLE_UNITS)?,
            }
        }
        packet_kind::HOST_EVENT_RECORDING_SINK_INTEGRITY_FAILED => {
            fields.validate_allowed(&[])?;
            HostEventKind::RecordingSinkIntegrityFailed
        }
        packet_kind::HOST_EVENT_RECORDING_SINK_FAILED => {
            fields.validate_allowed(&[field_id::PLATFORM_CODE])?;
            HostEventKind::RecordingSinkFailed {
                platform_code: fields.optional_i64(field_id::PLATFORM_CODE)?,
            }
        }
        packet_kind::HOST_EVENT_STREAMING_SINK_ACCEPTED => {
            fields.validate_allowed(&[field_id::COMPLETED_UNITS])?;
            HostEventKind::StreamingSinkAccepted {
                received_units: fields.required_u64(field_id::COMPLETED_UNITS)?,
            }
        }
        packet_kind::HOST_EVENT_STREAMING_SINK_FINALIZED => {
            fields.validate_allowed(&[field_id::UPLOADED_CHUNKS, field_id::TOTAL_UNITS])?;
            HostEventKind::StreamingSinkFinalized {
                uploaded_chunks: fields
                    .required_u64(field_id::UPLOADED_CHUNKS)?
                    .try_into()
                    .map_err(|_| invalid("uploaded chunk count does not fit in 32 bits"))?,
                total_units: fields.required_u64(field_id::TOTAL_UNITS)?,
            }
        }
        packet_kind::HOST_EVENT_STREAMING_SINK_FAILED => {
            fields.validate_allowed(&[field_id::PLATFORM_CODE])?;
            HostEventKind::StreamingSinkFailed {
                platform_code: fields.optional_i64(field_id::PLATFORM_CODE)?,
            }
        }
        packet_kind::HOST_EVENT_FIRMWARE_CHUNK_READ => {
            fields.validate_allowed(&[field_id::DOWNLOAD_ID, field_id::OFFSET, field_id::VALUE])?;
            HostEventKind::FirmwareChunkRead {
                download_id: fields.required_u64(field_id::DOWNLOAD_ID)?,
                offset: fields.required_u64(field_id::OFFSET)?,
                bytes: fields.required_bytes(field_id::VALUE)?,
            }
        }
        packet_kind::HOST_EVENT_FIRMWARE_BLOB_FAILED => {
            fields.validate_allowed(&[field_id::PLATFORM_CODE])?;
            HostEventKind::FirmwareBlobFailed {
                platform_code: fields.optional_i64(field_id::PLATFORM_CODE)?,
            }
        }
        packet_kind::HOST_EVENT_SECRET_LOADED => {
            fields.validate_allowed(&[field_id::KEY, field_id::VALUE])?;
            HostEventKind::SecretLoaded {
                key: fields.required_text(field_id::KEY)?,
                value: fields.optional_bytes(field_id::VALUE)?,
            }
        }
        packet_kind::HOST_EVENT_SECRET_STORED => {
            fields.validate_allowed(&[field_id::KEY])?;
            HostEventKind::SecretStored {
                key: fields.required_text(field_id::KEY)?,
            }
        }
        packet_kind::HOST_EVENT_NETWORK_DOWNLOAD_PROGRESS => {
            fields.validate_allowed(&[
                field_id::DOWNLOAD_ID,
                field_id::COMPLETED_UNITS,
                field_id::TOTAL_UNITS,
            ])?;
            HostEventKind::Network(NetworkEvent::DownloadProgress {
                download_id: fields.required_u64(field_id::DOWNLOAD_ID)?,
                completed_bytes: fields.required_u64(field_id::COMPLETED_UNITS)?,
                total_bytes: fields.optional_u64(field_id::TOTAL_UNITS)?,
            })
        }
        packet_kind::HOST_EVENT_NETWORK_DOWNLOAD_COMPLETED => {
            fields.validate_allowed(&[field_id::DOWNLOAD_ID, field_id::FIRMWARE_CRC32])?;
            HostEventKind::Network(NetworkEvent::DownloadCompleted {
                download_id: fields.required_u64(field_id::DOWNLOAD_ID)?,
                crc32: fields
                    .required_u64(field_id::FIRMWARE_CRC32)?
                    .try_into()
                    .map_err(|_| invalid("firmware CRC32 does not fit in 32 bits"))?,
            })
        }
        packet_kind::HOST_EVENT_NETWORK_UPLOAD_PROGRESS => {
            fields.validate_allowed(&[
                field_id::UPLOAD_ID,
                field_id::COMPLETED_UNITS,
                field_id::TOTAL_UNITS,
            ])?;
            HostEventKind::Network(NetworkEvent::UploadProgress {
                upload_id: fields.required_u64(field_id::UPLOAD_ID)?,
                completed_bytes: fields.required_u64(field_id::COMPLETED_UNITS)?,
                total_bytes: fields.required_u64(field_id::TOTAL_UNITS)?,
            })
        }
        packet_kind::HOST_EVENT_NETWORK_UPLOAD_COMPLETED => {
            fields.validate_allowed(&[field_id::UPLOAD_ID])?;
            HostEventKind::Network(NetworkEvent::UploadCompleted {
                upload_id: fields.required_u64(field_id::UPLOAD_ID)?,
            })
        }
        packet_kind::HOST_EVENT_NETWORK_FAILED => {
            fields.validate_allowed(&[field_id::TRANSFER_ID, field_id::STATUS_CODE])?;
            HostEventKind::Network(NetworkEvent::Failed {
                transfer_id: fields.required_u64(field_id::TRANSFER_ID)?,
                status_code: optional_u16(&fields, field_id::STATUS_CODE)?,
            })
        }
        packet_kind::HOST_EVENT_ENCRYPTED_UPLOAD_V2_CHECKPOINT_LOADED => {
            fields.validate_allowed(&[field_id::CHECKPOINT])?;
            HostEventKind::EncryptedUploadV2(EncryptedUploadV2HostEvent::CheckpointLoaded(
                fields
                    .optional_bytes(field_id::CHECKPOINT)?
                    .as_deref()
                    .map(output::decode_encrypted_upload_v2_checkpoint)
                    .transpose()?,
            ))
        }
        packet_kind::HOST_EVENT_ENCRYPTED_UPLOAD_V2_SINK_TRUNCATED => {
            fields.validate_allowed(&[])?;
            HostEventKind::EncryptedUploadV2(EncryptedUploadV2HostEvent::SinkTruncated)
        }
        packet_kind::HOST_EVENT_ENCRYPTED_UPLOAD_V2_SESSION_PREPARED => {
            fields.validate_allowed(&[field_id::AUTHORIZATION_SHA256])?;
            HostEventKind::EncryptedUploadV2(EncryptedUploadV2HostEvent::SessionPrepared {
                authorization_sha256: fields
                    .required_fixed_bytes(field_id::AUTHORIZATION_SHA256)?,
            })
        }
        packet_kind::HOST_EVENT_ENCRYPTED_UPLOAD_V2_TRANSFER_STARTED => {
            fields.validate_allowed(&[])?;
            HostEventKind::EncryptedUploadV2(EncryptedUploadV2HostEvent::TransferStarted)
        }
        packet_kind::HOST_EVENT_ENCRYPTED_UPLOAD_V2_RESUME_REJECTED => {
            fields.validate_allowed(&[])?;
            HostEventKind::EncryptedUploadV2(EncryptedUploadV2HostEvent::ResumeRejected)
        }
        packet_kind::HOST_EVENT_ENCRYPTED_UPLOAD_V2_WINDOW_STAGED => {
            fields.validate_allowed(&[
                field_id::CHECKPOINT,
                field_id::SERIAL_NUMBER,
                field_id::RECORDING_UUID,
                field_id::RECORDING_GENERATION,
                field_id::UPLOAD_SESSION_UUID,
                field_id::OWNER_REVISION,
                field_id::TRANSPORT_SESSION_ID,
                field_id::CHECKPOINT_REVISION,
                field_id::OFFSET,
                field_id::PREFIX_SHA256,
                field_id::WINDOW_PACKETS,
                field_id::DATA_PAYLOAD_BYTES,
                field_id::MISSING_SEQUENCE,
            ])?;
            let opaque_checkpoint = fields.optional_bytes(field_id::CHECKPOINT)?;
            let has_structured_checkpoint =
                fields.optional_text(field_id::SERIAL_NUMBER)?.is_some()
                    || fields.optional_text(field_id::RECORDING_UUID)?.is_some()
                    || fields
                        .optional_u64(field_id::RECORDING_GENERATION)?
                        .is_some()
                    || fields
                        .optional_bytes(field_id::UPLOAD_SESSION_UUID)?
                        .is_some()
                    || fields.optional_u64(field_id::OWNER_REVISION)?.is_some()
                    || fields
                        .optional_u64(field_id::TRANSPORT_SESSION_ID)?
                        .is_some()
                    || fields
                        .optional_u64(field_id::CHECKPOINT_REVISION)?
                        .is_some()
                    || fields.optional_u64(field_id::OFFSET)?.is_some()
                    || fields.optional_bytes(field_id::PREFIX_SHA256)?.is_some()
                    || fields.optional_u64(field_id::WINDOW_PACKETS)?.is_some()
                    || fields.optional_u64(field_id::DATA_PAYLOAD_BYTES)?.is_some();
            if opaque_checkpoint.is_some() == has_structured_checkpoint {
                return Err(invalid(
                    "window-staged event requires exactly one checkpoint representation",
                ));
            }
            HostEventKind::EncryptedUploadV2(EncryptedUploadV2HostEvent::WindowStaged {
                checkpoint: match opaque_checkpoint {
                    Some(checkpoint) => output::decode_encrypted_upload_v2_checkpoint(&checkpoint)?,
                    None => structured_encrypted_upload_v2_checkpoint(&fields)?,
                },
                missing_sequences: fields
                    .optional_bytes(field_id::MISSING_SEQUENCE)?
                    .map(|bytes| decode_missing_sequences(&bytes))
                    .transpose()?
                    .unwrap_or_default(),
            })
        }
        packet_kind::HOST_EVENT_ENCRYPTED_UPLOAD_V2_CHECKPOINT_SAVED => {
            fields.validate_allowed(&[])?;
            HostEventKind::EncryptedUploadV2(EncryptedUploadV2HostEvent::CheckpointSaved)
        }
        packet_kind::HOST_EVENT_ENCRYPTED_UPLOAD_V2_WINDOW_ACKNOWLEDGED => {
            fields.validate_allowed(&[field_id::CHECKPOINT])?;
            HostEventKind::EncryptedUploadV2(EncryptedUploadV2HostEvent::WindowAcknowledged {
                checkpoint: output::decode_encrypted_upload_v2_checkpoint(
                    &fields.required_bytes(field_id::CHECKPOINT)?,
                )?,
            })
        }
        packet_kind::HOST_EVENT_ENCRYPTED_UPLOAD_V2_TRANSFER_COMPLETED => {
            fields.validate_allowed(&encrypted_upload_v2_evidence_field_ids())?;
            HostEventKind::EncryptedUploadV2(EncryptedUploadV2HostEvent::TransferCompleted(
                encrypted_upload_v2_evidence(&fields)?,
            ))
        }
        packet_kind::HOST_EVENT_ENCRYPTED_UPLOAD_V2_ARTIFACTS_STAGED => {
            fields.validate_allowed(&[])?;
            HostEventKind::EncryptedUploadV2(EncryptedUploadV2HostEvent::ArtifactsStaged)
        }
        packet_kind::HOST_EVENT_ENCRYPTED_UPLOAD_V2_RECEIPT_ACCEPTED => {
            fields.validate_allowed(&[field_id::RECEIPT_SHA256])?;
            HostEventKind::EncryptedUploadV2(
                EncryptedUploadV2HostEvent::CompletionReceiptAccepted {
                    receipt_sha256: fields.required_fixed_bytes(field_id::RECEIPT_SHA256)?,
                },
            )
        }
        packet_kind::HOST_EVENT_ENCRYPTED_UPLOAD_V2_RECORDING_CONFIRMED => {
            fields.validate_allowed(&[])?;
            HostEventKind::EncryptedUploadV2(EncryptedUploadV2HostEvent::RecordingConfirmed)
        }
        packet_kind::HOST_EVENT_ENCRYPTED_UPLOAD_V2_MIXED_PROFILE => {
            fields.validate_allowed(&[])?;
            HostEventKind::EncryptedUploadV2(EncryptedUploadV2HostEvent::MixedProfile)
        }
        packet_kind::HOST_EVENT_ENCRYPTED_UPLOAD_V2_FAILED => {
            fields.validate_allowed(&[
                field_id::ERROR_CODE,
                field_id::RETRYABLE,
                field_id::PROTOCOL_STATUS,
                field_id::ERROR_DETAIL,
            ])?;
            let mut error = DeviceSdkError::new(
                error_code(fields.required_u64(field_id::ERROR_CODE)?)?,
                Operation::TransferRecording,
                fields.required_bool(field_id::RETRYABLE)?,
            );
            if let Some(status) = optional_u16(&fields, field_id::PROTOCOL_STATUS)? {
                error = error.with_protocol_status(status);
            }
            if let Some(detail) = fields.optional_text(field_id::ERROR_DETAIL)? {
                error = error.with_detail(detail);
            }
            HostEventKind::EncryptedUploadV2(EncryptedUploadV2HostEvent::Failed { error })
        }
        _ => {
            return Err(
                DeviceSdkError::new(ErrorCode::UnknownPacket, Operation::Decode, false)
                    .with_detail(format!(
                        "unknown host event packet kind 0x{:04x}",
                        packet.kind
                    )),
            );
        }
    };

    Ok(HostEvent {
        request_id: RequestId::from_u64(packet.request_id),
        kind,
    })
}

fn structured_encrypted_upload_v2_checkpoint(
    fields: &PacketFields<'_>,
) -> Result<EncryptedUploadV2Checkpoint, DeviceSdkError> {
    Ok(EncryptedUploadV2Checkpoint {
        device: DeviceSerialNumber::new(fields.required_text(field_id::SERIAL_NUMBER)?)?,
        recording: fields
            .required_text(field_id::RECORDING_UUID)?
            .parse::<RecordingUuid>()?,
        recording_generation: required_u32(fields, field_id::RECORDING_GENERATION)?,
        upload_session_uuid: fields.required_fixed_bytes(field_id::UPLOAD_SESSION_UUID)?,
        owner_revision: required_u32(fields, field_id::OWNER_REVISION)?,
        transport_session_id: fields.required_u64(field_id::TRANSPORT_SESSION_ID)?,
        checkpoint_revision: required_u32(fields, field_id::CHECKPOINT_REVISION)?,
        next_ciphertext_offset: fields.required_u64(field_id::OFFSET)?,
        prefix_sha256: fields.required_fixed_bytes(field_id::PREFIX_SHA256)?,
        window_packets: required_u16(fields, field_id::WINDOW_PACKETS)?,
        data_payload_bytes: required_u16(fields, field_id::DATA_PAYLOAD_BYTES)?,
    })
}

fn required_u16(fields: &PacketFields<'_>, id: u32) -> Result<u16, DeviceSdkError> {
    fields
        .required_u64(id)?
        .try_into()
        .map_err(|_| invalid(format!("field {id} does not fit in 16 bits")))
}

fn required_u32(fields: &PacketFields<'_>, id: u32) -> Result<u32, DeviceSdkError> {
    fields
        .required_u64(id)?
        .try_into()
        .map_err(|_| invalid(format!("field {id} does not fit in 32 bits")))
}

fn candidate(fields: &PacketFields<'_>) -> Result<DeviceCandidate, DeviceSdkError> {
    Ok(DeviceCandidate {
        peripheral_id: fields.required_text(field_id::PERIPHERAL_ID)?,
        name: fields.optional_text(field_id::NAME)?,
        advertised_address: fields.optional_text(field_id::ADVERTISED_ADDRESS)?,
        rssi: fields
            .required_i64(field_id::RSSI)?
            .try_into()
            .map_err(|_| invalid("RSSI does not fit in a signed 16-bit value"))?,
    })
}

fn optional_u16(fields: &PacketFields<'_>, id: u32) -> Result<Option<u16>, DeviceSdkError> {
    fields
        .optional_u64(id)?
        .map(|value| {
            value
                .try_into()
                .map_err(|_| invalid(format!("field {id} does not fit in 16 bits")))
        })
        .transpose()
}

const fn encrypted_upload_v2_evidence_field_ids() -> [u32; 5] {
    [
        field_id::CIPHERTEXT_LENGTH,
        field_id::CIPHERTEXT_SHA256,
        field_id::MANIFEST_LENGTH,
        field_id::MANIFEST_SHA256,
        field_id::BLOCK_COUNT,
    ]
}

fn encrypted_upload_v2_evidence(
    fields: &PacketFields<'_>,
) -> Result<EncryptedUploadV2TransferEvidence, DeviceSdkError> {
    Ok(EncryptedUploadV2TransferEvidence {
        ciphertext_length: fields.required_u64(field_id::CIPHERTEXT_LENGTH)?,
        ciphertext_sha256: fields.required_fixed_bytes(field_id::CIPHERTEXT_SHA256)?,
        manifest_length: fields
            .required_u64(field_id::MANIFEST_LENGTH)?
            .try_into()
            .map_err(|_| invalid("manifest length does not fit in 16 bits"))?,
        manifest_sha256: fields.required_fixed_bytes(field_id::MANIFEST_SHA256)?,
        block_count: fields
            .required_u64(field_id::BLOCK_COUNT)?
            .try_into()
            .map_err(|_| invalid("block count does not fit in 32 bits"))?,
    })
}

fn decode_missing_sequences(bytes: &[u8]) -> Result<Vec<u32>, DeviceSdkError> {
    let (sequences, remainder) = bytes.as_chunks::<4>();
    if !remainder.is_empty() {
        return Err(invalid(
            "missing-sequence byte field length must be a multiple of four",
        ));
    }
    Ok(sequences
        .iter()
        .map(|sequence| u32::from_le_bytes(*sequence))
        .collect())
}

fn error_code(value: u64) -> Result<ErrorCode, DeviceSdkError> {
    match value {
        1 => Ok(ErrorCode::InvalidInput),
        2 => Ok(ErrorCode::TruncatedPacket),
        3 => Ok(ErrorCode::UnknownPacket),
        4 => Ok(ErrorCode::PayloadTooLarge),
        5 => Ok(ErrorCode::UnsupportedCapability),
        6 => Ok(ErrorCode::UnsupportedOperation),
        7 => Ok(ErrorCode::FeatureUnavailable),
        8 => Ok(ErrorCode::OperationInProgress),
        9 => Ok(ErrorCode::UnexpectedEvent),
        10 => Ok(ErrorCode::DeviceNotFound),
        11 => Ok(ErrorCode::IdentityMismatch),
        12 => Ok(ErrorCode::ConnectionFailed),
        13 => Ok(ErrorCode::PersistenceFailed),
        14 => Ok(ErrorCode::NotConnected),
        15 => Ok(ErrorCode::Timeout),
        16 => Ok(ErrorCode::Cancelled),
        17 => Ok(ErrorCode::ProtocolRejected),
        18 => Ok(ErrorCode::IntegrityFailed),
        19 => Ok(ErrorCode::UploadOwnershipUnknown),
        20 => Ok(ErrorCode::DownloadFailed),
        21 => Ok(ErrorCode::Internal),
        _ => Err(invalid("error code is invalid")),
    }
}

fn invalid(detail: impl Into<String>) -> DeviceSdkError {
    DeviceSdkError::new(ErrorCode::InvalidInput, Operation::Decode, false).with_detail(detail)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::BotaDeviceSdkPacketV1;
    use bota_device_sdk_core::{
        engine::{CheckpointPhase, WorkflowCheckpoint, WorkflowKind},
        model::DeviceSerialNumber,
    };

    fn event(kind: u32) -> BotaDeviceSdkPacketV1 {
        BotaDeviceSdkPacketV1::new(kind)
            .with_operation(4)
            .with_request_id(1)
            .with_cancellation_id(2, 3)
    }

    #[test]
    fn window_staged_accepts_structured_checkpoint_fields_from_native_hosts() {
        let packet = event(packet_kind::HOST_EVENT_ENCRYPTED_UPLOAD_V2_WINDOW_STAGED)
            .with_text(field_id::SERIAL_NUMBER, "EVFXXW67KP")
            .with_text(
                field_id::RECORDING_UUID,
                "ffeeddcc-bbaa-9988-7766-554433221100",
            )
            .with_u64(field_id::RECORDING_GENERATION, 7)
            .with_bytes(
                field_id::UPLOAD_SESSION_UUID,
                (0_u8..16).collect::<Vec<_>>(),
            )
            .with_u64(field_id::OWNER_REVISION, 9)
            .with_u64(field_id::TRANSPORT_SESSION_ID, 11)
            .with_u64(field_id::CHECKPOINT_REVISION, 2)
            .with_u64(field_id::OFFSET, 200)
            .with_bytes(field_id::PREFIX_SHA256, vec![0x44; 32])
            .with_u64(field_id::WINDOW_PACKETS, 4)
            .with_u64(field_id::DATA_PAYLOAD_BYTES, 160)
            .with_bytes(field_id::MISSING_SEQUENCE, 7_u32.to_le_bytes().to_vec());

        let decoded = unsafe { host_event_from_packet(&packet.view()) }.unwrap();

        let HostEventKind::EncryptedUploadV2(EncryptedUploadV2HostEvent::WindowStaged {
            checkpoint,
            missing_sequences,
        }) = decoded.kind
        else {
            panic!("expected encrypted upload v2 window event");
        };
        assert_eq!(checkpoint.device.as_str(), "EVFXXW67KP");
        assert_eq!(checkpoint.recording_generation, 7);
        assert_eq!(
            checkpoint.upload_session_uuid,
            std::array::from_fn(|index| index as u8)
        );
        assert_eq!(checkpoint.owner_revision, 9);
        assert_eq!(checkpoint.transport_session_id, 11);
        assert_eq!(checkpoint.checkpoint_revision, 2);
        assert_eq!(checkpoint.next_ciphertext_offset, 200);
        assert_eq!(checkpoint.prefix_sha256, [0x44; 32]);
        assert_eq!(checkpoint.window_packets, 4);
        assert_eq!(checkpoint.data_payload_bytes, 160);
        assert_eq!(missing_sequences, vec![7]);
    }

    #[test]
    fn window_staged_rejects_mixed_checkpoint_representations() {
        let checkpoint = EncryptedUploadV2Checkpoint {
            device: DeviceSerialNumber::new("EVFXXW67KP").unwrap(),
            recording: "ffeeddcc-bbaa-9988-7766-554433221100".parse().unwrap(),
            recording_generation: 7,
            upload_session_uuid: [0x11; 16],
            owner_revision: 9,
            transport_session_id: 11,
            checkpoint_revision: 2,
            next_ciphertext_offset: 200,
            prefix_sha256: [0x44; 32],
            window_packets: 4,
            data_payload_bytes: 160,
        };
        let packet = event(packet_kind::HOST_EVENT_ENCRYPTED_UPLOAD_V2_WINDOW_STAGED)
            .with_bytes(
                field_id::CHECKPOINT,
                output::encode_encrypted_upload_v2_checkpoint(&checkpoint).unwrap(),
            )
            .with_u64(field_id::RECORDING_GENERATION, 7);

        let decoded = unsafe { host_event_from_packet(&packet.view()) };

        assert!(decoded.is_err());
    }

    #[test]
    fn every_host_event_variant_decodes_from_a_typed_packet() {
        let checkpoint = WorkflowCheckpoint {
            workflow: WorkflowKind::Connection,
            operation: Operation::Reconnect,
            device: DeviceSerialNumber::new("ABC123").unwrap(),
            recording: None,
            phase: CheckpointPhase::Connecting,
            completed_units: 0,
            retry_count: 1,
            last_sequence: None,
            firmware_version: None,
        };
        let packets = vec![
            event(packet_kind::HOST_EVENT_BLE_SCAN_RESULT)
                .with_text(field_id::PERIPHERAL_ID, "peripheral-1")
                .with_i64(field_id::RSSI, -60),
            event(packet_kind::HOST_EVENT_BLE_SCAN_STOPPED),
            event(packet_kind::HOST_EVENT_BLE_CONNECTED)
                .with_text(field_id::PERIPHERAL_ID, "peripheral-1"),
            event(packet_kind::HOST_EVENT_BLE_SERVICES_DISCOVERED)
                .with_text(field_id::PERIPHERAL_ID, "peripheral-1"),
            event(packet_kind::HOST_EVENT_BLE_SUBSCRIBED)
                .with_text(field_id::CHARACTERISTIC_UUID, "characteristic"),
            event(packet_kind::HOST_EVENT_BLE_DISCONNECTED)
                .with_text(field_id::PERIPHERAL_ID, "peripheral-1")
                .with_u64(field_id::REASON_CODE, 7),
            event(packet_kind::HOST_EVENT_BLE_READ_COMPLETED)
                .with_bytes(field_id::VALUE, vec![0, 255]),
            event(packet_kind::HOST_EVENT_BLE_WRITE_COMPLETED),
            event(packet_kind::HOST_EVENT_BLE_NOTIFICATION)
                .with_text(field_id::CHARACTERISTIC_UUID, "characteristic")
                .with_bytes(field_id::VALUE, vec![1, 2]),
            event(packet_kind::HOST_EVENT_BLE_FAILED).with_i64(field_id::PLATFORM_CODE, -1),
            event(packet_kind::HOST_EVENT_TIMER_FIRED).with_u64(field_id::TIMER_ID, 1),
            event(packet_kind::HOST_EVENT_CHECKPOINT_LOADED).with_bytes(
                field_id::CHECKPOINT,
                output::encode_checkpoint(&checkpoint).unwrap(),
            ),
            event(packet_kind::HOST_EVENT_CHECKPOINT_SAVED),
            event(packet_kind::HOST_EVENT_CONNECTION_IDENTITY_SAVED),
            event(packet_kind::HOST_EVENT_FACTORY_RESET_RESULT_SAVED),
            event(packet_kind::HOST_EVENT_FACTORY_RESET_RESULT_DELETED),
            event(packet_kind::HOST_EVENT_PERSISTENCE_FAILED).with_i64(field_id::PLATFORM_CODE, -2),
            event(packet_kind::HOST_EVENT_PROVISIONING_MATERIAL_PREPARED)
                .with_bytes(field_id::API_ENDPOINT, b"https://api.example".to_vec())
                .with_bytes(field_id::DEVICE_TOKEN, vec![3; 32])
                .with_u64(field_id::MTU, 180),
            event(packet_kind::HOST_EVENT_FACTORY_RESET_GRANT_PREPARED)
                .with_bytes(field_id::GRANT, vec![4; 32]),
            event(packet_kind::HOST_EVENT_HOST_MATERIAL_FAILED)
                .with_i64(field_id::PLATFORM_CODE, -3),
            event(packet_kind::HOST_EVENT_RECORDING_SINK_TRUNCATED),
            event(packet_kind::HOST_EVENT_RECORDING_SINK_APPEND_COMPLETED)
                .with_u64(field_id::DURABLE_UNITS, 10),
            event(packet_kind::HOST_EVENT_RECORDING_SINK_FINALIZED)
                .with_u64(field_id::DURABLE_UNITS, 20),
            event(packet_kind::HOST_EVENT_RECORDING_SINK_INTEGRITY_FAILED),
            event(packet_kind::HOST_EVENT_RECORDING_SINK_FAILED)
                .with_i64(field_id::PLATFORM_CODE, -4),
            event(packet_kind::HOST_EVENT_FIRMWARE_CHUNK_READ)
                .with_u64(field_id::DOWNLOAD_ID, 1)
                .with_u64(field_id::OFFSET, 2)
                .with_bytes(field_id::VALUE, vec![0, 255, 1]),
            event(packet_kind::HOST_EVENT_FIRMWARE_BLOB_FAILED)
                .with_i64(field_id::PLATFORM_CODE, -5),
            event(packet_kind::HOST_EVENT_SECRET_LOADED)
                .with_text(field_id::KEY, "key")
                .with_bytes(field_id::VALUE, vec![0, 1]),
            event(packet_kind::HOST_EVENT_SECRET_STORED).with_text(field_id::KEY, "key"),
            event(packet_kind::HOST_EVENT_NETWORK_DOWNLOAD_PROGRESS)
                .with_u64(field_id::DOWNLOAD_ID, 1)
                .with_u64(field_id::COMPLETED_UNITS, 2)
                .with_u64(field_id::TOTAL_UNITS, 3),
            event(packet_kind::HOST_EVENT_NETWORK_DOWNLOAD_COMPLETED)
                .with_u64(field_id::DOWNLOAD_ID, 1)
                .with_u64(field_id::FIRMWARE_CRC32, 0x1234_5678),
            event(packet_kind::HOST_EVENT_NETWORK_UPLOAD_PROGRESS)
                .with_u64(field_id::UPLOAD_ID, 1)
                .with_u64(field_id::COMPLETED_UNITS, 2)
                .with_u64(field_id::TOTAL_UNITS, 3),
            event(packet_kind::HOST_EVENT_NETWORK_UPLOAD_COMPLETED)
                .with_u64(field_id::UPLOAD_ID, 1),
            event(packet_kind::HOST_EVENT_NETWORK_FAILED)
                .with_u64(field_id::TRANSFER_ID, 1)
                .with_u64(field_id::STATUS_CODE, 503),
        ];

        assert_eq!(packets.len(), 34);
        for (index, packet) in packets.iter().enumerate() {
            let decoded = unsafe { host_event_from_packet(&packet.view()) };
            assert!(decoded.is_ok(), "event case {index}: {decoded:?}");
        }
    }

    #[test]
    fn raw_event_bytes_and_checkpoint_round_trip_without_json() {
        let packet = event(packet_kind::HOST_EVENT_BLE_NOTIFICATION)
            .with_text(field_id::CHARACTERISTIC_UUID, "characteristic")
            .with_bytes(field_id::VALUE, vec![0, 255, 0, 127]);
        let decoded = unsafe { host_event_from_packet(&packet.view()) }.unwrap();
        assert!(matches!(
            decoded.kind,
            HostEventKind::Ble(BleEvent::Notification { value, .. })
                if value == [0, 255, 0, 127]
        ));

        let checkpoint = WorkflowCheckpoint {
            workflow: WorkflowKind::FirmwareUpdate,
            operation: Operation::UpdateFirmware,
            device: DeviceSerialNumber::new("ABC123").unwrap(),
            recording: None,
            phase: CheckpointPhase::Transferring,
            completed_units: 512,
            retry_count: 2,
            last_sequence: Some(7),
            firmware_version: Some("1.0.11".to_owned()),
        };
        let encoded = output::encode_checkpoint(&checkpoint).unwrap();
        assert_eq!(output::decode_checkpoint(&encoded).unwrap(), checkpoint);
    }
}
