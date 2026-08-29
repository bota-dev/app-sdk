use crate::{
    error::DeviceSdkError,
    generated::protocol,
    model::{DeviceFlags, DeviceState, DeviceStatus, ModemInfo},
};

use super::cursor::Cursor;

pub fn parse_device_status(bytes: &[u8]) -> Result<DeviceStatus, DeviceSdkError> {
    let cursor = Cursor::new(bytes);
    cursor.require(protocol::DEVICE_STATUS_MINIMUM_LENGTH)?;

    let flags = cursor.u8(8)?;
    let signal_quality = cursor.u8(13)?;
    let battery_mv = if cursor.len() >= 17 {
        match cursor.u16_le(15)? {
            0 => None,
            value => Some(value),
        }
    } else {
        None
    };
    let modem_info = if cursor.len() > 17 {
        parse_modem_info(cursor.tail(17)?)
    } else {
        None
    };

    Ok(DeviceStatus {
        battery_percent: cursor.u8(0)?,
        battery_mv,
        storage_total_mb: cursor.u16_le(9)?,
        storage_used_mb: cursor.u16_le(11)?,
        state: DeviceState::from_wire(cursor.u8(2)?),
        pending_recordings: cursor.u8(3)?,
        last_time_sync_timestamp: cursor.u32_le(4)?,
        flags: DeviceFlags {
            charging: flags & protocol::FLAG_CHARGING != 0,
            low_battery: flags & protocol::FLAG_LOW_BATTERY != 0,
            storage_full: flags & protocol::FLAG_STORAGE_FULL != 0,
            wifi_connected: flags & protocol::FLAG_WIFI_CONNECTED != 0,
            lte_connected: flags & protocol::FLAG_LTE_CONNECTED != 0,
            sync_active: flags & protocol::FLAG_SYNC_ACTIVE != 0,
        },
        lte_status_raw: cursor.u8(1)?,
        lte_signal_quality: if matches!(signal_quality, 99 | u8::MAX) {
            None
        } else {
            Some(signal_quality)
        },
        wifi_status_raw: if cursor.len() >= 15 {
            Some(cursor.u8(14)?)
        } else {
            None
        },
        modem_info,
    })
}

fn parse_modem_info(bytes: &[u8]) -> Option<ModemInfo> {
    let raw = String::from_utf8_lossy(bytes);
    let mut info = ModemInfo::default();
    let mut has_value = false;

    for line in raw.split('\n') {
        let Some((key, raw_value)) = line.split_once('=') else {
            continue;
        };
        let value = raw_value.replace('\0', "");
        if value.is_empty() {
            continue;
        }
        has_value = true;
        match key {
            "IMEI" => info.imei = Some(value),
            "ICCID" => info.iccid = Some(value),
            "OP" => info.operator = Some(value),
            "RAT" => info.rat = Some(value),
            "BAND" => info.band = Some(value),
            "APN" => info.apn = Some(value),
            "SIM" => info.sim_status = Some(value),
            "CSQ" => info.csq = value.parse().ok(),
            "IP" => info.ip_address = Some(value),
            "MV" => info.voltage_mv = value.parse().ok().filter(|voltage| *voltage > 0),
            "FW" => info.firmware = Some(value),
            "ROAM" => info.roaming = Some(value == "1"),
            _ => {}
        }
    }

    has_value.then_some(info)
}
