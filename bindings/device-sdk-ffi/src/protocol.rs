use crate::{
    ABI_VERSION, BotaDeviceSdkPacketV1, BotaDeviceSdkPacketViewV1, command::PacketFields, field_id,
    packet_kind,
};
use bota_device_sdk_core::{
    error::{DeviceSdkError, ErrorCode, Operation},
    generated::protocol as wire,
    model::{
        DeviceConnectionSettings, DeviceFlags, DeviceModel, EnabledConnections,
        HeartbeatConnections, IdleTimeout, PowerManagement, RecordingUuid,
    },
    protocol::{
        AckType, CommonHeaderV2, ConfirmV2, DeviceCommand, DeviceLogDecoder,
        EncryptedUploadV2SignedBlob, EncryptedUploadV2Transfer, FirmwareStatus,
        RecordingControlCommand, ResumeV2, StartV2, TransferCommand, TransferPacket,
        WiFiScanUpdate, WindowAckV2, decode_encrypted_upload_v2_capabilities,
        decode_encrypted_upload_v2_signed_blob, decode_encrypted_upload_v2_status,
        decode_encrypted_upload_v2_transfer, encode_ack, encode_bounded_payload,
        encode_connection_settings, encode_device_command, encode_encrypted_upload_v2_signed_blob,
        encode_encrypted_upload_v2_transfer, encode_firmware_data, encode_firmware_upload_start,
        encode_firmware_upload_verify, encode_firmware_window_ack, encode_ota_status,
        encode_provisioning_chunks, encode_recording_control_command, encode_time_sync,
        encode_transfer_command, encode_wifi_credentials, encode_wifi_grant,
        encode_wifi_scan_command, parse_ack, parse_connection_settings, parse_device_status,
        parse_factory_reset_result, parse_ota_status, parse_recording_control_result,
        parse_recording_list, parse_recording_state, parse_transfer_packet,
        parse_trigger_upload_response, parse_wifi_config_result, parse_wifi_scan_result,
        parse_wifi_status_info,
    },
};

pub(crate) unsafe fn decode(
    packet: &BotaDeviceSdkPacketViewV1,
    log_decoder: &mut DeviceLogDecoder,
) -> Result<BotaDeviceSdkPacketV1, DeviceSdkError> {
    validate_packet(packet)?;
    let fields = unsafe { PacketFields::new(packet.fields, packet.field_count)? };
    fields.validate_allowed(&[field_id::VALUE])?;
    let value = fields.required_bytes(field_id::VALUE)?;
    let output = BotaDeviceSdkPacketV1::new(packet.kind);

    match packet.kind {
        packet_kind::PROTOCOL_DECODE_ENCRYPTED_UPLOAD_V2_CAPABILITY => {
            let value = decode_encrypted_upload_v2_capabilities(&value)?;
            Ok(output
                .with_u64(field_id::PROTOCOL_VARIANT, 1)
                .with_u64(field_id::PROFILE_VERSION, 2)
                .with_u64(field_id::CAPABILITY_FLAGS, u64::from(value.flags))
                .with_u64(
                    field_id::MAX_SIGNED_BLOB_BYTES,
                    u64::from(value.maximum_signed_blob_bytes),
                )
                .with_u64(
                    field_id::MAX_MANIFEST_BYTES,
                    u64::from(value.maximum_manifest_bytes),
                )
                .with_u64(
                    field_id::DATA_PAYLOAD_BYTES,
                    u64::from(value.maximum_data_payload_bytes),
                )
                .with_u64(
                    field_id::WINDOW_PACKETS,
                    u64::from(value.maximum_window_packets),
                )
                .with_u64(
                    field_id::CHECKPOINT_INTERVAL,
                    u64::from(value.durable_checkpoint_interval_blocks),
                )
                .with_u64(
                    field_id::MAX_MISSING_SEQUENCES,
                    u64::from(value.maximum_missing_sequences),
                ))
        }
        packet_kind::PROTOCOL_DECODE_ENCRYPTED_UPLOAD_V2_SIGNED_BLOB => {
            decode_encrypted_upload_v2_signed_blob_packet(output, &value)
        }
        packet_kind::PROTOCOL_DECODE_ENCRYPTED_UPLOAD_V2_TRANSFER_OR_STATUS => {
            if value.first() == Some(&2) {
                let value = decode_encrypted_upload_v2_status(&value)?;
                Ok(output
                    .with_u64(field_id::PROTOCOL_VARIANT, 4)
                    .with_u64(field_id::PROFILE_VERSION, 2)
                    .with_u64(field_id::PHASE, u64::from(value.phase))
                    .with_u64(field_id::DETAIL_CODE, u64::from(value.result))
                    .with_u64(field_id::TRANSPORT_SESSION_ID, value.transport_session_id)
                    .with_u64(
                        field_id::DURABLE_CIPHERTEXT_BYTES,
                        value.durable_ciphertext_bytes,
                    )
                    .with_u64(
                        field_id::PROGRESS_PERCENT,
                        u64::from(value.progress_percent),
                    )
                    .with_u64(
                        field_id::TRANSPORT_PROFILE,
                        u64::from(value.transport_profile),
                    ))
            } else {
                decode_encrypted_upload_v2_transfer_packet(output, &value)
            }
        }
        packet_kind::PROTOCOL_DECODE_DEVICE_STATUS => {
            let status = parse_device_status(&value)?;
            let mut output = output
                .with_u64(field_id::BATTERY_PERCENT, u64::from(status.battery_percent))
                .with_u64(
                    field_id::STORAGE_TOTAL_MB,
                    u64::from(status.storage_total_mb),
                )
                .with_u64(field_id::STORAGE_USED_MB, u64::from(status.storage_used_mb))
                .with_u64(field_id::DEVICE_STATE, u64::from(status.state.to_wire()))
                .with_u64(
                    field_id::PENDING_RECORDINGS,
                    u64::from(status.pending_recordings),
                )
                .with_u64(
                    field_id::TIMESTAMP,
                    u64::from(status.last_time_sync_timestamp),
                )
                .with_u64(field_id::FLAGS, u64::from(device_flags(status.flags)))
                .with_u64(field_id::LTE_STATUS_RAW, u64::from(status.lte_status_raw));
            if let Some(value) = status.battery_mv {
                output = output.with_u64(field_id::BATTERY_MV, u64::from(value));
            }
            if let Some(value) = status.lte_signal_quality {
                output = output.with_u64(field_id::LTE_SIGNAL_QUALITY, u64::from(value));
            }
            if let Some(value) = status.wifi_status_raw {
                output = output.with_u64(field_id::WIFI_STATUS_RAW, u64::from(value));
            }
            if let Some(modem) = status.modem_info {
                output = optional_text(output, field_id::MODEM_IMEI, modem.imei);
                output = optional_text(output, field_id::MODEM_ICCID, modem.iccid);
                output = optional_text(output, field_id::MODEM_OPERATOR, modem.operator);
                output = optional_text(output, field_id::MODEM_RAT, modem.rat);
                output = optional_text(output, field_id::MODEM_BAND, modem.band);
                output = optional_text(output, field_id::MODEM_APN, modem.apn);
                output = optional_text(output, field_id::MODEM_SIM_STATUS, modem.sim_status);
                output = optional_u64(output, field_id::MODEM_CSQ, modem.csq.map(u64::from));
                output = optional_text(output, field_id::MODEM_IP_ADDRESS, modem.ip_address);
                output = optional_u64(
                    output,
                    field_id::MODEM_VOLTAGE_MV,
                    modem.voltage_mv.map(u64::from),
                );
                output = optional_text(output, field_id::MODEM_FIRMWARE, modem.firmware);
                if let Some(value) = modem.roaming {
                    output = output.with_bool(field_id::MODEM_ROAMING, value);
                }
            }
            Ok(output)
        }
        packet_kind::PROTOCOL_DECODE_RECORDING_LIST => {
            let recordings = parse_recording_list(&value)?;
            let mut output = output.with_u64(field_id::RECORDING_COUNT, recordings.len() as u64);
            for recording in recordings {
                output = output
                    .with_text(field_id::RECORDING_UUID, recording.uuid.to_string())
                    .with_u64(
                        field_id::STARTED_AT,
                        u64::from(recording.started_at_timestamp),
                    )
                    .with_u64(field_id::DURATION_MS, recording.duration_ms)
                    .with_u64(field_id::FILE_SIZE_BYTES, recording.file_size_bytes)
                    .with_u64(field_id::AUDIO_CODEC, u64::from(recording.codec.to_wire()))
                    .with_bool(field_id::ENCRYPTED, recording.encrypted);
            }
            Ok(output)
        }
        packet_kind::PROTOCOL_DECODE_TRANSFER_PACKET => {
            let output = match parse_transfer_packet(&value)? {
                TransferPacket::Data { sequence, data } => output
                    .with_u64(field_id::PROTOCOL_VARIANT, 1)
                    .with_u64(field_id::SEQUENCE, u64::from(sequence))
                    .with_bytes(field_id::VALUE, data),
                TransferPacket::Eof { sequence, checksum } => output
                    .with_u64(field_id::PROTOCOL_VARIANT, 2)
                    .with_u64(field_id::SEQUENCE, u64::from(sequence))
                    .with_u64(field_id::CHECKSUM, u64::from(checksum)),
                TransferPacket::Paused {
                    sequence,
                    bytes_sent,
                } => optional_u64(
                    output
                        .with_u64(field_id::PROTOCOL_VARIANT, 3)
                        .with_u64(field_id::SEQUENCE, u64::from(sequence)),
                    field_id::BYTES_SENT,
                    bytes_sent.map(u64::from),
                ),
                TransferPacket::Sha256(value) => output
                    .with_u64(field_id::PROTOCOL_VARIANT, 4)
                    .with_bytes(field_id::VALUE, value),
                TransferPacket::E2eStart {
                    ephemeral_public_key,
                    salt,
                } => output
                    .with_u64(field_id::PROTOCOL_VARIANT, 5)
                    .with_bytes(field_id::EPHEMERAL_PUBLIC_KEY, ephemeral_public_key)
                    .with_bytes(field_id::SALT, salt),
                TransferPacket::EncryptedData { sequence, chunk } => output
                    .with_u64(field_id::PROTOCOL_VARIANT, 6)
                    .with_u64(field_id::SEQUENCE, u64::from(sequence))
                    .with_bytes(field_id::VALUE, chunk),
                TransferPacket::EncryptedEof { sequence } => output
                    .with_u64(field_id::PROTOCOL_VARIANT, 7)
                    .with_u64(field_id::SEQUENCE, u64::from(sequence)),
                TransferPacket::Error { sequence, code } => output
                    .with_u64(field_id::PROTOCOL_VARIANT, 8)
                    .with_u64(field_id::SEQUENCE, u64::from(sequence))
                    .with_u64(field_id::ERROR_CODE, u64::from(code)),
            };
            Ok(output)
        }
        packet_kind::PROTOCOL_DECODE_TRIGGER_UPLOAD_RESPONSE => {
            let response = parse_trigger_upload_response(&value)?;
            let mut output =
                output.with_u64(field_id::PROTOCOL_VARIANT, u64::from(response.is_some()));
            if let Some(response) = response {
                output = output.with_bool(field_id::ACCEPTED, response.accepted);
                if let Some(code) = response.error_code {
                    output = output.with_u64(field_id::ERROR_CODE, u64::from(code));
                }
            }
            Ok(output)
        }
        packet_kind::PROTOCOL_DECODE_ACK => {
            let (ack_type, sequence) = parse_ack(&value)?;
            Ok(output
                .with_u64(field_id::ACK_TYPE, ack_type_code(ack_type))
                .with_u64(field_id::SEQUENCE, u64::from(sequence)))
        }
        packet_kind::PROTOCOL_DECODE_FIRMWARE_STATUS => {
            let status = parse_ota_status(&value)?;
            let mut output = output
                .with_u64(field_id::COMMAND, u64::from(status.command))
                .with_u64(field_id::RESULT, u64::from(status.result));
            if let Some(sequence) = status.sequence {
                output = output.with_u64(field_id::SEQUENCE, u64::from(sequence));
            }
            Ok(output)
        }
        packet_kind::PROTOCOL_DECODE_WIFI_CONFIG_RESULT => Ok(output.with_u64(
            field_id::WIFI_RESULT,
            u64::from(parse_wifi_config_result(&value)?.to_wire()),
        )),
        packet_kind::PROTOCOL_DECODE_FACTORY_RESET_RESULT => {
            let result = parse_factory_reset_result(&value)?;
            Ok(output
                .with_u64(field_id::RESULT_CODE, u64::from(result.result_code))
                .with_u64(
                    field_id::DELETED_RECORDING_COUNT,
                    u64::from(result.deleted_recording_count),
                ))
        }
        packet_kind::PROTOCOL_DECODE_CONNECTION_SETTINGS => {
            let parsed = parse_connection_settings(&value)?;
            let settings = parsed.settings;
            let mut output = output
                .with_bool(field_id::SUPPORTED_VERSION, parsed.supported_version)
                .with_bool(field_id::ENABLED_WIFI, settings.enabled.wifi)
                .with_bool(field_id::ENABLED_CELLULAR, settings.enabled.cellular)
                .with_i64(
                    field_id::CELLULAR_IDLE_TIMEOUT,
                    i64::from(settings.power.cellular.seconds()),
                )
                .with_i64(
                    field_id::WIFI_IDLE_TIMEOUT,
                    i64::from(settings.power.wifi.seconds()),
                )
                .with_bool(field_id::STREAMING_ENABLED, settings.streaming_enabled)
                .with_u64(
                    field_id::STREAMING_FLUSH_INTERVAL,
                    u64::from(settings.streaming_flush_interval_seconds),
                )
                .with_bool(field_id::HEARTBEAT_WIFI, settings.heartbeat.wifi)
                .with_bool(field_id::HEARTBEAT_CELLULAR, settings.heartbeat.cellular)
                .with_u64(
                    field_id::HEARTBEAT_UNKNOWN_MASK,
                    u64::from(settings.heartbeat.unknown_mask),
                );
            for connection in settings.upload_priority {
                output =
                    output.with_u64(field_id::CONNECTION_TYPE, u64::from(connection.to_wire()));
            }
            Ok(output)
        }
        packet_kind::PROTOCOL_DECODE_DEVICE_LOGS => {
            let mut output = output;
            for event in log_decoder.push(&value) {
                output = output
                    .with_text(field_id::LOG_MESSAGE, event.message)
                    .with_bool(field_id::IS_BACKLOG, event.is_backlog);
            }
            Ok(output)
        }
        packet_kind::PROTOCOL_DECODE_WIFI_STATUS => {
            let status = parse_wifi_status_info(&value)?;
            let mut output =
                output.with_u64(field_id::STATUS_CODE, u64::from(status.status.to_wire()));
            output = optional_u64(
                output,
                field_id::WIFI_SIGNAL_STRENGTH,
                status.signal_strength.map(u64::from),
            );
            output = optional_text(output, field_id::WIFI_SSID, status.ssid);
            output = optional_text(output, field_id::ERROR_DETAIL, status.last_error);
            Ok(output)
        }
        packet_kind::PROTOCOL_DECODE_WIFI_SCAN => match parse_wifi_scan_result(&value)? {
            WiFiScanUpdate::Pending(status) => {
                Ok(output.with_u64(field_id::STATUS_CODE, u64::from(status)))
            }
            WiFiScanUpdate::Done(result) => {
                let mut output = output.with_u64(
                    field_id::STATUS_CODE,
                    u64::from(bota_device_sdk_core::generated::protocol::WIFI_SCAN_STATUS_DONE),
                );
                for network in result.networks {
                    output = output
                        .with_text(field_id::WIFI_SSID, network.ssid)
                        .with_u64(field_id::WIFI_QUALITY, u64::from(network.quality))
                        .with_bool(field_id::WIFI_IS_CURRENT, network.is_current)
                        .with_bool(field_id::WIFI_IS_OPEN, network.is_open);
                }
                Ok(output)
            }
        },
        packet_kind::PROTOCOL_DECODE_RECORDING_STATE => {
            let state = parse_recording_state(&value)?;
            let output = output
                .with_bool(field_id::RECORDING_ACTIVE, state.active)
                .with_bool(
                    field_id::RECORDING_INITIATED_REMOTELY,
                    state.initiated_remotely,
                );
            Ok(match state.recording_uuid {
                Some(uuid) => output.with_text(field_id::RECORDING_UUID, uuid.to_string()),
                None => output,
            })
        }
        packet_kind::PROTOCOL_DECODE_RECORDING_CONTROL_RESULT => {
            let result = parse_recording_control_result(&value)?;
            let output = output.with_bool(field_id::RECORDING_SUCCESS, result.success);
            Ok(match result.error {
                Some(error) => output.with_text(field_id::ERROR_DETAIL, error.as_str()),
                None => output,
            })
        }
        _ => Err(unknown_packet(packet.kind)),
    }
}

