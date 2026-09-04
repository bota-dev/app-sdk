use bota_device_sdk_core::{
    engine::{
        BleEvent, CancellationId, Capability, CapabilitySet, Command, Effect, Event, HostEvent,
        HostEventKind, RequestId, WorkflowEngine, WorkflowNotification, WorkflowStatus,
    },
    error::ErrorCode,
    generated::protocol,
    model::{
        DeviceCandidate, DeviceSerialNumber, FactoryResetCommandId, FactoryResetResult,
        FirmwareImage, HostMaterialId, ReconnectHint, RecordingSinkId, RecordingUploadProfile,
        RecordingUuid, UploadDestinationId, UploadProfileSelection, UploadSecurityPolicy,
        UploadSessionId,
    },
    protocol::EncryptedUploadV2Capabilities,
    workflow::EncryptedUploadV2BatchRequest,
};

const CANCELLATION: CancellationId = CancellationId::from_bytes([0x31; 16]);
const OTHER_CANCELLATION: CancellationId = CancellationId::from_bytes([0x32; 16]);

fn device() -> DeviceSerialNumber {
    DeviceSerialNumber::new("EVFXXW67KP").unwrap()
}

fn all_capabilities() -> CapabilitySet {
    CapabilitySet::from([
        Capability::Ble,
        Capability::Timer,
        Capability::Persistence,
        Capability::SecureStorage,
        Capability::NetworkTransfer,
        Capability::Progress,
        Capability::HostMaterial,
        Capability::RecordingSink,
        Capability::FirmwareBlob,
    ])
}

fn commands() -> Vec<(&'static str, Command)> {
    let reset_command = FactoryResetCommandId::new("reset-command-1").unwrap();
    vec![
        (
            "discovery",
            Command::DiscoverDevices {
                timeout_ms: 5_000,
                allow_duplicates: true,
            },
        ),
        (
            "manual connection",
            Command::Connect {
                device: device(),
                candidate: DeviceCandidate {
                    peripheral_id: "candidate-1".into(),
                    name: Some("Bota Pin".into()),
                    advertised_address: None,
                    rssi: -40,
                },
            },
        ),
        (
            "reconnect",
            Command::Reconnect {
                device: device(),
                hint: ReconnectHint::default(),
            },
        ),
        (
            "provisioning",
            Command::Provision {
                device: device(),
                material_id: HostMaterialId::new("provisioning-material-1").unwrap(),
            },
        ),
        (
            "recording transfer",
            Command::TransferRecording {
                device: device(),
                recording: RecordingUuid::from_bytes([0x11; 16]),
                sink_id: RecordingSinkId::new("recording-sink-1").unwrap(),
                total_units: 1_024,
                confirm_on_completion: true,
            },
        ),
        (
            "encrypted upload v2 transfer",
            Command::TransferEncryptedRecording {
                request: EncryptedUploadV2BatchRequest {
                    device: device(),
                    recording: RecordingUuid::from_bytes([0x33; 16]),
                    recording_generation: 9,
                    storage_format: protocol::STORAGE_FORMAT_BOTA_ENC_V2,
                    upload_session_uuid: [0x44; 16],
                    owner_revision: 3,
                    transport_session_id: 0x1122_3344_5566,
                    material_id: HostMaterialId::new("v2-material-1").unwrap(),
                    sink_id: RecordingSinkId::new("v2-sink-1").unwrap(),
                    selection: UploadProfileSelection {
                        policy: UploadSecurityPolicy::V2Preferred,
                        profile: RecordingUploadProfile::EncryptedUploadV2,
                    },
                    capabilities: EncryptedUploadV2Capabilities {
                        flags: 0x7f,
                        maximum_signed_blob_bytes: 1024,
                        maximum_manifest_bytes: 1024,
                        maximum_data_payload_bytes: 244,
                        maximum_window_packets: 16,
                        durable_checkpoint_interval_blocks: 8,
                        maximum_missing_sequences: 16,
                    },
                    window_packets: 16,
                    data_payload_bytes: 244,
                    ciphertext_length: 330,
                    ciphertext_sha256: [0x55; 32],
                },
            },
        ),
        (
            "upload handoff",
            Command::UploadRecording {
                device: device(),
                recording: RecordingUuid::from_bytes([0x22; 16]),
                upload_id: UploadSessionId::new("upload-session-1").unwrap(),
                destination_id: UploadDestinationId::new("upload-destination-1").unwrap(),
            },
        ),
        (
            "firmware update",
            Command::UpdateFirmware {
                device: device(),
                image: FirmwareImage {
                    version: "1.0.18".into(),
                    size_bytes: 1_024,
                    crc32: 0x1234_5678,
                },
                download_id: 41,
                reconnect_hint: ReconnectHint::default(),
            },
        ),
        ("device logs", Command::ReadDeviceLogs { device: device() }),
        (
            "factory reset",
            Command::FactoryReset {
                device: device(),
                command_id: reset_command.clone(),
                grant_id: HostMaterialId::new("reset-grant-1").unwrap(),
            },
        ),
        (
            "factory reset resume",
            Command::ResumeFactoryReset {
                device: device(),
                command_id: reset_command,
                expected_result: Some(FactoryResetResult {
                    result_code: 0,
                    deleted_recording_count: 2,
                }),
            },
        ),
    ]
}

