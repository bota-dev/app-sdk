use base64::{Engine, engine::general_purpose::STANDARD};
use bota_device_sdk_core::protocol::WifiProvisioning;
use serde_json::Value;
fn vector() -> Value {
    serde_json::from_str(include_str!("../../../protocol/wifi-config-v2.vector.json")).unwrap()
}
fn unhex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}
fn session() -> WifiProvisioning {
    let v = vector();
    let grant = STANDARD
        .decode(v["response"]["envelope_base64"].as_str().unwrap())
        .unwrap();
    WifiProvisioning::new([7; 32], &grant, 41, 1).unwrap()
}
#[test]
fn actual_crypto_matches_backend_and_firmware_vector_without_plaintext() {
    let v = vector();
    let mut s = session();
    let wire = s
        .seal_credentials("Audit-Network", "Audit-Only-123")
        .unwrap();
    assert_eq!(wire, unhex(v["credentialHex"].as_str().unwrap()));
    assert!(!wire.windows(13).any(|p| p == b"Audit-Network"));
    assert!(!wire.windows(14).any(|p| p == b"Audit-Only-123"));
    assert_eq!(
        s.open_result(&unhex(v["successHex"].as_str().unwrap()))
            .unwrap(),
        0
    );
    assert!(s.seal_credentials("Other", "other").is_err());
    assert!(
        s.open_result(&unhex(v["successHex"].as_str().unwrap()))
            .is_err()
    );
}
#[test]
fn rejects_result_tamper_reflection_legacy_and_duplicate() {
    let good = unhex(vector()["successHex"].as_str().unwrap());
    for i in 0..good.len() {
        let mut s = session();
        s.seal_credentials("Audit-Network", "Audit-Only-123")
            .unwrap();
        let mut bad = good.clone();
        bad[i] ^= 1;
        assert!(s.open_result(&bad).is_err());
        assert!(s.open_result(&good).is_err());
    }
    let mut s = session();
    assert!(s.open_result(&good).is_err());
    let mut s = session();
    let wire = s
        .seal_credentials("Audit-Network", "Audit-Only-123")
        .unwrap();
    assert!(s.open_result(&wire).is_err());
    let mut s = session();
    s.seal_credentials("A", "").unwrap();
    assert!(s.open_result(&[0]).is_err());
}
#[test]
fn validates_credentials_and_grant_before_exposing_any_bytes() {
    for (ssid, password) in [
        ("", "secret"),
        ("a\0b", "12345678"),
        ("A", "a\0b"),
        ("", ""),
    ] {
        assert!(session().seal_credentials(ssid, password).is_err());
    }
    assert!(session().seal_credentials(&"x".repeat(33), "p").is_err());
    assert!(session().seal_credentials("ssid", &"p".repeat(65)).is_err());
    let v = vector();
    let g = STANDARD
        .decode(v["response"]["envelope_base64"].as_str().unwrap())
        .unwrap();
    assert!(WifiProvisioning::new([0; 32], &g, 41, 1).is_err());
    assert!(WifiProvisioning::new([7; 32], &g, 0, 1).is_err());
    assert!(WifiProvisioning::new([7; 32], &g, 41, 2).is_err());
    assert!(WifiProvisioning::new([7; 32], b"legacy.jwt", 41, 1).is_err());
}
