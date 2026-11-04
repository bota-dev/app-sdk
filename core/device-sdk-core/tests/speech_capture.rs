use bota_device_sdk_core::speech::capture::dispatch_json;
use serde_json::{Value, json};

const CAPTURE: &str = "10000000-0000-4000-8000-000000000003";
const CLOCK: &str = "20000000-0000-4000-8000-000000000001";
fn call(value: Value) -> Value {
    serde_json::from_str(&dispatch_json(&value.to_string()).unwrap()).unwrap()
}
fn state() -> Value {
    call(
        json!({"op":"create","captureId":CAPTURE,"recordingId":"rec_original","retention":"original_audio_and_text"}),
    )
}
#[test]
fn archive_policy_refuses_nonrecording_modes_before_capture() {
    for retention in ["text_only", "live_only"] {
        assert!(dispatch_json(&json!({"op":"create","captureId":CAPTURE,"recordingId":"rec_original","retention":retention}).to_string()).is_err());
    }
}
#[test]
fn durable_commits_advance_the_archive_independently_of_capture_gaps() {
    let initial = call(json!({"op":"begin_clock","state":state(),"clockId":CLOCK}));
    let plan = call(json!({"op":"plan","state":initial,"firstSample":0,"samples":480}));
    assert_eq!(plan["header"]["sequence"], 0);
    assert_eq!(plan["header"]["archiveSample"], 0);
    let committed = call(
        json!({"op":"commit","state":initial,"header":plan["header"],"sha256":"a".repeat(64)}),
    );
    assert_eq!(committed["archiveSamples"], 480);
    let gap = call(json!({"op":"end_clock","state":committed,"samples":960}));
    let finished = call(json!({"op":"finish","state":gap}));
    assert_eq!(finished["manifest"]["archiveSamples"], 480);
    assert_eq!(finished["manifest"]["clocks"][0]["samples"], 960);
    assert!(
        dispatch_json(
            &json!({"op":"begin_clock","state":finished["state"],"clockId":CLOCK}).to_string()
        )
        .is_err()
    );
}
#[test]
fn retries_and_clock_replacement_cannot_rewrite_committed_archive_positions() {
    let initial = call(json!({"op":"begin_clock","state":state(),"clockId":CLOCK}));
    let plan = call(json!({"op":"plan","state":initial,"firstSample":480,"samples":480}));
    let committed = call(
        json!({"op":"commit","state":initial,"header":plan["header"],"sha256":"b".repeat(64)}),
    );
    assert!(dispatch_json(&json!({"op":"commit","state":committed,"header":plan["header"],"sha256":"b".repeat(64)}).to_string()).is_err());
    assert!(
        dispatch_json(
            &json!({"op":"plan","state":committed,"firstSample":0,"samples":480}).to_string()
        )
        .is_err()
    );
    assert!(
        dispatch_json(&json!({"op":"end_clock","state":committed,"samples":479}).to_string())
            .is_err()
    );
    let ended = call(json!({"op":"end_clock","state":committed,"samples":960}));
    assert!(
        dispatch_json(&json!({"op":"begin_clock","state":ended,"clockId":CLOCK}).to_string())
            .is_err()
    );
}
#[test]
fn local_cleanup_requires_the_exact_persisted_manifest_receipt() {
    let finished = call(json!({"op":"finish","state":state()}));
    let receipt = json!({"profile":"speech_capture_pcm_v1","capture_id":CAPTURE,"recording_id":"rec_original", "state":"published",
        "audio_verification":"verified","manifest_sha256":"a".repeat(64),"content_sha256":"b".repeat(64),"archive_samples":0});
    assert_eq!(
        call(
            json!({"op":"receipt","state":finished["state"],"manifestSha256":"a".repeat(64),"receipt":receipt})
        )["canDelete"],
        true
    );
    for (field, value) in [
        ("capture_id", json!(CLOCK)),
        ("recording_id", json!("rec_other")),
        ("state", json!("sealed")),
        ("manifest_sha256", json!("c".repeat(64))),
        ("archive_samples", json!(1)),
    ] {
        let mut wrong = receipt.clone();
        wrong[field] = value;
        assert!(dispatch_json(&json!({"op":"receipt","state":finished["state"],"manifestSha256":"a".repeat(64),"receipt":wrong}).to_string()).is_err());
    }
}
#[test]
fn recovery_never_turns_an_unobserved_crash_tail_into_a_complete_clock() {
    let capturing = call(json!({"op":"begin_clock","state":state(),"clockId":CLOCK}));
    let recovered = call(json!({"op":"recover","state":capturing}));
    let finished = call(json!({"op":"finish","state":recovered}));
    assert_eq!(finished["manifest"]["clocks"][0]["endKnown"], false);
}

#[test]
fn canonical_capture_vector_matches_wire_aad_chain_and_clock_boundaries() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../protocol/speech-session/capture-v1.json"
    ))
    .unwrap();
    let mut current = call(
        json!({"op":"create","captureId":fixture["captureId"],"recordingId":fixture["recordingId"],"retention":"original_audio_and_text"}),
    );
    for (index, chunk) in fixture["chunks"].as_array().unwrap().iter().enumerate() {
        current = call(
            json!({"op":"begin_clock","state":current,"clockId":chunk["packet"]["header"]["clockId"]}),
        );
        let plan = call(
            json!({"op":"plan","state":current,"firstSample":chunk["packet"]["header"]["firstSample"],"samples":chunk["packet"]["header"]["samples"]}),
        );
        assert_eq!(plan["aad"], chunk["aad"]);
        assert_eq!(plan["header"], chunk["packet"]["header"]);
        current = call(
            json!({"op":"commit","state":current,"header":plan["header"],"sha256":chunk["sha256"]}),
        );
        current = if index == 0 {
            call(json!({"op":"end_clock","state":current,"samples":1000}))
        } else {
            call(json!({"op":"recover","state":current}))
        };
    }
    let finished = call(json!({"op":"finish","state":current}));
    assert_eq!(finished["manifest"], fixture["manifest"]["value"]);
    assert_eq!(finished["aad"], fixture["manifest"]["aad"]);
}
