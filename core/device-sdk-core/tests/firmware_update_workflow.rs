use bota_device_sdk_core::{
    engine::{
        BleEffect, BleEvent, CancellationId, Capability, CapabilitySet, CheckpointPhase, Command,
        Effect, EffectRequest, Event, FirmwareBlobEffect, HostEvent, HostEventKind, NetworkEffect,
        NetworkEvent, PersistenceEffect, RequestId, TimerEffect, WorkflowCheckpoint,
        WorkflowEngine, WorkflowKind, WorkflowNotification, WorkflowStatus,
    },
    error::{ErrorCode, Operation},
    generated::protocol::{
        CHAR_FIRMWARE_REVISION, CHAR_RECORDING_TRANSFER, CHAR_SERIAL_NUMBER, CHAR_TRANSFER_CONTROL,
        CHAR_TRANSFER_STATUS, FIRMWARE_ACK, FIRMWARE_UPLOAD_START, FIRMWARE_UPLOAD_VERIFY,
    },
    model::{
        DeviceCandidate, DeviceSerialNumber, FirmwareImage, FirmwareUpdatePhase, ReconnectHint,
    },
};

const CANCELLATION: CancellationId = CancellationId::from_bytes([7; 16]);
const DOWNLOAD_ID: u64 = 41;
const DOWNLOADED_CRC32: u32 = 0x89ab_cdef;

fn capabilities() -> CapabilitySet {
    CapabilitySet::from([
        Capability::Ble,
        Capability::Timer,
        Capability::Persistence,
        Capability::NetworkTransfer,
        Capability::Progress,
        Capability::FirmwareBlob,
    ])
}

fn device() -> DeviceSerialNumber {
    DeviceSerialNumber::new("EVFXXW67KP").unwrap()
}

fn image(size_bytes: u32) -> FirmwareImage {
    FirmwareImage {
        version: "1.0.18".into(),
        size_bytes,
        crc32: 0x1234_5678,
    }
}

fn hint() -> ReconnectHint {
    ReconnectHint {
        stored_peripheral_id: Some("new-ios-id".into()),
        advertised_address: None,
        stored_name: Some("Bota Pin".into()),
        scan_timeout_ms: 1_000,
        connection_timeout_ms: 10_000,
    }
}

