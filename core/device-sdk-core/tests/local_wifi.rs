use bota_device_sdk_core::protocol::*;

#[test]
fn local_capabilities_fail_closed_without_changing_v2() {
    let bytes = [2, 2, 16, 0, 31, 0, 0, 0, 3, 0, 185, 0, 182, 0, 182, 0];
    assert_eq!(
        decode_local_wifi_capabilities(&bytes, 185)
            .unwrap()
            .band_mask,
        3
    );
    assert!(decode_local_wifi_capabilities(&bytes, 184).is_err());
    for i in 0..bytes.len() {
        let mut bad = bytes;
        bad[i] = 255;
        assert!(
            decode_local_wifi_capabilities(&bad, 185).is_err(),
            "offset {i}"
        );
    }
    assert!(decode_local_wifi_capabilities(&bytes[..15], 185).is_err());
}

#[test]
fn local_commands_reuse_transport_identity_and_exact_layout() {
    assert_eq!(
        encode_local_wifi_link(0x10, 1).unwrap(),
        [0x10, 2, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]
    );
    assert!(encode_local_wifi_link(0x10, 0).is_err());
    assert!(encode_local_wifi_link(0x20, 1).is_err());
    let p = LocalWifiPrepare {
        transport_session_id: 9,
        upload_session_uuid: [1; 16],
        recording_uuid: [2; 16],
        recording_generation: 0,
        authorization_sha256: [3; 32],
        owner_revision: 4,
    };
    let bytes = encode_local_wifi_prepare(&p).unwrap();
    assert_eq!(bytes.len(), 84);
    assert_eq!(&bytes[48..80], &[3; 32]);
    assert_eq!(&bytes[80..], &4u32.to_le_bytes());
}

#[test]
fn local_evidence_has_no_ble_sequence_and_preserves_u64() {
    let mut bytes = vec![0; 128];
    bytes[0] = 0xb0;
    bytes[1] = 2;
    bytes[4] = 1;
    bytes[12..28].fill(1);
    bytes[28..44].fill(2);
    bytes[48] = 3;
    bytes[52..60].copy_from_slice(&(1u64 << 54).to_le_bytes());
    bytes[60..92].fill(3);
    bytes[92..124].fill(4);
    bytes[124] = 1;
    let evidence = decode_local_wifi_evidence(&bytes).unwrap();
    assert_eq!(evidence.ciphertext_length, 1u64 << 54);
    let finish = encode_local_wifi_finish(1, &evidence).unwrap();
    assert_eq!(finish.len(), 124);
    assert_eq!(finish[0], 0x31);
    assert_eq!(&finish[12..], &bytes[12..124]);
    for len in 0..128 {
        assert!(decode_local_wifi_evidence(&bytes[..len]).is_err());
    }
    bytes.push(0);
    assert!(decode_local_wifi_evidence(&bytes).is_err());
}

#[test]
fn ready_material_is_bounded_and_never_accepted_on_failure() {
    let mut bytes = vec![0x90, 2, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0x10];
    bytes.extend([2, 36, 0, 192, 168, 4, 1, 0xbb, 1, 60, 0, 0, 0, 4]);
    bytes.extend(b"Test");
    bytes.push(32);
    bytes.extend([b'a'; 32]);
    bytes.extend([1; 32]);
    bytes.extend([2; 32]);
    assert_eq!(
        decode_local_wifi_link_state(&bytes)
            .unwrap()
            .material
            .unwrap()
            .ssid,
        "Test"
    );
    for len in 0..bytes.len() {
        assert!(decode_local_wifi_link_state(&bytes[..len]).is_err());
    }
    bytes[12] = 1;
    assert!(decode_local_wifi_link_state(&bytes).is_err());
    let off = [0x90, 2, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x12];
    assert!(
        decode_local_wifi_link_state(&off)
            .unwrap()
            .material
            .is_none()
    );
}
