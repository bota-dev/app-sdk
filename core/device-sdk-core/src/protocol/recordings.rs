use crate::{
    error::{DeviceSdkError, ErrorCode, Operation},
    generated::protocol,
    model::{AudioCodec, DeviceRecording, RecordingUuid},
};
use serde::{Deserialize, Serialize};

use super::cursor::Cursor;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum TransferPacket {
    Data {
        sequence: u16,
        data: Vec<u8>,
    },
    Eof {
        sequence: u16,
        checksum: u32,
    },
    Paused {
        sequence: u16,
        bytes_sent: Option<u32>,
    },
    Sha256(Vec<u8>),
    E2eStart {
        ephemeral_public_key: Vec<u8>,
        salt: Vec<u8>,
    },
    EncryptedData {
        sequence: u16,
        chunk: Vec<u8>,
    },
    EncryptedEof {
        sequence: u16,
    },
    Error {
        sequence: u16,
        code: u8,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct TriggerUploadResponse {
    pub accepted: bool,
    pub error_code: Option<u8>,
}

pub fn parse_recording_list(bytes: &[u8]) -> Result<Vec<DeviceRecording>, DeviceSdkError> {
    let cursor = Cursor::new(bytes);
    let entry_size = protocol::RECORDING_ENTRY_FIXED_LENGTH;
    let mut offset = usize::from(cursor.len() > 0 && !cursor.len().is_multiple_of(entry_size));
    let mut recordings = Vec::new();

    while offset.saturating_add(entry_size) <= cursor.len() {
        let mut uuid = [0_u8; 16];
        uuid[..4].copy_from_slice(cursor.slice(offset, 4)?);
        recordings.push(DeviceRecording {
            uuid: RecordingUuid::from_bytes(uuid),
            encrypted: cursor.u8(offset + 4)? & 0x01 != 0,
            started_at_timestamp: cursor.u32_le(offset + 16)?,
            duration_ms: u64::from(cursor.u16_le(offset + 20)?) * 1_000,
            file_size_bytes: u64::from(cursor.u16_le(offset + 22)?) * 1_024,
            codec: AudioCodec::Opus16k,
        });
        offset += entry_size;
    }

    Ok(recordings)
}

pub fn parse_transfer_packet(bytes: &[u8]) -> Result<TransferPacket, DeviceSdkError> {
    let cursor = Cursor::new(bytes);
    cursor.require(protocol::TRANSFER_PACKET_MINIMUM_LENGTH)?;
    let packet_type = cursor.u8(0)?;
    let sequence = cursor.u16_le(1)?;

    match packet_type {
        protocol::PACKET_TYPE_DATA => Ok(TransferPacket::Data {
            sequence,
            data: if cursor.len() >= 5 {
                cursor.tail(5)?.to_vec()
            } else {
                Vec::new()
            },
        }),
        protocol::PACKET_TYPE_EOF => Ok(TransferPacket::Eof {
            sequence,
            checksum: cursor.u32_le(3)?,
        }),
        protocol::PACKET_TYPE_PAUSED => Ok(TransferPacket::Paused {
            sequence,
            bytes_sent: if cursor.len() >= 7 {
                Some(cursor.u32_le(3)?)
            } else {
                None
            },
        }),
        protocol::PACKET_TYPE_SHA256 => Ok(TransferPacket::Sha256(
            cursor.slice(1, protocol::SHA256_LENGTH)?.to_vec(),
        )),
        protocol::PACKET_TYPE_E2E_START => Ok(TransferPacket::E2eStart {
            ephemeral_public_key: cursor
                .slice(1, protocol::E2E_EPHEMERAL_PUBLIC_KEY_LENGTH)?
                .to_vec(),
            salt: cursor
                .slice(
                    1 + protocol::E2E_EPHEMERAL_PUBLIC_KEY_LENGTH,
                    protocol::E2E_SALT_LENGTH,
                )?
                .to_vec(),
        }),
        protocol::PACKET_TYPE_ENCRYPTED_DATA => Ok(TransferPacket::EncryptedData {
            sequence,
            chunk: if cursor.len() >= 5 {
                cursor.tail(5)?.to_vec()
            } else {
                Vec::new()
            },
        }),
        protocol::PACKET_TYPE_ENCRYPTED_EOF => Ok(TransferPacket::EncryptedEof { sequence }),
        protocol::PACKET_TYPE_ERROR => Ok(TransferPacket::Error {
            sequence,
            code: if cursor.len() > 3 {
                cursor.u8(3)?
            } else {
                u8::MAX
            },
        }),
        _ => Err(
            DeviceSdkError::new(ErrorCode::UnknownPacket, Operation::Decode, false)
                .with_protocol_status(u16::from(packet_type))
                .with_detail(format!("unknown transfer packet type {packet_type}")),
        ),
    }
}

pub fn parse_trigger_upload_response(
    bytes: &[u8],
) -> Result<Option<TriggerUploadResponse>, DeviceSdkError> {
    let cursor = Cursor::new(bytes);
    if cursor.len() < 2 || cursor.u8(0)? != protocol::TRANSFER_CMD_TRIGGER_DEVICE_UPLOAD {
        return Ok(None);
    }
    let code = cursor.u8(1)?;
    Ok(Some(TriggerUploadResponse {
        accepted: code == protocol::TRIGGER_UPLOAD_ACCEPTED,
        error_code: (code != protocol::TRIGGER_UPLOAD_ACCEPTED).then_some(code),
    }))
}
