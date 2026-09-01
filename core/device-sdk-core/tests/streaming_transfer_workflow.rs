use bota_device_sdk_core::{
    engine::{
        BleEffect, BleEvent, CancellationId, Capability, CapabilitySet, Command, Effect,
        EffectRequest, Event, HostEvent, HostEventKind, RecordingSinkEffect, RequestId,
        WorkflowEngine, WorkflowNotification,
    },
    generated::protocol::{
        CHAR_RECORDING_TRANSFER, CHAR_TRANSFER_CONTROL, PACKET_TYPE_E2E_START,
        PACKET_TYPE_ENCRYPTED_DATA, PACKET_TYPE_ENCRYPTED_EOF,
    },
    model::{DeviceSerialNumber, RecordingSinkId, RecordingUuid},
};

const CANCELLATION: CancellationId = CancellationId::from_bytes([0x71; 16]);

fn capabilities() -> CapabilitySet {
    CapabilitySet::from([Capability::Ble, Capability::RecordingSink])
}

fn command() -> Command {
    Command::StreamRecording {
        device: DeviceSerialNumber::new("EVFXXW67KP").unwrap(),
        recording: RecordingUuid::from_bytes([0x11; 16]),
        sink_id: RecordingSinkId::new("stream-1").unwrap(),
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

fn start(engine: &mut WorkflowEngine) -> RequestId {
    let started = engine
        .start(command(), &capabilities(), CANCELLATION)
        .unwrap();
    let subscription = request_id(&started, |effect| {
        matches!(
            effect,
            Effect::Ble(BleEffect::Subscribe { characteristic_uuid, .. })
                if characteristic_uuid == CHAR_RECORDING_TRANSFER
        )
    });
    let starting = engine
        .dispatch(host(
            subscription,
            HostEventKind::Ble(BleEvent::Subscribed {
                characteristic_uuid: CHAR_RECORDING_TRANSFER.into(),
            }),
        ))
        .unwrap();
    let write = request_id(&starting, |effect| {
        matches!(
            effect,
            Effect::Ble(BleEffect::Write { characteristic_uuid, payload, .. })
                if characteristic_uuid == CHAR_TRANSFER_CONTROL && payload.first() == Some(&2)
        )
    });
    engine
        .dispatch(host(write, HostEventKind::Ble(BleEvent::WriteCompleted)))
        .unwrap();
    subscription
}

fn notification(subscription: RequestId, value: Vec<u8>) -> Event {
    host(
        subscription,
        HostEventKind::Ble(BleEvent::Notification {
            characteristic_uuid: CHAR_RECORDING_TRANSFER.into(),
            value,
        }),
    )
}

fn data(sequence: u16, payload: &[u8]) -> Vec<u8> {
    let mut bytes = vec![1];
    bytes.extend_from_slice(&sequence.to_le_bytes());
    bytes.extend_from_slice(&(payload.len() as u16).to_le_bytes());
    bytes.extend_from_slice(payload);
    bytes
}

fn paused(sequence: u16, bytes_sent: u32) -> Vec<u8> {
    let mut bytes = vec![3];
    bytes.extend_from_slice(&sequence.to_le_bytes());
    bytes.extend_from_slice(&bytes_sent.to_le_bytes());
    bytes
}

fn eof(sequence: u16, checksum: u32) -> Vec<u8> {
    let mut bytes = vec![2];
    bytes.extend_from_slice(&sequence.to_le_bytes());
    bytes.extend_from_slice(&checksum.to_le_bytes());
    bytes
}

fn e2e_start() -> Vec<u8> {
    let mut bytes = vec![PACKET_TYPE_E2E_START];
    bytes.extend_from_slice(&[0x41; 32]);
    bytes.extend_from_slice(&[0x52; 4]);
    bytes
}

fn encrypted_data(sequence: u16, payload: &[u8]) -> Vec<u8> {
    let mut bytes = vec![PACKET_TYPE_ENCRYPTED_DATA];
    bytes.extend_from_slice(&sequence.to_le_bytes());
    bytes.extend_from_slice(&(payload.len() as u16).to_le_bytes());
    bytes.extend_from_slice(payload);
    bytes
}

fn encrypted_eof(sequence: u16) -> Vec<u8> {
    let mut bytes = vec![PACKET_TYPE_ENCRYPTED_EOF];
    bytes.extend_from_slice(&sequence.to_le_bytes());
    bytes
}

#[test]
fn plaintext_stream_pauses_resumes_and_finalizes_before_device_confirmation() {
    let mut engine = WorkflowEngine::default();
    let subscription = start(&mut engine);
    let appending = engine
        .dispatch(notification(subscription, data(0, &[1, 2, 3])))
        .unwrap();
    let append = request_id(&appending, |effect| {
        matches!(
            effect,
            Effect::RecordingSink(RecordingSinkEffect::AppendStreamingPlaintext {
                sequence: 0,
                payload,
                ..
            }) if payload == &[1, 2, 3]
        )
    });
    engine
        .dispatch(host(
            append,
            HostEventKind::StreamingSinkAccepted {
                received_units: 3,
            },
        ))
        .unwrap();

    let pause = engine
        .dispatch(notification(subscription, paused(1, 3)))
        .unwrap();
    assert!(pause.iter().any(|request| matches!(
        request.effect,
        Effect::Notify(WorkflowNotification::StreamingPaused { completed_units: 3 })
    )));

    let resumed = engine
        .dispatch(notification(subscription, data(1, &[4, 5])))
        .unwrap();
    assert!(resumed.iter().any(|request| matches!(
        request.effect,
        Effect::Notify(WorkflowNotification::StreamingResumed)
    )));
    let append = request_id(&resumed, |effect| {
        matches!(
            effect,
            Effect::RecordingSink(RecordingSinkEffect::AppendStreamingPlaintext {
                sequence: 1,
                payload,
                ..
            }) if payload == &[4, 5]
        )
    });
    engine
        .dispatch(host(
            append,
            HostEventKind::StreamingSinkAccepted {
                received_units: 5,
            },
        ))
        .unwrap();

    let finalizing = engine
        .dispatch(notification(subscription, eof(2, 0x1234_5678)))
        .unwrap();
    let finalize = request_id(&finalizing, |effect| {
        matches!(
            effect,
            Effect::RecordingSink(RecordingSinkEffect::FinalizeStreaming {
                encrypted: false,
                expected_chunks: 0,
                total_units: 5,
                ..
            })
        )
    });
    let acknowledging = engine
        .dispatch(host(
            finalize,
            HostEventKind::StreamingSinkFinalized {
                uploaded_chunks: 1,
                total_units: 5,
            },
        ))
        .unwrap();
    let ack = request_id(&acknowledging, |effect| {
        matches!(
            effect,
            Effect::Ble(BleEffect::Write { characteristic_uuid, payload, .. })
                if characteristic_uuid == CHAR_RECORDING_TRANSFER && payload.first() == Some(&0x10)
        )
    });
    let confirming = engine
        .dispatch(host(ack, HostEventKind::Ble(BleEvent::WriteCompleted)))
        .unwrap();
    let confirm = request_id(&confirming, |effect| {
        matches!(
            effect,
            Effect::Ble(BleEffect::Write { characteristic_uuid, payload, .. })
                if characteristic_uuid == CHAR_TRANSFER_CONTROL && payload.first() == Some(&7)
        )
    });
    let completed = engine
        .dispatch(host(
            confirm,
            HostEventKind::Ble(BleEvent::WriteCompleted),
        ))
        .unwrap();
    assert!(completed.iter().any(|request| matches!(
        request.effect,
        Effect::Notify(WorkflowNotification::StreamingCompleted {
            total_units: 5,
            uploaded_chunks: 1,
            encrypted: false,
        })
    )));
}

#[test]
fn encrypted_stream_preserves_wire_sequences_and_allows_gaps() {
    let mut engine = WorkflowEngine::default();
    let subscription = start(&mut engine);
    let header = engine
        .dispatch(notification(subscription, e2e_start()))
        .unwrap();
    let header_request = request_id(&header, |effect| {
        matches!(
            effect,
            Effect::RecordingSink(RecordingSinkEffect::BeginStreamingEncrypted {
                ephemeral_public_key,
                salt,
                ..
            }) if ephemeral_public_key == &[0x41; 32] && salt == &[0x52; 4]
        )
    });
    engine
        .dispatch(host(
            header_request,
            HostEventKind::StreamingSinkAccepted { received_units: 0 },
        ))
        .unwrap();

    for sequence in [0, 2] {
        let appending = engine
            .dispatch(notification(
                subscription,
                encrypted_data(sequence, &[0x61; 20]),
            ))
            .unwrap();
        let append = request_id(&appending, |effect| {
            matches!(
                effect,
                Effect::RecordingSink(RecordingSinkEffect::AppendStreamingEncrypted {
                    sequence: value,
                    payload,
                    ..
                }) if *value == sequence && payload == &[0x61; 20]
            )
        });
        engine
            .dispatch(host(
                append,
                HostEventKind::StreamingSinkAccepted {
                    received_units: if sequence == 0 { 4 } else { 8 },
                },
            ))
            .unwrap();
    }

    let finalizing = engine
        .dispatch(notification(subscription, encrypted_eof(3)))
        .unwrap();
    assert!(finalizing.iter().any(|request| matches!(
        request.effect,
        Effect::RecordingSink(RecordingSinkEffect::FinalizeStreaming {
            encrypted: true,
            expected_chunks: 3,
            total_units: 8,
            ..
        })
    )));
}

#[test]
fn cancelling_live_stream_aborts_transport_and_discards_without_confirming() {
    let mut engine = WorkflowEngine::default();
    start(&mut engine);

    let cancelled = engine
        .dispatch(Event::Cancelled {
            cancellation_id: CANCELLATION,
        })
        .unwrap();

    assert!(cancelled.iter().any(|request| matches!(
        request.effect,
        Effect::Ble(BleEffect::Write { ref payload, .. }) if payload.first() == Some(&0x12)
    )));
    assert!(cancelled.iter().any(|request| matches!(
        request.effect,
        Effect::RecordingSink(RecordingSinkEffect::DiscardStreaming { .. })
    )));
    assert!(!cancelled.iter().any(|request| matches!(
        request.effect,
        Effect::Ble(BleEffect::Write { ref payload, .. }) if payload.first() == Some(&7)
    )));
}
