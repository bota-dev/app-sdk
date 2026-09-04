use bota_device_sdk_core::{
    error::ErrorCode,
    protocol::{
        EncryptedUploadV2SignedBlob, EncryptedUploadV2Transfer, SignedBlobAssemblerV2,
        decode_encrypted_upload_v2_capabilities, decode_encrypted_upload_v2_signed_blob,
        decode_encrypted_upload_v2_status, decode_encrypted_upload_v2_transfer,
        encode_encrypted_upload_v2_signed_blob, encode_encrypted_upload_v2_transfer,
    },
};
use sha2::{Digest, Sha256};

#[derive(Clone, Copy)]
enum FixedFrameKind {
    Capability,
    SignedBlob,
    Transfer,
    Status,
}

#[test]
fn fixed_frames_reject_every_truncation_and_one_byte_extension() {
    for (name, kind, valid) in valid_fixed_frames() {
        for end in 0..valid.len() {
            assert!(
                decode_fixed_frame(kind, &valid[..end]).is_err(),
                "{name} accepted truncation at {end}"
            );
        }
        let mut extended = valid.clone();
        extended.push(0);
        assert!(
            decode_fixed_frame(kind, &extended).is_err(),
            "{name} accepted a trailing byte"
        );
        decode_fixed_frame(kind, &valid)
            .unwrap_or_else(|error| panic!("{name} rejected its valid fixed frame: {error}"));
    }
}

#[test]
fn fixed_signed_blob_and_transfer_frames_round_trip_exactly() {
    for (name, kind, valid) in valid_fixed_frames() {
        let encoded = match kind {
            FixedFrameKind::SignedBlob => {
                let decoded = decode_encrypted_upload_v2_signed_blob(&valid).unwrap();
                encode_encrypted_upload_v2_signed_blob(&decoded).unwrap()
            }
            FixedFrameKind::Transfer => {
                let decoded = decode_encrypted_upload_v2_transfer(&valid).unwrap();
                encode_encrypted_upload_v2_transfer(&decoded).unwrap()
            }
            FixedFrameKind::Capability | FixedFrameKind::Status => continue,
        };
        assert_eq!(encoded, valid, "{name} did not round-trip exactly");
    }
}

#[test]
fn reserved_bytes_and_unknown_critical_bits_are_rejected() {
    let mut capability = valid_capability();
    capability[22] = 1;
    assert_noncanonical(decode_encrypted_upload_v2_capabilities(&capability));

    let mut capability = valid_capability();
    capability[4..8].copy_from_slice(&0x100_u32.to_le_bytes());
    assert_noncanonical(decode_encrypted_upload_v2_capabilities(&capability));

    let mut abort = valid_transfer(16, 0x24);
    abort[14] = 1;
    assert_noncanonical(decode_encrypted_upload_v2_transfer(&abort));

    let mut abort = valid_transfer(16, 0x24);
    abort[2] = 1;
    assert_noncanonical(decode_encrypted_upload_v2_transfer(&abort));
}

