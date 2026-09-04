use bota_device_sdk_core::{
    error::{DeviceSdkError, ErrorCode, Operation},
    generated::protocol,
    model::{
        DeviceSerialNumber, HostMaterialId, RecordingSinkId, RecordingUploadProfile, RecordingUuid,
        UploadProfileSelection, UploadSecurityPolicy,
    },
    protocol::{EncryptedUploadV2Capabilities, decode_encrypted_upload_v2_capabilities},
    workflow::{
        EncryptedUploadV2Action, EncryptedUploadV2BatchCoordinator, EncryptedUploadV2BatchEvent,
        EncryptedUploadV2BatchRequest, EncryptedUploadV2BatchStatus, EncryptedUploadV2Checkpoint,
        EncryptedUploadV2TransferEvidence,
    },
};

fn capabilities() -> EncryptedUploadV2Capabilities {
    decode_encrypted_upload_v2_capabilities(&[
        0x01, 0x02, 0x18, 0x00, 0x7f, 0x00, 0x00, 0x00, 0x00, 0x04, 0x00, 0x04, 0xf4, 0x00, 0x10,
        0x00, 0x08, 0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00,
    ])
    .unwrap()
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
        capabilities: capabilities(),
        window_packets: 16,
        data_payload_bytes: 244,
        ciphertext_length: 330,
        ciphertext_sha256: [0x33; 32],
    }
}

fn checkpoint() -> EncryptedUploadV2Checkpoint {
    let request = request();
    EncryptedUploadV2Checkpoint {
        device: request.device,
        recording: request.recording,
        recording_generation: request.recording_generation,
        upload_session_uuid: request.upload_session_uuid,
        owner_revision: request.owner_revision,
        transport_session_id: request.transport_session_id,
        checkpoint_revision: 4,
        next_ciphertext_offset: 128,
        prefix_sha256: [0x44; 32],
        window_packets: request.window_packets,
        data_payload_bytes: request.data_payload_bytes,
    }
}

fn transfer_evidence() -> EncryptedUploadV2TransferEvidence {
    EncryptedUploadV2TransferEvidence {
        ciphertext_length: 330,
        ciphertext_sha256: [0x33; 32],
        manifest_length: 580,
        manifest_sha256: [0x55; 32],
        block_count: 1,
    }
}

fn start_fresh(coordinator: &mut EncryptedUploadV2BatchCoordinator) {
    assert_eq!(
        coordinator.start().unwrap(),
        vec![EncryptedUploadV2Action::LoadCheckpoint]
    );
    assert_eq!(
        coordinator
            .dispatch(EncryptedUploadV2BatchEvent::CheckpointLoaded(None))
            .unwrap(),
        vec![EncryptedUploadV2Action::TruncateSink {
            next_ciphertext_offset: 0,
        }]
    );
    assert_eq!(
        coordinator
            .dispatch(EncryptedUploadV2BatchEvent::SinkTruncated)
            .unwrap(),
        vec![EncryptedUploadV2Action::PrepareSession]
    );
    assert_eq!(
        coordinator
            .dispatch(EncryptedUploadV2BatchEvent::SessionPrepared {
                authorization_sha256: [0x66; 32],
            })
            .unwrap(),
        vec![EncryptedUploadV2Action::StartTransfer {
            checkpoint: None,
            authorization_sha256: [0x66; 32],
        }]
    );
    assert!(
        coordinator
            .dispatch(EncryptedUploadV2BatchEvent::TransferStarted)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn constructor_rejects_policy_capability_and_parameter_mismatch_before_actions() {
    let mut legacy = request();
    legacy.selection.profile = RecordingUploadProfile::LegacyPlainV1;
    let error = EncryptedUploadV2BatchCoordinator::new(legacy).unwrap_err();
    assert_eq!(
        error.detail.as_deref(),
        Some("encrypted_upload_v2_required_selection")
    );

    let mut unsupported = request();
    unsupported.capabilities.flags &= !protocol::ENCRYPTED_UPLOAD_V2_CAP_BATCH;
    let error = EncryptedUploadV2BatchCoordinator::new(unsupported).unwrap_err();
    assert_eq!(
        error.detail.as_deref(),
        Some("encrypted_upload_v2_unsupported")
    );

    let mut oversized = request();
    oversized.window_packets = oversized.capabilities.maximum_window_packets + 1;
    let error = EncryptedUploadV2BatchCoordinator::new(oversized).unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput);

    let mut impossible_length = request();
    impossible_length.ciphertext_length = 271;
    let error = EncryptedUploadV2BatchCoordinator::new(impossible_length).unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput);
}

