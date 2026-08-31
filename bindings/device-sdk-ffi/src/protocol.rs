use crate::{
    ABI_VERSION, BotaDeviceSdkPacketV1, BotaDeviceSdkPacketViewV1, command::PacketFields, field_id,
    packet_kind,
};
use bota_device_sdk_core::{
    error::{DeviceSdkError, ErrorCode, Operation},
    model::{
        DeviceConnectionSettings, DeviceFlags, DeviceModel, EnabledConnections,
        HeartbeatConnections, IdleTimeout, PowerManagement, RecordingUuid,
    },
    protocol::{
        AckType, DeviceCommand, DeviceLogDecoder, FirmwareStatus, TransferCommand, TransferPacket,
        WiFiScanUpdate, encode_ack, encode_bounded_payload, encode_connection_settings,
        encode_device_command, encode_firmware_data, encode_firmware_upload_start,
        encode_firmware_upload_verify, encode_firmware_window_ack, encode_ota_status,
        encode_provisioning_chunks, encode_transfer_command, encode_wifi_credentials,
        encode_wifi_grant, encode_wifi_scan_command, parse_ack, parse_connection_settings,
        parse_device_status, parse_factory_reset_result, parse_ota_status, parse_recording_list,
        parse_transfer_packet, parse_trigger_upload_response, parse_wifi_config_result,
        parse_wifi_scan_result, parse_wifi_status_info,
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
        _ => return Err(unknown_packet(packet.kind)),
    };

    Ok(BotaDeviceSdkPacketV1::new(packet.kind).with_bytes(field_id::VALUE, bytes))
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

    fn packet(kind: u32) -> BotaDeviceSdkPacketV1 {
        BotaDeviceSdkPacketV1::new(kind)
    }

    #[test]
    fn every_declared_decode_and_encode_kind_calls_the_core_codec() {
        let decode_cases = vec![
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
        ];
        for (index, input) in encode_cases.iter().enumerate() {
            let output = unsafe { encode(&input.view()) };
            assert!(output.is_ok(), "encode case {index}");
            assert_eq!(output.unwrap().view().kind, input.view().kind);
        }
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

    fn hex(value: &str) -> Vec<u8> {
        let (pairs, remainder) = value.as_bytes().as_chunks::<2>();
        assert!(remainder.is_empty());
        pairs
            .iter()
            .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
            .collect()
    }
}
