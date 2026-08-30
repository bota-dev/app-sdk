use crate::{error::DeviceSdkError, generated::protocol, model::FactoryResetResult};
use serde::{Deserialize, Serialize};

use super::cursor::Cursor;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum WiFiConfigResult {
    Success,
    InvalidGrant,
    GrantExpired,
    DecryptionError,
    StorageError,
    Unknown(u8),
}

impl WiFiConfigResult {
    pub const fn to_wire(self) -> u8 {
        match self {
            Self::Success => protocol::WIFI_CONFIG_SUCCESS,
            Self::InvalidGrant => protocol::WIFI_CONFIG_INVALID_GRANT,
            Self::GrantExpired => protocol::WIFI_CONFIG_GRANT_EXPIRED,
            Self::DecryptionError => protocol::WIFI_CONFIG_DECRYPTION_ERROR,
            Self::StorageError => protocol::WIFI_CONFIG_STORAGE_ERROR,
            Self::Unknown(value) => value,
        }
    }
}

pub fn parse_wifi_config_result(bytes: &[u8]) -> Result<WiFiConfigResult, DeviceSdkError> {
    let code = Cursor::new(bytes).u8(0)?;
    Ok(match code {
        protocol::WIFI_CONFIG_SUCCESS => WiFiConfigResult::Success,
        protocol::WIFI_CONFIG_INVALID_GRANT => WiFiConfigResult::InvalidGrant,
        protocol::WIFI_CONFIG_GRANT_EXPIRED => WiFiConfigResult::GrantExpired,
        protocol::WIFI_CONFIG_DECRYPTION_ERROR => WiFiConfigResult::DecryptionError,
        protocol::WIFI_CONFIG_STORAGE_ERROR => WiFiConfigResult::StorageError,
        value => WiFiConfigResult::Unknown(value),
    })
}

pub fn parse_factory_reset_result(bytes: &[u8]) -> Result<FactoryResetResult, DeviceSdkError> {
    let cursor = Cursor::new(bytes);
    cursor.require(3)?;
    Ok(FactoryResetResult {
        result_code: cursor.u8(0)?,
        deleted_recording_count: cursor.u16_le(1)?,
    })
}