#[test]
fn completion_receipt_is_an_absolute_gate_before_confirm_and_completion() {
    let mut coordinator = EncryptedUploadV2BatchCoordinator::new(request()).unwrap();
    start_fresh(&mut coordinator);

    assert_eq!(
        coordinator
            .dispatch(EncryptedUploadV2BatchEvent::TransferCompleted(
                transfer_evidence()
            ))
            .unwrap(),
        vec![EncryptedUploadV2Action::StageArtifacts {
            evidence: transfer_evidence(),
        }]
    );
    let before_receipt = coordinator
        .dispatch(EncryptedUploadV2BatchEvent::ArtifactsStaged)
        .unwrap();
    assert_eq!(
        before_receipt,
        vec![
            EncryptedUploadV2Action::ReportStaged {
                evidence: transfer_evidence(),
            },
            EncryptedUploadV2Action::AwaitCompletionReceipt,
        ]
    );
    assert!(!before_receipt.iter().any(is_confirm));
    assert_eq!(
        coordinator.status(),
        EncryptedUploadV2BatchStatus::WaitingForReceipt
    );

    assert_eq!(
        coordinator
            .dispatch(EncryptedUploadV2BatchEvent::CompletionReceiptAccepted {
                receipt_sha256: [0x77; 32],
            })
            .unwrap(),
        vec![EncryptedUploadV2Action::ConfirmWithReceipt {
            receipt_sha256: [0x77; 32],
        }]
    );
    assert_eq!(
        coordinator
            .dispatch(EncryptedUploadV2BatchEvent::RecordingConfirmed)
            .unwrap(),
        vec![
            EncryptedUploadV2Action::DeleteCheckpoint,
            EncryptedUploadV2Action::Complete,
        ]
    );
    assert_eq!(
        coordinator.status(),
        EncryptedUploadV2BatchStatus::Completed
    );
}

#[test]
fn failure_after_v2_selection_retains_recording_and_has_no_legacy_fallback_action() {
    let mut coordinator = EncryptedUploadV2BatchCoordinator::new(request()).unwrap();
    start_fresh(&mut coordinator);
    let failure = DeviceSdkError::new(ErrorCode::PersistenceFailed, Operation::Upload, true)
        .with_detail("staging failed");
    let actions = coordinator
        .dispatch(EncryptedUploadV2BatchEvent::Failed(failure.clone()))
        .unwrap();
    assert_eq!(
        actions,
        vec![
            EncryptedUploadV2Action::AbortV2,
            EncryptedUploadV2Action::RetainRecording,
            EncryptedUploadV2Action::Failed(failure),
        ]
    );
    assert!(!actions.iter().any(is_confirm));
    assert_eq!(coordinator.status(), EncryptedUploadV2BatchStatus::Failed);
}

