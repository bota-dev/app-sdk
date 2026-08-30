use std::{fs, str::FromStr};

use bota_device_sdk_core::{
    engine::{
        BleEffect, BleEvent, CancellationId, Capability, CapabilitySet, CheckpointPhase, Command,
        Effect, EffectRequest, Event, HostEvent, HostEventKind, NetworkEffect, NetworkEvent,
        PersistenceEffect, ProgressEffect, RequestId, SecureStorageEffect, TimerEffect,
        WorkflowCheckpoint, WorkflowKind,
    },
    error::{ErrorCode, Operation},
    model::{DeviceSerialNumber, RecordingSinkId, RecordingUuid},
};

#[test]
fn unsupported_capability_fails_before_transport_effect_is_built() {
    let command = Command::TransferRecording {
        device: DeviceSerialNumber::new("C8SU2XXWHI").unwrap(),
        recording: recording_id(),
        sink_id: RecordingSinkId::new("sink-1").unwrap(),
        total_units: 4,
    };
    let capabilities = CapabilitySet::from([Capability::Persistence]);
    let mut transport_effect_built = false;

    let result = command.authorize(&capabilities).map(|_| {
        transport_effect_built = true;
        Effect::Ble(BleEffect::Write {
            service_uuid: "B07A0004-0000-1000-8000-00805F9B34FB".into(),
            characteristic_uuid: "B07A0004-0004-1000-8000-00805F9B34FB".into(),
            payload: vec![0x01],
            with_response: true,
        })
    });

    assert_eq!(result.unwrap_err().code, ErrorCode::UnsupportedCapability);
    assert!(!transport_effect_built);
}

#[test]
fn every_effect_request_carries_operation_and_cancellation_identity() {
    let request = EffectRequest::new(
        RequestId::from_u64(1),
        Operation::TransferRecording,
        CancellationId::from_bytes([7; 16]),
        Effect::Ble(BleEffect::Read {
            service_uuid: "service".into(),
            characteristic_uuid: "characteristic".into(),
        }),
    );

    assert_eq!(request.operation, Operation::TransferRecording);
    assert_eq!(request.request_id.as_u64(), 1);
    assert_eq!(request.cancellation_id.as_bytes(), &[7; 16]);
}

#[test]
fn host_side_work_is_explicit_in_the_effect_vocabulary() {
    let effects = [
        Effect::Timer(TimerEffect::Schedule {
            timer_id: 1,
            delay_ms: 500,
        }),
        Effect::Persistence(PersistenceEffect::SaveCheckpoint {
            checkpoint: checkpoint(),
        }),
        Effect::SecureStorage(SecureStorageEffect::Read {
            key: "device-token".into(),
        }),
        Effect::Ble(BleEffect::StartScan {
            allow_duplicates: true,
        }),
        Effect::Network(NetworkEffect::Upload {
            upload_id: 8,
            source: bota_device_sdk_core::engine::UploadSource::HostFile,
        }),
        Effect::Progress(ProgressEffect {
            completed_units: 4,
            total_units: 10,
        }),
    ];

    assert!(matches!(effects[0], Effect::Timer(_)));
    assert!(matches!(effects[1], Effect::Persistence(_)));
    assert!(matches!(effects[2], Effect::SecureStorage(_)));
    assert!(matches!(effects[3], Effect::Ble(_)));
    assert!(matches!(effects[4], Effect::Network(_)));
    assert!(matches!(effects[5], Effect::Progress(_)));
}

#[test]
fn platform_callbacks_enter_only_as_typed_events() {
    let events = [
        Event::Host(HostEvent {
            request_id: RequestId::from_u64(1),
            kind: HostEventKind::Ble(BleEvent::WriteCompleted),
        }),
        Event::Host(HostEvent {
            request_id: RequestId::from_u64(2),
            kind: HostEventKind::TimerFired { timer_id: 1 },
        }),
        Event::Host(HostEvent {
            request_id: RequestId::from_u64(3),
            kind: HostEventKind::CheckpointLoaded { checkpoint: None },
        }),
        Event::Host(HostEvent {
            request_id: RequestId::from_u64(4),
            kind: HostEventKind::SecretLoaded {
                key: "device-token".into(),
                value: None,
            },
        }),
        Event::Host(HostEvent {
            request_id: RequestId::from_u64(5),
            kind: HostEventKind::Network(NetworkEvent::UploadCompleted { upload_id: 8 }),
        }),
        Event::Cancelled {
            cancellation_id: CancellationId::from_bytes([7; 16]),
        },
    ];

    assert_eq!(events.len(), 6);
}

#[test]
fn checkpoints_cannot_contain_credentials_or_recording_payloads() {
    let json = serde_json::to_value(checkpoint()).unwrap();
    let serialized = serde_json::to_string(&json).unwrap();

    for forbidden in [
        "token",
        "password",
        "credential",
        "private_key",
        "payload",
        "audio",
        "presigned",
    ] {
        assert!(
            !serialized.contains(forbidden),
            "checkpoint leaked {forbidden}"
        );
    }
}

#[test]
fn core_has_no_platform_transport_runtime_or_filesystem_dependency() {
    let manifest = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml")).unwrap();
    for forbidden in [
        "tokio",
        "async-std",
        "reqwest",
        "btleplug",
        "uniffi",
        "flutter_rust_bridge",
        "cbindgen",
    ] {
        assert!(!manifest.contains(forbidden), "core depends on {forbidden}");
    }
}

fn checkpoint() -> WorkflowCheckpoint {
    WorkflowCheckpoint {
        workflow: WorkflowKind::RecordingTransfer,
        operation: Operation::TransferRecording,
        device: DeviceSerialNumber::new("C8SU2XXWHI").unwrap(),
        recording: Some(recording_id()),
        phase: CheckpointPhase::Transferring,
        completed_units: 4,
        retry_count: 1,
        last_sequence: None,
        firmware_version: None,
    }
}

fn recording_id() -> RecordingUuid {
    RecordingUuid::from_str("a1b2c3d4-0000-0000-0000-000000000000").unwrap()
}
