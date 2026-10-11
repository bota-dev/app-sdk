use bota_device_sdk_core::model::{ByoCapture, ByoPhase, ByoRecovery, ByoRetryAction, ByoRoute};

fn capture() -> ByoCapture {
    ByoCapture {
        environment: bota_device_sdk_core::model::ByoEnvironment::Gamma,
        organization_id: "organization".into(),
        project_id: "project".into(),
        device_id: "device".into(),
        binding_generation: 1,
        device_assignment_generation: 1,
        policy_revision: "1".into(),
        recording_uuid: "00112233-4455-6677-8899-aabbccddeeff".into(),
        recording_generation: 1,
    }
}
fn route() -> ByoRoute {
    ByoRoute {
        recording_id: "recording".into(),
        configuration_id: "310eec75-feb0-487b-9d05-2d21c0b18794".into(),
        configuration_revision: 1,
        configuration_sha256: "a".repeat(64),
        destination_ref: "customer".into(),
        session_id: "cde68c61-db75-43c8-8112-623ad29a2f13".into(),
        owner_revision: 1,
    }
}

#[test]
fn renewal_intent_survives_restart_and_fences_late_replies() {
    let mut r = ByoRecovery::new(capture()).unwrap();
    r.source_finalized(1000, "b".repeat(64)).unwrap();
    r.bind(route(), false).unwrap();
    let operation = "00112233-4455-4677-8899-aabbccddeeff";
    r.begin_renewal(operation.into(), 0).unwrap();
    let bytes = r.encode_checkpoint().unwrap();
    let mut restored = ByoRecovery::decode_checkpoint(&bytes).unwrap();
    restored.after_restart().unwrap();
    assert_eq!(restored.renewal_operation.as_deref(), Some(operation));
    assert!(
        restored
            .begin_renewal("10112233-4455-4677-8899-aabbccddeeff".into(), 0)
            .is_err()
    );
    assert!(restored.renewal_committed(operation, 2).is_err());
    restored.renewal_committed(operation, 1).unwrap();
    assert_eq!(restored.renewal_revision, 1);
    assert_eq!(restored.route, r.route);
    assert_eq!(restored.phase, ByoPhase::HttpWholeFile);
    assert!(restored.renewal_committed(operation, 1).is_err());
    assert!(!restored.may_cleanup());
}

#[test]
fn original_checkpoint_restores_with_no_renewal_and_pending_renewal_blocks_cleanup() {
    let mut r = ByoRecovery::new(capture()).unwrap();
    r.source_finalized(1000, "b".repeat(64)).unwrap();
    r.bind(route(), false).unwrap();
    let mut old = r.encode_checkpoint().unwrap();
    old[4] = 1;
    old.truncate(old.len() - 5);
    assert_eq!(ByoRecovery::decode_checkpoint(&old).unwrap(), r);
    r.verification_pending().unwrap();
    r.receipt_verified("c".repeat(64)).unwrap();
    r.receipt_persisted(&"c".repeat(64)).unwrap();
    r.begin_renewal("00112233-4455-4677-8899-aabbccddeeff".into(), 0)
        .unwrap();
    assert!(!r.may_cleanup());
    assert!(r.cleanup_finished().is_err());
    r.renewal_committed("00112233-4455-4677-8899-aabbccddeeff", 1)
        .unwrap();
    assert!(r.may_cleanup());
    r.cleanup_finished().unwrap();
    assert!(
        r.begin_renewal("00112233-4455-4677-8899-aabbccddeeff".into(), 1)
            .is_err()
    );
}

#[test]
fn renewal_does_not_overwrite_a_handoff_or_grant_cleanup() {
    let mut r = ByoRecovery::new(capture()).unwrap();
    assert!(
        r.begin_renewal("00112233-4455-4677-8899-aabbccddeeff".into(), 0)
            .is_err()
    );
    r.bind(route(), true).unwrap();
    r.source_finalized(1000, "b".repeat(64)).unwrap();
    r.after_restart().unwrap();
    r.begin_fallback("handoff".into()).unwrap();
    let before = r.clone();
    assert!(r.begin_renewal("bad".into(), 0).is_err());
    assert_eq!(r, before);
    // Renewing the exhausted stream is allowed while the exact fence is pending;
    // neither the pending fence nor source facts may be discarded.
    r.begin_renewal("00112233-4455-4677-8899-aabbccddeeff".into(), 0)
        .unwrap();
    assert_eq!(r.pending_operation, before.pending_operation);
    r.renewal_committed("00112233-4455-4677-8899-aabbccddeeff", 1)
        .unwrap();
    assert_eq!(r.phase, ByoPhase::FencePending);
    assert!(!r.may_cleanup());
}

