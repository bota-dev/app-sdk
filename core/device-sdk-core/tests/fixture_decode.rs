use bota_device_sdk_core::{
    model::{ConnectionType, DeviceState},
    protocol::{
        DeviceLogDecoder, ParsedConnectionSettings, TransferPacket, WiFiConfigResult,
        WiFiScanUpdate, WiFiStatus, parse_connection_settings, parse_device_status,
        parse_ota_status, parse_recording_list, parse_transfer_packet,
        parse_trigger_upload_response, parse_wifi_config_result, parse_wifi_scan_result,
        parse_wifi_status_info,
    },
};
use serde_json::{Map, Value, json};
use std::{fs, path::PathBuf};
use time::{OffsetDateTime, format_description};

fn fixture_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../protocol/fixtures")
}

#[test]
fn decode_fixtures_match_react_native_compatibility_values() {
    let mut matched = 0;
    for entry in fs::read_dir(fixture_root()).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let suite: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        for fixture_case in suite["cases"].as_array().unwrap() {
            let Some(actual) = decode_fixture(fixture_case) else {
                continue;
            };
            matched += 1;
            let name = fixture_case["name"].as_str().unwrap();
            if fixture_case.get("expectedError").is_some() {
                assert!(actual.is_err(), "{name} unexpectedly succeeded");
            } else {
                assert_eq!(actual.unwrap(), fixture_case["expected"], "{name}");
            }
        }
    }
    assert_eq!(matched, 33);
}

#[test]
fn parsers_never_panic_for_short_or_oversized_deterministic_input() {
    for length in 0..=80 {
        let bytes: Vec<u8> = (0..length).map(|index| (index * 17) as u8).collect();
        let _ = parse_device_status(&bytes);
        let _ = parse_recording_list(&bytes);
        let _ = parse_transfer_packet(&bytes);
        let _ = parse_trigger_upload_response(&bytes);
        let _ = parse_connection_settings(&bytes);
        let _ = parse_wifi_config_result(&bytes);
        let _ = parse_wifi_status_info(&bytes);
        let _ = parse_wifi_scan_result(&bytes);
        let _ = parse_ota_status(&bytes);
        let mut decoder = DeviceLogDecoder::default();
        let _ = decoder.push(&bytes);
    }
}

fn decode_fixture(fixture_case: &Value) -> Option<Result<Value, String>> {
    let operation = fixture_case["operation"].as_str().unwrap();
    let bytes = hex_decode(fixture_case["inputHex"].as_str().unwrap_or_default());
    let result = match operation {
        "parseDeviceStatus" => parse_device_status(&bytes).map(status_json),
        "parseRecordingList" => parse_recording_list(&bytes)
            .map(|recordings| Value::Array(recordings.into_iter().map(recording_json).collect())),
        "parseTransferPacket" => parse_transfer_packet(&bytes).map(transfer_json),
        "parseTriggerDeviceUploadResponse" => {
            parse_trigger_upload_response(&bytes).map(|response| match response {
                Some(response) => {
                    let mut value = Map::new();
                    value.insert("accepted".into(), response.accepted.into());
                    if let Some(error_code) = response.error_code {
                        value.insert("errorCode".into(), error_code.into());
                    }
                    Value::Object(value)
                }
                None => Value::Null,
            })
        }
        "parseConnectionSettings" => parse_connection_settings(&bytes).map(settings_json),
        "parseWiFiConfigResult" => parse_wifi_config_result(&bytes).map(wifi_config_json),
        "parseWiFiStatusInfo" => parse_wifi_status_info(&bytes).map(wifi_status_json),
        "parseWiFiScanResult" => parse_wifi_scan_result(&bytes).map(wifi_scan_json),
        "decodeDeviceLogs" => {
            let mut decoder = DeviceLogDecoder::default();
            Ok(Value::Array(
                fixture_case["inputsHex"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|value| {
                        Value::Array(
                            decoder
                                .push(&hex_decode(value.as_str().unwrap()))
                                .into_iter()
                                .map(|event| {
                                    json!({
                                        "level": "debug",
                                        "message": event.message,
                                        "isBacklog": event.is_backlog,
                                    })
                                })
                                .collect(),
                        )
                    })
                    .collect(),
            ))
        }
        _ => return None,
    };
    Some(result.map_err(|error| error.to_string()))
}

fn wifi_status_json(info: bota_device_sdk_core::protocol::WiFiStatusInfo) -> Value {
    let mut value = Map::new();
    value.insert(
        "status".into(),
        match info.status {
            WiFiStatus::Idle | WiFiStatus::Unknown(_) => "idle",
            WiFiStatus::Connecting => "connecting",
            WiFiStatus::Connected => "connected",
            WiFiStatus::Failed => "failed",
            WiFiStatus::Disconnected => "disconnected",
        }
        .into(),
    );
    if let Some(signal_strength) = info.signal_strength {
        value.insert("signalStrength".into(), signal_strength.into());
    }
    if let Some(ssid) = info.ssid {
        value.insert("ssid".into(), ssid.into());
    }
    if let Some(last_error) = info.last_error {
        value.insert("lastError".into(), last_error.into());
    }
    Value::Object(value)
}

