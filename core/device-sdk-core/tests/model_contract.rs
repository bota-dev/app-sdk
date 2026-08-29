use std::str::FromStr;

use bota_device_sdk_core::{
    error::{DeviceSdkError, ErrorCode, Operation},
    model::{
        ConnectionType, DeviceConnectionSettings, DeviceModel, DeviceSerialNumber, DeviceState,
        EnabledConnections, HeartbeatConnections, IdleTimeout, PowerManagement, RecordingUuid,
    },
};

#[test]
fn unknown_enum_values_round_trip_without_data_loss() {
    let state = DeviceState::from_wire(0xaa);
    let connection = ConnectionType::from_wire(0xbb);

    assert_eq!(state, DeviceState::Unknown(0xaa));
    assert_eq!(state.to_wire(), 0xaa);
    assert_eq!(connection, ConnectionType::Unknown(0xbb));
    assert_eq!(connection.to_wire(), 0xbb);
}

#[test]
fn device_serial_numbers_reject_empty_or_non_alphanumeric_values() {
    assert!(DeviceSerialNumber::new("C8SU2XXWHI").is_ok());
    assert!(DeviceSerialNumber::new("").is_err());
    assert!(DeviceSerialNumber::new("C8SU 2XXWHI").is_err());
}

#[test]
fn recording_uuid_requires_the_canonical_shape() {
    let id = RecordingUuid::from_str("a1b2c3d4-0000-0000-0000-000000000000").unwrap();

    assert_eq!(id.to_string(), "a1b2c3d4-0000-0000-0000-000000000000");
    assert!(RecordingUuid::from_str("a1b2c3d4").is_err());
    assert!(RecordingUuid::from_str("zzzzzzzz-0000-0000-0000-000000000000").is_err());
}

#[test]
fn note_settings_remove_cellular_without_reordering_other_channels() {
    let settings = DeviceConnectionSettings {
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
            ConnectionType::Cellular,
            ConnectionType::Ble,
        ],
        power: PowerManagement {
            cellular: IdleTimeout::Seconds(180),
            wifi: IdleTimeout::Seconds(180),
        },
        streaming_enabled: false,
        streaming_flush_interval_seconds: 60,
    };

    let normalized = settings.normalized_for(DeviceModel::Note);

    assert!(!normalized.enabled.cellular);
    assert!(!normalized.heartbeat.cellular);
    assert_eq!(
        normalized.upload_priority,
        vec![ConnectionType::Wifi, ConnectionType::Ble]
    );
}

#[test]
fn idle_timeout_preserves_immediate_and_always_on_semantics() {
    assert_eq!(
        IdleTimeout::try_from_seconds(0).unwrap(),
        IdleTimeout::Immediate
    );
    assert_eq!(
        IdleTimeout::try_from_seconds(-1).unwrap(),
        IdleTimeout::AlwaysOn
    );
    assert_eq!(IdleTimeout::Immediate.seconds(), 0);
    assert_eq!(IdleTimeout::AlwaysOn.seconds(), -1);
    assert!(IdleTimeout::try_from_seconds(-2).is_err());
}

#[test]
fn errors_expose_stable_machine_fields() {
    let error = DeviceSdkError::new(ErrorCode::ProtocolRejected, Operation::Provision, false)
        .with_protocol_status(4)
        .with_detail("device is already paired");

    assert_eq!(error.code.as_str(), "protocol_rejected");
    assert_eq!(error.operation.as_str(), "provision");
    assert!(!error.retryable);
    assert_eq!(error.protocol_status, Some(4));
    assert_eq!(error.detail.as_deref(), Some("device is already paired"));
}
