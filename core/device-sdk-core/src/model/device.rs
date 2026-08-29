use crate::{
    error::{DeviceSdkError, ErrorCode, Operation},
    generated::protocol,
};
use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
pub struct DeviceSerialNumber(String);

impl DeviceSerialNumber {
    pub fn new(value: impl Into<String>) -> Result<Self, DeviceSdkError> {
        let value = value.into();
        if value.is_empty()
            || value.len() > 64
            || !value.bytes().all(|byte| byte.is_ascii_alphanumeric())
        {
            return Err(
                DeviceSdkError::new(ErrorCode::InvalidInput, Operation::Validate, false)
                    .with_detail("serial number must be 1-64 ASCII alphanumeric characters"),
            );
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for DeviceSerialNumber {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum DeviceModel {
    Pin,
    Pin4g,
    Note,
    Unknown(u8),
}

impl DeviceModel {
    pub const fn from_wire(value: u8) -> Self {
        match value {
            protocol::DEVICE_TYPE_PIN => Self::Pin,
            protocol::DEVICE_TYPE_PIN_4G => Self::Pin4g,
            protocol::DEVICE_TYPE_NOTE => Self::Note,
            value => Self::Unknown(value),
        }
    }

    pub const fn to_wire(self) -> u8 {
        match self {
            Self::Pin => protocol::DEVICE_TYPE_PIN,
            Self::Pin4g => protocol::DEVICE_TYPE_PIN_4G,
            Self::Note => protocol::DEVICE_TYPE_NOTE,
            Self::Unknown(value) => value,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum DeviceState {
    Idle,
    Recording,
    Syncing,
    Uploading,
    Charging,
    LowBattery,
    StorageFull,
    Error,
    Unknown(u8),
}

impl DeviceState {
    pub const fn from_wire(value: u8) -> Self {
        match value {
            protocol::DEVICE_STATE_IDLE => Self::Idle,
            protocol::DEVICE_STATE_RECORDING => Self::Recording,
            protocol::DEVICE_STATE_SYNCING => Self::Syncing,
            protocol::DEVICE_STATE_UPLOADING => Self::Uploading,
            protocol::DEVICE_STATE_CHARGING => Self::Charging,
            protocol::DEVICE_STATE_LOW_BATTERY => Self::LowBattery,
            protocol::DEVICE_STATE_STORAGE_FULL => Self::StorageFull,
            protocol::DEVICE_STATE_ERROR => Self::Error,
            value => Self::Unknown(value),
        }
    }

    pub const fn to_wire(self) -> u8 {
        match self {
            Self::Idle => protocol::DEVICE_STATE_IDLE,
            Self::Recording => protocol::DEVICE_STATE_RECORDING,
            Self::Syncing => protocol::DEVICE_STATE_SYNCING,
            Self::Uploading => protocol::DEVICE_STATE_UPLOADING,
            Self::Charging => protocol::DEVICE_STATE_CHARGING,
            Self::LowBattery => protocol::DEVICE_STATE_LOW_BATTERY,
            Self::StorageFull => protocol::DEVICE_STATE_STORAGE_FULL,
            Self::Error => protocol::DEVICE_STATE_ERROR,
            Self::Unknown(value) => value,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct DeviceFlags {
    pub charging: bool,
    pub low_battery: bool,
    pub storage_full: bool,
    pub wifi_connected: bool,
    pub lte_connected: bool,
    pub sync_active: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct DeviceStatus {
    pub battery_percent: u8,
    pub battery_mv: Option<u16>,
    pub storage_total_mb: u16,
    pub storage_used_mb: u16,
    pub state: DeviceState,
    pub pending_recordings: u8,
    pub last_time_sync_timestamp: u32,
    pub flags: DeviceFlags,
    pub lte_status_raw: u8,
    pub lte_signal_quality: Option<u8>,
    pub wifi_status_raw: Option<u8>,
}