fn wifi_scan_json(update: WiFiScanUpdate) -> Value {
    match update {
        WiFiScanUpdate::Pending(_) => Value::Null,
        WiFiScanUpdate::Done(result) => json!({
            "networks": result.networks.into_iter().map(|network| json!({
                "ssid": network.ssid,
                "quality": network.quality,
                "isCurrent": network.is_current,
                "isOpen": network.is_open,
            })).collect::<Vec<_>>(),
            "currentSsid": result.current_ssid,
        }),
    }
}

fn status_json(status: bota_device_sdk_core::model::DeviceStatus) -> Value {
    let mut value = Map::new();
    value.insert("batteryLevel".into(), status.battery_percent.into());
    if let Some(battery_mv) = status.battery_mv {
        value.insert("batteryMv".into(), battery_mv.into());
    }
    value.insert("storageTotalMb".into(), status.storage_total_mb.into());
    value.insert("storageUsedMb".into(), status.storage_used_mb.into());
    value.insert("state".into(), legacy_device_state(status.state).into());
    value.insert("pendingRecordings".into(), status.pending_recordings.into());
    value.insert(
        "lastTimeSyncAt".into(),
        if status.last_time_sync_timestamp == 0 {
            Value::Null
        } else {
            timestamp_json(status.last_time_sync_timestamp)
        },
    );
    value.insert("signalStrength".into(), 0.into());
    value.insert(
        "flags".into(),
        json!({
            "charging": status.flags.charging,
            "lowBattery": status.flags.low_battery,
            "storageFull": status.flags.storage_full,
            "wifiConnected": status.flags.wifi_connected,
            "lteConnected": status.flags.lte_connected,
            "syncActive": status.flags.sync_active,
        }),
    );
    value.insert("timestamp".into(), status.last_time_sync_timestamp.into());
    value.insert(
        "lteStatus".into(),
        legacy_lte_status(status.lte_status_raw).into(),
    );
    if let Some(quality) = status.lte_signal_quality {
        value.insert("lteSignalQuality".into(), quality.into());
    }
    if let Some(wifi) = status.wifi_status_raw {
        value.insert("wifiStatus".into(), legacy_wifi_status(wifi).into());
    }
    if let Some(modem) = status.modem_info {
        let mut info = Map::new();
        macro_rules! optional_string {
            ($field:ident, $name:literal) => {
                if let Some(value) = modem.$field {
                    info.insert($name.into(), value.into());
                }
            };
        }
        optional_string!(imei, "imei");
        optional_string!(iccid, "iccid");
        optional_string!(operator, "operator");
        optional_string!(rat, "rat");
        optional_string!(band, "band");
        optional_string!(apn, "apn");
        optional_string!(sim_status, "simStatus");
        optional_string!(ip_address, "ipAddress");
        optional_string!(firmware, "modemFirmware");
        if let Some(csq) = modem.csq {
            info.insert("csq".into(), csq.into());
        }
        if let Some(voltage) = modem.voltage_mv {
            info.insert("modemVoltage".into(), voltage.into());
        }
        if let Some(roaming) = modem.roaming {
            info.insert("roaming".into(), roaming.into());
        }
        value.insert("modemInfo".into(), Value::Object(info));
    }
    Value::Object(value)
}

fn recording_json(recording: bota_device_sdk_core::model::DeviceRecording) -> Value {
    json!({
        "uuid": recording.uuid.to_string(),
        "startedAt": timestamp_json(recording.started_at_timestamp),
        "durationMs": recording.duration_ms,
        "fileSizeBytes": recording.file_size_bytes,
        "codec": "opus_16k",
        "isEncrypted": recording.encrypted,
    })
}