#[test]
fn nonzero_fields_decode_at_the_frozen_offsets_and_little_endian_widths() {
    let capabilities = decode_encrypted_upload_v2_capabilities(&valid_capability()).unwrap();
    assert_eq!(capabilities.flags, 0x7f);
    assert_eq!(capabilities.maximum_signed_blob_bytes, 1024);
    assert_eq!(capabilities.maximum_manifest_bytes, 1024);
    assert_eq!(capabilities.maximum_data_payload_bytes, 100);
    assert_eq!(capabilities.maximum_window_packets, 4);
    assert_eq!(capabilities.durable_checkpoint_interval_blocks, 8);
    assert_eq!(capabilities.maximum_missing_sequences, 4);

    let mut start = valid_start();
    start[4..12].copy_from_slice(&0x0102_0304_0506_0708_u64.to_le_bytes());
    start[12..28].copy_from_slice(&[0x11; 16]);
    start[28..44].copy_from_slice(&[0x22; 16]);
    start[44..48].copy_from_slice(&0x3344_5566_u32.to_le_bytes());
    start[48..80].copy_from_slice(&[0x77; 32]);
    start[80..84].copy_from_slice(&0x8899_aabb_u32.to_le_bytes());
    start[84..92].copy_from_slice(&0x0102_0304_0506_0708_u64.to_le_bytes());
    start[92..124].copy_from_slice(&[0xcc; 32]);
    let EncryptedUploadV2Transfer::Start(decoded) =
        decode_encrypted_upload_v2_transfer(&start).unwrap()
    else {
        panic!("START decoded as another variant");
    };
    assert_eq!(decoded.common.transport_session_id, 0x0102_0304_0506_0708);
    assert_eq!(decoded.upload_session_uuid, [0x11; 16]);
    assert_eq!(decoded.recording_uuid, [0x22; 16]);
    assert_eq!(decoded.recording_generation, 0x3344_5566);
    assert_eq!(decoded.authorization_sha256, [0x77; 32]);
    assert_eq!(decoded.checkpoint_revision, 0x8899_aabb);
    assert_eq!(decoded.next_ciphertext_offset, 0x0102_0304_0506_0708);
    assert_eq!(decoded.prefix_sha256, [0xcc; 32]);
    assert_eq!(decoded.window_packets, 4);
    assert_eq!(decoded.data_payload_bytes, 100);

    let mut status = valid_status();
    status[1] = 0xfe;
    status[2..4].copy_from_slice(&0x1234_u16.to_le_bytes());
    status[4..12].copy_from_slice(&9_u64.to_le_bytes());
    status[12..20].copy_from_slice(&0x0102_0304_0506_0708_u64.to_le_bytes());
    status[20] = 57;
    status[21] = 3;
    let decoded = decode_encrypted_upload_v2_status(&status).unwrap();
    assert_eq!(decoded.phase, 0xfe);
    assert_eq!(decoded.result, 0x1234);
    assert_eq!(decoded.transport_session_id, 9);
    assert_eq!(decoded.durable_ciphertext_bytes, 0x0102_0304_0506_0708);
    assert_eq!(decoded.progress_percent, 57);
    assert_eq!(decoded.transport_profile, 3);
}

#[test]
fn variable_frames_require_exact_declared_tail_lengths_and_round_trip() {
    let mut data = valid_transfer(31, 0x41);
    data[12..16].copy_from_slice(&7_u32.to_le_bytes());
    data[16..24].copy_from_slice(&11_u64.to_le_bytes());
    data[24..26].copy_from_slice(&3_u16.to_le_bytes());
    data[28..].copy_from_slice(b"abc");
    assert_transfer_round_trip(&data);
    for declared in [0_u16, 2, 4, u16::MAX] {
        let mut invalid = data.clone();
        invalid[24..26].copy_from_slice(&declared.to_le_bytes());
        assert!(decode_encrypted_upload_v2_transfer(&invalid).is_err());
    }
    let mut overflowing_offset = data.clone();
    overflowing_offset[16..24].copy_from_slice(&u64::MAX.to_le_bytes());
    assert_eq!(
        decode_encrypted_upload_v2_transfer(&overflowing_offset)
            .unwrap_err()
            .code,
        ErrorCode::PayloadTooLarge
    );

    let mut manifest = valid_transfer(56, 0x43);
    manifest[12..14].copy_from_slice(&580_u16.to_le_bytes());
    manifest[14..16].copy_from_slice(&100_u16.to_le_bytes());
    manifest[16..18].copy_from_slice(&4_u16.to_le_bytes());
    manifest[52..].copy_from_slice(b"test");
    assert_transfer_round_trip(&manifest);
    for declared in [0_u16, 3, 5, u16::MAX] {
        let mut invalid = manifest.clone();
        invalid[16..18].copy_from_slice(&declared.to_le_bytes());
        assert!(decode_encrypted_upload_v2_transfer(&invalid).is_err());
    }

    let mut blob = vec![0_u8; 15];
    blob[0] = 0x61;
    blob[1] = 2;
    blob[2] = 1;
    blob[4..8].copy_from_slice(&9_u32.to_le_bytes());
    blob[8..10].copy_from_slice(&12_u16.to_le_bytes());
    blob[10..12].copy_from_slice(&3_u16.to_le_bytes());
    blob[12..].copy_from_slice(b"xyz");
    let decoded = decode_encrypted_upload_v2_signed_blob(&blob).unwrap();
    assert_eq!(
        encode_encrypted_upload_v2_signed_blob(&decoded).unwrap(),
        blob
    );
    for declared in [0_u16, 2, 4, u16::MAX] {
        let mut invalid = blob.clone();
        invalid[10..12].copy_from_slice(&declared.to_le_bytes());
        assert!(decode_encrypted_upload_v2_signed_blob(&invalid).is_err());
    }
}

#[test]
fn window_ack_count_must_match_the_exact_tail() {
    let valid = valid_window_ack(&[7, 11]);
    assert_transfer_round_trip(&valid);
    for declared in [0_u16, 1, 3, u16::MAX] {
        let mut invalid = valid.clone();
        invalid[64..66].copy_from_slice(&declared.to_le_bytes());
        assert!(decode_encrypted_upload_v2_transfer(&invalid).is_err());
    }
}

