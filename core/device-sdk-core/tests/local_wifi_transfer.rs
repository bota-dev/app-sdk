use bota_device_sdk_core::{generated::protocol as p, protocol::*};
use sha2::{Digest, Sha256};

fn digest(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}
fn config() -> LocalWifiTransferConfig {
    LocalWifiTransferConfig {
        prepare: LocalWifiPrepare {
            transport_session_id: 7,
            upload_session_uuid: [1; 16],
            recording_uuid: [2; 16],
            recording_generation: 3,
            authorization_sha256: [4; 32],
            owner_revision: 5,
        },
        ciphertext_length: 330,
        ciphertext_sha256: digest(&[9; 330]),
    }
}
fn evidence(kind: u8) -> Vec<u8> {
    let mut b = vec![0; 128];
    b[0] = kind;
    b[1] = 2;
    b[4..12].copy_from_slice(&7u64.to_le_bytes());
    b[12..28].fill(1);
    b[28..44].fill(2);
    b[44..48].copy_from_slice(&3u32.to_le_bytes());
    b[48..52].copy_from_slice(&5u32.to_le_bytes());
    b[52..60].copy_from_slice(&330u64.to_le_bytes());
    b[60..92].copy_from_slice(&digest(&[9; 330]));
    b[92..124].copy_from_slice(&digest(&[6; 580]));
    b[124..128].copy_from_slice(&1u32.to_le_bytes());
    b
}
fn ready() -> LocalWifiTransferReceiver {
    let mut r = LocalWifiTransferReceiver::new(config()).unwrap();
    r.prepared(&evidence(p::LOCAL_WIFI_PREPARED)).unwrap();
    for (i, chunk) in [6; 580].chunks(130).enumerate() {
        let frame = encode_encrypted_upload_v2_transfer(&EncryptedUploadV2Transfer::ManifestChunk(
            ManifestChunkV2 {
                common: CommonHeaderV2 {
                    message_type: p::ENCRYPTED_UPLOAD_V2_MANIFEST_CHUNK,
                    flags: 0,
                    transport_session_id: 7,
                },
                total_manifest_length: 580,
                chunk_offset: (i * 130) as u16,
                manifest_sha256: digest(&[6; 580]),
                chunk,
            },
        ))
        .unwrap();
        r.manifest(&frame).unwrap();
    }
    r
}
fn proof(length: u64, bytes: &[u8]) -> LocalWifiFileProof {
    LocalWifiFileProof {
        byte_length: length,
        prefix_sha256: digest(bytes),
    }
}
fn headers(start: u64) -> LocalWifiHttpResponse {
    LocalWifiHttpResponse {
        status: if start == 0 { 200 } else { 206 },
        content_length: 330 - start,
        content_range: if start == 0 {
            None
        } else {
            Some(format!("bytes {start}-329/330"))
        },
        etag: format!(
            "\"{}\"",
            digest(&[9; 330])
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        ),
        content_encoding: None,
    }
}
#[test]
fn fresh_download_is_durable_before_finish_and_reuses_original_completion_evidence() {
    let mut r = ready();
    let plan = r.resume(None, proof(12, &[])).unwrap();
    assert_eq!(plan.offset, 0);
    assert_eq!(plan.truncate_to, Some(0));
    assert!(plan.download);
    assert!(r.finish().is_err());
    r.response(headers(0)).unwrap();
    r.chunk(330).unwrap();
    let checkpoint = r.flushed(proof(330, &[9; 330])).unwrap();
    assert!(r.finish().is_err()); // fsync is insufficient until journal commit.
    r.saved(&checkpoint).unwrap();
    assert!(r.finish().is_err()); // must join/close HTTP reader first.
    r.reader_closed().unwrap();
    assert_eq!(r.finish().unwrap().len(), 124);
    let completed = r.eof(&evidence(p::LOCAL_WIFI_EOF)).unwrap();
    assert_eq!(completed.ciphertext_length, 330);
    assert_eq!(completed.manifest_length, 580);
}
#[test]
fn complete_retained_file_never_requests_http_or_resets_to_ble() {
    let mut first = ready();
    first.resume(None, proof(0, &[])).unwrap();
    first.response(headers(0)).unwrap();
    first.chunk(330).unwrap();
    let cp = first.flushed(proof(330, &[9; 330])).unwrap();
    first.saved(&cp).unwrap();
    let mut resumed = ready();
    let plan = resumed.resume(Some(cp), proof(330, &[9; 330])).unwrap();
    assert!(!plan.download);
    assert_eq!(plan.truncate_to, None);
    assert_eq!(resumed.finish().unwrap().len(), 124);
}
#[test]
fn partial_resume_requires_exact_owner_prefix_and_strong_range_response() {
    let mut first = ready();
    first.resume(None, proof(0, &[])).unwrap();
    first.response(headers(0)).unwrap();
    first.chunk(100).unwrap();
    let cp = first.flushed(proof(100, &[9; 100])).unwrap();
    first.saved(&cp).unwrap();
    let mut resumed = ready();
    let plan = resumed
        .resume(Some(cp.clone()), proof(130, &[9; 100]))
        .unwrap();
    assert_eq!(plan.offset, 100);
    assert_eq!(plan.truncate_to, Some(100));
    assert!(resumed.response(headers(0)).is_err());
    let mut resumed = ready();
    resumed
        .resume(Some(cp.clone()), proof(100, &[9; 100]))
        .unwrap();
    resumed.response(headers(100)).unwrap();
    assert!(resumed.chunk(231).is_err());
    let mut corrupt = ready();
    assert!(
        corrupt
            .resume(Some(cp.clone()), proof(100, &[8; 100]))
            .is_err()
    );
    let mut wrong = cp;
    wrong.owner_revision += 1;
    assert!(ready().resume(Some(wrong), proof(100, &[9; 100])).is_err());
}
#[test]
fn cancel_stale_evidence_and_uncommitted_chunks_cannot_complete() {
    let mut r = ready();
    r.resume(None, proof(0, &[])).unwrap();
    r.response(headers(0)).unwrap();
    r.chunk(100).unwrap();
    assert!(r.chunk(100).is_err());
    r.cancel();
    assert!(r.flushed(proof(100, &[9; 100])).is_err());
    assert!(r.finish().is_err());
    let mut r = LocalWifiTransferReceiver::new(config()).unwrap();
    let mut stale = evidence(p::LOCAL_WIFI_PREPARED);
    stale[4] = 8;
    assert!(r.prepared(&stale).is_err());
}
#[test]
fn invalid_http_and_manifest_never_authorize_writes() {
    for mutate in [0, 1, 2] {
        let mut r = ready();
        r.resume(None, proof(0, &[])).unwrap();
        let mut h = headers(0);
        match mutate {
            0 => h.etag = format!("W/{}", h.etag),
            1 => h.content_encoding = Some("gzip".into()),
            _ => h.content_length = 331,
        }
        assert!(r.response(h).is_err());
        assert!(r.chunk(10).is_err());
    }
    let mut r = LocalWifiTransferReceiver::new(config()).unwrap();
    r.prepared(&evidence(p::LOCAL_WIFI_PREPARED)).unwrap();
    assert!(r.resume(None, proof(0, &[])).is_err());
}

