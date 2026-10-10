use bota_device_sdk_core::protocol::{
    MarkerDocumentAssembler, decode_marker_body, decode_marker_document_header,
};

fn body() -> Vec<u8> {
    let mut bytes = vec![0; 52];
    for (i, byte) in bytes[..16].iter_mut().enumerate() {
        *byte = i as u8;
    }
    bytes[16..20].copy_from_slice(&1_u32.to_le_bytes());
    bytes[20..28].copy_from_slice(&1234_u64.to_le_bytes());
    bytes[32..40].copy_from_slice(&1234_u64.to_le_bytes());
    bytes[48] = 1;
    bytes
}
fn document() -> Vec<u8> {
    let mut bytes = vec![0; 228];
    bytes[..8].copy_from_slice(b"BOTAMRK1");
    bytes[8..10].copy_from_slice(&1_u16.to_le_bytes());
    bytes[10..12].copy_from_slice(&1_u16.to_le_bytes());
    bytes[12..16].copy_from_slice(&228_u32.to_le_bytes());
    bytes[16..32].fill(1);
    bytes[32..64].fill(2);
    bytes
}
#[test]
fn marker_body_preserves_device_integer_and_digest() {
    let marker = decode_marker_body(&body()).unwrap();
    assert_eq!(marker.media_offset_ms, 1234);
    assert_eq!(marker.created_at_utc_ms, None);
    assert_eq!(
        marker.digest,
        [
            0x67, 0x66, 0x50, 0xee, 0x38, 0x0a, 0x72, 0x2a, 0x6d, 0x04, 0x78, 0x77, 0xb8, 0x8a,
            0x61, 0xc5, 0x31, 0xbf, 0x87, 0xa6, 0xc2, 0x6f, 0xf3, 0x90, 0x45, 0x20, 0x48, 0x02,
            0x27, 0x45, 0xc8, 0xcd
        ]
    );
    let mut large = body();
    large[20..28].copy_from_slice(&9_007_199_254_740_993_u64.to_le_bytes());
    large[32..40].copy_from_slice(&9_007_199_254_740_993_u64.to_le_bytes());
    assert_eq!(
        decode_marker_body(&large).unwrap().media_offset_ms,
        9_007_199_254_740_993
    );
}
#[test]
fn invalid_body_fields_are_rejected() {
    for offset in [16, 48, 49, 50, 40] {
        let mut bytes = body();
        bytes[offset] = if offset == 16 { 0 } else { 255 };
        assert!(decode_marker_body(&bytes).is_err());
    }
    for len in 0..52 {
        assert!(decode_marker_body(&body()[..len]).is_err());
    }
    let mut bytes = body();
    bytes.push(0);
    assert!(decode_marker_body(&bytes).is_err());
}
#[test]
fn opaque_header_is_not_a_persistence_proof() {
    let bytes = document();
    assert_eq!(decode_marker_document_header(&bytes, 228).unwrap().kind, 1);
    assert!(decode_marker_document_header(&bytes, 227).is_err());
    for offset in [0, 8, 10, 12] {
        let mut changed = bytes.clone();
        changed[offset] = 255;
        assert!(decode_marker_document_header(&changed, 228).is_err());
    }
}
#[test]
fn reassembly_fences_connection_transfer_offset_and_content() {
    let bytes = document();
    let mut assembler = MarkerDocumentAssembler::new(7, 1, 1, 228, 256, [1; 16], [2; 32]).unwrap();
    assert!(!assembler.push(7, 1, 0, &bytes[..80]).unwrap());
    assert!(!assembler.push(7, 1, 0, &bytes[..80]).unwrap());
    assert!(assembler.push(6, 1, 80, &bytes[80..]).is_err());
    assert!(assembler.push(7, 2, 80, &bytes[80..]).is_err());
    assert!(assembler.push(7, 1, 81, &bytes[80..]).is_err());
    assert!(assembler.push(7, 1, 80, &bytes[80..]).unwrap());
    assert_eq!(assembler.document().unwrap(), bytes);
    let mut bad = bytes[..80].to_vec();
    bad[70] ^= 1;
    assert!(assembler.push(7, 1, 0, &bad).is_err());
    assert!(MarkerDocumentAssembler::new(7, 1, 1, 257, 256, [1; 16], [2; 32]).is_err());
}
#[test]
fn completed_context_mismatch_never_exposes_a_document() {
    let bytes = document();
    let mut assembler = MarkerDocumentAssembler::new(7, 1, 1, 228, 256, [1; 16], [3; 32]).unwrap();
    assert!(assembler.push(7, 1, 0, &bytes).is_err());
    assert!(assembler.document().is_none());
    assert!(assembler.push(7, 1, 0, &bytes).is_err());
}

