use crate::{
    error::{DeviceSdkError, ErrorCode, Operation},
    generated::protocol,
    model::RecordingUuid,
};

use super::{cursor::Cursor, encode::ensure_capacity};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AckType {
    Ack,
    Nack,
    Abort,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TransferCommand {
    List,
    Start(RecordingUuid),
    TriggerDeviceUpload,
    Confirm(RecordingUuid),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DeviceCommand {
    Deprovision,
    FactoryReset,
    FactoryResetReceipt,
}

pub fn encode_ack(ack_type: AckType, sequence: u16) -> Result<Vec<u8>, DeviceSdkError> {
    let command = match ack_type {
        AckType::Ack => protocol::ACK_TYPE_ACK,
        AckType::Nack => protocol::ACK_TYPE_NACK,
        AckType::Abort => protocol::ACK_TYPE_ABORT,
    };
    let mut bytes = Vec::with_capacity(3);
    bytes.push(command);
    bytes.extend_from_slice(&sequence.to_le_bytes());
    Ok(bytes)
}

pub fn parse_ack(bytes: &[u8]) -> Result<(AckType, u16), DeviceSdkError> {
    let cursor = Cursor::new(bytes);
    cursor.require(3)?;
    let code = cursor.u8(0)?;
    let ack_type = match code {
        protocol::ACK_TYPE_ACK => AckType::Ack,
        protocol::ACK_TYPE_NACK => AckType::Nack,
        protocol::ACK_TYPE_ABORT => AckType::Abort,
        _ => {
            return Err(
                DeviceSdkError::new(ErrorCode::UnknownPacket, Operation::Decode, false)
                    .with_protocol_status(u16::from(code))
                    .with_detail(format!("unknown acknowledgement type {code}")),
            );
        }
    };
    Ok((ack_type, cursor.u16_le(1)?))
}

pub fn encode_transfer_command(command: TransferCommand) -> Result<Vec<u8>, DeviceSdkError> {
    let (opcode, recording) = match command {
        TransferCommand::List => (protocol::TRANSFER_CMD_LIST, None),
        TransferCommand::Start(recording) => (protocol::TRANSFER_CMD_START, Some(recording)),
        TransferCommand::TriggerDeviceUpload => {
            (protocol::TRANSFER_CMD_TRIGGER_DEVICE_UPLOAD, None)
        }
        TransferCommand::Confirm(recording) => {
            (protocol::TRANSFER_CMD_CONFIRM_SYNC, Some(recording))
        }
    };
    let mut bytes = Vec::with_capacity(1 + usize::from(recording.is_some()) * 16);
    bytes.push(opcode);
    if let Some(recording) = recording {
        bytes.extend_from_slice(recording.as_bytes());
    }
    Ok(bytes)
}

pub fn encode_device_command(command: DeviceCommand) -> Result<Vec<u8>, DeviceSdkError> {
    Ok(vec![match command {
        DeviceCommand::Deprovision => protocol::DEVICE_CMD_BLE_DEPROVISION,
        DeviceCommand::FactoryReset => protocol::DEVICE_CMD_BLE_FACTORY_RESET,
        DeviceCommand::FactoryResetReceipt => protocol::DEVICE_CMD_BLE_FACTORY_RESET_RESULT_ACK,
    }])
}

pub fn encode_firmware_upload_start(size: u32) -> Result<Vec<u8>, DeviceSdkError> {
    let mut bytes = Vec::with_capacity(protocol::FIRMWARE_UPLOAD_START_FIXED_LENGTH);
    bytes.push(protocol::FIRMWARE_UPLOAD_START);
    bytes.extend_from_slice(&size.to_le_bytes());
    Ok(bytes)
}

pub fn encode_firmware_data(sequence: u16, payload: &[u8]) -> Result<Vec<u8>, DeviceSdkError> {
    ensure_capacity(payload.len(), protocol::FIRMWARE_CHUNK_SIZE)?;
    let mut bytes =
        Vec::with_capacity(protocol::FIRMWARE_DATA_PACKET_MINIMUM_LENGTH + payload.len());
    bytes.push(protocol::FIRMWARE_DATA);
    bytes.extend_from_slice(&sequence.to_le_bytes());
    bytes.extend_from_slice(payload);
    Ok(bytes)
}

pub fn encode_firmware_window_ack(sequence: u16) -> Result<Vec<u8>, DeviceSdkError> {
    let mut bytes = Vec::with_capacity(3);
    bytes.push(protocol::FIRMWARE_ACK);
    bytes.extend_from_slice(&sequence.to_le_bytes());
    Ok(bytes)
}

pub fn encode_firmware_upload_verify(crc32: u32) -> Result<Vec<u8>, DeviceSdkError> {
    let mut bytes = Vec::with_capacity(protocol::FIRMWARE_UPLOAD_VERIFY_FIXED_LENGTH);
    bytes.push(protocol::FIRMWARE_UPLOAD_VERIFY);
    bytes.extend_from_slice(&crc32.to_le_bytes());
    Ok(bytes)
}
