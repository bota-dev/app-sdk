use bota_device_sdk_core::{
    engine::{
        BleEffect, BleEvent, Effect, EncryptedUploadV2HostEffect, HostEvent, HostEventKind,
        PersistenceEffect, WorkflowNotification, WorkflowStatus,
    },
    error::{DeviceSdkError, ErrorCode, Operation},
    generated::protocol,
    model::{ReconnectHint, UploadSecurityPolicy},
    protocol::{DeprovisionFailure, EncryptedUploadV2Capabilities},
};
use bota_device_sdk_wasm::{
    BridgeCore, WebIntegrityHasher, decode_deprovision_result_dto, decode_device_status_dto,
    decode_encrypted_upload_v2_capabilities_dto, decode_recording_list_dto,
    encode_deprovision_command, encode_recording_confirm, encode_recording_list_command,
};

const SERIAL: &str = "EVFXXW67KP";
const CANCELLATION_ID: [u8; 16] = [0x11; 16];
const RECORDING_UUID: [u8; 16] = [0x22; 16];

#[derive(Clone, Copy, Debug)]
enum WorkflowCase {
    Reconnect,
    Provisioning,
    RecordingTransfer,
    EncryptedUploadV2,
    FirmwareUpdate,
    DeviceLogs,
}

impl WorkflowCase {
    const ALL: [Self; 6] = [
        Self::Reconnect,
        Self::Provisioning,
        Self::RecordingTransfer,
        Self::EncryptedUploadV2,
        Self::FirmwareUpdate,
        Self::DeviceLogs,
    ];

    const fn operation(self) -> Operation {
        match self {
            Self::Reconnect => Operation::Reconnect,
            Self::Provisioning => Operation::Provision,
            Self::RecordingTransfer | Self::EncryptedUploadV2 => Operation::TransferRecording,
            Self::FirmwareUpdate => Operation::UpdateFirmware,
            Self::DeviceLogs => Operation::ReadDeviceLogs,
        }
    }

    fn start(
        self,
        bridge: &mut BridgeCore,
        serial: &str,
    ) -> Result<Vec<bota_device_sdk_core::engine::EffectRequest>, DeviceSdkError> {
        match self {
            Self::Reconnect => bridge.start_reconnect(
                serial,
                ReconnectHint {
                    stored_peripheral_id: Some("browser-peripheral-1".to_owned()),
                    advertised_address: Some("001122334455".to_owned()),
                    stored_name: Some("Bota Pin".to_owned()),
                    scan_timeout_ms: 5_000,
                    connection_timeout_ms: 15_000,
                },
                CANCELLATION_ID,
            ),
            Self::Provisioning => {
                bridge.start_provisioning(serial, "web-material-1", CANCELLATION_ID)
            }
            Self::RecordingTransfer => bridge.start_recording_transfer(
                serial,
                RECORDING_UUID,
                "web-sink-1",
                4_096,
                CANCELLATION_ID,
            ),
            Self::EncryptedUploadV2 => bridge.start_encrypted_upload_v2(
                serial,
                RECORDING_UUID,
                9,
                protocol::STORAGE_FORMAT_BOTA_ENC_V2,
                [0x44; 16],
                3,
                0x1122_3344_5566,
                "web-v2-material-1",
                "web-v2-sink-1",
                UploadSecurityPolicy::V2Preferred,
                encrypted_upload_v2_capabilities(),
                16,
                244,
                330,
                [0x33; 32],
                CANCELLATION_ID,
            ),
            Self::FirmwareUpdate => bridge.start_firmware_update(
                serial,
                "1.0.18",
                1_024,
                0x1234_5678,
                41,
                ReconnectHint::default(),
                CANCELLATION_ID,
            ),
            Self::DeviceLogs => bridge.start_device_logs(serial, CANCELLATION_ID),
        }
    }

