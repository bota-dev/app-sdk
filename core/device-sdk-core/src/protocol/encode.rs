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