#[test]
fn zero_session_unknown_version_and_legacy_packets_are_rejected() {
    let mut start = valid_start();
    start[4..12].fill(0);
    assert_noncanonical(decode_encrypted_upload_v2_transfer(&start));

    let mut start = valid_start();
    start[1] = 3;
    assert_eq!(
        decode_encrypted_upload_v2_transfer(&start)
            .unwrap_err()
            .code,
        ErrorCode::UnknownPacket
    );

    for legacy in [&[0x01, 0, 0][..], &[0x05, 0, 0][..], &[0x81, 0, 0][..]] {
        assert_eq!(
            decode_encrypted_upload_v2_transfer(legacy)
                .unwrap_err()
                .code,
            ErrorCode::UnknownPacket
        );
    }
}

#[test]
fn oversized_variable_payloads_fail_before_encoding() {
    let bytes = vec![0_u8; usize::from(u16::MAX) + 1];
    let signed = EncryptedUploadV2SignedBlob::Data {
        kind: 1,
        write_id: 1,
        offset: 0,
        data: &bytes,
    };
    assert_eq!(
        encode_encrypted_upload_v2_signed_blob(&signed)
            .unwrap_err()
            .code,
        ErrorCode::PayloadTooLarge
    );

    let mut encoded = valid_transfer(28, 0x41);
    encoded[24..26].copy_from_slice(&0_u16.to_le_bytes());
    let decoded = decode_encrypted_upload_v2_transfer(&encoded).unwrap_err();
    assert_eq!(decoded.code, ErrorCode::InvalidInput);
}

#[test]
fn signed_blob_assembler_accepts_exact_duplicates_and_verifies_commit_digest() {
    let document = vec![0x5a; 408];
    let digest: [u8; 32] = Sha256::digest(&document).into();
    let begin = EncryptedUploadV2SignedBlob::Begin {
        kind: 1,
        write_id: 17,
        total_length: 408,
        sha256: digest,
    };
    let mut assembler = SignedBlobAssemblerV2::from_begin(&begin).unwrap();
    let first = EncryptedUploadV2SignedBlob::Data {
        kind: 1,
        write_id: 17,
        offset: 0,
        data: &document[..200],
    };
    let second = EncryptedUploadV2SignedBlob::Data {
        kind: 1,
        write_id: 17,
        offset: 200,
        data: &document[200..],
    };
    assembler.push(&first).unwrap();
    assembler.push(&first).unwrap();
    assembler.push(&second).unwrap();
    let commit = EncryptedUploadV2SignedBlob::Commit {
        kind: 1,
        write_id: 17,
    };

    assert_eq!(assembler.finish(&commit).unwrap(), document);
}

#[test]
fn signed_blob_assembler_clears_gaps_conflicts_excess_and_digest_mismatch() {
    let document = vec![0x5a; 408];
    let digest: [u8; 32] = Sha256::digest(&document).into();
    let begin = EncryptedUploadV2SignedBlob::Begin {
        kind: 1,
        write_id: 17,
        total_length: 408,
        sha256: digest,
    };

    let mut assembler = SignedBlobAssemblerV2::from_begin(&begin).unwrap();
    let gap = EncryptedUploadV2SignedBlob::Data {
        kind: 1,
        write_id: 17,
        offset: 1,
        data: &document[..1],
    };
    assert_eq!(
        assembler.push(&gap).unwrap_err().code,
        ErrorCode::InvalidInput
    );
    assert_eq!(assembler.buffered_length(), 0);
    let restart = EncryptedUploadV2SignedBlob::Data {
        kind: 1,
        write_id: 17,
        offset: 0,
        data: &document[..1],
    };
    assert_eq!(
        assembler.push(&restart).unwrap_err().code,
        ErrorCode::InvalidInput
    );

    let mut assembler = SignedBlobAssemblerV2::from_begin(&begin).unwrap();
    let first = EncryptedUploadV2SignedBlob::Data {
        kind: 1,
        write_id: 17,
        offset: 0,
        data: &document[..8],
    };
    assembler.push(&first).unwrap();
    let conflict = EncryptedUploadV2SignedBlob::Data {
        kind: 1,
        write_id: 17,
        offset: 0,
        data: b"conflict",
    };
    assert_eq!(
        assembler.push(&conflict).unwrap_err().code,
        ErrorCode::InvalidInput
    );
    assert_eq!(assembler.buffered_length(), 0);

    let mut assembler = SignedBlobAssemblerV2::from_begin(&begin).unwrap();
    let excess_bytes = vec![0; 409];
    let excess = EncryptedUploadV2SignedBlob::Data {
        kind: 1,
        write_id: 17,
        offset: 0,
        data: &excess_bytes,
    };
    assert_eq!(
        assembler.push(&excess).unwrap_err().code,
        ErrorCode::PayloadTooLarge
    );
    assert_eq!(assembler.buffered_length(), 0);

    let mut wrong_digest = digest;
    wrong_digest[0] ^= 1;
    let begin = EncryptedUploadV2SignedBlob::Begin {
        kind: 1,
        write_id: 17,
        total_length: 408,
        sha256: wrong_digest,
    };
    let mut assembler = SignedBlobAssemblerV2::from_begin(&begin).unwrap();
    let all = EncryptedUploadV2SignedBlob::Data {
        kind: 1,
        write_id: 17,
        offset: 0,
        data: &document,
    };
    assembler.push(&all).unwrap();
    let commit = EncryptedUploadV2SignedBlob::Commit {
        kind: 1,
        write_id: 17,
    };
    assert_eq!(
        assembler.finish(&commit).unwrap_err().code,
        ErrorCode::IntegrityFailed
    );
    assert_eq!(assembler.buffered_length(), 0);
}