#[test]
fn cancellation_matrix_covers_every_operation() {
    for (label, command) in commands() {
        let operation = command.operation();
        let mut engine = WorkflowEngine::default();
        engine
            .start(command, &all_capabilities(), CANCELLATION)
            .unwrap_or_else(|error| panic!("{label} failed to start: {error}"));

        let effects = engine
            .dispatch(Event::Cancelled {
                cancellation_id: CANCELLATION,
            })
            .unwrap_or_else(|error| panic!("{label} failed to cancel: {error}"));

        assert!(
            effects.iter().any(|request| matches!(
                request.effect,
                Effect::Notify(WorkflowNotification::Cancelled { operation: value })
                    if value == operation
            )),
            "{label} did not emit cancellation"
        );
        assert_eq!(
            engine.status(),
            &WorkflowStatus::Cancelled { operation },
            "{label} did not become cancelled"
        );
    }
}

#[test]
fn stale_event_matrix_preserves_every_active_owner() {
    for (label, command) in commands() {
        let operation = command.operation();
        let mut engine = WorkflowEngine::default();
        engine
            .start(command, &all_capabilities(), CANCELLATION)
            .unwrap_or_else(|error| panic!("{label} failed to start: {error}"));

        let error = engine
            .dispatch(Event::Host(HostEvent {
                request_id: RequestId::from_u64(99_999),
                kind: HostEventKind::Ble(BleEvent::WriteCompleted),
            }))
            .expect_err("stale callback must be rejected");

        assert_eq!(error.code, ErrorCode::UnexpectedEvent, "{label}");
        assert_eq!(
            engine.status(),
            &WorkflowStatus::Running {
                operation,
                cancellation_id: CANCELLATION,
            },
            "{label} lost ownership after a stale callback"
        );
    }
}

#[test]
fn second_command_matrix_never_mutates_the_active_owner() {
    for (label, command) in commands() {
        let operation = command.operation();
        let mut engine = WorkflowEngine::default();
        engine
            .start(command.clone(), &all_capabilities(), CANCELLATION)
            .unwrap_or_else(|error| panic!("{label} failed to start: {error}"));

        let error = engine
            .start(command, &all_capabilities(), OTHER_CANCELLATION)
            .expect_err("second command must be rejected");

        assert_eq!(error.code, ErrorCode::OperationInProgress, "{label}");
        assert_eq!(
            engine.status(),
            &WorkflowStatus::Running {
                operation,
                cancellation_id: CANCELLATION,
            },
            "{label} owner changed after a second command"
        );
    }
}
