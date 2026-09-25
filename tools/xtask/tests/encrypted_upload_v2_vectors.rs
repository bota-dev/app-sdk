use serde_json::Value;
use std::{collections::BTreeSet, fs, path::PathBuf};

#[test]
fn unknown_capability_vector_uses_a_bit_outside_the_current_known_mask() {
    let bundle = bundle_json();
    let case = bundle["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["name"] == "ble-capability-unknown-flag")
        .unwrap();
    let encoded = case["inputHex"].as_str().unwrap();
    let bytes: Vec<u8> = (0..encoded.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&encoded[index..index + 2], 16).unwrap())
        .collect();
    assert!(
        bota_device_sdk_core::protocol::decode_encrypted_upload_v2_capabilities(&bytes).is_err(),
        "the unknown-capability fixture must not advertise only known bits"
    );
    let flags = u32::from_le_bytes(bytes[4..8].try_into().unwrap());
    assert_eq!(flags & !0x3ff, 0x400);
    assert_eq!(case["expectedError"], "noncanonical_encoding");
}

#[test]
fn encrypted_upload_v2_vectors_are_deterministic_and_current() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let first = xtask::encrypted_upload_v2::generated_bundle(&root).unwrap();
    let second = xtask::encrypted_upload_v2::generated_bundle(&root).unwrap();
    assert_eq!(first, second);
    assert_eq!(
        first,
        fs::read(root.join("protocol/vectors/encrypted-upload-v2.json")).unwrap()
    );
}

#[test]
fn bundle_covers_every_required_category() {
    let bundle = bundle_json();
    let names: BTreeSet<_> = bundle["cases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|case| case["name"].as_str().unwrap())
        .collect();
    for required in [
        "storage-partial-block",
        "storage-multi-block",
        "authorization-development",
        "authorization-gamma",
        "authorization-production",
        "key-export-hpke",
        "manifest-hpke",
        "completion-receipt",
        "ble-fresh-transfer",
        "ble-window-repair",
        "ble-resume-accepted",
        "ble-resume-prefix-rejected",
        "old-sdk-new-firmware-v1",
        "new-sdk-old-firmware-v1",
        "historical-p10-unchanged",
    ] {
        assert!(names.contains(required), "missing vector {required}");
    }
}

#[test]
fn malformed_matrix_covers_structural_and_cryptographic_boundaries() {
    let bundle = bundle_json();
    let names: BTreeSet<_> = bundle["cases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|case| case["name"].as_str().unwrap())
        .collect();
    for required in [
        "storage-wrong-magic",
        "storage-trailing-byte",
        "storage-altered-block-tag",
        "storage-altered-trailer-tag",
        "authorization-high-s-signature",
        "authorization-expired",
        "manifest-wrong-recipient-key",
        "manifest-altered-tag",
        "receipt-altered-signature",
        "receipt-replay-conflict",
        "ble-truncated-capability",
        "ble-trailing-start",
        "ble-nonzero-reserved",
        "ble-window-count-mismatch",
        "ble-zero-session",
        "ble-mixed-v1-p10-v2",
        "v2-required-rejects-legacy-batch",
        "v2-required-rejects-legacy-streaming",
    ] {
        assert!(
            names.contains(required),
            "missing negative vector {required}"
        );
    }
}

#[test]
fn generated_digest_matches_the_exact_bundle_bytes() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let bundle = xtask::encrypted_upload_v2::generated_bundle(&root).unwrap();
    let generated = xtask::encrypted_upload_v2::generated_digest_source(&bundle);
    assert_eq!(
        generated,
        fs::read_to_string(
            root.join("core/device-sdk-core/src/generated/encrypted_upload_v2_vectors.rs")
        )
        .unwrap()
    );
}

fn bundle_json() -> Value {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    serde_json::from_slice(&xtask::encrypted_upload_v2::generated_bundle(&root).unwrap()).unwrap()
}
