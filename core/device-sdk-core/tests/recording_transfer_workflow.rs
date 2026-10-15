use bota_device_sdk_core::{
    engine::{
        BleEffect, BleEvent, CancellationId, Capability, CapabilitySet, CheckpointPhase, Command,
        Effect, EffectRequest, Event, HostEvent, HostEventKind, PersistenceEffect,
        RecordingSinkEffect, RequestId, TimerEffect, WorkflowCheckpoint, WorkflowEngine,
        WorkflowKind, WorkflowNotification, WorkflowStatus,
    },
    error::{ErrorCode, Operation},
    generated::protocol::{
        ACK_TYPE_ABORT, ACK_TYPE_ACK, ACK_TYPE_NACK, CHAR_RECORDING_TRANSFER,
        CHAR_TRANSFER_CONTROL, PACKET_TYPE_E2E_START, PACKET_TYPE_ENCRYPTED_DATA,
        PACKET_TYPE_ENCRYPTED_EOF,
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
        Capability::Timer,
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
        confirm_on_completion: true,
    }
}

fn retained_command() -> Command {
    Command::TransferRecording {
        device: device(),
        recording: recording(),
        sink_id: sink(),
        total_units: 10,
        confirm_on_completion: false,
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
    start_with_write_completion(engine, checkpoint, true)
}

fn start_with_write_completion(
    engine: &mut WorkflowEngine,
    checkpoint: Option<WorkflowCheckpoint>,
    complete_write: bool,
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
    if complete_write {
        engine
            .dispatch(host(
                start_request,
                HostEventKind::Ble(BleEvent::WriteCompleted),
            ))
            .unwrap();
    }
    (subscription_request, start_request)
}

fn data(sequence: u16, payload: &[u8]) -> Vec<u8> {
    let mut bytes = vec![1];
    bytes.extend_from_slice(&sequence.to_le_bytes());
    bytes.extend_from_slice(&(payload.len() as u16).to_le_bytes());
    bytes.extend_from_slice(payload);
    bytes
}

#[derive(Default)]
struct DelayedLegacySink {
    pending: Option<(RequestId, u16, Vec<u8>)>,
    durable: Vec<u8>,
    durable_sequence: Option<u16>,
    append_count: usize,
    checkpoint_count: usize,
}

impl DelayedLegacySink {
    fn observe(&mut self, engine: &mut WorkflowEngine, effects: Vec<EffectRequest>) {
        for request in effects {
            match request.effect {
                Effect::RecordingSink(RecordingSinkEffect::Append {
                    sequence, payload, ..
                }) => {
                    assert!(self.pending.is_none(), "only one append may be in flight");
                    assert!(payload.len() <= 32 * 1024, "append must remain bounded");
                    self.pending = Some((request.request_id, sequence, payload));
                    self.append_count += 1;
                }
                Effect::Persistence(PersistenceEffect::SaveCheckpoint { checkpoint }) => {
                    assert_eq!(checkpoint.completed_units, self.durable.len() as u64);
                    assert_eq!(checkpoint.last_sequence, self.durable_sequence);
                    self.checkpoint_count += 1;
                    assert!(
                        engine
                            .dispatch(host(request.request_id, HostEventKind::CheckpointSaved))
                            .unwrap()
                            .is_empty()
                    );
                }
                Effect::Ble(BleEffect::Write { .. }) => {
                    panic!("no intermediate transfer ACK or CONFIRM")
                }
                Effect::Notify(WorkflowNotification::Failed { error }) => {
                    panic!("delayed append transfer failed: {error:?}")
                }
                _ => {}
            }
        }
    }

    fn complete(&mut self, engine: &mut WorkflowEngine) {
        let (request_id, sequence, payload) = self.pending.take().expect("append is pending");
        self.durable.extend_from_slice(&payload);
        self.durable_sequence = Some(sequence);
        let effects = engine
            .dispatch(host(
                request_id,
                HostEventKind::RecordingSinkAppendCompleted {
                    durable_units: self.durable.len() as u64,
                },
            ))
            .unwrap();
        self.observe(engine, effects);
    }
}

#[test]
fn legacy_400_packet_cadence_batches_delayed_durable_appends() {
    let mut engine = WorkflowEngine::default();
    let (subscription, _) = start_with_checkpoint(&mut engine, None);
    let mut sink = DelayedLegacySink::default();
    let mut expected = Vec::new();
    // Match the observed 400 DATA / 142 completed-append pressure, spreading
    // callbacks across arrivals rather than draining the sink between packets.
    let mut completed_callbacks = 0;
    for sequence in 0..400u16 {
        if (usize::from(sequence) + 1) * 142 / 399 > usize::from(sequence) * 142 / 399 {
            sink.complete(&mut engine);
            completed_callbacks += 1;
        }
        let payload = vec![(sequence % 251) as u8; 500];
        expected.extend_from_slice(&payload);
        let effects = engine
            .dispatch(host(
                subscription,
                HostEventKind::Ble(BleEvent::Notification {
                    characteristic_uuid: CHAR_RECORDING_TRANSFER.into(),
                    value: data(sequence, &payload),
                }),
            ))
            .unwrap();
        sink.observe(&mut engine, effects);
    }
    assert_eq!(completed_callbacks, 142);
    while sink.pending.is_some() {
        sink.complete(&mut engine);
    }
    assert_eq!(sink.durable, expected);
    assert_eq!(sink.durable_sequence, Some(399));
    assert!(
        sink.append_count <= 144,
        "buffered DATA must amortize disk work"
    );
    assert_eq!(sink.append_count, sink.checkpoint_count);
    println!(
        "400 DATA / 200000 bytes: {} durable appends and checkpoints",
        sink.append_count
    );

    let effects = engine
        .dispatch(host(
            subscription,
            HostEventKind::Ble(BleEvent::Notification {
                characteristic_uuid: CHAR_RECORDING_TRANSFER.into(),
                value: eof(400, 0x12345678),
            }),
        ))
        .unwrap();
    assert!(effects.iter().any(|request| matches!(
        request.effect,
        Effect::RecordingSink(RecordingSinkEffect::Finalize {
            expected_crc32: Some(0x12345678),
            ..
        })
    )));
    assert!(
        !effects
            .iter()
            .any(|request| matches!(request.effect, Effect::Ble(BleEffect::Write { .. })))
    );
}

#[test]
fn buffered_legacy_batches_bound_bytes_and_checkpoint_only_durable_sequences() {
    let mut engine = WorkflowEngine::default();
    let (subscription, start) = start_with_write_completion(&mut engine, None, false);
    for sequence in 0..5 {
        assert!(
            engine
                .dispatch(host(
                    subscription,
                    HostEventKind::Ble(BleEvent::Notification {
                        characteristic_uuid: CHAR_RECORDING_TRANSFER.into(),
                        value: data(sequence, &vec![sequence as u8; 8 * 1024]),
                    })
                ))
                .unwrap()
                .is_empty()
        );
    }
    let mut sink = DelayedLegacySink::default();
    let effects = engine
        .dispatch(host(start, HostEventKind::Ble(BleEvent::WriteCompleted)))
        .unwrap();
    sink.observe(&mut engine, effects);
    let (_, last_sequence, payload) = sink.pending.as_ref().unwrap();
    assert_eq!(*last_sequence, 3);
    assert_eq!(payload.len(), 32 * 1024);
    assert_eq!(sink.checkpoint_count, 0);
    sink.complete(&mut engine);
    assert_eq!(sink.durable_sequence, Some(3));
    assert_eq!(sink.checkpoint_count, 1);
    assert_eq!(sink.pending.as_ref().unwrap().1, 4);
    assert_eq!(sink.pending.as_ref().unwrap().2.len(), 8 * 1024);
    sink.complete(&mut engine);
    assert_eq!(sink.durable_sequence, Some(4));
    assert_eq!(sink.checkpoint_count, 2);
    assert_eq!(sink.durable.len(), 40 * 1024);
}

#[test]
fn buffered_legacy_batches_leave_gap_malformed_and_mixed_boundaries_for_validation() {
    for boundary in [data(4, &[4]), vec![1], encrypted_data(3, &[7; 16])] {
        let mut engine = WorkflowEngine::default();
        let (subscription, start) = start_with_write_completion(&mut engine, None, false);
        for value in [
            data(0, &[1]),
            data(1, &[2]),
            data(1, &[2]),
            data(2, &[3]),
            boundary,
        ] {
            assert!(
                engine
                    .dispatch(host(
                        subscription,
                        HostEventKind::Ble(BleEvent::Notification {
                            characteristic_uuid: CHAR_RECORDING_TRANSFER.into(),
                            value,
                        })
                    ))
                    .unwrap()
                    .is_empty()
            );
        }
        let appending = engine
            .dispatch(host(start, HostEventKind::Ble(BleEvent::WriteCompleted)))
            .unwrap();
        let append = request_id(&appending, |effect| {
            matches!(effect,
            Effect::RecordingSink(RecordingSinkEffect::Append { sequence: 2, payload, .. }) if payload == &[1, 2, 3])
        });
        assert!(!appending.iter().any(|request| matches!(
            request.effect,
            Effect::Persistence(PersistenceEffect::SaveCheckpoint { .. })
        )));
        let failed = engine
            .dispatch(host(
                append,
                HostEventKind::RecordingSinkAppendCompleted { durable_units: 3 },
            ))
            .unwrap();
        assert!(failed.iter().any(|request| matches!(&request.effect,
            Effect::Persistence(PersistenceEffect::SaveCheckpoint { checkpoint })
            if checkpoint.last_sequence == Some(2) && checkpoint.completed_units == 3)));
        assert!(failed.iter().any(|request| matches!(
            request.effect,
            Effect::Notify(WorkflowNotification::Failed { .. })
        )));
        assert!(!failed.iter().any(|request| matches!(&request.effect,
            Effect::Ble(BleEffect::Write { payload, .. }) if payload.first() == Some(&7))));
    }
}

#[test]
fn non_durable_legacy_batch_never_advances_checkpoint_or_finalizes() {
    let mut engine = WorkflowEngine::default();
    let (subscription, start) = start_with_write_completion(&mut engine, None, false);
    for value in [data(0, &[1, 2]), data(1, &[3, 4]), eof(2, 0xb63cfbcd)] {
        engine
            .dispatch(host(
                subscription,
                HostEventKind::Ble(BleEvent::Notification {
                    characteristic_uuid: CHAR_RECORDING_TRANSFER.into(),
                    value,
                }),
            ))
            .unwrap();
    }
    let appending = engine
        .dispatch(host(start, HostEventKind::Ble(BleEvent::WriteCompleted)))
        .unwrap();
    let append = request_id(&appending, |effect| {
        matches!(effect,
        Effect::RecordingSink(RecordingSinkEffect::Append { sequence: 1, payload, .. }) if payload == &[1, 2, 3, 4])
    });
    let failed = engine
        .dispatch(host(
            append,
            HostEventKind::RecordingSinkAppendCompleted { durable_units: 3 },
        ))
        .unwrap();
    assert!(failed.iter().any(|request| matches!(
        request.effect,
        Effect::Notify(WorkflowNotification::Failed { .. })
    )));
    assert!(!failed.iter().any(|request| matches!(
        request.effect,
        Effect::Persistence(PersistenceEffect::SaveCheckpoint { .. })
            | Effect::RecordingSink(RecordingSinkEffect::Finalize { .. })
            | Effect::Ble(BleEffect::Write { .. })
    )));
}

#[test]
fn resumed_legacy_batch_skips_only_previously_durable_sequences() {
    let mut engine = WorkflowEngine::default();
    let checkpoint = WorkflowCheckpoint {
        workflow: WorkflowKind::RecordingTransfer,
        operation: Operation::TransferRecording,
        device: device(),
        recording: Some(recording()),
        phase: CheckpointPhase::Transferring,
        completed_units: 4,
        retry_count: 1,
        last_sequence: Some(1),
        firmware_version: None,
    };
    let (subscription, start) = start_with_write_completion(&mut engine, Some(checkpoint), false);
    for sequence in 0..4 {
        engine
            .dispatch(host(
                subscription,
                HostEventKind::Ble(BleEvent::Notification {
                    characteristic_uuid: CHAR_RECORDING_TRANSFER.into(),
                    value: data(sequence, &[sequence as u8; 2]),
                }),
            ))
            .unwrap();
    }
    let appending = engine
        .dispatch(host(start, HostEventKind::Ble(BleEvent::WriteCompleted)))
        .unwrap();
    let append = request_id(&appending, |effect| {
        matches!(effect,
        Effect::RecordingSink(RecordingSinkEffect::Append { sequence: 3, payload, .. }) if payload == &[2, 2, 3, 3])
    });
    assert!(!appending.iter().any(|request| matches!(
        request.effect,
        Effect::Persistence(PersistenceEffect::SaveCheckpoint { .. })
    )));
    let persisted = engine
        .dispatch(host(
            append,
            HostEventKind::RecordingSinkAppendCompleted { durable_units: 8 },
        ))
        .unwrap();
    assert!(persisted.iter().any(|request| matches!(&request.effect,
        Effect::Persistence(PersistenceEffect::SaveCheckpoint { checkpoint })
        if checkpoint.last_sequence == Some(3) && checkpoint.completed_units == 8 && checkpoint.retry_count == 2)));
}

#[test]
fn burst_packets_wait_for_durable_appends_without_loss() {
    let mut engine = WorkflowEngine::default();
    let (subscription, _) = start_with_checkpoint(&mut engine, None);
    let first = engine
        .dispatch(host(
            subscription,
            HostEventKind::Ble(BleEvent::Notification {
                characteristic_uuid: CHAR_RECORDING_TRANSFER.into(),
                value: data(0, &[1, 2]),
            }),
        ))
        .unwrap();
    let first_append = request_id(&first, |effect| {
        matches!(
            effect,
            Effect::RecordingSink(RecordingSinkEffect::Append { sequence: 0, .. })
        )
    });
    for value in [data(1, &[3, 4]), data(1, &[3, 4]), eof(2, 0xb63cfbcd)] {
        assert!(
            engine
                .dispatch(host(
                    subscription,
                    HostEventKind::Ble(BleEvent::Notification {
                        characteristic_uuid: CHAR_RECORDING_TRANSFER.into(),
                        value,
                    })
                ))
                .expect("in-flight sink must not drop a notification")
                .is_empty()
        );
    }
    let second = engine
        .dispatch(host(
            first_append,
            HostEventKind::RecordingSinkAppendCompleted { durable_units: 2 },
        ))
        .unwrap();
    let second_append = request_id(&second, |effect| {
        matches!(effect,
        Effect::RecordingSink(RecordingSinkEffect::Append { sequence: 1, payload, .. }) if payload == &[3, 4])
    });
    let finalized = engine
        .dispatch(host(
            second_append,
            HostEventKind::RecordingSinkAppendCompleted { durable_units: 4 },
        ))
        .unwrap();
    assert!(finalized.iter().any(|request| matches!(
        request.effect,
        Effect::RecordingSink(RecordingSinkEffect::Finalize {
            expected_crc32: Some(0xb63cfbcd),
            ..
        })
    )));
    assert!(!finalized.iter().any(|request| matches!(&request.effect,
        Effect::Ble(BleEffect::Write { payload, .. }) if payload.first() == Some(&3))));
}

#[test]
fn early_data_waits_for_start_write_completion() {
    let mut engine = WorkflowEngine::default();
    let (subscription, start) = start_with_write_completion(&mut engine, None, false);
    assert!(
        engine
            .dispatch(host(
                subscription,
                HostEventKind::Ble(BleEvent::Notification {
                    characteristic_uuid: CHAR_RECORDING_TRANSFER.into(),
                    value: data(0, &[1, 2]),
                })
            ))
            .unwrap()
            .is_empty()
    );
    let appending = engine
        .dispatch(host(start, HostEventKind::Ble(BleEvent::WriteCompleted)))
        .unwrap();
    assert!(appending.iter().any(|request| matches!(&request.effect,
        Effect::RecordingSink(RecordingSinkEffect::Append { sequence: 0, payload, .. }) if payload == &[1, 2])));
}

#[test]
fn queued_transfer_overflow_fails_without_confirming_device_deletion() {
    for packet in [data(0, &[]), data(0, &vec![7; 1024])] {
        let mut engine = WorkflowEngine::default();
        let (subscription, _) = start_with_write_completion(&mut engine, None, false);
        let mut failed = false;
        for _ in 0..257 {
            let effects = engine
                .dispatch(host(
                    subscription,
                    HostEventKind::Ble(BleEvent::Notification {
                        characteristic_uuid: CHAR_RECORDING_TRANSFER.into(),
                        value: packet.clone(),
                    }),
                ))
                .unwrap();
            assert!(!effects.iter().any(|request| matches!(&request.effect,
                Effect::Ble(BleEffect::Write { payload, .. }) if payload.first() == Some(&3))));
            if effects.iter().any(|request| {
                matches!(
                    request.effect,
                    Effect::Notify(WorkflowNotification::Failed { .. })
                )
            }) {
                failed = true;
                break;
            }
        }
        assert!(
            failed,
            "queue must bound both packet count and retained bytes"
        );
    }
}

fn eof(sequence: u16, checksum: u32) -> Vec<u8> {
    let mut bytes = vec![2];
    bytes.extend_from_slice(&sequence.to_le_bytes());
    bytes.extend_from_slice(&checksum.to_le_bytes());
    bytes
}

fn e2e_start(ephemeral_public_key: &[u8; 32], salt: &[u8; 4]) -> Vec<u8> {
    let mut bytes = vec![PACKET_TYPE_E2E_START];
    bytes.extend_from_slice(ephemeral_public_key);
    bytes.extend_from_slice(salt);
    bytes
}

fn encrypted_data(sequence: u16, ciphertext_with_tag: &[u8]) -> Vec<u8> {
    let mut bytes = vec![PACKET_TYPE_ENCRYPTED_DATA];
    bytes.extend_from_slice(&sequence.to_le_bytes());
    bytes.extend_from_slice(&(ciphertext_with_tag.len() as u16).to_le_bytes());
    bytes.extend_from_slice(ciphertext_with_tag);
    bytes
}

fn encrypted_eof(sequence: u16) -> Vec<u8> {
    let mut bytes = vec![PACKET_TYPE_ENCRYPTED_EOF];
    bytes.extend_from_slice(&sequence.to_le_bytes());
    bytes
}

fn sha256(value: &[u8; 32]) -> Vec<u8> {
    let mut bytes = vec![4];
    bytes.extend_from_slice(value);
    bytes.extend_from_slice(recording().as_bytes());
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
fn encrypted_transfer_stages_backend_decryption_wire_format() {
    let mut engine = WorkflowEngine::default();
    let (subscription_request, _) = start_with_checkpoint(&mut engine, None);
    let ephemeral_public_key = [0x11; 32];
    let salt = [0x22; 4];

    let header = engine
        .dispatch(host(
            subscription_request,
            HostEventKind::Ble(BleEvent::Notification {
                characteristic_uuid: CHAR_RECORDING_TRANSFER.into(),
                value: e2e_start(&ephemeral_public_key, &salt),
            }),
        ))
        .unwrap();
    let header_request = request_id(&header, |effect| {
        matches!(
            effect,
            Effect::RecordingSink(RecordingSinkEffect::Append { payload, .. })
                if payload == &[ephemeral_public_key.as_slice(), salt.as_slice()].concat()
        )
    });
    engine
        .dispatch(host(
            header_request,
            HostEventKind::RecordingSinkAppendCompleted { durable_units: 36 },
        ))
        .unwrap();

    let ciphertext_with_tag = [0x33; 24];
    let chunk = engine
        .dispatch(host(
            subscription_request,
            HostEventKind::Ble(BleEvent::Notification {
                characteristic_uuid: CHAR_RECORDING_TRANSFER.into(),
                value: encrypted_data(0, &ciphertext_with_tag),
            }),
        ))
        .unwrap();
    let chunk_request = request_id(&chunk, |effect| {
        matches!(
            effect,
            Effect::RecordingSink(RecordingSinkEffect::Append {
                sequence: 0,
                payload,
                ..
            }) if payload == &[&[0, 8], ciphertext_with_tag.as_slice()].concat()
        )
    });
    engine
        .dispatch(host(
            chunk_request,
            HostEventKind::RecordingSinkAppendCompleted { durable_units: 62 },
        ))
        .unwrap();

    let finalizing = engine
        .dispatch(host(
            subscription_request,
            HostEventKind::Ble(BleEvent::Notification {
                characteristic_uuid: CHAR_RECORDING_TRANSFER.into(),
                value: encrypted_eof(1),
            }),
        ))
        .unwrap();
    assert!(finalizing.iter().any(|request| matches!(
        request.effect,
        Effect::RecordingSink(RecordingSinkEffect::Finalize {
            expected_crc32: None,
            ..
        })
    )));
}

#[test]
fn transfer_waits_for_post_eof_sha_and_reports_completion_metadata() {
    let mut engine = WorkflowEngine::default();
    let (subscription_request, _) = start_with_checkpoint(&mut engine, None);
    let header = engine
        .dispatch(host(
            subscription_request,
            HostEventKind::Ble(BleEvent::Notification {
                characteristic_uuid: CHAR_RECORDING_TRANSFER.into(),
                value: e2e_start(&[0x11; 32], &[0x22; 4]),
            }),
        ))
        .unwrap();
    let header_request = request_id(&header, |effect| {
        matches!(
            effect,
            Effect::RecordingSink(RecordingSinkEffect::Append { .. })
        )
    });
    engine
        .dispatch(host(
            header_request,
            HostEventKind::RecordingSinkAppendCompleted { durable_units: 36 },
        ))
        .unwrap();
    let finalizing = engine
        .dispatch(host(
            subscription_request,
            HostEventKind::Ble(BleEvent::Notification {
                characteristic_uuid: CHAR_RECORDING_TRANSFER.into(),
                value: encrypted_eof(0),
            }),
        ))
        .unwrap();
    let finalize_request = request_id(&finalizing, |effect| {
        matches!(
            effect,
            Effect::RecordingSink(RecordingSinkEffect::Finalize { .. })
        )
    });
    assert!(finalizing.iter().any(|request| matches!(
        request.effect,
        Effect::Timer(TimerEffect::Schedule { delay_ms: 200, .. })
    )));

    let waiting = engine
        .dispatch(host(
            finalize_request,
            HostEventKind::RecordingSinkFinalized { durable_units: 36 },
        ))
        .unwrap();
    assert!(
        !waiting
            .iter()
            .any(|request| matches!(request.effect, Effect::Ble(BleEffect::Write { .. })))
    );

    let digest = [0x5a; 32];
    let acknowledging = engine
        .dispatch(host(
            subscription_request,
            HostEventKind::Ble(BleEvent::Notification {
                characteristic_uuid: CHAR_RECORDING_TRANSFER.into(),
                value: sha256(&digest),
            }),
        ))
        .unwrap();
    let ack_request = request_id(&acknowledging, |effect| {
        matches!(
            effect,
            Effect::Ble(BleEffect::Write { payload, .. })
                if payload.first() == Some(&ACK_TYPE_ACK)
        )
    });
    assert!(
        acknowledging
            .iter()
            .any(|request| matches!(request.effect, Effect::Timer(TimerEffect::Cancel { .. })))
    );

    let confirming = engine
        .dispatch(host(
            ack_request,
            HostEventKind::Ble(BleEvent::WriteCompleted),
        ))
        .unwrap();
    let confirm_request = request_id(&confirming, |effect| {
        matches!(
            effect,
            Effect::Ble(BleEffect::Write { characteristic_uuid, payload, .. })
                if characteristic_uuid == CHAR_TRANSFER_CONTROL && payload.first() == Some(&7)
        )
    });
    let completed = engine
        .dispatch(host(
            confirm_request,
            HostEventKind::Ble(BleEvent::WriteCompleted),
        ))
        .unwrap();
    assert!(completed.iter().any(|request| matches!(
        &request.effect,
        Effect::Notify(WorkflowNotification::RecordingTransferCompleted {
            encrypted: true,
            sha256: Some(value),
        }) if value == &digest
    )));
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
        firmware_version: None,
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
        }) if characteristic_uuid == CHAR_TRANSFER_CONTROL
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
        Effect::Ble(BleEffect::Write { characteristic_uuid, payload, .. })
            if characteristic_uuid == CHAR_TRANSFER_CONTROL
                && payload.first() == Some(&ACK_TYPE_NACK)
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
    assert!(acknowledging.is_empty());
    let timer_id = finalizing
        .iter()
        .find_map(|request| match request.effect {
            Effect::Timer(TimerEffect::Schedule { timer_id, .. }) => Some(timer_id),
            _ => None,
        })
        .expect("SHA grace timer");
    let acknowledging = engine
        .dispatch(host(
            RequestId::from_u64(0),
            HostEventKind::TimerFired { timer_id },
        ))
        .unwrap();
    let ack_request = request_id(&acknowledging, |effect| {
        matches!(
            effect,
            Effect::Ble(BleEffect::Write {
                characteristic_uuid,
                payload,
                ..
            }) if characteristic_uuid == CHAR_TRANSFER_CONTROL
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
        Effect::Notify(WorkflowNotification::RecordingTransferCompleted {
            encrypted: false,
            sha256: None,
        })
    )));
}