pub(crate) unsafe fn encode(
    packet: &BotaDeviceSdkPacketViewV1,
) -> Result<BotaDeviceSdkPacketV1, DeviceSdkError> {
    validate_packet(packet)?;
    let fields = unsafe { PacketFields::new(packet.fields, packet.field_count)? };
    let bytes = match packet.kind {
        packet_kind::PROTOCOL_ENCODE_ACK => {
            fields.validate_allowed(&[field_id::ACK_TYPE, field_id::SEQUENCE])?;
            encode_ack(
                ack_type(fields.required_u64(field_id::ACK_TYPE)?)?,
                to_u16(&fields, field_id::SEQUENCE)?,
            )?
        }
        packet_kind::PROTOCOL_ENCODE_TRANSFER_COMMAND => {
            fields.validate_allowed(&[field_id::COMMAND, field_id::RECORDING_UUID])?;
            let command = match fields.required_u64(field_id::COMMAND)? {
                1 => TransferCommand::List,
                2 => TransferCommand::Start(recording(&fields)?),
                3 => TransferCommand::TriggerDeviceUpload,
                4 => TransferCommand::Confirm(recording(&fields)?),
                _ => return Err(invalid("unknown transfer command")),
            };
            encode_transfer_command(command)?
        }
        packet_kind::PROTOCOL_ENCODE_DEVICE_COMMAND => {
            fields.validate_allowed(&[field_id::COMMAND])?;
            let command = match fields.required_u64(field_id::COMMAND)? {
                1 => DeviceCommand::Deprovision,
                2 => DeviceCommand::FactoryReset,
                3 => DeviceCommand::FactoryResetReceipt,
                _ => return Err(invalid("unknown device command")),
            };
            encode_device_command(command)?
        }
        packet_kind::PROTOCOL_ENCODE_FIRMWARE_UPLOAD_START => {
            fields.validate_allowed(&[field_id::FIRMWARE_SIZE_BYTES])?;
            encode_firmware_upload_start(to_u32(&fields, field_id::FIRMWARE_SIZE_BYTES)?)?
        }
        packet_kind::PROTOCOL_ENCODE_FIRMWARE_DATA => {
            fields.validate_allowed(&[field_id::SEQUENCE, field_id::PAYLOAD])?;
            encode_firmware_data(
                to_u16(&fields, field_id::SEQUENCE)?,
                &fields.required_bytes(field_id::PAYLOAD)?,
            )?
        }
        packet_kind::PROTOCOL_ENCODE_FIRMWARE_WINDOW_ACK => {
            fields.validate_allowed(&[field_id::SEQUENCE])?;
            encode_firmware_window_ack(to_u16(&fields, field_id::SEQUENCE)?)?
        }
        packet_kind::PROTOCOL_ENCODE_FIRMWARE_UPLOAD_VERIFY => {
            fields.validate_allowed(&[field_id::FIRMWARE_CRC32])?;
            encode_firmware_upload_verify(to_u32(&fields, field_id::FIRMWARE_CRC32)?)?
        }
        packet_kind::PROTOCOL_ENCODE_FIRMWARE_STATUS => {
            fields.validate_allowed(&[field_id::COMMAND, field_id::RESULT, field_id::SEQUENCE])?;
            encode_ota_status(FirmwareStatus {
                command: to_u8(&fields, field_id::COMMAND)?,
                result: to_u8(&fields, field_id::RESULT)?,
                sequence: optional_u16(&fields, field_id::SEQUENCE)?,
            })?
        }
        packet_kind::PROTOCOL_ENCODE_CONNECTION_SETTINGS => {
            fields.validate_allowed(&[
                field_id::ENABLED_WIFI,
                field_id::ENABLED_CELLULAR,
                field_id::CONNECTION_TYPE,
                field_id::CELLULAR_IDLE_TIMEOUT,
                field_id::WIFI_IDLE_TIMEOUT,
                field_id::STREAMING_ENABLED,
                field_id::STREAMING_FLUSH_INTERVAL,
                field_id::HEARTBEAT_WIFI,
                field_id::HEARTBEAT_CELLULAR,
                field_id::HEARTBEAT_UNKNOWN_MASK,
                field_id::DEVICE_MODEL,
            ])?;
            let priorities = fields.required_bytes(field_id::CONNECTION_TYPE)?;
            let settings = DeviceConnectionSettings {
                enabled: EnabledConnections {
                    wifi: fields.required_bool(field_id::ENABLED_WIFI)?,
                    cellular: fields.required_bool(field_id::ENABLED_CELLULAR)?,
                },
                heartbeat: HeartbeatConnections {
                    wifi: fields
                        .optional_bool(field_id::HEARTBEAT_WIFI)?
                        .unwrap_or(true),
                    cellular: fields
                        .optional_bool(field_id::HEARTBEAT_CELLULAR)?
                        .unwrap_or(true),
                    unknown_mask: optional_u8(&fields, field_id::HEARTBEAT_UNKNOWN_MASK)?
                        .unwrap_or(0),
                },
                upload_priority: priorities
                    .into_iter()
                    .map(bota_device_sdk_core::model::ConnectionType::from_wire)
                    .collect(),
                power: PowerManagement {
                    cellular: timeout(&fields, field_id::CELLULAR_IDLE_TIMEOUT, 180)?,
                    wifi: timeout(&fields, field_id::WIFI_IDLE_TIMEOUT, 180)?,
                },
                streaming_enabled: fields
                    .optional_bool(field_id::STREAMING_ENABLED)?
                    .unwrap_or(true),
                streaming_flush_interval_seconds: optional_u8(
                    &fields,
                    field_id::STREAMING_FLUSH_INTERVAL,
                )?
                .unwrap_or(60),
            };
            let model = DeviceModel::from_wire(to_u8(&fields, field_id::DEVICE_MODEL)?);
            encode_connection_settings(&settings, model)?
        }
        packet_kind::PROTOCOL_ENCODE_BOUNDED_PAYLOAD => {
            fields.validate_allowed(&[field_id::PAYLOAD, field_id::CAPACITY])?;
            encode_bounded_payload(
                &fields.required_bytes(field_id::PAYLOAD)?,
                to_usize(&fields, field_id::CAPACITY)?,
            )?
        }
        packet_kind::PROTOCOL_ENCODE_WIFI_GRANT => {
            fields.validate_allowed(&[field_id::GRANT, field_id::CAPACITY])?;
            encode_wifi_grant(
                &fields.required_text(field_id::GRANT)?,
                to_usize(&fields, field_id::CAPACITY)?,
            )?
        }
        packet_kind::PROTOCOL_ENCODE_WIFI_SCAN => {
            fields.validate_allowed(&[])?;
            encode_wifi_scan_command()?
        }
        packet_kind::PROTOCOL_ENCODE_PROVISIONING_CHUNKS => {
            fields.validate_allowed(&[field_id::PAYLOAD, field_id::MTU])?;
            let chunks = encode_provisioning_chunks(
                &fields.required_bytes(field_id::PAYLOAD)?,
                to_usize(&fields, field_id::MTU)?,
            )?;
            let mut output = BotaDeviceSdkPacketV1::new(packet.kind);
            for chunk in chunks {
                output = output.with_bytes(field_id::CHUNK, chunk);
            }
            return Ok(output);
        }
        packet_kind::PROTOCOL_ENCODE_WIFI_CREDENTIALS => {
            fields.validate_allowed(&[field_id::WIFI_SSID, field_id::WIFI_PASSWORD])?;
            encode_wifi_credentials(
                &fields.required_text(field_id::WIFI_SSID)?,
                &fields.required_text(field_id::WIFI_PASSWORD)?,
            )?
        }
        packet_kind::PROTOCOL_ENCODE_TIME_SYNC => {
            fields.validate_allowed(&[field_id::TIMESTAMP, field_id::OFFSET])?;
            encode_time_sync(
                fields.required_u64(field_id::TIMESTAMP)?,
                to_i16(&fields, field_id::OFFSET)?,
            )?
        }
        packet_kind::PROTOCOL_ENCODE_RECORDING_CONTROL_COMMAND => {
            fields.validate_allowed(&[field_id::COMMAND])?;
            let command = match fields.required_u64(field_id::COMMAND)? {
                1 => RecordingControlCommand::Start,
                2 => RecordingControlCommand::Stop,
                _ => return Err(invalid("unknown recording control command")),
            };
            encode_recording_control_command(command).to_vec()
        }
        packet_kind::PROTOCOL_ENCODE_ENCRYPTED_UPLOAD_V2_SIGNED_BLOB => {
            encode_encrypted_upload_v2_signed_blob_packet(&fields)?
        }
        packet_kind::PROTOCOL_ENCODE_ENCRYPTED_UPLOAD_V2_TRANSFER => {
            encode_encrypted_upload_v2_transfer_packet(&fields)?
        }
        _ => return Err(unknown_packet(packet.kind)),
    };

    Ok(BotaDeviceSdkPacketV1::new(packet.kind).with_bytes(field_id::VALUE, bytes))
}

