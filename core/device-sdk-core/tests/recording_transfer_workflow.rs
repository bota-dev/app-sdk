use bota_device_sdk_core::{
    engine::{
        BleEffect, BleEvent, CancellationId, Capability, CapabilitySet, CheckpointPhase, Command,
        Effect, EffectRequest, Event, HostEvent, HostEventKind, PersistenceEffect,
        RecordingSinkEffect, RequestId, WorkflowCheckpoint, WorkflowEngine, WorkflowKind,
        WorkflowNotification, WorkflowStatus,
    },
    error::{ErrorCode, Operation},
    generated::protocol::{
        ACK_TYPE_ABORT, ACK_TYPE_ACK, ACK_TYPE_NACK, CHAR_RECORDING_TRANSFER, CHAR_TRANSFER_CONTROL,
    },
    model::{DeviceSerialNumber, RecordingSinkId, RecordingUuid},
};

const CANCELLATION: CancellationId = CancellationId::from_bytes([5; 16]);

fn capabilities() -> CapabilitySet {
    CapabilitySet::from([
        Capability::Ble,
        Capability::Persistence,
        Capability::Progress,
        Capability::RecordingSink,
    ])
}

fn device() -> DeviceSerialNumber {
    DeviceSerialNumber::new("EVFXXW67KP").unwrap()
}

fn recording() -> RecordingUuid {
    RecordingUuid::from_bytes([0x11; 16])
}

fn sink() -> RecordingSinkId {
    RecordingSinkId::new("sink-recording-1").unwrap()
}

fn command() -> Command {
    Command::TransferRecording {
        device: device(),
        recording: recording(),
        sink_id: sink(),
        total_units: 10,
    }
}

fn request_id(effects: &[EffectRequest], predicate: impl Fn(&Effect) -> bool) -> RequestId {
    effects
        .iter()
        .find(|request| predicate(&request.effect))
        .expect("expected effect")
        .request_id
}

fn host(request_id: RequestId, kind: HostEventKind) -> Event {
    Event::Host(HostEvent { request_id, kind })
}

fn start_with_checkpoint(
    engine: &mut WorkflowEngine,
    checkpoint: Option<WorkflowCheckpoint>,
) -> (RequestId, RequestId) {
    let started = engine
        .start(command(), &capabilities(), CANCELLATION)
        .unwrap();
    let load_request = request_id(&started, |effect| {
        matches!(
            effect,
            Effect::Persistence(PersistenceEffect::LoadCheckpoint)
        )
    });
    let truncating = engine
        .dispatch(host(
            load_request,
            HostEventKind::CheckpointLoaded { checkpoint },
        ))
        .unwrap();
    let truncate_request = request_id(&truncating, |effect| {
        matches!(
            effect,
            Effect::RecordingSink(RecordingSinkEffect::Truncate { .. })
        )
    });
    let subscribing = engine
        .dispatch(host(
            truncate_request,
            HostEventKind::RecordingSinkTruncated,
        ))
        .unwrap();
    let subscription_request = request_id(&subscribing, |effect| {
        matches!(
            effect,
            Effect::Ble(BleEffect::Subscribe { characteristic_uuid, .. })
                if characteristic_uuid == CHAR_RECORDING_TRANSFER
        )
    });
    let starting = engine
        .dispatch(host(
            subscription_request,
            HostEventKind::Ble(BleEvent::Subscribed {
                characteristic_uuid: CHAR_RECORDING_TRANSFER.into(),
            }),
        ))
        .unwrap();
    let start_request = request_id(&starting, |effect| {
        matches!(
            effect,
            Effect::Ble(BleEffect::Write { characteristic_uuid, payload, .. })
                if characteristic_uuid == CHAR_TRANSFER_CONTROL
                    && payload.first() == Some(&2)
        )
    });
    engine
        .dispatch(host(
            start_request,
            HostEventKind::Ble(BleEvent::WriteCompleted),
        ))
        .unwrap();
    (subscription_request, start_request)
}

fn data(sequence: u16, payload: &[u8]) -> Vec<u8> {
    let mut bytes = vec![1];
    bytes.extend_from_slice(&sequence.to_le_bytes());
    bytes.extend_from_slice(&(payload.len() as u16).to_le_bytes());
    bytes.extend_from_slice(payload);
    bytes
}

fn eof(sequence: u16, checksum: u32) -> Vec<u8> {
    let mut bytes = vec![2];
    bytes.extend_from_slice(&sequence.to_le_bytes());
    bytes.extend_from_slice(&checksum.to_le_bytes());
    bytes
}

