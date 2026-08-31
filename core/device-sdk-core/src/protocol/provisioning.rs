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

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum WiFiStatus {
    Idle,
    Connecting,
    Connected,
    Failed,
    Disconnected,
    Unknown(u8),
}

impl WiFiStatus {
    pub const fn from_wire(value: u8) -> Self {
        match value {
            protocol::WIFI_STATUS_IDLE => Self::Idle,
            protocol::WIFI_STATUS_CONNECTING => Self::Connecting,
            protocol::WIFI_STATUS_CONNECTED => Self::Connected,
            protocol::WIFI_STATUS_FAILED => Self::Failed,
            protocol::WIFI_STATUS_DISCONNECTED => Self::Disconnected,
            value => Self::Unknown(value),
        }
    }

    pub const fn to_wire(self) -> u8 {
        match self {
            Self::Idle => protocol::WIFI_STATUS_IDLE,
            Self::Connecting => protocol::WIFI_STATUS_CONNECTING,
            Self::Connected => protocol::WIFI_STATUS_CONNECTED,
            Self::Failed => protocol::WIFI_STATUS_FAILED,
            Self::Disconnected => protocol::WIFI_STATUS_DISCONNECTED,
            Self::Unknown(value) => value,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct WiFiStatusInfo {
    pub status: WiFiStatus,
    pub signal_strength: Option<u8>,
    pub ssid: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct WiFiScanNetwork {
    pub ssid: String,
    pub quality: u8,
    pub is_current: bool,
    pub is_open: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct WiFiScanResult {
    pub networks: Vec<WiFiScanNetwork>,
    pub current_ssid: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum WiFiScanUpdate {
    Pending(u8),
    Done(WiFiScanResult),
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

pub fn parse_wifi_status_info(bytes: &[u8]) -> Result<WiFiStatusInfo, DeviceSdkError> {
    let cursor = Cursor::new(bytes);
    let status = WiFiStatus::from_wire(cursor.u8(0)?);
    if cursor.len() < 3 {
        return Ok(WiFiStatusInfo {
            status,
            signal_strength: None,
            ssid: None,
            last_error: None,
        });
    }

    let signal = cursor.u8(1)?;
    let ssid_length = usize::from(cursor.u8(2)?);
    if ssid_length > protocol::WIFI_SSID_MAX_LENGTH {
        return Err(invalid_wifi_packet("SSID exceeds the firmware limit"));
    }
    let ssid_end = 3 + ssid_length;
    let ssid = if ssid_length == 0 {
        None
    } else {
        Some(parse_utf8(cursor.slice(3, ssid_length)?, "WiFi SSID")?)
    };
    let last_error = if matches!(status, WiFiStatus::Failed) && cursor.len() > ssid_end {
        Some(parse_utf8(cursor.tail(ssid_end)?, "WiFi error")?)
    } else {
        None
    };

    Ok(WiFiStatusInfo {
        status,
        signal_strength: (signal > 0).then_some(signal),
        ssid,
        last_error,
    })
}

pub fn parse_wifi_scan_result(bytes: &[u8]) -> Result<WiFiScanUpdate, DeviceSdkError> {
    let cursor = Cursor::new(bytes);
    let status = cursor.u8(0)?;
    if status == protocol::WIFI_SCAN_STATUS_ERROR {
        return Err(DeviceSdkError::new(
            crate::error::ErrorCode::ProtocolRejected,
            crate::error::Operation::Decode,
            true,
        )
        .with_protocol_status(u16::from(status))
        .with_detail("device WiFi scan failed"));
    }
    if status != protocol::WIFI_SCAN_STATUS_DONE {
        return Ok(WiFiScanUpdate::Pending(status));
    }

    let count = usize::from(cursor.u8(1)?);
    if count > protocol::WIFI_SCAN_MAX_NETWORKS {
        return Err(invalid_wifi_packet(
            "WiFi scan contains more networks than the firmware limit",
        ));
    }
    let mut offset = 2;
    let mut networks = Vec::with_capacity(count);
    let mut current_ssid = None;
    for _ in 0..count {
        let ssid_length = usize::from(cursor.u8(offset)?);
        offset += 1;
        if ssid_length > protocol::WIFI_SSID_MAX_LENGTH {
            return Err(invalid_wifi_packet("scan SSID exceeds the firmware limit"));
        }
        let ssid = parse_utf8(cursor.slice(offset, ssid_length)?, "WiFi scan SSID")?;
        offset += ssid_length;
        let quality = cursor.u8(offset)?;
        offset += 1;
        let flags = cursor.u8(offset)?;
        offset += 1;
        let is_current = flags & 0x01 != 0;
        if is_current {
            current_ssid = Some(ssid.clone());
        }
        networks.push(WiFiScanNetwork {
            ssid,
            quality,
            is_current,
            is_open: flags & 0x02 != 0,
        });
    }

    Ok(WiFiScanUpdate::Done(WiFiScanResult {
        networks,
        current_ssid,
    }))
}

fn parse_utf8(bytes: &[u8], field: &'static str) -> Result<String, DeviceSdkError> {
    std::str::from_utf8(bytes)
        .map(str::to_owned)
        .map_err(|_| invalid_wifi_packet(format!("{field} is not valid UTF-8")))
}

fn invalid_wifi_packet(detail: impl Into<String>) -> DeviceSdkError {
    DeviceSdkError::new(
        crate::error::ErrorCode::InvalidInput,
        crate::error::Operation::Decode,
        false,
    )
    .with_detail(detail)
}

pub fn parse_factory_reset_result(bytes: &[u8]) -> Result<FactoryResetResult, DeviceSdkError> {
    let cursor = Cursor::new(bytes);
    cursor.require(3)?;
    Ok(FactoryResetResult {
        result_code: cursor.u8(0)?,
        deleted_recording_count: cursor.u16_le(1)?,
    })
}