fn encode_encrypted_upload_v2_transfer_packet(
    fields: &PacketFields<'_>,
) -> Result<Vec<u8>, DeviceSdkError> {
    let message_type = to_u8(fields, field_id::MESSAGE_TYPE)?;
    let common = CommonHeaderV2 {
        message_type,
        flags: 0,
        transport_session_id: fields.required_u64(field_id::TRANSPORT_SESSION_ID)?,
    };

    match message_type {
        wire::ENCRYPTED_UPLOAD_V2_LIST => {
            fields.validate_allowed(&[field_id::MESSAGE_TYPE, field_id::TRANSPORT_SESSION_ID])?;
            encode_encrypted_upload_v2_transfer(&EncryptedUploadV2Transfer::List(common))
        }
        wire::ENCRYPTED_UPLOAD_V2_START => {
            fields.validate_allowed(&[
                field_id::MESSAGE_TYPE,
                field_id::TRANSPORT_SESSION_ID,
                field_id::UPLOAD_SESSION_UUID,
                field_id::RECORDING_UUID,
                field_id::RECORDING_GENERATION,
                field_id::AUTHORIZATION_SHA256,
                field_id::CHECKPOINT_REVISION,
                field_id::OFFSET,
                field_id::PREFIX_SHA256,
                field_id::WINDOW_PACKETS,
                field_id::DATA_PAYLOAD_BYTES,
            ])?;
            let recording = recording(fields)?;
            encode_encrypted_upload_v2_transfer(&EncryptedUploadV2Transfer::Start(StartV2 {
                common,
                upload_session_uuid: fields.required_fixed_bytes(field_id::UPLOAD_SESSION_UUID)?,
                recording_uuid: *recording.as_bytes(),
                recording_generation: to_u32(fields, field_id::RECORDING_GENERATION)?,
                authorization_sha256: fields
                    .required_fixed_bytes(field_id::AUTHORIZATION_SHA256)?,
                checkpoint_revision: to_u32(fields, field_id::CHECKPOINT_REVISION)?,
                next_ciphertext_offset: fields.required_u64(field_id::OFFSET)?,
                prefix_sha256: fields.required_fixed_bytes(field_id::PREFIX_SHA256)?,
                window_packets: to_u16(fields, field_id::WINDOW_PACKETS)?,
                data_payload_bytes: to_u16(fields, field_id::DATA_PAYLOAD_BYTES)?,
            }))
        }
        wire::ENCRYPTED_UPLOAD_V2_WINDOW_ACK => {
            fields.validate_allowed(&[
                field_id::MESSAGE_TYPE,
                field_id::TRANSPORT_SESSION_ID,
                field_id::WINDOW_INDEX,
                field_id::SEQUENCE,
                field_id::OFFSET,
                field_id::PREFIX_SHA256,
                field_id::CHECKPOINT_REVISION,
                field_id::MISSING_SEQUENCE,
            ])?;
            let missing_sequences = fields
                .optional_bytes(field_id::MISSING_SEQUENCE)?
                .map(|bytes| decode_missing_sequences(&bytes))
                .transpose()?
                .unwrap_or_default();
            encode_encrypted_upload_v2_transfer(&EncryptedUploadV2Transfer::WindowAck(
                WindowAckV2 {
                    common,
                    window_index: to_u32(fields, field_id::WINDOW_INDEX)?,
                    highest_contiguous_sequence: to_u32(fields, field_id::SEQUENCE)?,
                    next_ciphertext_offset: fields.required_u64(field_id::OFFSET)?,
                    prefix_sha256: fields.required_fixed_bytes(field_id::PREFIX_SHA256)?,
                    checkpoint_revision: to_u32(fields, field_id::CHECKPOINT_REVISION)?,
                    missing_sequences,
                },
            ))
        }
        wire::ENCRYPTED_UPLOAD_V2_RESUME_REQUEST => {
            fields.validate_allowed(&[
                field_id::MESSAGE_TYPE,
                field_id::TRANSPORT_SESSION_ID,
                field_id::UPLOAD_SESSION_UUID,
                field_id::RECORDING_UUID,
                field_id::RECORDING_GENERATION,
                field_id::CHECKPOINT_REVISION,
                field_id::OFFSET,
                field_id::PREFIX_SHA256,
                field_id::WINDOW_PACKETS,
                field_id::DATA_PAYLOAD_BYTES,
            ])?;
            let recording = recording(fields)?;
            encode_encrypted_upload_v2_transfer(&EncryptedUploadV2Transfer::ResumeRequest(
                ResumeV2 {
                    common,
                    upload_session_uuid: fields
                        .required_fixed_bytes(field_id::UPLOAD_SESSION_UUID)?,
                    recording_uuid: *recording.as_bytes(),
                    recording_generation: to_u32(fields, field_id::RECORDING_GENERATION)?,
                    checkpoint_revision: to_u32(fields, field_id::CHECKPOINT_REVISION)?,
                    next_ciphertext_offset: fields.required_u64(field_id::OFFSET)?,
                    prefix_sha256: fields.required_fixed_bytes(field_id::PREFIX_SHA256)?,
                    window_packets: to_u16(fields, field_id::WINDOW_PACKETS)?,
                    data_payload_bytes: to_u16(fields, field_id::DATA_PAYLOAD_BYTES)?,
                },
            ))
        }
        wire::ENCRYPTED_UPLOAD_V2_CONFIRM => {
            fields.validate_allowed(&[
                field_id::MESSAGE_TYPE,
                field_id::TRANSPORT_SESSION_ID,
                field_id::UPLOAD_SESSION_UUID,
                field_id::RECORDING_UUID,
                field_id::RECORDING_GENERATION,
                field_id::OWNER_REVISION,
                field_id::RECEIPT_SHA256,
            ])?;
            let recording = recording(fields)?;
            encode_encrypted_upload_v2_transfer(&EncryptedUploadV2Transfer::Confirm(ConfirmV2 {
                common,
                upload_session_uuid: fields.required_fixed_bytes(field_id::UPLOAD_SESSION_UUID)?,
                recording_uuid: *recording.as_bytes(),
                recording_generation: to_u32(fields, field_id::RECORDING_GENERATION)?,
                owner_revision: to_u32(fields, field_id::OWNER_REVISION)?,
                receipt_sha256: fields.required_fixed_bytes(field_id::RECEIPT_SHA256)?,
            }))
        }
        wire::ENCRYPTED_UPLOAD_V2_ABORT => {
            fields.validate_allowed(&[
                field_id::MESSAGE_TYPE,
                field_id::TRANSPORT_SESSION_ID,
                field_id::DETAIL_CODE,
            ])?;
            encode_encrypted_upload_v2_transfer(&EncryptedUploadV2Transfer::Abort {
                common,
                reason: to_u16(fields, field_id::DETAIL_CODE)?,
            })
        }
        _ => Err(invalid(
            "unsupported encrypted upload v2 app transfer message type for encoding",
        )),
    }
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

fn encode_encrypted_upload_v2_signed_blob_packet(
    fields: &PacketFields<'_>,
) -> Result<Vec<u8>, DeviceSdkError> {
    let message_type = to_u8(fields, field_id::MESSAGE_TYPE)?;
    let kind = to_u8(fields, field_id::BLOB_KIND)?;
    let write_id = to_u32(fields, field_id::WRITE_ID)?;

    match message_type {
        0x60 => {
            fields.validate_allowed(&[
                field_id::MESSAGE_TYPE,
                field_id::BLOB_KIND,
                field_id::WRITE_ID,
                field_id::BODY_LENGTH,
                field_id::CONTENT_SHA256,
            ])?;
            encode_encrypted_upload_v2_signed_blob(&EncryptedUploadV2SignedBlob::Begin {
                kind,
                write_id,
                total_length: to_u16(fields, field_id::BODY_LENGTH)?,
                sha256: fields.required_fixed_bytes(field_id::CONTENT_SHA256)?,
            })
        }
        0x61 => {
            fields.validate_allowed(&[
                field_id::MESSAGE_TYPE,
                field_id::BLOB_KIND,
                field_id::WRITE_ID,
                field_id::OFFSET,
                field_id::VALUE,
            ])?;
            let data = fields.required_bytes(field_id::VALUE)?;
            encode_encrypted_upload_v2_signed_blob(&EncryptedUploadV2SignedBlob::Data {
                kind,
                write_id,
                offset: to_u16(fields, field_id::OFFSET)?,
                data: &data,
            })
        }
        0x62 => {
            fields.validate_allowed(&[
                field_id::MESSAGE_TYPE,
                field_id::BLOB_KIND,
                field_id::WRITE_ID,
            ])?;
            encode_encrypted_upload_v2_signed_blob(&EncryptedUploadV2SignedBlob::Commit {
                kind,
                write_id,
            })
        }
        0x63 => {
            fields.validate_allowed(&[
                field_id::MESSAGE_TYPE,
                field_id::BLOB_KIND,
                field_id::WRITE_ID,
            ])?;
            encode_encrypted_upload_v2_signed_blob(&EncryptedUploadV2SignedBlob::Abort {
                kind,
                write_id,
            })
        }
        _ => Err(invalid("unsupported signed blob message type for encoding")),
    }
}

fn decode_encrypted_upload_v2_signed_blob_packet(
    output: BotaDeviceSdkPacketV1,
    bytes: &[u8],
) -> Result<BotaDeviceSdkPacketV1, DeviceSdkError> {
    let output = output.with_u64(field_id::PROTOCOL_VARIANT, 2);
    Ok(match decode_encrypted_upload_v2_signed_blob(bytes)? {
        EncryptedUploadV2SignedBlob::Begin {
            kind,
            write_id,
            total_length,
            sha256,
        } => output
            .with_u64(field_id::MESSAGE_TYPE, 0x60)
            .with_u64(field_id::BLOB_KIND, u64::from(kind))
            .with_u64(field_id::WRITE_ID, u64::from(write_id))
            .with_u64(field_id::BODY_LENGTH, u64::from(total_length))
            .with_bytes(field_id::CONTENT_SHA256, sha256.to_vec()),
        EncryptedUploadV2SignedBlob::Data {
            kind,
            write_id,
            offset,
            data,
        } => output
            .with_u64(field_id::MESSAGE_TYPE, 0x61)
            .with_u64(field_id::BLOB_KIND, u64::from(kind))
            .with_u64(field_id::WRITE_ID, u64::from(write_id))
            .with_u64(field_id::OFFSET, u64::from(offset))
            .with_u64(field_id::BODY_LENGTH, data.len() as u64)
            .with_bytes(field_id::VALUE, data.to_vec()),
        EncryptedUploadV2SignedBlob::Commit { kind, write_id } => output
            .with_u64(field_id::MESSAGE_TYPE, 0x62)
            .with_u64(field_id::BLOB_KIND, u64::from(kind))
            .with_u64(field_id::WRITE_ID, u64::from(write_id)),
        EncryptedUploadV2SignedBlob::Abort { kind, write_id } => output
            .with_u64(field_id::MESSAGE_TYPE, 0x63)
            .with_u64(field_id::BLOB_KIND, u64::from(kind))
            .with_u64(field_id::WRITE_ID, u64::from(write_id)),
        EncryptedUploadV2SignedBlob::Result {
            kind,
            write_id,
            result,
        } => output
            .with_u64(field_id::MESSAGE_TYPE, 0x64)
            .with_u64(field_id::BLOB_KIND, u64::from(kind))
            .with_u64(field_id::WRITE_ID, u64::from(write_id))
            .with_u64(field_id::DETAIL_CODE, u64::from(result)),
    })
}

fn decode_encrypted_upload_v2_transfer_packet(
    output: BotaDeviceSdkPacketV1,
    bytes: &[u8],
) -> Result<BotaDeviceSdkPacketV1, DeviceSdkError> {
    let output = output.with_u64(field_id::PROTOCOL_VARIANT, 3);
    Ok(match decode_encrypted_upload_v2_transfer(bytes)? {
        EncryptedUploadV2Transfer::List(common) => {
            encrypted_v2_common(output, common).with_u64(field_id::REQUEST_FLAGS, 0)
        }
        EncryptedUploadV2Transfer::RecordingEntry(value) => {
            encrypted_v2_common(output, value.common)
                .with_text(field_id::RECORDING_UUID, uuid_text(&value.recording_uuid))
                .with_u64(
                    field_id::RECORDING_GENERATION,
                    u64::from(value.recording_generation),
                )
                .with_u64(field_id::STORAGE_FORMAT, u64::from(value.storage_format))
                .with_u64(
                    field_id::COMPLETION_STATE,
                    u64::from(value.completion_state),
                )
                .with_u64(field_id::TIMESTAMP, value.started_at)
                .with_u64(
                    field_id::DURATION_SECONDS,
                    u64::from(value.duration_seconds),
                )
                .with_u64(field_id::PLAINTEXT_LENGTH, value.plaintext_length)
                .with_u64(field_id::CIPHERTEXT_LENGTH, value.ciphertext_length)
                .with_bytes(
                    field_id::CIPHERTEXT_SHA256,
                    value.ciphertext_sha256.to_vec(),
                )
        }
        EncryptedUploadV2Transfer::RecordingListEnd {
            common,
            count,
            list_revision,
            list_sha256,
        } => encrypted_v2_common(output, common)
            .with_u64(field_id::RECORDING_COUNT, u64::from(count))
            .with_u64(field_id::LIST_REVISION, u64::from(list_revision))
            .with_bytes(field_id::CONTENT_SHA256, list_sha256.to_vec()),
        EncryptedUploadV2Transfer::Start(value) => encrypted_v2_common(output, value.common)
            .with_bytes(
                field_id::UPLOAD_SESSION_UUID,
                value.upload_session_uuid.to_vec(),
            )
            .with_text(field_id::RECORDING_UUID, uuid_text(&value.recording_uuid))
            .with_u64(
                field_id::RECORDING_GENERATION,
                u64::from(value.recording_generation),
            )
            .with_bytes(
                field_id::AUTHORIZATION_SHA256,
                value.authorization_sha256.to_vec(),
            )
            .with_u64(
                field_id::CHECKPOINT_REVISION,
                u64::from(value.checkpoint_revision),
            )
            .with_u64(field_id::OFFSET, value.next_ciphertext_offset)
            .with_bytes(field_id::PREFIX_SHA256, value.prefix_sha256.to_vec())
            .with_u64(field_id::WINDOW_PACKETS, u64::from(value.window_packets))
            .with_u64(
                field_id::DATA_PAYLOAD_BYTES,
                u64::from(value.data_payload_bytes),
            ),
        EncryptedUploadV2Transfer::StartAck(value) => encrypted_v2_common(output, value.common)
            .with_bytes(
                field_id::UPLOAD_SESSION_UUID,
                value.upload_session_uuid.to_vec(),
            )
            .with_text(field_id::RECORDING_UUID, uuid_text(&value.recording_uuid))
            .with_u64(
                field_id::RECORDING_GENERATION,
                u64::from(value.recording_generation),
            )
            .with_u64(field_id::CIPHERTEXT_LENGTH, value.ciphertext_length)
            .with_bytes(
                field_id::CIPHERTEXT_SHA256,
                value.ciphertext_sha256.to_vec(),
            )
            .with_u64(field_id::WINDOW_PACKETS, u64::from(value.window_packets))
            .with_u64(
                field_id::DATA_PAYLOAD_BYTES,
                u64::from(value.data_payload_bytes),
            )
            .with_u64(
                field_id::CHECKPOINT_INTERVAL,
                u64::from(value.checkpoint_interval_blocks),
            )
            .with_u64(
                field_id::CHECKPOINT_REVISION,
                u64::from(value.checkpoint_revision),
            )
            .with_u64(field_id::OFFSET, value.next_ciphertext_offset)
            .with_bytes(field_id::PREFIX_SHA256, value.prefix_sha256.to_vec()),
        EncryptedUploadV2Transfer::Data {
            common,
            sequence,
            offset,
            data,
        } => encrypted_v2_common(output, common)
            .with_u64(field_id::SEQUENCE, u64::from(sequence))
            .with_u64(field_id::OFFSET, offset)
            .with_u64(field_id::BODY_LENGTH, data.len() as u64)
            .with_bytes(field_id::VALUE, data.to_vec()),
        EncryptedUploadV2Transfer::WindowEnd(value) => encrypted_v2_common(output, value.common)
            .with_u64(field_id::WINDOW_INDEX, u64::from(value.window_index))
            .with_u64(field_id::FIRST_SEQUENCE, u64::from(value.first_sequence))
            .with_u64(field_id::LAST_SEQUENCE, u64::from(value.last_sequence))
            .with_u64(field_id::OFFSET, value.next_ciphertext_offset)
            .with_bytes(field_id::PREFIX_SHA256, value.prefix_sha256.to_vec())
            .with_u64(
                field_id::CHECKPOINT_REVISION,
                u64::from(value.checkpoint_revision),
            ),
        EncryptedUploadV2Transfer::WindowAck(value) => encrypted_v2_common(output, value.common)
            .with_u64(field_id::WINDOW_INDEX, u64::from(value.window_index))
            .with_u64(
                field_id::SEQUENCE,
                u64::from(value.highest_contiguous_sequence),
            )
            .with_u64(field_id::OFFSET, value.next_ciphertext_offset)
            .with_bytes(field_id::PREFIX_SHA256, value.prefix_sha256.to_vec())
            .with_u64(
                field_id::CHECKPOINT_REVISION,
                u64::from(value.checkpoint_revision),
            )
            .with_bytes(
                field_id::MISSING_SEQUENCE,
                pack_missing_sequences(&value.missing_sequences),
            ),
        EncryptedUploadV2Transfer::ManifestChunk(value) => {
            encrypted_v2_common(output, value.common)
                .with_u64(
                    field_id::MAX_MANIFEST_BYTES,
                    u64::from(value.total_manifest_length),
                )
                .with_u64(field_id::OFFSET, u64::from(value.chunk_offset))
                .with_u64(field_id::BODY_LENGTH, value.chunk.len() as u64)
                .with_bytes(field_id::MANIFEST_SHA256, value.manifest_sha256.to_vec())
                .with_bytes(field_id::VALUE, value.chunk.to_vec())
        }
        EncryptedUploadV2Transfer::Eof(value) => encrypted_v2_common(output, value.common)
            .with_u64(field_id::SEQUENCE, u64::from(value.final_sequence))
            .with_u64(field_id::BLOCK_COUNT, u64::from(value.block_count))
            .with_u64(field_id::CIPHERTEXT_LENGTH, value.ciphertext_length)
            .with_bytes(
                field_id::CIPHERTEXT_SHA256,
                value.ciphertext_sha256.to_vec(),
            )
            .with_bytes(field_id::MANIFEST_SHA256, value.manifest_sha256.to_vec()),
        EncryptedUploadV2Transfer::ResumeRequest(value)
        | EncryptedUploadV2Transfer::ResumeAccept(value) => {
            encrypted_v2_common(output, value.common)
                .with_bytes(
                    field_id::UPLOAD_SESSION_UUID,
                    value.upload_session_uuid.to_vec(),
                )
                .with_text(field_id::RECORDING_UUID, uuid_text(&value.recording_uuid))
                .with_u64(
                    field_id::RECORDING_GENERATION,
                    u64::from(value.recording_generation),
                )
                .with_u64(
                    field_id::CHECKPOINT_REVISION,
                    u64::from(value.checkpoint_revision),
                )
                .with_u64(field_id::OFFSET, value.next_ciphertext_offset)
                .with_bytes(field_id::PREFIX_SHA256, value.prefix_sha256.to_vec())
                .with_u64(field_id::WINDOW_PACKETS, u64::from(value.window_packets))
                .with_u64(
                    field_id::DATA_PAYLOAD_BYTES,
                    u64::from(value.data_payload_bytes),
                )
        }
        EncryptedUploadV2Transfer::ResumeReject(value) => encrypted_v2_common(output, value.common)
            .with_u64(field_id::DETAIL_CODE, u64::from(value.reason))
            .with_u64(
                field_id::CHECKPOINT_REVISION,
                u64::from(value.checkpoint_revision),
            )
            .with_u64(field_id::OFFSET, value.next_ciphertext_offset)
            .with_bytes(field_id::PREFIX_SHA256, value.prefix_sha256.to_vec()),
        EncryptedUploadV2Transfer::Confirm(value) => encrypted_v2_common(output, value.common)
            .with_bytes(
                field_id::UPLOAD_SESSION_UUID,
                value.upload_session_uuid.to_vec(),
            )
            .with_text(field_id::RECORDING_UUID, uuid_text(&value.recording_uuid))
            .with_u64(
                field_id::RECORDING_GENERATION,
                u64::from(value.recording_generation),
            )
            .with_u64(field_id::OWNER_REVISION, u64::from(value.owner_revision))
            .with_bytes(field_id::RECEIPT_SHA256, value.receipt_sha256.to_vec()),
        EncryptedUploadV2Transfer::Abort { common, reason } => {
            encrypted_v2_common(output, common).with_u64(field_id::DETAIL_CODE, u64::from(reason))
        }
        EncryptedUploadV2Transfer::Error {
            common,
            result,
            failed_message_type,
            checkpoint_revision,
        } => encrypted_v2_common(output, common)
            .with_u64(field_id::DETAIL_CODE, u64::from(result))
            .with_u64(field_id::COMMAND, u64::from(failed_message_type))
            .with_u64(
                field_id::CHECKPOINT_REVISION,
                u64::from(checkpoint_revision),
            ),
    })
}

fn encrypted_v2_common(
    output: BotaDeviceSdkPacketV1,
    common: CommonHeaderV2,
) -> BotaDeviceSdkPacketV1 {
    output
        .with_u64(field_id::MESSAGE_TYPE, u64::from(common.message_type))
        .with_u64(field_id::FLAGS, u64::from(common.flags))
        .with_u64(field_id::TRANSPORT_SESSION_ID, common.transport_session_id)
}

fn uuid_text(bytes: &[u8; 16]) -> String {
    let byte = |index: usize| bytes[index];
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        byte(0),
        byte(1),
        byte(2),
        byte(3),
        byte(4),
        byte(5),
        byte(6),
        byte(7),
        byte(8),
        byte(9),
        byte(10),
        byte(11),
        byte(12),
        byte(13),
        byte(14),
        byte(15),
    )
}