#[test]
fn transfer_subscribes_before_start_and_appends_before_checkpointing() {
    let mut engine = WorkflowEngine::default();
    let started = engine
        .start(command(), &capabilities(), CANCELLATION)
        .unwrap();
    assert!(!started.iter().any(|request| matches!(
        request.effect,
        Effect::Ble(BleEffect::Write { .. } | BleEffect::Subscribe { .. })
    )));

    let load_request = request_id(&started, |effect| {
        matches!(
            effect,
            Effect::Persistence(PersistenceEffect::LoadCheckpoint)
        )
    });
    let truncating = engine
        .dispatch(host(
            load_request,
            HostEventKind::CheckpointLoaded { checkpoint: None },
        ))
        .unwrap();
    assert!(truncating.iter().any(|request| matches!(
        &request.effect,
        Effect::RecordingSink(RecordingSinkEffect::Truncate {
            sink_id,
            completed_units: 0,
        }) if sink_id == &sink()
    )));
    assert!(!truncating.iter().any(|request| matches!(
        request.effect,
        Effect::Ble(BleEffect::Write { .. } | BleEffect::Subscribe { .. })
    )));

    let mut engine = WorkflowEngine::default();
    let (subscription_request, _) = start_with_checkpoint(&mut engine, None);
    let appending = engine
        .dispatch(host(
            subscription_request,
            HostEventKind::Ble(BleEvent::Notification {
                characteristic_uuid: CHAR_RECORDING_TRANSFER.into(),
                value: data(0, &[0xaa, 0xbb]),
            }),
        ))
        .unwrap();
    let append_request = request_id(&appending, |effect| {
        matches!(
            effect,
            Effect::RecordingSink(RecordingSinkEffect::Append {
                sequence: 0,
                payload,
                ..
            }) if payload == &[0xaa, 0xbb]
        )
    });
    assert!(!appending.iter().any(|request| matches!(
        request.effect,
        Effect::Ble(BleEffect::Write { .. })
            | Effect::Persistence(PersistenceEffect::SaveCheckpoint { .. })
    )));

    let persisted = engine
        .dispatch(host(
            append_request,
            HostEventKind::RecordingSinkAppendCompleted { durable_units: 2 },
        ))
        .unwrap();
    assert!(persisted.iter().any(|request| matches!(
        &request.effect,
        Effect::Persistence(PersistenceEffect::SaveCheckpoint { checkpoint })
            if checkpoint.last_sequence == Some(0) && checkpoint.completed_units == 2
    )));
    assert!(
        persisted
            .iter()
            .any(|request| matches!(request.effect, Effect::Progress(_)))
    );
    assert!(
        !persisted
            .iter()
            .any(|request| matches!(request.effect, Effect::Ble(BleEffect::Write { .. })))
    );
}

#[test]
fn duplicate_packets_are_idempotent_and_resume_skips_durable_sequences() {
    let mut engine = WorkflowEngine::default();
    let checkpoint = WorkflowCheckpoint {
        workflow: WorkflowKind::RecordingTransfer,
        operation: Operation::TransferRecording,
        device: device(),
        recording: Some(recording()),
        phase: CheckpointPhase::Transferring,
        completed_units: 8,
        retry_count: 1,
        last_sequence: Some(1),
    };
    let (subscription_request, _) = start_with_checkpoint(&mut engine, Some(checkpoint));

    for sequence in [0, 1] {
        let duplicate = engine
            .dispatch(host(
                subscription_request,
                HostEventKind::Ble(BleEvent::Notification {
                    characteristic_uuid: CHAR_RECORDING_TRANSFER.into(),
                    value: data(sequence, &[sequence as u8]),
                }),
            ))
            .unwrap();
        assert!(duplicate.is_empty());
    }

    let next = engine
        .dispatch(host(
            subscription_request,
            HostEventKind::Ble(BleEvent::Notification {
                characteristic_uuid: CHAR_RECORDING_TRANSFER.into(),
                value: data(2, &[0xcc]),
            }),
        ))
        .unwrap();
    assert!(next.iter().any(|request| matches!(
        &request.effect,
        Effect::RecordingSink(RecordingSinkEffect::Append {
            sequence: 2,
            payload,
            ..
        }) if payload == &[0xcc]
    )));
}

#[test]
fn disconnect_retains_durable_sink_for_retry_and_cancel_never_confirms_delete() {
    let mut engine = WorkflowEngine::default();
    let (subscription_request, _) = start_with_checkpoint(&mut engine, None);
    let failed = engine
        .dispatch(host(
            subscription_request,
            HostEventKind::Ble(BleEvent::Disconnected {
                peripheral_id: "device-1".into(),
                reason_code: None,
            }),
        ))
        .unwrap();
    assert!(matches!(
        engine.status(),
        WorkflowStatus::Failed { error }
            if error.code == ErrorCode::NotConnected && error.retryable
    ));
    assert!(!failed.iter().any(|request| matches!(
        request.effect,
        Effect::RecordingSink(RecordingSinkEffect::Discard { .. })
            | Effect::Persistence(PersistenceEffect::DeleteCheckpoint)
    )));

    let mut engine = WorkflowEngine::default();
    start_with_checkpoint(&mut engine, None);
    let cancelled = engine
        .dispatch(Event::Cancelled {
            cancellation_id: CANCELLATION,
        })
        .unwrap();
    assert!(cancelled.iter().any(|request| matches!(
        &request.effect,
        Effect::Ble(BleEffect::Write {
            characteristic_uuid,
            payload,
            ..
        }) if characteristic_uuid == CHAR_RECORDING_TRANSFER
            && payload.first() == Some(&ACK_TYPE_ABORT)
    )));
    assert!(cancelled.iter().any(|request| matches!(
        request.effect,
        Effect::RecordingSink(RecordingSinkEffect::Discard { .. })
    )));
    assert!(!cancelled.iter().any(|request| matches!(
        &request.effect,
        Effect::Ble(BleEffect::Write {
            characteristic_uuid,
            payload,
            ..
        }) if characteristic_uuid == CHAR_TRANSFER_CONTROL
            && payload.first() == Some(&7)
    )));
}

