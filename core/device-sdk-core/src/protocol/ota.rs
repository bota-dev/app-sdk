use crate::{error::DeviceSdkError, generated::protocol};
use serde::{Deserialize, Serialize};

use super::cursor::Cursor;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct FirmwareStatus {
    pub command: u8,
    pub result: u8,
    pub sequence: Option<u16>,
}

pub fn parse_ota_status(bytes: &[u8]) -> Result<FirmwareStatus, DeviceSdkError> {
    let cursor = Cursor::new(bytes);
    cursor.require(2)?;
    let command = cursor.u8(0)?;
    let (result, sequence) = if command == protocol::FIRMWARE_ACK {
        (0, Some(cursor.u16_le(1)?))
    } else {
        (cursor.u8(1)?, None)
    };
    Ok(FirmwareStatus {
        command,
        result,
        sequence,
    })
}

pub fn encode_ota_status(status: FirmwareStatus) -> Result<Vec<u8>, DeviceSdkError> {
    if status.command == protocol::FIRMWARE_ACK {
        let sequence = status.sequence.ok_or_else(|| {
            crate::error::DeviceSdkError::new(
                crate::error::ErrorCode::InvalidInput,
                crate::error::Operation::Encode,
                false,
            )
            .with_detail("firmware ACK requires a sequence")
        })?;
        let mut bytes = Vec::with_capacity(3);
        bytes.push(status.command);
        bytes.extend_from_slice(&sequence.to_le_bytes());
        return Ok(bytes);
    }
    Ok(vec![status.command, status.result])
}
