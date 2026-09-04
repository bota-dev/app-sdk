use bota_device_sdk_core::{
    engine::{
        CancellationId, Capability, CapabilitySet, Command, Effect, EncryptedUploadV2HostEffect,
        EncryptedUploadV2HostEvent, Event, HostEvent, HostEventKind, RequestId, WorkflowEngine,
        WorkflowNotification, WorkflowStatus,
    },
    error::ErrorCode,
    generated::protocol,
    model::{
        DeviceSerialNumber, HostMaterialId, RecordingSinkId, RecordingUploadProfile, RecordingUuid,
        UploadProfileSelection, UploadSecurityPolicy,
    },
    protocol::decode_encrypted_upload_v2_capabilities,
    workflow::{
        EncryptedUploadV2BatchRequest, EncryptedUploadV2Checkpoint,
        EncryptedUploadV2TransferEvidence,
    },
};

const CANCELLATION: CancellationId = CancellationId::from_bytes([0x91; 16]);

fn capabilities() -> CapabilitySet {
    CapabilitySet::from([
        Capability::Ble,
        Capability::Persistence,
        Capability::Progress,
        Capability::HostMaterial,
        Capability::RecordingSink,
        Capability::NetworkTransfer,
    ])
}

fn request() -> EncryptedUploadV2BatchRequest {
    EncryptedUploadV2BatchRequest {
        device: DeviceSerialNumber::new("EVFXXW67KP").unwrap(),
        recording: RecordingUuid::from_bytes([0x22; 16]),
        recording_generation: 9,
        storage_format: protocol::STORAGE_FORMAT_BOTA_ENC_V2,
        upload_session_uuid: [0x11; 16],
        owner_revision: 3,
        transport_session_id: 0x1122_3344_5566,
        material_id: HostMaterialId::new("v2-material-1").unwrap(),
        sink_id: RecordingSinkId::new("v2-sink-1").unwrap(),
        selection: UploadProfileSelection {
            policy: UploadSecurityPolicy::V2Preferred,
            profile: RecordingUploadProfile::EncryptedUploadV2,
        },
        capabilities: decode_encrypted_upload_v2_capabilities(&[
            0x01, 0x02, 0x18, 0x00, 0x7f, 0x00, 0x00, 0x00, 0x00, 0x04, 0x00, 0x04, 0xf4, 0x00,
            0x10, 0x00, 0x08, 0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00,
        ])
        .unwrap(),
        window_packets: 16,
        data_payload_bytes: 244,
        ciphertext_length: 330,
        ciphertext_sha256: [0x33; 32],
    }
}

fn command() -> Command {
    Command::TransferEncryptedRecording { request: request() }
}

fn evidence() -> EncryptedUploadV2TransferEvidence {
    EncryptedUploadV2TransferEvidence {
        ciphertext_length: 330,
        ciphertext_sha256: [0x33; 32],
        manifest_length: 580,
        manifest_sha256: [0x55; 32],
        block_count: 1,
    }
}

fn checkpoint(revision: u32, offset: u64) -> EncryptedUploadV2Checkpoint {
    let request = request();
    EncryptedUploadV2Checkpoint {
        device: request.device,
        recording: request.recording,
        recording_generation: request.recording_generation,
        upload_session_uuid: request.upload_session_uuid,
        owner_revision: request.owner_revision,
        transport_session_id: request.transport_session_id,
        checkpoint_revision: revision,
        next_ciphertext_offset: offset,
        prefix_sha256: [revision as u8; 32],
        window_packets: request.window_packets,
        data_payload_bytes: request.data_payload_bytes,
    }
}

fn host(request_id: RequestId, event: EncryptedUploadV2HostEvent) -> Event {
    Event::Host(HostEvent {
        request_id,
        kind: HostEventKind::EncryptedUploadV2(event),
    })
}

fn v2_request_id(effects: &[bota_device_sdk_core::engine::EffectRequest]) -> RequestId {
    effects
        .iter()
        .find_map(|effect| {
            matches!(effect.effect, Effect::EncryptedUploadV2(_)).then_some(effect.request_id)
        })
        .expect("expected encrypted upload v2 host effect")
}

