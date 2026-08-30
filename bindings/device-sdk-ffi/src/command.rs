use crate::{
    ABI_VERSION, BotaDeviceSdkFieldViewV1, BotaDeviceSdkPacketViewV1, field_id, field_type,
    packet_kind,
};
use bota_device_sdk_core::{
    engine::{Capability, CapabilitySet, Command},
    error::{DeviceSdkError, ErrorCode, Operation},
    model::{
        DeviceCandidate, DeviceSerialNumber, DurableFactoryResetResult, FactoryResetCommandId,
        FactoryResetResult, FirmwareImage, HostMaterialId, ReconnectHint, RecordingSinkId,
        RecordingUuid, UploadDestinationId, UploadSessionId,
    },
};
use std::{collections::BTreeSet, str::FromStr};

pub mod capability_bits {
    pub const BLE: u64 = 1 << 0;
    pub const TIMER: u64 = 1 << 1;
    pub const PERSISTENCE: u64 = 1 << 2;
    pub const SECURE_STORAGE: u64 = 1 << 3;
    pub const NETWORK_TRANSFER: u64 = 1 << 4;
    pub const PROGRESS: u64 = 1 << 5;
    pub const HOST_MATERIAL: u64 = 1 << 6;
    pub const RECORDING_SINK: u64 = 1 << 7;
    pub const FIRMWARE_BLOB: u64 = 1 << 8;

    pub const KNOWN: u64 = BLE
        | TIMER
        | PERSISTENCE
        | SECURE_STORAGE
        | NETWORK_TRANSFER
        | PROGRESS
        | HOST_MATERIAL
        | RECORDING_SINK
        | FIRMWARE_BLOB;
}

pub(crate) fn capabilities_from_bits(bits: u64) -> Result<CapabilitySet, DeviceSdkError> {
    let unknown = bits & !capability_bits::KNOWN;
    if unknown != 0 {
        return Err(invalid(format!("unknown capability bits: 0x{unknown:x}")));
    }

    let capabilities = [
        (capability_bits::BLE, Capability::Ble),
        (capability_bits::TIMER, Capability::Timer),
        (capability_bits::PERSISTENCE, Capability::Persistence),
        (capability_bits::SECURE_STORAGE, Capability::SecureStorage),
        (
            capability_bits::NETWORK_TRANSFER,
            Capability::NetworkTransfer,
        ),
        (capability_bits::PROGRESS, Capability::Progress),
        (capability_bits::HOST_MATERIAL, Capability::HostMaterial),
        (capability_bits::RECORDING_SINK, Capability::RecordingSink),
        (capability_bits::FIRMWARE_BLOB, Capability::FirmwareBlob),
    ]
    .into_iter()
    .filter_map(|(mask, capability)| (bits & mask != 0).then_some(capability));

    Ok(capabilities.collect())
}

