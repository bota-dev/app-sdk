use bota_device_sdk_core::protocol::*;
use sha2::{Digest, Sha256};

fn entry(session: u64, id: u32) -> Vec<u8> {
    let mut uuid = [1; 16];
    uuid[..4].copy_from_slice(&id.to_le_bytes());
    encode_encrypted_upload_v2_transfer(&EncryptedUploadV2Transfer::RecordingEntry(
        RecordingEntryV2 {
            common: CommonHeaderV2 {
                message_type: 0x48,
                flags: 0,
                transport_session_id: session,
            },
            recording_uuid: uuid,
            recording_generation: 7,
            storage_format: 3,
            completion_state: 1,
            started_at: 99,
            duration_seconds: 5,
            plaintext_length: 100,
            ciphertext_length: 600,
            ciphertext_sha256: [2; 32],
        },
    ))
    .unwrap()
}
fn end(session: u64, entries: &[Vec<u8>]) -> Vec<u8> {
    let mut hash = Sha256::new();
    for entry in entries {
        hash.update(&entry[12..]);
    }
    encode_encrypted_upload_v2_transfer(&EncryptedUploadV2Transfer::RecordingListEnd {
        common: CommonHeaderV2 {
            message_type: 0x49,
            flags: 0,
            transport_session_id: session,
        },
        count: entries.len() as u32,
        list_revision: 9,
        list_sha256: hash.finalize().into(),
    })
    .unwrap()
}
#[test]
fn catalog_preserves_arrival_order_and_hashes_only_entry_bodies() {
    let mut decoder = EncryptedUploadV2CatalogDecoder::default();
    let entries = vec![entry(7, 2), entry(7, 1)];
    assert!(decoder.push(7, &[]).unwrap().is_none());
    for bytes in &entries {
        assert!(decoder.push(7, bytes).unwrap().is_none());
    }
    let batch = decoder.push(7, &end(7, &entries)).unwrap().unwrap();
    assert_eq!(batch.transport_session_id, 7);
    assert_eq!(batch.list_revision, 9);
    assert_eq!(batch.entries.len(), 2);
    assert_eq!(batch.entries[0].recording_uuid[0], 2);
    assert_eq!(batch.entries[1].recording_uuid[0], 1);
    assert!(decoder.push(7, &end(7, &[])).is_err());
}
#[test]
fn catalog_rejects_bad_order_count_digest_session_and_reset_without_partial_output() {
    let mut decoder = EncryptedUploadV2CatalogDecoder::default();
    let entries = vec![entry(7, 1)];
    let mut bad_hash = end(7, &entries);
    *bad_hash.last_mut().unwrap() ^= 1;
    let mut reordered = entry(7, 1);
    reordered[0] = 0x41;
    for (session, bad) in [
        (7, bad_hash),
        (7, end(7, &[])),
        (7, entry(8, 1)),
        (8, entry(8, 1)),
        (7, entry(7, 1)),
        (7, reordered),
        (7, vec![0; 97]),
    ] {
        decoder.push(7, &[]).unwrap();
        decoder.push(7, &entries[0]).unwrap();
        assert!(decoder.push(session, &bad).is_err());
        assert!(decoder.push(7, &end(7, &entries)).is_err());
    }
    decoder.push(7, &[]).unwrap();
    decoder.push(7, &entries[0]).unwrap();
    decoder.reset();
    assert!(decoder.push(7, &end(7, &entries)).is_err());
    assert!(decoder.push(0, &[]).is_err());
}
#[test]
fn catalog_accepts_exact_capacity_and_rejects_the_next_entry() {
    let mut decoder = EncryptedUploadV2CatalogDecoder::default();
    let entries: Vec<_> = (0..4096).map(|id| entry(7, id)).collect();
    decoder.push(7, &[]).unwrap();
    for bytes in &entries {
        decoder.push(7, bytes).unwrap();
    }
    assert_eq!(
        decoder
            .push(7, &end(7, &entries))
            .unwrap()
            .unwrap()
            .entries
            .len(),
        4096
    );
    decoder.push(7, &[]).unwrap();
    for bytes in &entries {
        decoder.push(7, bytes).unwrap();
    }
    assert!(decoder.push(7, &entry(7, 4096)).is_err());
    assert!(decoder.push(7, &end(7, &entries)).is_err());
}
