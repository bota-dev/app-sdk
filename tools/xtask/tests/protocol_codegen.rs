use std::{fs, path::PathBuf};

#[test]
fn generated_protocol_constants_are_current() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let checked_in =
        fs::read_to_string(root.join("core/device-sdk-core/src/generated/protocol.rs"))
            .unwrap_or_default();

    let generated = xtask::protocol::generated_content(&root);

    assert_eq!(generated.as_deref(), Ok(checked_in.as_str()));
}

#[test]
fn generated_encrypted_upload_v2_contract_is_complete() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let generated = xtask::protocol::generated_content(&root).unwrap();
    for expected in [
        "ENCRYPTED_UPLOAD_V2_CONTRACT_REVISION: &str = \"encrypted-upload-v2-contract-v1\"",
        "CHAR_STORAGE_TRANSFER_CAPABILITIES_V2: &str = \"B07A0004-0006-1000-8000-00805F9B34FB\"",
        "CHAR_TRANSFER_SIGNED_BLOB_V2: &str = \"B07A0004-0007-1000-8000-00805F9B34FB\"",
        "CHAR_TRANSFER_CONTROL_V2: &str = \"B07A0004-0008-1000-8000-00805F9B34FB\"",
        "CHAR_RECORDING_TRANSFER_V2: &str = \"B07A0004-0009-1000-8000-00805F9B34FB\"",
        "CHAR_TRANSFER_STATUS_V2: &str = \"B07A0004-000A-1000-8000-00805F9B34FB\"",
        "CHAR_RECORDING_LIST_V2: &str = \"B07A0004-000B-1000-8000-00805F9B34FB\"",
        "BLE_ERROR_ENCRYPTED_UPLOAD_V2_REQUIRED: u8 = 0x22",
        "ENCRYPTED_UPLOAD_V2_STORAGE_HEADER_FIXED_LENGTH: usize = 128",
        "ENCRYPTED_UPLOAD_V2_STORAGE_BLOCK_HEADER_FIXED_LENGTH: usize = 4",
        "ENCRYPTED_UPLOAD_V2_STORAGE_TRAILER_FIXED_LENGTH: usize = 144",
        "UPLOAD_AUTHORIZATION_V2_FIXED_LENGTH: usize = 408",
        "UPLOAD_MANIFEST_V2_FIXED_LENGTH: usize = 580",
        "COMPLETION_RECEIPT_V2_FIXED_LENGTH: usize = 336",
        "ENCRYPTED_UPLOAD_V2_DOMAIN_HPKE_KEY_EXPORT: &[u8] = b\"bota/enc-v2/hpke-key-export/v1\"",
        "ENCRYPTED_UPLOAD_V2_CAPABILITY_FIXED_LENGTH: usize = 24",
        "ENCRYPTED_UPLOAD_V2_BLOB_BEGIN_FIXED_LENGTH: usize = 42",
        "ENCRYPTED_UPLOAD_V2_BLOB_DATA_MINIMUM_LENGTH: usize = 12",
        "ENCRYPTED_UPLOAD_V2_BLOB_COMMIT_FIXED_LENGTH: usize = 8",
        "ENCRYPTED_UPLOAD_V2_BLOB_ABORT_FIXED_LENGTH: usize = 8",
        "ENCRYPTED_UPLOAD_V2_BLOB_RESULT_FIXED_LENGTH: usize = 10",
        "ENCRYPTED_UPLOAD_V2_COMMON_HEADER_FIXED_LENGTH: usize = 12",
        "ENCRYPTED_UPLOAD_V2_LIST_FIXED_LENGTH: usize = 16",
        "ENCRYPTED_UPLOAD_V2_RECORDING_ENTRY_FIXED_LENGTH: usize = 96",
        "ENCRYPTED_UPLOAD_V2_RECORDING_LIST_END_FIXED_LENGTH: usize = 52",
        "ENCRYPTED_UPLOAD_V2_START_FIXED_LENGTH: usize = 128",
        "ENCRYPTED_UPLOAD_V2_START_ACK_FIXED_LENGTH: usize = 140",
        "ENCRYPTED_UPLOAD_V2_DATA_MINIMUM_LENGTH: usize = 28",
        "ENCRYPTED_UPLOAD_V2_WINDOW_END_FIXED_LENGTH: usize = 68",
        "ENCRYPTED_UPLOAD_V2_WINDOW_ACK_MINIMUM_LENGTH: usize = 68",
        "ENCRYPTED_UPLOAD_V2_MANIFEST_CHUNK_MINIMUM_LENGTH: usize = 52",
        "ENCRYPTED_UPLOAD_V2_EOF_FIXED_LENGTH: usize = 92",
        "ENCRYPTED_UPLOAD_V2_RESUME_FIXED_LENGTH: usize = 96",
        "ENCRYPTED_UPLOAD_V2_RESUME_REJECT_FIXED_LENGTH: usize = 60",
        "ENCRYPTED_UPLOAD_V2_CONFIRM_FIXED_LENGTH: usize = 84",
        "ENCRYPTED_UPLOAD_V2_ABORT_FIXED_LENGTH: usize = 16",
        "ENCRYPTED_UPLOAD_V2_ERROR_FIXED_LENGTH: usize = 20",
        "ENCRYPTED_UPLOAD_V2_STATUS_FIXED_LENGTH: usize = 24",
        "ENCRYPTED_UPLOAD_V2_RESULT_SUCCESS: u16 = 0x0000",
        "ENCRYPTED_UPLOAD_V2_CAP_TRANSFER_FRAMING: u32 = 1 << 0",
        "ENCRYPTED_UPLOAD_V2_START_SESSION_ID_OFFSET: usize = 4",
        "ENCRYPTED_UPLOAD_V2_WINDOW_ACK_MISSING_SEQUENCES_WIDTH: usize = 0",
        "UPLOAD_MANIFEST_V2_MANIFEST_TAG_OFFSET: usize = 548",
    ] {
        assert!(generated.contains(expected), "missing {expected}");
    }
}