fn pack_missing_sequences(sequences: &[u32]) -> Vec<u8> {
    sequences
        .iter()
        .flat_map(|sequence| sequence.to_le_bytes())
        .collect()
}

fn validate_packet(packet: &BotaDeviceSdkPacketViewV1) -> Result<(), DeviceSdkError> {
    if packet.abi_version != ABI_VERSION {
        return Err(invalid("unsupported ABI version"));
    }
    if packet.operation != 0
        || packet.reserved != 0
        || packet.request_id != 0
        || packet.cancellation_id_high != 0
        || packet.cancellation_id_low != 0
    {
        return Err(invalid("protocol packet metadata must be zero"));
    }
    Ok(())
}

fn device_flags(flags: DeviceFlags) -> u8 {
    u8::from(flags.charging)
        | (u8::from(flags.low_battery) << 1)
        | (u8::from(flags.storage_full) << 2)
        | (u8::from(flags.wifi_connected) << 3)
        | (u8::from(flags.lte_connected) << 4)
        | (u8::from(flags.sync_active) << 5)
}

fn optional_text(
    packet: BotaDeviceSdkPacketV1,
    id: u32,
    value: Option<String>,
) -> BotaDeviceSdkPacketV1 {
    match value {
        Some(value) => packet.with_text(id, value),
        None => packet,
    }
}

