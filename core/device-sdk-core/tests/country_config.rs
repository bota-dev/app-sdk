use bota_device_sdk_core::protocol::{
    CountryConfigurationDocument, EncryptedUploadV2SignedBlob, SignedBlobAssemblerV2,
    decode_encrypted_upload_v2_signed_blob, encode_encrypted_upload_v2_signed_blob,
};
use sha2::{Digest, Sha256};

fn document() -> Vec<u8> {
    // Structural fixture only. This is not an authenticated configuration.
    let mut bytes = vec![0; 264];
    bytes[..8].copy_from_slice(b"BOTACFG1");
    bytes[8] = 1;
    bytes[10] = 1;
    bytes[12..16].fill(2);
    bytes[16..24].copy_from_slice(&7_u64.to_be_bytes());
    bytes[24..32].copy_from_slice(&9_u64.to_be_bytes());
    bytes[32..34].copy_from_slice(b"US");
    bytes[36..68].fill(7);
    for (offset, text) in [(68, "proj_test"), (134, "dev_test")] {
        bytes[offset..offset + 2].copy_from_slice(&(text.len() as u16).to_be_bytes());
        bytes[offset + 2..offset + 2 + text.len()].copy_from_slice(text.as_bytes());
    }
    bytes[231] = 1;
    bytes[263] = 1;
    bytes
}

#[test]
fn country_document_has_bounded_identity_and_monotonic_metadata() {
    let bytes = document();
    let parsed = CountryConfigurationDocument::parse(&bytes).unwrap();
    assert_eq!(parsed.country_alpha2, "US");
    assert_eq!(parsed.country_revision, 9);
    assert_eq!(parsed.binding_generation, 7);
    assert_eq!(parsed.project_id, "proj_test");
    assert_eq!(parsed.device_id, "dev_test");
    for (offset, value) in [
        (0, b'X'),
        (8, 2),
        (9, 3),
        (10, 0),
        (11, 1),
        (32, b'u'),
        (34, 1),
        (35, 1),
        (68, 1),
        (69, 0),
        (70, 0),
        (100, 1),
        (134, 1),
        (135, 0),
        (136, 0),
        (190, 1),
    ] {
        let mut bad = bytes.clone();
        bad[offset] = value;
        assert!(
            CountryConfigurationDocument::parse(&bad).is_err(),
            "offset {offset}"
        );
    }
    for span in [16..24, 24..32, 200..232, 232..264] {
        let mut bad = bytes.clone();
        bad[span].fill(0);
        assert!(CountryConfigurationDocument::parse(&bad).is_err());
    }
    assert!(CountryConfigurationDocument::parse(&bytes[..263]).is_err());
    assert!(CountryConfigurationDocument::parse(&[bytes.clone(), vec![0]].concat()).is_err());
    let mut overflow = bytes;
    overflow[16..24].copy_from_slice(&u64::MAX.to_be_bytes());
    assert!(CountryConfigurationDocument::parse(&overflow).is_err());
}

#[test]
fn country_uses_exact_length_existing_signed_blob_frames() {
    let bytes = document();
    let begin = EncryptedUploadV2SignedBlob::Begin {
        kind: 8,
        write_id: 7,
        total_length: 264,
        sha256: Sha256::digest(&bytes).into(),
    };
    let wire = encode_encrypted_upload_v2_signed_blob(&begin).unwrap();
    let mut assembler =
        SignedBlobAssemblerV2::from_begin(&decode_encrypted_upload_v2_signed_blob(&wire).unwrap())
            .unwrap();
    for (index, data) in bytes.chunks(52).enumerate() {
        let frame = EncryptedUploadV2SignedBlob::Data {
            kind: 8,
            write_id: 7,
            offset: (index * 52) as u16,
            data,
        };
        let encoded = encode_encrypted_upload_v2_signed_blob(&frame).unwrap();
        assert!(encoded.len() <= 64);
        assembler
            .push(&decode_encrypted_upload_v2_signed_blob(&encoded).unwrap())
            .unwrap();
    }
    let commit = EncryptedUploadV2SignedBlob::Commit {
        kind: 8,
        write_id: 7,
    };
    assert_eq!(assembler.finish(&commit).unwrap(), bytes);
    let bad = EncryptedUploadV2SignedBlob::Begin {
        kind: 8,
        write_id: 7,
        total_length: 263,
        sha256: Sha256::digest([]).into(),
    };
    assert!(encode_encrypted_upload_v2_signed_blob(&bad).is_err());
}