pub(crate) unsafe fn command_from_packet(
    packet: &BotaDeviceSdkPacketViewV1,
) -> Result<Command, DeviceSdkError> {
    if packet.abi_version != ABI_VERSION {
        return Err(invalid(format!(
            "unsupported ABI version {}",
            packet.abi_version
        )));
    }
    if packet.operation != 0 || packet.reserved != 0 || packet.request_id != 0 {
        return Err(invalid(
            "command packet operation, reserved, and request_id must be zero",
        ));
    }

    let fields = unsafe { PacketFields::new(packet.fields, packet.field_count)? };
    let serial = || {
        fields
            .required_text(field_id::SERIAL_NUMBER)
            .and_then(DeviceSerialNumber::new)
    };

    match packet.kind {
        packet_kind::COMMAND_DISCOVER_DEVICES => {
            fields.validate_allowed(&[field_id::TIMEOUT_MS, field_id::ALLOW_DUPLICATES])?;
            Ok(Command::DiscoverDevices {
                timeout_ms: fields.required_u64(field_id::TIMEOUT_MS)?,
                allow_duplicates: fields.required_bool(field_id::ALLOW_DUPLICATES)?,
            })
        }
        packet_kind::COMMAND_CONNECT => {
            fields.validate_allowed(&[
                field_id::SERIAL_NUMBER,
                field_id::PERIPHERAL_ID,
                field_id::NAME,
                field_id::ADVERTISED_ADDRESS,
                field_id::RSSI,
            ])?;
            let rssi = i16::try_from(fields.required_i64(field_id::RSSI)?)
                .map_err(|_| invalid("RSSI does not fit in a signed 16-bit value"))?;
            Ok(Command::Connect {
                device: serial()?,
                candidate: DeviceCandidate {
                    peripheral_id: fields.required_text(field_id::PERIPHERAL_ID)?,
                    name: fields.optional_text(field_id::NAME)?,
                    advertised_address: fields.optional_text(field_id::ADVERTISED_ADDRESS)?,
                    rssi,
                },
            })
        }
        packet_kind::COMMAND_RECONNECT => {
            fields.validate_allowed(&[
                field_id::SERIAL_NUMBER,
                field_id::STORED_PERIPHERAL_ID,
                field_id::ADVERTISED_ADDRESS,
                field_id::STORED_NAME,
                field_id::SCAN_TIMEOUT_MS,
                field_id::CONNECTION_TIMEOUT_MS,
            ])?;
            let defaults = ReconnectHint::default();
            Ok(Command::Reconnect {
                device: serial()?,
                hint: ReconnectHint {
                    stored_peripheral_id: fields.optional_text(field_id::STORED_PERIPHERAL_ID)?,
                    advertised_address: fields.optional_text(field_id::ADVERTISED_ADDRESS)?,
                    stored_name: fields.optional_text(field_id::STORED_NAME)?,
                    scan_timeout_ms: fields
                        .optional_u64(field_id::SCAN_TIMEOUT_MS)?
                        .unwrap_or(defaults.scan_timeout_ms),
                    connection_timeout_ms: fields
                        .optional_u64(field_id::CONNECTION_TIMEOUT_MS)?
                        .unwrap_or(defaults.connection_timeout_ms),
                },
            })
        }
        packet_kind::COMMAND_PROVISION => {
            fields.validate_allowed(&[field_id::SERIAL_NUMBER, field_id::MATERIAL_ID])?;
            Ok(Command::Provision {
                device: serial()?,
                material_id: HostMaterialId::new(fields.required_text(field_id::MATERIAL_ID)?)?,
            })
        }
        packet_kind::COMMAND_TRANSFER_RECORDING => {
            fields.validate_allowed(&[
                field_id::SERIAL_NUMBER,
                field_id::RECORDING_UUID,
                field_id::SINK_ID,
                field_id::TOTAL_UNITS,
            ])?;
            Ok(Command::TransferRecording {
                device: serial()?,
                recording: RecordingUuid::from_str(
                    &fields.required_text(field_id::RECORDING_UUID)?,
                )?,
                sink_id: RecordingSinkId::new(fields.required_text(field_id::SINK_ID)?)?,
                total_units: fields.required_u64(field_id::TOTAL_UNITS)?,
            })
        }
        packet_kind::COMMAND_UPLOAD_RECORDING => {
            fields.validate_allowed(&[
                field_id::SERIAL_NUMBER,
                field_id::RECORDING_UUID,
                field_id::UPLOAD_ID,
                field_id::DESTINATION_ID,
            ])?;
            Ok(Command::UploadRecording {
                device: serial()?,
                recording: RecordingUuid::from_str(
                    &fields.required_text(field_id::RECORDING_UUID)?,
                )?,
                upload_id: UploadSessionId::new(fields.required_text(field_id::UPLOAD_ID)?)?,
                destination_id: UploadDestinationId::new(
                    fields.required_text(field_id::DESTINATION_ID)?,
                )?,
            })
        }
        packet_kind::COMMAND_UPDATE_FIRMWARE => {
            fields.validate_allowed(&[
                field_id::SERIAL_NUMBER,
                field_id::FIRMWARE_VERSION,
                field_id::FIRMWARE_SIZE_BYTES,
                field_id::FIRMWARE_CRC32,
                field_id::DOWNLOAD_ID,
                field_id::STORED_PERIPHERAL_ID,
                field_id::ADVERTISED_ADDRESS,
                field_id::STORED_NAME,
                field_id::SCAN_TIMEOUT_MS,
                field_id::CONNECTION_TIMEOUT_MS,
            ])?;
            let defaults = ReconnectHint::default();
            Ok(Command::UpdateFirmware {
                device: serial()?,
                image: FirmwareImage {
                    version: fields.required_text(field_id::FIRMWARE_VERSION)?,
                    size_bytes: fields
                        .required_u64(field_id::FIRMWARE_SIZE_BYTES)?
                        .try_into()
                        .map_err(|_| invalid("firmware size does not fit in 32 bits"))?,
                    crc32: fields
                        .required_u64(field_id::FIRMWARE_CRC32)?
                        .try_into()
                        .map_err(|_| invalid("firmware CRC32 does not fit in 32 bits"))?,
                },
                download_id: fields.required_u64(field_id::DOWNLOAD_ID)?,
                reconnect_hint: ReconnectHint {
                    stored_peripheral_id: fields.optional_text(field_id::STORED_PERIPHERAL_ID)?,
                    advertised_address: fields.optional_text(field_id::ADVERTISED_ADDRESS)?,
                    stored_name: fields.optional_text(field_id::STORED_NAME)?,
                    scan_timeout_ms: fields
                        .optional_u64(field_id::SCAN_TIMEOUT_MS)?
                        .unwrap_or(defaults.scan_timeout_ms),
                    connection_timeout_ms: fields
                        .optional_u64(field_id::CONNECTION_TIMEOUT_MS)?
                        .unwrap_or(defaults.connection_timeout_ms),
                },
            })
        }
        packet_kind::COMMAND_READ_DEVICE_LOGS => {
            fields.validate_allowed(&[field_id::SERIAL_NUMBER])?;
            Ok(Command::ReadDeviceLogs { device: serial()? })
        }
        packet_kind::COMMAND_FACTORY_RESET => {
            fields.validate_allowed(&[
                field_id::SERIAL_NUMBER,
                field_id::COMMAND_ID,
                field_id::GRANT_ID,
            ])?;
            Ok(Command::FactoryReset {
                device: serial()?,
                command_id: FactoryResetCommandId::new(
                    fields.required_text(field_id::COMMAND_ID)?,
                )?,
                grant_id: HostMaterialId::new(fields.required_text(field_id::GRANT_ID)?)?,
            })
        }
        packet_kind::COMMAND_RESUME_FACTORY_RESET => {
            fields.validate_allowed(&[
                field_id::SERIAL_NUMBER,
                field_id::COMMAND_ID,
                field_id::RESULT_CODE,
                field_id::DELETED_RECORDING_COUNT,
            ])?;
            Ok(Command::ResumeFactoryReset {
                device: serial()?,
                result: DurableFactoryResetResult {
                    command_id: FactoryResetCommandId::new(
                        fields.required_text(field_id::COMMAND_ID)?,
                    )?,
                    result: FactoryResetResult {
                        result_code: fields
                            .required_u64(field_id::RESULT_CODE)?
                            .try_into()
                            .map_err(|_| invalid("reset result code does not fit in 8 bits"))?,
                        deleted_recording_count: fields
                            .required_u64(field_id::DELETED_RECORDING_COUNT)?
                            .try_into()
                            .map_err(|_| {
                                invalid("deleted recording count does not fit in 16 bits")
                            })?,
                    },
                },
            })
        }
        _ => Err(
            DeviceSdkError::new(ErrorCode::UnknownPacket, Operation::Decode, false)
                .with_detail(format!("unknown command packet kind 0x{:04x}", packet.kind)),
        ),
    }
}

