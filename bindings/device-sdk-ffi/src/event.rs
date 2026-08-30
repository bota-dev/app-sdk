use crate::{
    ABI_VERSION, BotaDeviceSdkPacketViewV1, command::PacketFields, field_id, output, packet_kind,
};
use bota_device_sdk_core::{
    engine::{BleEvent, HostEvent, HostEventKind, NetworkEvent, RequestId},
    error::{DeviceSdkError, ErrorCode, Operation},
    model::{DeviceCandidate, ProvisioningMaterial},
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
            fields.validate_allowed(&[field_id::DOWNLOAD_ID])?;
            HostEventKind::Network(NetworkEvent::DownloadCompleted {
                download_id: fields.required_u64(field_id::DOWNLOAD_ID)?,
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
                .with_u64(field_id::DOWNLOAD_ID, 1),
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
