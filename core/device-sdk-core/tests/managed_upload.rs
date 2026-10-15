use bota_device_sdk_core::model::{ManagedUploadError, ManagedUploadInput, ManagedUploadRequest};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const UUID: &str = "00112233-4455-6677-8899-aabbccddeeff";
const SESSION: &str = "11112233-4455-6677-8899-aabbccddeeff";
fn input() -> Value {
    json!({"operationId":"upload-1","scope":{"apiOrigin":"https://api.example.com","apiBasePath":"/v1",
        "accountId":"a","projectId":"p","organizationId":"org","environment":"production","endUserId":"eu_1",
        "deviceId":"dev_1","bindingGeneration":2,"serialNumber":"BOTA1","nativeDeviceId":"ble-id","scopeKey":"a:p:production"},
        "recording":{"uuid":UUID,"generation":3,"ciphertextLength":"900","ciphertextSha256":"aa".repeat(32),
            "startedAtMs":"1704067200123","durationMs":"1000","plaintextLength":"608","storageFormat":3},
        "capability":{"rawValueHex":"00".repeat(24),"flags":0x37f}})
}
fn run(value: &Value, event: Value) -> Result<Value, ManagedUploadError> {
    serde_json::from_value::<ManagedUploadRequest>(json!({"input":value,"event":event}))
        .unwrap()
        .reduce()
        .map(|r| r.value)
}
fn entry() -> Value {
    json!({"recordingId":"rec_1","sessionId":SESSION,"ownerRevision":2})
}
fn session() -> Value {
    json!({"profile":"encrypted_upload_v2","session_id":SESSION,"owner_revision":2,"policy":"v2_required",
        "authorization_base64":"AA==","authorization_sha256":"00".repeat(32),"expires_at":"2030-01-01T00:00:00Z",
        "state":"staging","channel":"ble","ciphertext_length":900,"ciphertext_sha256":"aa".repeat(32)})
}
fn evidence() -> Value {
    json!({"ciphertextLength":"900","ciphertextSha256":vec![0xaa;32],"manifestLength":580,"manifestSha256":vec![0;32]})
}
fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[test]
fn exact_transport_independent_identity_and_scope_key() {
    let first: ManagedUploadInput = serde_json::from_value(input()).unwrap();
    let mut second = first.clone();
    second.scope.native_device_id = "new-ble-id".into();
    assert_eq!(
        first.identity(false).unwrap(),
        second.identity(false).unwrap()
    );
    assert_ne!(
        first.identity(true).unwrap(),
        second.identity(true).unwrap()
    );
    second.recording.markers_required = Some(false);
    assert_eq!(
        first.identity(false).unwrap(),
        second.identity(false).unwrap()
    );
    second.scope.project_id = "another".into();
    assert_ne!(
        first.identity(false).unwrap(),
        second.identity(false).unwrap()
    );
    let key = serde_json::to_vec(&json!([
        "a:p:production",
        "dev_1",
        2,
        UUID,
        3,
        "900",
        "aa".repeat(32)
    ]))
    .unwrap();
    assert_eq!(first.journal_key().unwrap(), digest(&key));
}
#[test]
fn rejects_noncanonical_numbers_scope_and_mismatched_keys() {
    for (path, value) in [
        ("ciphertextLength", json!("0900")),
        ("generation", json!(0)),
        ("storageFormat", json!(2)),
        ("durationMs", json!("999999999999999999")),
    ] {
        let mut i = input();
        i["recording"][path] = value;
        assert_eq!(
            run(&i, json!({"type":"Identity"})).unwrap_err(),
            ManagedUploadError::InvalidInput
        );
    }
    let mut i = input();
    i["scope"]["apiOrigin"] = json!("https://api.example.com/evil");
    assert_eq!(
        run(&i, json!({"type":"Identity"})).unwrap_err(),
        ManagedUploadError::InvalidInput
    );
    let mut i = input();
    i["journalKey"] = json!("00".repeat(32));
    assert_eq!(
        run(&i, json!({"type":"Identity"})).unwrap_err(),
        ManagedUploadError::IdentityConflict
    );
}
#[test]
fn generated_create_body_preserves_strict_ten_keys_and_real_dates() {
    let record = run(&input(), json!({"type":"CreateRecording"})).unwrap();
    let body: Value = serde_json::from_str(record["bodyJSON"].as_str().unwrap()).unwrap();
    assert_eq!(body["metadata"]["started_at"], "2024-01-01T00:00:00.123Z");
    assert_eq!(body["metadata"]["ended_at"], "2024-01-01T00:00:01.123Z");
    let selected = run(
        &input(),
        json!({"type":"CreateSession","entry":{"recordingId":"rec_1"},"nonce":vec![1;16]}),
    )
    .unwrap();
    let body: Value = serde_json::from_str(selected["bodyJSON"].as_str().unwrap()).unwrap();
    assert_eq!(body.as_object().unwrap().len(), 10);
    assert!(body.get("end_user_id").is_none());
    assert_eq!(body["ciphertext_length"], 900);
}
#[test]
fn recording_create_preserves_capture_identity_across_transport_and_operation_changes() {
    let body = |value: &Value| {
        let plan = run(value, json!({"type":"CreateRecording"})).unwrap();
        serde_json::from_str::<Value>(plan["bodyJSON"].as_str().unwrap()).unwrap()
    };
    let first = body(&input());
    assert_eq!(first["device_id"], "dev_1");
    assert_eq!(first["recording_uuid"], UUID);
    assert_eq!(first["recording_generation"], 3);
    let mut retry = input();
    retry["operationId"] = json!("upload-after-restart");
    retry["scope"]["nativeDeviceId"] = json!("replacement-ble-id");
    assert_eq!(body(&retry), first);
    for (section, field, value) in [
        ("scope", "deviceId", json!("dev_2")),
        ("recording", "uuid", json!(SESSION)),
        ("recording", "generation", json!(4)),
    ] {
        let mut distinct = input();
        distinct[section][field] = value.clone();
        let expected_field = match field {
            "deviceId" => "device_id",
            "uuid" => "recording_uuid",
            _ => "recording_generation",
        };
        assert_eq!(body(&distinct)[expected_field], value);
        assert_ne!(body(&distinct), first);
    }
}
#[test]
fn root_and_prefixed_routes_preserve_exact_origin_and_path() {
    for prefix in ["", "/v1", "/dashboard/projects/proj_a"] {
        let mut i = input();
        i["scope"]["apiBasePath"] = json!(prefix);
        assert_eq!(
            run(&i, json!({"type":"CreateRecording"})).unwrap()["path"],
            format!("{prefix}/recordings")
        );
        assert_eq!(
            run(
                &i,
                json!({"type":"CreateSession","entry":{"recordingId":"rec_1"},"nonce":vec![1;16]})
            )
            .unwrap()["path"],
            format!("{prefix}/recordings/rec_1/encrypted-upload-v2/sessions")
        );
    }
    for prefix in [
        "/",
        "//evil.example",
        "v1",
        "/v1/",
        "/v1//nested",
        "/v1/../nested",
        "/v1?x=1",
        "/v1#x",
        "/v%31",
        "https://evil.example",
    ] {
        let mut i = input();
        i["scope"]["apiBasePath"] = json!(prefix);
        assert_eq!(
            run(&i, json!({"type":"CreateRecording"})).unwrap_err(),
            ManagedUploadError::InvalidInput
        );
    }
    let mut omitted = input();
    omitted["scope"]
        .as_object_mut()
        .unwrap()
        .remove("apiBasePath");
    assert_eq!(
        run(&omitted, json!({"type":"CreateRecording"})).unwrap()["path"],
        "/v1/recordings"
    );
}
#[test]
fn unknown_create_cannot_restart_and_exact_rejection_can_rollback() {
    let i = input();
    let identity = run(&i, json!({"type":"Identity"})).unwrap()["identity"].clone();
    let record = json!({"version":2,"identity":identity,"phase":"recording_create_unknown"});
    assert_eq!(
        run(&i, json!({"type":"Inspect","record":record})).unwrap_err(),
        ManagedUploadError::Pending
    );
    assert_eq!(
        run(
            &i,
            json!({"type":"RollbackRejectedCreate","record":record,"entry":null})
        )
        .unwrap()["remove"],
        true
    );
    assert_eq!(run(&i,json!({"type":"RollbackRejectedCreate","record":record,"entry":{"recordingId":"rec_other"}})).unwrap_err(),ManagedUploadError::IdentityConflict);
}
#[test]
fn journal_import_checkpoint_and_removal_require_exact_identity_and_receipt() {
    let i = input();
    let record = run(
        &i,
        json!({"type":"SaveJournal","previous":null,"entry":entry(),"phase":"ready"}),
    )
    .unwrap()["record"]
        .clone();
    assert_eq!(run(&i,json!({"type":"CompleteJournal","record":record,"expected":entry(),"receiptDelivered":false})).unwrap_err(),ManagedUploadError::State);
    assert_eq!(run(&i,json!({"type":"CompleteJournal","record":record,"expected":entry(),"receiptDelivered":true})).unwrap()["remove"],true);
    let mut changed = entry();
    changed["ownerRevision"] = json!(3);
    assert_eq!(run(&i,json!({"type":"CompleteJournal","record":record,"expected":changed,"receiptDelivered":true})).unwrap_err(),ManagedUploadError::IdentityConflict);
    let mut migrated = record;
    migrated["version"] = json!(1);
    migrated["identity"] = json!(
        serde_json::from_value::<ManagedUploadInput>(i.clone())
            .unwrap()
            .identity(true)
            .unwrap()
    );
    assert_eq!(
        run(&i, json!({"type":"Inspect","record":migrated})).unwrap()["record"]["version"],
        2
    );
}
#[test]
fn restore_checks_channel_owner_ciphertext_and_rfc3339_expiry() {
    let i = input();
    let mut s = session();
    assert_eq!(
        run(
            &i,
            json!({"type":"Session","entry":entry(),"responseJson":s.to_string(),"restore":true})
        )
        .unwrap()["uploadCiphertext"],
        true
    );
    for (field, value) in [
        ("channel", json!("wifi")),
        ("ciphertext_length", json!(901)),
        ("owner_revision", json!(3)),
    ] {
        s = session();
        s[field] = value;
        assert_eq!(run(&i,json!({"type":"Session","entry":entry(),"responseJson":s.to_string(),"restore":true})).unwrap_err(),ManagedUploadError::IdentityConflict);
    }
    s = session();
    s["expires_at"] = json!("2030-02-30T00:00:00Z");
    assert_eq!(
        run(
            &i,
            json!({"type":"Session","entry":entry(),"responseJson":s.to_string(),"restore":true})
        )
        .unwrap_err(),
        ManagedUploadError::InvalidDocument
    );
}
#[test]
fn nonce_change_recovery_is_bounded_and_durable_exact_replay() {
    let i = input();
    let s = session();
    let inspect=run(&i,json!({"type":"RestoreDecision","entry":entry(),"responseJson":s.to_string(),"nowMs":0,
        "authorizationNonceSha256":digest(&[0;16]),"recoveryNonceBase64":null,"nonce":vec![1;16],"hop":0})).unwrap();
    assert_eq!(inspect["recover"], true);
    assert_eq!(inspect["expired"], false);
    let plan = run(
        &i,
        json!({"type":"RecoverSession","entry":entry(),"nonce":vec![1;16],"expired":false}),
    )
    .unwrap();
    assert!(plan["bodyJSON"].as_str().unwrap().contains("nonce_changed"));
    let mut no_cap = i.clone();
    no_cap["capability"]["flags"] = json!(0);
    assert_eq!(
        run(
            &no_cap,
            json!({"type":"RecoverSession","entry":entry(),"nonce":vec![1;16],"expired":false})
        )
        .unwrap_err(),
        ManagedUploadError::Expired
    );
    assert_eq!(run(&i,json!({"type":"RestoreDecision","entry":entry(),"responseJson":s.to_string(),"nowMs":0,
        "authorizationNonceSha256":digest(&[0;16]),"recoveryNonceBase64":null,"nonce":vec![1;16],"hop":3})).unwrap_err(),ManagedUploadError::Expired);
    let bad = json!({"profile":"encrypted_upload_v2","session_id":SESSION,"owner_revision":3});
    assert_eq!(run(&i,json!({"type":"AcceptRecovery","parent":entry(),"responseJson":bad.to_string(),"visited":[SESSION]})).unwrap_err(),ManagedUploadError::IdentityConflict);
}
#[test]
fn stale_evidence_and_bad_manifest_fail_before_http_plan() {
    let mut e = evidence();
    e["ciphertextLength"] = json!("901");
    assert_eq!(
        run(&input(), json!({"type":"VerifyEvidence","evidence":e})).unwrap_err(),
        ManagedUploadError::IdentityConflict
    );
    assert_eq!(run(&input(),json!({"type":"Manifest","entry":entry(),"evidence":evidence(),"bytes":vec![0;580],"needed":true})).unwrap_err(),ManagedUploadError::InvalidDocument);
    let mut e = evidence();
    e["manifestSha256"] = json!(Sha256::digest([0; 580]).to_vec());
    assert!(run(&input(),json!({"type":"Manifest","entry":entry(),"evidence":e,"bytes":vec![0;580],"needed":true})).unwrap()["path"].as_str().unwrap().ends_with("/manifest"));
}
#[test]
fn staging_refuses_credentials_headers_expiry_and_redirect_urls() {
    let i = input();
    for headers in [
        json!({"Authorization":"Bearer secret"}),
        json!({"Cookie":"id=1"}),
        json!({"X-Test":"bad\r\n"}),
    ] {
        assert_eq!(run(&i,json!({"type":"Staging","expiresAt":"2030-01-01T00:00:00Z","nowMs":0,
            "responseJson":json!({"url":"https://storage.example.com/object?signature=a","method":"PUT","headers":headers}).to_string()})).unwrap_err(),ManagedUploadError::InvalidDocument);
    }
    assert!(run(&i,json!({"type":"Staging","expiresAt":"2030-01-01T01:00:00+01:00","nowMs":0,
        "responseJson":json!({"url":"https://storage.example.com/object?signature=a","method":"PUT","headers":{}}).to_string()})).is_ok());
}
#[test]
fn published_http_without_valid_signed_receipt_never_allows_completion() {
    let mut s = session();
    s["state"] = json!("published");
    s["plaintext_length"] = json!(608);
    assert_eq!(run(&input(),json!({"type":"Finalize","entry":entry(),"responseJson":s.to_string(),"evidence":evidence()})).unwrap_err(),ManagedUploadError::InvalidDocument);
    s["state"] = json!("processing");
    assert_eq!(run(&input(),json!({"type":"Finalize","entry":entry(),"responseJson":s.to_string(),"evidence":evidence()})).unwrap()["published"],false);
}
#[test]
fn marker_batch_documents_are_bounded_individually_and_hash_checked() {
    let mut i = input();
    i["recording"]["markersRequired"] = json!(true);
    assert!(
        run(
            &i,
            json!({"type":"MarkerBatch","entry":entry(),"evidence":evidence(),"count":4097})
        )
        .is_ok()
    );
    assert_eq!(
        run(
            &i,
            json!({"type":"MarkerBatch","entry":entry(),"evidence":evidence(),"count":4098})
        )
        .unwrap_err(),
        ManagedUploadError::InvalidDocument
    );
    assert!(
        run(
            &i,
            json!({"type":"MarkerDocument","index":0,"count":2,"bytes":vec![0;200],
        "expectedSha256":Sha256::digest([0;200]).to_vec(),"durableLength":"200"})
        )
        .is_ok()
    );
    assert_eq!(
        run(
            &i,
            json!({"type":"MarkerDocument","index":1,"count":2,"bytes":vec![0;200],
        "expectedSha256":Sha256::digest([0;200]).to_vec(),"durableLength":"200"})
        )
        .unwrap_err(),
        ManagedUploadError::InvalidDocument
    );
}
#[test]
fn retry_policy_never_retries_business_rejections() {
    for status in [400, 401, 403, 404, 409, 425] {
        assert_eq!(
            run(
                &input(),
                json!({"type":"HttpPolicy","status":status,"transportFailure":false,"attempt":0})
            )
            .unwrap()["retry"],
            false
        );
    }
    assert_eq!(
        run(
            &input(),
            json!({"type":"HttpPolicy","status":503,"transportFailure":false,"attempt":1})
        )
        .unwrap()["retry"],
        true
    );
    assert_eq!(
        run(
            &input(),
            json!({"type":"HttpPolicy","status":503,"transportFailure":false,"attempt":2})
        )
        .unwrap()["retry"],
        false
    );
}