fn retained_checkpoint(length: usize) -> LocalWifiCheckpoint {
    let mut first = ready();
    first.resume(None, proof(0, &[])).unwrap();
    first.response(headers(0)).unwrap();
    first.chunk(length).unwrap();
    first
        .flushed(proof(length as u64, &vec![9; length]))
        .unwrap()
}
fn successor() -> (LocalWifiTransferReceiver, LocalWifiRecovery) {
    let mut c = config();
    c.prepare.upload_session_uuid = [3; 16];
    c.prepare.owner_revision = 6;
    let mut r = LocalWifiTransferReceiver::new(c).unwrap();
    let mut e = evidence(p::LOCAL_WIFI_PREPARED);
    e[12..28].fill(3);
    e[48..52].copy_from_slice(&6u32.to_le_bytes());
    e[92..124].copy_from_slice(&digest(&[8; 580]));
    r.prepared(&e).unwrap();
    for (i, chunk) in [8; 580].chunks(130).enumerate() {
        r.manifest(
            &encode_encrypted_upload_v2_transfer(&EncryptedUploadV2Transfer::ManifestChunk(
                ManifestChunkV2 {
                    common: CommonHeaderV2 {
                        message_type: p::ENCRYPTED_UPLOAD_V2_MANIFEST_CHUNK,
                        flags: 0,
                        transport_session_id: 7,
                    },
                    total_manifest_length: 580,
                    chunk_offset: (i * 130) as u16,
                    manifest_sha256: digest(&[8; 580]),
                    chunk,
                },
            ))
            .unwrap(),
        )
        .unwrap();
    }
    (
        r,
        LocalWifiRecovery {
            previous_upload_session_uuid: [1; 16],
            previous_owner_revision: 5,
            upload_session_uuid: [3; 16],
            owner_revision: 6,
        },
    )
}
#[test]
fn authorized_successor_rebases_full_and_partial_files_without_weakening_normal_resume() {
    for length in [150, 330] {
        let cp = retained_checkpoint(length);
        let (mut next, recovery) = successor();
        assert!(next.resume_prefix(Some(&cp)).is_err());
        let rebased = next.rebase_checkpoint(&cp, &recovery).unwrap();
        assert_eq!(rebased.manifest_sha256, digest(&[8; 580]));
        assert_eq!(rebased.prefix_sha256, cp.prefix_sha256);
        assert_eq!(next.resume_prefix(Some(&rebased)).unwrap(), length as u64);
        let plan = next
            .resume(Some(rebased), proof(length as u64, &vec![9; length]))
            .unwrap();
        assert_eq!(plan.offset, length as u64);
        assert_eq!(plan.download, length < 330);
        assert_eq!(plan.truncate_to, None);
    }
}
#[test]
fn recovery_refuses_foreign_object_authority_and_corrupt_bytes() {
    let cp = retained_checkpoint(330);
    let (next, recovery) = successor();
    for changed in 0..8 {
        let mut c = cp.clone();
        let mut authority = recovery.clone();
        match changed {
            0 => c.recording_uuid[0] ^= 1,
            1 => c.recording_generation += 1,
            2 => c.ciphertext_length += 1,
            3 => c.ciphertext_sha256[0] ^= 1,
            4 => c.next_ciphertext_offset += 1,
            5 => authority.previous_upload_session_uuid[0] ^= 1,
            6 => authority.owner_revision += 1,
            _ => authority.previous_owner_revision = authority.owner_revision,
        }
        assert!(
            next.rebase_checkpoint(&c, &authority).is_err(),
            "case {changed}"
        );
    }
    let rebased = next.rebase_checkpoint(&cp, &recovery).unwrap();
    let (mut next, _) = successor();
    assert!(next.resume(Some(rebased), proof(330, &[8; 330])).is_err());
}