fn command(size_bytes: u32) -> Command {
    Command::UpdateFirmware {
        device: device(),
        image: image(size_bytes),
        download_id: DOWNLOAD_ID,
        reconnect_hint: hint(),
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
    size_bytes: u32,
    checkpoint: Option<WorkflowCheckpoint>,
) -> Vec<EffectRequest> {
    let started = engine
        .start(command(size_bytes), &capabilities(), CANCELLATION)
        .unwrap();
    let load_request = request_id(&started, |effect| {
        matches!(
            effect,
            Effect::Persistence(PersistenceEffect::LoadCheckpoint)
        )
    });
    engine
        .dispatch(host(
            load_request,
            HostEventKind::CheckpointLoaded { checkpoint },
        ))
        .unwrap()
}

fn complete_download(
    engine: &mut WorkflowEngine,
    size_bytes: u32,
) -> (RequestId, Vec<EffectRequest>) {
    let downloading = start_with_checkpoint(engine, size_bytes, None);
    let download_request = request_id(&downloading, |effect| {
        matches!(
            effect,
            Effect::Network(NetworkEffect::Download {
                download_id: DOWNLOAD_ID
            })
        )
    });
    let preparing = engine
        .dispatch(host(
            download_request,
            HostEventKind::Network(NetworkEvent::DownloadCompleted {
                download_id: DOWNLOAD_ID,
                crc32: DOWNLOADED_CRC32,
            }),
        ))
        .unwrap();
    (download_request, preparing)
}

fn reach_first_chunk(
    engine: &mut WorkflowEngine,
    size_bytes: u32,
) -> (RequestId, Vec<EffectRequest>) {
    let (_, subscribing) = complete_download(engine, size_bytes);
    let subscription_request = request_id(&subscribing, |effect| {
        matches!(
            effect,
            Effect::Ble(BleEffect::Subscribe { characteristic_uuid, .. })
                if characteristic_uuid == CHAR_TRANSFER_STATUS
        )
    });
    let starting = engine
        .dispatch(host(
            subscription_request,
            HostEventKind::Ble(BleEvent::Subscribed {
                characteristic_uuid: CHAR_TRANSFER_STATUS.into(),
            }),
        ))
        .unwrap();
    let start_request = request_id(&starting, |effect| {
        matches!(
            effect,
            Effect::Ble(BleEffect::Write { characteristic_uuid, payload, .. })
                if characteristic_uuid == CHAR_TRANSFER_CONTROL
                    && payload.first() == Some(&FIRMWARE_UPLOAD_START)
        )
    });
    engine
        .dispatch(host(
            start_request,
            HostEventKind::Ble(BleEvent::WriteCompleted),
        ))
        .unwrap();
    let first_chunk = engine
        .dispatch(host(
            subscription_request,
            HostEventKind::Ble(BleEvent::Notification {
                characteristic_uuid: CHAR_TRANSFER_STATUS.into(),
                value: vec![FIRMWARE_UPLOAD_START, 0],
            }),
        ))
        .unwrap();
    (subscription_request, first_chunk)
}

fn write_chunk(
    engine: &mut WorkflowEngine,
    read_effects: &[EffectRequest],
    offset: u64,
    sequence: u16,
    bytes: Vec<u8>,
) -> (RequestId, Vec<EffectRequest>) {
    let read_request = request_id(read_effects, |effect| {
        matches!(
            effect,
            Effect::FirmwareBlob(FirmwareBlobEffect::ReadChunk {
                download_id: DOWNLOAD_ID,
                offset: candidate_offset,
                ..
            }) if *candidate_offset == offset
        )
    });
    let writing = engine
        .dispatch(host(
            read_request,
            HostEventKind::FirmwareChunkRead {
                download_id: DOWNLOAD_ID,
                offset,
                bytes,
            },
        ))
        .unwrap();
    let write_request = request_id(&writing, |effect| {
        matches!(
            effect,
            Effect::Ble(BleEffect::Write { characteristic_uuid, payload, .. })
                if characteristic_uuid == CHAR_RECORDING_TRANSFER
                    && payload.first() == Some(&0x20)
                    && payload.get(1..3) == Some(sequence.to_le_bytes().as_slice())
        )
    });
    (write_request, writing)
}

fn reach_verify(
    engine: &mut WorkflowEngine,
    size_bytes: u32,
) -> (RequestId, RequestId, Vec<EffectRequest>) {
    let (subscription_request, first_chunk) = reach_first_chunk(engine, size_bytes);
    let (write_request, _) =
        write_chunk(engine, &first_chunk, 0, 0, vec![0x55; size_bytes as usize]);
    let verifying = engine
        .dispatch(host(
            write_request,
            HostEventKind::Ble(BleEvent::WriteCompleted),
        ))
        .unwrap();
    let verify_request = request_id(&verifying, |effect| {
        matches!(
            effect,
            Effect::Ble(BleEffect::Write { characteristic_uuid, payload, .. })
                if characteristic_uuid == CHAR_TRANSFER_CONTROL
                    && payload.first() == Some(&FIRMWARE_UPLOAD_VERIFY)
        )
    });
    let mut expected_verify = vec![FIRMWARE_UPLOAD_VERIFY];
    expected_verify.extend_from_slice(&DOWNLOADED_CRC32.to_le_bytes());
    assert!(verifying.iter().any(|request| matches!(
        &request.effect,
        Effect::Ble(BleEffect::Write { characteristic_uuid, payload, .. })
            if characteristic_uuid == CHAR_TRANSFER_CONTROL && payload == &expected_verify
    )));
    (subscription_request, verify_request, verifying)
}

fn reach_reconnect(engine: &mut WorkflowEngine) -> Vec<EffectRequest> {
    let (subscription_request, verify_request, _) = reach_verify(engine, 500);
    engine
        .dispatch(host(
            verify_request,
            HostEventKind::Ble(BleEvent::WriteCompleted),
        ))
        .unwrap();
    let rebooting = engine
        .dispatch(host(
            subscription_request,
            HostEventKind::Ble(BleEvent::Notification {
                characteristic_uuid: CHAR_TRANSFER_STATUS.into(),
                value: vec![FIRMWARE_UPLOAD_VERIFY, 0],
            }),
        ))
        .unwrap();
    assert!(
        rebooting
            .iter()
            .any(|request| matches!(request.effect, Effect::Timer(TimerEffect::Schedule { .. })))
    );
    engine
        .dispatch(host(
            subscription_request,
            HostEventKind::Ble(BleEvent::Disconnected {
                peripheral_id: "old-ios-id".into(),
                reason_code: None,
            }),
        ))
        .unwrap()
}

fn reach_ready_wait(engine: &mut WorkflowEngine) -> (RequestId, RequestId) {
    let (_, subscribing) = complete_download(engine, 500);
    let subscription = request_id(&subscribing, |effect| {
        matches!(effect, Effect::Ble(BleEffect::Subscribe { .. }))
    });
    let starting = engine
        .dispatch(host(
            subscription,
            HostEventKind::Ble(BleEvent::Subscribed {
                characteristic_uuid: CHAR_TRANSFER_STATUS.into(),
            }),
        ))
        .unwrap();
    let start = request_id(&starting, |effect| {
        matches!(effect, Effect::Ble(BleEffect::Write { .. }))
    });
    let waiting = engine
        .dispatch(host(start, HostEventKind::Ble(BleEvent::WriteCompleted)))
        .unwrap();
    (subscription, response_timer(&waiting))
}

fn response_timer(effects: &[EffectRequest]) -> RequestId {
    request_id(effects, |effect| {
        matches!(
            effect,
            Effect::Timer(TimerEffect::Schedule {
                timer_id: 105,
                delay_ms: 30_000,
            })
        )
    })
}

fn assert_response_timeout(engine: &mut WorkflowEngine, timer: RequestId) {
    let failed = engine
        .dispatch(host(timer, HostEventKind::TimerFired { timer_id: 105 }))
        .unwrap();
    assert!(matches!(engine.status(), WorkflowStatus::Failed { error }
        if error.code == ErrorCode::Timeout && error.retryable));
    assert!(failed.iter().any(|request| matches!(
        request.effect,
        Effect::Timer(TimerEffect::Cancel { timer_id: 105 })
    )));
    assert!(
        failed
            .iter()
            .any(|request| matches!(request.effect, Effect::Ble(BleEffect::Unsubscribe { .. })))
    );
    assert!(!failed.iter().any(|request| matches!(
        request.effect,
        Effect::FirmwareBlob(_)
            | Effect::Network(_)
            | Effect::Ble(BleEffect::Write { .. } | BleEffect::StartScan { .. })
            | Effect::Notify(WorkflowNotification::Completed { .. })
    )));
    assert!(!failed.iter().any(|request| matches!(
        request.effect,
        Effect::Notify(WorkflowNotification::FirmwareProgress { progress })
            if matches!(progress.phase, FirmwareUpdatePhase::Rebooting | FirmwareUpdatePhase::Complete)
    )));
}

#[test]
fn missing_readiness_times_out_without_reading_or_retransmitting_firmware() {
    let mut engine = WorkflowEngine::default();
    let (subscription, timer) = reach_ready_wait(&mut engine);
    let ack = engine
        .dispatch(host(
            subscription,
            HostEventKind::Ble(BleEvent::Notification {
                characteristic_uuid: CHAR_TRANSFER_STATUS.into(),
                value: vec![FIRMWARE_ACK, 0, 0],
            }),
        ))
        .unwrap();
    assert!(ack.is_empty());
    assert_response_timeout(&mut engine, timer);
}

#[test]
fn missing_verification_times_out_even_after_successful_write_and_chunk_ack() {
    let mut engine = WorkflowEngine::default();
    let (subscription, verify, _) = reach_verify(&mut engine, 500);
    let waiting = engine
        .dispatch(host(verify, HostEventKind::Ble(BleEvent::WriteCompleted)))
        .unwrap();
    let timer = response_timer(&waiting);
    let ack = engine
        .dispatch(host(
            subscription,
            HostEventKind::Ble(BleEvent::Notification {
                characteristic_uuid: CHAR_TRANSFER_STATUS.into(),
                value: vec![FIRMWARE_ACK, 0, 0],
            }),
        ))
        .unwrap();
    assert!(ack.is_empty());
    assert_response_timeout(&mut engine, timer);
}

#[test]
fn accepted_responses_disarm_deadlines_and_ignore_stale_timer_requests() {
    let mut engine = WorkflowEngine::default();
    let (subscription, ready_timer) = reach_ready_wait(&mut engine);
    let reading = engine
        .dispatch(host(
            subscription,
            HostEventKind::Ble(BleEvent::Notification {
                characteristic_uuid: CHAR_TRANSFER_STATUS.into(),
                value: vec![FIRMWARE_UPLOAD_START, 0],
            }),
        ))
        .unwrap();
    assert!(reading.iter().any(|request| matches!(
        request.effect,
        Effect::Timer(TimerEffect::Cancel { timer_id: 105 })
    )));
    assert!(
        engine
            .dispatch(host(
                ready_timer,
                HostEventKind::TimerFired { timer_id: 105 }
            ))
            .unwrap()
            .is_empty()
    );
    let (chunk, _) = write_chunk(&mut engine, &reading, 0, 0, vec![0x55; 500]);
    let verifying = engine
        .dispatch(host(chunk, HostEventKind::Ble(BleEvent::WriteCompleted)))
        .unwrap();
    let verify = request_id(&verifying, |effect| {
        matches!(effect, Effect::Ble(BleEffect::Write { .. }))
    });
    let waiting = engine
        .dispatch(host(verify, HostEventKind::Ble(BleEvent::WriteCompleted)))
        .unwrap();
    let verify_timer = response_timer(&waiting);
    assert_ne!(ready_timer, verify_timer);
    assert!(
        engine
            .dispatch(host(
                ready_timer,
                HostEventKind::TimerFired { timer_id: 105 }
            ))
            .unwrap()
            .is_empty()
    );
    let rebooting = engine
        .dispatch(host(
            subscription,
            HostEventKind::Ble(BleEvent::Notification {
                characteristic_uuid: CHAR_TRANSFER_STATUS.into(),
                value: vec![FIRMWARE_UPLOAD_VERIFY, 0],
            }),
        ))
        .unwrap();
    assert!(rebooting.iter().any(|request| matches!(
        request.effect,
        Effect::Timer(TimerEffect::Cancel { timer_id: 105 })
    )));
    let reboot_timer = request_id(&rebooting, |effect| {
        matches!(
            effect,
            Effect::Timer(TimerEffect::Schedule { timer_id: 102, .. })
        )
    });
    assert!(
        engine
            .dispatch(host(
                verify_timer,
                HostEventKind::TimerFired { timer_id: 105 }
            ))
            .unwrap()
            .is_empty()
    );
    engine
        .dispatch(host(
            reboot_timer,
            HostEventKind::TimerFired { timer_id: 102 },
        ))
        .unwrap();
    assert!(matches!(engine.status(), WorkflowStatus::Failed { error }
        if error.code == ErrorCode::Timeout));
}

#[test]
fn cancellation_disarms_both_readiness_and_verification_deadlines() {
    for waiting_for_verify in [false, true] {
        let mut engine = WorkflowEngine::default();
        if waiting_for_verify {
            let (_, verify, _) = reach_verify(&mut engine, 500);
            let waiting = engine
                .dispatch(host(verify, HostEventKind::Ble(BleEvent::WriteCompleted)))
                .unwrap();
            response_timer(&waiting);
        } else {
            reach_ready_wait(&mut engine);
        }
        let cancelled = engine
            .dispatch(Event::Cancelled {
                cancellation_id: CANCELLATION,
            })
            .unwrap();
        assert!(cancelled.iter().any(|request| matches!(
            request.effect,
            Effect::Timer(TimerEffect::Cancel { timer_id: 105 })
        )));
        assert!(
            cancelled.iter().any(|request| matches!(
                request.effect,
                Effect::Ble(BleEffect::Unsubscribe { .. })
            ))
        );
        assert!(matches!(engine.status(), WorkflowStatus::Cancelled { .. }));
    }
}

#[test]
fn http_rejection_fails_without_touching_ble() {
    let mut engine = WorkflowEngine::default();
    let downloading = start_with_checkpoint(&mut engine, 500, None);
    let download_request = request_id(&downloading, |effect| {
        matches!(effect, Effect::Network(NetworkEffect::Download { .. }))
    });
    let failed = engine
        .dispatch(host(
            download_request,
            HostEventKind::Network(NetworkEvent::Failed {
                transfer_id: DOWNLOAD_ID,
                status_code: Some(503),
            }),
        ))
        .unwrap();

    assert!(
        !failed
            .iter()
            .any(|request| matches!(request.effect, Effect::Ble(_)))
    );
    assert!(matches!(
        engine.status(),
        WorkflowStatus::Failed { error } if error.code == ErrorCode::DownloadFailed
    ));
}

#[test]
fn download_progress_uses_firmware_size_when_http_total_is_unknown() {
    let mut engine = WorkflowEngine::default();
    let downloading = start_with_checkpoint(&mut engine, 4_000, None);
    let download_request = request_id(&downloading, |effect| {
        matches!(effect, Effect::Network(NetworkEffect::Download { .. }))
    });
    let progress = engine
        .dispatch(host(
            download_request,
            HostEventKind::Network(NetworkEvent::DownloadProgress {
                download_id: DOWNLOAD_ID,
                completed_bytes: 750,
                total_bytes: None,
            }),
        ))
        .unwrap();

    assert!(progress.iter().any(|request| matches!(
        request.effect,
        Effect::Notify(WorkflowNotification::FirmwareProgress { progress })
            if progress.phase == FirmwareUpdatePhase::Downloading
                && progress.completed_bytes == 750
                && progress.total_bytes == 4_000
    )));
}

#[test]
fn device_rejection_stops_before_blob_reads() {
    let mut engine = WorkflowEngine::default();
    let (_, subscribing) = complete_download(&mut engine, 500);
    let subscription_request = request_id(&subscribing, |effect| {
        matches!(effect, Effect::Ble(BleEffect::Subscribe { .. }))
    });
    let starting = engine
        .dispatch(host(
            subscription_request,
            HostEventKind::Ble(BleEvent::Subscribed {
                characteristic_uuid: CHAR_TRANSFER_STATUS.into(),
            }),
        ))
        .unwrap();
    let start_request = request_id(&starting, |effect| {
        matches!(effect, Effect::Ble(BleEffect::Write { .. }))
    });
    engine
        .dispatch(host(
            start_request,
            HostEventKind::Ble(BleEvent::WriteCompleted),
        ))
        .unwrap();
    let failed = engine
        .dispatch(host(
            subscription_request,
            HostEventKind::Ble(BleEvent::Notification {
                characteristic_uuid: CHAR_TRANSFER_STATUS.into(),
                value: vec![FIRMWARE_UPLOAD_START, 1],
            }),
        ))
        .unwrap();

    assert!(
        !failed
            .iter()
            .any(|request| matches!(request.effect, Effect::FirmwareBlob(_)))
    );
    assert!(matches!(
        engine.status(),
        WorkflowStatus::Failed { error } if error.code == ErrorCode::ProtocolRejected
    ));
}

#[test]
fn early_window_ack_is_cached_and_ack_timeout_is_retryable() {
    let mut early = WorkflowEngine::default();
    let (subscription_request, mut next) = reach_first_chunk(&mut early, 4_000);
    for sequence in 0_u16..8 {
        let offset = u64::from(sequence) * 500;
        let (write_request, _) = write_chunk(
            &mut early,
            &next,
            offset,
            sequence,
            vec![sequence as u8; 500],
        );
        if sequence == 7 {
            early
                .dispatch(host(
                    subscription_request,
                    HostEventKind::Ble(BleEvent::Notification {
                        characteristic_uuid: CHAR_TRANSFER_STATUS.into(),
                        value: vec![FIRMWARE_ACK, 7, 0],
                    }),
                ))
                .unwrap();
        }
        next = early
            .dispatch(host(
                write_request,
                HostEventKind::Ble(BleEvent::WriteCompleted),
            ))
            .unwrap();
    }
    assert!(next.iter().any(|request| matches!(
        &request.effect,
        Effect::Ble(BleEffect::Write { payload, .. })
            if payload.first() == Some(&FIRMWARE_UPLOAD_VERIFY)
    )));
    assert!(
        !next
            .iter()
            .any(|request| matches!(request.effect, Effect::Timer(TimerEffect::Schedule { .. })))
    );

    let mut timed_out = WorkflowEngine::default();
    let (_, mut next) = reach_first_chunk(&mut timed_out, 4_000);
    for sequence in 0_u16..8 {
        let offset = u64::from(sequence) * 500;
        let (write_request, _) = write_chunk(
            &mut timed_out,
            &next,
            offset,
            sequence,
            vec![sequence as u8; 500],
        );
        next = timed_out
            .dispatch(host(
                write_request,
                HostEventKind::Ble(BleEvent::WriteCompleted),
            ))
            .unwrap();
    }
    let timer_request = request_id(&next, |effect| {
        matches!(effect, Effect::Timer(TimerEffect::Schedule { .. }))
    });
    let timer_id = next
        .iter()
        .find_map(|request| match request.effect {
            Effect::Timer(TimerEffect::Schedule { timer_id, .. }) => Some(timer_id),
            _ => None,
        })
        .unwrap();
    timed_out
        .dispatch(host(timer_request, HostEventKind::TimerFired { timer_id }))
        .unwrap();
    assert!(matches!(
        timed_out.status(),
        WorkflowStatus::Failed { error }
            if error.code == ErrorCode::Timeout && error.retryable
    ));
}

#[test]
fn transfer_resume_reuses_blob_but_restarts_device_at_offset_zero() {
    let checkpoint = WorkflowCheckpoint {
        workflow: WorkflowKind::FirmwareUpdate,
        operation: Operation::UpdateFirmware,
        device: device(),
        recording: None,
        phase: CheckpointPhase::Transferring,
        completed_units: 2_000,
        retry_count: 1,
        last_sequence: Some(3),
        firmware_version: Some("1.0.18".into()),
    };
    let mut engine = WorkflowEngine::default();
    let subscribing = start_with_checkpoint(&mut engine, 4_000, Some(checkpoint));
    assert!(!subscribing.iter().any(|request| matches!(
        request.effect,
        Effect::Network(NetworkEffect::Download { .. })
    )));
    let subscription_request = request_id(&subscribing, |effect| {
        matches!(effect, Effect::Ble(BleEffect::Subscribe { .. }))
    });
    let starting = engine
        .dispatch(host(
            subscription_request,
            HostEventKind::Ble(BleEvent::Subscribed {
                characteristic_uuid: CHAR_TRANSFER_STATUS.into(),
            }),
        ))
        .unwrap();
    let start_request = request_id(&starting, |effect| {
        matches!(effect, Effect::Ble(BleEffect::Write { .. }))
    });
    engine
        .dispatch(host(
            start_request,
            HostEventKind::Ble(BleEvent::WriteCompleted),
        ))
        .unwrap();
    let first_chunk = engine
        .dispatch(host(
            subscription_request,
            HostEventKind::Ble(BleEvent::Notification {
                characteristic_uuid: CHAR_TRANSFER_STATUS.into(),
                value: vec![FIRMWARE_UPLOAD_START, 0],
            }),
        ))
        .unwrap();
    assert!(first_chunk.iter().any(|request| matches!(
        request.effect,
        Effect::FirmwareBlob(FirmwareBlobEffect::ReadChunk { offset: 0, .. })
    )));
}

#[test]
fn verify_success_requires_expected_disconnect_and_reconnect_is_bounded() {
    let mut engine = WorkflowEngine::default();
    let reconnecting = reach_reconnect(&mut engine);
    assert!(
        reconnecting
            .iter()
            .any(|request| matches!(request.effect, Effect::Ble(BleEffect::StartScan { .. })))
    );
    let timeout_request = request_id(&reconnecting, |effect| {
        matches!(
            effect,
            Effect::Timer(TimerEffect::Schedule {
                delay_ms: 120_000,
                ..
            })
        )
    });
    let timer_id = reconnecting
        .iter()
        .find_map(|request| match request.effect {
            Effect::Timer(TimerEffect::Schedule {
                timer_id,
                delay_ms: 120_000,
            }) => Some(timer_id),
            _ => None,
        })
        .unwrap();
    engine
        .dispatch(host(
            timeout_request,
            HostEventKind::TimerFired { timer_id },
        ))
        .unwrap();
    assert!(matches!(
        engine.status(),
        WorkflowStatus::Failed { error } if error.code == ErrorCode::Timeout
    ));
}

#[test]
fn verified_image_subscription_loss_enters_reconnect_instead_of_failing() {
    let mut engine = WorkflowEngine::default();
    let (subscription, verify, _) = reach_verify(&mut engine, 500);
    engine
        .dispatch(host(verify, HostEventKind::Ble(BleEvent::WriteCompleted)))
        .unwrap();
    engine
        .dispatch(host(
            subscription,
            HostEventKind::Ble(BleEvent::Notification {
                characteristic_uuid: CHAR_TRANSFER_STATUS.into(),
                value: vec![FIRMWARE_UPLOAD_VERIFY, 0],
            }),
        ))
        .unwrap();
    let effects = engine
        .dispatch(host(
            subscription,
            HostEventKind::Ble(BleEvent::Failed {
                platform_code: Some(-8),
            }),
        ))
        .unwrap();
    assert!(
        effects
            .iter()
            .any(|request| matches!(request.effect, Effect::Ble(BleEffect::StartScan { .. })))
    );
    assert!(!matches!(engine.status(), WorkflowStatus::Failed { .. }));
}

#[test]
fn subscription_loss_before_image_verification_remains_a_failure() {
    let mut engine = WorkflowEngine::default();
    let (subscription, _, _) = reach_verify(&mut engine, 500);
    engine
        .dispatch(host(
            subscription,
            HostEventKind::Ble(BleEvent::Failed {
                platform_code: Some(-8),
            }),
        ))
        .unwrap();
    assert!(matches!(engine.status(), WorkflowStatus::Failed { error }
        if error.code == ErrorCode::ConnectionFailed));
}

#[test]
fn reboot_reconnect_retries_empty_scans_without_restarting_the_overall_deadline() {
    let mut engine = WorkflowEngine::default();
    let reconnecting = reach_reconnect(&mut engine);
    let deadline = request_id(&reconnecting, |effect| {
        matches!(
            effect,
            Effect::Timer(TimerEffect::Schedule {
                delay_ms: 120_000,
                ..
            })
        )
    });
    let scan_timer = request_id(&reconnecting, |effect| {
        matches!(
            effect,
            Effect::Timer(TimerEffect::Schedule {
                delay_ms: 1_000,
                ..
            })
        )
    });
    let stopping = engine
        .dispatch(host(scan_timer, HostEventKind::TimerFired { timer_id: 1 }))
        .unwrap();
    let stop = request_id(&stopping, |effect| {
        matches!(effect, Effect::Ble(BleEffect::StopScan))
    });
    let waiting = engine
        .dispatch(host(stop, HostEventKind::Ble(BleEvent::ScanStopped)))
        .unwrap();
    assert!(!matches!(engine.status(), WorkflowStatus::Failed { .. }));
    let retry = request_id(&waiting, |effect| {
        matches!(
            effect,
            Effect::Timer(TimerEffect::Schedule {
                timer_id: 104,
                delay_ms: 1_000
            })
        )
    });
    let next = engine
        .dispatch(host(retry, HostEventKind::TimerFired { timer_id: 104 }))
        .unwrap();
    assert!(
        next.iter()
            .any(|request| matches!(request.effect, Effect::Ble(BleEffect::StartScan { .. })))
    );
    assert!(!next.iter().any(|request| matches!(
        request.effect,
        Effect::Timer(TimerEffect::Schedule {
            delay_ms: 120_000,
            ..
        }) | Effect::Network(_)
    )));
    engine
        .dispatch(host(deadline, HostEventKind::TimerFired { timer_id: 103 }))
        .unwrap();
    assert!(
        matches!(engine.status(), WorkflowStatus::Failed { error } if error.code == ErrorCode::Timeout)
    );
}

#[test]
fn successful_reconnect_reads_back_the_target_firmware_version() {
    let mut engine = WorkflowEngine::default();
    let reconnecting = reach_reconnect(&mut engine);
    let scan_request = request_id(&reconnecting, |effect| {
        matches!(effect, Effect::Ble(BleEffect::StartScan { .. }))
    });
    let stopping = engine
        .dispatch(host(
            scan_request,
            HostEventKind::Ble(BleEvent::ScanResult {
                candidate: DeviceCandidate {
                    peripheral_id: "new-ios-id".into(),
                    name: Some("Bota Pin".into()),
                    advertised_address: None,
                    rssi: -40,
                },
            }),
        ))
        .unwrap();
    let stop_request = request_id(&stopping, |effect| {
        matches!(effect, Effect::Ble(BleEffect::StopScan))
    });
    let connecting = engine
        .dispatch(host(
            stop_request,
            HostEventKind::Ble(BleEvent::ScanStopped),
        ))
        .unwrap();
    let connect_request = request_id(&connecting, |effect| {
        matches!(effect, Effect::Ble(BleEffect::Connect { .. }))
    });
    let discovering = engine
        .dispatch(host(
            connect_request,
            HostEventKind::Ble(BleEvent::Connected {
                peripheral_id: "new-ios-id".into(),
            }),
        ))
        .unwrap();
    let discover_request = request_id(&discovering, |effect| {
        matches!(effect, Effect::Ble(BleEffect::DiscoverServices { .. }))
    });
    let reading_identity = engine
        .dispatch(host(
            discover_request,
            HostEventKind::Ble(BleEvent::ServicesDiscovered {
                peripheral_id: "new-ios-id".into(),
            }),
        ))
        .unwrap();
    let serial_request = request_id(&reading_identity, |effect| {
        matches!(
            effect,
            Effect::Ble(BleEffect::Read { characteristic_uuid, .. })
                if characteristic_uuid == CHAR_SERIAL_NUMBER
        )
    });
    let persisting = engine
        .dispatch(host(
            serial_request,
            HostEventKind::Ble(BleEvent::ReadCompleted {
                value: device().as_str().as_bytes().to_vec(),
            }),
        ))
        .unwrap();
    let persist_request = request_id(&persisting, |effect| {
        matches!(
            effect,
            Effect::Persistence(PersistenceEffect::SaveConnectionIdentity { .. })
        )
    });
    let reading_version = engine
        .dispatch(host(
            persist_request,
            HostEventKind::ConnectionIdentitySaved,
        ))
        .unwrap();
    let version_request = request_id(&reading_version, |effect| {
        matches!(
            effect,
            Effect::Ble(BleEffect::Read { characteristic_uuid, .. })
                if characteristic_uuid == CHAR_FIRMWARE_REVISION
        )
    });
    let completed = engine
        .dispatch(host(
            version_request,
            HostEventKind::Ble(BleEvent::ReadCompleted {
                value: b"1.0.18".to_vec(),
            }),
        ))
        .unwrap();
    assert!(completed.iter().any(|request| matches!(
        request.effect,
        Effect::Notify(WorkflowNotification::Completed {
            operation: Operation::UpdateFirmware,
        })
    )));
}
