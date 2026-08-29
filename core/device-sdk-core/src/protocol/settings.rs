use crate::{
    error::DeviceSdkError,
    generated::protocol,
    model::{
        ConnectionType, DeviceConnectionSettings, EnabledConnections, HeartbeatConnections,
        IdleTimeout, PowerManagement,
    },
};
use serde::{Deserialize, Serialize};

use super::cursor::Cursor;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ParsedConnectionSettings {
    pub settings: DeviceConnectionSettings,
    pub supported_version: bool,
}

pub fn parse_connection_settings(bytes: &[u8]) -> Result<ParsedConnectionSettings, DeviceSdkError> {
    let cursor = Cursor::new(bytes);
    let version = if cursor.len() >= 1 { cursor.u8(0)? } else { 0 };
    if cursor.len() < protocol::DEVICE_SETTINGS_MINIMUM_LENGTH || !matches!(version, 1 | 2) {
        return Ok(ParsedConnectionSettings {
            settings: default_settings(),
            supported_version: false,
        });
    }

    let enabled_mask = cursor.u8(1)?;
    let mut upload_priority = Vec::with_capacity(3);
    for offset in 2..=4 {
        let id = cursor.u8(offset)?;
        if id == 0 {
            break;
        }
        upload_priority.push(ConnectionType::from_wire(id));
    }

    let heartbeat_mask = if version == 2 && cursor.len() >= 10 {
        cursor.u8(9)?
    } else {
        0
    };
    let heartbeat = if heartbeat_mask & protocol::HEARTBEAT_EXPLICIT == 0 {
        HeartbeatConnections {
            wifi: true,
            cellular: true,
            unknown_mask: 0,
        }
    } else {
        HeartbeatConnections {
            wifi: heartbeat_mask & protocol::HEARTBEAT_WIFI != 0,
            cellular: heartbeat_mask & protocol::HEARTBEAT_CELLULAR != 0,
            unknown_mask: heartbeat_mask
                & !(protocol::HEARTBEAT_EXPLICIT
                    | protocol::HEARTBEAT_WIFI
                    | protocol::HEARTBEAT_CELLULAR),
        }
    };

    Ok(ParsedConnectionSettings {
        settings: DeviceConnectionSettings {
            enabled: EnabledConnections {
                wifi: enabled_mask & protocol::HEARTBEAT_WIFI != 0,
                cellular: enabled_mask & protocol::HEARTBEAT_CELLULAR != 0,
            },
            heartbeat,
            upload_priority,
            power: PowerManagement {
                cellular: decode_timeout(cursor.u8(5)?),
                wifi: decode_timeout(cursor.u8(6)?),
            },
            streaming_enabled: cursor.u8(7)? != 0,
            streaming_flush_interval_seconds: if version == 2 && cursor.len() >= 9 {
                cursor.u8(8)?
            } else {
                60
            },
        },
        supported_version: true,
    })
}

fn decode_timeout(value: u8) -> IdleTimeout {
    match value {
        0 => IdleTimeout::Immediate,
        u8::MAX => IdleTimeout::AlwaysOn,
        value => IdleTimeout::Seconds(u16::from(value) * 10),
    }
}

fn default_settings() -> DeviceConnectionSettings {
    DeviceConnectionSettings {
        enabled: EnabledConnections {
            wifi: true,
            cellular: true,
        },
        heartbeat: HeartbeatConnections {
            wifi: true,
            cellular: true,
            unknown_mask: 0,
        },
        upload_priority: vec![
            ConnectionType::Wifi,
            ConnectionType::Ble,
            ConnectionType::Cellular,
        ],
        power: PowerManagement {
            cellular: IdleTimeout::Seconds(180),
            wifi: IdleTimeout::Seconds(180),
        },
        streaming_enabled: true,
        streaming_flush_interval_seconds: 60,
    }
}

pub fn encode_connection_settings(
    settings: &DeviceConnectionSettings,
    model: crate::model::DeviceModel,
) -> Result<Vec<u8>, DeviceSdkError> {
    let settings = settings.normalized_for(model);
    let mut bytes = vec![0_u8; protocol::DEVICE_SETTINGS_FIXED_LENGTH];
    bytes[0] = 0x02;
    bytes[1] = u8::from(settings.enabled.wifi) | (u8::from(settings.enabled.cellular) << 1);

    for (index, connection) in settings.upload_priority.iter().take(3).enumerate() {
        bytes[2 + index] = connection.to_wire();
    }
    bytes[5] = encode_timeout(settings.power.cellular)?;
    bytes[6] = encode_timeout(settings.power.wifi)?;
    bytes[7] = u8::from(settings.streaming_enabled);
    bytes[8] = settings.streaming_flush_interval_seconds.min(128);
    bytes[9] = protocol::HEARTBEAT_EXPLICIT
        | settings.heartbeat.unknown_mask
        | u8::from(settings.heartbeat.wifi)
        | (u8::from(settings.heartbeat.cellular) << 1);
    Ok(bytes)
}

fn encode_timeout(timeout: IdleTimeout) -> Result<u8, DeviceSdkError> {
    match timeout {
        IdleTimeout::Immediate => Ok(0),
        IdleTimeout::AlwaysOn => Ok(u8::MAX),
        IdleTimeout::Seconds(seconds) if seconds <= 2_540 => Ok((seconds / 10).max(1) as u8),
        IdleTimeout::Seconds(_) => Err(crate::error::DeviceSdkError::new(
            crate::error::ErrorCode::InvalidInput,
            crate::error::Operation::Encode,
            false,
        )
        .with_detail("idle timeout must not exceed 2540 seconds")),
    }
}