fn engine_waiting_for_staging() -> (WorkflowEngine, RequestId) {
    let mut engine = WorkflowEngine::default();
    let effects = engine
        .start(command(), &capabilities(), CANCELLATION)
        .unwrap();
    let effects = engine
        .dispatch(host(
            v2_request_id(&effects),
            EncryptedUploadV2HostEvent::CheckpointLoaded(None),
        ))
        .unwrap();
    let effects = engine
        .dispatch(host(
            v2_request_id(&effects),
            EncryptedUploadV2HostEvent::SinkTruncated,
        ))
        .unwrap();
    let effects = engine
        .dispatch(host(
            v2_request_id(&effects),
            EncryptedUploadV2HostEvent::SessionPrepared {
                authorization_sha256: [0x66; 32],
            },
        ))
        .unwrap();
    let transfer_request = v2_request_id(&effects);
    engine
        .dispatch(host(
            transfer_request,
            EncryptedUploadV2HostEvent::TransferStarted,
        ))
        .unwrap();
    let effects = engine
        .dispatch(host(
            transfer_request,
            EncryptedUploadV2HostEvent::TransferCompleted(evidence()),
        ))
        .unwrap();
    let stage_request = v2_request_id(&effects);
    (engine, stage_request)
}

#[test]
fn invalid_v2_decision_fails_before_engine_state_or_host_effects() {
    let mut invalid = request();
    invalid.selection.profile = RecordingUploadProfile::LegacyPlainV1;
    let mut engine = WorkflowEngine::default();
    let error = engine
        .start(
            Command::TransferEncryptedRecording { request: invalid },
            &capabilities(),
            CANCELLATION,
        )
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput);
    assert_eq!(engine.status(), &WorkflowStatus::Idle);
}

#[test]
fn engine_preserves_request_identity_and_receipt_gate() {
    let mut engine = WorkflowEngine::default();
    let effects = engine
        .start(command(), &capabilities(), CANCELLATION)
        .unwrap();
    assert!(effects.iter().any(|effect| matches!(
        effect.effect,
        Effect::Notify(WorkflowNotification::Started { .. })
    )));
    assert!(effects.iter().any(|effect| matches!(
        effect.effect,
        Effect::EncryptedUploadV2(EncryptedUploadV2HostEffect::LoadCheckpoint { .. })
    )));

    let load = v2_request_id(&effects);
    let stale = engine
        .dispatch(host(
            RequestId::from_u64(load.as_u64() + 99),
            EncryptedUploadV2HostEvent::CheckpointLoaded(None),
        ))
        .unwrap_err();
    assert_eq!(stale.code, ErrorCode::UnexpectedEvent);

    let effects = engine
        .dispatch(host(
            load,
            EncryptedUploadV2HostEvent::CheckpointLoaded(None),
        ))
        .unwrap();
    let truncate = v2_request_id(&effects);
    let effects = engine
        .dispatch(host(truncate, EncryptedUploadV2HostEvent::SinkTruncated))
        .unwrap();
    let prepare = v2_request_id(&effects);
    let effects = engine
        .dispatch(host(
            prepare,
            EncryptedUploadV2HostEvent::SessionPrepared {
                authorization_sha256: [0x66; 32],
            },
        ))
        .unwrap();
    let start = v2_request_id(&effects);
    let effects = engine
        .dispatch(host(start, EncryptedUploadV2HostEvent::TransferStarted))
        .unwrap();
    assert!(effects.is_empty());

    let start_operation = engine.status().clone();
    let error = engine
        .dispatch(host(
            RequestId::from_u64(start.as_u64() + 99),
            EncryptedUploadV2HostEvent::TransferCompleted(evidence()),
        ))
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::UnexpectedEvent);
    assert_eq!(engine.status(), &start_operation);
}