    fn first_semantic_effect_matches(self, effect: &Effect) -> bool {
        match self {
            Self::Reconnect => matches!(effect, Effect::Ble(BleEffect::StartScan { .. })),
            Self::Provisioning => matches!(effect, Effect::Ble(BleEffect::Read { .. })),
            Self::RecordingTransfer | Self::FirmwareUpdate => matches!(
                effect,
                Effect::Persistence(PersistenceEffect::LoadCheckpoint)
            ),
            Self::EncryptedUploadV2 => matches!(
                effect,
                Effect::EncryptedUploadV2(EncryptedUploadV2HostEffect::LoadCheckpoint { .. })
            ),
            Self::DeviceLogs => matches!(effect, Effect::Ble(BleEffect::Subscribe { .. })),
        }
    }
}

fn encrypted_upload_v2_capabilities() -> EncryptedUploadV2Capabilities {
    EncryptedUploadV2Capabilities {
        flags: 0x7f,
        maximum_signed_blob_bytes: 1_024,
        maximum_manifest_bytes: 1_024,
        maximum_data_payload_bytes: 244,
        maximum_window_packets: 16,
        durable_checkpoint_interval_blocks: 8,
        maximum_missing_sequences: 16,
    }
}

fn request_id_for(
    effects: &[bota_device_sdk_core::engine::EffectRequest],
    predicate: impl Fn(&Effect) -> bool,
) -> bota_device_sdk_core::engine::RequestId {
    effects
        .iter()
        .find(|request| predicate(&request.effect))
        .map(|request| request.request_id)
        .expect("expected effect")
}

#[test]
fn included_workflow_starts_supply_capabilities_and_preserve_ownership() {
    for workflow in WorkflowCase::ALL {
        let mut bridge = BridgeCore::default();

        let effects = workflow
            .start(&mut bridge, SERIAL)
            .unwrap_or_else(|error| panic!("{workflow:?} should start: {error}"));

        assert!(workflow.first_semantic_effect_matches(&effects[1].effect));
        assert!(effects.iter().all(|request| {
            request.operation == workflow.operation()
                && request.cancellation_id.as_bytes() == &CANCELLATION_ID
        }));
        assert!(matches!(
            bridge.status(),
            WorkflowStatus::Running {
                operation,
                cancellation_id,
            } if *operation == workflow.operation()
                && cancellation_id.as_bytes() == &CANCELLATION_ID
        ));
    }
}

#[test]
fn recording_transfer_starts_without_device_confirmation() {
    let effects = BridgeCore::default()
        .start_recording_transfer(SERIAL, RECORDING_UUID, "web-sink-1", 4096, CANCELLATION_ID)
        .unwrap();
    assert!(matches!(
        effects[1].effect,
        Effect::Persistence(PersistenceEffect::LoadCheckpoint)
    ));
}

#[test]
fn included_workflow_starts_return_structured_invalid_input_errors() {
    for workflow in WorkflowCase::ALL {
        let error = workflow
            .start(&mut BridgeCore::default(), "invalid serial!")
            .expect_err("invalid serial must fail before workflow ownership");

        assert_eq!(error.code, ErrorCode::InvalidInput, "{workflow:?}");
        assert_eq!(error.operation, Operation::Validate, "{workflow:?}");
    }
}

#[test]
fn included_workflows_enforce_one_exact_cancellation_owner() {
    for workflow in WorkflowCase::ALL {
        let mut bridge = BridgeCore::default();
        workflow.start(&mut bridge, SERIAL).unwrap();

        let second_owner = workflow
            .start(&mut bridge, SERIAL)
            .expect_err("a second workflow owner must be rejected");
        assert_eq!(second_owner.code, ErrorCode::OperationInProgress);
        assert_eq!(second_owner.operation, workflow.operation());

        let wrong_owner = bridge
            .cancel([0x12; 16])
            .expect_err("a different cancellation ID must be rejected");
        assert_eq!(wrong_owner.code, ErrorCode::UnexpectedEvent);
        assert_eq!(wrong_owner.operation, workflow.operation());

        let effects = bridge
            .cancel(CANCELLATION_ID)
            .expect("the exact cancellation owner should settle the workflow");
        assert!(effects.iter().all(|request| {
            request.operation == workflow.operation()
                && request.cancellation_id.as_bytes() == &CANCELLATION_ID
        }));
        assert!(matches!(
            bridge.status(),
            WorkflowStatus::Cancelled { operation } if *operation == workflow.operation()
        ));
        assert!(bridge.cancel(CANCELLATION_ID).unwrap().is_empty());
    }
}

