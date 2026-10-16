use bota_device_sdk_core::protocol::{
    encode_find_control, parse_find_capabilities, parse_find_status,
};
#[test]
fn validates_action_identity_and_duration() {
    let id = [7; 16];
    let packet = encode_find_control(1, 10, id).unwrap();
    assert_eq!(packet.len(), 20);
    assert_eq!(&packet[..4], &[1, 1, 10, 0]);
    assert_eq!(&packet[4..], &id);
    assert!(encode_find_control(1, 0, id).is_err());
    assert!(encode_find_control(1, 31, id).is_err());
    assert!(encode_find_control(2, 1, id).is_err());
    assert!(encode_find_control(3, 0, id).is_err());
    assert!(encode_find_control(1, 10, [0; 16]).is_err());
    assert!(encode_find_control(2, 0, id).is_ok());
}
#[test]
fn capability_requires_both_actuators_and_exact_version() {
    assert!(parse_find_capabilities(&[1, 3, 30, 10, 0, 0, 0, 0]).unwrap());
    assert!(!parse_find_capabilities(&[1, 0, 30, 10, 0, 0, 0, 0]).unwrap());
    for bytes in [
        &[1, 1, 30, 10, 0, 0, 0, 0][..],
        &[2, 3, 30, 10, 0, 0, 0, 0],
        &[1, 3, 30, 10, 1, 0, 0, 0],
        &[1, 3],
    ] {
        assert!(parse_find_capabilities(bytes).is_err());
    }
}
#[test]
fn status_does_not_confuse_start_with_completion_or_a_stale_request() {
    let mut bytes = [0; 24];
    bytes[0] = 1;
    bytes[1] = 1;
    bytes[4..20].fill(7);
    bytes[20..24].copy_from_slice(&10000u32.to_le_bytes());
    let status = parse_find_status(&bytes).unwrap();
    assert!(status.active);
    assert_eq!(status.request_id, [7; 16]);
    assert_eq!(status.remaining_ms, 10000);
    bytes[1] = 0;
    assert!(parse_find_status(&bytes).is_err());
    bytes[20..].fill(0);
    assert!(!parse_find_status(&bytes).unwrap().active);
    bytes[3] = 1;
    assert!(parse_find_status(&bytes).is_err());
}
