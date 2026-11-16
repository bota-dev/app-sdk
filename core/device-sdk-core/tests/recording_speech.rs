use bota_device_sdk_core::recording_speech::dispatch_json;
use serde_json::{Value, json};

fn call(value: Value) -> Value {
    serde_json::from_str(&dispatch_json(&value.to_string()).unwrap()).unwrap()
}
fn opened() -> Value {
    let created = call(json!({"op":"create", "nowMs":1000,
        "configuration":{"projectId":"prj_test","activityId":"11111111-1111-4111-8111-111111111111","endpoint":"wss://api.example.com/v1/recording-speech/ws"},
        "grant":{"version":1,"project_id":"prj_test","activity_id":"11111111-1111-4111-8111-111111111111","transport":"websocket",
            "protocol":"bota.recording-speech.v1","url":"wss://api.example.com/v1/recording-speech/ws","token":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "generation":1,"expires_at":"1970-01-01T00:00:30.000Z"}}));
    assert!(!created["state"].to_string().contains("aaaaaaaa"));
    call(json!({"op":"ready","state":created["state"], "nowMs":1001,
        "event":{"type":"ready","version":1,"activityId":"11111111-1111-4111-8111-111111111111","generation":1,
            "target":{"revision":1,"language":"zh"},"sources":[{"id":"mixed","epoch":1,"role":"mixed","speaker":"unknown","language":"en","startSample":0}],
            "input":{"format":"pcm_s16le","sampleRate":48000,"maxFrameSamples":4800},"playbackRoute":"unqualified"}}))["state"].clone()
}
#[test]
fn direct_grants_and_frames_have_no_room_or_membership() {
    let state = opened();
    let frame = call(json!({"op":"frame","state":state,"sourceIndex":0,"firstSample":0,"samples":480}));
    assert_eq!(frame["state"]["progress"][0]["sample"], 480);
    assert_eq!(frame["header"].as_array().unwrap().len(), 32);
    assert!(!frame.to_string().contains("room"));
    assert!(!frame.to_string().contains("participant"));
    assert!(dispatch_json(&json!({"op":"frame","state":frame["state"],"sourceIndex":0,"firstSample":0,"samples":480}).to_string()).is_err());
}
#[test]
fn target_changes_hold_live_ingest_and_playback_until_exact_commit_and_clear() {
    let state = opened();
    let change = call(json!({"op":"target","state":state,"requestId":"switch-1","language":"en"}));
    assert_eq!(change["control"]["change"]["boundaries"][0]["sample"], 0);
    assert!(dispatch_json(&json!({"op":"frame","state":change["state"],"sourceIndex":0,"firstSample":0,"samples":480}).to_string()).is_err());
    let committed = call(json!({"op":"target_committed","state":change["state"],"requestId":"switch-1","revision":2,"language":"en"}));
    assert_eq!(committed["state"]["playbackHeld"], true);
    let cleared = call(json!({"op":"playback_cleared","state":committed["state"],"revision":2}));
    assert_eq!(cleared["control"], json!({"type":"playback_ack","revision":2}));
    assert_eq!(cleared["state"]["playbackHeld"], false);
}
#[test]
fn unknown_mixed_speakers_cannot_claim_proven_self_identity() {
    let mut state = opened(); state["sources"][0]["speaker"] = json!("self");
    assert!(dispatch_json(&json!({"op":"frame","state":state,"sourceIndex":0,"firstSample":0,"samples":480}).to_string()).is_err());
}
#[test]
fn reconnect_never_relabels_current_capture_as_old_audio() {
    let state = opened();
    let command = json!({"op":"create", "nowMs":1000, "configuration":state["configuration"],
        "grant":{"version":1,"project_id":"prj_test","activity_id":"11111111-1111-4111-8111-111111111111","transport":"websocket",
            "protocol":"bota.recording-speech.v1","url":"wss://api.example.com/v1/recording-speech/ws","token":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "generation":2,"expires_at":"1970-01-01T00:00:30.000Z"}});
    assert!(dispatch_json(&command.to_string()).is_err());
    let mut resumed = command;
    resumed["configuration"]["resume"] = json!([{"sourceId":"mixed","sample":48000}]);
    let created = call(resumed);
    assert_eq!(created["control"]["resume"], json!([{"sourceId":"mixed","sample":48000}]));
    let mut ready = json!({"op":"ready","state":created["state"],"nowMs":1001,
        "event":{"type":"ready","version":1,"activityId":"11111111-1111-4111-8111-111111111111","generation":2,
            "target":{"revision":2,"language":"zh"},"sources":[{"id":"mixed","epoch":2,"role":"mixed","speaker":"unknown","language":"en","startSample":0}],
            "input":{"format":"pcm_s16le","sampleRate":48000,"maxFrameSamples":4800},"playbackRoute":"unqualified"}});
    assert!(dispatch_json(&ready.to_string()).is_err());
    ready["event"]["sources"][0]["startSample"] = json!(48000);
    assert_eq!(call(ready)["state"]["progress"][0]["sample"], 48000);
}
#[test]
fn native_microphone_requires_the_admitted_mixed_capture_clock() {
    let clock = "20000000-0000-4000-8000-000000000001";
    let mut state = opened(); state["sources"][0]["captureClockId"] = json!(clock);
    let bound = call(json!({"op":"bind_microphone","state":state,"clockId":clock}));
    assert_eq!(bound["state"], state);
    assert!(dispatch_json(&json!({"op":"bind_microphone","state":state,"clockId":"20000000-0000-4000-8000-000000000002"}).to_string()).is_err());
    state["sources"][0]["role"] = json!("remote");
    assert!(dispatch_json(&json!({"op":"bind_microphone","state":state,"clockId":clock}).to_string()).is_err());
    state["sources"][0]["role"] = json!("mixed"); state["progress"][0]["sample"] = json!(480);
    assert!(dispatch_json(&json!({"op":"bind_microphone","state":state,"clockId":clock}).to_string()).is_err());
}