#[test]
fn exact_connection_is_owned_by_the_shared_rust_workflow() {
    let mut bridge = BridgeCore::default();
    let cancellation_id = [0x5a; 16];

    let effects = bridge
        .start_exact_connection(
            "GDPPSBZJN6",
            "browser-peripheral-1",
            Some("Bota Pin"),
            cancellation_id,
        )
        .expect("connection should start");
    let connect_request = request_id_for(&effects, |effect| {
        matches!(
            effect,
            Effect::Ble(BleEffect::Connect { peripheral_id })
                if peripheral_id == "browser-peripheral-1"
        )
    });

    let effects = bridge
        .dispatch(HostEvent {
            request_id: connect_request,
            kind: HostEventKind::Ble(BleEvent::Connected {
                peripheral_id: "browser-peripheral-1".to_owned(),
            }),
        })
        .expect("connect event should be accepted");
    let discover_request = request_id_for(&effects, |effect| {
        matches!(effect, Effect::Ble(BleEffect::DiscoverServices { .. }))
    });

    let effects = bridge
        .dispatch(HostEvent {
            request_id: discover_request,
            kind: HostEventKind::Ble(BleEvent::ServicesDiscovered {
                peripheral_id: "browser-peripheral-1".to_owned(),
            }),
        })
        .expect("service discovery should be accepted");
    let serial_request = request_id_for(&effects, |effect| {
        matches!(
            effect,
            Effect::Ble(BleEffect::Read {
                service_uuid,
                characteristic_uuid,
            }) if service_uuid == "180A" && characteristic_uuid == "2A25"
        )
    });

    let effects = bridge
        .dispatch(HostEvent {
            request_id: serial_request,
            kind: HostEventKind::Ble(BleEvent::ReadCompleted {
                value: b"GDPPSBZJN6".to_vec(),
            }),
        })
        .expect("serial read should be accepted");
    let persist_request = request_id_for(&effects, |effect| {
        matches!(
            effect,
            Effect::Persistence(PersistenceEffect::SaveConnectionIdentity { device, candidate })
                if device.as_str() == "GDPPSBZJN6"
                    && candidate.peripheral_id == "browser-peripheral-1"
        )
    });

    let effects = bridge
        .dispatch(HostEvent {
            request_id: persist_request,
            kind: HostEventKind::ConnectionIdentitySaved,
        })
        .expect("identity persistence should complete the workflow");

    assert!(effects.iter().any(|request| {
        matches!(
            &request.effect,
            Effect::Notify(WorkflowNotification::ConnectionEstablished { device, .. })
                if device.as_str() == "GDPPSBZJN6"
        )
    }));
    assert!(matches!(bridge.status(), WorkflowStatus::Completed { .. }));
}

#[test]
fn status_decoder_uses_the_frozen_status_layout() {
    let status = decode_device_status_dto(&[
        0x43, 0x03, 0x03, 0x01, 0x00, 0xf1, 0x53, 0x65, 0x18, 0x00, 0x08, 0x00, 0x02, 0x14, 0x03,
        0x68, 0x10, 0x49, 0x4d, 0x45, 0x49, 0x3d, 0x31, 0x32, 0x33, 0x0a, 0x52, 0x4f, 0x41, 0x4d,
        0x3d, 0x31, 0x0a,
    ])
    .expect("valid status should decode");

    assert_eq!(status.battery_percent, 67);
    assert_eq!(status.battery_mv, Some(4200));
    assert_eq!(status.storage_total_mb, 2048);
    assert_eq!(status.storage_used_mb, 512);
    assert_eq!(status.pending_recordings, 1);
    assert!(status.flags.wifi_connected);
    assert!(status.flags.lte_connected);
    assert_eq!(
        status.modem_info.expect("modem info").imei.as_deref(),
        Some("123")
    );
}