#[test]
fn staging_notification_precedes_receipt_and_only_receipt_acceptance_emits_confirm() {
    let mut engine = WorkflowEngine::default();
    let effects = engine
        .start(command(), &capabilities(), CANCELLATION)
        .unwrap();
    let load = v2_request_id(&effects);
    let effects = engine
        .dispatch(host(
            load,
            EncryptedUploadV2HostEvent::CheckpointLoaded(None),
        ))
        .unwrap();
    let effects = engine
        .dispatch(host(
            v2_request_id(&effects),
            EncryptedUploadV2HostEvent::SinkTruncated,
        ))
        .unwrap();
    let effects = engine
        .dispatch(host(
            v2_request_id(&effects),
            EncryptedUploadV2HostEvent::SessionPrepared {
                authorization_sha256: [0x66; 32],
            },
        ))
        .unwrap();
    let transfer_request = v2_request_id(&effects);
    let effects = engine
        .dispatch(host(
            transfer_request,
            EncryptedUploadV2HostEvent::TransferStarted,
        ))
        .unwrap();
    assert!(effects.is_empty());

    let effects = engine
        .dispatch(host(
            transfer_request,
            EncryptedUploadV2HostEvent::TransferCompleted(evidence()),
        ))
        .unwrap();
    assert!(effects.iter().any(|effect| matches!(
        effect.effect,
        Effect::EncryptedUploadV2(EncryptedUploadV2HostEffect::StageArtifacts { .. })
    )));
    assert!(!effects.iter().any(|effect| matches!(
        effect.effect,
        Effect::EncryptedUploadV2(EncryptedUploadV2HostEffect::ConfirmWithReceipt { .. })
    )));

    let effects = engine
        .dispatch(host(
            v2_request_id(&effects),
            EncryptedUploadV2HostEvent::ArtifactsStaged,
        ))
        .unwrap();
    assert!(effects.iter().any(|effect| matches!(
        effect.effect,
        Effect::Notify(WorkflowNotification::EncryptedUploadV2Staged { .. })
    )));
    assert!(!effects.iter().any(|effect| matches!(
        effect.effect,
        Effect::EncryptedUploadV2(EncryptedUploadV2HostEffect::ConfirmWithReceipt { .. })
    )));

    let effects = engine
        .dispatch(host(
            v2_request_id(&effects),
            EncryptedUploadV2HostEvent::CompletionReceiptAccepted {
                receipt_sha256: [0x77; 32],
            },
        ))
        .unwrap();
    assert!(effects.iter().any(|effect| matches!(
        effect.effect,
        Effect::EncryptedUploadV2(EncryptedUploadV2HostEffect::ConfirmWithReceipt { .. })
    )));
    let effects = engine
        .dispatch(host(
            v2_request_id(&effects),
            EncryptedUploadV2HostEvent::RecordingConfirmed,
        ))
        .unwrap();
    assert!(effects.iter().any(|effect| matches!(
        effect.effect,
        Effect::Notify(WorkflowNotification::Completed { .. })
    )));
    assert_eq!(
        engine.status(),
        &WorkflowStatus::Completed {
            operation: bota_device_sdk_core::error::Operation::TransferRecording,
        }
    );
}

#[test]
fn cancellation_after_selection_has_abort_and_no_fallback_or_confirm() {
    let mut engine = WorkflowEngine::default();
    engine
        .start(command(), &capabilities(), CANCELLATION)
        .unwrap();
    let effects = engine
        .dispatch(Event::Cancelled {
            cancellation_id: CANCELLATION,
        })
        .unwrap();
    assert!(effects.iter().any(|effect| matches!(
        effect.effect,
        Effect::EncryptedUploadV2(EncryptedUploadV2HostEffect::AbortV2 { .. })
    )));
    assert!(!effects.iter().any(|effect| matches!(
        effect.effect,
        Effect::EncryptedUploadV2(EncryptedUploadV2HostEffect::ConfirmWithReceipt { .. })
            | Effect::Notify(WorkflowNotification::BleFallbackReady { .. })
    )));
}

