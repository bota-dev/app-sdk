use bota_device_sdk_core::{
    error::ErrorCode,
    model::{
        ConnectionType, DeviceConnectionSettings, DeviceModel, EnabledConnections,
        HeartbeatConnections, IdleTimeout, PowerManagement,
    },
    protocol::{
        AckType, DeviceCommand, encode_ack, encode_connection_settings, encode_device_command,
        encode_firmware_data, encode_provisioning_chunks, parse_ack, parse_connection_settings,
    },
};

#[test]
fn connection_settings_round_trip_after_note_normalization() {
    let settings = settings_with_unknown_heartbeat();
    let encoded = encode_connection_settings(&settings, DeviceModel::Note).unwrap();
    let decoded = parse_connection_settings(&encoded).unwrap().settings;

    assert_eq!(decoded, settings.normalized_for(DeviceModel::Note));
    assert_eq!(decoded.heartbeat.unknown_mask, 0x20);
}

#[test]
fn acknowledgements_round_trip_and_abort_represents_transfer_cancel() {
    for ack_type in [AckType::Ack, AckType::Nack, AckType::Abort] {
        let encoded = encode_ack(ack_type, 0x1234).unwrap();
        assert_eq!(parse_ack(&encoded).unwrap(), (ack_type, 0x1234));
    }
}

#[test]
fn bind_payload_chunks_reconstruct_without_credentials_in_core_state() {
    let payload = b"short-lived-bind-token";
    let chunks = encode_provisioning_chunks(payload, 23).unwrap();
    let reconstructed: Vec<u8> = chunks
        .iter()
        .flat_map(|chunk| chunk[2..].iter().copied())
        .collect();

    assert_eq!(reconstructed, payload);
    assert_eq!(chunks[0][0], 0);
    assert_eq!(usize::from(chunks[0][1]), chunks.len());
}

#[test]
fn destructive_commands_have_distinct_wire_values() {
    assert_eq!(
        encode_device_command(DeviceCommand::Deprovision).unwrap(),
        [0x05]
    );
    assert_eq!(
        encode_device_command(DeviceCommand::FactoryReset).unwrap(),
        [0x06]
    );
    assert_eq!(
        encode_device_command(DeviceCommand::FactoryResetReceipt).unwrap(),
        [0x0a]
    );
}

#[test]
fn oversized_payloads_fail_before_transport() {
    let firmware = encode_firmware_data(0, &[0; 501]).unwrap_err();
    let provisioning = encode_provisioning_chunks(&vec![0; 4_081], 23).unwrap_err();

    assert_eq!(firmware.code, ErrorCode::PayloadTooLarge);
    assert_eq!(provisioning.code, ErrorCode::PayloadTooLarge);
}

fn settings_with_unknown_heartbeat() -> DeviceConnectionSettings {
    DeviceConnectionSettings {
        enabled: EnabledConnections {
            wifi: true,
            cellular: true,
        },
        heartbeat: HeartbeatConnections {
            wifi: true,
            cellular: true,
            unknown_mask: 0x20,
        },
        upload_priority: vec![
            ConnectionType::Wifi,
            ConnectionType::Cellular,
            ConnectionType::Ble,
        ],
        power: PowerManagement {
            cellular: IdleTimeout::AlwaysOn,
            wifi: IdleTimeout::Immediate,
        },
        streaming_enabled: false,
        streaming_flush_interval_seconds: 60,
    }
}
