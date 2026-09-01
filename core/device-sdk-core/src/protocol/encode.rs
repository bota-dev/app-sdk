use crate::{
    error::{DeviceSdkError, ErrorCode, Operation},
    generated::protocol,
};

pub fn encode_bounded_payload(payload: &[u8], capacity: usize) -> Result<Vec<u8>, DeviceSdkError> {
    ensure_capacity(payload.len(), capacity)?;
    Ok(payload.to_vec())
}

pub fn encode_wifi_grant(grant_blob: &str, capacity: usize) -> Result<Vec<u8>, DeviceSdkError> {
    encode_bounded_payload(grant_blob.as_bytes(), capacity)
}

pub fn encode_wifi_scan_command() -> Result<Vec<u8>, DeviceSdkError> {
    Ok(vec![protocol::WIFI_SCAN_CMD_START])
}

pub fn encode_time_sync(
    epoch_milliseconds: u64,
    timezone_offset_minutes: i16,
) -> Result<Vec<u8>, DeviceSdkError> {
    let unix_seconds = epoch_milliseconds / 1_000;
    let unix_seconds = u32::try_from(unix_seconds).map_err(|_| {
        DeviceSdkError::new(ErrorCode::InvalidInput, Operation::Encode, false)
            .with_detail("time sync timestamp exceeds the firmware range")
    })?;
    let milliseconds = (epoch_milliseconds % 1_000) as u16;
    let mut packet = Vec::with_capacity(8);
    packet.extend_from_slice(&unix_seconds.to_le_bytes());
    packet.extend_from_slice(&milliseconds.to_le_bytes());
    packet.extend_from_slice(&timezone_offset_minutes.to_le_bytes());
    Ok(packet)
}

pub fn encode_wifi_credentials(ssid: &str, password: &str) -> Result<Vec<u8>, DeviceSdkError> {
    let ssid = ssid.as_bytes();
    let password = password.as_bytes();
    if ssid.is_empty() {
        if !password.is_empty() {
            return Err(invalid_wifi_credentials(
                "disconnect credentials must not include a password",
            ));
        }
        return Ok(vec![0]);
    }
    if ssid.contains(&0) || password.contains(&0) {
        return Err(invalid_wifi_credentials(
            "WiFi credentials must not contain NUL bytes",
        ));
    }
    if ssid.len() > protocol::WIFI_SSID_MAX_LENGTH {
        return Err(payload_too_large(
            ssid.len(),
            protocol::WIFI_SSID_MAX_LENGTH,
        ));
    }
    if password.len() > protocol::WIFI_PASSWORD_MAX_LENGTH {
        return Err(payload_too_large(
            password.len(),
            protocol::WIFI_PASSWORD_MAX_LENGTH,
        ));
    }

    let mut packet = Vec::with_capacity(2 + ssid.len() + password.len());
    packet.push(ssid.len() as u8);
    packet.extend_from_slice(ssid);
    packet.push(password.len() as u8);
    packet.extend_from_slice(password);
    Ok(packet)
}

pub fn encode_provisioning_chunks(
    payload: &[u8],
    mtu: usize,
) -> Result<Vec<Vec<u8>>, DeviceSdkError> {
    let data_capacity = mtu
        .checked_sub(7)
        .filter(|capacity| *capacity > 0)
        .ok_or_else(|| {
            DeviceSdkError::new(ErrorCode::InvalidInput, Operation::Encode, false)
                .with_detail("MTU must leave room for BLE and provisioning headers")
        })?;
    let total_chunks = payload.len().div_ceil(data_capacity);
    if total_chunks > usize::from(u8::MAX) {
        return Err(payload_too_large(
            payload.len(),
            data_capacity * usize::from(u8::MAX),
        ));
    }

    let total = total_chunks as u8;
    let mut chunks = Vec::with_capacity(total_chunks);
    for (index, data) in payload.chunks(data_capacity).enumerate() {
        let mut chunk = Vec::with_capacity(2 + data.len());
        chunk.push(index as u8);
        chunk.push(total);
        chunk.extend_from_slice(data);
        chunks.push(chunk);
    }
    Ok(chunks)
}

pub(super) fn ensure_capacity(
    payload_length: usize,
    capacity: usize,
) -> Result<(), DeviceSdkError> {
    if payload_length > capacity {
        return Err(payload_too_large(payload_length, capacity));
    }
    Ok(())
}

fn payload_too_large(length: usize, capacity: usize) -> DeviceSdkError {
    DeviceSdkError::new(ErrorCode::PayloadTooLarge, Operation::Encode, false).with_detail(format!(
        "payload has {length} bytes but capacity is {capacity}"
    ))
}

fn invalid_wifi_credentials(detail: &'static str) -> DeviceSdkError {
    DeviceSdkError::new(ErrorCode::InvalidInput, Operation::Encode, false).with_detail(detail)
}
