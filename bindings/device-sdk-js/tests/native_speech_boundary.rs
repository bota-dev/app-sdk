use bota_device_sdk_js::TraceEngine;
use serde_json::{Value, json};

fn refused(codec: &str, input: Value) {
    let mut engine = TraceEngine::default();
    let response: Value = serde_json::from_slice(
        &engine.request(
            &serde_json::to_vec(&json!({"version":1,"action":"codec","codec":codec,"input":input}))
                .unwrap(),
        ),
    )
    .unwrap();
    assert_eq!(
        response["ok"], false,
        "native-only {codec} entered the JS runtime"
    );
}

#[test]
fn retired_room_session_cannot_acquire_a_js_policy_owner() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../protocol/speech-session/client-v1.json"
    ))
    .unwrap();
    refused(
        "speechSession",
        json!({"op":"create",
        "configurationJson":fixture["configuration"].to_string(),
        "grantJson":fixture["grant"].to_string(),"nowMs":fixture["nowMs"].to_string()}),
    );
}

#[test]
fn native_capture_is_not_duplicated_in_the_js_runtime() {
    refused(
        "speechCapture",
        json!({"op":"create",
        "captureId":"10000000-0000-4000-8000-000000000003",
        "recordingId":"rec_original","retention":"original_audio_and_text"}),
    );
}

#[test]
fn native_recording_grants_are_not_admitted_by_the_js_runtime() {
    refused(
        "recordingSpeech",
        json!({"op":"create","nowMs":1000,
        "configuration":{"projectId":"prj_test","activityId":"11111111-1111-4111-8111-111111111111",
            "endpoint":"wss://api.example.com/v1/recording-speech/ws"},
        "grant":{"version":1,"project_id":"prj_test","activity_id":"11111111-1111-4111-8111-111111111111",
            "transport":"websocket","protocol":"bota.recording-speech.v1",
            "url":"wss://api.example.com/v1/recording-speech/ws","token":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "generation":1,"expires_at":"1970-01-01T00:00:30.000Z"}}),
    );
}