fn assert_noncanonical<T: std::fmt::Debug>(
    result: Result<T, bota_device_sdk_core::error::DeviceSdkError>,
) {
    assert_eq!(result.unwrap_err().code, ErrorCode::InvalidInput);
}

fn decode_fixed_frame(
    kind: FixedFrameKind,
    bytes: &[u8],
) -> Result<(), bota_device_sdk_core::error::DeviceSdkError> {
    match kind {
        FixedFrameKind::Capability => decode_encrypted_upload_v2_capabilities(bytes).map(drop),
        FixedFrameKind::SignedBlob => decode_encrypted_upload_v2_signed_blob(bytes).map(drop),
        FixedFrameKind::Transfer => decode_encrypted_upload_v2_transfer(bytes).map(drop),
        FixedFrameKind::Status => decode_encrypted_upload_v2_status(bytes).map(drop),
    }
}

fn assert_transfer_round_trip(bytes: &[u8]) {
    let decoded = decode_encrypted_upload_v2_transfer(bytes).unwrap();
    assert_eq!(
        encode_encrypted_upload_v2_transfer(&decoded).unwrap(),
        bytes
    );
}

fn valid_fixed_frames() -> Vec<(&'static str, FixedFrameKind, Vec<u8>)> {
    vec![
        ("capability", FixedFrameKind::Capability, valid_capability()),
        ("blob begin", FixedFrameKind::SignedBlob, valid_blob_begin()),
        (
            "blob commit",
            FixedFrameKind::SignedBlob,
            valid_blob_fixed(8, 0x62),
        ),
        (
            "blob abort",
            FixedFrameKind::SignedBlob,
            valid_blob_fixed(8, 0x63),
        ),
        (
            "blob result",
            FixedFrameKind::SignedBlob,
            valid_blob_fixed(10, 0x64),
        ),
        ("list", FixedFrameKind::Transfer, valid_transfer(16, 0x25)),
        (
            "recording entry",
            FixedFrameKind::Transfer,
            valid_recording_entry(),
        ),
        (
            "recording list end",
            FixedFrameKind::Transfer,
            valid_transfer(52, 0x49),
        ),
        ("start", FixedFrameKind::Transfer, valid_start()),
        ("start ack", FixedFrameKind::Transfer, valid_start_ack()),
        ("window end", FixedFrameKind::Transfer, valid_window_end()),
        ("eof", FixedFrameKind::Transfer, valid_transfer(92, 0x44)),
        (
            "resume request",
            FixedFrameKind::Transfer,
            valid_resume(0x22),
        ),
        (
            "resume accept",
            FixedFrameKind::Transfer,
            valid_resume(0x45),
        ),
        (
            "resume reject",
            FixedFrameKind::Transfer,
            valid_transfer(60, 0x46),
        ),
        (
            "confirm",
            FixedFrameKind::Transfer,
            valid_transfer(84, 0x23),
        ),
        ("abort", FixedFrameKind::Transfer, valid_transfer(16, 0x24)),
        ("error", FixedFrameKind::Transfer, valid_transfer(20, 0x4f)),
        ("status", FixedFrameKind::Status, valid_status()),
    ]
}