#[test]
fn different_kind_cannot_satisfy_the_active_operation() {
    let bytes = document();
    let mut assembler = MarkerDocumentAssembler::new(7, 1, 3, 228, 256, [1; 16], [2; 32]).unwrap();
    assert!(assembler.push(7, 1, 0, &bytes).is_err());
    assert!(assembler.document().is_none());
}

#[test]
fn shares_exact_body_vectors_with_backend_and_firmware() {
    let vectors: serde_json::Value = serde_json::from_str(include_str!(
        "../../../protocol/vectors/recording-markers-v1.json"
    ))
    .unwrap();
    for vector in vectors["vectors"].as_array().unwrap() {
        let hex = vector["hex"].as_str().unwrap();
        let bytes: Vec<u8> = (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect();
        let result = decode_marker_body(&bytes);
        if vector["expected"] == "accept" {
            let marker = result.unwrap();
            let digest: String = marker.digest.iter().map(|b| format!("{b:02x}")).collect();
            assert_eq!(digest, vector["marker_digest"].as_str().unwrap());
        } else {
            assert!(result.is_err(), "{}", vector["name"]);
        }
    }
}

#[test]
fn protected_batch_ble_frames_and_exact_bundle_lengths() {
    use bota_device_sdk_core::protocol::{
        CommonHeaderV2, EncryptedUploadV2SignedBlob, EncryptedUploadV2Transfer, MarkerChunkV2,
        decode_encrypted_upload_v2_signed_blob, decode_encrypted_upload_v2_transfer,
        encode_encrypted_upload_v2_signed_blob, encode_encrypted_upload_v2_transfer,
    };
    let common = CommonHeaderV2 {
        message_type: 0x25,
        flags: 0,
        transport_session_id: 17,
    };
    let bytes = encode_encrypted_upload_v2_transfer(&EncryptedUploadV2Transfer::MarkedList(common))
        .unwrap();
    assert_eq!(&bytes[12..], &[1, 0, 0, 0]);
    assert!(matches!(
        decode_encrypted_upload_v2_transfer(&bytes).unwrap(),
        EncryptedUploadV2Transfer::MarkedList(_)
    ));
    let chunk = EncryptedUploadV2Transfer::MarkerChunk(MarkerChunkV2 {
        common: CommonHeaderV2 {
            message_type: 0x4a,
            ..common
        },
        document_index: 1,
        document_count: 3,
        chunk_offset: 0,
        document_length: 402,
        document_sha256: [7; 32],
        chunk: &[8; 180],
    });
    let bytes = encode_encrypted_upload_v2_transfer(&chunk).unwrap();
    assert_eq!(decode_encrypted_upload_v2_transfer(&bytes).unwrap(), chunk);
    for offset in [1, 2, 3, 17, 21, 22, 25, 26] {
        let mut invalid = bytes.clone();
        invalid[offset] = 255;
        assert!(
            decode_encrypted_upload_v2_transfer(&invalid).is_err(),
            "offset {offset}"
        );
    }
    for (kind, size) in [(5, 864), (6, 632)] {
        let frame = EncryptedUploadV2SignedBlob::Begin {
            kind,
            write_id: 1,
            total_length: size,
            sha256: [0; 32],
        };
        let encoded = encode_encrypted_upload_v2_signed_blob(&frame).unwrap();
        assert_eq!(
            decode_encrypted_upload_v2_signed_blob(&encoded).unwrap(),
            frame
        );
        assert!(
            encode_encrypted_upload_v2_signed_blob(&EncryptedUploadV2SignedBlob::Begin {
                kind,
                write_id: 1,
                total_length: size - 1,
                sha256: [0; 32]
            })
            .is_err()
        );
    }
}