#[test]
fn retained_transfer_completes_after_final_ack_without_confirming_delete() {
    let mut engine = WorkflowEngine::default();
    let started = engine
        .start(retained_command(), &capabilities(), CANCELLATION)
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
            HostEventKind::CheckpointLoaded { checkpoint: None },
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
        matches!(effect, Effect::Ble(BleEffect::Subscribe { .. }))
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
                if characteristic_uuid == CHAR_TRANSFER_CONTROL && payload.first() == Some(&2)
        )
    });
    engine
        .dispatch(host(
            start_request,
            HostEventKind::Ble(BleEvent::WriteCompleted),
        ))
        .unwrap();

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
    engine
        .dispatch(host(
            finalize_request,
            HostEventKind::RecordingSinkFinalized { durable_units: 10 },
        ))
        .unwrap();
    let timer_id = finalizing
        .iter()
        .find_map(|request| match request.effect {
            Effect::Timer(TimerEffect::Schedule { timer_id, .. }) => Some(timer_id),
            _ => None,
        })
        .expect("SHA grace timer");
    let acknowledging = engine
        .dispatch(host(
            RequestId::from_u64(0),
            HostEventKind::TimerFired { timer_id },
        ))
        .unwrap();
    let ack_request = request_id(
        &acknowledging,
        |effect| matches!(effect, Effect::Ble(BleEffect::Write { payload, .. }) if payload.first() == Some(&ACK_TYPE_ACK)),
    );

    let completed = engine
        .dispatch(host(
            ack_request,
            HostEventKind::Ble(BleEvent::WriteCompleted),
        ))
        .unwrap();
    assert!(!completed.iter().any(|request| matches!(
        &request.effect,
        Effect::Ble(BleEffect::Write { characteristic_uuid, payload, .. })
            if characteristic_uuid == CHAR_TRANSFER_CONTROL && payload.first() == Some(&7)
    )));
    assert!(completed.iter().any(|request| matches!(
        request.effect,
        Effect::Notify(WorkflowNotification::RecordingTransferCompleted { .. })
    )));
}
