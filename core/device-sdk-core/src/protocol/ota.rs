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
    let sequence = if command == protocol::FIRMWARE_ACK {
        Some(cursor.u16_le(1)?)
    } else {
        None
    };
    Ok(FirmwareStatus {
        command,
        result: cursor.u8(1)?,
        sequence,
    })
}