fn valid_capability() -> Vec<u8> {
    let mut bytes = vec![0_u8; 24];
    bytes[0] = 1;
    bytes[1] = 2;
    bytes[2..4].copy_from_slice(&24_u16.to_le_bytes());
    bytes[4..8].copy_from_slice(&0x7f_u32.to_le_bytes());
    bytes[8..10].copy_from_slice(&1024_u16.to_le_bytes());
    bytes[10..12].copy_from_slice(&1024_u16.to_le_bytes());
    bytes[12..14].copy_from_slice(&100_u16.to_le_bytes());
    bytes[14..16].copy_from_slice(&4_u16.to_le_bytes());
    bytes[16..20].copy_from_slice(&8_u32.to_le_bytes());
    bytes[20..22].copy_from_slice(&4_u16.to_le_bytes());
    bytes
}

fn valid_blob_begin() -> Vec<u8> {
    let mut bytes = valid_blob_fixed(42, 0x60);
    bytes[8..10].copy_from_slice(&408_u16.to_le_bytes());
    bytes
}

fn valid_blob_fixed(length: usize, code: u8) -> Vec<u8> {
    let mut bytes = vec![0_u8; length];
    bytes[0] = code;
    bytes[1] = 2;
    bytes[2] = 1;
    bytes[4..8].copy_from_slice(&9_u32.to_le_bytes());
    bytes
}

fn valid_transfer(length: usize, message_type: u8) -> Vec<u8> {
    let mut bytes = vec![0_u8; length];
    bytes[0] = message_type;
    bytes[1] = 2;
    bytes[4..12].copy_from_slice(&1_u64.to_le_bytes());
    bytes
}

fn valid_recording_entry() -> Vec<u8> {
    let mut bytes = valid_transfer(96, 0x48);
    bytes[32] = 3;
    bytes[33] = 1;
    bytes
}

fn valid_start() -> Vec<u8> {
    let mut bytes = valid_transfer(128, 0x20);
    bytes[124..126].copy_from_slice(&4_u16.to_le_bytes());
    bytes[126..128].copy_from_slice(&100_u16.to_le_bytes());
    bytes
}

fn valid_start_ack() -> Vec<u8> {
    let mut bytes = valid_transfer(140, 0x40);
    bytes[88..90].copy_from_slice(&4_u16.to_le_bytes());
    bytes[90..92].copy_from_slice(&100_u16.to_le_bytes());
    bytes[92..96].copy_from_slice(&8_u32.to_le_bytes());
    bytes
}

fn valid_window_end() -> Vec<u8> {
    let mut bytes = valid_transfer(68, 0x42);
    bytes[16..20].copy_from_slice(&7_u32.to_le_bytes());
    bytes[20..24].copy_from_slice(&11_u32.to_le_bytes());
    bytes
}

fn valid_window_ack(missing: &[u32]) -> Vec<u8> {
    let mut bytes = valid_transfer(68 + missing.len() * 4, 0x21);
    bytes[64..66].copy_from_slice(&(missing.len() as u16).to_le_bytes());
    for (index, sequence) in missing.iter().enumerate() {
        let offset = 68 + index * 4;
        bytes[offset..offset + 4].copy_from_slice(&sequence.to_le_bytes());
    }
    bytes
}

fn valid_resume(message_type: u8) -> Vec<u8> {
    let mut bytes = valid_transfer(96, message_type);
    bytes[92..94].copy_from_slice(&4_u16.to_le_bytes());
    bytes[94..96].copy_from_slice(&100_u16.to_le_bytes());
    bytes
}

fn valid_status() -> Vec<u8> {
    let mut bytes = vec![0_u8; 24];
    bytes[0] = 2;
    bytes
}

#[test]
fn decoded_variable_variants_expose_borrowed_payloads() {
    let mut data = valid_transfer(31, 0x41);
    data[24..26].copy_from_slice(&3_u16.to_le_bytes());
    data[28..].copy_from_slice(b"abc");
    assert!(matches!(
        decode_encrypted_upload_v2_transfer(&data).unwrap(),
        EncryptedUploadV2Transfer::Data { data: b"abc", .. }
    ));

    let mut blob = vec![0_u8; 15];
    blob[0] = 0x61;
    blob[1] = 2;
    blob[2] = 1;
    blob[10..12].copy_from_slice(&3_u16.to_le_bytes());
    blob[12..].copy_from_slice(b"xyz");
    assert!(matches!(
        decode_encrypted_upload_v2_signed_blob(&blob).unwrap(),
        EncryptedUploadV2SignedBlob::Data { data: b"xyz", .. }
    ));
}