#[test]
fn assembled_stream_and_http_segments_use_the_same_fenced_successor() {
    use bota_device_sdk_core::model::{ByoHandoffMode, ByoTransport};
    for transport in [ByoTransport::WebSocket, ByoTransport::HttpSegments] {
        let mut r = ByoRecovery::new(capture()).unwrap();
        r.bind_transport(route(), transport).unwrap();
        assert!(
            r.begin_handoff("finish".into(), ByoHandoffMode::Assembled)
                .is_err()
        );
        r.source_finalized(1000, "b".repeat(64)).unwrap();
        r.begin_handoff("finish".into(), ByoHandoffMode::Assembled)
            .unwrap();
        let saved = serde_json::to_vec(&r).unwrap();
        let mut restored: ByoRecovery = serde_json::from_slice(&saved).unwrap();
        restored.after_restart().unwrap();
        let mut successor = route();
        successor.owner_revision = 2;
        successor.session_id = "dde68c61-db75-43c8-8112-623ad29a2f13".into();
        restored.accept_handoff("finish", successor).unwrap();
        assert_eq!(restored.phase, ByoPhase::Verifying);
        assert!(!restored.may_cleanup());
    }
}

#[test]
fn native_recovery_boundary_checks_scope_and_rejects_material_fields() {
    use bota_device_sdk_core::model::{ByoRecoveryEvent, ByoRecoveryRequest};
    let request = ByoRecoveryRequest {
        checkpoint: None,
        current_capture: capture(),
        event: ByoRecoveryEvent::Create,
    };
    let initial = request.reduce().unwrap();
    assert_eq!(initial.checkpoint.phase, ByoPhase::New);
    let mut current = capture();
    current.binding_generation += 1;
    assert!(
        ByoRecoveryRequest {
            checkpoint: Some(initial.checkpoint),
            current_capture: current,
            event: ByoRecoveryEvent::Restart
        }
        .reduce()
        .is_err()
    );
    let mut json = serde_json::to_value(request).unwrap();
    json["audio"] = serde_json::json!("must-not-cross-this-boundary");
    assert!(serde_json::from_value::<ByoRecoveryRequest>(json).is_err());
}
#[test]
fn retries_ws_three_times_then_waits_for_complete_source_and_customer_fence() {
    let mut r = ByoRecovery::new(capture()).unwrap();
    r.bind(route(), true).unwrap();
    for delay in [1000, 2000, 4000] {
        assert_eq!(
            r.ws_failed().unwrap(),
            ByoRetryAction::ReconnectAfterMs(delay)
        );
    }
    assert_eq!(
        r.ws_failed().unwrap(),
        ByoRetryAction::WaitForCompleteSource
    );
    assert!(r.begin_fallback("operation".into()).is_err());
    r.source_finalized(1000, "b".repeat(64)).unwrap();
    r.begin_fallback("operation".into()).unwrap();
    assert_eq!(r.phase, ByoPhase::FencePending);
    let mut successor = route();
    successor.session_id = "dde68c61-db75-43c8-8112-623ad29a2f13".into();
    successor.owner_revision = 2;
    assert!(r.accept_handoff("other", successor.clone()).is_err());
    r.accept_handoff("operation", successor).unwrap();
    assert_eq!(r.phase, ByoPhase::HttpWholeFile);
    assert!(r.ws_failed().is_err());
    assert_eq!(r.upload_offset(), 0);
}
#[test]
fn lost_response_and_restart_keep_exact_capture_destination_and_operation() {
    let mut r = ByoRecovery::new(capture()).unwrap();
    r.bind(route(), true).unwrap();
    for _ in 0..4 {
        r.ws_failed().unwrap();
    }
    r.source_finalized(1000, "b".repeat(64)).unwrap();
    r.begin_fallback("same-operation".into()).unwrap();
    let bytes = serde_json::to_vec(&r).unwrap();
    let mut restored: ByoRecovery = serde_json::from_slice(&bytes).unwrap();
    restored.validate().unwrap();
    assert_eq!(
        restored.pending_operation.as_deref(),
        Some("same-operation")
    );
    let mut wrong = route();
    wrong.destination_ref = "bota".into();
    wrong.owner_revision = 2;
    assert!(restored.accept_handoff("same-operation", wrong).is_err());
    assert!(restored.bind(route(), false).is_err());
}
#[test]
fn segment_ack_never_authorizes_cleanup_and_receipt_persistence_precedes_deletion() {
    let mut r = ByoRecovery::new(capture()).unwrap();
    r.source_finalized(1000, "b".repeat(64)).unwrap();
    r.bind(route(), false).unwrap();
    assert!(!r.may_cleanup());
    r.verification_pending().unwrap();
    assert!(!r.may_cleanup());
    r.receipt_verified("c".repeat(64)).unwrap();
    assert!(!r.may_cleanup());
    assert!(r.receipt_persisted(&"d".repeat(64)).is_err());
    r.receipt_persisted(&"c".repeat(64)).unwrap();
    assert!(r.may_cleanup());
    r.cleanup_finished().unwrap();
    assert_eq!(r.phase, ByoPhase::Complete);
}
#[test]
fn finalized_bytes_and_capture_scope_cannot_change_on_retry() {
    let mut r = ByoRecovery::new(capture()).unwrap();
    r.source_finalized(1000, "b".repeat(64)).unwrap();
    r.bind(route(), false).unwrap();
    assert!(r.source_finalized(1001, "b".repeat(64)).is_err());
    let mut other = capture();
    other.binding_generation = 2;
    assert!(r.authorize(&other).is_err());
    assert!(r.source_finalized(134217729, "a".repeat(64)).is_err());
}
#[test]
fn restart_reconciles_stream_ownership_before_full_source_fallback() {
    let mut r = ByoRecovery::new(capture()).unwrap();
    r.bind(route(), true).unwrap();
    r.source_finalized(1000, "b".repeat(64)).unwrap();
    r.after_restart().unwrap();
    assert_eq!(r.phase, ByoPhase::WaitingForSource);
    r.begin_fallback("persisted-operation".into()).unwrap();
    let before = r.clone();
    r.after_restart().unwrap();
    assert_eq!(r, before);
}
#[test]
fn rejects_inconsistent_persisted_phases() {
    let initial = ByoRecovery::new(capture()).unwrap();
    let mut r = initial.clone();
    r.route = Some(route());
    assert!(r.validate().is_err());
    let mut r = initial.clone();
    r.pending_operation = Some("unexpected".into());
    assert!(r.validate().is_err());
    let mut r = initial;
    r.receipt_sha256 = Some("a".repeat(64));
    assert!(r.validate().is_err());
}

