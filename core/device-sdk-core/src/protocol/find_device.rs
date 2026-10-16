use crate::error::{DeviceSdkError, ErrorCode, Operation};
use serde::Serialize;
fn invalid() -> DeviceSdkError {
    DeviceSdkError::new(ErrorCode::InvalidInput, Operation::Decode, false)
        .with_detail("invalid find-device frame")
}
pub fn encode_find_control(
    action: u8,
    seconds: u8,
    id: [u8; 16],
) -> Result<[u8; 20], DeviceSdkError> {
    if id == [0; 16]
        || !((action == 1 && (1..=30).contains(&seconds)) || (action == 2 && seconds == 0))
    {
        return Err(invalid());
    }
    let mut out = [0; 20];
    out[0] = 1;
    out[1] = action;
    out[2] = seconds;
    out[4..].copy_from_slice(&id);
    Ok(out)
}
pub fn parse_find_capabilities(bytes: &[u8]) -> Result<bool, DeviceSdkError> {
    if bytes.len() != 8
        || bytes[0] != 1
        || !matches!(bytes[1], 0 | 3)
        || bytes[2] != 30
        || bytes[3] != 10
        || bytes[4..] != [0; 4]
    {
        return Err(invalid());
    }
    Ok(bytes[1] == 3)
}
#[derive(Debug, Clone, Serialize)]
pub struct FindDeviceStatus {
    pub active: bool,
    pub result: u8,
    pub request_id: [u8; 16],
    pub remaining_ms: u32,
}
pub fn parse_find_status(bytes: &[u8]) -> Result<FindDeviceStatus, DeviceSdkError> {
    if bytes.len() != 24 || bytes[0] != 1 || bytes[1] > 1 || bytes[2] > 7 || bytes[3] != 0 {
        return Err(invalid());
    }
    let mut id = [0; 16];
    id.copy_from_slice(&bytes[4..20]);
    let remaining = u32::from_le_bytes(bytes[20..24].try_into().map_err(|_| invalid())?);
    if remaining > 30000 || (bytes[1] == 0 && remaining != 0) {
        return Err(invalid());
    }
    Ok(FindDeviceStatus {
        active: bytes[1] == 1,
        result: bytes[2],
        request_id: id,
        remaining_ms: remaining,
    })
}
