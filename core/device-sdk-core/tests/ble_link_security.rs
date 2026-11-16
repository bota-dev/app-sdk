use bota_device_sdk_core::protocol::validate_ble_link_security;

#[test]
fn only_current_encryption_with_a_full_length_key_is_accepted() {
    assert!(validate_ble_link_security(&[1, 1, 16, 0]).is_ok());
    for bytes in [
        vec![],
        vec![1, 1, 16],
        vec![1, 1, 16, 0, 0],
        vec![0, 1, 16, 0],
        vec![2, 1, 16, 0],
        vec![1, 0, 16, 0],
        vec![1, 3, 16, 0],
        vec![1, 1, 7, 0],
        vec![1, 1, 15, 0],
        vec![1, 1, 17, 0],
        vec![1, 1, 16, 1],
    ] {
        assert!(validate_ble_link_security(&bytes).is_err(), "{bytes:?}");
    }
}