fn transfer_json(packet: TransferPacket) -> Value {
    match packet {
        TransferPacket::Data { sequence, data } => {
            json!({ "type": "data", "sequenceNumber": sequence, "data": hex_encode(&data) })
        }
        TransferPacket::Eof { sequence, checksum } => {
            json!({ "type": "eof", "sequenceNumber": sequence, "checksum": checksum })
        }
        TransferPacket::Paused {
            sequence,
            bytes_sent,
        } => json!({ "type": "paused", "sequenceNumber": sequence, "bytesSent": bytes_sent }),
        TransferPacket::Sha256(hash) => {
            json!({ "type": "sha256", "sequenceNumber": 0, "sha256": hex_encode(&hash) })
        }
        TransferPacket::E2eStart {
            ephemeral_public_key,
            salt,
        } => json!({
            "type": "e2e_start",
            "sequenceNumber": 0,
            "e2eEphemeralPk": hex_encode(&ephemeral_public_key),
            "e2eSalt": hex_encode(&salt),
        }),
        TransferPacket::EncryptedData { sequence, chunk } => json!({
            "type": "encrypted_data",
            "sequenceNumber": sequence,
            "e2eChunk": hex_encode(&chunk),
        }),
        TransferPacket::EncryptedEof { sequence } => {
            json!({ "type": "encrypted_eof", "sequenceNumber": sequence })
        }
        TransferPacket::Error { sequence, code } => {
            json!({ "type": "error", "sequenceNumber": sequence, "errorCode": code })
        }
    }
}

fn settings_json(parsed: ParsedConnectionSettings) -> Value {
    let settings = parsed.settings;
    let mut value = Map::new();
    value.insert(
        "enabled_connections".into(),
        json!({ "wifi": settings.enabled.wifi, "cellular": settings.enabled.cellular }),
    );
    value.insert(
        "heartbeat_enabled_connections".into(),
        json!({ "wifi": settings.heartbeat.wifi, "cellular": settings.heartbeat.cellular }),
    );
    value.insert(
        "upload_network_preference".into(),
        Value::Array(
            settings
                .upload_priority
                .into_iter()
                .filter_map(|connection| match connection {
                    ConnectionType::Wifi => Some("wifi".into()),
                    ConnectionType::Ble => Some("ble".into()),
                    ConnectionType::Cellular => Some("cellular".into()),
                    ConnectionType::Unknown(_) => None,
                })
                .collect(),
        ),
    );
    if parsed.supported_version {
        value.insert(
            "power_management".into(),
            json!({
                "cellular_idle_timeout_seconds": settings.power.cellular.seconds(),
                "wifi_idle_timeout_seconds": settings.power.wifi.seconds(),
            }),
        );
        value.insert(
            "streaming_enabled".into(),
            settings.streaming_enabled.into(),
        );
        value.insert(
            "streaming_flush_interval_seconds".into(),
            settings.streaming_flush_interval_seconds.into(),
        );
    }
    Value::Object(value)
}

fn wifi_config_json(result: WiFiConfigResult) -> Value {
    match result {
        WiFiConfigResult::Success => json!({ "success": true }),
        WiFiConfigResult::InvalidGrant => json!({ "success": false, "error": "invalid_grant" }),
        WiFiConfigResult::GrantExpired => json!({ "success": false, "error": "grant_expired" }),
        WiFiConfigResult::DecryptionError => {
            json!({ "success": false, "error": "decryption_error" })
        }
        WiFiConfigResult::StorageError => json!({ "success": false, "error": "storage_error" }),
        WiFiConfigResult::Unknown(_) => json!({ "success": false, "error": "unknown" }),
    }
}

fn timestamp_json(timestamp: u32) -> Value {
    let format = format_description::parse_borrowed::<2>(
        "[year]-[month]-[day]T[hour]:[minute]:[second].000Z",
    )
    .unwrap();
    OffsetDateTime::from_unix_timestamp(timestamp.into())
        .unwrap()
        .format(&format)
        .unwrap()
        .into()
}

fn legacy_device_state(state: DeviceState) -> &'static str {
    match state {
        DeviceState::Recording => "recording",
        DeviceState::Syncing => "syncing",
        DeviceState::Uploading => "uploading",
        DeviceState::Charging => "charging",
        DeviceState::LowBattery => "lowBattery",
        DeviceState::StorageFull => "storageFull",
        DeviceState::Error => "error",
        DeviceState::Idle | DeviceState::Unknown(_) => "idle",
    }
}

fn legacy_lte_status(value: u8) -> &'static str {
    match value {
        1 => "searching",
        2 => "registered",
        3 => "connected",
        4 => "denied",
        5 => "noSim",
        6 => "error",
        7 => "lowVoltage",
        8 => "disabled",
        _ => "off",
    }
}

fn legacy_wifi_status(value: u8) -> &'static str {
    match value {
        1 => "scanning",
        2 => "connecting",
        3 => "connected",
        4 => "connectFailed",
        5 => "noCredentials",
        6 => "disabled",
        7 => "error",
        _ => "off",
    }
}

fn hex_decode(value: &str) -> Vec<u8> {
    value
        .as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| {
            let text = std::str::from_utf8(pair).unwrap();
            u8::from_str_radix(text, 16).unwrap()
        })
        .collect()
}

fn hex_encode(value: &[u8]) -> String {
    value.iter().map(|byte| format!("{byte:02x}")).collect()
}