#[test]
fn encrypted_upload_capability_decoder_preserves_exact_bounds() {
    let decoded = decode_encrypted_upload_v2_capabilities_dto(&[
        0x01, 0x02, 0x18, 0x00, 0x7f, 0x00, 0x00, 0x00, 0x98, 0x01, 0x44, 0x02, 0xf4, 0x00, 0x10,
        0x00, 0x08, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00,
    ])
    .expect("valid capabilities should decode");

    assert_eq!(
        decoded,
        EncryptedUploadV2Capabilities {
            flags: 0x7f,
            maximum_signed_blob_bytes: 408,
            maximum_manifest_bytes: 580,
            maximum_data_payload_bytes: 244,
            maximum_window_packets: 16,
            durable_checkpoint_interval_blocks: 8,
            maximum_missing_sequences: 4,
        }
    );
}

#[test]
fn malformed_status_is_rejected_by_the_shared_decoder() {
    let error = decode_device_status_dto(&[0x00, 0x01]).expect_err("truncated status must fail");

    assert_eq!(error.code.as_str(), "truncated_packet");
    assert_eq!(error.operation.as_str(), "decode");
}

#[test]
fn codecs_delegate_legacy_packets_to_the_shared_rust_authority() {
    let recordings = decode_recording_list_dto(&[
        0xa1, 0xb2, 0xc3, 0xd4, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0xf1, 0x53, 0x65, 0x0c, 0x00, 0x04, 0x00,
    ])
    .expect("recording fixture should decode");

    assert_eq!(recordings.len(), 1);
    assert_eq!(recordings[0].uuid, "a1b2c3d4-0000-0000-0000-000000000000");
    assert_eq!(encode_recording_list_command().unwrap(), [0x01]);
    assert_eq!(
        encode_recording_confirm("a1b2c3d4-0000-0000-0000-000000000000").unwrap(),
        [
            0x07, 0xa1, 0xb2, 0xc3, 0xd4, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00,
        ]
    );
    assert!(encode_recording_confirm("not-a-uuid").is_err());
    assert_eq!(encode_deprovision_command().unwrap(), [0x05]);

    let unknown = decode_deprovision_result_dto(&[0xfe]).unwrap();
    assert!(!unknown.success);
    assert_eq!(unknown.error, Some(DeprovisionFailure::Unknown(0xfe)));
    assert!(decode_deprovision_result_dto(&[]).is_err());
    assert!(decode_deprovision_result_dto(&[0, 0]).is_err());
}

#[test]
fn codecs_integrity_hasher_streams_without_consuming_snapshots() {
    let mut hasher = WebIntegrityHasher::new();
    hasher.update(b"1234");
    let prefix = hasher.sha256_snapshot();
    hasher.update(b"56789");

    assert_eq!(hasher.length(), 9);
    assert_eq!(hasher.crc32(), 0xcbf4_3926);
    assert_eq!(
        hasher.sha256_snapshot(),
        [
            0x15, 0xe2, 0xb0, 0xd3, 0xc3, 0x38, 0x91, 0xeb, 0xb0, 0xf1, 0xef, 0x60, 0x9e, 0xc4,
            0x19, 0x42, 0x0c, 0x20, 0xe3, 0x20, 0xce, 0x94, 0xc6, 0x5f, 0xbc, 0x8c, 0x33, 0x12,
            0x44, 0x8e, 0xb2, 0x25,
        ]
    );
    assert_ne!(prefix, hasher.sha256_snapshot());
}
