use crate::{
    error::{DeviceSdkError, ErrorCode, Operation},
    generated::protocol as wire,
};

/// Firmware must enforce encrypted reads and derive this value from the current
/// connection, not from a retained bond or the business pairing state.
pub fn validate_ble_link_security(bytes: &[u8]) -> Result<(), DeviceSdkError> {
    if bytes.len() != wire::BLE_LINK_SECURITY_FIXED_LENGTH
        || bytes[wire::BLE_LINK_SECURITY_VERSION_OFFSET] != wire::BLE_LINK_SECURITY_VERSION
        || bytes[wire::BLE_LINK_SECURITY_FLAGS_OFFSET] != wire::BLE_LINK_SECURITY_ENCRYPTED
        || bytes[wire::BLE_LINK_SECURITY_KEY_BYTES_OFFSET] != wire::BLE_LINK_SECURITY_KEY_BYTES
        || bytes[wire::BLE_LINK_SECURITY_RESERVED_OFFSET] != 0
    {
        return Err(
            DeviceSdkError::new(ErrorCode::ProtocolRejected, Operation::Connect, false)
                .with_detail("BLE link security is not ready"),
        );
    }
    Ok(())
}