#[test]
fn resume_repair_persists_before_ack_and_returns_ownership_to_the_transfer() {
    let mut engine = WorkflowEngine::default();
    let effects = engine
        .start(command(), &capabilities(), CANCELLATION)
        .unwrap();
    let load = v2_request_id(&effects);
    let effects = engine
        .dispatch(host(
            load,
            EncryptedUploadV2HostEvent::CheckpointLoaded(Some(checkpoint(1, 100))),
        ))
        .unwrap();
    let effects = engine
        .dispatch(host(
            v2_request_id(&effects),
            EncryptedUploadV2HostEvent::SinkTruncated,
        ))
        .unwrap();
    let effects = engine
        .dispatch(host(
            v2_request_id(&effects),
            EncryptedUploadV2HostEvent::SessionPrepared {
                authorization_sha256: [0x66; 32],
            },
        ))
        .unwrap();
    let transfer_request = v2_request_id(&effects);
    let effects = engine
        .dispatch(host(
            transfer_request,
            EncryptedUploadV2HostEvent::TransferStarted,
        ))
        .unwrap();
    assert!(effects.is_empty());

    let candidate = checkpoint(2, 200);
    let effects = engine
        .dispatch(host(
            transfer_request,
            EncryptedUploadV2HostEvent::WindowStaged {
                checkpoint: candidate.clone(),
                missing_sequences: vec![7, 9],
            },
        ))
        .unwrap();
    assert!(matches!(
        &effects[0].effect,
        Effect::EncryptedUploadV2(EncryptedUploadV2HostEffect::RepairWindow {
            missing_sequences
        }) if missing_sequences == &[7, 9]
    ));

    let effects = engine
        .dispatch(host(
            v2_request_id(&effects),
            EncryptedUploadV2HostEvent::WindowStaged {
                checkpoint: candidate.clone(),
                missing_sequences: vec![],
            },
        ))
        .unwrap();
    assert!(matches!(
        effects[0].effect,
        Effect::EncryptedUploadV2(EncryptedUploadV2HostEffect::SaveCheckpoint { .. })
    ));
    let effects = engine
        .dispatch(host(
            v2_request_id(&effects),
            EncryptedUploadV2HostEvent::CheckpointSaved,
        ))
        .unwrap();
    assert!(matches!(
        effects[0].effect,
        Effect::EncryptedUploadV2(EncryptedUploadV2HostEffect::AcknowledgeWindow { .. })
    ));
    let effects = engine
        .dispatch(host(
            v2_request_id(&effects),
            EncryptedUploadV2HostEvent::WindowAcknowledged {
                checkpoint: candidate,
            },
        ))
        .unwrap();
    assert!(matches!(effects[0].effect, Effect::Progress(_)));

    let effects = engine
        .dispatch(host(
            transfer_request,
            EncryptedUploadV2HostEvent::TransferCompleted(evidence()),
        ))
        .unwrap();
    assert!(matches!(
        effects[0].effect,
        Effect::EncryptedUploadV2(EncryptedUploadV2HostEffect::StageArtifacts { .. })
    ));
}