fn optional_u64(
    packet: BotaDeviceSdkPacketV1,
    id: u32,
    value: Option<u64>,
) -> BotaDeviceSdkPacketV1 {
    match value {
        Some(value) => packet.with_u64(id, value),
        None => packet,
    }
}

const fn ack_type_code(value: AckType) -> u64 {
    match value {
        AckType::Ack => 1,
        AckType::Nack => 2,
        AckType::Abort => 3,
    }
}

fn ack_type(value: u64) -> Result<AckType, DeviceSdkError> {
    match value {
        1 => Ok(AckType::Ack),
        2 => Ok(AckType::Nack),
        3 => Ok(AckType::Abort),
        _ => Err(invalid("unknown acknowledgement type")),
    }
}

fn recording(fields: &PacketFields<'_>) -> Result<RecordingUuid, DeviceSdkError> {
    fields.required_text(field_id::RECORDING_UUID)?.parse()
}

fn to_u8(fields: &PacketFields<'_>, id: u32) -> Result<u8, DeviceSdkError> {
    fields
        .required_u64(id)?
        .try_into()
        .map_err(|_| invalid(format!("field {id} does not fit in 8 bits")))
}

fn optional_u8(fields: &PacketFields<'_>, id: u32) -> Result<Option<u8>, DeviceSdkError> {
    fields
        .optional_u64(id)?
        .map(|value| {
            value
                .try_into()
                .map_err(|_| invalid(format!("field {id} does not fit in 8 bits")))
        })
        .transpose()
}

fn to_u16(fields: &PacketFields<'_>, id: u32) -> Result<u16, DeviceSdkError> {
    fields
        .required_u64(id)?
        .try_into()
        .map_err(|_| invalid(format!("field {id} does not fit in 16 bits")))
}