struct PacketFields<'a> {
    fields: &'a [BotaDeviceSdkFieldViewV1],
}

impl<'a> PacketFields<'a> {
    unsafe fn new(
        fields: *const BotaDeviceSdkFieldViewV1,
        field_count: u64,
    ) -> Result<Self, DeviceSdkError> {
        const MAX_FIELDS: usize = 64;
        let field_count = usize::try_from(field_count)
            .map_err(|_| invalid("field count does not fit on this platform"))?;
        if field_count > MAX_FIELDS {
            return Err(invalid("packet has more than 64 fields"));
        }
        if field_count != 0 && fields.is_null() {
            return Err(invalid("non-empty field list has a null pointer"));
        }
        let fields = if field_count == 0 {
            &[]
        } else {
            unsafe { std::slice::from_raw_parts(fields, field_count) }
        };
        let mut ids = BTreeSet::new();
        for field in fields {
            if !ids.insert(field.field_id) {
                return Err(invalid(format!(
                    "field {} appears more than once",
                    field.field_id
                )));
            }
            validate_field_shape(field)?;
        }
        Ok(Self { fields })
    }

    fn validate_allowed(&self, allowed: &[u32]) -> Result<(), DeviceSdkError> {
        if let Some(field) = self
            .fields
            .iter()
            .find(|field| !allowed.contains(&field.field_id))
        {
            return Err(invalid(format!(
                "field {} is not valid for this command",
                field.field_id
            )));
        }
        Ok(())
    }

