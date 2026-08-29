use std::{fs, path::PathBuf, str::FromStr};

use bota_device_sdk_core::{
    generated::protocol,
    model::{
        ConnectionType, DeviceConnectionSettings, DeviceModel, EnabledConnections,
        HeartbeatConnections, IdleTimeout, PowerManagement, RecordingUuid,
    },
    protocol::{
        AckType, FirmwareStatus, TransferCommand, encode_ack, encode_bounded_payload,
        encode_connection_settings, encode_firmware_data, encode_firmware_upload_start,
        encode_firmware_upload_verify, encode_firmware_window_ack, encode_ota_status,
        encode_transfer_command, encode_wifi_grant, encode_wifi_scan_command,
    },
};
use serde_json::Value;

fn fixture_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../protocol/fixtures")
}

#[test]
fn encode_fixtures_match_react_native_bytes() {
    let mut matched = 0;
    for entry in fs::read_dir(fixture_root()).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let suite: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        for fixture_case in suite["cases"].as_array().unwrap() {
            let Some(actual) = encode_fixture(fixture_case) else {
                continue;
            };
            matched += 1;
            let name = fixture_case["name"].as_str().unwrap();
            if fixture_case.get("expectedError").is_some() {
                assert!(actual.is_err(), "{name} unexpectedly succeeded");
            } else {
                assert_eq!(
                    hex_encode(&actual.unwrap()),
                    fixture_case["expectedHex"],
                    "{name}"
                );
            }
        }
    }
    assert_eq!(matched, 22);
}

fn encode_fixture(fixture_case: &Value) -> Option<Result<Vec<u8>, String>> {
    let input = &fixture_case["input"];
    let operation = fixture_case["operation"].as_str().unwrap();
    if operation == "serializeConnectionSettings" {
        return Some(match settings_from_json(input) {
            Ok(settings) => encode_connection_settings(&settings, DeviceModel::Pin4g)
                .map_err(|error| error.to_string()),
            Err(error) => Err(error.to_string()),
        });
    }
    let result = match operation {
        "firmwareUploadStart" => {
            encode_firmware_upload_start(input["size"].as_u64().unwrap() as u32)
        }
        "firmwareDataPacket" => encode_firmware_data(
            input["sequenceNumber"].as_u64().unwrap() as u16,
            &hex_decode(input["payloadHex"].as_str().unwrap()),
        ),
        "firmwareWindowAck" => {
            encode_firmware_window_ack(input["sequenceNumber"].as_u64().unwrap() as u16)
        }
        "firmwareUploadVerify" => {
            encode_firmware_upload_verify(input["crc32"].as_u64().unwrap() as u32)
        }
        "firmwareStatus" => encode_ota_status(FirmwareStatus {
            command: input["command"].as_u64().unwrap() as u8,
            result: input["result"].as_u64().unwrap() as u8,
            sequence: None,
        }),
        "constantByte" => Ok(vec![constant_byte(
            fixture_case["constant"].as_str().unwrap(),
        )]),
        "createWiFiGrantPacket" => {
            encode_wifi_grant(input["grantBlob"].as_str().unwrap(), usize::MAX)
        }
        "createWiFiScanCommand" => encode_wifi_scan_command(),
        "identityBytes" => encode_bounded_payload(
            &hex_decode(fixture_case["inputHex"].as_str().unwrap()),
            usize::MAX,
        ),
        "createAckPacket" => encode_ack(
            match input["ackType"].as_str().unwrap() {
                "ack" => AckType::Ack,
                "nack" => AckType::Nack,
                "abort" => AckType::Abort,
                value => panic!("unsupported fixture ACK type {value}"),
            },
            input["sequenceNumber"].as_u64().unwrap() as u16,
        ),
        "createTransferCommand" => {
            encode_transfer_command(match input["command"].as_str().unwrap() {
                "list" => TransferCommand::List,
                "start" => TransferCommand::Start(
                    RecordingUuid::from_str(input["recordingUuid"].as_str().unwrap()).unwrap(),
                ),
                "triggerDeviceUpload" => TransferCommand::TriggerDeviceUpload,
                "confirm" => TransferCommand::Confirm(
                    RecordingUuid::from_str(input["recordingUuid"].as_str().unwrap()).unwrap(),
                ),
                value => panic!("unsupported fixture transfer command {value}"),
            })
        }
        _ => return None,
    };
    Some(result.map_err(|error| error.to_string()))
}

fn settings_from_json(value: &Value) -> Result<DeviceConnectionSettings, &'static str> {
    let power = value.get("power_management");
    Ok(DeviceConnectionSettings {
        enabled: EnabledConnections {
            wifi: value["enabled_connections"]["wifi"].as_bool().unwrap(),
            cellular: value["enabled_connections"]["cellular"].as_bool().unwrap(),
        },
        heartbeat: HeartbeatConnections {
            wifi: value
                .get("heartbeat_enabled_connections")
                .and_then(|heartbeat| heartbeat["wifi"].as_bool())
                .unwrap_or(true),
            cellular: value
                .get("heartbeat_enabled_connections")
                .and_then(|heartbeat| heartbeat["cellular"].as_bool())
                .unwrap_or(true),
            unknown_mask: 0,
        },
        upload_priority: value["upload_network_preference"]
            .as_array()
            .unwrap()
            .iter()
            .map(|connection| match connection.as_str().unwrap() {
                "wifi" => ConnectionType::Wifi,
                "ble" => ConnectionType::Ble,
                "cellular" => ConnectionType::Cellular,
                value => panic!("unsupported fixture connection {value}"),
            })
            .collect(),
        power: PowerManagement {
            cellular: idle_timeout(
                power
                    .and_then(|settings| settings["cellular_idle_timeout_seconds"].as_i64())
                    .unwrap_or(180),
            )?,
            wifi: idle_timeout(
                power
                    .and_then(|settings| settings["wifi_idle_timeout_seconds"].as_i64())
                    .unwrap_or(180),
            )?,
        },
        streaming_enabled: value
            .get("streaming_enabled")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        streaming_flush_interval_seconds: value
            .get("streaming_flush_interval_seconds")
            .and_then(Value::as_u64)
            .unwrap_or(60) as u8,
    })
}

fn idle_timeout(value: i64) -> Result<IdleTimeout, &'static str> {
    IdleTimeout::try_from_seconds(value as i32).map_err(|_| "invalid idle timeout")
}

fn constant_byte(name: &str) -> u8 {
    match name {
        "PROVISIONING_SUCCESS" => protocol::PROVISIONING_SUCCESS,
        "PROVISIONING_ALREADY_PAIRED" => protocol::PROVISIONING_ALREADY_PAIRED,
        "DEVICE_CMD_BLE_DEPROVISION" => protocol::DEVICE_CMD_BLE_DEPROVISION,
        "DEVICE_CMD_BLE_FACTORY_RESET" => protocol::DEVICE_CMD_BLE_FACTORY_RESET,
        "DEVICE_CMD_BLE_FACTORY_RESET_RESULT_ACK" => {
            protocol::DEVICE_CMD_BLE_FACTORY_RESET_RESULT_ACK
        }
        value => panic!("unsupported fixture constant {value}"),
    }
}

fn hex_decode(value: &str) -> Vec<u8> {
    value
        .as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}

fn hex_encode(value: &[u8]) -> String {
    value.iter().map(|byte| format!("{byte:02x}")).collect()
}