#[test]
fn matching_checkpoint_truncates_unproved_tail_and_resume_rejection_restarts_only_v2() {
    let mut coordinator = EncryptedUploadV2BatchCoordinator::new(request()).unwrap();
    assert_eq!(
        coordinator.start().unwrap(),
        vec![EncryptedUploadV2Action::LoadCheckpoint]
    );
    assert_eq!(
        coordinator
            .dispatch(EncryptedUploadV2BatchEvent::CheckpointLoaded(Some(
                checkpoint()
            )))
            .unwrap(),
        vec![EncryptedUploadV2Action::TruncateSink {
            next_ciphertext_offset: 128,
        }]
    );
    coordinator
        .dispatch(EncryptedUploadV2BatchEvent::SinkTruncated)
        .unwrap();
    assert_eq!(
        coordinator
            .dispatch(EncryptedUploadV2BatchEvent::SessionPrepared {
                authorization_sha256: [0x66; 32],
            })
            .unwrap(),
        vec![EncryptedUploadV2Action::StartTransfer {
            checkpoint: Some(checkpoint()),
            authorization_sha256: [0x66; 32],
        }]
    );

    assert_eq!(
        coordinator
            .dispatch(EncryptedUploadV2BatchEvent::ResumeRejected)
            .unwrap(),
        vec![
            EncryptedUploadV2Action::DeleteCheckpoint,
            EncryptedUploadV2Action::TruncateSink {
                next_ciphertext_offset: 0,
            },
        ]
    );
    assert_eq!(coordinator.status(), EncryptedUploadV2BatchStatus::Running);
}

#[test]
fn complete_windows_are_persisted_before_ack_and_missing_sequences_request_repair() {
    let mut coordinator = EncryptedUploadV2BatchCoordinator::new(request()).unwrap();
    start_fresh(&mut coordinator);
    let current = checkpoint();

    assert_eq!(
        coordinator
            .dispatch(EncryptedUploadV2BatchEvent::WindowStaged {
                checkpoint: current.clone(),
                missing_sequences: vec![7, 11],
            })
            .unwrap(),
        vec![EncryptedUploadV2Action::RepairWindow {
            missing_sequences: vec![7, 11],
        }]
    );
    assert_eq!(
        coordinator
            .dispatch(EncryptedUploadV2BatchEvent::WindowStaged {
                checkpoint: current.clone(),
                missing_sequences: Vec::new(),
            })
            .unwrap(),
        vec![EncryptedUploadV2Action::SaveCheckpoint {
            checkpoint: current.clone(),
        }]
    );
    assert_eq!(
        coordinator
            .dispatch(EncryptedUploadV2BatchEvent::CheckpointSaved)
            .unwrap(),
        vec![EncryptedUploadV2Action::AcknowledgeWindow {
            checkpoint: current.clone(),
        }]
    );
    assert_eq!(
        coordinator
            .dispatch(EncryptedUploadV2BatchEvent::WindowAcknowledged {
                checkpoint: current,
            })
            .unwrap(),
        vec![EncryptedUploadV2Action::Progress {
            completed_units: 128,
            total_units: 330,
        }]
    );
}

#[test]
fn mixed_profile_and_cancellation_abort_v2_without_confirming_delete() {
    for event in [
        EncryptedUploadV2BatchEvent::MixedProfile,
        EncryptedUploadV2BatchEvent::Cancelled,
    ] {
        let mut coordinator = EncryptedUploadV2BatchCoordinator::new(request()).unwrap();
        start_fresh(&mut coordinator);
        let actions = coordinator.dispatch(event).unwrap();
        assert!(actions.contains(&EncryptedUploadV2Action::AbortV2));
        assert!(actions.contains(&EncryptedUploadV2Action::RetainRecording));
        assert!(!actions.iter().any(is_confirm));
    }
}

#[test]
fn stale_phase_event_does_not_advance_or_confirm() {
    let mut coordinator = EncryptedUploadV2BatchCoordinator::new(request()).unwrap();
    coordinator.start().unwrap();
    let error = coordinator
        .dispatch(EncryptedUploadV2BatchEvent::CompletionReceiptAccepted {
            receipt_sha256: [0x77; 32],
        })
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::UnexpectedEvent);
    assert_eq!(coordinator.status(), EncryptedUploadV2BatchStatus::Running);
}

fn is_confirm(action: &EncryptedUploadV2Action) -> bool {
    matches!(action, EncryptedUploadV2Action::ConfirmWithReceipt { .. })
}