    fn required_u64(&self, id: u32) -> Result<u64, DeviceSdkError> {
        self.field(id, field_type::UNSIGNED)
            .map(|field| field.unsigned_value)
            .ok_or_else(|| missing(id, field_type::UNSIGNED))
    }

    fn optional_u64(&self, id: u32) -> Result<Option<u64>, DeviceSdkError> {
        self.optional_field(id, field_type::UNSIGNED)
            .map(|field| field.map(|field| field.unsigned_value))
    }

    fn required_i64(&self, id: u32) -> Result<i64, DeviceSdkError> {
        self.field(id, field_type::SIGNED)
            .map(|field| field.signed_value)
            .ok_or_else(|| missing(id, field_type::SIGNED))
    }

    fn required_bool(&self, id: u32) -> Result<bool, DeviceSdkError> {
        self.field(id, field_type::BOOL)
            .map(|field| field.unsigned_value != 0)
            .ok_or_else(|| missing(id, field_type::BOOL))
    }

    fn required_text(&self, id: u32) -> Result<String, DeviceSdkError> {
        self.optional_text(id)?
            .ok_or_else(|| missing(id, field_type::UTF8))
    }

    fn optional_text(&self, id: u32) -> Result<Option<String>, DeviceSdkError> {
        let Some(field) = self.optional_field(id, field_type::UTF8)? else {
            return Ok(None);
        };
        let bytes = unsafe { borrowed_data(field)? };
        let value = std::str::from_utf8(bytes)
            .map_err(|_| invalid(format!("field {id} is not valid UTF-8")))?;
        Ok(Some(value.to_owned()))
    }

    fn optional_field(
        &self,
        id: u32,
        expected_type: u32,
    ) -> Result<Option<&BotaDeviceSdkFieldViewV1>, DeviceSdkError> {
        let Some(field) = self.fields.iter().find(|field| field.field_id == id) else {
            return Ok(None);
        };
        if field.field_type != expected_type {
            return Err(invalid(format!(
                "field {id} has type {}, expected {expected_type}",
                field.field_type
            )));
        }
        Ok(Some(field))
    }

    fn field(&self, id: u32, expected_type: u32) -> Option<&BotaDeviceSdkFieldViewV1> {
        self.fields
            .iter()
            .find(|field| field.field_id == id && field.field_type == expected_type)
    }
}

fn validate_field_shape(field: &BotaDeviceSdkFieldViewV1) -> Result<(), DeviceSdkError> {
    match field.field_type {
        field_type::UNSIGNED | field_type::SIGNED => {
            if !field.data.data.is_null() || field.data.len != 0 {
                return Err(invalid(format!(
                    "scalar field {} must not contain byte data",
                    field.field_id
                )));
            }
        }
        field_type::BOOL => {
            if field.unsigned_value > 1 || !field.data.data.is_null() || field.data.len != 0 {
                return Err(invalid(format!(
                    "Boolean field {} must contain 0 or 1 and no byte data",
                    field.field_id
                )));
            }
        }
        field_type::UTF8 | field_type::BYTES => {
            if field.data.len != 0 && field.data.data.is_null() {
                return Err(invalid(format!(
                    "data field {} has a null pointer with non-zero length",
                    field.field_id
                )));
            }
        }
        _ => {
            return Err(invalid(format!(
                "field {} has unknown type {}",
                field.field_id, field.field_type
            )));
        }
    }
    Ok(())
}

unsafe fn borrowed_data(field: &BotaDeviceSdkFieldViewV1) -> Result<&[u8], DeviceSdkError> {
    let len = usize::try_from(field.data.len)
        .map_err(|_| invalid(format!("field {} length is too large", field.field_id)))?;
    if len == 0 {
        Ok(&[])
    } else {
        Ok(unsafe { std::slice::from_raw_parts(field.data.data, len) })
    }
}

fn missing(id: u32, expected_type: u32) -> DeviceSdkError {
    invalid(format!(
        "required field {id} with type {expected_type} is missing"
    ))
}

fn invalid(detail: impl Into<String>) -> DeviceSdkError {
    DeviceSdkError::new(ErrorCode::InvalidInput, Operation::Decode, false).with_detail(detail)
}
