use bota_device_sdk_core::protocol::*;

#[test]
fn context_begin_and_snapshot_match_released_wire() {
    assert_eq!(
        encode_upload_context_begin(0x12345678).unwrap(),
        [0x65, 2, 0, 0, 0x78, 0x56, 0x34, 0x12]
    );
    assert!(encode_upload_context_begin(0).is_err());
    let mut bytes = vec![0x66, 2, 1, 0, 0x78, 0x56, 0x34, 0x12, 0, 0, 16, 0];
    bytes.extend([17; 16]);
    let value = decode_upload_context_snapshot(&bytes).unwrap();
    assert_eq!(value.attempt_id, 0x12345678);
    assert_eq!(value.state, 1);
    assert_eq!(value.payload, vec![17; 16]);
    for length in 0..bytes.len() {
        assert!(decode_upload_context_snapshot(&bytes[..length]).is_err());
    }
    bytes[3] = 1;
    assert!(decode_upload_context_snapshot(&bytes).is_err());
    bytes[3] = 0;
    bytes[12..].fill(0);
    assert!(decode_upload_context_snapshot(&bytes).is_err());
}

#[test]
fn context_shapes_and_blob_lengths_fail_closed() {
    for (kind, length, magic) in [(3, 196, b"BOTACTXQ"), (4, 264, b"BOTACTXR")] {
        let mut document = vec![0; length];
        document[..8].copy_from_slice(magic);
        document[8] = 1;
        document[10..12].copy_from_slice(&(length as u16).to_le_bytes());
        assert!(decode_upload_context_document(kind, &document).is_ok());
        assert!(decode_upload_context_document(kind, &document[..length - 1]).is_err());
        document[0] = 0;
        assert!(decode_upload_context_document(kind, &document).is_err());
        let frame = EncryptedUploadV2SignedBlob::Begin {
            kind,
            write_id: 17,
            total_length: length as u16,
            sha256: [0; 32],
        };
        let bytes = encode_encrypted_upload_v2_signed_blob(&frame).unwrap();
        assert_eq!(
            decode_encrypted_upload_v2_signed_blob(&bytes).unwrap(),
            frame
        );
    }
    assert!(decode_upload_context_document(5, &[]).is_err());
}