#[test]
fn integrity_failure_nacks_and_never_confirms_delete() {
    let mut engine = WorkflowEngine::default();
    let (subscription_request, _) = start_with_checkpoint(&mut engine, None);
    let finalizing = engine
        .dispatch(host(
            subscription_request,
            HostEventKind::Ble(BleEvent::Notification {
                characteristic_uuid: CHAR_RECORDING_TRANSFER.into(),
                value: eof(0, 0x1234_5678),
            }),
        ))
        .unwrap();
    let finalize_request = request_id(&finalizing, |effect| {
        matches!(
            effect,
            Effect::RecordingSink(RecordingSinkEffect::Finalize {
                expected_crc32: Some(0x1234_5678),
                ..
            })
        )
    });
    assert!(
        !finalizing
            .iter()
            .any(|request| matches!(request.effect, Effect::Ble(BleEffect::Write { .. })))
    );

    let failed = engine
        .dispatch(host(
            finalize_request,
            HostEventKind::RecordingSinkIntegrityFailed,
        ))
        .unwrap();
    assert!(failed.iter().any(|request| matches!(
        &request.effect,
        Effect::Ble(BleEffect::Write { payload, .. })
            if payload.first() == Some(&ACK_TYPE_NACK)
    )));
    assert!(!failed.iter().any(|request| matches!(
        &request.effect,
        Effect::Ble(BleEffect::Write {
            characteristic_uuid,
            payload,
            ..
        }) if characteristic_uuid == CHAR_TRANSFER_CONTROL
            && payload.first() == Some(&7)
    )));
}

#[test]
fn confirm_delete_occurs_only_after_durable_sink_finalization_and_final_ack() {
    let mut engine = WorkflowEngine::default();
    let (subscription_request, _) = start_with_checkpoint(&mut engine, None);
    let finalizing = engine
        .dispatch(host(
            subscription_request,
            HostEventKind::Ble(BleEvent::Notification {
                characteristic_uuid: CHAR_RECORDING_TRANSFER.into(),
                value: eof(0, 0x1234_5678),
            }),
        ))
        .unwrap();
    let finalize_request = request_id(&finalizing, |effect| {
        matches!(
            effect,
            Effect::RecordingSink(RecordingSinkEffect::Finalize { .. })
        )
    });
    assert!(
        !finalizing
            .iter()
            .any(|request| matches!(request.effect, Effect::Ble(BleEffect::Write { .. })))
    );

    let acknowledging = engine
        .dispatch(host(
            finalize_request,
            HostEventKind::RecordingSinkFinalized { durable_units: 10 },
        ))
        .unwrap();
    let ack_request = request_id(&acknowledging, |effect| {
        matches!(
            effect,
            Effect::Ble(BleEffect::Write {
                characteristic_uuid,
                payload,
                ..
            }) if characteristic_uuid == CHAR_RECORDING_TRANSFER
                && payload.first() == Some(&ACK_TYPE_ACK)
        )
    });
    assert!(!acknowledging.iter().any(|request| matches!(
        &request.effect,
        Effect::Ble(BleEffect::Write {
            characteristic_uuid,
            payload,
            ..
        }) if characteristic_uuid == CHAR_TRANSFER_CONTROL
            && payload.first() == Some(&7)
    )));

    let confirming = engine
        .dispatch(host(
            ack_request,
            HostEventKind::Ble(BleEvent::WriteCompleted),
        ))
        .unwrap();
    let confirm_request = request_id(&confirming, |effect| {
        matches!(
            effect,
            Effect::Ble(BleEffect::Write {
                characteristic_uuid,
                payload,
                ..
            }) if characteristic_uuid == CHAR_TRANSFER_CONTROL
                && payload.first() == Some(&7)
        )
    });
    let completed = engine
        .dispatch(host(
            confirm_request,
            HostEventKind::Ble(BleEvent::WriteCompleted),
        ))
        .unwrap();
    assert!(completed.iter().any(|request| matches!(
        request.effect,
        Effect::Notify(WorkflowNotification::Completed {
            operation: Operation::TransferRecording,
        })
    )));
}