fn to_i16(fields: &PacketFields<'_>, id: u32) -> Result<i16, DeviceSdkError> {
    fields
        .required_i64(id)?
        .try_into()
        .map_err(|_| invalid(format!("field {id} does not fit in 16 bits")))
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

fn to_u32(fields: &PacketFields<'_>, id: u32) -> Result<u32, DeviceSdkError> {
    fields
        .required_u64(id)?
        .try_into()
        .map_err(|_| invalid(format!("field {id} does not fit in 32 bits")))
}

fn to_usize(fields: &PacketFields<'_>, id: u32) -> Result<usize, DeviceSdkError> {
    fields
        .required_u64(id)?
        .try_into()
        .map_err(|_| invalid(format!("field {id} does not fit on this platform")))
}

fn timeout(
    fields: &PacketFields<'_>,
    id: u32,
    default_seconds: i32,
) -> Result<IdleTimeout, DeviceSdkError> {
    let seconds = fields
        .optional_i64(id)?
        .unwrap_or(i64::from(default_seconds))
        .try_into()
        .map_err(|_| invalid(format!("field {id} timeout is out of range")))?;
    IdleTimeout::try_from_seconds(seconds)
}

fn unknown_packet(kind: u32) -> DeviceSdkError {
    DeviceSdkError::new(ErrorCode::UnknownPacket, Operation::Decode, false)
        .with_detail(format!("unknown protocol packet kind 0x{kind:04x}"))
}

fn invalid(detail: impl Into<String>) -> DeviceSdkError {
    DeviceSdkError::new(ErrorCode::InvalidInput, Operation::Decode, false).with_detail(detail)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::BotaDeviceSdkFieldViewV1;

    fn packet(kind: u32) -> BotaDeviceSdkPacketV1 {
        BotaDeviceSdkPacketV1::new(kind)
    }

    #[test]
    fn every_declared_decode_and_encode_kind_calls_the_core_codec() {
        let decode_cases = vec![
            packet(packet_kind::PROTOCOL_DECODE_ENCRYPTED_UPLOAD_V2_CAPABILITY).with_bytes(
                field_id::VALUE,
                hex("010218007f00000000040004f40010000800000010000000"),
            ),
            packet(packet_kind::PROTOCOL_DECODE_ENCRYPTED_UPLOAD_V2_SIGNED_BLOB)
                .with_bytes(field_id::VALUE, hex("6202010004030201")),
            packet(packet_kind::PROTOCOL_DECODE_ENCRYPTED_UPLOAD_V2_TRANSFER_OR_STATUS)
                .with_bytes(field_id::VALUE, hex("25020000665544332211000000000000")),
            packet(packet_kind::PROTOCOL_DECODE_DEVICE_STATUS)
                .with_bytes(field_id::VALUE, hex("3200000200000000290004000163")),
            packet(packet_kind::PROTOCOL_DECODE_RECORDING_LIST)
                .with_bytes(field_id::VALUE, Vec::new()),
            packet(packet_kind::PROTOCOL_DECODE_TRANSFER_PACKET)
                .with_bytes(field_id::VALUE, hex("0134120300aabbcc")),
            packet(packet_kind::PROTOCOL_DECODE_TRIGGER_UPLOAD_RESPONSE)
                .with_bytes(field_id::VALUE, hex("0300")),
            packet(packet_kind::PROTOCOL_DECODE_ACK).with_bytes(field_id::VALUE, hex("103412")),
            packet(packet_kind::PROTOCOL_DECODE_FIRMWARE_STATUS)
                .with_bytes(field_id::VALUE, hex("0802")),
            packet(packet_kind::PROTOCOL_DECODE_WIFI_CONFIG_RESULT)
                .with_bytes(field_id::VALUE, hex("02")),
            packet(packet_kind::PROTOCOL_DECODE_FACTORY_RESET_RESULT)
                .with_bytes(field_id::VALUE, hex("000400")),
            packet(packet_kind::PROTOCOL_DECODE_CONNECTION_SETTINGS)
                .with_bytes(field_id::VALUE, hex("0203010203ff00003c810000")),
            packet(packet_kind::PROTOCOL_DECODE_DEVICE_LOGS)
                .with_bytes(field_id::VALUE, hex("0000006c696e650a")),
            packet(packet_kind::PROTOCOL_DECODE_WIFI_STATUS)
                .with_bytes(field_id::VALUE, hex("025704426f7461")),
            packet(packet_kind::PROTOCOL_DECODE_WIFI_SCAN)
                .with_bytes(field_id::VALUE, hex("020104426f74616403")),
            packet(packet_kind::PROTOCOL_DECODE_RECORDING_STATE)
                .with_bytes(field_id::VALUE, hex("010100112233445566778899aabbccddeeff")),
            packet(packet_kind::PROTOCOL_DECODE_RECORDING_CONTROL_RESULT)
                .with_bytes(field_id::VALUE, hex("000000000004")),
        ];
        let mut logs = DeviceLogDecoder::default();
        for (index, input) in decode_cases.iter().enumerate() {
            let output = unsafe { decode(&input.view(), &mut logs) };
            assert!(output.is_ok(), "decode case {index}");
            assert_eq!(output.unwrap().view().kind, input.view().kind);
        }

        let encode_cases = vec![
            packet(packet_kind::PROTOCOL_ENCODE_ACK)
                .with_u64(field_id::ACK_TYPE, 1)
                .with_u64(field_id::SEQUENCE, 0x1234),
            packet(packet_kind::PROTOCOL_ENCODE_TRANSFER_COMMAND).with_u64(field_id::COMMAND, 1),
            packet(packet_kind::PROTOCOL_ENCODE_DEVICE_COMMAND).with_u64(field_id::COMMAND, 1),
            packet(packet_kind::PROTOCOL_ENCODE_FIRMWARE_UPLOAD_START)
                .with_u64(field_id::FIRMWARE_SIZE_BYTES, 1_000),
            packet(packet_kind::PROTOCOL_ENCODE_FIRMWARE_DATA)
                .with_u64(field_id::SEQUENCE, 7)
                .with_bytes(field_id::PAYLOAD, vec![0xaa, 0xbb]),
            packet(packet_kind::PROTOCOL_ENCODE_FIRMWARE_WINDOW_ACK)
                .with_u64(field_id::SEQUENCE, 7),
            packet(packet_kind::PROTOCOL_ENCODE_FIRMWARE_UPLOAD_VERIFY)
                .with_u64(field_id::FIRMWARE_CRC32, 0x1234_5678),
            packet(packet_kind::PROTOCOL_ENCODE_FIRMWARE_STATUS)
                .with_u64(field_id::COMMAND, 8)
                .with_u64(field_id::RESULT, 2),
            packet(packet_kind::PROTOCOL_ENCODE_CONNECTION_SETTINGS)
                .with_bool(field_id::ENABLED_WIFI, true)
                .with_bool(field_id::ENABLED_CELLULAR, true)
                .with_bytes(field_id::CONNECTION_TYPE, vec![1, 2, 3])
                .with_i64(field_id::CELLULAR_IDLE_TIMEOUT, -1)
                .with_i64(field_id::WIFI_IDLE_TIMEOUT, 0)
                .with_bool(field_id::STREAMING_ENABLED, false)
                .with_u64(field_id::STREAMING_FLUSH_INTERVAL, 60)
                .with_bool(field_id::HEARTBEAT_WIFI, true)
                .with_bool(field_id::HEARTBEAT_CELLULAR, false)
                .with_u64(field_id::DEVICE_MODEL, 1),
            packet(packet_kind::PROTOCOL_ENCODE_BOUNDED_PAYLOAD)
                .with_bytes(field_id::PAYLOAD, vec![1, 2])
                .with_u64(field_id::CAPACITY, 2),
            packet(packet_kind::PROTOCOL_ENCODE_WIFI_GRANT)
                .with_text(field_id::GRANT, "grant.test")
                .with_u64(field_id::CAPACITY, 64),
            packet(packet_kind::PROTOCOL_ENCODE_WIFI_SCAN),
            packet(packet_kind::PROTOCOL_ENCODE_PROVISIONING_CHUNKS)
                .with_bytes(field_id::PAYLOAD, vec![1, 2, 3])
                .with_u64(field_id::MTU, 20),
            packet(packet_kind::PROTOCOL_ENCODE_WIFI_CREDENTIALS)
                .with_text(field_id::WIFI_SSID, "Bota")
                .with_text(field_id::WIFI_PASSWORD, "secret"),
            packet(packet_kind::PROTOCOL_ENCODE_TIME_SYNC)
                .with_u64(field_id::TIMESTAMP, 1_725_000_000_321)
                .with_i64(field_id::OFFSET, -420),
            packet(packet_kind::PROTOCOL_ENCODE_RECORDING_CONTROL_COMMAND)
                .with_u64(field_id::COMMAND, 1),
            packet(packet_kind::PROTOCOL_ENCODE_ENCRYPTED_UPLOAD_V2_SIGNED_BLOB)
                .with_u64(field_id::MESSAGE_TYPE, 0x62)
                .with_u64(field_id::BLOB_KIND, 1)
                .with_u64(field_id::WRITE_ID, 0x0102_0304),
            packet(packet_kind::PROTOCOL_ENCODE_ENCRYPTED_UPLOAD_V2_TRANSFER)
                .with_u64(field_id::MESSAGE_TYPE, 0x25)
                .with_u64(field_id::TRANSPORT_SESSION_ID, 1),
        ];
        for (index, input) in encode_cases.iter().enumerate() {
            let output = unsafe { encode(&input.view()) };
            assert!(output.is_ok(), "encode case {index}");
            assert_eq!(output.unwrap().view().kind, input.view().kind);
        }
    }

    #[test]
    fn encrypted_upload_v2_signed_blob_encode_uses_the_core_codec() {
        let cases = [
            (
                packet(packet_kind::PROTOCOL_ENCODE_ENCRYPTED_UPLOAD_V2_SIGNED_BLOB)
                    .with_u64(field_id::MESSAGE_TYPE, 0x60)
                    .with_u64(field_id::BLOB_KIND, 1)
                    .with_u64(field_id::WRITE_ID, 0x0102_0304)
                    .with_u64(field_id::BODY_LENGTH, 408)
                    .with_bytes(field_id::CONTENT_SHA256, vec![0x11; 32]),
                format!("60020100040302019801{}", "11".repeat(32)),
            ),
            (
                packet(packet_kind::PROTOCOL_ENCODE_ENCRYPTED_UPLOAD_V2_SIGNED_BLOB)
                    .with_u64(field_id::MESSAGE_TYPE, 0x61)
                    .with_u64(field_id::BLOB_KIND, 1)
                    .with_u64(field_id::WRITE_ID, 0x0102_0304)
                    .with_u64(field_id::OFFSET, 7)
                    .with_bytes(field_id::VALUE, vec![0xaa, 0xbb]),
                "610201000403020107000200aabb".to_owned(),
            ),
            (
                packet(packet_kind::PROTOCOL_ENCODE_ENCRYPTED_UPLOAD_V2_SIGNED_BLOB)
                    .with_u64(field_id::MESSAGE_TYPE, 0x62)
                    .with_u64(field_id::BLOB_KIND, 1)
                    .with_u64(field_id::WRITE_ID, 0x0102_0304),
                "6202010004030201".to_owned(),
            ),
            (
                packet(packet_kind::PROTOCOL_ENCODE_ENCRYPTED_UPLOAD_V2_SIGNED_BLOB)
                    .with_u64(field_id::MESSAGE_TYPE, 0x63)
                    .with_u64(field_id::BLOB_KIND, 2)
                    .with_u64(field_id::WRITE_ID, 0x0102_0304),
                "6302020004030201".to_owned(),
            ),
        ];

        for (input, expected) in cases {
            let output = unsafe { encode(&input.view()) }.unwrap();
            let fields = packet_fields(&output);
            assert_eq!(bytes(&fields, field_id::VALUE), hex(&expected));
        }
    }

    #[test]
    fn encrypted_upload_v2_signed_blob_encode_rejects_noncanonical_input() {
        let wrong_length = packet(packet_kind::PROTOCOL_ENCODE_ENCRYPTED_UPLOAD_V2_SIGNED_BLOB)
            .with_u64(field_id::MESSAGE_TYPE, 0x60)
            .with_u64(field_id::BLOB_KIND, 1)
            .with_u64(field_id::WRITE_ID, 1)
            .with_u64(field_id::BODY_LENGTH, 407)
            .with_bytes(field_id::CONTENT_SHA256, vec![0x11; 32]);
        assert!(unsafe { encode(&wrong_length.view()) }.is_err());

        let unexpected = packet(packet_kind::PROTOCOL_ENCODE_ENCRYPTED_UPLOAD_V2_SIGNED_BLOB)
            .with_u64(field_id::MESSAGE_TYPE, 0x62)
            .with_u64(field_id::BLOB_KIND, 1)
            .with_u64(field_id::WRITE_ID, 1)
            .with_bytes(field_id::VALUE, vec![0xaa]);
        assert!(unsafe { encode(&unexpected.view()) }.is_err());
    }

    #[test]
    fn encrypted_upload_v2_transfer_encode_uses_the_core_codec_for_app_messages() {
        let session_id = 0x0000_1122_3344_5566;
        let upload_session_uuid = hex("101112131415161718191a1b1c1d1e1f");
        let recording_uuid = "00112233-4455-6677-8899-aabbccddeeff";
        let prefix = hex("e0e680b4ac7b3043263cd19a217ccd180508e9467006f75d86ed717814770c77");
        let cases = [
            (
                packet(packet_kind::PROTOCOL_ENCODE_ENCRYPTED_UPLOAD_V2_TRANSFER)
                    .with_u64(field_id::MESSAGE_TYPE, 0x25)
                    .with_u64(field_id::TRANSPORT_SESSION_ID, session_id),
                "25020000665544332211000000000000".to_owned(),
            ),
            (
                packet(packet_kind::PROTOCOL_ENCODE_ENCRYPTED_UPLOAD_V2_TRANSFER)
                    .with_u64(field_id::MESSAGE_TYPE, 0x20)
                    .with_u64(field_id::TRANSPORT_SESSION_ID, session_id)
                    .with_bytes(field_id::UPLOAD_SESSION_UUID, upload_session_uuid.clone())
                    .with_text(field_id::RECORDING_UUID, recording_uuid)
                    .with_u64(field_id::RECORDING_GENERATION, 9)
                    .with_bytes(
                        field_id::AUTHORIZATION_SHA256,
                        hex("d1d0f59c9251cb91f193aeca65c0340dce4bfc536faaba3f24dc89fa24d9eb44"),
                    )
                    .with_u64(field_id::CHECKPOINT_REVISION, 0)
                    .with_u64(field_id::OFFSET, 0)
                    .with_bytes(
                        field_id::PREFIX_SHA256,
                        hex("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
                    )
                    .with_u64(field_id::WINDOW_PACKETS, 16)
                    .with_u64(field_id::DATA_PAYLOAD_BYTES, 244),
                "200200006655443322110000101112131415161718191a1b1c1d1e1f00112233445566778899aabbccddeeff09000000d1d0f59c9251cb91f193aeca65c0340dce4bfc536faaba3f24dc89fa24d9eb44000000000000000000000000e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b8551000f400".to_owned(),
            ),
            (
                packet(packet_kind::PROTOCOL_ENCODE_ENCRYPTED_UPLOAD_V2_TRANSFER)
                    .with_u64(field_id::MESSAGE_TYPE, 0x21)
                    .with_u64(field_id::TRANSPORT_SESSION_ID, session_id)
                    .with_u64(field_id::WINDOW_INDEX, 2)
                    .with_u64(field_id::SEQUENCE, 12)
                    .with_u64(field_id::OFFSET, 48)
                    .with_bytes(field_id::PREFIX_SHA256, prefix.clone())
                    .with_u64(field_id::CHECKPOINT_REVISION, 3)
                    .with_bytes(field_id::MISSING_SEQUENCE, hex("0d0000000f000000")),
                "210200006655443322110000020000000c0000003000000000000000e0e680b4ac7b3043263cd19a217ccd180508e9467006f75d86ed717814770c7703000000020000000d0000000f000000".to_owned(),
            ),
            (
                packet(packet_kind::PROTOCOL_ENCODE_ENCRYPTED_UPLOAD_V2_TRANSFER)
                    .with_u64(field_id::MESSAGE_TYPE, 0x22)
                    .with_u64(field_id::TRANSPORT_SESSION_ID, session_id)
                    .with_bytes(field_id::UPLOAD_SESSION_UUID, upload_session_uuid.clone())
                    .with_text(field_id::RECORDING_UUID, recording_uuid)
                    .with_u64(field_id::RECORDING_GENERATION, 9)
                    .with_u64(field_id::CHECKPOINT_REVISION, 3)
                    .with_u64(field_id::OFFSET, 64)
                    .with_bytes(field_id::PREFIX_SHA256, prefix.clone())
                    .with_u64(field_id::WINDOW_PACKETS, 16)
                    .with_u64(field_id::DATA_PAYLOAD_BYTES, 244),
                "220200006655443322110000101112131415161718191a1b1c1d1e1f00112233445566778899aabbccddeeff09000000030000004000000000000000e0e680b4ac7b3043263cd19a217ccd180508e9467006f75d86ed717814770c771000f400".to_owned(),
            ),
            (
                packet(packet_kind::PROTOCOL_ENCODE_ENCRYPTED_UPLOAD_V2_TRANSFER)
                    .with_u64(field_id::MESSAGE_TYPE, 0x23)
                    .with_u64(field_id::TRANSPORT_SESSION_ID, session_id)
                    .with_bytes(field_id::UPLOAD_SESSION_UUID, upload_session_uuid)
                    .with_text(field_id::RECORDING_UUID, recording_uuid)
                    .with_u64(field_id::RECORDING_GENERATION, 9)
                    .with_u64(field_id::OWNER_REVISION, 3)
                    .with_bytes(
                        field_id::RECEIPT_SHA256,
                        hex("f8acd46a795a3f1cc599a8284d0f65543bb5b986fe721d735c6139ec028c20fc"),
                    ),
                "230200006655443322110000101112131415161718191a1b1c1d1e1f00112233445566778899aabbccddeeff0900000003000000f8acd46a795a3f1cc599a8284d0f65543bb5b986fe721d735c6139ec028c20fc".to_owned(),
            ),
            (
                packet(packet_kind::PROTOCOL_ENCODE_ENCRYPTED_UPLOAD_V2_TRANSFER)
                    .with_u64(field_id::MESSAGE_TYPE, 0x24)
                    .with_u64(field_id::TRANSPORT_SESSION_ID, session_id)
                    .with_u64(field_id::DETAIL_CODE, 0x0e),
                "2402000066554433221100000e000000".to_owned(),
            ),
        ];

        for (input, expected) in cases {
            let output = unsafe { encode(&input.view()) }.unwrap();
            let fields = packet_fields(&output);
            assert_eq!(bytes(&fields, field_id::VALUE), hex(&expected));
        }
    }

    #[test]
    fn encrypted_upload_v2_transfer_encode_rejects_non_app_and_noncanonical_input() {
        let device_data = packet(packet_kind::PROTOCOL_ENCODE_ENCRYPTED_UPLOAD_V2_TRANSFER)
            .with_u64(field_id::MESSAGE_TYPE, 0x41)
            .with_u64(field_id::TRANSPORT_SESSION_ID, 7);
        assert!(unsafe { encode(&device_data.view()) }.is_err());

        let malformed_missing = packet(packet_kind::PROTOCOL_ENCODE_ENCRYPTED_UPLOAD_V2_TRANSFER)
            .with_u64(field_id::MESSAGE_TYPE, 0x21)
            .with_u64(field_id::TRANSPORT_SESSION_ID, 7)
            .with_u64(field_id::WINDOW_INDEX, 2)
            .with_u64(field_id::SEQUENCE, 12)
            .with_u64(field_id::OFFSET, 48)
            .with_bytes(field_id::PREFIX_SHA256, vec![0x11; 32])
            .with_u64(field_id::CHECKPOINT_REVISION, 3)
            .with_bytes(field_id::MISSING_SEQUENCE, vec![0x0d]);
        assert!(unsafe { encode(&malformed_missing.view()) }.is_err());

        let confirm = |input: BotaDeviceSdkPacketV1| {
            input
                .with_u64(field_id::MESSAGE_TYPE, 0x23)
                .with_u64(field_id::TRANSPORT_SESSION_ID, 7)
                .with_text(
                    field_id::RECORDING_UUID,
                    "00112233-4455-6677-8899-aabbccddeeff",
                )
                .with_u64(field_id::RECORDING_GENERATION, 9)
                .with_u64(field_id::OWNER_REVISION, 3)
                .with_bytes(field_id::RECEIPT_SHA256, vec![0x22; 32])
        };
        let text_upload_session = confirm(
            packet(packet_kind::PROTOCOL_ENCODE_ENCRYPTED_UPLOAD_V2_TRANSFER).with_text(
                field_id::UPLOAD_SESSION_UUID,
                "10111213-1415-1617-1819-1a1b1c1d1e1f",
            ),
        );
        assert!(unsafe { encode(&text_upload_session.view()) }.is_err());
        let short_upload_session = confirm(
            packet(packet_kind::PROTOCOL_ENCODE_ENCRYPTED_UPLOAD_V2_TRANSFER)
                .with_bytes(field_id::UPLOAD_SESSION_UUID, vec![0x10; 15]),
        );
        assert!(unsafe { encode(&short_upload_session.view()) }.is_err());
    }

    #[test]
    fn encrypted_upload_v2_decode_exposes_only_normalized_framing_metadata() {
        let mut logs = DeviceLogDecoder::default();
        let capability = packet(packet_kind::PROTOCOL_DECODE_ENCRYPTED_UPLOAD_V2_CAPABILITY)
            .with_bytes(
                field_id::VALUE,
                hex("010218007f00000000040004f40010000800000010000000"),
            );
        let capability = unsafe { decode(&capability.view(), &mut logs) }.unwrap();
        let fields = packet_fields(&capability);
        assert_eq!(unsigned(&fields, field_id::PROTOCOL_VARIANT), 1);
        assert_eq!(unsigned(&fields, field_id::CAPABILITY_FLAGS), 0x7f);
        assert_eq!(unsigned(&fields, field_id::DATA_PAYLOAD_BYTES), 244);

        let blob = packet(packet_kind::PROTOCOL_DECODE_ENCRYPTED_UPLOAD_V2_SIGNED_BLOB)
            .with_bytes(field_id::VALUE, hex("610201000403020100000300aabbcc"));
        let blob = unsafe { decode(&blob.view(), &mut logs) }.unwrap();
        let fields = packet_fields(&blob);
        assert_eq!(unsigned(&fields, field_id::MESSAGE_TYPE), 0x61);
        assert_eq!(unsigned(&fields, field_id::BLOB_KIND), 1);
        assert_eq!(unsigned(&fields, field_id::WRITE_ID), 0x0102_0304);
        assert_eq!(bytes(&fields, field_id::VALUE), [0xaa, 0xbb, 0xcc]);

        let mut start = vec![0_u8; 128];
        start[0] = 0x20;
        start[1] = 2;
        start[4..12].copy_from_slice(&0x0000_1122_3344_5566_u64.to_le_bytes());
        start[12..28].copy_from_slice(&[0x10; 16]);
        start[28..44].copy_from_slice(&[
            0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd,
            0xee, 0xff,
        ]);
        start[44..48].copy_from_slice(&9_u32.to_le_bytes());
        start[48..80].copy_from_slice(&[0x77; 32]);
        start[92..124].copy_from_slice(&hex(
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        ));
        start[124..126].copy_from_slice(&16_u16.to_le_bytes());
        start[126..128].copy_from_slice(&244_u16.to_le_bytes());
        let transfer = packet(packet_kind::PROTOCOL_DECODE_ENCRYPTED_UPLOAD_V2_TRANSFER_OR_STATUS)
            .with_bytes(field_id::VALUE, start);
        let transfer = unsafe { decode(&transfer.view(), &mut logs) }.unwrap();
        let fields = packet_fields(&transfer);
        assert_eq!(unsigned(&fields, field_id::PROTOCOL_VARIANT), 3);
        assert_eq!(unsigned(&fields, field_id::MESSAGE_TYPE), 0x20);
        assert_eq!(
            unsigned(&fields, field_id::TRANSPORT_SESSION_ID),
            0x0000_1122_3344_5566
        );
        assert_eq!(
            text(&fields, field_id::RECORDING_UUID),
            "00112233-4455-6677-8899-aabbccddeeff"
        );
        assert_eq!(bytes(&fields, field_id::AUTHORIZATION_SHA256), [0x77; 32]);
        let upload_session = fields
            .iter()
            .find(|field| field.field_id == field_id::UPLOAD_SESSION_UUID)
            .unwrap();
        assert_eq!(upload_session.field_type, crate::field_type::BYTES);
        assert_eq!(bytes(&fields, field_id::UPLOAD_SESSION_UUID), [0x10; 16]);

        let confirm = packet(packet_kind::PROTOCOL_DECODE_ENCRYPTED_UPLOAD_V2_TRANSFER_OR_STATUS)
            .with_bytes(
                field_id::VALUE,
                hex("230200006655443322110000101112131415161718191a1b1c1d1e1f00112233445566778899aabbccddeeff0900000003000000f8acd46a795a3f1cc599a8284d0f65543bb5b986fe721d735c6139ec028c20fc"),
            );
        let confirm = unsafe { decode(&confirm.view(), &mut logs) }.unwrap();
        let fields = packet_fields(&confirm);
        assert_eq!(unsigned(&fields, field_id::OWNER_REVISION), 3);
        assert!(
            fields
                .iter()
                .all(|field| field.field_id != field_id::WRITE_ID)
        );

        let status = packet(packet_kind::PROTOCOL_DECODE_ENCRYPTED_UPLOAD_V2_TRANSFER_OR_STATUS)
            .with_bytes(
                field_id::VALUE,
                hex("02030f006655443322110000400000000000000025030000"),
            );
        let status = unsafe { decode(&status.view(), &mut logs) }.unwrap();
        let fields = packet_fields(&status);
        assert_eq!(unsigned(&fields, field_id::PROTOCOL_VARIANT), 4);
        assert_eq!(unsigned(&fields, field_id::PHASE), 3);
        assert_eq!(unsigned(&fields, field_id::DETAIL_CODE), 15);
        assert_eq!(unsigned(&fields, field_id::DURABLE_CIPHERTEXT_BYTES), 64);
        assert_eq!(unsigned(&fields, field_id::PROGRESS_PERCENT), 37);
    }

    #[test]
    fn encrypted_upload_v2_window_ack_decode_encode_preserves_packed_missing_sequences() {
        let prefix = "e0e680b4ac7b3043263cd19a217ccd180508e9467006f75d86ed717814770c77";
        let cases = [
            (
                format!(
                    "21020000665544332211000002000000100000004000000000000000{prefix}0400000000000000"
                ),
                Vec::new(),
            ),
            (
                format!(
                    "210200006655443322110000020000000c0000003000000000000000{prefix}03000000010000000d000000"
                ),
                hex("0d000000"),
            ),
            (
                format!(
                    "210200006655443322110000020000000c0000003000000000000000{prefix}03000000020000000d0000000f000000"
                ),
                hex("0d0000000f000000"),
            ),
        ];
        let mut logs = DeviceLogDecoder::default();

        for (wire, expected_missing) in cases {
            let decoded =
                packet(packet_kind::PROTOCOL_DECODE_ENCRYPTED_UPLOAD_V2_TRANSFER_OR_STATUS)
                    .with_bytes(field_id::VALUE, hex(&wire));
            let decoded = unsafe { decode(&decoded.view(), &mut logs) }.unwrap();
            let fields = packet_fields(&decoded);
            let missing = fields
                .iter()
                .filter(|field| field.field_id == field_id::MISSING_SEQUENCE)
                .collect::<Vec<_>>();
            assert_eq!(missing.len(), 1);
            assert_eq!(missing[0].field_type, crate::field_type::BYTES);
            assert_eq!(bytes(&fields, field_id::MISSING_SEQUENCE), expected_missing);

            let encoded = packet(packet_kind::PROTOCOL_ENCODE_ENCRYPTED_UPLOAD_V2_TRANSFER)
                .with_u64(
                    field_id::MESSAGE_TYPE,
                    unsigned(&fields, field_id::MESSAGE_TYPE),
                )
                .with_u64(
                    field_id::TRANSPORT_SESSION_ID,
                    unsigned(&fields, field_id::TRANSPORT_SESSION_ID),
                )
                .with_u64(
                    field_id::WINDOW_INDEX,
                    unsigned(&fields, field_id::WINDOW_INDEX),
                )
                .with_u64(field_id::SEQUENCE, unsigned(&fields, field_id::SEQUENCE))
                .with_u64(field_id::OFFSET, unsigned(&fields, field_id::OFFSET))
                .with_bytes(
                    field_id::PREFIX_SHA256,
                    bytes(&fields, field_id::PREFIX_SHA256),
                )
                .with_u64(
                    field_id::CHECKPOINT_REVISION,
                    unsigned(&fields, field_id::CHECKPOINT_REVISION),
                )
                .with_bytes(
                    field_id::MISSING_SEQUENCE,
                    bytes(&fields, field_id::MISSING_SEQUENCE),
                );
            let encoded = unsafe { encode(&encoded.view()) }.unwrap();
            assert_eq!(bytes(&packet_fields(&encoded), field_id::VALUE), hex(&wire));
        }
    }

    #[test]
    fn encrypted_upload_v2_decode_rejects_unexpected_input_fields() {
        let input = packet(packet_kind::PROTOCOL_DECODE_ENCRYPTED_UPLOAD_V2_CAPABILITY)
            .with_bytes(
                field_id::VALUE,
                hex("010218007f00000000040004f40010000800000010000000"),
            )
            .with_u64(field_id::FLAGS, 0);
        let mut logs = DeviceLogDecoder::default();
        let error = match unsafe { decode(&input.view(), &mut logs) } {
            Ok(_) => panic!("unexpected field must be rejected"),
            Err(error) => error,
        };
        assert_eq!(error.code, ErrorCode::InvalidInput);
    }

    #[test]
    fn settings_encode_matches_the_frozen_fixture_bytes() {
        let input = packet(packet_kind::PROTOCOL_ENCODE_CONNECTION_SETTINGS)
            .with_bool(field_id::ENABLED_WIFI, true)
            .with_bool(field_id::ENABLED_CELLULAR, true)
            .with_bytes(field_id::CONNECTION_TYPE, vec![1, 2, 3])
            .with_i64(field_id::CELLULAR_IDLE_TIMEOUT, -1)
            .with_i64(field_id::WIFI_IDLE_TIMEOUT, 0)
            .with_bool(field_id::STREAMING_ENABLED, false)
            .with_u64(field_id::STREAMING_FLUSH_INTERVAL, 60)
            .with_bool(field_id::HEARTBEAT_WIFI, true)
            .with_bool(field_id::HEARTBEAT_CELLULAR, false)
            .with_u64(field_id::DEVICE_MODEL, 1);
        let output = unsafe { encode(&input.view()) }.unwrap();
        let view = output.view();
        let fields = unsafe { std::slice::from_raw_parts(view.fields, view.field_count as usize) };
        let bytes = fields[0].data;
        let bytes = unsafe { std::slice::from_raw_parts(bytes.data, bytes.len as usize) };
        assert_eq!(bytes, hex("0203010203ff00003c810000"));
    }

    #[test]
    fn recording_control_bridge_preserves_state_result_and_command_values() {
        let state = packet(packet_kind::PROTOCOL_DECODE_RECORDING_STATE)
            .with_bytes(field_id::VALUE, hex("010100112233445566778899aabbccddeeff"));
        let mut logs = DeviceLogDecoder::default();
        let state = unsafe { decode(&state.view(), &mut logs) }.unwrap();
        let state_fields = packet_fields(&state);
        assert_eq!(unsigned(&state_fields, field_id::RECORDING_ACTIVE), 1);
        assert_eq!(
            unsigned(&state_fields, field_id::RECORDING_INITIATED_REMOTELY),
            1
        );
        assert_eq!(
            text(&state_fields, field_id::RECORDING_UUID),
            "00112233-4455-6677-8899-aabbccddeeff"
        );

        let result = packet(packet_kind::PROTOCOL_DECODE_RECORDING_CONTROL_RESULT)
            .with_bytes(field_id::VALUE, hex("000000000004"));
        let result = unsafe { decode(&result.view(), &mut logs) }.unwrap();
        let result_fields = packet_fields(&result);
        assert_eq!(unsigned(&result_fields, field_id::RECORDING_SUCCESS), 0);
        assert_eq!(
            text(&result_fields, field_id::ERROR_DETAIL),
            "invalid_grant"
        );

        let command = packet(packet_kind::PROTOCOL_ENCODE_RECORDING_CONTROL_COMMAND)
            .with_u64(field_id::COMMAND, 1);
        let command = unsafe { encode(&command.view()) }.unwrap();
        assert_eq!(bytes(&packet_fields(&command), field_id::VALUE), [0x10]);
    }

    fn packet_fields(packet: &BotaDeviceSdkPacketV1) -> Vec<BotaDeviceSdkFieldViewV1> {
        let view = packet.view();
        unsafe { std::slice::from_raw_parts(view.fields, view.field_count as usize) }.to_vec()
    }

    fn unsigned(fields: &[BotaDeviceSdkFieldViewV1], id: u32) -> u64 {
        fields
            .iter()
            .find(|field| field.field_id == id)
            .unwrap()
            .unsigned_value
    }

    fn text(fields: &[BotaDeviceSdkFieldViewV1], id: u32) -> String {
        String::from_utf8(bytes(fields, id)).unwrap()
    }

    fn bytes(fields: &[BotaDeviceSdkFieldViewV1], id: u32) -> Vec<u8> {
        let value = fields
            .iter()
            .find(|field| field.field_id == id)
            .unwrap()
            .data;
        if value.len == 0 {
            return Vec::new();
        }
        unsafe { std::slice::from_raw_parts(value.data, value.len as usize) }.to_vec()
    }

    fn hex(value: &str) -> Vec<u8> {
        let (pairs, remainder) = value.as_bytes().as_chunks::<2>();
        assert!(remainder.is_empty());
        pairs
            .iter()
            .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
            .collect()
    }
}
