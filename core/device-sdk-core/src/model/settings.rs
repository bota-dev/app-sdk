use crate::{
    error::{DeviceSdkError, ErrorCode, Operation},
    generated::protocol,
    model::DeviceModel,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum ConnectionType {
    Wifi,
    Ble,
    Cellular,
    Unknown(u8),
}

impl ConnectionType {
    pub const fn from_wire(value: u8) -> Self {
        match value {
            protocol::CONN_ID_WIFI => Self::Wifi,
            protocol::CONN_ID_BLE => Self::Ble,
            protocol::CONN_ID_CELLULAR => Self::Cellular,
            value => Self::Unknown(value),
        }
    }

    pub const fn to_wire(self) -> u8 {
        match self {
            Self::Wifi => protocol::CONN_ID_WIFI,
            Self::Ble => protocol::CONN_ID_BLE,
            Self::Cellular => protocol::CONN_ID_CELLULAR,
            Self::Unknown(value) => value,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum IdleTimeout {
    Immediate,
    Seconds(u16),
    AlwaysOn,
}

impl IdleTimeout {
    pub fn try_from_seconds(seconds: i32) -> Result<Self, DeviceSdkError> {
        match seconds {
            -1 => Ok(Self::AlwaysOn),
            0 => Ok(Self::Immediate),
            1..=2540 => Ok(Self::Seconds(seconds as u16)),
            _ => Err(
                DeviceSdkError::new(ErrorCode::InvalidInput, Operation::Validate, false)
                    .with_detail("idle timeout must be -1 or 0-2540 seconds"),
            ),
        }
    }

    pub const fn seconds(self) -> i32 {
        match self {
            Self::Immediate => 0,
            Self::Seconds(seconds) => seconds as i32,
            Self::AlwaysOn => -1,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct EnabledConnections {
    pub wifi: bool,
    pub cellular: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct HeartbeatConnections {
    pub wifi: bool,
    pub cellular: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct PowerManagement {
    pub cellular: IdleTimeout,
    pub wifi: IdleTimeout,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct DeviceConnectionSettings {
    pub enabled: EnabledConnections,
    pub heartbeat: HeartbeatConnections,
    pub upload_priority: Vec<ConnectionType>,
    pub power: PowerManagement,
    pub streaming_enabled: bool,
    pub streaming_flush_interval_seconds: u8,
}

impl DeviceConnectionSettings {
    pub fn normalized_for(&self, model: DeviceModel) -> Self {
        let mut normalized = self.clone();
        if model == DeviceModel::Note {
            normalized.enabled.cellular = false;
            normalized.heartbeat.cellular = false;
            normalized
                .upload_priority
                .retain(|connection| *connection != ConnectionType::Cellular);
        }
        normalized
    }
}
