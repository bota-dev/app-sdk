use bota_device_sdk_core::{
    error::ErrorCode,
    generated::protocol,
    protocol::{
        CommonHeaderV2, EncryptedUploadV2Receiver, EncryptedUploadV2ReceiverAction as Action,
        EncryptedUploadV2ReceiverCheckpoint as Checkpoint,
        EncryptedUploadV2ReceiverConfig as Config, EncryptedUploadV2ReceiverEvent as Event,
        EncryptedUploadV2Transfer, EofV2, ManifestChunkV2, MarkerChunkV2, WindowEndV2,
        decode_encrypted_upload_v2_transfer, encode_encrypted_upload_v2_transfer,
    },
};
use sha2::{Digest, Sha256};

fn hash(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

fn common(message_type: u8) -> CommonHeaderV2 {
    CommonHeaderV2 {
        message_type,
        flags: 0,
        transport_session_id: 7,
    }
}

fn config(ciphertext: &[u8], checkpoint: Checkpoint) -> Config {
    Config {
        transport_session_id: 7,
        expected_ciphertext_length: ciphertext.len() as u64,
        expected_ciphertext_sha256: hash(ciphertext),
        maximum_data_payload_bytes: 8,
        maximum_window_packets: 4,
        maximum_missing_sequences: 4,
        checkpoint,
        markers_required: false,
    }
}

fn packet(sequence: u32, offset: u64, bytes: &[u8]) -> Vec<u8> {
    encode_encrypted_upload_v2_transfer(&EncryptedUploadV2Transfer::Data {
        common: common(protocol::ENCRYPTED_UPLOAD_V2_DATA),
        sequence,
        offset,
        data: bytes,
    })
    .unwrap()
}

fn boundary(first: u32, last: u32, revision: u32, bytes: &[u8]) -> Vec<u8> {
    boundary_at(0, first, last, revision, bytes)
}

fn boundary_at(index: u32, first: u32, last: u32, revision: u32, bytes: &[u8]) -> Vec<u8> {
    encode_encrypted_upload_v2_transfer(&EncryptedUploadV2Transfer::WindowEnd(WindowEndV2 {
        common: common(protocol::ENCRYPTED_UPLOAD_V2_WINDOW_END),
        window_index: index,
        first_sequence: first,
        last_sequence: last,
        next_ciphertext_offset: bytes.len() as u64,
        prefix_sha256: hash(bytes),
        checkpoint_revision: revision,
    }))
    .unwrap()
}

fn prepare(receiver: &mut EncryptedUploadV2Receiver, bytes: &[u8]) {
    let Action::InspectSink {
        request_id,
        prefix_length,
        flush,
    } = receiver.start().unwrap()
    else {
        panic!("receiver must inspect retained prefix before truncation");
    };
    assert!(!flush);
    let action = receiver
        .apply(Event::SinkProof {
            request_id,
            byte_length: bytes.len() as u64,
            prefix_sha256: hash(&bytes[..prefix_length as usize]),
        })
        .unwrap();
    match action {
        Action::None => {}
        Action::TruncateSink { request_id, length } => {
            assert_eq!(length, prefix_length);
            assert_eq!(
                receiver.apply(Event::Applied { request_id }).unwrap(),
                Action::None
            );
        }
        _ => panic!("unexpected prepare action"),
    }
}

fn flush(receiver: &mut EncryptedUploadV2Receiver, action: Action, bytes: &[u8]) -> Action {
    let action = if let Action::AppendCiphertext { request_id, .. } = action {
        receiver.apply(Event::Applied { request_id }).unwrap()
    } else {
        action
    };
    let Action::InspectSink {
        request_id,
        prefix_length,
        flush,
    } = action
    else {
        panic!("append must be followed by synchronized prefix proof");
    };
    assert!(flush);
    receiver
        .apply(Event::SinkProof {
            request_id,
            byte_length: bytes.len() as u64,
            prefix_sha256: hash(&bytes[..prefix_length as usize]),
        })
        .unwrap()
}

fn ack(action: Action) -> (u32, u64, u32, Vec<u32>) {
    let Action::Control { frame } = action else {
        panic!("expected ACK");
    };
    let EncryptedUploadV2Transfer::WindowAck(value) =
        decode_encrypted_upload_v2_transfer(&frame).unwrap()
    else {
        panic!("expected window ACK frame");
    };
    (
        value.highest_contiguous_sequence,
        value.next_ciphertext_offset,
        value.checkpoint_revision,
        value.missing_sequences,
    )
}

fn commit(receiver: &mut EncryptedUploadV2Receiver, action: Action, ciphertext: &[u8]) -> Action {
    let action = flush(receiver, action, ciphertext);
    let Action::PersistCheckpoint {
        request_id,
        checkpoint,
    } = action
    else {
        panic!("clean window must request persistence before ACK");
    };
    assert_eq!(checkpoint.next_ciphertext_offset, ciphertext.len() as u64);
    receiver.apply(Event::Applied { request_id }).unwrap()
}

fn manifest(receiver: &mut EncryptedUploadV2Receiver, bytes: &[u8]) {
    for (index, chunk) in bytes.chunks(200).enumerate() {
        let frame = encode_encrypted_upload_v2_transfer(&EncryptedUploadV2Transfer::ManifestChunk(
            ManifestChunkV2 {
                common: common(protocol::ENCRYPTED_UPLOAD_V2_MANIFEST_CHUNK),
                total_manifest_length: bytes.len() as u16,
                chunk_offset: (index * 200) as u16,
                manifest_sha256: hash(bytes),
                chunk,
            },
        ))
        .unwrap();
        assert_eq!(receiver.receive(&frame).unwrap(), Action::None);
    }
}

fn eof(sequence: u32, ciphertext: &[u8], manifest: &[u8]) -> Vec<u8> {
    encode_encrypted_upload_v2_transfer(&EncryptedUploadV2Transfer::Eof(EofV2 {
        common: common(protocol::ENCRYPTED_UPLOAD_V2_EOF),
        final_sequence: sequence,
        block_count: 1,
        ciphertext_length: ciphertext.len() as u64,
        ciphertext_sha256: hash(ciphertext),
        manifest_sha256: hash(manifest),
    }))
    .unwrap()
}

#[test]
fn clean_window_requires_append_flush_and_exact_persistence_before_ack() {
    let ciphertext = b"abcd";
    let mut receiver =
        EncryptedUploadV2Receiver::new(config(ciphertext, Checkpoint::initial())).unwrap();
    prepare(&mut receiver, b"");
    receiver.receive(&packet(2, 2, b"cd")).unwrap();
    receiver.receive(&packet(1, 0, b"ab")).unwrap();
    let action = receiver.receive(&boundary(1, 2, 1, ciphertext)).unwrap();
    assert!(
        matches!(&action, Action::AppendCiphertext { offset: 0, bytes, .. } if bytes == ciphertext)
    );
    assert_eq!(receiver.checkpoint().revision, 0);
    let action = flush(&mut receiver, action, ciphertext);
    let Action::PersistCheckpoint {
        request_id,
        checkpoint,
    } = action
    else {
        panic!();
    };
    assert_eq!(checkpoint.revision, 1);
    assert_eq!(receiver.checkpoint().revision, 0);
    assert_eq!(
        receiver
            .apply(Event::Applied {
                request_id: request_id + 1
            })
            .unwrap_err()
            .code,
        ErrorCode::UnexpectedEvent
    );
    let action = receiver.apply(Event::Applied { request_id }).unwrap();
    assert_eq!(ack(action), (2, 4, 1, vec![]));
    assert_eq!(receiver.checkpoint().revision, 1);
    assert_eq!(
        ack(receiver.receive(&boundary(1, 2, 1, ciphertext)).unwrap()),
        (2, 4, 1, vec![])
    );
}

#[test]
fn missing_repair_proves_contiguous_prefix_without_advancing_checkpoint() {
    let ciphertext = b"abcdef";
    let mut receiver =
        EncryptedUploadV2Receiver::new(config(ciphertext, Checkpoint::initial())).unwrap();
    prepare(&mut receiver, b"");
    receiver.receive(&packet(3, 4, b"ef")).unwrap();
    receiver.receive(&packet(1, 0, b"ab")).unwrap();
    let action = receiver.receive(&boundary(1, 3, 1, ciphertext)).unwrap();
    let action = flush(&mut receiver, action, b"ab");
    assert_eq!(ack(action), (1, 2, 0, vec![2]));
    assert_eq!(receiver.checkpoint(), &Checkpoint::initial());
    receiver.receive(&packet(1, 0, b"ab")).unwrap();
    receiver.receive(&packet(2, 2, b"cd")).unwrap();
    let action = receiver.receive(&boundary(1, 3, 1, ciphertext)).unwrap();
    assert!(
        matches!(&action, Action::AppendCiphertext { offset: 2, bytes, .. } if bytes == b"cdef")
    );
    assert_eq!(
        ack(commit(&mut receiver, action, ciphertext)),
        (3, 6, 1, vec![])
    );
}

#[test]
fn complete_resume_uses_current_attempt_eof_zero_and_exact_final_evidence() {
    let ciphertext = b"abcd";
    let saved = Checkpoint {
        revision: 9,
        next_ciphertext_offset: 4,
        prefix_sha256: hash(ciphertext),
        highest_contiguous_sequence: Some(200),
    };
    let mut receiver = EncryptedUploadV2Receiver::new(config(ciphertext, saved)).unwrap();
    prepare(&mut receiver, ciphertext);
    let document = vec![3; protocol::UPLOAD_MANIFEST_V2_FIXED_LENGTH];
    manifest(&mut receiver, &document);
    let action = receiver.receive(&eof(0, ciphertext, &document)).unwrap();
    let action = flush(&mut receiver, action, ciphertext);
    let Action::Complete {
        manifest, evidence, ..
    } = action
    else {
        panic!();
    };
    assert_eq!(manifest, document);
    assert_eq!(evidence.ciphertext_length, 4);
    assert_eq!(evidence.manifest_sha256, hash(&document));
    assert_eq!(
        receiver
            .receive(&eof(0, ciphertext, &document))
            .unwrap_err()
            .code,
        ErrorCode::UnexpectedEvent
    );
}

#[test]
fn partial_resume_starts_sequence_one_independent_of_saved_history() {
    let ciphertext = b"abcdef";
    let saved = Checkpoint {
        revision: 9,
        next_ciphertext_offset: 4,
        prefix_sha256: hash(b"abcd"),
        highest_contiguous_sequence: Some(200),
    };
    let mut receiver = EncryptedUploadV2Receiver::new(config(ciphertext, saved)).unwrap();
    prepare(&mut receiver, b"abcdUNACKNOWLEDGED");
    receiver.receive(&packet(1, 4, b"ef")).unwrap();
    let action = receiver.receive(&boundary(1, 1, 10, ciphertext)).unwrap();
    assert_eq!(
        ack(commit(&mut receiver, action, ciphertext)),
        (1, 6, 10, vec![])
    );
}

#[test]
fn cancel_rejects_late_io_before_mutating_checkpoint() {
    let mut receiver =
        EncryptedUploadV2Receiver::new(config(b"ab", Checkpoint::initial())).unwrap();
    prepare(&mut receiver, b"");
    receiver.receive(&packet(1, 0, b"ab")).unwrap();
    let action = receiver.receive(&boundary(1, 1, 1, b"ab")).unwrap();
    let Action::PersistCheckpoint { request_id, .. } = flush(&mut receiver, action, b"ab") else {
        panic!();
    };
    receiver.cancel();
    assert_eq!(
        receiver
            .apply(Event::Applied { request_id })
            .unwrap_err()
            .code,
        ErrorCode::Cancelled
    );
    assert_eq!(receiver.checkpoint().revision, 0);
}

#[test]
fn corrupt_retained_prefix_never_requests_truncation() {
    let saved = Checkpoint {
        revision: 1,
        next_ciphertext_offset: 2,
        prefix_sha256: hash(b"ab"),
        highest_contiguous_sequence: Some(1),
    };
    let mut receiver = EncryptedUploadV2Receiver::new(config(b"abcd", saved)).unwrap();
    let Action::InspectSink { request_id, .. } = receiver.start().unwrap() else {
        panic!();
    };
    assert_eq!(
        receiver
            .apply(Event::SinkProof {
                request_id,
                byte_length: 4,
                prefix_sha256: hash(b"XX")
            })
            .unwrap_err()
            .code,
        ErrorCode::IntegrityFailed
    );
}

#[test]
fn invalid_configuration_rejects_unusable_wire_and_checkpoint_bounds() {
    let valid = config(b"abcd", Checkpoint::initial());
    let mut invalid = Vec::new();
    let mut value = valid.clone();
    value.transport_session_id = 0;
    invalid.push(value);
    let mut value = valid.clone();
    value.expected_ciphertext_length = 0;
    invalid.push(value);
    let mut value = valid.clone();
    value.maximum_data_payload_bytes = 0;
    invalid.push(value);
    let mut value = valid.clone();
    value.maximum_data_payload_bytes = u16::MAX;
    invalid.push(value);
    let mut value = valid.clone();
    value.maximum_window_packets = 0;
    invalid.push(value);
    let mut value = valid.clone();
    value.maximum_missing_sequences = 0;
    invalid.push(value);
    let mut value = valid.clone();
    value.maximum_missing_sequences = u16::MAX;
    invalid.push(value);
    let mut value = valid.clone();
    value.checkpoint.revision = 1;
    invalid.push(value);
    let mut value = valid.clone();
    value.checkpoint.next_ciphertext_offset = 5;
    invalid.push(value);
    let mut value = valid.clone();
    value.checkpoint.highest_contiguous_sequence = Some(1);
    invalid.push(value);
    let mut value = valid;
    value.checkpoint.prefix_sha256 = [0; 32];
    invalid.push(value);
    for value in invalid {
        assert_eq!(
            EncryptedUploadV2Receiver::new(value).unwrap_err().code,
            ErrorCode::InvalidInput
        );
    }
}

#[test]
fn data_duplicates_are_exact_and_do_not_append_before_window_boundary() {
    let mut receiver =
        EncryptedUploadV2Receiver::new(config(b"abcd", Checkpoint::initial())).unwrap();
    prepare(&mut receiver, b"");
    assert_eq!(
        receiver.receive(&packet(1, 0, b"ab")).unwrap(),
        Action::None
    );
    assert_eq!(
        receiver.receive(&packet(1, 0, b"ab")).unwrap(),
        Action::None
    );
    assert_eq!(
        receiver.receive(&packet(1, 0, b"XX")).unwrap_err().code,
        ErrorCode::IntegrityFailed
    );
    assert!(receiver.is_terminal());
}

#[test]
fn data_bounds_overlap_and_foreign_sessions_fail_closed() {
    let mut overflowing = packet(1, 0, b"ab");
    let offset = protocol::ENCRYPTED_UPLOAD_V2_DATA_CIPHERTEXT_OFFSET_OFFSET;
    overflowing[offset..offset + 8].copy_from_slice(&u64::MAX.to_le_bytes());
    for frame in [
        packet(0, 0, b"a"),
        packet(5, 0, b"a"),
        packet(1, 0, b"123456789"),
        packet(1, 9, b"abc"),
        overflowing,
    ] {
        let mut receiver =
            EncryptedUploadV2Receiver::new(config(b"abcdefghij", Checkpoint::initial())).unwrap();
        prepare(&mut receiver, b"");
        assert!(receiver.receive(&frame).is_err());
        assert!(receiver.is_terminal());
    }
    let mut receiver =
        EncryptedUploadV2Receiver::new(config(b"abcd", Checkpoint::initial())).unwrap();
    prepare(&mut receiver, b"");
    receiver.receive(&packet(1, 0, b"ab")).unwrap();
    assert_eq!(
        receiver.receive(&packet(2, 1, b"bc")).unwrap_err().code,
        ErrorCode::PayloadTooLarge
    );
    let mut receiver =
        EncryptedUploadV2Receiver::new(config(b"abcd", Checkpoint::initial())).unwrap();
    prepare(&mut receiver, b"");
    let mut foreign = packet(1, 0, b"ab");
    foreign[4] = 8;
    assert_eq!(
        receiver.receive(&foreign).unwrap_err().code,
        ErrorCode::IdentityMismatch
    );
}

#[test]
fn repair_boundary_identity_cannot_change_and_unrequested_data_is_rejected() {
    for change in [false, true] {
        let mut receiver =
            EncryptedUploadV2Receiver::new(config(b"abcdef", Checkpoint::initial())).unwrap();
        prepare(&mut receiver, b"");
        receiver.receive(&packet(1, 0, b"ab")).unwrap();
        let action = receiver.receive(&boundary(1, 2, 1, b"abcd")).unwrap();
        assert_eq!(ack(flush(&mut receiver, action, b"ab")), (1, 2, 0, vec![2]));
        let error = if change {
            receiver.receive(&boundary(1, 2, 2, b"abcd")).unwrap_err()
        } else {
            receiver.receive(&packet(3, 4, b"ef")).unwrap_err()
        };
        assert_eq!(error.code, ErrorCode::ProtocolRejected);
        assert_eq!(receiver.checkpoint().revision, 0);
    }
}

#[test]
fn clean_window_bad_prefix_proof_cannot_request_persistence_or_ack() {
    let mut receiver =
        EncryptedUploadV2Receiver::new(config(b"ab", Checkpoint::initial())).unwrap();
    prepare(&mut receiver, b"");
    receiver.receive(&packet(1, 0, b"ab")).unwrap();
    let Action::AppendCiphertext { request_id, .. } =
        receiver.receive(&boundary(1, 1, 1, b"ab")).unwrap()
    else {
        panic!();
    };
    let Action::InspectSink { request_id, .. } =
        receiver.apply(Event::Applied { request_id }).unwrap()
    else {
        panic!();
    };
    assert_eq!(
        receiver
            .apply(Event::SinkProof {
                request_id,
                byte_length: 2,
                prefix_sha256: hash(b"XX")
            })
            .unwrap_err()
            .code,
        ErrorCode::IntegrityFailed
    );
    assert_eq!(receiver.checkpoint().revision, 0);
}

#[test]
fn missing_limit_and_noncontiguous_complete_offsets_are_rejected() {
    let mut limited = config(b"abcdef", Checkpoint::initial());
    limited.maximum_missing_sequences = 1;
    let mut receiver = EncryptedUploadV2Receiver::new(limited).unwrap();
    prepare(&mut receiver, b"");
    receiver.receive(&packet(1, 0, b"ab")).unwrap();
    assert_eq!(
        receiver
            .receive(&boundary(1, 3, 1, b"abcdef"))
            .unwrap_err()
            .code,
        ErrorCode::PayloadTooLarge
    );
    let mut receiver =
        EncryptedUploadV2Receiver::new(config(b"abcdef", Checkpoint::initial())).unwrap();
    prepare(&mut receiver, b"");
    receiver.receive(&packet(1, 0, b"ab")).unwrap();
    receiver.receive(&packet(2, 3, b"def")).unwrap();
    assert_eq!(
        receiver
            .receive(&boundary(1, 2, 1, b"abcdef"))
            .unwrap_err()
            .code,
        ErrorCode::IntegrityFailed
    );
}

#[test]
fn no_contiguous_data_repair_uses_previous_verified_prefix_and_sequence_zero() {
    let mut receiver =
        EncryptedUploadV2Receiver::new(config(b"abcd", Checkpoint::initial())).unwrap();
    prepare(&mut receiver, b"");
    receiver.receive(&packet(2, 2, b"cd")).unwrap();
    let action = receiver.receive(&boundary(1, 2, 1, b"abcd")).unwrap();
    assert_eq!(ack(flush(&mut receiver, action, b"")), (0, 0, 0, vec![1]));
}

#[test]
fn persistence_failure_and_wrong_io_result_never_advance_checkpoint() {
    for failed in [false, true] {
        let mut receiver =
            EncryptedUploadV2Receiver::new(config(b"ab", Checkpoint::initial())).unwrap();
        prepare(&mut receiver, b"");
        receiver.receive(&packet(1, 0, b"ab")).unwrap();
        let action = receiver.receive(&boundary(1, 1, 1, b"ab")).unwrap();
        let Action::PersistCheckpoint { request_id, .. } = flush(&mut receiver, action, b"ab")
        else {
            panic!();
        };
        let event = if failed {
            Event::Failed {
                request_id,
                error: bota_device_sdk_core::error::DeviceSdkError::new(
                    ErrorCode::PersistenceFailed,
                    bota_device_sdk_core::error::Operation::TransferRecording,
                    true,
                ),
            }
        } else {
            Event::SinkProof {
                request_id,
                byte_length: 2,
                prefix_sha256: hash(b"ab"),
            }
        };
        assert!(receiver.apply(event).is_err());
        assert_eq!(receiver.checkpoint().revision, 0);
        assert!(receiver.is_terminal());
    }
}

#[test]
fn manifest_requires_durable_audio_and_rejects_conflicting_overlap() {
    let document = vec![3; protocol::UPLOAD_MANIFEST_V2_FIXED_LENGTH];
    let chunk = |offset, bytes: &[u8]| {
        encode_encrypted_upload_v2_transfer(&EncryptedUploadV2Transfer::ManifestChunk(
            ManifestChunkV2 {
                common: common(protocol::ENCRYPTED_UPLOAD_V2_MANIFEST_CHUNK),
                total_manifest_length: document.len() as u16,
                chunk_offset: offset,
                manifest_sha256: hash(&document),
                chunk: bytes,
            },
        ))
        .unwrap()
    };
    let mut receiver =
        EncryptedUploadV2Receiver::new(config(b"ab", Checkpoint::initial())).unwrap();
    prepare(&mut receiver, b"");
    assert_eq!(
        receiver
            .receive(&chunk(0, &document[..20]))
            .unwrap_err()
            .code,
        ErrorCode::ProtocolRejected
    );
    let saved = Checkpoint {
        revision: 1,
        next_ciphertext_offset: 2,
        prefix_sha256: hash(b"ab"),
        highest_contiguous_sequence: Some(1),
    };
    let mut receiver = EncryptedUploadV2Receiver::new(config(b"ab", saved)).unwrap();
    prepare(&mut receiver, b"ab");
    assert_eq!(
        receiver.receive(&chunk(0, &document[..20])).unwrap(),
        Action::None
    );
    assert_eq!(
        receiver.receive(&chunk(0, &document[..20])).unwrap(),
        Action::None
    );
    assert_eq!(
        receiver.receive(&chunk(1, b"X")).unwrap_err().code,
        ErrorCode::IntegrityFailed
    );
}

#[test]
fn eof_rejects_saved_attempt_sequence_incomplete_manifest_and_corrupt_final_sink() {
    let document = vec![3; protocol::UPLOAD_MANIFEST_V2_FIXED_LENGTH];
    for mode in 0..3 {
        let saved = Checkpoint {
            revision: 1,
            next_ciphertext_offset: 2,
            prefix_sha256: hash(b"ab"),
            highest_contiguous_sequence: Some(99),
        };
        let mut receiver = EncryptedUploadV2Receiver::new(config(b"ab", saved)).unwrap();
        prepare(&mut receiver, b"ab");
        if mode != 1 {
            manifest(&mut receiver, &document);
        }
        if mode == 2 {
            let Action::InspectSink { request_id, .. } =
                receiver.receive(&eof(0, b"ab", &document)).unwrap()
            else {
                panic!();
            };
            assert_eq!(
                receiver
                    .apply(Event::SinkProof {
                        request_id,
                        byte_length: 2,
                        prefix_sha256: hash(b"XX")
                    })
                    .unwrap_err()
                    .code,
                ErrorCode::IntegrityFailed
            );
        } else {
            assert_eq!(
                receiver
                    .receive(&eof(if mode == 0 { 99 } else { 0 }, b"ab", &document))
                    .unwrap_err()
                    .code,
                ErrorCode::IntegrityFailed
            );
        }
    }
}

#[test]
fn serializable_actions_events_and_configuration_round_trip() {
    let config = config(b"ab", Checkpoint::initial());
    let value = serde_json::to_vec(&config).unwrap();
    assert_eq!(serde_json::from_slice::<Config>(&value).unwrap(), config);
    let mut receiver = EncryptedUploadV2Receiver::new(config).unwrap();
    let action = receiver.start().unwrap();
    let value = serde_json::to_vec(&action).unwrap();
    assert_eq!(serde_json::from_slice::<Action>(&value).unwrap(), action);
    let event = Event::SinkProof {
        request_id: 1,
        byte_length: 0,
        prefix_sha256: hash(b""),
    };
    let value = serde_json::to_vec(&event).unwrap();
    assert_eq!(serde_json::from_slice::<Event>(&value).unwrap(), event);
}

#[test]
fn sequence_continues_across_windows_and_delayed_exact_ack_does_not_discard_new_data() {
    let mut receiver =
        EncryptedUploadV2Receiver::new(config(b"abcd", Checkpoint::initial())).unwrap();
    prepare(&mut receiver, b"");
    receiver.receive(&packet(1, 0, b"ab")).unwrap();
    let action = receiver.receive(&boundary(1, 1, 1, b"ab")).unwrap();
    assert_eq!(ack(commit(&mut receiver, action, b"ab")), (1, 2, 1, vec![]));
    receiver.receive(&packet(2, 2, b"cd")).unwrap();
    assert_eq!(
        ack(receiver.receive(&boundary(1, 1, 1, b"ab")).unwrap()),
        (1, 2, 1, vec![])
    );
    assert_eq!(
        receiver.receive(&packet(1, 0, b"ab")).unwrap(),
        Action::None
    );
    let action = receiver.receive(&boundary_at(1, 2, 2, 2, b"abcd")).unwrap();
    assert!(matches!(&action, Action::AppendCiphertext { offset: 2, bytes, .. } if bytes == b"cd"));
    assert_eq!(
        ack(commit(&mut receiver, action, b"abcd")),
        (2, 4, 2, vec![])
    );
}

#[test]
fn manifest_out_of_order_fragments_require_one_exact_digest_and_full_coverage() {
    let document = vec![3; protocol::UPLOAD_MANIFEST_V2_FIXED_LENGTH];
    let saved = Checkpoint {
        revision: 1,
        next_ciphertext_offset: 2,
        prefix_sha256: hash(b"ab"),
        highest_contiguous_sequence: Some(1),
    };
    let mut receiver = EncryptedUploadV2Receiver::new(config(b"ab", saved)).unwrap();
    prepare(&mut receiver, b"ab");
    for offset in [400, 0, 200] {
        let end = (offset + 200).min(document.len());
        let frame = encode_encrypted_upload_v2_transfer(&EncryptedUploadV2Transfer::ManifestChunk(
            ManifestChunkV2 {
                common: common(protocol::ENCRYPTED_UPLOAD_V2_MANIFEST_CHUNK),
                total_manifest_length: document.len() as u16,
                chunk_offset: offset as u16,
                manifest_sha256: hash(&document),
                chunk: &document[offset..end],
            },
        ))
        .unwrap();
        receiver.receive(&frame).unwrap();
    }
    let action = receiver.receive(&eof(0, b"ab", &document)).unwrap();
    assert!(matches!(
        flush(&mut receiver, action, b"ab"),
        Action::Complete { .. }
    ));
}

#[test]
fn device_numeric_rejection_is_preserved_and_mixed_profile_packet_is_terminal() {
    let mut receiver =
        EncryptedUploadV2Receiver::new(config(b"ab", Checkpoint::initial())).unwrap();
    prepare(&mut receiver, b"");
    let frame = encode_encrypted_upload_v2_transfer(&EncryptedUploadV2Transfer::Error {
        common: common(protocol::ENCRYPTED_UPLOAD_V2_ERROR),
        result: 0x1234,
        failed_message_type: protocol::ENCRYPTED_UPLOAD_V2_START,
        checkpoint_revision: 0,
    })
    .unwrap();
    let error = receiver.receive(&frame).unwrap_err();
    assert_eq!(error.code, ErrorCode::ProtocolRejected);
    assert_eq!(error.protocol_status, Some(0x1234));
    let mut receiver =
        EncryptedUploadV2Receiver::new(config(b"ab", Checkpoint::initial())).unwrap();
    prepare(&mut receiver, b"");
    assert!(receiver.receive(&[1, 2, 3]).is_err());
    assert!(receiver.is_terminal());
}

#[test]
fn packet_backlog_is_bounded_even_if_capability_window_limit_is_large() {
    let payload_bytes = protocol::MAX_MTU - protocol::ENCRYPTED_UPLOAD_V2_DATA_MINIMUM_LENGTH;
    let bytes = vec![7; payload_bytes];
    let mut options = config(b"ab", Checkpoint::initial());
    options.expected_ciphertext_length = 2 * 1024 * 1024;
    options.maximum_data_payload_bytes = payload_bytes as u16;
    options.maximum_window_packets = u16::MAX;
    let mut receiver = EncryptedUploadV2Receiver::new(options).unwrap();
    prepare(&mut receiver, b"");
    let mut rejected = false;
    for sequence in 1..=3000 {
        let frame = packet(
            sequence,
            u64::from(sequence - 1) * payload_bytes as u64,
            &bytes,
        );
        if let Err(error) = receiver.receive(&frame) {
            assert_eq!(error.code, ErrorCode::PayloadTooLarge);
            rejected = true;
            break;
        }
    }
    assert!(
        rejected,
        "receiver must bound RAM independently of peer capability limits"
    );
}

fn marked_receiver() -> EncryptedUploadV2Receiver {
    let saved = Checkpoint {
        revision: 1,
        next_ciphertext_offset: 2,
        prefix_sha256: hash(b"ab"),
        highest_contiguous_sequence: Some(99),
    };
    let mut options = config(b"ab", saved);
    options.markers_required = true;
    let mut receiver = EncryptedUploadV2Receiver::new(options).unwrap();
    prepare(&mut receiver, b"ab");
    manifest(
        &mut receiver,
        &vec![3; protocol::UPLOAD_MANIFEST_V2_FIXED_LENGTH],
    );
    receiver
}

fn marker_document(index: u32, context: u8) -> Vec<u8> {
    let length = if index == 0 {
        protocol::RECORDING_MARKER_SEAL_LENGTH
    } else {
        402
    };
    let kind = if index == 0 {
        protocol::RECORDING_MARKER_SEAL
    } else {
        protocol::RECORDING_MARKER_PAGE
    };
    let mut bytes = vec![7; length];
    bytes[..8].copy_from_slice(protocol::RECORDING_MARKER_MAGIC);
    bytes[8..10].copy_from_slice(&1u16.to_le_bytes());
    bytes[10..12].copy_from_slice(&kind.to_le_bytes());
    bytes[12..16].copy_from_slice(&(length as u32).to_le_bytes());
    bytes[16..20].copy_from_slice(&(index + 1).to_le_bytes());
    bytes[32..64].fill(context);
    bytes
}

fn marker_chunk(index: u32, count: u32, offset: u16, document: &[u8], chunk: &[u8]) -> Vec<u8> {
    encode_encrypted_upload_v2_transfer(&EncryptedUploadV2Transfer::MarkerChunk(MarkerChunkV2 {
        common: common(protocol::ENCRYPTED_UPLOAD_V2_MARKER_CHUNK),
        document_index: index,
        document_count: count,
        chunk_offset: offset,
        document_length: document.len() as u16,
        document_sha256: hash(document),
        chunk,
    }))
    .unwrap()
}

#[test]
fn marked_batch_uses_shared_assembler_and_per_document_durability_before_eof() {
    let mut receiver = marked_receiver();
    let seal = marker_document(0, 2);
    let page = marker_document(1, 2);
    for (index, document) in [&seal, &page].into_iter().enumerate() {
        for (fragment, bytes) in document.chunks(13).enumerate() {
            let frame = marker_chunk(index as u32, 2, (fragment * 13) as u16, document, bytes);
            let action = receiver.receive(&frame).unwrap();
            if (fragment + 1) * 13 < document.len() {
                assert_eq!(action, Action::None);
                // The shared assembler accepts exact repeated fragments both
                // before and after the 64-byte opaque header is available.
                assert_eq!(receiver.receive(&frame).unwrap(), Action::None);
            } else {
                let Action::AppendMarkerDocument {
                    request_id,
                    document_index,
                    document: retained,
                    ..
                } = action
                else {
                    panic!();
                };
                assert_eq!(document_index, index as u32);
                assert_eq!(&retained, document);
                assert_eq!(
                    receiver
                        .apply(Event::Applied {
                            request_id: request_id + 1
                        })
                        .unwrap_err()
                        .code,
                    ErrorCode::UnexpectedEvent
                );
                assert_eq!(
                    receiver.apply(Event::Applied { request_id }).unwrap(),
                    Action::None
                );
            }
        }
    }
    let document = vec![3; protocol::UPLOAD_MANIFEST_V2_FIXED_LENGTH];
    let action = receiver.receive(&eof(0, b"ab", &document)).unwrap();
    let Action::Complete {
        marker_evidence: Some(evidence),
        ..
    } = flush(&mut receiver, action, b"ab")
    else {
        panic!();
    };
    assert_eq!(evidence.document_count, 2);
    assert_eq!(evidence.documents_sha256, hash(&[seal, page].concat()));
}

#[test]
fn marked_eof_rejects_missing_documents_and_mixed_contexts() {
    let mut receiver = marked_receiver();
    let document = vec![3; protocol::UPLOAD_MANIFEST_V2_FIXED_LENGTH];
    assert_eq!(
        receiver
            .receive(&eof(0, b"ab", &document))
            .unwrap_err()
            .code,
        ErrorCode::IntegrityFailed
    );
    let mut receiver = marked_receiver();
    let seal = marker_document(0, 2);
    let Action::AppendMarkerDocument { request_id, .. } = receiver
        .receive(&marker_chunk(0, 2, 0, &seal, &seal))
        .unwrap()
    else {
        panic!();
    };
    receiver.apply(Event::Applied { request_id }).unwrap();
    let page = marker_document(1, 3);
    assert_eq!(
        receiver
            .receive(&marker_chunk(1, 2, 0, &page, &page))
            .unwrap_err()
            .code,
        ErrorCode::IdentityMismatch
    );
}

#[test]
fn marker_fragment_order_digest_and_metadata_conflicts_fail_closed() {
    let seal = marker_document(0, 2);
    for mode in 0..4 {
        let mut receiver = marked_receiver();
        let frame = match mode {
            0 => marker_chunk(1, 2, 0, &seal, &seal),
            1 => marker_chunk(0, 2, 1, &seal, &seal[1..]),
            2 => {
                let mut corrupt = seal.clone();
                corrupt[100] ^= 1;
                marker_chunk(0, 2, 0, &seal, &corrupt)
            }
            _ => {
                receiver
                    .receive(&marker_chunk(0, 2, 0, &seal, &seal[..20]))
                    .unwrap();
                marker_chunk(0, 3, 20, &seal, &seal[20..])
            }
        };
        assert!(receiver.receive(&frame).is_err());
        assert!(receiver.is_terminal());
    }
}

#[test]
fn marker_persistence_cancel_rejects_late_applied_before_ordered_digest_update() {
    let mut receiver = marked_receiver();
    let seal = marker_document(0, 2);
    let Action::AppendMarkerDocument { request_id, .. } = receiver
        .receive(&marker_chunk(0, 2, 0, &seal, &seal))
        .unwrap()
    else {
        panic!();
    };
    receiver.cancel();
    assert_eq!(
        receiver
            .apply(Event::Applied { request_id })
            .unwrap_err()
            .code,
        ErrorCode::Cancelled
    );
}

#[test]
fn full_supported_marker_count_keeps_each_serialized_action_bounded() {
    let mut receiver = marked_receiver();
    let mut expected_hash = Sha256::new();
    for index in 0..4097 {
        let document = marker_document(index, 2);
        expected_hash.update(&document);
        let action = receiver
            .receive(&marker_chunk(index, 4097, 0, &document, &document))
            .unwrap();
        assert!(serde_json::to_vec(&action).unwrap().len() < 1024 * 1024);
        let Action::AppendMarkerDocument { request_id, .. } = action else {
            panic!();
        };
        assert_eq!(
            receiver.apply(Event::Applied { request_id }).unwrap(),
            Action::None
        );
    }
    let document = vec![3; protocol::UPLOAD_MANIFEST_V2_FIXED_LENGTH];
    let action = receiver.receive(&eof(0, b"ab", &document)).unwrap();
    let Action::Complete {
        marker_evidence: Some(evidence),
        ..
    } = flush(&mut receiver, action, b"ab")
    else {
        panic!();
    };
    assert_eq!(evidence.document_count, 4097);
    assert_eq!(
        evidence.documents_sha256,
        <[u8; 32]>::from(expected_hash.finalize())
    );
}

#[test]
fn large_window_appends_are_split_before_hash_and_checkpoint_requests() {
    let ciphertext = vec![7; 128 * 1024];
    let mut options = config(&ciphertext, Checkpoint::initial());
    options.maximum_data_payload_bytes = 400;
    options.maximum_window_packets = 400;
    let mut receiver = EncryptedUploadV2Receiver::new(options).unwrap();
    prepare(&mut receiver, b"");
    for (index, bytes) in ciphertext.chunks(400).enumerate() {
        receiver
            .receive(&packet(index as u32 + 1, (index * 400) as u64, bytes))
            .unwrap();
    }
    let last_sequence = ciphertext.len().div_ceil(400) as u32;
    let mut action = receiver
        .receive(&boundary(1, last_sequence, 1, &ciphertext))
        .unwrap();
    let mut written = Vec::new();
    while let Action::AppendCiphertext {
        request_id,
        offset,
        bytes,
    } = action
    {
        assert!(bytes.len() <= 64 * 1024);
        assert_eq!(offset, written.len() as u64);
        written.extend_from_slice(&bytes);
        action = receiver.apply(Event::Applied { request_id }).unwrap();
    }
    assert_eq!(written, ciphertext);
    let Action::PersistCheckpoint { request_id, .. } = flush(&mut receiver, action, &ciphertext)
    else {
        panic!();
    };
    assert_eq!(
        ack(receiver.apply(Event::Applied { request_id }).unwrap()),
        (last_sequence, ciphertext.len() as u64, 1, vec![])
    );
}

#[test]
fn unmarked_configuration_default_rejects_marker_extension_without_admission() {
    let saved = Checkpoint {
        revision: 1,
        next_ciphertext_offset: 2,
        prefix_sha256: hash(b"ab"),
        highest_contiguous_sequence: Some(99),
    };
    let options = config(b"ab", saved);
    let mut json = serde_json::to_value(&options).unwrap();
    json.as_object_mut().unwrap().remove("markers_required");
    let restored: Config = serde_json::from_value(json).unwrap();
    assert!(!restored.markers_required);
    let mut receiver = EncryptedUploadV2Receiver::new(restored).unwrap();
    prepare(&mut receiver, b"ab");
    manifest(
        &mut receiver,
        &vec![3; protocol::UPLOAD_MANIFEST_V2_FIXED_LENGTH],
    );
    let seal = marker_document(0, 2);
    assert_eq!(
        receiver
            .receive(&marker_chunk(0, 2, 0, &seal, &seal))
            .unwrap_err()
            .code,
        ErrorCode::ProtocolRejected
    );
}

#[test]
fn marker_shared_header_kind_and_document_count_bounds_cannot_be_bypassed() {
    for count in [1u32, 4098] {
        let mut receiver = marked_receiver();
        let seal = marker_document(0, 2);
        let mut frame = marker_chunk(0, 2, 0, &seal, &seal);
        frame[16..20].copy_from_slice(&count.to_le_bytes());
        assert!(receiver.receive(&frame).is_err());
    }
    let mut receiver = marked_receiver();
    let page = marker_document(1, 2);
    assert_eq!(
        receiver
            .receive(&marker_chunk(0, 2, 0, &page, &page))
            .unwrap_err()
            .code,
        ErrorCode::InvalidInput
    );
}