#[test]
fn rejected_resume_restarts_only_v2_from_zero() {
    let mut engine = WorkflowEngine::default();
    let effects = engine
        .start(command(), &capabilities(), CANCELLATION)
        .unwrap();
    let effects = engine
        .dispatch(host(
            v2_request_id(&effects),
            EncryptedUploadV2HostEvent::CheckpointLoaded(Some(checkpoint(1, 100))),
        ))
        .unwrap();
    let effects = engine
        .dispatch(host(
            v2_request_id(&effects),
            EncryptedUploadV2HostEvent::SinkTruncated,
        ))
        .unwrap();
    let effects = engine
        .dispatch(host(
            v2_request_id(&effects),
            EncryptedUploadV2HostEvent::SessionPrepared {
                authorization_sha256: [0x66; 32],
            },
        ))
        .unwrap();
    let effects = engine
        .dispatch(host(
            v2_request_id(&effects),
            EncryptedUploadV2HostEvent::ResumeRejected,
        ))
        .unwrap();
    assert!(effects.iter().any(|effect| matches!(
        effect.effect,
        Effect::EncryptedUploadV2(EncryptedUploadV2HostEffect::DeleteCheckpoint { .. })
    )));
    let truncate = effects
        .iter()
        .find(|effect| {
            matches!(
                effect.effect,
                Effect::EncryptedUploadV2(EncryptedUploadV2HostEffect::TruncateSink {
                    next_ciphertext_offset: 0,
                    ..
                })
            )
        })
        .expect("resume rejection truncates to zero");
    let effects = engine
        .dispatch(host(
            truncate.request_id,
            EncryptedUploadV2HostEvent::SinkTruncated,
        ))
        .unwrap();
    assert!(effects.iter().any(|effect| matches!(
        effect.effect,
        Effect::EncryptedUploadV2(EncryptedUploadV2HostEffect::StartTransfer {
            checkpoint: None,
            ..
        })
    )));
    assert!(!effects.iter().any(|effect| matches!(
        effect.effect,
        Effect::Notify(WorkflowNotification::BleFallbackReady { .. })
    )));
}

#[test]
fn mixed_profile_and_host_failure_are_terminal_without_fallback_or_confirm() {
    for host_event in [
        EncryptedUploadV2HostEvent::MixedProfile,
        EncryptedUploadV2HostEvent::Failed {
            error: bota_device_sdk_core::error::DeviceSdkError::new(
                ErrorCode::IntegrityFailed,
                bota_device_sdk_core::error::Operation::TransferRecording,
                false,
            ),
        },
    ] {
        let mut engine = WorkflowEngine::default();
        let effects = engine
            .start(command(), &capabilities(), CANCELLATION)
            .unwrap();
        let effects = engine
            .dispatch(host(v2_request_id(&effects), host_event))
            .unwrap();
        assert!(effects.iter().any(|effect| matches!(
            effect.effect,
            Effect::EncryptedUploadV2(EncryptedUploadV2HostEffect::AbortV2 { .. })
        )));
        assert!(effects.iter().any(|effect| matches!(
            effect.effect,
            Effect::Notify(WorkflowNotification::Failed { .. })
        )));
        assert!(!effects.iter().any(|effect| matches!(
            effect.effect,
            Effect::EncryptedUploadV2(EncryptedUploadV2HostEffect::ConfirmWithReceipt { .. })
                | Effect::Notify(WorkflowNotification::BleFallbackReady { .. })
        )));
        assert!(matches!(engine.status(), WorkflowStatus::Failed { .. }));
    }
}

#[test]
fn staging_and_receipt_failures_retain_the_recording_without_confirming() {
    for after_staging in [false, true] {
        let (mut engine, stage_request) = engine_waiting_for_staging();
        let request_id = if after_staging {
            let effects = engine
                .dispatch(host(
                    stage_request,
                    EncryptedUploadV2HostEvent::ArtifactsStaged,
                ))
                .unwrap();
            v2_request_id(&effects)
        } else {
            stage_request
        };
        let effects = engine
            .dispatch(host(
                request_id,
                EncryptedUploadV2HostEvent::Failed {
                    error: bota_device_sdk_core::error::DeviceSdkError::new(
                        ErrorCode::IntegrityFailed,
                        bota_device_sdk_core::error::Operation::TransferRecording,
                        false,
                    ),
                },
            ))
            .unwrap();
        assert!(effects.iter().any(|effect| matches!(
            effect.effect,
            Effect::EncryptedUploadV2(EncryptedUploadV2HostEffect::AbortV2 { .. })
        )));
        assert!(!effects.iter().any(|effect| matches!(
            effect.effect,
            Effect::EncryptedUploadV2(EncryptedUploadV2HostEffect::ConfirmWithReceipt { .. })
                | Effect::Notify(WorkflowNotification::BleFallbackReady { .. })
        )));
        assert!(matches!(engine.status(), WorkflowStatus::Failed { .. }));
    }
}