#[test]
fn opaque_checkpoint_roundtrip_rejects_every_truncation_and_trailing_bytes() {
    let mut state = ByoRecovery::new(capture()).unwrap();
    state.bind(route(), true).unwrap();
    for _ in 0..4 {
        state.ws_failed().unwrap();
    }
    state.source_finalized(1000, "b".repeat(64)).unwrap();
    state.begin_fallback("durable-operation".into()).unwrap();
    let bytes = state.encode_checkpoint().unwrap();
    assert_eq!(ByoRecovery::decode_checkpoint(&bytes).unwrap(), state);
    for n in 0..bytes.len() {
        assert!(
            ByoRecovery::decode_checkpoint(&bytes[..n]).is_err(),
            "accepted truncation {n}"
        );
    }
    let mut trailing = bytes.clone();
    trailing.push(0);
    assert!(ByoRecovery::decode_checkpoint(&trailing).is_err());
    let mut bad_version = bytes;
    bad_version[4] = 3;
    assert!(ByoRecovery::decode_checkpoint(&bad_version).is_err());
}

#[test]
fn identifiers_match_server_admission_including_first_character() {
    for invalid in [
        "-device", ".device", ":device", "_device", " device", "设备",
    ] {
        let mut c = capture();
        c.device_id = invalid.into();
        assert!(ByoRecovery::new(c).is_err(), "accepted {invalid}");
    }
    let mut r = ByoRecovery::new(capture()).unwrap();
    let mut destination = route();
    destination.destination_ref = "-customer".into();
    assert!(r.bind(destination, false).is_err());
    assert_eq!(r.phase, ByoPhase::New);
}

#[test]
fn a_whole_file_owner_requires_final_source_facts_before_admission() {
    use bota_device_sdk_core::model::ByoTransport;
    let mut r = ByoRecovery::new(capture()).unwrap();
    let before = r.clone();
    assert!(r.bind_transport(route(), ByoTransport::WholeFile).is_err());
    assert_eq!(r, before);
    r.source_finalized(1000, "b".repeat(64)).unwrap();
    r.bind_transport(route(), ByoTransport::WholeFile).unwrap();
    let mut corrupt = r.clone();
    corrupt.source_length = None;
    corrupt.source_sha256 = None;
    assert!(corrupt.validate().is_err());
}
