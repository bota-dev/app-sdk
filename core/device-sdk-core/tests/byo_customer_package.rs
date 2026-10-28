use bota_device_sdk_core::model::byo_customer::*;
use serde_json::{Value, json};
#[test]
fn backend_package_vector_is_exact_and_bound() {
    let f: Value = serde_json::from_str(include_str!(
        "../../../protocol/vectors/byo-customer-hooks/package.json"
    ))
    .unwrap();
    let trailer = package_trailer(&f["context"], &f["authorization"], &f["manifest"]).unwrap();
    assert_eq!(hex(&trailer), f["trailer_hex"]);
    let mut wrong = f["manifest"].clone();
    wrong["recipient_id"] = json!("other");
    assert!(package_trailer(&f["context"], &f["authorization"], &wrong).is_err());
}
#[test]
fn transfer_ack_is_never_cleanup_and_cannot_cross_contracts() {
    let s = json!({"index":0,"offset":0,"length":10,"sha256":"ab".repeat(32)});
    let p = json!({"contract_version":CUSTOMER_HOOKS,"result":{"state":"transferred","segment":s,"cleanup_allowed":false}});
    assert!(transfer_ack(&p, &s, true));
    assert!(!transfer_ack(&p, &s, false));
    let mut bad = p.clone();
    bad["result"]["cleanup_allowed"] = json!(true);
    assert!(!transfer_ack(&bad, &s, true));
    bad = p.clone();
    bad["result"]["segment"]["offset"] = json!(1);
    assert!(!transfer_ack(&bad, &s, true));
    assert!(!transfer_ack(
        &json!({"result":{"state":"confirmed","segment":s}}),
        &s,
        true
    ));
}
#[test]
fn jwt_headers_are_bounded_and_framing_is_owned_by_transport() {
    assert!(
        upload_headers(&json!({"Authorization":"Bearer upload-jwt","X-Customer-Token":"value"}))
            .is_ok()
    );
    for h in [
        json!({"Host":"evil"}),
        json!({"Authorization":"a\r\nb"}),
        json!({"Cookie":"x"}),
        json!({"authorization":"a","Authorization":"b"}),
        json!({"Sec-X":"x"}),
    ] {
        assert!(upload_headers(&h).is_err());
    }
}
