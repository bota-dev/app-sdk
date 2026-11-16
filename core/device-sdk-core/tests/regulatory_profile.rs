use bota_device_sdk_core::protocol::{
    RegulatoryDocument, RegulatoryReceiptAssembler, regulatory_capabilities, regulatory_challenge,
    regulatory_ready,
};
fn fixture() -> (Vec<u8>, Vec<u8>, [u8; 16]) {
    let v: serde_json::Value = serde_json::from_str(include_str!(
        "../../../protocol/vectors/regulatory-signed-v1.json"
    ))
    .unwrap();
    let decode = |key: &str| {
        let s = v[key].as_str().unwrap();
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect::<Vec<_>>()
    };
    (
        decode("documentHex"),
        decode("receiptHex"),
        decode("nonceHex").try_into().unwrap(),
    )
}
#[test]
fn readiness_preserves_a_valid_profile_after_a_failed_delivery() {
    let mut status = [0u8; 64];
    status[0] = 1;
    assert!(!regulatory_ready(&status).unwrap());
    status[1] = 1;
    assert!(regulatory_ready(&status).is_err());
    status[5..7].copy_from_slice(b"CN");
    status[7] = 3;
    status[15] = 1;
    assert!(regulatory_ready(&status).unwrap());
    status[3] = 9;
    assert!(regulatory_ready(&status).unwrap());
    status[1] = 3;
    assert!(!regulatory_ready(&status).unwrap());
    assert!(regulatory_ready(&status[..63]).is_err());
}
#[test]
fn signed_backend_vector_survives_minimum_mtu_and_fragmented_receipt() {
    let (wire, ack, nonce) = fixture();
    regulatory_capabilities(&[1, 15, 66, 2, 198, 0, 120, 0]).unwrap();
    assert_eq!(
        regulatory_challenge(&[&[1][..], &nonce].concat()).unwrap(),
        nonce
    );
    let doc = RegulatoryDocument::parse(&wire, "SYNTHETIC", &nonce).unwrap();
    assert_eq!(doc.country, "CN");
    assert_eq!(doc.generation, 2);
    assert_eq!(doc.receipt(&ack).unwrap(), Some(0));
    for mtu in [23, 185, 247, 517] {
        let frames = doc.fragments(mtu).unwrap();
        assert!(frames.iter().all(|f| f.len() <= usize::from(mtu - 3)));
        assert_eq!(
            frames
                .iter()
                .flat_map(|f| f[2..].iter().copied())
                .collect::<Vec<_>>(),
            wire
        );
    }
    let mut assembler = RegulatoryReceiptAssembler::default();
    let total = ack.len().div_ceil(16);
    let mut completed = None;
    for (i, chunk) in ack.chunks(16).enumerate() {
        let frame = [vec![i as u8, total as u8], chunk.to_vec()].concat();
        let value = assembler.push(&frame).unwrap();
        if value.is_some() {
            completed = value;
        }
        assert!(assembler.push(&frame).unwrap().is_none());
    }
    assert_eq!(completed, Some(ack));
}
#[test]
fn invalid_context_bounds_and_stale_receipts_refuse() {
    let (wire, ack, nonce) = fixture();
    let doc = RegulatoryDocument::parse(&wire, "SYNTHETIC", &nonce).unwrap();
    assert!(RegulatoryDocument::parse(&wire, "OTHER", &nonce).is_err());
    let mut different_nonce = nonce;
    different_nonce[0] ^= 1;
    assert!(RegulatoryDocument::parse(&wire, "SYNTHETIC", &different_nonce).is_err());
    for offset in [8, 10, 11, 99] {
        let mut bad = wire.clone();
        bad[offset] = 9;
        assert!(RegulatoryDocument::parse(&bad, "SYNTHETIC", &nonce).is_err());
    }
    assert!(RegulatoryDocument::parse(&wire[..200], "SYNTHETIC", &nonce).is_err());
    assert!(doc.fragments(22).is_err());
    for offset in [9, 12, 44, 60, 68, 76, 78, 110] {
        let mut old = ack.clone();
        old[offset] ^= 1;
        assert_eq!(doc.receipt(&old).unwrap(), None);
    }
    assert_eq!(doc.receipt(&[]).unwrap(), None);
    assert!(doc.receipt(&ack[..100]).is_err());
    assert!(
        RegulatoryReceiptAssembler::default()
            .push(&[1, 2, 3])
            .is_err()
    );
    assert!(regulatory_challenge(&[0; 17]).is_err());
    assert!(regulatory_capabilities(&[1; 8]).is_err());
}
